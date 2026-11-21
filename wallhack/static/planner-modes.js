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

    function renderAll() { renderMesh(); renderCapacity(); renderIot(); renderEnterprise(); }
    app.onAnalysis = renderAll;
    app.store.subscribe(function (ev) { if (ev.source !== "select") { renderAll(); } });
    renderAll();
    app.modes = { renderAll: renderAll, last: last };
  }

  var api = { wouldLoop: wouldLoop, meshReport: meshReport, capacityReport: capacityReport, iotReport: iotReport, enterpriseLayout: enterpriseLayout,
              billOfQuantities: billOfQuantities, mount: mount };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  root.PlannerModes = api;
})(typeof self !== "undefined" ? self : this);
