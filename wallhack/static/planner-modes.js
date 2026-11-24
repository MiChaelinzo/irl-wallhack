"use strict";
// Planner bonus modes: multi-floor stack, 3D building view, mesh backhaul, capacity planning, IoT device
// placement and an enterprise lattice layout with a bill of quantities. The calculations are pure
// functions on a project and rf-config.json ("planner_modes"), tested under node. mount(app) adds the
// "Modes" tab. Every figure is a MODEL ESTIMATE built on rf-engine.js.
(function (root) {
  var E = (typeof module !== "undefined" && module.exports) ? require("./rf-engine.js") : root.RFEngine;
  var ESTIMATE = "ESTIMATE";

  function round(v, d) { return E.roundTo(v, d === undefined ? 1 : d); }
  function apIndex(project) {
    var out = {};
    project.floors.forEach(function (f) { f.aps.forEach(function (a) { out[a.id] = { ap: a, floor: f }; }); });
    return out;
  }

  // ------------------------------------------------------------------ mesh
  /** Would setting `child`'s backhaul to `parent` create a loop (or point at itself)? */
  function wouldLoop(project, child, parent) {
    var idx = apIndex(project), cur = parent, guard = 0;
    while (cur && guard++ < 1000) {
      if (cur === child) { return true; }
      cur = idx[cur] && idx[cur].ap.mesh_parent;
    }
    return false;
  }

  /** RSSI at `child` from `parent` alone, from the engine (walls, floors crossed). Returns {rssi_dbm, throughput_mbps}. */
  function backhaulLink(project, env, child, parent, mode) {
    var sub = { name: "link", units: "m", materials: project.materials, floors: project.floors.map(function (f) { return Object.assign({}, f, { aps: f.aps.filter(function (a) { return a.id === parent.ap.id; }) }); }) };
    var p = E.probeAt(sub, child.floor.id, child.ap.x, child.ap.y, { env: env, mode: mode || "basic" });
    return { rssi_dbm: p.rssi_dbm, throughput_mbps: p.throughput_mbps, walls: p.walls_crossed, floors: p.floors_crossed };
  }

  /**
   * Mesh nodes (APs with mesh_parent): hop count, first-hop backhaul RSSI, and end-to-end backhaul rate =
   * slowest link x hop_throughput_factor^hops (every wireless hop on one radio halves the rate). `usable` maps AP id to
   * the analytics usable_mbps, used to flag nodes whose clients are limited by backhaul.
   */
  function meshReport(project, config, opts) {
    var o = opts || {}, mc = config.planner_modes.mesh, env = o.env || E.makeEnv(config, project.materials), idx = apIndex(project), rows = [];
    Object.keys(idx).forEach(function (id) {
      var node = idx[id];
      if (node.ap.mesh_parent === undefined) { return; }
      var cur = node, hops = 0, slowest = Infinity, first = null, seen = {}, broken = null;
      while (cur.ap.mesh_parent !== undefined) {
        var parent = idx[cur.ap.mesh_parent];
        if (!parent || seen[cur.ap.id]) { broken = parent ? "backhaul loop" : "missing parent " + cur.ap.mesh_parent; break; }
        seen[cur.ap.id] = true;
        var link = backhaulLink(project, env, cur, parent, o.mode);
        if (!first) { first = link; }
        slowest = Math.min(slowest, link.throughput_mbps); hops++; cur = parent;
      }
      if (broken) { rows.push({ id: id, parent: node.ap.mesh_parent, hops: hops, error: broken }); return; }
      var e2e = slowest * Math.pow(mc.hop_throughput_factor, hops), usable = o.usable && o.usable[id];
      var notes = [];
      if (first.rssi_dbm < mc.weak_backhaul_dbm) { notes.push("weak backhaul (below " + mc.weak_backhaul_dbm + " dBm)"); }
      if (hops > mc.max_hops_advised) { notes.push("more than " + mc.max_hops_advised + " hops"); }
      if (usable !== undefined && usable > e2e) { notes.push("clients limited by backhaul"); }
      rows.push({ id: id, parent: node.ap.mesh_parent, hops: hops, backhaul_rssi_dbm: first.rssi_dbm, link_mbps: first.throughput_mbps, e2e_mbps: round(e2e),
                  usable_mbps: usable === undefined ? null : usable, effective_mbps: usable === undefined ? round(e2e) : round(Math.min(usable, e2e)), notes: notes });
    });
    return rows.sort(function (a, b) { return a.id < b.id ? -1 : 1; });
  }

  // ------------------------------------------------------------------ capacity
  /** Per-zone demand and per-AP load. zones are floor.rooms with entries in project.capacity["floorId/roomId"]; `an` is a floor analytics result. */
  function capacityReport(project, floorId, an, config) {
    var floor = E.findFloor(project, floorId), profiles = config.planner_modes.capacity_profiles, load = {}, zones = [];
    (floor.rooms || []).forEach(function (r) {
      var z = (project.capacity || {})[floorId + "/" + r.id];
      if (!z || !z.users) { return; }
      var prof = profiles[z.profile], mbps = prof ? prof.mbps : 0, demand = z.users * mbps;
      var col = Math.min(an.cols - 1, Math.max(0, Math.floor((r.x + r.w / 2) / an.cell_m))), row = Math.min(an.rows - 1, Math.max(0, Math.floor((r.y + r.d / 2) / an.cell_m)));
      var k = an.best_ap[row][col], ap = k >= 0 ? an.aps[k] : null;
      if (ap) { load[ap.id] = (load[ap.id] || 0) + demand; }
      zones.push({ room: r.name || r.id, users: z.users, profile: z.profile, demand_mbps: round(demand), ap_id: ap ? ap.id : null });
    });
    var aps = an.aps.map(function (a) {
      var d = load[a.id] || 0, util = a.usable_mbps > 0 ? 100 * d / a.usable_mbps : (d > 0 ? Infinity : 0);
      return { id: a.id, demand_mbps: round(d), usable_mbps: a.usable_mbps, utilisation_pct: isFinite(util) ? round(util) : null, over: d > a.usable_mbps };
    });
    return { zones: zones, aps: aps };
  }

  // ------------------------------------------------------------------ IoT
  /** Signal at each device on a floor against its class sensitivity, with a fix for devices below it or within the marginal margin. */
  function iotReport(project, floorId, config, opts) {
    var o = opts || {}, pm = config.planner_modes, env = o.env || E.makeEnv(config, project.materials), floor = E.findFloor(project, floorId), apById = apIndex(project);
    return (floor.devices || []).map(function (d) {
      var cls = pm.iot_classes[d.cls], p = E.probeAt(project, floorId, d.x, d.y, { env: env, mode: o.mode || "basic", band: o.band });
      var margin = round(p.rssi_dbm - cls.min_dbm), status = margin < 0 ? "fail" : margin < pm.iot.marginal_margin_db ? "marginal" : "ok", fix = "";
      if (status !== "ok") {
        var best = p.ap_id && apById[p.ap_id] ? apById[p.ap_id].ap : null;
        var target = status === "fail" ? -margin : pm.iot.marginal_margin_db - margin;
        if (best && best.tx_dbm + target <= config.planner.max_tx_dbm) { fix = "Raise " + best.id + " by about " + round(target) + " dB (to " + round(best.tx_dbm + target) + " dBm), or move the device closer."; }
        else {
          var ax = Math.min(floor.width_m, Math.max(0, d.x + pm.iot.suggest_offset_m)), probeProject = JSON.parse(JSON.stringify(project));
          probeProject.floors.forEach(function (f) { if (f.id === floorId) { f.aps.push({ id: "hypothetical", x: ax, y: d.y, tx_dbm: config.planner.default_tx_dbm }); } });
          var q = E.probeAt(probeProject, floorId, d.x, d.y, { env: env, mode: o.mode || "basic", band: o.band });
          fix = "Add an AP about " + pm.iot.suggest_offset_m + " m from the device (estimated " + q.rssi_dbm + " dBm there), or use a repeater.";
        }
      }
      return { id: d.id, name: d.name || d.id, cls: d.cls, class_label: cls.label, x: d.x, y: d.y, rssi_dbm: p.rssi_dbm, min_dbm: cls.min_dbm, margin_db: margin, status: status, ap_id: p.ap_id, fix: fix };
    });
  }

  // ------------------------------------------------------------------ enterprise lattice
  /** Square lattice of APs over a floor, cells centred, channels coloured (c + 2r) mod n so lattice neighbours differ. Deterministic. */
  function enterpriseLayout(floor, config, opts) {
    var en = config.planner_modes.enterprise, band = (opts && opts.band) || en.default_band, tx = opts && opts.tx_dbm !== undefined ? opts.tx_dbm : en.default_tx_dbm;
    var spacing = (opts && opts.spacing_m) || en.spacing_m[band], channels = config.planner.channel_sets[band];
    var cols = Math.max(1, Math.round(floor.width_m / spacing)), rows = Math.max(1, Math.round(floor.depth_m / spacing)), aps = [];
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        aps.push({ id: ((opts && opts.id_prefix) || "ap") + (aps.length + 1), x: round((c + 0.5) * floor.width_m / cols, 2), y: round((r + 0.5) * floor.depth_m / rows, 2), tx_dbm: tx, band: band, channel: channels[(c + 2 * r) % channels.length] });
      }
    }
    return { cols: cols, rows: rows, spacing_x_m: round(floor.width_m / cols, 2), spacing_y_m: round(floor.depth_m / rows, 2), aps: aps };
  }

  /** Bill of quantities rows for a list of APs (ESTIMATE: planning rules of thumb from rf-config.json). */
  function billOfQuantities(aps, config, floorName) {
    var en = config.planner_modes.enterprise, n = aps.length, byBand = {};
    aps.forEach(function (a) { var b = a.band || "2.4"; byBand[b] = (byBand[b] || 0) + 1; });
    var ports = Math.ceil(n * (1 + en.spare_port_pct / 100)), cable = Math.ceil(n * en.avg_cable_run_m * (1 + en.cable_spare_pct / 100));
    var rows = [["Item", "Quantity", "Unit", "Notes"]];
    Object.keys(byBand).sort().forEach(function (b) { rows.push(["Access point, " + b + " GHz primary", byBand[b], "each", "Floor: " + floorName]); });
    rows.push(["Mounting kit", n, "each", "One per access point"], ["PoE switch ports", ports, "ports", "Includes " + en.spare_port_pct + "% spare"],
      ["PoE switch, " + en.switch_ports + " ports", Math.ceil(ports / en.switch_ports), "each", ""], ["Cat6A cable", cable, "m", n + " runs of " + en.avg_cable_run_m + " m plus " + en.cable_spare_pct + "% spare"],
      ["Note", "", "", ESTIMATE + ": planning rules of thumb, confirm with a site survey and the vendor design guide"]);
    return rows;
  }

  // ------------------------------------------------------------------ timeline chart model
  /** Pixel geometry of the timeline chart: signal line points, handoff markers and the roam threshold line. Pure, tested under node. */
  function timelineChartModel(result, config, size) {
    var an = config.analytics, lo = config.engine.no_signal_dbm, hi = -30, total = Math.max(result.summary.length_m, 1e-9), pad = 24;
    function px(sM) { return pad + (size.w - 2 * pad) * sM / total; }
    function py(dbm) { var v = Math.min(hi, Math.max(lo, dbm)); return size.h - pad - (size.h - 2 * pad) * (v - lo) / (hi - lo); }
    return { line: result.samples.map(function (s) { return [px(s.s_m), py(s.rssi_dbm)]; }),
             best: result.samples.map(function (s) { return [px(s.s_m), py(s.best_rssi_dbm)]; }),
             events: result.events.map(function (e) { return { kind: e.kind, x: px(e.s_m), label: e.kind === "handoff" ? e.from_ap + " to " + e.to_ap : e.kind === "coverage_lost" ? "coverage lost" : "coverage regained" }; }),
             roam_y: py(an.roam_min_dbm), dead_y: py(an.dead_zone_dbm), x_of: px, pad: pad };
  }

  /** Text lines of the events of a timeline, in walking order. */
  function timelineEventLines(result) {
    return result.events.map(function (e) {
      var at = "at " + e.s_m + " m (" + e.x + " m, " + e.y + " m)";
      return e.kind === "handoff" ? "Handoff from " + e.from_ap + " (" + e.from_rssi_dbm + " dBm) to " + e.to_ap + " (" + e.to_rssi_dbm + " dBm) " + at
        : (e.kind === "coverage_lost" ? "Coverage lost " : "Coverage regained ") + at + ", " + e.rssi_dbm + " dBm";
    });
  }

  // ------------------------------------------------------------------ UI
  function mount(app) {
    var P = root.PlannerPanels, X = root.PlannerExport, S = root.PlannerState, el = P.el, H = root.PlannerHeat;
    var panel = app.tabs.add("modes", "Modes"), pm = app.config.planner_modes;
    var last = { stack: null, enterprise: null, iot: null }, three = { loaded: false, on: false };
    function floor() { return app.currentFloor(); }
    function analysis() { var a = app.panels && app.panels.state.analysis; return a && a.floor === app.store.floorId ? a.analytics : null; }
    function box(title, kids) { return el("section", { class: "mode-box" }, [el("h3", { text: title })].concat(kids)); }
    function note(t) { return el("p", { class: "muted hint", text: t }); }
    var host = el("div", { class: "mode-grid" });
    panel.appendChild(el("p", { class: "muted hint", text: pm.label }));
    panel.appendChild(host);

    // ---- multi-floor and vertical penetration
    var stackBox = el("div"), stackStatus = el("p", { class: "muted", role: "status" });
    function runStack() {
      stackStatus.textContent = "Analysing floors...";
      app.runJob({ type: "stack", cell_m: P.analysisCell(floor()) }, { result: function (m) { last.stack = m; stackStatus.textContent = ""; renderStack(); }, error: function (m) { stackStatus.textContent = "Failed: " + m.message; } });
    }
    function renderStack() {
      stackBox.textContent = "";
      var loss = app.config.floor_loss_db;
      stackBox.appendChild(P.table("Vertical penetration: signal loss per floor crossed (typical value, " + ESTIMATE + ")", ["Band", "Loss per floor"], Object.keys(loss).map(function (b) { return [b + " GHz", loss[b] + " dB"]; })));
      if (last.stack) {
        stackBox.appendChild(P.table("Floor stack. Coverage with all APs against only this floor's own APs: the difference is the contribution from other floors (" + ESTIMATE + ").",
          ["Floor", "Level", "APs", "Coverage (all APs)", "Coverage (own APs only)", "From other floors", "Average RSSI", "Dead zone"],
          last.stack.floors.slice().sort(function (a, b) { return b.level - a.level; }).map(function (f) { return [f.name, String(f.level), String(f.aps), P.pct(f.coverage_pct), P.pct(f.own_coverage_pct), P.signed(f.coverage_pct - f.own_coverage_pct) + " pts", P.f1(f.avg_rssi_dbm) + " dBm", P.pct(f.dead_zone_pct)]; })));
      }
    }
    host.appendChild(box("Multi-floor analysis", [note("Floors above and below add signal through the configured floor loss. Use the Floor selector above the plan to edit another floor."),
      el("div", { class: "tool-row" }, [P.button("Add floor", function () {
        var p = app.store.project, f = S.newFloor(p);
        app.store.exec({ label: "Add floor", ops: [S.addFloorOp(p, f)] }); app.say("Added " + f.name + " (level " + f.level + ")");
      }, { id: "addFloor", title: "Adds an empty floor above the top floor. Undoable." }), P.button("Analyse floor stack", runStack, { id: "runStack" })]), stackStatus, stackBox]));
    renderStack();

    // ---- 3D building (reuses Room3D from view3d.js)
    var cv = el("canvas", { id: "room3d", class: "room3d-box", tabindex: "0", role: "img", "aria-label": "3D view of the planner floors with the signal map. Drag to orbit, scroll to zoom." }), threeMsg = el("p", { class: "muted", role: "status" });
    cv.hidden = true;
    function sync3d() {
      if (!three.on || !root.Room3D) { return; }
      var p = app.store.project;
      root.Room3D.setTwin(p); root.Room3D.setTwinFloor("all"); root.Room3D.setViewMode("signal"); root.Room3D.showHeat(true);
      p.floors.forEach(function (f) {
        var res = root.RFEngine.coverageGrid(p, f.id, { env: app.env, cellM: P.analysisCell(f) * 2, band: app.settings.band, mode: app.settings.mode });
        root.Room3D.setHeat(f.id, res);
      });
    }
    function toggle3d() {
      if (three.on) { three.on = false; cv.hidden = true; threeMsg.textContent = "3D view hidden."; return; }
      function go() {
        try {
          if (!three.inited) { root.Room3D.init(cv); three.inited = true; }
          cv.hidden = false; three.on = true; sync3d(); threeMsg.textContent = "3D building view: " + ESTIMATE + " heat map per floor, MODEL ESTIMATE, not a measurement.";
        } catch (e) { threeMsg.textContent = "3D view failed: " + e.message; }
      }
      if (root.Room3D) { go(); return; }
      var s = root.document.createElement("script"); s.src = app.assetUrl("view3d.js");
      s.onload = go; s.onerror = function () { threeMsg.textContent = "Could not load view3d.js"; };
      root.document.head.appendChild(s);
    }
    host.appendChild(box("3D building mode", [note("Reuses the dashboard 3D renderer (view3d.js, loaded on demand) to show every floor with its walls and signal map."),
      el("div", { class: "tool-row" }, [P.button("Show or hide 3D view", toggle3d, { id: "toggle3d" }), P.button("Refresh 3D", sync3d)]), threeMsg, cv]));
    app.store.subscribe(function (ev) { if (three.on && ev.source !== "select") { root.setTimeout(sync3d, 400); } });

    // ---- mesh
    var meshBox = el("div");
    function renderMesh() {
      meshBox.textContent = "";
      var p = app.store.project, aps = [];
      p.floors.forEach(function (f) { f.aps.forEach(function (a) { aps.push({ ap: a, floor: f }); }); });
      var rows = aps.map(function (e) {
        var sel = el("select", { "aria-label": "Backhaul of " + e.ap.id });
        sel.appendChild(el("option", { value: "", text: "wired" }));
        aps.forEach(function (o) { if (o.ap.id !== e.ap.id && !wouldLoop(p, e.ap.id, o.ap.id)) { sel.appendChild(el("option", { value: o.ap.id, text: "mesh via " + o.ap.id })); } });
        sel.value = e.ap.mesh_parent || "";
        sel.addEventListener("change", function () { app.store.exec({ label: "Set mesh backhaul", ops: [S.setOp("ap", p, e.floor.id, e.ap.id, { mesh_parent: sel.value || undefined })] }); });
        return [e.ap.id + " (" + e.floor.name + ")", sel];
      });
      meshBox.appendChild(P.table("Backhaul per access point", ["AP", "Uplink"], rows));
      var an = analysis(), usable = {};
      if (an) { an.aps.forEach(function (a) { usable[a.id] = a.usable_mbps; }); }
      var rep = meshReport(p, app.config, { env: app.env, mode: app.settings.mode, usable: usable });
      meshBox.appendChild(P.table("Mesh nodes (throughput " + ESTIMATE + ", halved per wireless hop)", ["Node", "Uplink", "Hops", "Backhaul RSSI", "Slowest link", "End to end", "Client side", "Effective", "Notes"],
        rep.map(function (r) { return r.error ? [r.id, r.parent, String(r.hops), "-", "-", "-", "-", "-", r.error] : [r.id, r.parent, String(r.hops), P.f1(r.backhaul_rssi_dbm) + " dBm", P.f1(r.link_mbps) + " Mbps", P.f1(r.e2e_mbps) + " Mbps", r.usable_mbps === null ? "-" : P.f1(r.usable_mbps) + " Mbps", P.f1(r.effective_mbps) + " Mbps", r.notes.join("; ") || "ok"]; })));
    }
    host.appendChild(box("Mesh network simulation", [note("Pick an uplink for an AP to make it a mesh node. Backhaul RSSI comes from the engine (walls and floors between the two APs)."), meshBox]));

    // ---- capacity
    var capBox = el("div");
    function renderCapacity() {
      capBox.textContent = "";
      var f = floor(), p = app.store.project, an = analysis();
      if (!f.rooms.length) { capBox.appendChild(note("This floor has no rooms. Rooms come from the digital twin.")); return; }
      var rows = f.rooms.map(function (r) {
        var key = f.id + "/" + r.id, cur = (p.capacity || {})[key] || { users: 0, profile: "office" };
        var users = el("input", { type: "number", min: "0", max: "5000", step: "1", value: String(cur.users), "aria-label": "Users in " + (r.name || r.id) }), prof = el("select", { "aria-label": "Demand profile for " + (r.name || r.id) });
        Object.keys(pm.capacity_profiles).forEach(function (k) { prof.appendChild(el("option", { value: k, text: pm.capacity_profiles[k].label + " (" + pm.capacity_profiles[k].mbps + " Mbps)" })); });
        prof.value = cur.profile;
        function save() {
          var next = Object.assign({}, p.capacity || {}), n = Math.max(0, Math.min(5000, Math.floor(parseFloat(users.value) || 0)));
          if (n) { next[key] = { users: n, profile: prof.value }; } else { delete next[key]; }
          app.store.setMeta("capacity", next); renderCapacity();
        }
        users.addEventListener("change", save); prof.addEventListener("change", save);
        return [r.name || r.id, users, prof];
      });
      capBox.appendChild(P.table("Users per room", ["Room", "Users", "Demand profile"], rows));
      if (!an) { capBox.appendChild(note("Waiting for analytics...")); return; }
      var rep = capacityReport(p, f.id, an, app.config);
      capBox.appendChild(P.table("Demand per zone (" + ESTIMATE + ")", ["Room", "Users", "Profile", "Demand", "Served by"], rep.zones.map(function (z) { return [z.room, String(z.users), z.profile, P.f1(z.demand_mbps) + " Mbps", z.ap_id || "no coverage"]; })));
      capBox.appendChild(P.table("Access point load against usable throughput (" + ESTIMATE + "). Over capacity is flagged.", ["AP", "Demand", "Usable", "Utilisation", "Status"],
        rep.aps.map(function (a) { return [a.id, P.f1(a.demand_mbps) + " Mbps", P.f1(a.usable_mbps) + " Mbps", a.utilisation_pct === null ? "n/a" : a.utilisation_pct + "%", a.over ? "OVER CAPACITY" : "ok"]; })));
    }
    host.appendChild(box("Capacity planning", [note("Enter users per room and a demand profile. The AP that serves the room centre carries the demand."), capBox]));

    // ---- IoT
    var iotBox = el("div"), clsSel = el("select", { id: "iotClass", "aria-label": "Device class" });
    Object.keys(pm.iot_classes).forEach(function (k) { clsSel.appendChild(el("option", { value: k, text: pm.iot_classes[k].label + " (needs " + pm.iot_classes[k].min_dbm + " dBm)" })); });
    function addDevice(pt) {
      var f = floor(), st = app.store, d = { id: S.nextId(f.devices, "d"), cls: clsSel.value, x: Math.min(f.width_m, Math.max(0, pt.x)), y: Math.min(f.depth_m, Math.max(0, pt.y)) };
      st.exec({ label: "Add device", ops: [S.addOp("device", st.project, f.id, d)] });
    }
    app.deviceTool = function (phase, raw) { if (phase === "down") { addDevice(raw); return true; } return false; };
    function renderIot() {
      iotBox.textContent = "";
      var f = floor(), rep = iotReport(app.store.project, f.id, app.config, { env: app.env, mode: app.settings.mode, band: app.settings.band });
      iotBox.appendChild(P.table("Devices on " + f.name + " (signal " + ESTIMATE + ")", ["Device", "Class", "Signal", "Needs", "Margin", "Status", "Suggested fix", "Remove"],
        rep.map(function (r) { return [r.name, r.class_label, P.f1(r.rssi_dbm) + " dBm", r.min_dbm + " dBm", P.signed(r.margin_db) + " dB", r.status.toUpperCase(), r.fix || "-",
          P.button("Delete", function () { app.store.exec({ label: "Delete device", ops: [S.removeOp("device", app.store.project, f.id, r.id)] }); }, { "aria-label": "Delete device " + r.name })]; })));
    }
    host.appendChild(box("IoT device placement", [note("Place devices with the Device tool (click the plan) or at the probe point. Each class has a receiver sensitivity from rf-config.json."),
      el("div", { class: "tool-row" }, [clsSel, P.button("Device tool", function () { app.editor.setTool("device"); }, { "data-tool": "device", "aria-pressed": "false" }),
        P.button("Add at probe point", function () { var f = floor(), pt = app.probe || { x: f.width_m / 2, y: f.depth_m / 2 }; addDevice(pt); }, { id: "iotAdd" })]), iotBox]));

    // ---- enterprise
    var entBox = el("div"), entMsg = el("p", { class: "muted", role: "status" });
    var bandSel = el("select", { id: "entBand", "aria-label": "Band" }), txIn = el("input", { type: "number", id: "entTx", min: "5", max: "23", step: "1", value: String(pm.enterprise.default_tx_dbm), "aria-label": "Transmit power in dBm" });
    Object.keys(pm.enterprise.spacing_m).forEach(function (b) { bandSel.appendChild(el("option", { value: b, text: b + " GHz" })); });
    bandSel.value = pm.enterprise.default_band;
    var spaceIn = el("input", { type: "number", id: "entSpacing", min: "3", max: "60", step: "0.5", value: "", placeholder: "auto", "aria-label": "Spacing in metres" });
    function layout() { return enterpriseLayout(floor(), app.config, { band: bandSel.value, tx_dbm: parseFloat(txIn.value), spacing_m: parseFloat(spaceIn.value) || undefined, id_prefix: floor().id + "-ap" }); }
    function renderEnterprise() {
      entBox.textContent = "";
      var l = layout(), rows = [["Lattice", l.cols + " x " + l.rows + " (spacing " + l.spacing_x_m + " x " + l.spacing_y_m + " m)"], ["Access points", String(l.aps.length)],
        ["Channels used", Array.from(new Set(l.aps.map(function (a) { return a.channel; }))).join(", ")]];
      if (last.enterprise) { rows.push(["Estimated coverage", P.pct(last.enterprise.coverage_pct)], ["Estimated client capacity (" + ESTIMATE + ")", last.enterprise.client_capacity + " in total, about " + Math.floor(last.enterprise.client_capacity / Math.max(1, last.enterprise.aps)) + " per AP"]); }
      entBox.appendChild(P.table("Layout preview", ["Item", "Value"], rows));
      entBox.appendChild(P.table("Bill of quantities (" + ESTIMATE + ")", billOfQuantities(l.aps, app.config, floor().name)[0], billOfQuantities(l.aps, app.config, floor().name).slice(1)));
    }
    function layoutProject(l) {
      var p = S.computeProject(app.store.project), f = S.findFloor(p, app.store.floorId);
      f.aps = l.aps.map(function (a) { return Object.assign({}, a); });
      return p;
    }
    function evaluateLayout() {
      var l = layout(); entMsg.textContent = "Evaluating...";
      app.runJob({ type: "rank", floor: app.store.floorId, cell_m: P.analysisCell(floor()), items: [{ id: "layout", name: "Layout", project: layoutProject(l) }] }, {
        result: function (m) { last.enterprise = m.rows[0]; entMsg.textContent = "Evaluated layout of " + l.aps.length + " APs."; renderEnterprise(); },
        error: function (m) { entMsg.textContent = "Failed: " + m.message; }
      });
    }
    function applyLayout() {
      var l = layout(), f = floor(), st = app.store;
      if (!root.confirm("Replace the " + f.aps.length + " access points on " + f.name + " with " + l.aps.length + " lattice APs? You can undo this.")) { return; }
      var ops = f.aps.map(function (a) { return S.removeOp("ap", st.project, f.id, a.id); }).concat(l.aps.map(function (a) { return S.addOp("ap", st.project, f.id, a); }));
      st.exec({ label: "Apply enterprise layout", ops: ops }); entMsg.textContent = "Applied " + l.aps.length + " APs. Undo restores the old layout.";
    }
    [bandSel, txIn, spaceIn].forEach(function (c) { c.addEventListener("change", function () { last.enterprise = null; renderEnterprise(); }); });
    host.appendChild(box("Enterprise deployment planner", [note("Generates a square lattice of APs for a large floor with a channel plan and a bill of quantities."),
      el("div", { class: "tool-row" }, [el("label", { class: "inline" }, ["Band ", bandSel]), el("label", { class: "inline" }, ["TX dBm ", txIn]), el("label", { class: "inline" }, ["Spacing m ", spaceIn])]),
      el("div", { class: "tool-row" }, [P.button("Evaluate layout", evaluateLayout, { id: "entEval" }), P.button("Apply layout", applyLayout, { id: "entApply" }), P.button("Bill of quantities CSV", function () { app.exportRun("boq"); }, { id: "entBoq" })]), entMsg, entBox]));
    X.register("boq", { label: "Bill of quantities CSV (enterprise)", run: function (ctx) {
      var f = ctx.app.currentFloor();
      return { name: (ctx.app.store.project.name || "project").replace(/[^\w.-]+/g, "_") + "-" + f.id + "-bill-of-quantities.csv", mime: "text/csv", data: X.toCsv(billOfQuantities(f.aps, ctx.app.config, f.name)) };
    } });
    if (app.tabs.rerenderExport) { app.tabs.rerenderExport(); }


    mountTwinLab(app);

    function renderAll() { renderMesh(); renderCapacity(); renderIot(); renderEnterprise(); }
    app.onAnalysis = renderAll;
    app.store.subscribe(function (ev) { if (ev.source !== "select") { renderAll(); } });
    renderAll();
    app.modes = { renderAll: renderAll, last: last };
  }

  // ------------------------------------------------------------------ timeline, what-if, recommendations, design (tab "Timeline and what-if")
  function mountTwinLab(app) {
    var P = root.PlannerPanels, S = root.PlannerState, el = P.el, E_ = root.RFEngine, Opt = root.RFOptimizer, doc = root.document;
    var demo = !!root.WALLHACK_DEMO, tl = app.config.timeline, rc = app.config.recommendations;
    var panel = app.tabs.add("twinlab", "Timeline and what-if");
    var st = { path: [], result: null, index: 0, plan: null, recs: null };
    function floor() { return app.currentFloor(); }
    function note(t) { return el("p", { class: "muted hint", text: t }); }
    function box(title, kids) { return el("section", { class: "mode-box" }, [el("h3", { text: title })].concat(kids)); }
    var host = el("div", { class: "mode-grid" });
    panel.appendChild(el("p", { class: "muted hint", text: tl.label }));
    panel.appendChild(host);

    // ---- walking timeline
    var tlOut = el("div"), tlMsg = el("p", { class: "muted", role: "status" }), scrub = el("input", { type: "range", id: "tlScrub", min: "0", max: "0", step: "1", value: "0", "aria-label": "Position along the walking path" });
    var chart = el("canvas", { id: "tlChart", class: "tl-chart", width: "560", height: "180", role: "img", "aria-label": "Signal strength along the walking path with handoff markers" });
    var readout = el("p", { id: "tlReadout", role: "status", "aria-live": "polite" });
    function drawChart() {
      var c = chart.getContext("2d"), w = chart.width, h = chart.height;
      c.clearRect(0, 0, w, h);
      if (!st.result) { return; }
      var m = timelineChartModel(st.result, app.config, { w: w, h: h });
      c.lineWidth = 1; c.strokeStyle = "#475569"; c.setLineDash([4, 4]);
      [m.roam_y, m.dead_y].forEach(function (y) { c.beginPath(); c.moveTo(m.pad, y); c.lineTo(w - m.pad, y); c.stroke(); });
      c.setLineDash([]); c.lineWidth = 1; c.strokeStyle = "#64748b";
      c.beginPath(); m.best.forEach(function (p, i) { if (i) { c.lineTo(p[0], p[1]); } else { c.moveTo(p[0], p[1]); } }); c.stroke();
      c.lineWidth = 2; c.strokeStyle = "#38bdf8"; c.beginPath(); m.line.forEach(function (p, i) { if (i) { c.lineTo(p[0], p[1]); } else { c.moveTo(p[0], p[1]); } }); c.stroke();
      c.fillStyle = "#fbbf24"; c.font = "11px sans-serif";
      m.events.forEach(function (e) { c.fillRect(e.x - 1, m.pad, 2, h - 2 * m.pad); c.fillText(e.label, Math.min(e.x + 3, w - 90), m.pad - 6); });
      var cur = m.line[st.index];
      if (cur) { c.fillStyle = "#f8fafc"; c.beginPath(); c.arc(cur[0], cur[1], 4, 0, Math.PI * 2); c.fill(); }
    }
    function showSample() {
      var s = st.result && st.result.samples[st.index];
      readout.textContent = s ? "At " + s.s_m + " m on floor " + s.floor + ": " + s.rssi_dbm + " dBm from " + (s.ap_id || "no AP") + " (" + s.quality + "), about " + s.throughput_mbps + " Mbps" +
        (s.in_handoff_zone ? ", in a handoff zone" : "") + (s.best_ap_id && s.best_ap_id !== s.ap_id ? ", " + s.best_ap_id + " is stronger at " + s.best_rssi_dbm + " dBm but the client has not roamed yet" : "") + "." : "";
      drawChart(); app.editor.invalidate();
    }
    scrub.addEventListener("input", function () { st.index = parseInt(scrub.value, 10) || 0; showSample(); });
    function renderTimeline() {
      tlOut.textContent = "";
      var r = st.result;
      if (!r) { return; }
      var sm = r.summary;
      tlOut.appendChild(P.table("Walk summary (" + ESTIMATE + ")", ["Item", "Value"], [["Length", sm.length_m + " m"], ["Samples", String(sm.samples) + " every " + sm.step_m + " m"], ["Handoffs", String(sm.handoffs)],
        ["Time in a handoff zone", P.pct(sm.handoff_zone_pct)], ["Samples below the dead zone level", P.pct(sm.dead_samples_pct)], ["Weakest signal", sm.min_rssi_dbm + " dBm"],
        ["Mean signal", (sm.mean_rssi_dbm === null ? "n/a" : sm.mean_rssi_dbm + " dBm")], ["Mean speed", (sm.mean_throughput_mbps === null ? "n/a" : sm.mean_throughput_mbps + " Mbps")],
        ["Samples on a weaker AP than the best (sticky client)", sm.sticky_samples + (sm.sticky_samples ? ", up to " + sm.max_sticky_gap_db + " dB" : "")]]));
      var lines = timelineEventLines(r), ul = el("ul", { id: "tlEvents" });
      lines.forEach(function (l) { ul.appendChild(el("li", { text: l })); });
      tlOut.appendChild(el("h4", { text: "Events" })); tlOut.appendChild(lines.length ? ul : note("No handoffs or coverage changes on this path."));
    }
    function runTimeline() {
      if (!st.path.length) { tlMsg.textContent = "Draw a path first: press Draw path, then click at least two points on the plan."; return; }
      try {
        st.result = E_.signalTimeline(app.store.project, st.path, { env: app.env, band: app.settings.band || undefined, mode: app.settings.mode });
      } catch (e) { tlMsg.textContent = "Could not run the timeline: " + e.message; return; }
      st.index = 0; scrub.max = String(st.result.samples.length - 1); scrub.value = "0";
      tlMsg.textContent = "Walk of " + st.result.summary.length_m + " m with " + st.result.summary.handoffs + " handoffs (" + ESTIMATE + ").";
      renderTimeline(); showSample();
    }
    app.pathTool = function (phase, raw) {
      if (phase !== "down") { return phase === "move"; }
      var f = floor();
      if (st.path.length >= tl.max_waypoints) { tlMsg.textContent = "A path can have at most " + tl.max_waypoints + " points."; return true; }
      st.path.push({ floor: f.id, x: round(Math.min(f.width_m, Math.max(0, raw.x)), 2), y: round(Math.min(f.depth_m, Math.max(0, raw.y)), 2) });
      st.result = null; tlMsg.textContent = st.path.length + " points. Press Run timeline when the path is done."; renderTimeline(); drawChart(); app.editor.invalidate();
      return true;
    };
    app.overlay(function (c, view) {
      if (!st.path.length) { return; }
      var f = floor(), pts = st.path.filter(function (p) { return p.floor === f.id; });
      function sx(x) { return view.ox + x * view.scale; }
      function sy(y) { return view.oy + y * view.scale; }
      c.save(); c.strokeStyle = "#38bdf8"; c.lineWidth = 2; c.setLineDash([6, 4]); c.beginPath();
      pts.forEach(function (p, i) { if (i) { c.lineTo(sx(p.x), sy(p.y)); } else { c.moveTo(sx(p.x), sy(p.y)); } }); c.stroke(); c.setLineDash([]);
      pts.forEach(function (p) { c.fillStyle = "#38bdf8"; c.beginPath(); c.arc(sx(p.x), sy(p.y), 4, 0, Math.PI * 2); c.fill(); });
      var s = st.result && st.result.samples[st.index];
      if (s && s.floor === f.id) { c.fillStyle = "#fbbf24"; c.beginPath(); c.arc(sx(s.x), sy(s.y), 6, 0, Math.PI * 2); c.fill(); }
      c.restore();
    });
    host.appendChild(box("Walking timeline and handoffs", [note("Draw a walking path on the plan. The client keeps its AP until a stronger one wins by " + tl.hysteresis_db + " dB or the signal drops below " + app.config.analytics.roam_min_dbm + " dBm."),
      el("div", { class: "tool-row" }, [P.button("Draw path", function () { app.editor.setTool("path"); }, { id: "tlDraw", "data-tool": "path", "aria-pressed": "false" }),
        P.button("Run timeline", runTimeline, { id: "tlRun" }), P.button("Clear path", function () { st.path = []; st.result = null; tlMsg.textContent = "Path cleared."; renderTimeline(); drawChart(); app.editor.invalidate(); }, { id: "tlClear" })]),
      tlMsg, chart, el("label", { class: "inline" }, ["Scrub ", scrub]), readout, tlOut]));

    // ---- what-if
    var kindSel = el("select", { id: "wiKind", "aria-label": "Kind of change" }), apSel = el("select", { id: "wiAp", "aria-label": "Access point" }), valSel = el("select", { id: "wiValue", "aria-label": "New value" });
    var xIn = el("input", { type: "number", id: "wiX", step: "0.5", "aria-label": "X in metres" }), yIn = el("input", { type: "number", id: "wiY", step: "0.5", "aria-label": "Y in metres" });
    var wiOut = el("div", { id: "wiOut" }), wiMsg = el("p", { class: "muted", role: "status" });
    var KINDS = [["move_ap", "Move an AP"], ["upgrade_standard", "Upgrade the WiFi standard"], ["upgrade_profile", "Switch to an AP class profile"], ["remove_wall", "Remove a wall"], ["add_mesh_node", "Add a mesh node"], ["set_channels", "Change the channel"]];
    KINDS.forEach(function (k) { kindSel.appendChild(el("option", { value: k[0], text: k[1] })); });
    function fillOptions(sel, pairs) { sel.textContent = ""; pairs.forEach(function (p) { sel.appendChild(el("option", { value: p[0], text: p[1] })); }); }
    function refreshWhatIf() {
      var f = floor(), k = kindSel.value;
      fillOptions(apSel, f.aps.map(function (a) { return [a.id, a.id]; }));
      if (k === "remove_wall") { fillOptions(valSel, f.walls.map(function (w) { return [w.id, w.id + " (" + w.material + ")"]; })); }
      else if (k === "upgrade_standard") { fillOptions(valSel, Object.keys(app.config.wifi_standards.standards).map(function (id) { return [id, app.config.wifi_standards.standards[id].label]; })); }
      else if (k === "upgrade_profile") { fillOptions(valSel, Object.keys(app.config.ap_profiles.profiles).map(function (id) { return [id, app.config.ap_profiles.profiles[id].label]; })); }
      else if (k === "set_channels") { var ch = app.config.planner.channel_sets[app.settings.band || app.config.planner.default_band] || []; fillOptions(valSel, ch.map(function (c) { return [String(c), "Channel " + c]; })); }
      else { fillOptions(valSel, []); }
      apSel.disabled = k === "remove_wall" || k === "add_mesh_node"; valSel.disabled = k === "move_ap" || k === "add_mesh_node";
      xIn.disabled = yIn.disabled = !(k === "move_ap" || k === "add_mesh_node");
    }
    kindSel.addEventListener("change", refreshWhatIf);
    function changeFromForm() {
      var f = floor(), k = kindSel.value, x = parseFloat(xIn.value), y = parseFloat(yIn.value);
      if (k === "move_ap") { return { kind: k, ap_id: apSel.value, x: x, y: y }; }
      if (k === "upgrade_standard") { return { kind: k, ap_id: apSel.value, standard: valSel.value }; }
      if (k === "upgrade_profile") { return { kind: k, ap_id: apSel.value, profile_id: valSel.value }; }
      if (k === "remove_wall") { return { kind: k, floor: f.id, wall_id: valSel.value }; }
      if (k === "add_mesh_node") { return { kind: k, floor: f.id, x: x, y: y, parent_ap_id: f.aps.length ? f.aps[0].id : undefined }; }
      return { kind: k, assignments: [{ ap_id: apSel.value, channel: parseInt(valSel.value, 10) }] };
    }
    function showDiff(target, w, caption) {
      var b = w.before, a = w.after, d = w.delta;
      target.textContent = "";
      target.appendChild(P.table(caption, ["Measure", "Before", "After", "Change"], [
        ["Coverage score (out of 100)", b.score, a.score, P.signed(d.score)], ["Coverage", P.pct(b.coverage_pct), P.pct(a.coverage_pct), P.signed(d.coverage_pct) + " pts"],
        ["Dead zone", P.pct(b.dead_zone_pct), P.pct(a.dead_zone_pct), P.signed(d.dead_zone_pct) + " pts"], ["Average speed", b.mean_throughput_mbps + " Mbps", a.mean_throughput_mbps + " Mbps", P.signed(d.mean_throughput_mbps) + " Mbps"],
        ["Client capacity", String(b.client_capacity), String(a.client_capacity), P.signed(d.client_capacity)], ["Optimiser score", b.optimiser_score, a.optimiser_score, P.signed(d.optimiser_score)]]));
      target.appendChild(note("Confidence " + w.confidence + ". " + w.reason));
    }
    function runWhatIf() {
      try {
        var change = changeFromForm(), f = floor();
        var w = Opt.whatIf(app.store.project, f.id, change, { env: app.env, band: app.settings.band || undefined, mode: app.settings.mode, cellM: P.analysisCell(f), floor: f.id });
        showDiff(wiOut, w, "Before and after (" + ESTIMATE + ", " + (KINDS.filter(function (k) { return k[0] === change.kind; })[0][1]) + ")"); wiMsg.textContent = "";
      } catch (e) { wiMsg.textContent = "Could not run the what-if: " + e.message; }
    }
    host.appendChild(box("What-if comparison", [note("Pick one change. The plan is copied, the change applied to the copy, and both runs of the engine are compared."),
      el("div", { class: "tool-row" }, [kindSel, apSel, valSel, el("label", { class: "inline" }, ["x ", xIn]), el("label", { class: "inline" }, ["y ", yIn]), P.button("Compare", runWhatIf, { id: "wiRun" })]), wiMsg, wiOut]));

    // ---- apply helpers shared by recommendations and the design
    function opsFor(change, f) {
      var p = app.store.project;
      if (change.kind === "move_ap") { return [S.setOp("ap", p, f.id, change.ap_id, { x: change.x, y: change.y })]; }
      if (change.kind === "upgrade_standard") { return [S.setOp("ap", p, f.id, change.ap_id, { standard: change.standard })]; }
      if (change.kind === "set_channels") { return change.assignments.map(function (a) { return S.setOp("ap", p, f.id, a.ap_id, { channel: a.channel }); }); }
      if (change.kind === "add_mesh_node") {
        var target = S.findFloor(p, change.floor), node = { id: S.nextId(target.aps, "mesh"), x: change.x, y: change.y, tx_dbm: app.config.planner.default_tx_dbm, band: app.config.planner.default_band };
        if (change.parent_ap_id) { node.mesh_parent = change.parent_ap_id; }
        return [S.addOp("ap", p, change.floor, node)];
      }
      return [];
    }

    // ---- recommendations
    var recOut = el("div", { id: "recOut" }), recMsg = el("p", { class: "muted", role: "status" });
    function renderRecs() {
      recOut.textContent = "";
      var r = st.recs;
      if (!r) { return; }
      recOut.appendChild(el("p", { id: "recScore", class: "stat-v", text: "Coverage score " + r.score + " out of 100" }));
      if (!r.actions.length) { recOut.appendChild(note(r.note)); return; }
      recOut.appendChild(P.table("Ranked actions, each measured on a copy of the plan (" + ESTIMATE + ")", ["#", "Action", "Score", "Coverage", "Speed", "Confidence", "Apply"],
        r.actions.map(function (a) {
          var ops = opsFor(a.change, floor());
          return [String(a.rank), a.text, a.before.score + " to " + a.after.score + " (" + P.signed(a.delta.score) + ")", P.signed(a.delta.coverage_pct) + " pts", P.signed(a.delta.mean_throughput_mbps) + " Mbps", String(a.confidence),
            ops.length ? P.button("Apply", function () { app.store.exec({ label: a.text, ops: ops }); recMsg.textContent = "Applied: " + a.text + ". Undo with Ctrl+Z."; }, { "aria-label": "Apply: " + a.text }) : "-"];
        })));
      recOut.appendChild(note("Confidence is sensitivity to wall attenuation errors, not accuracy. " + r.label));
    }
    function runRecs() {
      recMsg.textContent = "Testing actions...";
      var f = floor();
      app.runJob({ type: "recommend", floor: f.id, cell_m: P.analysisCell(f) }, { result: function (m) { st.recs = m; recMsg.textContent = ""; renderRecs(); }, error: function (m) { recMsg.textContent = "Failed: " + m.message; } });
    }
    host.appendChild(box("Recommendations", [note("Ranked by the measured gain in the coverage score. Each action is a what-if on a copy of your plan."),
      el("div", { class: "tool-row" }, [P.button("Find best actions", runRecs, { id: "recRun" })]), recMsg, recOut]));

    // ---- design my network
    var planOut = el("div", { id: "planOut" }), planMsg = el("p", { class: "muted", role: "status" }), narration = el("div", { id: "planNarration", "aria-live": "polite" });
    function narrate(plan) {
      narration.textContent = "";
      function local(why) {
        plan.text.split("\n").forEach(function (line) { narration.appendChild(el("p", { text: line })); });
        narration.appendChild(el("p", { class: "muted hint", text: "Rule-based text (no LLM used)" + (why ? ": " + why : "") + "." }));
      }
      if (demo || !root.fetch) { local("the static demo has no server"); return; }
      function ask(confirm) {
        var body = Opt.planPayload(plan); if (confirm) { body.confirm_off_device = true; }
        root.fetch("/api/planner/explain", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
          .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
          .then(function (r) {
            narration.textContent = "";
            if (r.status === 409) { narration.appendChild(el("p", { text: r.body.detail })); narration.appendChild(P.button("Send the numbers to the cloud provider", function () { ask(true); }, { id: "planConfirm" })); return; }
            if (r.status !== 200) { local("the server refused the request"); return; }
            narration.appendChild(el("p", { class: "muted hint", text: (r.body.source === "llm" ? "Reworded by " + r.body.provider + ", checked against the plan numbers" : "Rule-based text (no LLM used)") + ". " + r.body.note }));
            r.body.explanation.split("\n").forEach(function (line) { narration.appendChild(el("p", { text: line })); });
          })
          .catch(function (e) { narration.textContent = ""; local(e.message); });
      }
      local("asking the server"); ask(false);
    }
    function renderPlan() {
      planOut.textContent = "";
      var p = st.plan;
      if (!p) { return; }
      planOut.appendChild(P.table("Planned access points (" + ESTIMATE + ")", ["AP", "Position", "Band", "Channel", "Standard", "Antenna"],
        p.aps.map(function (a) { return [a.id, a.x + " m, " + a.y + " m", a.band + " GHz", a.channel === undefined ? "default" : String(a.channel), a.standard, a.pattern === "sector" ? "sector at " + a.azimuth_deg + " degrees" : "omni"]; })));
      if (p.mesh_nodes.length) { planOut.appendChild(P.table("Mesh nodes", ["Floor", "Position", "Uplink", "Backhaul"], p.mesh_nodes.map(function (m) { return [m.floor, m.x + " m, " + m.y + " m", m.parent_ap_id, m.backhaul_dbm + " dBm"]; }))); }
      showDiff(planOut.appendChild(el("div")), { before: p.before, after: p.after, delta: Object.assign({}, { score: p.delta.score, coverage_pct: p.delta.coverage_pct, dead_zone_pct: p.after.dead_zone_pct - p.before.dead_zone_pct,
        mean_throughput_mbps: p.after.mean_throughput_mbps - p.before.mean_throughput_mbps, client_capacity: p.after.client_capacity - p.before.client_capacity, optimiser_score: p.after.optimiser_score - p.before.optimiser_score }),
        confidence: "n/a", reason: p.reached ? "The coverage target is reached." : "The coverage target is not reached." }, "Your plan compared with the generated plan (" + ESTIMATE + ")");
      planOut.appendChild(P.button("Apply plan", function () {
        var f = floor(), st2 = app.store, ops = f.aps.map(function (a) { return S.removeOp("ap", st2.project, f.id, a.id); }).concat(p.aps.map(function (a) { return S.addOp("ap", st2.project, f.id, a); }));
        p.mesh_nodes.forEach(function (m) { ops.push(S.addOp("ap", st2.project, m.floor, { id: m.id, x: m.x, y: m.y, tx_dbm: m.tx_dbm, band: m.band, mesh_parent: m.parent_ap_id })); });
        if (!root.confirm("Replace the " + f.aps.length + " access points on " + f.name + " with the " + p.aps.length + " planned ones? You can undo this.")) { return; }
        st2.exec({ label: "Apply network plan", ops: ops }); planMsg.textContent = "Applied the plan. Undo restores the old layout.";
      }, { id: "planApply" }));
      planOut.appendChild(el("h4", { text: "In plain language" })); planOut.appendChild(narration);
    }
    function runDesign() {
      planMsg.textContent = "Designing..."; var f = floor();
      app.runJob({ type: "design", floor: f.id, cell_m: P.analysisCell(f) }, { result: function (m) { st.plan = m; planMsg.textContent = ""; renderPlan(); narrate(m); }, error: function (m) { planMsg.textContent = "Failed: " + m.message; } });
    }
    host.appendChild(box("Design my network", [note(rc.design.label + " It ignores the access points now on this floor."),
      el("div", { class: "tool-row" }, [P.button("Design my network", runDesign, { id: "designRun" })]), planMsg, planOut]));

    app.store.subscribe(function (ev) { if (ev.source !== "select") { refreshWhatIf(); } });
    refreshWhatIf();
    app.twinLab = { state: st, runTimeline: runTimeline };
  }

  var api = { wouldLoop: wouldLoop, meshReport: meshReport, capacityReport: capacityReport, iotReport: iotReport, enterpriseLayout: enterpriseLayout,
              billOfQuantities: billOfQuantities, timelineChartModel: timelineChartModel, timelineEventLines: timelineEventLines, mount: mount };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  root.PlannerModes = api;
})(typeof self !== "undefined" ? self : this);
