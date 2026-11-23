"use strict";
// Planner panels: tab framework, analytics dashboard, scenario comparison and the Smart WiFi Planner panel.
// Pure helpers (formatting, recommendation to operation conversion, colour scales) run under node in
// tests; mount(app) needs the DOM. Everything shown here is a MODEL ESTIMATE, not a measurement.
// All text from data goes through textContent, never innerHTML.
(function (root) {
  var DELTA_RANGE_DB = 15;            // delta heat map saturates at +- this many dB
  var ANALYSIS_DEBOUNCE_MS = 300;
  var CELL_LIMITS = [[0.5, 20000], [1, 40000], [2, 90000]];   // finest cell size whose cell count stays below the limit
  var FLASH_MS = 2500, WIPE_START_PCT = 50;
  var ESTIMATE = "ESTIMATE";
  var PLAN_NOTE = "Model-based suggestion from a propagation model. Confidence shows how stable a result is when the model is perturbed (AP moved 1 m, wall loss changed), not how accurate it is in a real building. Verify with a site survey.";

  // ------------------------------------------------------------------ pure helpers
  function f1(v) { return typeof v === "number" && isFinite(v) ? (Math.round(v * 10) / 10).toFixed(1) : "-"; }
  function f2(v) { return typeof v === "number" && isFinite(v) ? (Math.round(v * 100) / 100).toFixed(2) : "-"; }
  function pct(v) { return f1(v) + "%"; }
  function signed(v, digits) { var s = (digits === 2 ? f2(v) : f1(v)); return (v > 0 ? "+" : "") + s; }

  /** Analysis grid cell size for a floor: fine for small floors, coarser for big ones. */
  function analysisCell(floor) {
    for (var i = 0; i < CELL_LIMITS.length; i++) {
      var c = CELL_LIMITS[i][0];
      if (Math.ceil(floor.width_m / c) * Math.ceil(floor.depth_m / c) <= CELL_LIMITS[i][1]) { return c; }
    }
    return 4;
  }

  /** Diverging colour for a dB difference (after minus before): blue loses signal, orange gains, grey is no change. */
  function deltaColor(db) {
    var t = Math.max(-1, Math.min(1, db / DELTA_RANGE_DB)), a = Math.abs(t);
    if (a < 0.02) { return [128, 128, 128, 0]; }
    var base = t < 0 ? [59, 130, 246] : [249, 115, 22];
    return [Math.round(235 + (base[0] - 235) * a), Math.round(235 + (base[1] - 235) * a), Math.round(235 + (base[2] - 235) * a), Math.round(70 + 170 * a)];
  }

  function floorOfAp(project, apId) {
    for (var i = 0; i < project.floors.length; i++) {
      for (var j = 0; j < project.floors[i].aps.length; j++) { if (project.floors[i].aps[j].id === apId) { return project.floors[i]; } }
    }
    return null;
  }

  /**
   * Flat list of actionable recommendations from a "plan" worker result. Each item:
   * {id, kind, text, reason, confidence (0..1 or null), ghost {x, y} or null, action {type, ...}}.
   */
  function buildRecommendations(plan) {
    var out = [], n = 0;
    function add(kind, text, reason, confidence, ghost, action) { out.push({ id: "r" + (++n), kind: kind, text: text, reason: reason, confidence: confidence, ghost: ghost, action: action }); }
    ((plan.placements && plan.placements.recommendations) || []).forEach(function (r) {
      add("add_ap", r.text, r.reason, r.confidence, { x: r.x, y: r.y }, { type: "add_ap", x: r.x, y: r.y, tx_dbm: r.tx_dbm, band: r.band });
    });
    var power = plan.power || { overpowered: [], underpowered: [] };
    power.overpowered.concat(power.underpowered).forEach(function (r) {
      add(r.kind, r.text, r.reason, r.confidence, null, { type: "set_tx", ap_id: r.ap_id, tx_dbm: r.to_tx_dbm });
    });
    var ch = plan.channels;
    if (ch) {
      ch.assignments.filter(function (a) { return a.changed; }).forEach(function (a) {
        add("channel", a.ap_id + ": move from channel " + a.from_channel + " to " + a.to_channel + " (" + a.band + " GHz). Co-channel conflicts " + ch.conflicts_before + " to " + ch.conflicts_after + " (estimate).",
            "Greedy channel colouring from the modelled signal between APs. No confidence is computed for channel changes.", null, null,
            { type: "set_channel", ap_id: a.ap_id, channel: a.to_channel });
      });
    }
    return out;
  }

  /**
   * Store operations for one recommendation. `added` lists AP items already created for earlier
   * recommendations in the same batch, so "apply all" gets distinct ids.
   */
  function recommendationOps(S, project, floorId, rec, added) {
    var a = rec.action, floor = S.findFloor(project, floorId);
    if (a.type === "add_ap") {
      var all = [];   // ids are unique across the whole project, because mesh uplinks and power advice refer to APs by id
      project.floors.forEach(function (f) { all = all.concat(f.aps); });
      var id = S.nextId(all.concat(added), "ap"), item = { id: id, x: a.x, y: a.y, tx_dbm: a.tx_dbm };
      if (a.band) { item.band = a.band; }
      added.push(item);
      var op = S.addOp("ap", project, floorId, item);
      op.index = floor.aps.length + added.length - 1;   // keep batch order: later APs go after earlier ones
      return [op];
    }
    var owner = floorOfAp(project, a.ap_id);
    if (!owner) { throw new Error("access point " + a.ap_id + " no longer exists"); }
    if (a.type === "set_tx") { return [S.setOp("ap", project, owner.id, a.ap_id, { tx_dbm: a.tx_dbm })]; }
    if (a.type === "set_channel") { return [S.setOp("ap", project, owner.id, a.ap_id, { channel: a.channel })]; }
    throw new Error("unknown recommendation action " + a.type);
  }

  /** Rows for the metric diff table of a comparison result: [label, a, b, delta, note]. */
  function diffRows(c) {
    var a = c.a.analytics, b = c.b.analytics;
    function row(label, x, y, d, unit, note) { return [label, f1(x) + unit, f1(y) + unit, signed(d) + unit, note || ""]; }
    return [
      row("Coverage", a.coverage_pct, b.coverage_pct, c.coverage_delta_pct, "%"),
      row("Average RSSI", a.avg_rssi_dbm, b.avg_rssi_dbm, c.mean_rssi_delta_db, " dB"),
      row("Dead zone area", a.dead_zone_area_m2, b.dead_zone_area_m2, c.dead_zone_delta_m2, " m2"),
      row("Mean throughput", a.mean_throughput_mbps, b.mean_throughput_mbps, c.mean_throughput_delta_mbps, " Mbps", ESTIMATE),
      row("Overlap area", a.overlap.pct, b.overlap.pct, b.overlap.pct - a.overlap.pct, "%"),
      row("Client capacity", a.total_client_capacity, b.total_client_capacity, b.total_client_capacity - a.total_client_capacity, "", ESTIMATE),
      ["Access points", String(a.aps.length), String(b.aps.length), signed(c.ap_count_delta, 0).replace(".0", ""), ""],
      row("Optimisation score", c.a.score.score, c.b.score.score, c.score_delta, "", "higher is better")
    ];
  }


  // ------------------------------------------------------------------ engineering dashboard and spectrum data (pure)
  /** Rectangles the dashboard ranks: the rooms of the floor, or square tiles when it has none. */
  function dashboardZones(floor, tileM) {
    if (floor.rooms && floor.rooms.length) {
      return floor.rooms.map(function (r) { return { name: r.label || r.name || r.id, x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.d }; });
    }
    var out = [];
    for (var y = 0; y < floor.depth_m; y += tileM) {
      for (var x = 0; x < floor.width_m; x += tileM) {
        var x1 = Math.min(floor.width_m, x + tileM), y1 = Math.min(floor.depth_m, y + tileM);
        out.push({ name: "Area " + f1(x) + "-" + f1(x1) + " m by " + f1(y) + "-" + f1(y1) + " m", x0: x, y0: y, x1: x1, y1: y1 });
      }
    }
    return out;
  }

  /**
   * Engineering dashboard figures of one floor from an analysis. a: analytics (cols, rows, cell_m, coverage_pct, avg_rssi_dbm), rssi and rate:
   * per-cell best RSSI and estimated bandwidth (Float32Array or array, row-major), floor: the floor record, config: rf-config.json.
   * Returns {histogram, coverage_pct, avg_rssi_dbm, mean_throughput_mbps, efficiency_pct, edge, weakest, strongest, zone_source}. ESTIMATES.
   */
  function dashboardStats(a, rssi, rate, floor, config) {
    var d = config.planner_layers.dashboard, lo = config.planner_layers.layers.rssi.lo, hi = config.planner_layers.layers.rssi.hi, cover = config.analytics.coverage_dbm;
    var n = a.cols * a.rows, cell = a.cell_m, i, bins = [], nb = Math.round((hi - lo) / d.histogram_bin_db);
    for (i = 0; i < nb; i++) { bins.push({ from: lo + i * d.histogram_bin_db, to: lo + (i + 1) * d.histogram_bin_db, cells: 0, pct: 0 }); }
    var rateSum = 0, eff = 0, edgeCells = 0, edgeCovered = 0, edgeSum = 0;
    for (i = 0; i < n; i++) {
      var col = i % a.cols, row = Math.floor(i / a.cols), x = (col + 0.5) * cell, y = (row + 0.5) * cell;
      bins[Math.max(0, Math.min(nb - 1, Math.floor((rssi[i] - lo) / d.histogram_bin_db)))].cells++;
      rateSum += rate[i]; eff += Math.min(1, rate[i] / d.efficiency_target_mbps);
      if (x < d.edge_margin_m || y < d.edge_margin_m || x > floor.width_m - d.edge_margin_m || y > floor.depth_m - d.edge_margin_m) {
        edgeCells++; edgeSum += rssi[i]; if (rssi[i] >= cover) { edgeCovered++; }
      }
    }
    bins.forEach(function (b) { b.pct = n ? 100 * b.cells / n : 0; });
    var zones = dashboardZones(floor, d.zone_tile_m).map(function (z) {
      var sum = 0, count = 0;
      for (var r = Math.max(0, Math.floor(z.y0 / cell)); r < Math.min(a.rows, Math.ceil(z.y1 / cell)); r++) {
        for (var c = Math.max(0, Math.floor(z.x0 / cell)); c < Math.min(a.cols, Math.ceil(z.x1 / cell)); c++) {
          var cx = (c + 0.5) * cell, cy = (r + 0.5) * cell;
          if (cx >= z.x0 && cx < z.x1 && cy >= z.y0 && cy < z.y1) { sum += rssi[r * a.cols + c]; count++; }
        }
      }
      return count ? { name: z.name, x0: z.x0, y0: z.y0, x1: z.x1, y1: z.y1, mean_rssi_dbm: sum / count, cells: count } : null;
    }).filter(Boolean);
    function byName(p, q) { return p.name < q.name ? -1 : p.name > q.name ? 1 : 0; }
    return { histogram: bins, coverage_pct: a.coverage_pct, avg_rssi_dbm: a.avg_rssi_dbm, mean_throughput_mbps: n ? rateSum / n : 0, efficiency_pct: n ? 100 * eff / n : 0,
             edge: { cells: edgeCells, coverage_pct: edgeCells ? 100 * edgeCovered / edgeCells : null, mean_rssi_dbm: edgeCells ? edgeSum / edgeCells : null },
             weakest: zones.slice().sort(function (p, q) { return (p.mean_rssi_dbm - q.mean_rssi_dbm) || byName(p, q); }).slice(0, d.zones),
             strongest: zones.slice().sort(function (p, q) { return (q.mean_rssi_dbm - p.mean_rssi_dbm) || byName(p, q); }).slice(0, d.zones),
             zone_source: floor.rooms && floor.rooms.length ? "rooms" : "tiles" };
  }

  /**
   * Spectrum view of one band: the engine analysis (channel occupancy, congestion, suggestions) plus the frequency span of every access point
   * and source for the width overlap rows. RF is RFEngine, config rf-config.json.
   */
  function spectrumView(project, band, widthMhz, RF, config) {
    var analysis = RF.spectrumAnalysis(project, band, { config: config, widthMhz: widthMhz }), sources = [];
    project.floors.forEach(function (f) {
      f.aps.forEach(function (ap) {
        if ((ap.band || "2.4") !== band) { return; }
        var radio = RF.apRadio(config, ap, band), span = RF.sourceSpanMhz(config, { band: band, channel: radio.channel, width_mhz: radio.width });
        sources.push({ id: ap.id, kind: "ap", lo: span[0], hi: span[1], channel: radio.channel, width_mhz: radio.width });
      });
    });
    RF.resolveInterferers(project, config).forEach(function (src) {
      if (src.band !== band) { return; }
      var span = RF.sourceSpanMhz(config, src);
      sources.push({ id: src.id, kind: src.kind, lo: span[0], hi: span[1], channel: src.channel === undefined ? null : src.channel, width_mhz: src.width_mhz });
    });
    var lo = Infinity, hi = -Infinity;
    analysis.channels.forEach(function (c) { lo = Math.min(lo, c.centre_mhz - widthMhz / 2); hi = Math.max(hi, c.centre_mhz + widthMhz / 2); });
    sources.forEach(function (x) { lo = Math.min(lo, x.lo); hi = Math.max(hi, x.hi); });
    return { analysis: analysis, sources: sources, lo_mhz: lo, hi_mhz: hi, width_mhz: widthMhz };
  }

  // ------------------------------------------------------------------ DOM helpers
  function el(tag, props, kids) {
    var e = root.document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === "text") { e.textContent = props[k]; } else if (k === "class") { e.className = props[k]; }
      else if (k === "on") { Object.keys(props.on).forEach(function (ev) { e.addEventListener(ev, props.on[ev]); }); }
      else if (props[k] !== undefined && props[k] !== null) { e.setAttribute(k, props[k]); }
    });
    (kids || []).forEach(function (k) { if (k) { e.appendChild(typeof k === "string" ? root.document.createTextNode(k) : k); } });
    return e;
  }
  function button(text, onClick, props) { return el("button", Object.assign({ type: "button", text: text, on: { click: onClick } }, props || {})); }
  function table(caption, headers, rows) {
    var t = el("table", { class: "dtable" }), head = el("tr"), body = el("tbody");
    t.appendChild(el("caption", { text: caption }));
    headers.forEach(function (h) { head.appendChild(el("th", { scope: "col", text: h })); });
    t.appendChild(el("thead", {}, [head]));
    rows.forEach(function (r) {
      var tr = el("tr");
      r.forEach(function (c) { tr.appendChild(c && c.nodeType ? el("td", {}, [c]) : el("td", { text: String(c) })); });
      body.appendChild(tr);
    });
    if (!rows.length) { body.appendChild(el("tr", {}, [el("td", { colspan: headers.length, text: "None" })])); }
    t.appendChild(body);
    return el("div", { class: "tscroll" }, [t]);
  }
  function card(label, value, note, cls) {
    return el("div", { class: "stat" + (cls ? " " + cls : "") }, [el("span", { class: "stat-v", text: value }), el("span", { class: "stat-l", text: label }), note ? el("span", { class: "stat-n", text: note }) : null]);
  }

  /** Tab strip with arrow key navigation. add(id, label) returns the panel element. */
  function createTabs(strip, host) {
    var tabs = [], listeners = {};
    function select(id, focus) {
      tabs.forEach(function (t) {
        var on = t.id === id;
        t.button.setAttribute("aria-selected", String(on)); t.button.tabIndex = on ? 0 : -1; t.panel.hidden = !on;
        if (on && focus) { t.button.focus(); }
      });
      (listeners[id] || []).forEach(function (fn) { fn(); });
    }
    return {
      add: function (id, label) {
        var b = el("button", { type: "button", role: "tab", id: "tab-" + id, "aria-controls": "panel-" + id, "aria-selected": "false", text: label, tabindex: "-1" });
        var p = el("div", { role: "tabpanel", id: "panel-" + id, "aria-labelledby": "tab-" + id, class: "tabpanel", tabindex: "0" });
        p.hidden = true;
        var entry = { id: id, button: b, panel: p };
        b.addEventListener("click", function () { select(id, false); });
        b.addEventListener("keydown", function (e) {
          var i = tabs.indexOf(entry), j = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
          if (j < 0) { return; }
          e.preventDefault(); select(tabs[(j + tabs.length) % tabs.length].id, true);
        });
        tabs.push(entry); strip.appendChild(b); host.appendChild(p);
        if (tabs.length === 1) { select(id, false); }
        return p;
      },
      select: select,
      /** Call fn each time the tab is shown, so panels that draw to a canvas can size it while visible. */
      onSelect: function (id, fn) { (listeners[id] = listeners[id] || []).push(fn); }
    };
  }

  // ------------------------------------------------------------------ mount
  function mount(app) {
    var S = root.PlannerState, H = root.PlannerHeat, doc = root.document;
    var tabs = createTabs(doc.getElementById("tabs"), doc.getElementById("tabPanels"));
    app.tabs = tabs;
    var state = { analysis: null, timer: 0, flash: null, ghost: null, compare: null, plan: null, recs: [], planJob: 0, applied: {}, staleNote: false };
    var panels = { analytics: tabs.add("analytics", "Analytics"), layers: tabs.add("layers", "Layers"), dashboard: tabs.add("dashboard", "Dashboard"),
                   spectrum: tabs.add("spectrum", "Spectrum"), environment: tabs.add("environment", "Environment"),
                   scenarios: tabs.add("scenarios", "Scenarios"), smart: tabs.add("smart", "Smart planner") };
    function overlayOn(id) { return app.view.overlays.indexOf(id) >= 0; }
    function toggleOverlay(id, on) {
      var list = app.view.overlays.filter(function (x) { return x !== id; });
      app.setView({ overlays: on ? list.concat([id]) : list });
    }

    // -------------------------------------------------------------- overlays on the editor canvas
    app.overlay(function (c, view) {
      function sx(x) { return view.ox + x * view.scale; }
      function sy(y) { return view.oy + y * view.scale; }
      if (overlayOn("roaming") && state.analysis && state.analysis.floor === app.store.floorId) {
        // exact per-cell data (analytics.roaming.map), horizontal runs of equal zones drawn as one rectangle
        var an = state.analysis.analytics, map = an.roaming.map, cell = an.cell_m * view.scale;
        var fills = { overlap: "rgba(251,191,36,.12)", handoff: "rgba(251,191,36,.40)" };
        c.save();
        map.zone.forEach(function (row, r) {
          for (var col = 0; col < row.length; col++) {
            var id = map.zone_ids[row[col]];
            if (!fills[id]) { continue; }
            var end = col;
            while (end + 1 < row.length && row[end + 1] === row[col]) { end++; }
            c.fillStyle = fills[id];
            c.fillRect(sx(col * an.cell_m), sy(r * an.cell_m), cell * (end - col + 1), cell);
            col = end;
          }
        });
        c.restore();
      }
      ["strongest", "blend"].forEach(function (id) {
        var img = overlayOn(id) && state.analysis && state.analysis.floor === app.store.floorId ? overlayImage(id) : null;
        if (!img) { return; }
        c.save(); c.imageSmoothingEnabled = false;
        c.drawImage(img, sx(0), sy(0), img.width * state.analysis.analytics.cell_m * view.scale, img.height * state.analysis.analytics.cell_m * view.scale);
        c.restore();
      });
      if (state.flash) {
        c.save(); c.strokeStyle = "#fb7185"; c.lineWidth = 3; c.setLineDash([6, 4]);
        c.strokeRect(sx(state.flash.x_min), sy(state.flash.y_min), (state.flash.x_max - state.flash.x_min) * view.scale, (state.flash.y_max - state.flash.y_min) * view.scale);
        c.restore();
      }
      if (state.ghost) {
        c.save(); c.globalAlpha = 0.75; c.strokeStyle = "#a78bfa"; c.fillStyle = "rgba(167,139,250,.35)"; c.lineWidth = 2; c.setLineDash([4, 3]);
        c.beginPath(); c.arc(sx(state.ghost.x), sy(state.ghost.y), 12, 0, Math.PI * 2); c.fill(); c.stroke();
        c.setLineDash([]); c.fillStyle = "#e8edf6"; c.font = "11px system-ui, sans-serif"; c.textAlign = "center";
        c.fillText(state.ghost.label || "suggested AP", sx(state.ghost.x), sy(state.ghost.y) - 18);
        c.restore();
      }
    });

    // ============================================================== analytics
    function requestAnalysis(immediate) {
      root.clearTimeout(state.timer);
      state.timer = root.setTimeout(function () {
        if (!app.backend) { return; }
        var floor = app.currentFloor();
        app.runJob({ type: "analyze", floor: floor.id, cell_m: analysisCell(floor), layers: app.neededLayers() }, {
          result: function (m) {
            state.analysis = m; m.overlays = {};
            renderAnalytics(); renderDashboard(); renderSideBySide(); renderLayerPanel();
            if (app.refreshApResults) { app.refreshApResults(); }
            if (app.view.layer !== "rssi") { app.applyLayer(); }
            app.editor.invalidate();
            if (app.onAnalysis) { app.onAnalysis(m); }
          },
          error: function (m) { panels.analytics.textContent = "Analytics failed: " + m.message; }
        });
      }, immediate === true ? 0 : ANALYSIS_DEBOUNCE_MS);
    }
    app.requestAnalysis = requestAnalysis;

    function locate(box) {
      var cx = (box.x_min + box.x_max) / 2, cy = (box.y_min + box.y_max) / 2;
      app.editor.centerOn(cx, cy);
      state.flash = box; app.editor.invalidate();
      app.say("Dead zone at " + f1(cx) + " m, " + f1(cy) + " m highlighted");
      root.setTimeout(function () { if (state.flash === box) { state.flash = null; app.editor.invalidate(); } }, FLASH_MS);
    }

    function renderAnalytics() {
      var host = panels.analytics, m = state.analysis, cfg = app.config;
      host.textContent = "";
      if (!m) { host.appendChild(el("p", { class: "muted", text: "Computing analytics..." })); return; }
      var a = m.analytics, th = cfg.analytics;
      host.appendChild(el("p", { class: "muted hint", text: "MODEL ESTIMATE, not a measurement. Throughput, capacity and channel utilisation are ESTIMATES from a rate table and an airtime model (docs/rf-planner.md). Grid " + a.cell_m + " m." }));
      var stats = el("div", { class: "stats" });
      [card("Coverage", pct(a.coverage_pct), "at or above " + th.coverage_dbm + " dBm"), card("Average RSSI", f1(a.avg_rssi_dbm) + " dBm", "best AP per cell"),
       card("Weak area", f1(a.weak_area_m2) + " m2", pct(a.weak_area_pct) + " of floor"), card("Dead zones", String(a.dead_zones.length), f1(a.dead_zone_area_m2) + " m2 below " + th.dead_zone_dbm + " dBm", a.dead_zones.length ? "bad" : ""),
       card("Mean throughput " + ESTIMATE, f1(a.mean_throughput_mbps) + " Mbps", "per cell, one client"), card("Client capacity " + ESTIMATE, String(a.total_client_capacity), "at " + th.per_client_demand_mbps + " Mbps each"),
       card("AP overlap", pct(a.overlap.pct), f1(a.overlap.area_m2) + " m2"), card("Roaming zones", pct(a.roaming.pct), a.roaming.zones.length + " areas")
      ].forEach(function (c) { stats.appendChild(c); });
      host.appendChild(stats);

      var tools = el("div", { class: "tool-row" });
      var rg = el("input", { type: "checkbox", id: "tgRoaming" });
      rg.checked = overlayOn("roaming");
      rg.addEventListener("change", function () { toggleOverlay("roaming", rg.checked); });
      tools.appendChild(el("label", { class: "check" }, [rg, " Show roaming zones on the plan (exact cells: handoff strong, overlap light)"]));
      host.appendChild(tools);

      var bars = el("div", { class: "bars", "aria-hidden": "true" });
      th.quality_bands.forEach(function (b) {
        var row = el("div", { class: "bar-row" }), fill = el("i");
        fill.style.width = Math.max(0, Math.min(100, a.quality_pct[b.id])) + "%";
        var c = H.bandColor(app.paletteId || "classic", b.id); fill.style.background = "rgb(" + c.join(",") + ")";
        row.appendChild(el("span", { text: b.id })); row.appendChild(el("div", { class: "bar" }, [fill])); row.appendChild(el("span", { text: pct(a.quality_pct[b.id]) }));
        bars.appendChild(row);
      });
      host.appendChild(el("h3", { text: "Signal quality distribution" }));
      host.appendChild(bars);
      host.appendChild(table("Signal quality distribution (text equivalent of the bars)", ["Band", "Share of floor"], th.quality_bands.map(function (b) { return [b.id, pct(a.quality_pct[b.id])]; })));

      host.appendChild(table("Per access point. Throughput, capacity and utilisation are " + ESTIMATE + "S.",
        ["AP", "Band / channel", "Served area", "Usable throughput " + ESTIMATE, "Client capacity " + ESTIMATE, "Expected clients", "Channel utilisation " + ESTIMATE, "Co-channel neighbours"],
        a.aps.map(function (p) {
          return [p.id, p.band + " GHz / " + p.channel + " (" + p.width_mhz + " MHz)", f1(p.served_area_m2) + " m2", f1(p.usable_mbps) + " Mbps", String(p.client_capacity), f1(p.expected_clients),
                  f1(p.channel_utilisation_pct) + "%" + (p.saturated ? " (saturated)" : ""), p.cochannel_neighbours.join(", ") || "none"];
        })));
      host.appendChild(table("AP overlap (cells where two APs are both usable and within " + th.overlap_margin_db + " dB)", ["AP A", "AP B", "Area"],
        a.overlap.pairs.map(function (p) { return [p.a, p.b, f1(p.area_m2) + " m2"]; })));
      host.appendChild(table("Roaming candidates (two APs within " + th.roam_margin_db + " dB, both above " + th.roam_min_dbm + " dBm)", ["Best AP", "Second AP", "Area"],
        a.roaming.pairs.map(function (p) { return [p.a, p.b, f1(p.area_m2) + " m2"]; })));
      var zones = a.dead_zones.map(function (z, i) {
        return [String(i + 1), f1(z.area_m2) + " m2", "(" + f1(z.centroid.x) + ", " + f1(z.centroid.y) + ") m",
                button("Locate", function () { locate(z.bbox); }, { "aria-label": "Locate dead zone " + (i + 1) + " on the plan" })];
      });
      host.appendChild(table("Dead zones (below " + th.dead_zone_dbm + " dBm)", ["#", "Area", "Centre", "Show"], zones));
    }
    app.onStoreAnalytics = requestAnalysis;

    // ============================================================== scenarios
    var sc = { host: panels.scenarios, nameInput: null, list: el("div"), a: "current", b: "current", mode: "side", result: null, ranking: null, msg: el("p", { class: "muted", role: "status" }), view: null, wipe: WIPE_START_PCT };
    function scenarios() { return app.store.project.scenarios || []; }
    function now() { return new Date().toISOString().slice(0, 19) + "Z"; }
    function saveScenarios(list) { app.store.setMeta("scenarios", list); renderScenarios(); }

    function projectFor(id) {
      if (id === "current") { return S.computeProject(app.store.project); }
      var s = scenarios().filter(function (x) { return x.id === id; })[0];
      if (!s) { throw new Error("scenario '" + id + "' no longer exists"); }
      return S.computeProject(S.scenarioProject(app.store.project, s));
    }
    function nameFor(id) { return id === "current" ? "Current plan" : (scenarios().filter(function (x) { return x.id === id; })[0] || { name: id }).name; }

    function textMax() { return S.textLimit(app.validateOpts()); }
    function renderScenarios() {
      var host = sc.host; host.textContent = "";
      host.appendChild(el("p", { class: "muted hint", text: "A scenario is a named snapshot of the floors (walls, access points and settings). Scenarios are saved with the project in this browser and in exported project JSON. MODEL ESTIMATE, not a measurement." }));
      sc.nameInput = el("input", { type: "text", id: "scenarioName", maxlength: String(textMax()), placeholder: "Scenario name", "aria-label": "Scenario name" });
      var saveRow = el("div", { class: "tool-row" }, [sc.nameInput, button("Save current plan as scenario", function () {
        if (scenarios().length >= S.MAX_SCENARIOS) { sc.msg.textContent = "At most " + S.MAX_SCENARIOS + " scenarios. Delete one first."; return; }
        var raw = sc.nameInput.value.trim() || "Scenario " + (scenarios().length + 1), s = S.makeScenario(app.store.project, raw, app.settings, now(), textMax());
        saveScenarios(scenarios().concat([s]));
        sc.msg.textContent = "Saved scenario " + s.name + (S.clipText(raw, textMax()).clipped ? " (name shortened to " + textMax() + " characters)" : "");
      }, { id: "scenarioSave" })]);
      host.appendChild(saveRow);
      var rows = scenarios().map(function (s) {
        var aps = s.floors.reduce(function (n, f) { return n + f.aps.length; }, 0), nameCell = el("span", { text: s.name });
        var rename = button("Rename", function () {
          var input = el("input", { type: "text", maxlength: String(textMax()), value: s.name, "aria-label": "New name for " + s.name });
          var ok = button("Save", function () { saveScenarios(S.renameScenario(scenarios(), s.id, input.value.trim() || s.name, textMax())); });
          nameCell.textContent = ""; nameCell.appendChild(input); nameCell.appendChild(ok); input.focus();
        }, { "aria-label": "Rename " + s.name });
        return [nameCell, s.created.replace("T", " ").replace("Z", ""), String(aps),
          el("span", { class: "row-actions" }, [
            button("Restore", function () {
              if (!root.confirm("Restore \"" + s.name + "\" as the working plan? This clears the undo history. Save the current plan as a scenario first if you want to keep it.")) { return; }
              var p = S.scenarioProject(app.store.project, s); p.scenarios = scenarios();
              app.store.load(S.validateProject(p, app.validateOpts())); app.editor.fit(); app.say("Restored " + s.name);
            }, { "aria-label": "Restore " + s.name }), rename,
            button("Duplicate", function () { saveScenarios(S.duplicateScenario(scenarios(), s.id, now())); }, { "aria-label": "Duplicate " + s.name }),
            button("Delete", function () { saveScenarios(S.deleteScenario(scenarios(), s.id)); }, { "aria-label": "Delete " + s.name })])];
      });
      host.appendChild(table("Saved scenarios", ["Name", "Saved", "APs", "Actions"], rows));
      var io = el("div", { class: "tool-row" }, [button("Download scenarios (JSON)", function () { app.download("scenarios.wallhack-scenarios.json", "application/json", JSON.stringify({ kind: "wallhack-scenarios", schema_version: S.SCHEMA_VERSION, scenarios: scenarios() }, null, 1)); }),
        button("Import scenarios", function () { sc.file.click(); })]);
      sc.file = el("input", { type: "file", accept: "application/json,.json", hidden: "" });
      sc.file.addEventListener("change", function () {
        var f = sc.file.files[0]; sc.file.value = ""; if (!f) { return; }
        var r = new root.FileReader();
        r.onload = function () {
          try {
            var d = JSON.parse(r.result);
            if (!d || d.kind !== "wallhack-scenarios") { throw new Error("not a Wallhack scenarios file"); }
            var merged = scenarios().slice();
            S.validateProject({ floors: app.store.project.floors, materials: app.store.project.materials, scenarios: d.scenarios }, app.validateOpts()).scenarios.forEach(function (s) {
              s.id = S.nextId(merged, "s"); merged.push(s);
            });
            if (merged.length > S.MAX_SCENARIOS) { throw new Error("too many scenarios (limit " + S.MAX_SCENARIOS + ")"); }
            saveScenarios(merged); sc.msg.textContent = "Imported " + (merged.length - scenarios().length) + " scenarios";
          } catch (e) { sc.msg.textContent = "Import failed: " + e.message; }
        };
        r.readAsText(f);
      });
      io.appendChild(sc.file); host.appendChild(io);

      // compare controls
      host.appendChild(el("h3", { text: "Compare" }));
      var opts = [["current", "Current plan"]].concat(scenarios().map(function (s) { return [s.id, s.name]; }));
      function select(id, label, key) {
        var s = el("select", { id: id, "aria-label": label });
        opts.forEach(function (o) { s.appendChild(el("option", { value: o[0], text: o[1] })); });
        if (!opts.some(function (o) { return o[0] === sc[key]; })) { sc[key] = "current"; }
        s.value = sc[key]; s.addEventListener("change", function () { sc[key] = s.value; });
        return el("label", { class: "inline" }, [label + " ", s]);
      }
      var modeSel = el("select", { id: "cmpMode", "aria-label": "View" });
      [["side", "Side by side"], ["delta", "Delta (B minus A)"], ["wipe", "Before/after slider"]].forEach(function (o) { modeSel.appendChild(el("option", { value: o[0], text: o[1] })); });
      modeSel.value = sc.mode; modeSel.addEventListener("change", function () { sc.mode = modeSel.value; renderComparison(); });
      host.appendChild(el("div", { class: "tool-row" }, [select("cmpA", "A (before)", "a"), select("cmpB", "B (after)", "b"), el("label", { class: "inline" }, ["View ", modeSel]),
        button("Compare", runCompare, { id: "cmpRun" }), button("Rank all by score", runRank, { id: "cmpRank" })]));
      host.appendChild(sc.msg);
      sc.out = el("div", { id: "cmpOut" }); host.appendChild(sc.out);
      if (sc.result) { renderComparison(); }
      if (sc.ranking) { renderRanking(); }
    }

    function runCompare() {
      var floor = app.currentFloor();
      try {
        sc.msg.textContent = "Comparing...";
        app.runJob({ type: "compare", floor: floor.id, cell_m: analysisCell(floor), a: projectFor(sc.a), b: projectFor(sc.b) }, {
          result: function (m) { sc.result = m; sc.names = [nameFor(sc.a), nameFor(sc.b)]; sc.floorSnap = [S.clone(projectFor(sc.a).floors), S.clone(projectFor(sc.b).floors)]; sc.msg.textContent = "Compared " + sc.names[0] + " with " + sc.names[1]; renderComparison(); },
          error: function (m) { sc.msg.textContent = "Comparison failed: " + m.message; }
        });
      } catch (e) { sc.msg.textContent = e.message; }
    }
    function runRank() {
      var floor = app.currentFloor(), items = [{ id: "current", name: "Current plan", project: projectFor("current") }].concat(scenarios().map(function (s) { return { id: s.id, name: s.name, project: projectFor(s.id) }; }));
      app.runJob({ type: "rank", floor: floor.id, cell_m: analysisCell(floor), items: items }, {
        progress: function (m) { sc.msg.textContent = "Ranking: " + m.text + " (" + (m.step + 1) + " of " + m.steps + ")"; },
        result: function (m) { sc.ranking = m; sc.msg.textContent = "Ranked " + m.rows.length + " plans"; renderRanking(); },
        error: function (m) { sc.msg.textContent = "Ranking failed: " + m.message; }
      });
    }

    function renderRanking() {
      var old = doc.getElementById("rankOut"); if (old) { old.remove(); }
      var box = el("div", { id: "rankOut" });
      box.appendChild(table("Ranking by optimisation score (higher is better). Weights are planning preferences, not physics. " + ESTIMATE,
        ["Rank", "Plan", "Score", "Coverage", "Avg RSSI", "Dead zone", "Overlap", "APs", "Mean throughput " + ESTIMATE],
        sc.ranking.rows.map(function (r, i) { return [String(i + 1), r.name, f1(r.score), pct(r.coverage_pct), f1(r.avg_rssi_dbm) + " dBm", pct(r.dead_zone_pct), pct(r.overlap_pct), String(r.aps), f1(r.mean_throughput_mbps) + " Mbps"]; })));
      sc.host.appendChild(box);
    }

    // ---- comparison viewer: shared pan and zoom, three views
    function drawGridTo(ctx, cols, rows, colorAt) {
      var off = doc.createElement("canvas"); off.width = cols; off.height = rows;
      var oc = off.getContext("2d"), img = oc.createImageData(cols, rows);
      for (var i = 0; i < cols * rows; i++) { var c = colorAt(i); img.data[i * 4] = c[0]; img.data[i * 4 + 1] = c[1]; img.data[i * 4 + 2] = c[2]; img.data[i * 4 + 3] = c[3] === undefined ? 190 : c[3]; }
      oc.putImageData(img, 0, 0);
      return off;
    }
    function drawView(canvas, view, layers, clip, label) {
      var dpr = root.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
      var c = canvas.getContext("2d"), r = sc.result, floor = layers.floors.filter(function (f) { return f.id === r.floor; })[0];
      c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
      c.fillStyle = getComputedStyle(doc.documentElement).getPropertyValue("--bg").trim() || "#080b12"; c.fillRect(0, 0, w, h);
      c.save();
      if (clip) { c.beginPath(); c.rect(clip.x0, 0, clip.x1 - clip.x0, h); c.clip(); }
      c.imageSmoothingEnabled = true;
      c.drawImage(layers.image, view.ox, view.oy, floor.width_m * view.scale, floor.depth_m * view.scale);
      c.strokeStyle = "#cbd5e1"; c.lineWidth = Math.max(1.5, 0.1 * view.scale); c.lineCap = "round"; c.beginPath();
      floor.walls.forEach(function (wl) { c.moveTo(view.ox + wl.x1 * view.scale, view.oy + wl.y1 * view.scale); c.lineTo(view.ox + wl.x2 * view.scale, view.oy + wl.y2 * view.scale); });
      c.stroke();
      floor.aps.forEach(function (ap) { c.fillStyle = "#a78bfa"; c.beginPath(); c.arc(view.ox + ap.x * view.scale, view.oy + ap.y * view.scale, 6, 0, Math.PI * 2); c.fill(); });
      c.restore();
      c.fillStyle = "rgba(0,0,0,.55)"; c.fillRect(6, 6, c.measureText ? Math.min(w - 12, label.length * 7 + 12) : 200, 22);
      c.fillStyle = "#fff"; c.font = "12px system-ui, sans-serif"; c.fillText(label, 12, 21);
      c.fillStyle = "#fbbf24"; c.fillText("MODEL ESTIMATE, not a measurement", 12, h - 10);
    }
    function renderComparison() {
      if (!sc.out) { return; }
      sc.out.textContent = "";
      var r = sc.result; if (!r) { return; }
      var floor = r.floorDims || (sc.floorSnap[0].filter(function (f) { return f.id === r.floor; })[0]);
      var pal = app.paletteId || "classic";
      var imgA = drawGridTo(null, r.cols, r.rows, function (i) { var c = H.colorAt(pal, r.rssi_a[i]); return [c[0], c[1], c[2], 190]; });
      var imgB = drawGridTo(null, r.cols, r.rows, function (i) { var c = H.colorAt(pal, r.rssi_b[i]); return [c[0], c[1], c[2], 190]; });
      var imgD = drawGridTo(null, r.cols, r.rows, function (i) { return deltaColor(r.delta[i]); });
      var wrap = el("div", { class: "cmp-stage cmp-" + sc.mode });
      var cA = el("canvas", { id: "cmpCanvasA", class: "cmp-canvas", role: "img", "aria-label": "Heat map of " + sc.names[0] + ". Text equivalent is in the tables below." });
      var cB = el("canvas", { id: "cmpCanvasB", class: "cmp-canvas", role: "img", "aria-label": "Heat map of " + sc.names[1] + ". Text equivalent is in the tables below." });
      wrap.appendChild(cA); if (sc.mode !== "delta") { wrap.appendChild(cB); }
      if (sc.mode === "delta") { cB = null; }
      var slider = null;
      if (sc.mode === "wipe") {
        slider = el("input", { type: "range", min: "0", max: "100", value: String(sc.wipe), id: "cmpWipe", "aria-label": "Wipe position: left shows before (A), right shows after (B)", class: "wipe" });
        wrap.appendChild(slider);
      }
      sc.out.appendChild(wrap);
      var A = { floors: sc.floorSnap[0], image: imgA }, B = { floors: sc.floorSnap[1], image: imgB }, D = { floors: sc.floorSnap[1], image: imgD };
      function fit() {
        var w = cA.clientWidth || 400, h = cA.clientHeight || 300, pad = 12;
        var scale = Math.min((w - 2 * pad) / floor.width_m, (h - 2 * pad) / floor.depth_m);
        sc.view = { scale: scale, ox: (w - floor.width_m * scale) / 2, oy: (h - floor.depth_m * scale) / 2 };
      }
      function redraw() {
        var v = sc.view;
        if (sc.mode === "side") { drawView(cA, v, A, null, "A: " + sc.names[0]); drawView(cB, v, B, null, "B: " + sc.names[1]); }
        else if (sc.mode === "delta") { drawView(cA, v, { floors: D.floors, image: imgD }, null, "B minus A (dB)"); }
        else {
          var w = cA.clientWidth, x = w * sc.wipe / 100;
          drawView(cA, v, B, { x0: x, x1: w }, "A (left) | B (right): " + sc.names[0] + " | " + sc.names[1]);
          var c = cA.getContext("2d"), dpr = root.devicePixelRatio || 1;
          c.setTransform(dpr, 0, 0, dpr, 0, 0); c.save(); c.beginPath(); c.rect(0, 0, x, cA.clientHeight); c.clip();
          c.drawImage(imgA, v.ox, v.oy, floor.width_m * v.scale, floor.depth_m * v.scale);
          c.strokeStyle = "#cbd5e1"; c.lineWidth = Math.max(1.5, 0.1 * v.scale); c.beginPath();
          A.floors.filter(function (f) { return f.id === r.floor; })[0].walls.forEach(function (wl) { c.moveTo(v.ox + wl.x1 * v.scale, v.oy + wl.y1 * v.scale); c.lineTo(v.ox + wl.x2 * v.scale, v.oy + wl.y2 * v.scale); });
          c.stroke(); c.restore();
          c.fillStyle = "#fff"; c.fillRect(x - 1, 0, 2, cA.clientHeight);
        }
      }
      function attach(canvas) {
        var drag = null;
        canvas.addEventListener("pointerdown", function (e) { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
        canvas.addEventListener("pointermove", function (e) { if (!drag) { return; } sc.view.ox += e.clientX - drag.x; sc.view.oy += e.clientY - drag.y; drag = { x: e.clientX, y: e.clientY }; redraw(); });
        canvas.addEventListener("pointerup", function () { drag = null; });
        canvas.addEventListener("wheel", function (e) {
          e.preventDefault();
          var rc = canvas.getBoundingClientRect(), k = Math.pow(1.0015, -e.deltaY), v = sc.view, px = e.clientX - rc.left, py = e.clientY - rc.top;
          v.ox = px - (px - v.ox) * k; v.oy = py - (py - v.oy) * k; v.scale *= k; redraw();
        }, { passive: false });
      }
      attach(cA); if (cB) { attach(cB); }
      if (slider) { slider.addEventListener("input", function () { sc.wipe = parseInt(slider.value, 10); redraw(); }); }
      fit(); root.requestAnimationFrame(function () { fit(); redraw(); });
      redraw();
      if (sc.mode === "delta") {
        var lg = el("div", { class: "delta-legend" }, [el("span", { text: "-" + DELTA_RANGE_DB + " dB (B weaker)" }), el("i", { class: "delta-bar", "aria-hidden": "true" }), el("span", { text: "+" + DELTA_RANGE_DB + " dB (B stronger)" })]);
        sc.out.appendChild(lg);
      }
      sc.out.appendChild(table("Metrics, A (" + sc.names[0] + ") against B (" + sc.names[1] + "). Throughput and capacity are " + ESTIMATE + "S.", ["Metric", "A", "B", "Change (B minus A)", "Note"], diffRows(r)));
      var names = r.a.score.breakdown.map(function (p, i) { return [p.id.replace("_", " "), String(p.weight), f2(p.value), f2(p.contribution), f2(r.b.score.breakdown[i].value), f2(r.b.score.breakdown[i].contribution)]; });
      sc.out.appendChild(table("Optimisation score. " + r.a.score.label, ["Component", "Weight", "A value", "A points", "B value", "B points"],
        names.concat([["Total", "", "", f2(r.a.score.score), "", f2(r.b.score.score)]])));
    }
    root.addEventListener("resize", function () { if (sc.result) { renderComparison(); } });
    app.store.subscribe(function (ev) { if (ev.source === "meta" && ev.key === "scenarios") { return; } if (ev.source === "load") { sc.result = null; sc.ranking = null; renderScenarios(); } });
    renderScenarios();

    // ============================================================== smart planner
    var sp = { host: panels.smart, out: el("div"), status: el("p", { class: "muted", role: "status", id: "planStatus" }), bar: el("progress", { max: "1", value: "0", hidden: "", "aria-label": "Planner progress" }) };
    function renderSmart() {
      var host = sp.host; host.textContent = "";
      host.appendChild(el("p", { class: "banner note", role: "note", text: PLAN_NOTE }));
      var target = el("input", { type: "number", min: "50", max: "100", step: "1", value: String(app.config.planner.target_coverage_pct), id: "planTarget", "aria-label": "Target coverage in percent" });
      var maxAps = el("input", { type: "number", min: "1", max: "64", step: "1", value: "12", id: "planMax", "aria-label": "Maximum total access points" });
      var run = button("Run planner", function () { runPlan(parseFloat(target.value), parseInt(maxAps.value, 10)); }, { id: "planRun" });
      var cancel = button("Cancel", function () { if (state.planJob) { app.cancelJob(state.planJob); } }, { id: "planCancel", disabled: "" });
      sp.run = run; sp.cancel = cancel;
      host.appendChild(el("div", { class: "tool-row" }, [el("label", { class: "inline" }, ["Target coverage % ", target]), el("label", { class: "inline" }, ["Max APs ", maxAps]), run, cancel]));
      host.appendChild(sp.bar); host.appendChild(sp.status); host.appendChild(sp.out);
      if (state.plan) { renderPlan(); }
    }
    function runPlan(targetPct, max) {
      if (!(targetPct >= 50 && targetPct <= 100) || !(max >= 1 && max <= 64)) { sp.status.textContent = "Target must be 50 to 100 percent and max APs 1 to 64."; return; }
      sp.run.disabled = true; sp.cancel.disabled = false; sp.bar.hidden = false; sp.bar.value = 0;
      state.planJob = app.runJob({ type: "plan", floor: app.store.floorId, target_pct: targetPct, max_aps: max }, {
        progress: function (m) { sp.bar.value = m.step / m.steps; sp.status.textContent = "Step " + (m.step + 1) + " of " + m.steps + ": " + m.text + "..."; },
        result: function (m) { done(); state.plan = m; state.recs = buildRecommendations(m); state.applied = {}; state.staleNote = false; sp.status.textContent = "Planner finished: " + state.recs.length + " recommendations."; renderPlan(); },
        cancelled: function () { done(); sp.status.textContent = "Planner cancelled."; },
        error: function (m) { done(); sp.status.textContent = "Planner failed: " + m.message; }
      });
    }
    function done() { state.planJob = 0; sp.run.disabled = false; sp.cancel.disabled = true; sp.bar.hidden = true; }

    function applyRecs(recs, label) {
      var added = [], ops = [];
      try { recs.forEach(function (r) { ops = ops.concat(recommendationOps(S, app.store.project, app.store.floorId, r, added)); }); }
      catch (e) { sp.status.textContent = "Cannot apply: " + e.message; return; }
      state.applying = true;
      app.store.exec({ label: label, ops: ops });
      state.applying = false;
      recs.forEach(function (r) { state.applied[r.id] = true; });
      sp.status.textContent = "Applied " + recs.length + (recs.length === 1 ? " recommendation" : " recommendations") + ". Undo with Ctrl+Z. Results below are from before the change: run the planner again.";
      renderPlan();
    }
    function setGhost(r) { state.ghost = r && r.ghost ? { x: r.ghost.x, y: r.ghost.y, label: "suggested AP" } : null; app.editor.invalidate(); }

    function renderPlan() {
      var p = state.plan, out = sp.out; out.textContent = "";
      if (!p) { return; }
      var count = p.count;
      out.appendChild(el("p", { class: "plan-sum", text: count.message + " Confidence " + Math.round(count.confidence * 100) + "% (lowest of the placements)." }));
      out.appendChild(table("Coverage against AP count (estimate)", ["Total APs", "Coverage"], count.curve.map(function (c) { return [String(c.aps), pct(c.coverage_pct)]; })));
      out.appendChild(table("Issues found", ["Severity", "Issue"], p.issues.map(function (i) { return [i.severity, i.text]; })));
      var openRecs = state.recs.filter(function (r) { return !state.applied[r.id]; });
      var head = el("div", { class: "tool-row" }, [button("Apply all (" + openRecs.length + ")", function () { applyRecs(openRecs, "Apply all planner recommendations"); }, openRecs.length ? { id: "planApplyAll" } : { id: "planApplyAll", disabled: "" })]);
      out.appendChild(el("h3", { text: "Recommendations" })); out.appendChild(head);
      var list = el("ul", { class: "recs", id: "recList" });
      state.recs.forEach(function (r) {
        var applied = !!state.applied[r.id];
        var li = el("li", { class: applied ? "applied" : "" });
        li.appendChild(el("div", { class: "rec-main" }, [el("strong", { text: r.kind.replace("_", " ") }), " ", el("span", { text: r.text })]));
        li.appendChild(el("div", { class: "muted hint", text: "Confidence: " + (r.confidence === null ? "n/a" : Math.round(r.confidence * 100) + "%") + ". " + r.reason }));
        var row = el("div", { class: "tool-row" });
        if (r.ghost) {
          var pv = button("Preview", function () { setGhost(state.ghost && state.ghost.x === r.ghost.x && state.ghost.y === r.ghost.y ? null : r); }, { "aria-label": "Preview suggested access point on the plan" });
          row.appendChild(pv);
          li.addEventListener("mouseenter", function () { setGhost(r); }); li.addEventListener("mouseleave", function () { setGhost(null); });
        }
        row.appendChild(button(applied ? "Applied" : "Apply", function () { applyRecs([r], "Apply recommendation: " + r.kind.replace("_", " ")); }, applied ? { disabled: "" } : { "data-rec": r.id }));
        li.appendChild(row); list.appendChild(li);
      });
      if (!state.recs.length) { list.appendChild(el("li", { text: "No changes recommended." })); }
      out.appendChild(list);
      out.appendChild(el("p", { class: "muted hint", text: PLAN_NOTE }));
    }
    app.store.subscribe(function (ev) {
      if (ev.source === "load") { state.plan = null; state.recs = []; state.ghost = null; renderSmart(); }
      else if (state.plan && !state.applying && ev.ops && ev.ops.length && !state.staleNote) { state.staleNote = true; sp.status.textContent = "The plan changed since the planner ran. Run it again for fresh recommendations."; }
    });
    renderSmart();

    // ============================================================== layers: combine, side-by-side compare, roaming and AP overlays
    var AP_COLOURS = function () { return app.config.planner_layers.overlay_ap_colours; };
    function hexRgb(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }

    /** Cached cols x rows image of an overlay ("strongest" AP or signal "blend"), one pixel per analysis cell. */
    function overlayImage(id) {
      var m = state.analysis;
      if (!m || !m.analytics || !m.analytics.best_ap) { return null; }
      if (m.overlays[id]) { return m.overlays[id]; }
      var a = m.analytics, cv = doc.createElement("canvas"), cx = cv.getContext("2d"), img;
      cv.width = a.cols; cv.height = a.rows; img = cx.createImageData(a.cols, a.rows);
      for (var r = 0; r < a.rows; r++) {
        for (var c = 0; c < a.cols; c++) {
          var k = (r * a.cols + c) * 4, ap = a.best_ap[r][c], rgb = null, alpha = 0;
          if (id === "strongest" && ap >= 0) { rgb = hexRgb(AP_COLOURS()[ap % AP_COLOURS().length]); alpha = 105; }
          else if (id === "blend") {
            var blend = a.roaming.map.blend_pct[r][c];
            if (blend !== null && blend < 100) { rgb = [251, 191, 36]; alpha = Math.round(40 + 190 * (100 - blend) / 50); }
          }
          if (rgb) { img.data[k] = rgb[0]; img.data[k + 1] = rgb[1]; img.data[k + 2] = rgb[2]; img.data[k + 3] = alpha; }
        }
      }
      cx.putImageData(img, 0, 0);
      m.overlays[id] = cv;
      return cv;
    }

    var layerUi = { host: panels.layers };
    function layerLabel(id) { return H.layerSpec(app.config, id).label; }
    function renderLayerPanel() {
      var host = layerUi.host, v = app.view, cfg = app.config;
      host.textContent = "";
      host.appendChild(el("p", { class: "muted hint", text: cfg.planner_layers.label + ". Pick the map layer in the Heat map card. Layers that need a WiFi standard on an access point stay empty until you set one in the access point list." }));
      var combine = el("div", { class: "checks", id: "combineList", role: "group", "aria-label": "Layers to combine" });
      H.layerIds(cfg).forEach(function (id) {
        var cb = el("input", { type: "checkbox", "data-layer": id });
        cb.checked = v.combine.indexOf(id) >= 0;
        cb.addEventListener("change", function () {
          var list = Array.prototype.slice.call(combine.querySelectorAll("input")).filter(function (x) { return x.checked; }).map(function (x) { return x.dataset.layer; });
          if (!list.length) { cb.checked = true; app.say("Keep at least one layer selected"); return; }
          app.setView({ combine: list });
        });
        combine.appendChild(el("label", { class: "check" }, [cb, " " + layerLabel(id)]));
      });
      host.appendChild(el("h3", { text: "Combined layer" }));
      host.appendChild(el("p", { class: "muted hint", text: "The combined map shows, in every cell, the weakest result among the ticked layers (each rated from worst to best on its own scale), so it highlights the bottleneck." }));
      host.appendChild(combine);
      host.appendChild(el("div", { class: "tool-row" }, [button("Show combined map", function () { app.setView({ layer: H.COMBINED_ID }); }, { id: "showCombined" })]));

      host.appendChild(el("h3", { text: "Roaming and signal overlays" }));
      var ov = el("div", { class: "checks", id: "overlayList" });
      [["roaming", "Overlap and handoff areas (exact cells)"], ["strongest", "Strongest AP (colour per access point)"], ["blend", "Signal blend (where several APs share a cell, darker means more even)"]].forEach(function (o) {
        var cb = el("input", { type: "checkbox", id: "ov-" + o[0] });
        cb.checked = overlayOn(o[0]);
        cb.addEventListener("change", function () { toggleOverlay(o[0], cb.checked); });
        ov.appendChild(el("label", { class: "check" }, [cb, " " + o[1]]));
      });
      host.appendChild(ov);
      var m = state.analysis;
      if (m && m.floor === app.store.floorId) {
        var legend = el("ul", { class: "legend-list", id: "apColourLegend", "aria-label": "Strongest AP colours" });
        m.analytics.aps.forEach(function (ap, i) {
          var sw = el("i"); sw.style.background = AP_COLOURS()[i % AP_COLOURS().length]; sw.setAttribute("aria-hidden", "true");
          legend.appendChild(el("li", {}, [sw, el("b", { text: ap.id }), " " + ap.band + " GHz channel " + ap.channel + ", serves " + f1(ap.served_area_m2) + " m2"]));
        });
        if (overlayOn("strongest")) { host.appendChild(legend); }
        host.appendChild(el("p", { class: "muted hint", text: "Handoff area " + f1(m.analytics.roaming.area_m2) + " m2 (" + pct(m.analytics.roaming.pct) + "), overlap area " + f1(m.analytics.overlap.area_m2) + " m2 (" + pct(m.analytics.overlap.pct) + "). " + cfg.roaming.label }));
      }

      host.appendChild(el("h3", { text: "Side by side" }));
      var sel = el("select", { id: "cmpLayerB", "aria-label": "Layer shown on the right" });
      H.layerIds(cfg).concat([H.COMBINED_ID]).forEach(function (id) { sel.appendChild(el("option", { value: id, text: layerLabel(id) })); });
      sel.value = v.compare === undefined ? "snr" : v.compare;
      sel.addEventListener("change", function () { app.setView({ compare: sel.value }); });
      host.appendChild(el("div", { class: "tool-row" }, [el("label", { class: "inline" }, ["Left: current map layer. Right: ", sel])]));
      layerUi.side = el("div", { class: "side-by-side", id: "sideBySide" });
      host.appendChild(layerUi.side);
      renderSideBySide();
    }

    function drawLayerCanvas(canvas, info, floor, palette) {
      var dpr = root.devicePixelRatio || 1, w = canvas.clientWidth || 360, h = canvas.clientHeight || 240, pad = 6;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      var c = canvas.getContext("2d"), k = Math.min((w - 2 * pad) / floor.width_m, (h - 2 * pad) / floor.depth_m), ox = (w - floor.width_m * k) / 2, oy = (h - floor.depth_m * k) / 2;
      c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
      c.fillStyle = "rgba(128,140,170,.15)"; c.fillRect(ox, oy, floor.width_m * k, floor.depth_m * k);
      if (info && info.stats) {
        var off = doc.createElement("canvas"), oc, img, lut = {};
        off.width = info.cols; off.height = info.rows; oc = off.getContext("2d"); img = oc.createImageData(info.cols, info.rows);
        for (var i = 0; i < info.rssi.length; i++) {
          var key = Math.round(info.rssi[i] * 2), col = lut[key] || (lut[key] = H.colorAt(palette, info.rssi[i]));
          img.data[i * 4] = col[0]; img.data[i * 4 + 1] = col[1]; img.data[i * 4 + 2] = col[2]; img.data[i * 4 + 3] = 215;
        }
        oc.putImageData(img, 0, 0);
        c.imageSmoothingEnabled = true; c.drawImage(off, ox, oy, floor.width_m * k, floor.depth_m * k);
      }
      c.strokeStyle = "#cbd5e1"; c.lineWidth = 1.5; c.lineCap = "round"; c.beginPath();
      floor.walls.forEach(function (wl) { c.moveTo(ox + wl.x1 * k, oy + wl.y1 * k); c.lineTo(ox + wl.x2 * k, oy + wl.y2 * k); });
      c.stroke();
      floor.aps.forEach(function (ap) { c.fillStyle = "#a78bfa"; c.beginPath(); c.arc(ox + ap.x * k, oy + ap.y * k, 4, 0, Math.PI * 2); c.fill(); });
    }

    function renderSideBySide() {
      var host = layerUi.side;
      if (!host) { return; }
      host.textContent = "";
      var m = state.analysis, floor = app.currentFloor(), v = app.view;
      if (!m || m.floor !== floor.id || !m.layers) { host.appendChild(el("p", { class: "muted", text: "Computing layers..." })); return; }
      var ids = [v.layer, v.compare], pending = [];
      var panes = ids.map(function (id, n) {
        if (!(id === H.COMBINED_ID ? v.combine : [id]).every(function (x) { return m.layers[x]; })) { pending.push(id); return null; }
        var info = H.layerGrid(id, { config: app.config, analytics: m.analytics, values: m.layers }, v.combine);
        var cv = el("canvas", { id: "side" + (n ? "B" : "A"), class: "side-canvas", role: "img", "aria-label": layerLabel(id) + " map. The legend and the table below give the same information as text." });
        var legend = el("ul", { class: "legend-list" });
        H.fillLayerLegend(legend, app.config, id, v.palette, info);
        host.appendChild(el("figure", { class: "side-pane" }, [el("figcaption", { text: layerLabel(id) }), cv, legend]));
        root.requestAnimationFrame(function () { drawLayerCanvas(cv, info, floor, v.palette); });
        return info;
      });
      if (pending.length) {
        host.appendChild(el("p", { class: "muted", text: "Computing " + pending.map(layerLabel).join(", ") + "..." }));
        app.requestAnalysis(true);
      }
      var rows = panes.map(function (info, n) {
        var spec = H.layerSpec(app.config, ids[n]);
        return info ? [layerLabel(ids[n]), info.stats ? f1(info.stats.min) + " " + spec.unit : "-", info.stats ? f1(info.stats.mean) + " " + spec.unit : "-", info.stats ? f1(info.stats.max) + " " + spec.unit : "-", info.reason || ""] : [layerLabel(ids[n]), "-", "-", "-", "computing"];
      });
      host.appendChild(table("Layer statistics over the floor (" + ESTIMATE + "S)", ["Layer", "Minimum", "Mean", "Maximum", "Note"], rows));
    }
    app.onView(function () { renderLayerPanel(); renderSideBySide(); if (state.analysis) { renderAnalytics(); } app.editor.invalidate(); });

    // ============================================================== engineering dashboard
    var dash = { host: panels.dashboard };
    function renderDashboard() {
      var host = dash.host, m = state.analysis, floor = app.currentFloor();
      host.textContent = "";
      if (!m || m.floor !== floor.id || !m.layers || !m.layers.rssi || !m.layers.bandwidth) { host.appendChild(el("p", { class: "muted", text: "Computing the dashboard..." })); return; }
      var d = dashboardStats(m.analytics, m.layers.rssi.values, m.layers.bandwidth.values, floor, app.config), th = app.config.planner_layers.dashboard;
      host.appendChild(el("p", { class: "muted hint", text: "MODEL ESTIMATE, not a measurement. Throughput and efficiency are " + ESTIMATE + "S from a rate table (docs/rf-planner.md). " + th.efficiency_note }));
      var stats = el("div", { class: "stats" });
      [card("Average coverage", pct(d.coverage_pct), "at or above " + app.config.analytics.coverage_dbm + " dBm"), card("Average RSSI", f1(d.avg_rssi_dbm) + " dBm", "best AP per cell"),
       card("Edge coverage", d.edge.coverage_pct === null ? "-" : pct(d.edge.coverage_pct), "within " + th.edge_margin_m + " m of the outer edge"),
       card("Throughput " + ESTIMATE, f1(d.mean_throughput_mbps) + " Mbps", "mean per cell, one client"),
       card("Efficiency score " + ESTIMATE, f1(d.efficiency_pct) + " / 100", "target " + th.efficiency_target_mbps + " Mbps per cell")
      ].forEach(function (c) { stats.appendChild(c); });
      host.appendChild(stats);
      host.appendChild(el("h3", { text: "Signal distribution" }));
      var cv = el("canvas", { id: "dashHist", class: "hist", role: "img", "aria-label": "Histogram of the best signal per cell, in " + th.histogram_bin_db + " dB bins. The table below has the same numbers." });
      host.appendChild(cv);
      root.requestAnimationFrame(function () { drawHistogram(cv, d.histogram); });
      host.appendChild(table("Signal distribution (share of floor area per RSSI range)", ["RSSI range", "Share of floor"], d.histogram.filter(function (b) { return b.cells > 0; })
        .map(function (b) { return [b.from + " to " + b.to + " dBm", pct(b.pct)]; })));
      function zoneRows(list) {
        return list.map(function (z) {
          return [z.name, f1(z.mean_rssi_dbm) + " dBm", button("Locate", function () { locate({ x_min: z.x0, y_min: z.y0, x_max: z.x1, y_max: z.y1 }); }, { "aria-label": "Show " + z.name + " on the plan" })];
        });
      }
      var what = d.zone_source === "rooms" ? "rooms" : "tiles of " + th.zone_tile_m + " m (this floor has no rooms)";
      host.appendChild(table("Weakest zones, by mean RSSI of " + what, ["Zone", "Mean signal", "Show"], zoneRows(d.weakest)));
      host.appendChild(table("Strongest zones, by mean RSSI of " + what, ["Zone", "Mean signal", "Show"], zoneRows(d.strongest)));
    }
    function drawHistogram(canvas, bins) {
      var dpr = root.devicePixelRatio || 1, w = canvas.clientWidth || 480, h = canvas.clientHeight || 160, padL = 34, padB = 24, padT = 8;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      var c = canvas.getContext("2d"), max = Math.max.apply(null, bins.map(function (b) { return b.pct; }).concat([1])), bw = (w - padL - 8) / bins.length, fg = getComputedStyle(doc.documentElement).getPropertyValue("--fg").trim() || "#e8edf6";
      c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
      c.font = "11px system-ui, sans-serif"; c.fillStyle = fg; c.strokeStyle = fg; c.globalAlpha = 0.5;
      c.beginPath(); c.moveTo(padL, padT); c.lineTo(padL, h - padB); c.lineTo(w - 4, h - padB); c.stroke(); c.globalAlpha = 1;
      c.textAlign = "right"; c.fillText(f1(max) + "%", padL - 4, padT + 8); c.fillText("0", padL - 4, h - padB);
      bins.forEach(function (b, i) {
        var mid = (b.from + b.to) / 2, col = H.colorAt(app.view.palette, mid), bh = (h - padB - padT) * b.pct / max;
        c.fillStyle = "rgb(" + col.join(",") + ")"; c.fillRect(padL + i * bw + 1, h - padB - bh, bw - 2, bh);
        c.strokeStyle = fg; c.globalAlpha = 0.6; c.strokeRect(padL + i * bw + 1, h - padB - bh, bw - 2, bh); c.globalAlpha = 1;
        if (i % 2 === 0) { c.fillStyle = fg; c.textAlign = "center"; c.fillText(String(b.from), padL + i * bw + bw / 2, h - 8); }
      });
      c.fillStyle = fg; c.textAlign = "right"; c.fillText("dBm", w - 4, h - 8);
    }
    app.onView(function () { if (state.analysis) { renderDashboard(); } });

    // ============================================================== spectrum view
    var spec = { host: panels.spectrum, band: "5", width: null, canvas: null };
    var LEVEL_COLOURS = { low: "#009e73", moderate: "#f0e442", high: "#e69f00", severe: "#d55e00" };
    var KIND_COLOURS = { ap: "#56b4e9", microwave: "#d55e00", bluetooth: "#cc79a7", neighbour_wifi: "#e69f00" };
    function renderSpectrum() {
      var host = spec.host, cfg = app.config, bands = Object.keys(cfg.bands);
      host.textContent = "";
      if (bands.indexOf(spec.band) < 0) { spec.band = bands[0]; }
      var widths = cfg.bands[spec.band].widths_mhz;
      if (widths.indexOf(spec.width) < 0) { spec.width = cfg.spectrum.width_mhz[spec.band]; }
      var data;
      try { data = spectrumView(app.store.project, spec.band, spec.width, root.RFEngine, cfg); } catch (e) { host.appendChild(el("p", { class: "banner error", role: "alert", text: "Spectrum view failed: " + e.message })); return; }
      host.appendChild(el("p", { class: "muted hint", text: data.analysis.label + ". " + "Congestion adds up coupling times duty cycle of every access point and source in the project, ignoring distance." }));
      var bandSel = el("select", { id: "specBand", "aria-label": "Band" }), widthSel = el("select", { id: "specWidth", "aria-label": "Channel width" });
      bands.forEach(function (b) { bandSel.appendChild(el("option", { value: b, text: b + " GHz" })); }); bandSel.value = spec.band;
      widths.forEach(function (w) { widthSel.appendChild(el("option", { value: String(w), text: w + " MHz" })); }); widthSel.value = String(spec.width);
      bandSel.addEventListener("change", function () { spec.band = bandSel.value; spec.width = null; renderSpectrum(); });
      widthSel.addEventListener("change", function () { spec.width = parseInt(widthSel.value, 10); renderSpectrum(); });
      host.appendChild(el("div", { class: "tool-row" }, [el("label", { class: "inline" }, ["Band ", bandSel]), el("label", { class: "inline" }, ["Candidate channel width ", widthSel])]));
      var sugg = data.analysis.suggestions;
      host.appendChild(el("p", { id: "specSuggest", class: "plan-sum", text: sugg.length ? "Least congested channels at " + spec.width + " MHz: " + sugg.map(function (x) { return x.channel + " (" + x.level + ", congestion " + x.congestion + ")"; }).join(", ") + "." : "No channel suggestion for this band." }));
      var rowsN = Math.min(data.sources.length, 12), height = 230 + rowsN * 16;
      spec.canvas = el("canvas", { id: "specCanvas", class: "spectrum", width: "900", height: String(height), role: "img",
        "aria-label": "Channel occupancy of the " + spec.band + " GHz band with the frequency span of each access point and source. The tables below have the same numbers." });
      host.appendChild(spec.canvas);
      drawSpectrum(spec.canvas, data);
      var legend = el("p", { class: "muted hint", text: "Bars: congestion of a channel of the chosen width (full height is 100 percent). Colour and text level: low, moderate, high, severe. Rows below: the frequency span of each access point and source (blue AP, red microwave, pink Bluetooth, orange neighbour WiFi). Triangles mark the suggested channels." });
      host.appendChild(legend);
      host.appendChild(table("Channels (" + ESTIMATE + "S)", ["Channel", "Centre", "Overlapping sources", "Congestion", "Level"], data.analysis.channels.map(function (c) {
        return [String(c.channel), c.centre_mhz + " MHz", c.sources.map(function (x) { return x.id + " (" + f1(x.overlap_mhz) + " MHz)"; }).join(", ") || "none", String(c.congestion), c.level];
      })));
      host.appendChild(table("Sources in this band", ["Source", "Kind", "Span", "Channel", "Width"], data.sources.map(function (x) {
        return [x.id, x.kind, Math.round(x.lo) + " to " + Math.round(x.hi) + " MHz", x.channel === null ? "-" : String(x.channel), x.width_mhz + " MHz"];
      })));
    }
    function drawSpectrum(canvas, data) {
      var c = canvas.getContext("2d"), w = canvas.width, h = canvas.height, padL = 40, padR = 12, padT = 26, chartH = 140, axisY = padT + chartH;
      var fg = getComputedStyle(doc.documentElement).getPropertyValue("--fg").trim() || "#e8edf6", span = data.hi_mhz - data.lo_mhz, k = (w - padL - padR) / span;
      function X(mhz) { return padL + (mhz - data.lo_mhz) * k; }
      c.clearRect(0, 0, w, h); c.font = "11px system-ui, sans-serif"; c.textBaseline = "alphabetic";
      c.strokeStyle = fg; c.fillStyle = fg; c.globalAlpha = 0.45; c.lineWidth = 1;
      c.beginPath(); c.moveTo(padL, padT); c.lineTo(padL, axisY); c.lineTo(w - padR, axisY); c.stroke(); c.globalAlpha = 1;
      c.textAlign = "right"; c.fillText("100%", padL - 4, padT + 8); c.fillText("0", padL - 4, axisY);
      var chans = data.analysis.channels, sparse = chans.length > 14, shown = {};
      data.analysis.suggestions.forEach(function (x) { shown[x.channel] = true; });
      chans.forEach(function (ch, i) {
        var x0 = X(ch.centre_mhz - data.width_mhz / 2), x1 = X(ch.centre_mhz + data.width_mhz / 2), bh = chartH * Math.min(100, ch.occupancy_pct) / 100, col = LEVEL_COLOURS[ch.level];
        c.globalAlpha = 0.4; c.fillStyle = col; c.fillRect(x0, axisY - bh, x1 - x0, bh);
        c.globalAlpha = 0.9; c.strokeStyle = col; c.strokeRect(x0, axisY - bh, x1 - x0, bh); c.globalAlpha = 1;
        if (!sparse || i % Math.ceil(chans.length / 14) === 0 || shown[ch.channel]) {
          c.fillStyle = fg; c.textAlign = "center"; c.fillText(String(ch.channel), X(ch.centre_mhz), axisY + 13);
        }
      });
      data.analysis.suggestions.forEach(function (sg) {
        var ch = chans.filter(function (x) { return x.channel === sg.channel; })[0], cx = X(ch.centre_mhz);
        c.fillStyle = fg; c.beginPath(); c.moveTo(cx, axisY - 4); c.lineTo(cx - 6, axisY - 15); c.lineTo(cx + 6, axisY - 15); c.closePath(); c.fill();
      });
      c.fillStyle = fg; c.textAlign = "left"; c.fillText("Channel (centre frequency " + Math.round(data.lo_mhz) + " to " + Math.round(data.hi_mhz) + " MHz)", padL, padT - 10);
      data.sources.slice(0, 12).forEach(function (src, i) {
        var y = axisY + 26 + i * 16, col = KIND_COLOURS[src.kind] || "#999";
        c.globalAlpha = 0.55; c.fillStyle = col; c.fillRect(X(src.lo), y, Math.max(2, X(src.hi) - X(src.lo)), 11); c.globalAlpha = 1;
        c.strokeStyle = col; c.strokeRect(X(src.lo), y, Math.max(2, X(src.hi) - X(src.lo)), 11);
        c.fillStyle = fg; c.textAlign = "left"; c.fillText(src.id + " (" + src.kind + ")", Math.min(X(src.hi) + 4, w - 150), y + 10);
      });
    }
    app.store.subscribe(function (ev) { if (ev.source !== "select" && ev.source !== "meta" && spec.canvas !== null) { root.clearTimeout(spec.timer); spec.timer = root.setTimeout(renderSpectrum, 120); } });
    tabs.onSelect("spectrum", renderSpectrum); tabs.onSelect("dashboard", renderDashboard); tabs.onSelect("layers", renderSideBySide);
    renderSpectrum();
    app.renderSpectrum = renderSpectrum;

    // ============================================================== environment: interference sources, floor openings, doors and windows
    var env = { host: panels.environment };
    function numberField(value, min, max, step, label, onChange) {
      var inp = el("input", { type: "number", min: String(min), max: String(max), step: String(step), value: String(value), "aria-label": label });
      inp.addEventListener("change", function () {
        var v = parseFloat(inp.value);
        if (isFinite(v) && v >= min && v <= max) { onChange(v); } else { inp.value = String(value); app.say(label + " must be " + min + " to " + max); }
      });
      return inp;
    }
    function selectField(options, value, label, onChange) {
      var sel = el("select", { "aria-label": label });
      options.forEach(function (o) { sel.appendChild(el("option", { value: o[0], text: o[1] })); });
      sel.value = value; sel.addEventListener("change", function () { onChange(sel.value); });
      return sel;
    }
    function renderEnvironment() {
      var host = env.host, cfg = app.config, ext = cfg.external_sources, project = app.store.project, floor = app.currentFloor(), st = app.store;
      host.textContent = "";
      host.appendChild(el("p", { class: "muted hint", text: ext.label + ". Add sources with the Interference tool (X) or here. Drag a source on the plan to move it." }));

      // interference sources
      host.appendChild(el("h3", { text: "Interference and neighbour networks" }));
      host.appendChild(el("div", { class: "tool-row" }, [button("Add source on this floor", function () {
        var kind = doc.getElementById("sourceKind").value;
        app.editor.addInterfererAt({ x: floor.width_m / 2, y: floor.depth_m / 2 }, kind);
      }, { id: "envAddSource" })]));
      var srcRows = (project.interferers || []).map(function (src) {
        var spec = ext.kinds[src.kind], fl = S.findFloor(project, src.floor);
        function set(props, label) { st.exec({ label: label, key: "src:" + src.id + ":" + Object.keys(props)[0], ops: [S.setOp("interferer", project, null, src.id, props)] }); }
        var cells = [src.id,
          selectField(Object.keys(ext.kinds).map(function (k) { return [k, ext.kinds[k].label]; }), src.kind, "Kind of " + src.id, function (v) {
            set({ kind: v, band: undefined, channel: undefined, width_mhz: undefined }, "Change source kind"); }),
          selectField(project.floors.map(function (f) { return [f.id, f.name]; }), src.floor, "Floor of " + src.id, function (v) {
            var f2 = S.findFloor(project, v); set({ floor: v, x: Math.min(src.x, f2.width_m), y: Math.min(src.y, f2.depth_m) }, "Move source to another floor"); }),
          el("span", { class: "row-actions" }, [
            numberField(src.x, 0, fl.width_m, 0.5, "X of " + src.id + " (m)", function (v) { set({ x: v }, "Move source"); }),
            numberField(src.y, 0, fl.depth_m, 0.5, "Y of " + src.id + " (m)", function (v) { set({ y: v }, "Move source"); })]),
          numberField(src.tx_dbm !== undefined ? src.tx_dbm : spec.tx_dbm, ext.tx_dbm_range[0], ext.tx_dbm_range[1], 1, "Power of " + src.id + " (dBm)", function (v) { set({ tx_dbm: v }, "Change source power"); }),
          numberField(Math.round(100 * (src.duty_cycle !== undefined ? src.duty_cycle : spec.duty_cycle)), 100 * ext.duty_cycle_range[0], 100 * ext.duty_cycle_range[1], 5, "Duty cycle of " + src.id + " (percent)",
            function (v) { set({ duty_cycle: v / 100 }, "Change source duty cycle"); })];
        if (src.kind === "neighbour_wifi") {
          var band = src.band || spec.default_band;
          cells.push(el("span", { class: "row-actions" }, [
            selectField(Object.keys(cfg.bands).map(function (b) { return [b, b + " GHz"]; }), band, "Band of " + src.id, function (v) { set({ band: v, channel: undefined, width_mhz: undefined }, "Change source band"); }),
            selectField([["", "default"]].concat(cfg.bands[band].channels.map(function (ch) { return [String(ch), String(ch)]; })), src.channel === undefined ? "" : String(src.channel), "Channel of " + src.id,
              function (v) { set({ channel: v ? parseInt(v, 10) : undefined }, "Change source channel"); })]));
        } else { cells.push(spec.centre_mhz ? spec.centre_mhz + " MHz, " + spec.width_mhz + " MHz wide" : ""); }
        cells.push(button("Delete", function () { app.editor.deleteInterferer(src.id); }, { "aria-label": "Delete " + src.id }));
        return cells;
      });
      host.appendChild(table("Sources (" + ESTIMATE + "S, planning assumptions)", ["Id", "Kind", "Floor", "Position (m)", "Power dBm", "Duty %", "Radio", ""], srcRows));

      // floor openings (stairwells)
      host.appendChild(el("h3", { text: "Stairwells, atria and shafts on " + floor.name }));
      host.appendChild(el("div", { class: "tool-row" }, [button("Add stairwell", function () {
        var kind = doc.getElementById("voidKind").value, size = Math.min(3, floor.width_m, floor.depth_m);
        var rect = { x: Math.max(0, Math.floor((floor.width_m - size) / 2)), y: Math.max(0, Math.floor((floor.depth_m - size) / 2)), w: size, d: size };
        app.editor.addVoid(rect, kind);
      }, { id: "envAddVoid" })]));
      var voidRows = (floor.voids || []).map(function (v) {
        function set(props, label) { st.exec({ label: label, key: "void:" + v.id + ":" + Object.keys(props)[0], ops: [S.setOp("void", project, floor.id, v.id, props)] }); }
        var geometry = v.points ? el("span", { text: v.points.length + " point polygon" }) :
          el("span", { class: "row-actions" }, [numberField(v.x, 0, floor.width_m - v.w, 0.5, "X of " + v.id, function (n) { set({ x: n }, "Move floor opening"); }),
            numberField(v.y, 0, floor.depth_m - v.d, 0.5, "Y of " + v.id, function (n) { set({ y: n }, "Move floor opening"); }),
            numberField(v.w, 0.5, floor.width_m - v.x, 0.5, "Width of " + v.id, function (n) { set({ w: n }, "Resize floor opening"); }),
            numberField(v.d, 0.5, floor.depth_m - v.y, 0.5, "Depth of " + v.id, function (n) { set({ d: n }, "Resize floor opening"); })]);
        return [v.id, selectField(cfg.voids.kinds.map(function (k) { return [k, k]; }), v.kind, "Kind of " + v.id, function (k) { set({ kind: k }, "Change floor opening kind"); }), geometry,
                button("Delete", function () { app.editor.deleteVoid(v.id); }, { "aria-label": "Delete " + v.id })];
      });
      host.appendChild(table("Floor openings. They lower the floor loss for paths that start or end inside them (" + cfg.voids.label + ")", ["Id", "Kind", "Position and size (x, y, width, depth in m)", ""], voidRows));

      // doors and windows
      host.appendChild(el("h3", { text: "Doors and windows on " + floor.name }));
      var wallIds = floor.walls.map(function (w) { return w.id; });
      host.appendChild(el("p", { class: "muted hint", text: "Use the Door and Window tools (D, O) and click a wall, or right-click a wall. A door or window passes more signal than the wall around it." }));
      var openRows = floor.openings.map(function (op) {
        var wall = floor.walls.filter(function (w) { return w.id === op.wall; })[0], len = wall ? S.wallLength(wall) : op.pos + op.width;
        function set(props, label) { st.exec({ label: label, key: "opening:" + op.id + ":" + Object.keys(props)[0], ops: [S.setOp("opening", project, floor.id, op.id, props)] }); }
        return [op.id, selectField([["door", "Door"], ["window", "Window"]], op.kind, "Kind of " + op.id, function (k) { set({ kind: k }, "Change opening kind"); }), op.wall,
          numberField(op.pos, 0, Math.max(0, len - op.width), 0.1, "Position of " + op.id + " along its wall (m)", function (n) { set({ pos: n }, "Move opening"); }),
          numberField(op.width, 0.1, Math.max(0.1, len - op.pos), 0.1, "Width of " + op.id + " (m)", function (n) { set({ width: n }, "Resize opening"); }),
          button("Delete", function () { app.editor.deleteOpening(op.id); }, { "aria-label": "Delete " + op.id })];
      });
      host.appendChild(table("Doors and windows (" + wallIds.length + " walls on this floor)", ["Id", "Kind", "Wall", "Position (m)", "Width (m)", ""], openRows));
    }
    app.store.subscribe(function (ev) {
      if (ev.source === "select" || ev.source === "meta") { return; }
      if (ev.source === "exec" && ev.ops.length && ev.ops.every(function (o) { return o.t.indexOf("opening.") !== 0 && o.t.indexOf("void.") !== 0 && o.t.indexOf("interferer.") !== 0 && o.t !== "floors.add" && o.t !== "floors.remove"; })) { return; }
      renderEnvironment();
    });
    renderEnvironment();
    renderLayerPanel(); renderDashboard();

    app.panels = { renderAnalytics: renderAnalytics, renderScenarios: renderScenarios, state: state, sc: sc, renderEnvironment: renderEnvironment, renderSpectrum: renderSpectrum };
  }

  var api = { mount: mount, createTabs: createTabs, el: el, table: table, button: button, card: card, f1: f1, f2: f2, pct: pct, signed: signed, analysisCell: analysisCell,
              deltaColor: deltaColor, DELTA_RANGE_DB: DELTA_RANGE_DB, buildRecommendations: buildRecommendations, recommendationOps: recommendationOps, diffRows: diffRows,
              floorOfAp: floorOfAp, PLAN_NOTE: PLAN_NOTE, dashboardStats: dashboardStats, dashboardZones: dashboardZones, spectrumView: spectrumView };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  root.PlannerPanels = api;
})(typeof self !== "undefined" ? self : this);
