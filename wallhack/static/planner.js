"use strict";
// RF planner page wiring: loads the project and rf-config.json, connects the store (undo/redo), the
// canvas editor, the heat-map worker (or the main-thread fallback) and the renderer, and runs the
// panels. MODEL ESTIMATE, not a measurement. Nothing leaves the browser.
(function () {
  var S = window.PlannerState, E = window.PlannerEditor, H = window.PlannerHeat, RF = window.RFEngine;
  var scriptUrl = document.currentScript && document.currentScript.src;
  var BASE = scriptUrl ? scriptUrl.slice(0, scriptUrl.lastIndexOf("/") + 1) : "";   // /static/ live, the site root in the demo
  var CELL_CHOICES = [0.25, 0.5, 1, 2], MAX_AUTO_CELLS = 90000;
  var AUTOSAVE_MS = 600, PROBE_STEP_M = 0.5, PROBE_BIG_STEP_M = 2.5, MAX_IMPORT_BYTES = 12 * 1024 * 1024;
  var DEFAULT_FLOOR = { w: 20, d: 12 };
  var THEME_KEY = "wallhack.theme", CONTRAST_KEY = "wallhack.contrast";
  var BAND_CHOICES = ["2.4", "5", "6"];

  function $(id) { return document.getElementById(id); }
  var app = { store: null, editor: null, renderer: null, config: null, env: null, backend: null, latestId: 0, waiters: [],
              lastResult: null, probe: null, settings: { band: null, mode: "basic", cell: null }, saveTimer: 0, perf: {}, view: null, rssiGrid: null, layerInfo: null };
  window.PlannerApp = app;
  app.base = BASE;

  // ---------------------------------------------------------------- small helpers
  function say(msg) { $("status").textContent = msg; }
  function notice(msg, kind) {
    var el = $("plannerNotice");
    el.textContent = msg || ""; el.hidden = !msg; el.className = "banner" + (kind === "error" ? " error" : kind === "note" ? " note" : "");
    el.setAttribute("role", kind === "error" ? "alert" : "status");
  }
  function option(value, label) { var o = document.createElement("option"); o.value = value; o.textContent = label; return o; }
  function currentFloor() { return S.findFloor(app.store.project, app.store.floorId); }
  function rebuildEnv() { app.env = RF.makeEnv(app.config, app.store.project.materials); }
  function materialTable() {
    var out = {}, cfg = app.config.materials, custom = app.store.project.materials || {};
    Object.keys(cfg).forEach(function (k) { out[k] = { label: cfg[k].label || k, info: lossText(cfg[k]) }; });
    Object.keys(custom).forEach(function (k) { out[k] = { label: custom[k].label || k, info: lossText(custom[k]) }; });
    return out;
  }
  /** Estimated losses of a material, from the derived fields of the engine (MODEL ESTIMATE, typical values). */
  function lossText(material) {
    var f = RF.materialFields(app.config, material, app.settings && app.settings.band || "2.4");
    return "Estimated loss " + f.attenuation24GHz + " / " + f.attenuation5GHz + " / " + f.attenuation6GHz + " dB at 2.4 / 5 / 6 GHz, passes " +
      (100 * f.penetrationRate).toFixed(2) + "% and reflects " + (100 * f.reflectionRate).toFixed(1) + "% of the power at the selected band (MODEL ESTIMATE)";
  }
  function validateOpts() {
    var o = { config: app.config, materialIds: Object.keys(app.config.materials), bands: Object.keys(app.config.bands), modes: RF.modeIds() };
    if (app.config.planner_modes) { o.deviceClasses = Object.keys(app.config.planner_modes.iot_classes); }
    return o;
  }
  app.validateOpts = validateOpts;
  app.assetUrl = function (name) { return (app.base || "") + name; };
  app.say = say; app.notice = notice; app.currentFloor = function () { return currentFloor(); };
  // overlays drawn on the editor canvas after everything else (probe, roaming zones, ghost AP, annotations)
  var overlays = [];
  app.overlay = function (fn) { overlays.push(fn); };
  app.download = function (name, type, data) {
    var blob = new Blob([data], { type: type }), a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); window.setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  };
  // analysis jobs (analytics, compare, rank, plan, stack) run in the worker; ids start high so they never collide with heat map ids
  var JOB_BASE = 1000000;
  app.jobs = {}; app.jobSeq = JOB_BASE;
  app.runJob = function (msg, handlers) { app.jobSeq += 1; msg.id = app.jobSeq; app.jobs[msg.id] = handlers; app.backend.send(msg); return msg.id; };
  app.cancelJob = function (id) { app.backend.send({ type: "cancel", id: id }); };
  function onJobMessage(m) {
    var h = app.jobs[m.id];
    if (!h) { return; }
    if (m.type === "progress") { if (h.progress) { h.progress(m); } return; }
    delete app.jobs[m.id];
    if (m.type === "cancelled") { if (h.cancelled) { h.cancelled(m); } }
    else if (m.type === "error") { if (h.error) { h.error(m); } }
    else { h.result(m); }
  }

  // ---------------------------------------------------------------- compute backend: Worker or main-thread fallback
  function startBackend() {
    function onMessage(m) {
      if (m.type === "ready") { return; }
      if (m.id >= JOB_BASE) { onJobMessage(m); return; }
      if (m.type === "error") {
        if (m.id !== undefined && m.id !== app.latestId) { return; }   // an error for a superseded request must not touch the current one
        notice("Heat map computation failed: " + m.message, "error"); finishCompute(m.id); return;
      }
      if (m.type === "cancelled") { return; }
      if (m.id !== app.latestId) { return; }   // stale
      var g = { rssi: m.grid, cols: m.cols, rows: m.rows, cellM: m.cell_m, floor: m.floor };
      app.rssiGrid = g;
      if (app.view.layer === "rssi") { app.renderer.setGrid(g); }
      app.editor.invalidate();
      if (m.type === "progress") {
        $("computeChip").textContent = m.stage === "coarse" ? "coarse pass, refining" : "refining " + Math.round(100 * m.done / m.total) + "%";
        if (m.stage === "coarse") { app.perf.coarseMs = m.coarse_ms; }
      } else {
        app.lastResult = m;
        $("computeChip").textContent = "done " + Math.round(m.stats.ms) + " ms";
        $("coverageChip").textContent = "coverage: " + m.coverage_pct.toFixed(1) + "% at " + app.config.analytics.coverage_dbm + " dBm";
        $("deadChip").textContent = "dead zone: " + m.dead_zone_pct.toFixed(1) + "%";
        finishCompute(m.id);
        if (app.requestAnalysis) { app.requestAnalysis(); }
      }
      drawMinimap();
    }
    function fallback(reason) {
      if (!window.RFWorkerCore) { notice("Heat map worker unavailable: " + reason, "error"); return; }
      var core = window.RFWorkerCore.createCore({ RF: RF, State: S, Opt: window.RFOptimizer }, function (m) { onMessage(m); });
      app.backend = { kind: "main", send: function (msg) { core.handle(msg); } };
      notice("Web Workers are unavailable here (" + reason + "), so the heat map is computed on the main thread in short time slices. The page stays usable but large floors update more slowly.", "note");
      initBackend();
    }
    var useWorker = typeof window.Worker === "function" && !/[?&]worker=0/.test(location.search) && location.protocol !== "file:";
    if (useWorker) {
      try {
        var w = new window.Worker(BASE + "rf-worker.js");
        w.onmessage = function (e) { onMessage(e.data); };
        w.onerror = function (e) { if (app.backend && app.backend.kind === "worker") { app.backend = null; w.terminate(); fallback(e.message || "worker failed to start"); } };
        app.backend = { kind: "worker", send: function (msg) { w.postMessage(msg); } };
        initBackend();
        return;
      } catch (e) { fallback(e.message); return; }
    }
    fallback(location.protocol === "file:" ? "page opened from a file" : "Worker not supported");
  }
  function initBackend() {
    app.backend.send({ type: "init", config: app.config });
    sendProject();
  }
  function sendProject() {
    app.backend.send({ type: "setProject", project: S.computeProject(app.store.project), mode: app.settings.mode, band: app.settings.band });
  }
  function cellFor(floor) {
    if (app.settings.cell) { return app.settings.cell; }
    for (var i = 0; i < CELL_CHOICES.length; i++) {
      if (Math.ceil(floor.width_m / CELL_CHOICES[i]) * Math.ceil(floor.depth_m / CELL_CHOICES[i]) <= MAX_AUTO_CELLS) { return CELL_CHOICES[i]; }
    }
    return CELL_CHOICES[CELL_CHOICES.length - 1];
  }
  var computeQueued = false;
  function requestCompute() {
    if (computeQueued) { return; }
    computeQueued = true;
    window.requestAnimationFrame(function () {
      computeQueued = false;
      if (!app.backend) { return; }
      app.latestId += 1;
      $("computeChip").textContent = "computing";
      app.backend.send({ type: "compute", id: app.latestId, floor: app.store.floorId, cell_m: cellFor(currentFloor()) });
    });
  }
  function finishCompute(id) {
    if (id !== app.latestId) { return; }
    var w = app.waiters; app.waiters = [];
    w.forEach(function (fn) { fn(app.lastResult); });
  }
  /** Resolves when the newest compute request has produced its final result (used by tests and tools). */
  app.whenIdle = function () {
    return new Promise(function (resolve) { app.waiters.push(resolve); requestCompute(); });
  };

  // ---------------------------------------------------------------- store events
  function onStoreEvent(ev) {
    if (ev.source === "load") { rebuildEnv(); sendProject(); fillFloors(); syncPanels(); dropLayerGrid(); requestCompute(); schedulePersist(); return; }
    if (ev.source === "floor") { fillFloors(); syncPanels(); dropLayerGrid(); requestCompute(); return; }
    if (ev.source === "select") { syncSelection(); return; }
    if (ev.source === "meta") { schedulePersist(); return; }
    if (ev.ops && ev.ops.length && ev.ops.some(function (o) { return o.t.indexOf("floors.") === 0; })) {
      if (app.backend) { app.backend.send({ type: "update", ops: ev.ops.filter(function (o) { return o.t.indexOf("floors.") === 0; }) }); }
      fillFloors(); syncPanels(); requestCompute(); schedulePersist(); updateHistoryButtons(); return;
    }
    if (ev.ops && ev.ops.length) {
      if (app.backend) { app.backend.send({ type: "update", ops: ev.ops }); }
      var kinds = ev.ops.map(function (o) { return o.t; });
      var moveOnly = kinds.every(function (k) { return k === "wall.set" || k === "ap.set" || k === "label.set"; }) &&
        ev.ops.every(function (o) { return !("tx_dbm" in o.after || "band" in o.after || "channel" in o.after || "name" in o.after ||
          "standard" in o.after || "width_mhz" in o.after || "pattern" in o.after || "spatial_streams" in o.after || "mlo_bands" in o.after); });
      if (!moveOnly) { fillApList(); }
      if (kinds.some(function (k) { return k.indexOf("client.") === 0; })) { fillClientList(); }
      if (kinds.some(function (k) { return k === "floor.set"; })) { syncFloorPanel(); }
      if (!kinds.every(function (k) { return k.indexOf("label.") === 0 || k.indexOf("annotation.") === 0 || k.indexOf("device.") === 0; }) && !kinds.every(function (k) { return k === "floor.set" && !("width_m" in ev.ops[0].after || "depth_m" in ev.ops[0].after); })) { requestCompute(); }
      syncSelection();
      schedulePersist();
    }
    updateHistoryButtons();
    if (ev.label && (ev.source === "undo" || ev.source === "redo")) { say((ev.source === "undo" ? "Undid: " : "Redid: ") + ev.label); }
  }
  function updateHistoryButtons() {
    var st = app.store;
    $("undoBtn").disabled = !st.canUndo(); $("redoBtn").disabled = !st.canRedo();
    $("undoBtn").title = st.canUndo() ? "Undo: " + st.undoLabel() + " (Ctrl+Z)" : "Undo (Ctrl+Z)";
    $("redoBtn").title = st.canRedo() ? "Redo: " + st.redoLabel() + " (Ctrl+Shift+Z)" : "Redo (Ctrl+Shift+Z)";
  }

  // ---------------------------------------------------------------- persistence
  function schedulePersist() {
    $("saveState").textContent = "Unsaved changes";
    window.clearTimeout(app.saveTimer);
    app.saveTimer = window.setTimeout(persist, AUTOSAVE_MS);
  }
  function persist() {
    var res;
    try { res = S.saveProject(window.localStorage, app.store.project); } catch (e) { res = { ok: false, error: "Browser storage is unavailable: " + e.message }; }
    if (res.ok) { app.store.markSaved(); $("saveState").textContent = "Saved in this browser (" + Math.round(res.bytes / 1024) + " KB)"; if ($("plannerNotice").className.indexOf("error") >= 0) { notice(""); } }
    else { $("saveState").textContent = "Not saved"; notice(res.error, "error"); }
  }

  // ---------------------------------------------------------------- panels
  function fillFloors() {
    var sel = $("floorSel"), st = app.store;
    sel.textContent = "";
    st.project.floors.forEach(function (f) { sel.appendChild(option(f.id, f.name + " (level " + f.level + ")")); });
    sel.value = st.floorId;
    var order = floorsByLevel(), at = order.indexOf(st.floorId);
    $("floorDown").disabled = at <= 0; $("floorUp").disabled = at < 0 || at >= order.length - 1;
  }
  /** Floor ids from the lowest level to the highest. */
  function floorsByLevel() { return app.store.project.floors.slice().sort(function (a, b) { return a.level - b.level; }).map(function (f) { return f.id; }); }
  function stepFloor(delta) {
    var order = floorsByLevel(), next = order[order.indexOf(app.store.floorId) + delta];
    if (next === undefined) { say(delta > 0 ? "This is the top floor" : "This is the bottom floor"); return; }
    app.store.setFloor(next); app.editor.fit();
    say("Floor " + currentFloor().name + " (level " + currentFloor().level + ")");
  }
  function syncFloorPanel() {
    var f = currentFloor();
    $("floorW").value = f.width_m; $("floorD").value = f.depth_m;
    $("floorInfo").textContent = f.walls.length + " walls, " + f.aps.length + " access points" + (f.scale_m_per_px ? ", image scale " + f.scale_m_per_px.toFixed(4) + " m per pixel" : "");
    $("imageOpacity").value = f.bg_opacity === undefined ? S.DEFAULT_BG_OPACITY : f.bg_opacity;
    $("imageOpacity").disabled = !f.background; $("imageClear").disabled = !f.background;
  }
  function syncPanels() { syncFloorPanel(); fillApList(); fillClientList(); syncSelection(); updateHistoryButtons(); app.editor.buildPalette($("palette")); }

  function fillApList() {
    var list = $("apList"), f = currentFloor(), st = app.store;
    list.textContent = "";
    f.aps.forEach(function (ap) {
      var li = document.createElement("li"), head = document.createElement("div"), name = document.createElement("button"), del = document.createElement("button"), fields = document.createElement("div");
      li.dataset.id = ap.id; if (st.selection.ap === ap.id) { li.className = "sel"; }
      head.className = "ap-head"; name.type = "button"; name.textContent = ap.name || ap.id; name.title = "Select " + ap.id;
      name.addEventListener("click", function () { st.select({ ap: ap.id }); app.editor.invalidate(); });
      del.type = "button"; del.textContent = "Delete"; del.setAttribute("aria-label", "Delete " + (ap.name || ap.id));
      del.addEventListener("click", function () { st.exec({ label: "Delete access point", ops: [S.removeOp("ap", st.project, f.id, ap.id)] }); });
      head.appendChild(name); head.appendChild(del);
      fields.className = "ap-fields";
      function apSet(props, label) { st.exec({ label: label, key: "ap-prop:" + ap.id + ":" + Object.keys(props)[0], ops: [S.setOp("ap", st.project, f.id, ap.id, props)] }); }
      var tx = document.createElement("input");
      tx.type = "number"; tx.min = 0; tx.max = 30; tx.step = 1; tx.value = ap.tx_dbm;
      tx.addEventListener("change", function () { var v = parseFloat(tx.value); if (isFinite(v) && v >= 0 && v <= 30) { apSet({ tx_dbm: v }, "Change TX power"); } else { tx.value = ap.tx_dbm; say("TX power must be 0 to 30 dBm"); } });
      var bandSelect = document.createElement("select");
      bandSelect.appendChild(option("", "auto"));
      BAND_CHOICES.forEach(function (b) { bandSelect.appendChild(option(b, b + " GHz")); });
      bandSelect.value = ap.band || "";
      var chan = document.createElement("select");
      function fillChannels() {
        var b = ap.band || app.settings.band || "2.4";
        chan.textContent = ""; chan.appendChild(option("", "default"));
        app.config.bands[b].channels.forEach(function (c) { chan.appendChild(option(String(c), String(c))); });
        chan.value = ap.channel === undefined ? "" : String(ap.channel);
      }
      fillChannels();
      bandSelect.addEventListener("change", function () {
        apSet({ band: bandSelect.value || undefined, channel: undefined, standard: undefined, width_mhz: undefined,
                spatial_streams: undefined, mlo_bands: undefined }, "Change band");
      });
      chan.addEventListener("change", function () { apSet({ channel: chan.value ? parseInt(chan.value, 10) : undefined }, "Change channel"); });
      var effectiveBand = ap.band || app.settings.band || "2.4", standards = app.config.wifi_standards.standards;
      var std = document.createElement("select");
      std.title = "MODEL ESTIMATE: the WiFi standard sets the PHY rate table and the SINR throughput";
      std.appendChild(option("", "none (legacy)"));
      Object.keys(standards).filter(function (id) { return standards[id].widths_mhz_by_band[effectiveBand]; })
        .forEach(function (id) { std.appendChild(option(id, standards[id].label)); });
      std.value = ap.standard || "";
      std.addEventListener("change", function () {
        apSet({ standard: std.value || undefined, width_mhz: undefined, spatial_streams: undefined, mlo_bands: undefined }, "Change WiFi standard");
      });
      var width = document.createElement("select");
      width.appendChild(option("", "default"));
      (ap.standard ? standards[ap.standard].widths_mhz_by_band[effectiveBand] : app.config.bands[effectiveBand].widths_mhz)
        .forEach(function (w) { width.appendChild(option(String(w), w + " MHz")); });
      width.value = ap.width_mhz === undefined ? "" : String(ap.width_mhz);
      width.addEventListener("change", function () { apSet({ width_mhz: width.value ? parseInt(width.value, 10) : undefined }, "Change channel width"); });
      var pattern = document.createElement("select");
      pattern.title = "MODEL ESTIMATE: horizontal antenna pattern, omni by default";
      Object.keys(app.config.antenna.patterns).forEach(function (id) { pattern.appendChild(option(id, app.config.antenna.patterns[id].label)); });
      pattern.value = ap.pattern || "omni";
      pattern.addEventListener("change", function () { apSet({ pattern: pattern.value === "omni" ? undefined : pattern.value }, "Change antenna pattern"); });
      var azimuth = document.createElement("input"), range = app.config.antenna.azimuth_deg_range;
      azimuth.type = "number"; azimuth.min = range[0]; azimuth.max = range[1]; azimuth.step = 5; azimuth.value = ap.azimuth_deg === undefined ? 0 : ap.azimuth_deg;
      azimuth.disabled = pattern.value === "omni";
      azimuth.title = "Degrees, 0 points east, 90 points south on the plan";
      azimuth.addEventListener("change", function () {
        var v = parseFloat(azimuth.value);
        if (isFinite(v) && v >= range[0] && v <= range[1]) { apSet({ azimuth_deg: v }, "Change antenna azimuth"); } else { azimuth.value = ap.azimuth_deg === undefined ? 0 : ap.azimuth_deg; say("Azimuth must be " + range[0] + " to " + range[1] + " degrees"); }
      });
      var streams = document.createElement("select"), spec = ap.standard ? standards[ap.standard] : null;
      streams.title = "MODEL ESTIMATE: spatial streams set the PHY rate, the standard default applies when empty";
      streams.appendChild(option("", spec ? "default (" + app.config.wifi_standards.default_streams + ")" : "needs a standard"));
      if (spec) { for (var n = 1; n <= spec.max_streams; n++) { streams.appendChild(option(String(n), String(n))); } }
      streams.disabled = !spec;
      streams.value = ap.spatial_streams === undefined ? "" : String(ap.spatial_streams);
      streams.addEventListener("change", function () { apSet({ spatial_streams: streams.value ? parseInt(streams.value, 10) : undefined }, "Change spatial streams"); });
      // Generic class profile (consumer, gaming, mesh, enterprise): sets band, power, standard, streams, antenna and beamforming
      var profiles = app.config.ap_profiles.profiles, profileSel = document.createElement("select");
      profileSel.title = "Typical generic class of equipment, not a product. Sets power within the ETSI EIRP limit, standard, streams, antenna gain and beamforming.";
      profileSel.appendChild(option("", "none"));
      Object.keys(profiles).forEach(function (id) { profileSel.appendChild(option(id, profiles[id].label)); });
      profileSel.value = ap.profile || "";
      profileSel.addEventListener("change", function () {
        if (!profileSel.value) { apSet({ profile: undefined }, "Clear class profile"); return; }
        var pr = profiles[profileSel.value], keepBand = ap.band && pr.bands.indexOf(ap.band) >= 0 ? ap.band : undefined;
        var props = RF.applyApProfile(app.config, ap, profileSel.value, keepBand);
        ["id", "x", "y", "name"].forEach(function (k) { delete props[k]; });
        ["channel", "width_mhz", "mlo_bands", "azimuth_deg", "beamwidth_deg", "front_to_back_db"].forEach(function (k) { props[k] = undefined; });
        apSet(props, "Apply class profile");
      });
      var bf = document.createElement("input");
      bf.type = "checkbox"; bf.checked = !!ap.beamforming; bf.disabled = !ap.standard;
      bf.setAttribute("aria-label", "Beamforming for " + (ap.name || ap.id) + " (CAPACITY MODEL, needs a standard)");
      bf.addEventListener("change", function () { apSet({ beamforming: bf.checked ? true : undefined }, "Change beamforming"); });
      [["TX dBm", tx], ["Class", profileSel], ["Beamforming", bf], ["Band", bandSelect], ["Channel", chan], ["Standard", std], ["Width", width], ["Streams", streams], ["Antenna", pattern], ["Azimuth", azimuth]].forEach(function (p) {
        var l = document.createElement("label"); l.appendChild(document.createTextNode(p[0])); l.appendChild(p[1]); fields.appendChild(l);
      });
      // Multi-Link Operation: extra bands the AP aggregates, only for the standards that have it
      var mlo = app.config.wifi_standards.mlo;
      if (ap.standard && mlo.standards.indexOf(ap.standard) >= 0) {
        var box = document.createElement("fieldset"), legend = document.createElement("legend"), chosen = ap.mlo_bands || [];
        box.className = "mlo-box"; legend.textContent = "MLO links (aggregate more bands, CAPACITY MODEL)"; box.appendChild(legend);
        Object.keys(standards[ap.standard].widths_mhz_by_band).filter(function (b) { return b !== effectiveBand; }).forEach(function (b) {
          var cb = document.createElement("input"), lab = document.createElement("label");
          cb.type = "checkbox"; cb.checked = chosen.indexOf(b) >= 0; cb.setAttribute("aria-label", "MLO link on the " + b + " GHz band for " + (ap.name || ap.id));
          cb.addEventListener("change", function () {
            var next = Object.keys(standards[ap.standard].widths_mhz_by_band).filter(function (x) { return x !== effectiveBand && (x === b ? cb.checked : (ap.mlo_bands || []).indexOf(x) >= 0); });
            if (next.length > mlo.max_links - 1) { cb.checked = false; say("MLO allows at most " + mlo.max_links + " links including the main band"); return; }
            apSet({ mlo_bands: next.length ? next : undefined }, "Change MLO links");
          });
          lab.className = "check"; lab.appendChild(cb); lab.appendChild(document.createTextNode(" " + b + " GHz")); box.appendChild(lab);
        });
        fields.appendChild(box);
      }
      var result = document.createElement("p");
      result.className = "ap-result muted hint"; result.dataset.apResult = ap.id; result.textContent = apResultText(ap.id);
      li.appendChild(head); li.appendChild(fields); li.appendChild(result); list.appendChild(li);
    });
    if (!f.aps.length) { var li0 = document.createElement("li"); li0.textContent = "No access points on this floor. Use the AP tool."; list.appendChild(li0); }
  }

  /** Smart Home client list of the floor with the latest CAPACITY MODEL results. */
  function fillClientList() {
    var list = $("clientList"), f = currentFloor(), st = app.store, devices = app.config.client_devices.devices;
    var an = app.panels && app.panels.state.analysis, section = an && an.analytics.clients;
    list.textContent = "";
    (f.clients || []).forEach(function (c) {
      var li = document.createElement("li"), name = document.createElement("span"), del = document.createElement("button"), res = document.createElement("p");
      var e = section && section.clients.filter(function (x) { return x.id === c.id; })[0];
      name.textContent = c.id + ": " + devices[c.device].label + " (" + devices[c.device].demand_mbps + " Mbps)";
      del.type = "button"; del.textContent = "Delete"; del.setAttribute("aria-label", "Delete client " + c.id);
      del.addEventListener("click", function () { st.exec({ label: "Delete client", ops: [S.removeOp("client", st.project, f.id, c.id)] }); });
      res.className = "muted hint";
      res.textContent = !e ? "No result yet." : e.status !== "ok" ? "CAPACITY MODEL: not served (" + e.status.replace("_", " ") + ")." :
        "CAPACITY MODEL: " + e.ap + ", link " + e.link_mbps.toFixed(1) + " Mbps, gets " + e.delivered_mbps.toFixed(1) + " Mbps" + (e.satisfied ? "." : ", the access point is saturated.");
      li.appendChild(name); li.appendChild(del); li.appendChild(res); list.appendChild(li);
    });
    if (!(f.clients || []).length) { var li0 = document.createElement("li"); li0.textContent = "No clients on this floor."; list.appendChild(li0); }
  }

  /** SINR, reliability and MLO figures of one AP from the latest analysis (ESTIMATES), or a hint to set a standard. */
  function apResultText(apId) {
    var an = app.panels && app.panels.state.analysis;
    if (!an || !an.analytics.sinr) { return "No SINR results yet. Choose a WiFi standard to get SINR, throughput and reliability estimates."; }
    var e = an.analytics.sinr.aps.filter(function (x) { return x.id === apId; })[0];
    if (!e) { return "No SINR results for this access point on this floor."; }
    var f1 = function (v) { return v === null ? "-" : v.toFixed(1); };
    var text = "ESTIMATE: " + e.standard + ", " + e.width_mhz + " MHz, " + e.streams + " streams. Mean SINR " + f1(e.mean_sinr_db) + " dB, mean throughput " + f1(e.mean_throughput_mbps) +
      " Mbps, packet loss " + f1(e.reliability.mean_loss_pct) + "%, latency " + f1(e.reliability.mean_latency_ms) + " ms.";
    if (e.interferers.length || e.external_sources.length) { text += " Interfered by " + e.interferers.concat(e.external_sources).join(", ") + "."; }
    if (e.mlo) { text += " MLO over " + e.mlo.links.join(" + ") + " GHz: mean capacity " + f1(e.mlo.mean_capacity_mbps) + " Mbps."; }
    return text;
  }
  /** Refresh only the result lines of the access point list (after an analysis), without rebuilding the controls. */
  app.refreshApResults = function () {
    Array.prototype.forEach.call(document.querySelectorAll("[data-ap-result]"), function (p) { p.textContent = apResultText(p.dataset.apResult); });
    fillClientList();
  };

  function syncSelection() {
    var st = app.store, f = currentFloor(), n = st.selection.walls.length;
    $("inspector").hidden = !n;
    Array.prototype.forEach.call($("apList").children, function (li) { li.className = li.dataset.id === st.selection.ap ? "sel" : ""; });
    if (n) {
      var walls = f.walls.filter(function (w) { return st.selection.walls.indexOf(w.id) >= 0; }), mats = {};
      walls.forEach(function (w) { mats[w.material || ""] = true; });
      $("wallMaterial").value = Object.keys(mats).length === 1 ? Object.keys(mats)[0] : "";
      var shown = Object.keys(mats).length === 1 ? materialTable()[walls[0].material || (walls[0].kind === "exterior" ? app.config.kind_defaults.exterior : app.config.kind_defaults.interior)] : null;
      $("wallInfo").textContent = (n === 1 ? S.wallLength(walls[0]).toFixed(2) + " m long, " + Math.round(E.angleDeg(walls[0])) + " degrees" : n + " walls selected") + (shown ? ". " + shown.info : "");
    }
    app.editor.invalidate();
  }

  function fillMaterialSelect() {
    var sel = $("wallMaterial"), table = materialTable();
    sel.textContent = ""; sel.appendChild(option("", "mixed"));
    Object.keys(table).forEach(function (id) { sel.appendChild(option(id, table[id].label)); });
  }

  // ---------------------------------------------------------------- probe and tooltip
  function probeAtPoint(x, y, anchor) {
    var f = currentFloor(), tip = $("tip");
    if (x < 0 || y < 0 || x > f.width_m || y > f.depth_m) { tip.hidden = true; return; }
    var p = RF.probeAt(app.store.project, f.id, x, y, { env: app.env, band: app.settings.band, mode: app.settings.mode });
    app.probe = { x: x, y: y, result: p };
    var rows = H.describeProbe(p, app.config);
    tip.textContent = "";
    rows.forEach(function (r) {
      var d = document.createElement("div");
      if (r[0]) { var k = document.createElement("span"), v = document.createElement("span"); k.className = "k"; k.textContent = r[0]; v.textContent = r[1]; d.appendChild(k); d.appendChild(v); }
      else { d.className = "est"; d.textContent = r[1]; }
      tip.appendChild(d);
    });
    tip.hidden = false;
    var stage = $("stage"), tx = Math.min(stage.clientWidth - 270, anchor.x + 14), ty = Math.min(stage.clientHeight - tip.offsetHeight - 6, anchor.y + 14);
    tip.style.left = Math.max(4, tx) + "px"; tip.style.top = Math.max(4, ty) + "px";
    var dl = $("probe");
    dl.textContent = "";
    rows.forEach(function (r) {
      if (!r[0]) { return; }
      var dt = document.createElement("dt"), dd = document.createElement("dd");
      dt.textContent = r[0]; dd.textContent = r[1]; dl.appendChild(dt); dl.appendChild(dd);
    });
    app.editor.invalidate();
  }
  var pendingPointer = null;
  function onPointer(raw, e) {
    if (e.buttons) { return; }
    var r = $("cEdit").getBoundingClientRect();
    pendingPointer = { x: raw.x, y: raw.y, ax: e.clientX - r.left, ay: e.clientY - r.top };
    if (!app.pointerQueued) {
      app.pointerQueued = true;
      window.requestAnimationFrame(function () {
        app.pointerQueued = false;
        if (pendingPointer) { probeAtPoint(pendingPointer.x, pendingPointer.y, { x: pendingPointer.ax, y: pendingPointer.ay }); }
      });
    }
  }
  function moveProbeByKey(dx, dy, big) {
    var f = currentFloor(), cur = app.probe || { x: f.width_m / 2, y: f.depth_m / 2 }, step = big ? PROBE_BIG_STEP_M : PROBE_STEP_M;
    var x = Math.min(f.width_m, Math.max(0, cur.x + dx * step)), y = Math.min(f.depth_m, Math.max(0, cur.y + dy * step)), v = app.editor.view;
    probeAtPoint(x, y, { x: v.ox + x * v.scale, y: v.oy + y * v.scale });
    var p = app.probe.result;
    say(p.rssi_dbm.toFixed(1) + " dBm, " + p.quality + ", " + (p.ap_id ? "best AP " + p.ap_id + " at " + p.distance_m + " metres, " + p.walls_crossed + " walls" : "no access point"));
  }
  function drawProbe(c, view) {
    if (!app.probe) { return; }
    var x = view.ox + app.probe.x * view.scale, y = view.oy + app.probe.y * view.scale;
    c.strokeStyle = "#fff"; c.lineWidth = 2; c.beginPath(); c.arc(x, y, 6, 0, Math.PI * 2); c.moveTo(x - 11, y); c.lineTo(x - 3, y); c.moveTo(x + 3, y); c.lineTo(x + 11, y); c.moveTo(x, y - 11); c.lineTo(x, y - 3); c.moveTo(x, y + 3); c.lineTo(x, y + 11); c.stroke();
  }

  // ---------------------------------------------------------------- mini-map
  var minimap = null;
  function drawMinimap() { if (minimap) { minimap.draw(); } }

  // ---------------------------------------------------------------- map layers and view settings
  var VIEW_PARAMS = ["layer", "palette", "compare", "combine", "overlays"];
  function paletteIds() { return Object.keys(H.PALETTES); }
  function storage() { try { return window.localStorage; } catch (e) { return { getItem: function () { return null; }, setItem: function () { throw e; } }; } }
  /** Keep the view in browser storage and in the page URL (other query parameters such as renderer=canvas2d stay). */
  function persistView() {
    S.saveView(storage(), app.view);
    try {
      var keep = location.search.replace(/^\?/, "").split("&").filter(function (p) { return p && VIEW_PARAMS.indexOf(p.split("=")[0]) < 0; });
      window.history.replaceState(null, "", "?" + keep.concat([S.viewToSearch(app.view)]).join("&") + location.hash);
    } catch (e) { /* history API unavailable (sandboxed frame): the view is still in storage */ }
  }
  function applyHeatOptions() {
    app.paletteId = app.view.palette;
    app.renderer.setOptions({ palette: app.view.palette, opacity: $("tgHeat").checked ? parseFloat($("heatOpacity").value) : 0, banded: $("tgBands").checked,
                              contours: $("tgContours").checked, deadZones: $("tgDead").checked });
    app.editor.invalidate(); drawMinimap();
  }
  /** Layers the analysis job must return: the active one, the compare one, the members of a combination and the two the dashboard needs. */
  app.neededLayers = function () {
    var v = app.view, ids = ["rssi", "bandwidth", v.compare];
    if (v.layer === H.COMBINED_ID) { ids = ids.concat(v.combine); } else { ids.push(v.layer); }
    return ids.filter(function (id, i) { return ids.indexOf(id) === i; });
  };
  function layerAnalysis() {
    var an = app.panels && app.panels.state.analysis, v = app.view;
    if (!an || an.floor !== app.store.floorId || !an.layers) { return null; }
    var need = v.layer === H.COMBINED_ID ? v.combine : [v.layer];
    return need.every(function (id) { return an.layers[id]; }) ? an : null;
  }
  function dropLayerGrid() { if (app.view.layer !== "rssi") { app.layerInfo = null; app.renderer.clearGrid(); } }
  /** Draw the selected map layer: the live RSSI grid, or a layer from the latest analysis (requested if it is missing). */
  app.applyLayer = function () {
    var v = app.view, spec = H.layerSpec(app.config, v.layer), list = $("legend");
    $("layerSel").value = v.layer; $("paletteSel").value = v.palette;
    $("legendTitle").textContent = v.layer === "rssi" ? "Signal quality (RSSI)" : spec.label;
    applyHeatOptions();
    if (v.layer === "rssi") {
      app.layerInfo = null; H.fillLegend(list, app.config, v.palette); $("layerNote").textContent = "";
      if (app.rssiGrid) { app.renderer.setGrid(app.rssiGrid); }
      app.editor.invalidate(); drawMinimap();
      return;
    }
    var an = layerAnalysis();
    if (!an) {
      H.fillLayerLegend(list, app.config, v.layer, v.palette, null); $("layerNote").textContent = "Computing layer...";
      if (app.requestAnalysis) { app.requestAnalysis(true); }
      return;
    }
    var info = H.layerGrid(v.layer, { config: app.config, analytics: an.analytics, values: an.layers }, v.combine);
    app.layerInfo = info;
    if (info.reason && !info.stats) { app.renderer.clearGrid(); } else { app.renderer.setGrid(info); }
    H.fillLayerLegend(list, app.config, v.layer, v.palette, info);
    $("layerNote").textContent = (info.reason ? info.reason + " " : "") + "MODEL ESTIMATE, not a measurement.";
    app.editor.invalidate(); drawMinimap();
  };
  var viewListeners = [];
  app.onView = function (fn) { viewListeners.push(fn); };
  /** Change the view (layer, palette, compare, combine, overlays). Invalid values are ignored. */
  app.setView = function (patch) {
    app.view = S.normalizeView(Object.assign({}, app.view, patch), app.config, paletteIds());
    persistView(); app.applyLayer();
    viewListeners.forEach(function (fn) { fn(app.view); });
  };
  function fillLayerControls() {
    var sel = $("layerSel"), pal = $("paletteSel");
    H.layerIds(app.config).forEach(function (id) { sel.appendChild(option(id, app.config.planner_layers.layers[id].label)); });
    sel.appendChild(option(H.COMBINED_ID, H.layerSpec(app.config, H.COMBINED_ID).label));
    paletteIds().forEach(function (id) { pal.appendChild(option(id, H.PALETTE_LABELS[id] || id)); });
    var voidKinds = $("voidKind"), sourceKinds = $("sourceKind");
    app.config.voids.kinds.forEach(function (k) { voidKinds.appendChild(option(k, k.charAt(0).toUpperCase() + k.slice(1))); });
    Object.keys(app.config.external_sources.kinds).forEach(function (k) { sourceKinds.appendChild(option(k, app.config.external_sources.kinds[k].label)); });
    voidKinds.addEventListener("change", function () { app.editor.setVoidKind(voidKinds.value); });
    sourceKinds.addEventListener("change", function () { app.editor.setSourceKind(sourceKinds.value); });
    sel.addEventListener("change", function () { app.setView({ layer: sel.value }); });
    pal.addEventListener("change", function () { app.setView({ palette: pal.value }); });
  }

  // ---------------------------------------------------------------- controls
  function wireControls() {
    var st = app.store, ed = app.editor;
    Array.prototype.forEach.call(document.querySelectorAll("[data-tool]"), function (b) { b.addEventListener("click", function () { ed.setTool(b.dataset.tool); }); });
    $("undoBtn").addEventListener("click", function () { st.undo(); });
    $("redoBtn").addEventListener("click", function () { st.redo(); });
    $("fitBtn").addEventListener("click", function () { ed.fit(); });
    $("gridBtn").addEventListener("click", function () { ed.toggleGrid(); });
    $("gridStep").addEventListener("change", function () { ed.setStep(parseFloat($("gridStep").value)); });
    $("floorSel").addEventListener("change", function () { st.setFloor($("floorSel").value); ed.fit(); });
    Object.keys(app.config.client_devices.devices).forEach(function (id) { $("clientKind").appendChild(option(id, app.config.client_devices.devices[id].label)); });
    $("clientAdd").addEventListener("click", function () {
      var st = app.store, f = currentFloor(), n = (f.clients || []).length;
      var item = { id: S.nextId(f.clients || [], "client"), device: $("clientKind").value, x: Math.min(f.width_m, f.width_m / 2 + n % 5), y: Math.min(f.depth_m, f.depth_m / 2 + Math.floor(n / 5)) };
      st.exec({ label: "Add client", ops: [S.addOp("client", st.project, f.id, item)] });
      say("Added " + item.id + " at the middle of the floor");
    });
    $("bandSel").addEventListener("change", function () { app.settings.band = $("bandSel").value || null; app.backend.send({ type: "update", ops: [{ t: "band", band: app.settings.band }] }); fillApList(); requestCompute(); });
    $("modeSel").addEventListener("change", function () { app.settings.mode = $("modeSel").value; app.backend.send({ type: "update", ops: [{ t: "mode", mode: app.settings.mode }] }); requestCompute(); });
    $("cellSel").addEventListener("change", function () { app.settings.cell = parseFloat($("cellSel").value) || null; requestCompute(); });
    ["heatOpacity", "tgHeat", "tgBands", "tgContours", "tgDead"].forEach(function (id) { $(id).addEventListener("input", applyHeatOptions); $(id).addEventListener("change", applyHeatOptions); });
    $("floorUp").addEventListener("click", function () { stepFloor(1); });
    $("floorDown").addEventListener("click", function () { stepFloor(-1); });
    document.addEventListener("keydown", function (e) {
      var t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) { return; }
      if (e.key === "PageUp") { stepFloor(1); e.preventDefault(); } else if (e.key === "PageDown") { stepFloor(-1); e.preventDefault(); }
    });
    [["tgWalls", "walls"], ["tgLabels", "labels"], ["tgImage", "image"]].forEach(function (p) { $(p[0]).addEventListener("change", function () { ed.setLayer(p[1], $(p[0]).checked); }); });
    $("imageOpacity").addEventListener("input", function () { ed.setBgOpacity(parseFloat($("imageOpacity").value)); });
    $("imageBtn").addEventListener("click", function () { $("imageFile").click(); });
    $("imageFile").addEventListener("change", function () {
      var file = $("imageFile").files[0]; $("imageFile").value = "";
      ed.importImage(file).then(function (msg) { say(msg); notice(""); ed.setTool("calibrate"); }).catch(function (e) { notice(e.message, "error"); });
    });
    $("imageClear").addEventListener("click", function () { ed.removeImage(); });
    $("exportBtn").addEventListener("click", function () {
      var blob = new Blob([S.exportProjectJson(st.project)], { type: "application/json" }), a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = (st.project.name || "project").replace(/[^\w.-]+/g, "_") + ".wallhack-plan.json";
      document.body.appendChild(a); a.click(); a.remove(); window.setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    });
    $("importBtn").addEventListener("click", function () { $("importFile").click(); });
    $("importFile").addEventListener("change", function () {
      var file = $("importFile").files[0]; $("importFile").value = "";
      if (!file) { return; }
      if (file.size > MAX_IMPORT_BYTES) { notice("Import refused: the file is larger than " + Math.round(MAX_IMPORT_BYTES / 1048576) + " MB.", "error"); return; }
      var reader = new FileReader();
      reader.onerror = function () { notice("Could not read the file.", "error"); };
      reader.onload = function () {
        try { st.load(S.parseProjectJson(reader.result, validateOpts())); notice(""); say("Imported " + file.name); ed.fit(); }
        catch (e) { notice("Import failed: " + e.message, "error"); }
      };
      reader.readAsText(file);
    });
    $("resetBtn").addEventListener("click", function () {
      loadTwin().then(function (p) { st.load(p); ed.fit(); notice(""); say("Loaded the Wallhack digital twin"); }).catch(function (e) { notice("Could not load the twin: " + e.message, "error"); });
    });
    function floorSize() {
      var f = currentFloor(), w = parseFloat($("floorW").value), d = parseFloat($("floorD").value);
      var needW = Math.max.apply(null, [0].concat(f.walls.map(function (x) { return Math.max(x.x1, x.x2); }), f.aps.map(function (a) { return a.x; }), f.labels.map(function (l) { return l.x; })));
      var needD = Math.max.apply(null, [0].concat(f.walls.map(function (x) { return Math.max(x.y1, x.y2); }), f.aps.map(function (a) { return a.y; }), f.labels.map(function (l) { return l.y; })));
      if (!(w >= 1 && w <= 200 && d >= 1 && d <= 200)) { say("Floor size must be 1 to 200 metres"); syncFloorPanel(); return; }
      if (w < needW || d < needD) { say("Floor cannot be smaller than the walls and access points on it (" + needW.toFixed(1) + " x " + needD.toFixed(1) + " m needed)"); syncFloorPanel(); return; }
      st.exec({ label: "Resize floor", ops: [S.setOp("floor", st.project, f.id, null, { width_m: w, depth_m: d })] });
      ed.fit();
    }
    $("floorW").addEventListener("change", floorSize); $("floorD").addEventListener("change", floorSize);
    $("wallMaterial").addEventListener("change", function () { if ($("wallMaterial").value) { ed.setSelectionMaterial($("wallMaterial").value); } });
    // help dialog and theme
    function help(show) {
      var open = show === undefined ? $("help").hidden : show;
      $("help").hidden = !open; $("helpBtn").setAttribute("aria-expanded", String(open));
      if (open) { $("helpClose").focus(); } else { $("cEdit").focus(); }
    }
    $("helpBtn").addEventListener("click", function () { help(); });
    $("helpClose").addEventListener("click", function () { help(false); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !$("help").hidden) { help(false); } });
    app.help = help;
    $("cEdit").addEventListener("pointerleave", function () { $("tip").hidden = true; });
    $("cEdit").addEventListener("pointerdown", function () { $("tip").hidden = true; });
    window.addEventListener("beforeunload", function (e) { if (st.isDirty() && app.saveFailed) { e.preventDefault(); } });
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    $("themeBtn").textContent = theme === "light" ? "Dark" : "Light"; $("themeBtn").setAttribute("aria-pressed", String(theme === "light"));
    if (app.editor) { app.editor.invalidate(); }
  }
  function applyContrast(on) {
    if (on) { document.documentElement.setAttribute("data-contrast", "more"); } else { document.documentElement.removeAttribute("data-contrast"); }
    $("contrastBtn").textContent = on ? "Contrast: on" : "Contrast: off"; $("contrastBtn").setAttribute("aria-pressed", String(on));
    if (app.editor) { app.editor.invalidate(); }
  }
  function wireContrast() {
    var saved = null, prefers = !!(window.matchMedia && window.matchMedia("(prefers-contrast: more)").matches);
    try { saved = window.localStorage.getItem(CONTRAST_KEY); } catch (e) { /* storage unavailable */ }
    applyContrast(saved === null ? prefers : saved === "more");
    $("contrastBtn").addEventListener("click", function () {
      var next = document.documentElement.getAttribute("data-contrast") !== "more";
      try { window.localStorage.setItem(CONTRAST_KEY, next ? "more" : "off"); } catch (e) { /* storage unavailable */ }
      applyContrast(next);
    });
  }
  function wireTheme() {
    var saved = null;
    try { saved = window.localStorage.getItem(THEME_KEY); } catch (e) { /* storage unavailable */ }
    applyTheme(saved === "light" ? "light" : "dark");
    $("themeBtn").addEventListener("click", function () {
      var next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
      try { window.localStorage.setItem(THEME_KEY, next); } catch (e) { /* storage unavailable */ }
      applyTheme(next);
    });
  }

  // ---------------------------------------------------------------- project loading
  function blankProject() {
    return S.validateProject({ name: "New plan", floors: [{ id: "f1", name: "Floor 1", level: 0, width_m: DEFAULT_FLOOR.w, depth_m: DEFAULT_FLOOR.d,
      aps: [{ id: "ap1", x: DEFAULT_FLOOR.w / 2, y: DEFAULT_FLOOR.d / 2, tx_dbm: 20 }] }] });
  }
  function loadTwin() {
    return window.WallhackCommon.getJson("/api/twin").then(function (t) { return S.validateProject(t, validateOpts()); });
  }
  function initialProject() {
    var saved = S.loadSavedProject(window.localStorage, validateOpts());
    if (saved.project) { return Promise.resolve(saved.project); }
    if (saved.error) { notice(saved.error, "note"); }
    return loadTwin().catch(function (e) { notice("Could not load the Wallhack twin (" + e.message + "). Started with an empty plan.", "note"); return blankProject(); });
  }

  /** Replace the project (tests and tools). */
  app.loadProject = function (project) { app.store.load(S.validateProject(project, validateOpts())); app.editor.fit(); };
  /** Time `n` full frames (base, heat, contours, editor) and return milliseconds per frame. */
  app.benchmarkRender = function (n) {
    var t0 = performance.now();
    for (var i = 0; i < n; i++) { app.editor.drawNow(); }
    if (app.renderer.kind === "webgl") { var gl = app.renderer.canvas.getContext("webgl"); if (gl) { gl.finish(); } }
    return (performance.now() - t0) / n;
  };

  function start(config, project) {
    app.config = config;
    app.view = S.loadView(storage(), location.search, config, paletteIds());
    var heatCanvas = $("cHeat");
    var store = S.createStore(project);
    app.store = store; rebuildEnv();
    RF.modeIds().forEach(function (m) { $("modeSel").appendChild(option(m, m.charAt(0).toUpperCase() + m.slice(1))); });
    app.renderer = H.createRenderer({ heat: heatCanvas, over: $("cOver"), config: config, forceCanvas2d: /[?&]renderer=canvas2d/.test(location.search),
      onKind: function (r) { $("rendererChip").textContent = "renderer: " + (r.kind === "webgl" ? "WebGL" : "canvas 2D"); $("rendererChip").title = r.info; app.rendererInfo = r.info; } });
    app.editor = E.create({ base: $("cBase"), edit: $("cEdit"), store: store, materials: materialTable(), config: config,
      onFrame: function (view) { app.renderer.draw(view); drawMinimap(); }, onDraw: function (c, view, f) { drawProbe(c, view); overlays.forEach(function (fn) { fn(c, view, f); }); }, announce: say, textLimit: function () { return S.textLimit(validateOpts()); }, onPointer: onPointer, onHelp: function () { app.help(); },
      onArrowWithoutSelection: moveProbeByKey,
      onToolPointer: function (tool, phase, raw, e) { return (tool.indexOf("note-") === 0 && app.noteTool) ? app.noteTool(tool, phase, raw, e) : (tool === "device" && app.deviceTool) ? app.deviceTool(phase, raw, e) : (tool === "path" && app.pathTool) ? app.pathTool(phase, raw, e) : false; },
      onTool: function (t) { Array.prototype.forEach.call(document.querySelectorAll("[data-tool]"), function (b) { b.setAttribute("aria-pressed", String(b.dataset.tool === t)); }); },
      onGrid: function (on) { $("gridBtn").setAttribute("aria-pressed", String(on)); } });
    minimap = H.createMinimap({ canvas: $("minimap"), getFloor: currentFloor, getView: function () { return app.editor.view; }, getThumb: function () { return app.renderer.thumb; },
      onNavigate: function (x, y) { app.editor.centerOn(x, y); } });
    fillMaterialSelect(); fillLayerControls();
    wireControls(); fillFloors(); syncPanels();
    store.subscribe(onStoreEvent);
    startBackend();
    if (window.PlannerPanels) { window.PlannerPanels.mount(app); }
    if (window.PlannerExport) { window.PlannerExport.mount(app); }
    if (window.PlannerModes) { window.PlannerModes.mount(app); }
    if (window.Planner3D) { window.Planner3D.mount(app); }
    if (window.PlannerLearn) { window.PlannerLearn.mount(app); }
    app.applyLayer();
    requestCompute();
    $("saveState").textContent = "Not saved yet";
    app.ready = true;
  }

  function fail(msg) { notice("The planner could not start: " + msg, "error"); }
  document.addEventListener("DOMContentLoaded", function () {
    wireTheme(); wireContrast();
    window.fetch(BASE + "rf-config.json").then(function (r) { if (!r.ok) { throw new Error("rf-config.json returned " + r.status); } return r.json(); })
      .then(function (config) { app.config = config; return initialProject().then(function (p) { start(config, p); }); })
      .catch(function (e) { fail(e.message + (location.protocol === "file:" ? ". Serve the page over http (python -m wallhack) instead of opening the file." : "")); });
  });
})();
