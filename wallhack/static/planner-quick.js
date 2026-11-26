"use strict";
// Wi-Fi architect front end: the Quick start card for non-experts, the tabs Rooms and gaming, Score card, Assistant, Mesh and
// Time Machine, the "Find best spot for this router" button, the Smart Home check rows and the optional Signal waves.
// Everything here presents numbers computed by rf-insight.js, rf-optimizer.js and rf-engine.js. MODEL ESTIMATE, not a measurement.
// The first half is pure view-model builders (text, rows, chips, store operations, wave geometry) that run under node
// (tests/test_planner_quick.py). The second half, mount(app), is the DOM wiring and needs the browser.
(function (root) {
  var isNode = typeof module !== "undefined" && module.exports;
  var ESTIMATE = "MODEL ESTIMATE";
  var QUALITIES = ["low", "medium", "high"];

  // ================================================================== pure view-model builders
  var APPLICABLE = ["move_ap", "set_channels", "add_ap", "add_mesh_node"];
  function plural(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }
  function signed(v) { return (v > 0 ? "+" : "") + v; }
  function gradeClass(grade) { return "grade-" + String(grade).charAt(0).toLowerCase(); }
  function pingText(range) { return range ? range[0] + " to " + range[1] + " ms" : "no signal"; }
  function pct(v) { return v === null || v === undefined ? "n/a" : v + "%"; }
  function ms(v) { return v === null || v === undefined ? "n/a" : v + " ms"; }
  function mbps(v) { return v === null || v === undefined ? "n/a" : v + " Mbps"; }

  /** Big grade, headline sentence and the three activity chips of a scoreCard() result. */
  function resultModel(card) {
    var r = card.ratings;
    return {
      grade: card.grade, gradeClass: gradeClass(card.grade), score: card.score,
      gradeLabel: "Overall grade " + card.grade + ", " + card.score + " out of 100",
      headline: card.text,
      stats: [{ label: "Coverage", value: pct(card.coverage_pct) }, { label: "Dead zones", value: String(card.dead_zones) }],
      chips: [{ key: "gaming", label: "Gaming", word: r.gaming.word, grade: r.gaming.grade, text: "Gaming: " + r.gaming.word + " (grade " + r.gaming.grade + ")" },
              { key: "streaming", label: "Streaming", word: r.streaming.word, grade: null, text: "Streaming: " + r.streaming.word },
              { key: "video", label: "Video calls", word: r.video.word, grade: null, text: "Video calls: " + r.video.word }]
    };
  }

  /** Before and after of an applied fix from two scoreCard() results: grade, score, activity words and a plain sentence. */
  function beforeAfterModel(before, after, label) {
    var b = before.ratings, a = after.ratings, delta = Math.round(after.score) - Math.round(before.score);
    var verdict = delta > 0 ? "Better: your score went up " + delta + " point" + (delta === 1 ? "" : "s") + "."
      : delta < 0 ? "Worse: your score went down " + (-delta) + " point" + (delta === -1 ? "" : "s") + ". Undo with Ctrl+Z."
      : "No change in the score. The fix may help in ways the score does not show, or undo with Ctrl+Z.";
    function row(key, name) { return { name: name, before: b[key].word, after: a[key].word, changed: b[key].word !== a[key].word }; }
    return { label: label, delta: delta, verdict: verdict, direction: delta > 0 ? "up" : delta < 0 ? "down" : "same",
             before: { grade: before.grade, gradeClass: gradeClass(before.grade), score: before.score }, after: { grade: after.grade, gradeClass: gradeClass(after.grade), score: after.score },
             gradeText: "Grade " + before.grade + " (" + Math.round(before.score) + ") to grade " + after.grade + " (" + Math.round(after.score) + ")",
             rows: [row("gaming", "Gaming"), row("streaming", "Streaming"), row("video", "Video calls")],
             coverage: { before: before.coverage_pct, after: after.coverage_pct }, dead: { before: before.dead_zones, after: after.dead_zones } };
  }

  /** One row per room from a gamerMode() result, with a text equivalent for screen readers. */
  function roomRows(gamer) {
    return gamer.rooms.map(function (r) {
      var ping = pingText(r.ping_ms);
      return { id: r.id, name: r.name, coverage: pct(r.coverage_pct), ping: ping, jitter: r.jitter_ms === null || r.jitter_ms === undefined ? "n/a" : r.jitter_ms + " ms",
               loss: r.loss_risk, grade: r.grade, gradeClass: gradeClass(r.grade), score: r.stability_score,
               text: r.name + ": coverage " + pct(r.coverage_pct) + ", ping " + ping + ", packet loss risk " + r.loss_risk + ", gaming grade " + r.grade + " (stability " + r.stability_score + " out of 100)" };
    });
  }

  /** The room with the lowest gaming stability score (first on ties), or null. */
  function worstRoom(gamer) {
    var worst = null;
    gamer.rooms.forEach(function (r) { if (!worst || r.stability_score < worst.stability_score) { worst = r; } });
    return worst;
  }

  function questionFor(roomName) { return "Why is my " + String(roomName).toLowerCase() + " WiFi slow?"; }

  /** Suggested question chips: one per named room of the floor (at most `max`). */
  function questionChips(floor, max) {
    return (floor.rooms || []).filter(function (r) { return r.name; }).slice(0, max || 6).map(function (r) { return { room: r.name, text: questionFor(r.name) }; });
  }

  /** "Living room, +34 points coverage, 3 dead zones removed" from a placementReport(), built from its numbers. */
  function bestSpotModel(report) {
    var where = report.room || "(" + report.position.x + " m, " + report.position.y + " m)";
    var gain = signed(report.coverage_increase_pts) + " points coverage, " + report.dead_zones_removed + " dead zone" + (report.dead_zones_removed === 1 ? "" : "s") + " removed";
    var change = null, canApply = false, line;
    if (!report.had_router) {
      line = "Add a router in " + where + ", " + gain; canApply = true;
      change = { kind: "add_ap", floor: report.floor, x: report.position.x, y: report.position.y };
    } else if (report.moved) {
      line = where + ", " + gain; canApply = true;
      change = { kind: "move_ap", ap_id: report.ap_id, x: report.position.x, y: report.position.y };
    } else {
      line = "Your router is already at the best spot we found (" + where + ")";
    }
    return { line: line, canApply: canApply, change: change, position: { x: report.position.x, y: report.position.y },
             detail: report.text, latency: report.latency_change_ms === null || report.latency_change_ms === undefined ? null : "Wi-Fi delay " + signed(report.latency_change_ms) + " ms",
             extra: report.additional_ap ? "Coverage is still short of the target. A second access point near " + (report.additional_ap.room || "(" + report.additional_ap.x + " m, " + report.additional_ap.y + " m)") + " would help." : null };
  }

  /** Display model of a diagnose() result: lines, cause rows and fix rows (a fix can be shown and applied when it has a change). */
  function answerModel(d) {
    if (d.status !== "diagnosed") {
      return { status: d.status, title: "I need a room name", lines: d.text.slice(), causes: [], fixes: [], rooms: (d.rooms || []).map(function (r) { return r.name; }) };
    }
    var causes = d.causes.concat(d.other_causes || []).map(function (c) { return { text: c.text, db: c.db === undefined ? null : c.db }; });
    return {
      status: d.status, title: "WiFi in " + d.room.name, lines: d.text.slice(), causes: causes, rooms: [],
      fixes: d.fixes.map(function (f) { return { rank: f.rank, line: f.line, confidence: f.what_if.confidence, change: f.change, point: f.change.x === undefined ? null : { x: f.change.x, y: f.change.y } }; })
    };
  }

  function topologyColumns(mesh) {
    return mesh.topologies.map(function (t) {
      return { id: t.id, label: t.label, nodes: t.nodes.map(function (n) { return (n.room || "(" + n.x + " m, " + n.y + " m)") + " at (" + n.x + " m, " + n.y + " m)"; }),
               coverage: pct(t.coverage_pct), dead: String(t.dead_zones), latency: ms(t.mean_latency_ms), throughput: mbps(t.mean_throughput_mbps), grade: t.grade, score: t.score,
               dCoverage: signed(t.delta.coverage_pts) + " points", dDead: signed(t.delta.dead_zones),
               dLatency: t.delta.mean_latency_ms === null ? "n/a" : signed(t.delta.mean_latency_ms) + " ms", dThroughput: t.delta.mean_throughput_mbps === null ? "n/a" : signed(t.delta.mean_throughput_mbps) + " Mbps" };
    });
  }

  /** Rows of the mesh table, one metric per row and one topology per column: [metric, ...values]. */
  function meshRows(mesh) {
    var cols = topologyColumns(mesh);
    function row(label, pick) { return [label].concat(cols.map(pick)); }
    return [row("Coverage", function (c) { return c.coverage; }), row("Coverage change", function (c) { return c.dCoverage; }),
            row("Dead zones", function (c) { return c.dead; }), row("Dead zone change", function (c) { return c.dDead; }),
            row("Mean Wi-Fi delay", function (c) { return c.latency; }), row("Delay change", function (c) { return c.dLatency; }),
            row("Mean speed", function (c) { return c.throughput; }), row("Speed change", function (c) { return c.dThroughput; }),
            row("Grade", function (c) { return c.grade + " (" + c.score + ")"; }),
            row("Mesh nodes", function (c) { return c.nodes.length ? c.nodes.join("; ") : "none"; })];
  }

  /** Rows of the Time Machine table from timeMachine(): rank, label, coverage, dead zones, delay, grade and deltas against the first item. */
  function timeMachineRows(tm) {
    return tm.items.map(function (it, i) {
      var d = it.delta;
      return [String(it.rank), String.fromCharCode(65 + i) + ": " + it.label, pct(it.coverage_pct), String(it.dead_zones), ms(it.mean_latency_ms), it.grade + " (" + it.score + ")",
              i === 0 ? "baseline" : signed(d.coverage_pts) + " points coverage, " + signed(d.dead_zones) + " dead zones, " + (d.mean_latency_pct === null ? "delay n/a" : "delay " + signed(d.mean_latency_pct) + "%") + ", score " + signed(d.score) + ", grade " + d.grade_change];
    });
  }

  /**
   * One Smart Home check row per room: Coverage, Bandwidth, Reliability. `clients` is analytics.clients of the floor (or null). A client belongs
   * to the room that contains it (placeName). Bandwidth compares the demand of the clients with what the capacity model delivers.
   */
  function smartHomeRows(floor, gamer, clients, placeName) {
    var entries = clients ? clients.clients : [], byId = {};
    (floor.clients || []).forEach(function (c) { byId[c.id] = c; });
    return gamer.rooms.map(function (r) {
      var mine = entries.filter(function (e) { var c = byId[e.id]; return c && placeName(floor, c.x, c.y) === r.name; });
      var coverage = r.coverage_pct >= 90 ? "OK" : r.coverage_pct >= 60 ? "Weak" : "Poor";
      var demand = mine.reduce(function (s, e) { return s + e.demand_mbps; }, 0), got = mine.reduce(function (s, e) { return s + e.delivered_mbps; }, 0);
      var bandwidth = !mine.length ? "No devices here" : mine.every(function (e) { return e.satisfied; }) ? "OK: " + mine.length + " device" + (mine.length === 1 ? "" : "s") + " need " + Math.round(demand * 10) / 10 + " Mbps"
        : "Short: " + mine.filter(function (e) { return !e.satisfied; }).length + " of " + mine.length + " not served (" + Math.round(got * 10) / 10 + " of " + Math.round(demand * 10) / 10 + " Mbps)";
      var reliability = r.loss_risk === "Low" ? "OK: low packet loss risk" : r.loss_risk + " packet loss risk";
      return { room: r.name, coverage: coverage + " (" + pct(r.coverage_pct) + ")", bandwidth: bandwidth, reliability: reliability,
               text: r.name + ": coverage " + coverage + ", bandwidth " + bandwidth + ", reliability " + reliability };
    });
  }

  /**
   * Store operations for a change object (move_ap, set_channels, add_mesh_node, add_ap) as the optimiser and insight code describe them.
   * `S` is PlannerState. Throws when the access point no longer exists. Defaults for power and band come from rf-config planner.*.
   */
  function changeOps(S, project, floorId, change, config) {
    var floor = S.findFloor(project, floorId), pc = config.planner;
    if (change.kind === "move_ap") {
      var owner = project.floors.filter(function (f) { return f.aps.some(function (a) { return a.id === change.ap_id; }); })[0];
      if (!owner) { throw new Error("access point " + change.ap_id + " no longer exists"); }
      return [S.setOp("ap", project, owner.id, change.ap_id, { x: change.x, y: change.y })];
    }
    if (change.kind === "set_channels") {
      return change.assignments.map(function (a) {
        var home = project.floors.filter(function (f) { return f.aps.some(function (x) { return x.id === a.ap_id; }); })[0];
        if (!home) { throw new Error("access point " + a.ap_id + " no longer exists"); }
        return S.setOp("ap", project, home.id, a.ap_id, { channel: a.channel });
      });
    }
    if (change.kind === "add_mesh_node" || change.kind === "add_ap") {
      var all = [];
      project.floors.forEach(function (f) { all = all.concat(f.aps); });
      var item = { id: S.nextId(all, change.kind === "add_ap" ? "ap" : "mesh"), x: change.x, y: change.y,
                   tx_dbm: change.tx_dbm !== undefined ? change.tx_dbm : pc.default_tx_dbm, band: change.band || pc.default_band };
      if (change.parent_ap_id) { item.mesh_parent = change.parent_ap_id; }
      var op = S.addOp("ap", project, floorId, item);
      op.index = floor.aps.length;
      return [op];
    }
    throw new Error("cannot apply change kind " + change.kind);
  }

  /** Wave tuning for a quality level: ray count from signal_waves.rays_by_quality, falling back to medium. */
  function waveRays(cfg, quality) { return cfg.rays_by_quality[QUALITIES.indexOf(quality) >= 0 ? quality : "medium"]; }

  /**
   * Accumulated wall loss (dB) from an access point along `rays` evenly spaced directions, sampled every sample_step_m out to max_radius_m.
   * loss[r][k] is the engine wallLoss from the AP to the point at distance (k + 1) * step on ray r, so it counts the walls and openings crossed.
   * `RF` is rf-engine, `prep` its prepareFloor() result.
   */
  function rayLosses(RF, env, prep, ap, rays, cfg) {
    var steps = Math.floor(cfg.max_radius_m / cfg.sample_step_m), out = [];
    for (var r = 0; r < rays; r++) {
      var a = 2 * Math.PI * r / rays, cos = Math.cos(a), sin = Math.sin(a), row = new Float32Array(steps);
      for (var k = 0; k < steps; k++) {
        var d = (k + 1) * cfg.sample_step_m;
        row[k] = RF.wallLoss(env, prep, ap.x, ap.y, ap.x + d * cos, ap.y + d * sin);
      }
      out.push(row);
    }
    return out;
  }

  /** Brightness 0..1 of a ring of radius `radius` on a ray with the given loss row: falls with wall loss and with distance. */
  function ringAlpha(row, radius, cfg) {
    var k = Math.min(row.length - 1, Math.max(0, Math.round(radius / cfg.sample_step_m) - 1));
    var byWalls = Math.max(0, 1 - row[k] / cfg.fade_loss_db), byDistance = Math.max(0, 1 - radius / cfg.distance_fade_m);
    return byWalls * byDistance;
  }

  /** Ring radii (metres) at time t seconds: rings leave the AP every ring_spacing_m, at most max_rings, none beyond max_radius_m. */
  function ringRadii(cfg, t) {
    var phase = (t * cfg.speed_m_per_s) % cfg.ring_spacing_m, out = [];
    for (var k = 0; k < cfg.max_rings; k++) {
      var radius = phase + k * cfg.ring_spacing_m;
      if (radius > 0.1 && radius <= cfg.max_radius_m) { out.push(radius); }
    }
    return out;
  }

  // ================================================================== DOM wiring
  function mount(app) {
    var P = root.PlannerPanels, S = root.PlannerState, RF = root.RFEngine, I = root.RFInsight, O = root.RFOptimizer, H = root.PlannerHeat, doc = root.document;
    var el = P.el, button = P.button, table = P.table;
    var demo = !!root.WALLHACK_DEMO;
    function $(id) { return doc.getElementById(id); }
    function now() { return root.performance && root.performance.now ? root.performance.now() : Date.now(); }
    function later(fn) { return root.setTimeout(fn, 0); }
    function clone(o) { return JSON.parse(JSON.stringify(o)); }
    function reducedMotion() { return !!(root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches); }
    function quality() { return root.WallhackCommon && root.WallhackCommon.getQuality ? root.WallhackCommon.getQuality() : "medium"; }
    function floorId() { return app.store.floorId; }
    function insightOpts() { return { config: app.config, mode: app.settings.mode, band: app.settings.band || undefined }; }
    function currentProject() { return S.computeProject(app.store.project); }
    function showGhost(point, label) {
      var st = app.panels && app.panels.state;
      if (st) { st.ghost = point ? { x: point.x, y: point.y, label: label } : null; }
      app.editor.invalidate();
    }
    function applyChange(change, label) {
      var ops = changeOps(S, app.store.project, floorId(), change, app.config);
      q.pending = q.card && !q.dirty ? { label: label, card: q.card } : q.pending;
      q.compare = null;
      app.store.exec({ label: label, ops: ops });
      showGhost(null);
      app.say(label + ". Undo with Ctrl+Z.");
    }
    function gradeChip(grade) { return el("span", { class: "grade-chip " + gradeClass(grade), text: grade }); }

    var q = { token: 0, res: null, card: null, gamer: null, placement: null, answer: null, floor: null, ready: false, ms: null, dirty: false, analysedOnce: false, timer: 0 };
    app.quick = { state: q };
    /** Inputs of the Wi-Fi assessment PDF and CSV from the latest analysis of the current floor (mesh and Time Machine only when they were run on it). */
    app.quick.assessmentData = function () {
      if (!q.card || !q.gamer || q.floor !== floorId()) { throw new Error("run Analyse on this floor first, the assessment needs its result"); }
      return { project: app.store.project.name, floor: app.currentFloor().name, date: new Date().toISOString().slice(0, 10), card: q.card, gamer: q.gamer, answer: q.answer, placement: q.placement,
               mesh: mesh.result && mesh.floor === floorId() ? mesh.result : null, timeMachine: tm.result && tm.floor === floorId() ? tm.result : null };
    };
    function exportButtons() {
      return el("p", { class: "tool-row" }, [button("Download wifi_assessment.pdf", function () { app.exportRun("assessment"); }, { "data-quick": "pdf", title: "Grade, rooms, diagnosis and fixes as a PDF that stays on this device" }),
        button("Print or save as PDF", function () { app.exportRun("print"); }, { "data-quick": "print", title: "Uses the browser print dialog" })]);
    }

    // ---------------------------------------------------------------- Quick start card
    var card = $("quick");
    var tplSel = $("quickTemplate"), tplNote = $("quickTemplateNote"), goBtn = $("quickAnalyse"), status = $("quickStatus"), progress = $("quickProgress"), result = $("quickResult");
    var templates = [];
    tplSel.appendChild(el("option", { value: "", text: "Keep my current plan" }));
    function loadTemplates() {
      if (!root.fetch) { return; }
      root.fetch(app.assetUrl("scenarios.json")).then(function (r) { if (!r.ok) { throw new Error("scenarios.json returned " + r.status); } return r.json(); })
        .then(function (data) {
          templates = data.scenarios;
          templates.forEach(function (t) { tplSel.appendChild(el("option", { value: t.id, text: t.name })); });
          app.quick.templatesReady = true;
        }).catch(function (e) { tplNote.textContent = "Templates could not be loaded (" + e.message + "). You can still analyse your own plan."; });
    }
    tplSel.addEventListener("change", function () {
      var t = templates.filter(function (x) { return x.id === tplSel.value; })[0];
      tplNote.textContent = t ? t.description : "Uses the plan on screen.";
    });

    function setStatus(text, busy, fraction) {
      status.textContent = text;
      progress.hidden = !busy;
      if (busy) { progress.value = fraction; }
      goBtn.disabled = !!busy;
      card.setAttribute("aria-busy", String(!!busy));
    }

    function runAnalysis() {
      var token = ++q.token, t0 = now(), fid = floorId(), opts = insightOpts(), project = currentProject();
      q.ready = false; q.dirty = false; result.removeAttribute("data-ready");
      setStatus("Analysing your WiFi...", true, 0.1);
      function alive() { return token === q.token; }
      later(function () {
        if (!alive()) { return; }
        try {
          var res = I.analyze(project, fid, opts), o2 = Object.assign({}, opts, { result: res });
          q.res = res; q.card = I.scoreCard(project, fid, o2); q.gamer = I.gamerMode(project, fid, o2); q.floor = fid; q.placement = null; q.answer = null;
          renderResult(); renderTabs();
        } catch (e) { setStatus("The analysis failed: " + e.message, false); return; }
        setStatus("Looking for the best router spot...", true, 0.5);
        later(function () {
          if (!alive()) { return; }
          try { q.placement = I.placementReport(project, fid, opts); } catch (e) { q.placement = null; q.placementError = e.message; }
          renderResult();
          setStatus("Checking the weakest room...", true, 0.8);
          later(function () {
            if (!alive()) { return; }
            var worst = worstRoom(q.gamer);
            if (worst) { ask(questionFor(worst.name), true); }
            q.ms = Math.round(now() - t0); q.ready = true; q.analysedOnce = true;
            q.compare = q.pending && q.card ? beforeAfterModel(q.pending.card, q.card, q.pending.label) : null;
            q.pending = null;
            result.setAttribute("data-ready", "true"); result.setAttribute("data-ms", String(q.ms));
            setStatus("Done in " + q.ms + " ms. Model estimate, not a measurement.", false);
            renderResult();
          });
        });
      });
    }

    function analyseClicked() {
      var t = templates.filter(function (x) { return x.id === tplSel.value; })[0];
      if (t) {
        if (app.store.canUndo() && root.confirm && !root.confirm("Replace the current project with the " + t.name + " template? Export it first if you want to keep it.")) { return; }
        app.loadProject(clone(t.project));
        app.notice(t.description + " " + t.learn, "note");
        tplSel.value = "";   // the template is now the plan on screen, so further runs analyse it without reloading
        tplNote.textContent = "Loaded the " + t.name + " template.";
      }
      runAnalysis();
    }
    goBtn.addEventListener("click", analyseClicked);

    // result block
    function renderResult() {
      result.textContent = "";
      if (!q.card) { return; }
      var m = resultModel(q.card), box = el("div", { class: "q-result" });
      result.className = q.dirty ? "q-stale" : "";
      var head = el("div", { class: "q-head" }, [
        el("div", { class: "q-grade " + m.gradeClass, role: "img", "aria-label": m.gradeLabel, text: m.grade }),
        el("div", { class: "q-head-text" }, [el("p", { class: "q-line", text: m.headline }),
          el("div", { class: "q-chips" }, m.stats.map(function (s) { return el("span", { class: "chip", text: s.label + ": " + s.value }); })
            .concat(m.chips.map(function (c) { return el("span", { class: "chip", text: c.text }); })))])]);
      if (q.compare) { box.appendChild(compareBlock(q.compare)); }
      box.appendChild(head);
      if (q.dirty) { box.appendChild(el("p", { class: "banner note", role: "note", text: "The plan changed after this result. It refreshes in a moment." })); }
      // rooms
      box.appendChild(el("h3", { text: "Your rooms, for gaming" }));
      box.appendChild(roomTable(q.gamer));
      // top diagnosis
      if (q.answer) {
        box.appendChild(el("h3", { text: "What is hurting your WiFi most" }));
        var d = el("div", { class: "q-diag" }); renderAnswer(d, q.answer); box.appendChild(d);
      }
      // best spot
      box.appendChild(el("h3", { text: "Best router spot" }));
      if (q.placement) { box.appendChild(bestSpotBlock(q.placement)); }
      else { box.appendChild(el("p", { class: "muted", text: q.placementError ? "No router spot could be computed: " + q.placementError : "Searching..." })); }
      box.appendChild(el("p", { class: "tool-row" }, [button("See signal against interference", function () {
        app.setView({ layer: "interference" }); app.tabs.select("layers", true); app.say("Showing the signal and interference layers");
      }, { id: "quickInterference", title: "Opens the Layers tab, where signal and interference can be compared side by side" })]));
      box.appendChild(exportButtons());
      box.appendChild(el("p", { class: "muted hint", text: q.card.label }));
      result.appendChild(box);
    }

    function compareBlock(c) {
      var wrap = el("section", { class: "q-compare q-compare-" + c.direction, id: "quickCompare", "aria-label": "Before and after the fix" });
      wrap.appendChild(el("h3", { text: "Before and after your fix" }));
      wrap.appendChild(el("p", { class: "muted", text: c.label }));
      function side(name, g) { return el("span", { class: "q-side", "aria-hidden": "true" }, [el("span", { class: "q-grade q-grade-sm " + g.gradeClass, text: g.grade }), el("span", { class: "muted", text: name + ": " + Math.round(g.score) + " of 100" })]); }
      wrap.appendChild(el("div", { class: "q-compare-grades", role: "img", "aria-label": c.gradeText }, [side("Before", c.before), el("span", { class: "q-arrow", "aria-hidden": "true", text: "\u2192" }), side("After", c.after)]));
      wrap.appendChild(el("p", { class: "q-line", id: "quickCompareLine", text: c.verdict }));
      wrap.appendChild(el("ul", { class: "q-lines" }, c.rows.map(function (r) {
        return el("li", { text: r.name + ": " + (r.changed ? r.before + " to " + r.after : r.after + " (same)") });
      }).concat([el("li", { text: "Coverage: " + pct(c.coverage.before) + " to " + pct(c.coverage.after) + ". Dead zones: " + c.dead.before + " to " + c.dead.after })])));
      wrap.appendChild(el("p", { class: "muted hint", text: ESTIMATE + ". Undo with Ctrl+Z to compare again." }));
      return wrap;
    }

    function roomTable(gamer, caption) {
      var rows = roomRows(gamer).map(function (r) { return [r.name, r.coverage, r.ping, r.loss, el("span", { class: "grade-chip " + r.gradeClass, text: r.grade, role: "img", "aria-label": "grade " + r.grade }), r.score]; });
      return table((caption || "Rooms") + ": ping range, packet loss risk and stability grade (" + ESTIMATE + ", no standard RSSI to ping formula)", ["Room", "Coverage", "Ping range", "Packet loss risk", "Gaming grade", "Stability"], rows);
    }

    function bestSpotBlock(report) {
      var m = bestSpotModel(report), wrap = el("div", { class: "q-best" });
      wrap.appendChild(el("p", { class: "q-line", id: "quickBestLine", text: m.line }));
      wrap.appendChild(el("p", { class: "muted", text: m.detail }));
      if (m.extra) { wrap.appendChild(el("p", { class: "muted", text: m.extra })); }
      var row = el("div", { class: "tool-row" });
      row.appendChild(button("Show", function () { showGhost(m.position, "best spot"); app.editor.centerOn(m.position.x, m.position.y); app.say("Showing the best router spot on the plan"); },
        { id: "quickShow", "aria-label": "Show the best router spot on the plan" }));
      row.appendChild(button("Apply", function () { try { applyChange(m.change, m.change.kind === "add_ap" ? "Add a router at the best spot" : "Move the router to the best spot"); } catch (e) { app.say("Cannot apply: " + e.message); } },
        m.canApply ? { id: "quickApply", "aria-label": "Apply the best router spot. You can undo it." } : { id: "quickApply", disabled: "" }));
      wrap.appendChild(row);
      return wrap;
    }

    // ---------------------------------------------------------------- questions (Quick start and Assistant tab share one answer)
    var hosts = [];   // {out, chips} blocks that show the latest answer
    function renderAnswer(host, d) {
      var a = answerModel(d);
      host.textContent = "";
      host.appendChild(el("h3", { text: a.title }));
      var ul = el("ul", { class: "q-lines" });
      a.lines.forEach(function (t) { ul.appendChild(el("li", { text: t })); });
      host.appendChild(ul);
      if (a.rooms.length) {
        host.appendChild(el("div", { class: "q-chips" }, a.rooms.map(function (n) { return button(n, function () { ask(questionFor(n)); }, { class: "q-chip" }); })));
      }
      a.fixes.forEach(function (f) {
        var row = el("div", { class: "tool-row" });
        if (f.point) { row.appendChild(button("Show fix " + f.rank, function () { showGhost(f.point, "fix " + f.rank); }, { "aria-label": "Show fix " + f.rank + " on the plan" })); }
        if (f.point || APPLICABLE.indexOf(f.change.kind) >= 0) {
          row.appendChild(button("Apply fix " + f.rank, function () { try { applyChange(f.change, "Fix " + f.rank + ": " + f.line); } catch (e) { app.say("Cannot apply: " + e.message); } }, { "aria-label": "Apply fix " + f.rank + ". You can undo it." }));
        }
        host.appendChild(row);
      });
    }

    function ask(text, quiet) {
      var clean = String(text || "").trim();
      if (!clean) { app.say("Type a question first, for example: Why is my bedroom WiFi slow?"); return; }
      var d;
      try { d = I.diagnose(currentProject(), floorId(), clean, insightOpts()); }
      catch (e) { app.say("The assistant could not answer: " + e.message); return; }
      q.answer = d; q.question = clean;
      hosts.forEach(function (h) { renderAnswer(h.out, d); });
      if (!quiet && q.card) { renderResult(); }
      return d;
    }
    app.quick.ask = ask;

    function chipRow(host, onPick) {
      host.textContent = "";
      questionChips(app.currentFloor(), 6).forEach(function (c) { host.appendChild(button(c.text, function () { onPick(c.text); }, { class: "q-chip" })); });
    }
    var askIn = $("quickAsk"), chipsHost = $("quickChips"), answerHost = $("quickAnswer");
    hosts.push({ out: answerHost });
    $("quickAskForm").addEventListener("submit", function (e) { e.preventDefault(); ask(askIn.value); });
    function refreshChips() { chipRow(chipsHost, function (t) { askIn.value = t; ask(t); }); if (asst) { chipRow(asst.chips, function (t) { asst.input.value = t; ask(t); }); } }

    // ---------------------------------------------------------------- tabs
    var tabs = {
      rooms: app.tabs.add("rooms", "Rooms and gaming"), score: app.tabs.add("scorecard", "Score card"), assistant: app.tabs.add("assistant", "Assistant"),
      mesh: app.tabs.add("mesh", "Mesh"), time: app.tabs.add("timemachine", "Time Machine")
    };
    function needAnalysis(host, why) {
      host.textContent = "";
      host.appendChild(el("p", { class: "muted", text: why || "Press Analyse my WiFi in the Quick start card first." }));
      host.appendChild(button("Analyse my WiFi", function () { analyseClicked(); }, { class: "tab-analyse" }));
    }

    // Rooms and gaming
    function renderRooms() {
      var host = tabs.rooms; host.textContent = "";
      if (!q.gamer || q.floor !== floorId()) { needAnalysis(host); return; }
      host.appendChild(el("p", { class: "banner note", role: "note", text: q.gamer.note }));
      host.appendChild(roomTable(q.gamer, "All rooms"));
      var grid = el("div", { class: "room-cards" });
      roomRows(q.gamer).forEach(function (r) {
        grid.appendChild(el("article", { class: "room-card", "aria-label": r.text }, [
          el("h3", {}, [r.name + " ", gradeChip(r.grade)]),
          el("dl", { class: "kv" }, [el("dt", { text: "Ping" }), el("dd", { text: r.ping }), el("dt", { text: "Jitter" }), el("dd", { text: r.jitter }),
            el("dt", { text: "Packet loss risk" }), el("dd", { text: r.loss }), el("dt", { text: "Coverage" }), el("dd", { text: r.coverage }), el("dt", { text: "Stability" }), el("dd", { text: r.score + " out of 100" })])]));
      });
      host.appendChild(grid);
      host.appendChild(el("h3", { text: "Smart Home check" }));
      var f = app.currentFloor(), clients = q.res.analytics.clients || null;
      host.appendChild(el("p", { class: "muted hint", text: (f.clients || []).length ? app.config.client_devices.label + ". Bandwidth comes from the capacity model." : "No Smart Home devices on this floor yet. Add a doorbell, camera, speaker, thermostat, robot vacuum, TV or console under Smart Home clients to see bandwidth checks." }));
      var rows = smartHomeRows(f, q.gamer, clients, I.placeName);
      host.appendChild(table("Smart Home check per room (" + ESTIMATE + ", capacity model)", ["Room", "Coverage", "Bandwidth", "Reliability"], rows.map(function (r) { return [r.room, r.coverage, r.bandwidth, r.reliability]; })));
    }

    // Score card
    function renderScore() {
      var host = tabs.score; host.textContent = "";
      if (!q.card || q.floor !== floorId()) { needAnalysis(host); return; }
      var m = resultModel(q.card), c = q.card, w = app.config.insight.score_card.weights;
      host.appendChild(el("div", { class: "q-head" }, [el("div", { class: "q-grade " + m.gradeClass, role: "img", "aria-label": m.gradeLabel, text: m.grade }),
        el("div", { class: "q-head-text" }, [el("p", { class: "q-line", text: m.headline }), el("p", { class: "muted", text: "Score " + c.score + " out of 100." })])]));
      var comp = [["Coverage", "coverage", c.coverage_pct + "% of the floor has a usable signal"], ["Dead zones", "dead_zones", c.dead_zones + " dead zone" + (c.dead_zones === 1 ? "" : "s") + ", " + c.dead_zone_area_m2 + " square metres"],
        ["Signal quality", "sinr", c.mean_sinr_db === null ? "no SINR (give an access point a WiFi standard)" : "mean SINR " + c.mean_sinr_db + " dB"], ["Gaming, streaming and calls", "activities", "area weighted ratings below"]];
      host.appendChild(table("How the grade is built (weights are planning preferences, not physics)", ["Part", "Weight", "Result", "What it means"],
        comp.map(function (x) { return [x[0], Math.round(100 * w[x[1]]) + "%", Math.round(100 * c.components[x[1]]) + " of 100", x[2]]; })));
      host.appendChild(table("Ratings", ["Activity", "Rating", "Score"], [["Gaming", c.ratings.gaming.word + " (grade " + c.ratings.gaming.grade + ")", c.ratings.gaming.score], ["Streaming", c.ratings.streaming.word, c.ratings.streaming.score], ["Video calls", c.ratings.video.word, c.ratings.video.score]]));
      host.appendChild(table("Rooms", ["Room", "Coverage", "Ping", "Gaming", "Streaming", "Video calls"],
        c.rooms.map(function (r) { return [r.name, pct(r.coverage_pct), pingText(r.ping_ms), r.gaming_grade, r.streaming, r.video]; })));
      host.appendChild(exportButtons());
      host.appendChild(el("p", { class: "muted hint", text: c.label }));
    }

    // Assistant
    var asst = null;
    (function buildAssistant() {
      var host = tabs.assistant, input = el("input", { type: "text", id: "asstInput", "aria-label": "Ask about your WiFi", placeholder: "Why is my bedroom WiFi slow?", autocomplete: "off", maxlength: "160" });
      var out = el("div", { id: "asstAnswer", "aria-live": "polite" }), chips = el("div", { class: "q-chips", "aria-label": "Suggested questions" });
      var form = el("form", { class: "q-ask", id: "asstForm" }, [el("label", { for: "asstInput", text: "Ask about a room" }), input, el("button", { type: "submit", text: "Ask" })]);
      form.addEventListener("submit", function (e) { e.preventDefault(); ask(input.value); });
      host.appendChild(el("p", { class: "muted", text: "Plain questions about one room, for example: Why is my bedroom WiFi slow? Answers use the same model as the heat map and test each fix with a second run. " + ESTIMATE + "." }));
      host.appendChild(form); host.appendChild(chips); host.appendChild(out);
      var extras = el("div", { id: "asstExtras" });
      host.appendChild(extras);
      asst = { input: input, chips: chips, out: out, extras: extras };
      hosts.push({ out: out });
      var rephrase = el("div", { id: "asstRephrase", "aria-live": "polite" });
      if (!demo) {
        extras.appendChild(button("Explain in plain words", function () { explainAnswer(rephrase, false); }, { id: "asstExplain", title: "Sends only the numbers above to the local server. Optional." }));
        extras.appendChild(el("p", { class: "muted hint", text: "Optional. Uses the configured LLM if there is one (UNVERIFIED here: no LLM was available to test), otherwise a rule-based text. Only the numbers shown are sent." }));
      } else { extras.appendChild(el("p", { class: "muted hint", text: "The static demo has no server, so answers are rule-based text built from the model numbers." })); }
      extras.appendChild(rephrase);
    })();
    function explainAnswer(out, confirm) {
      if (!q.answer) { out.textContent = "Ask a question first."; return; }
      var body = I.assistantPayload(q.answer); if (confirm) { body.confirm_off_device = true; }
      out.textContent = "Asking...";
      root.fetch("/api/planner/explain", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
        .then(function (r) {
          out.textContent = "";
          if (r.status === 409) { out.appendChild(el("p", { text: r.body.detail })); out.appendChild(button("Send the numbers to the cloud provider", function () { explainAnswer(out, true); })); return; }
          if (r.status !== 200) { out.appendChild(el("p", { text: "Could not explain: " + (typeof r.body.detail === "string" ? r.body.detail : "request refused") })); return; }
          out.appendChild(el("p", { class: "muted hint", text: (r.body.source === "llm" ? "Reworded by " + r.body.provider + (r.body.off_device ? " (off-device)" : " (on this machine)") : "Rule-based text (no LLM used)") + ". " + r.body.note }));
          r.body.explanation.split("\n").forEach(function (line) { out.appendChild(el("p", { text: line })); });
        }).catch(function (e) { out.textContent = "Could not explain: " + e.message; });
    }

    // Mesh
    var mesh = { token: 0, result: null, floor: null };
    function renderMesh() {
      var host = tabs.mesh; host.textContent = "";
      host.appendChild(el("p", { class: "muted", text: "Compares your single router with one extra mesh node and with a whole-home mesh. Coverage and dead zones come from the engine. Speed and delay include an assumed wireless backhaul cost per hop. " + ESTIMATE + "." }));
      var msg = el("p", { class: "muted", role: "status", id: "meshStatus" });
      host.appendChild(el("div", { class: "tool-row" }, [button("Compare mesh options", function () { runMesh(msg); }, { id: "meshRun" })]));
      host.appendChild(msg);
      if (mesh.result && mesh.floor === floorId()) { drawMesh(host, mesh.result); }
    }
    function runMesh(msg) {
      var token = ++mesh.token, t0 = now();
      msg.textContent = "Comparing three layouts...";
      later(function () {
        if (token !== mesh.token) { return; }
        try { mesh.result = I.meshTopologies(currentProject(), floorId(), insightOpts()); mesh.floor = floorId(); }
        catch (e) { msg.textContent = "The comparison failed: " + e.message; return; }
        renderMesh();
        $("meshStatus").textContent = "Done in " + Math.round(now() - t0) + " ms.";
      });
    }
    function drawMesh(host, m) {
      var cols = topologyColumns(m);
      host.appendChild(table("Mesh topologies side by side (" + ESTIMATE + ")", ["Measure"].concat(cols.map(function (c) { return c.label; })), meshRows(m)));
      host.appendChild(el("p", { class: "muted hint", text: m.assumptions.note }));
      var row = el("div", { class: "tool-row" });
      cols.forEach(function (c, i) {
        var first = m.topologies[i].nodes[0];
        if (first) { row.appendChild(button("Show nodes of " + c.label, function () { showGhost(first, "mesh node"); }, { "aria-label": "Show the first mesh node of " + c.label + " on the plan" })); }
      });
      host.appendChild(row);
    }

    // Time Machine
    var tm = { slots: ["current", "preset:" + (app.config.insight.time_machine.presets[0] || {}).id, "preset:" + (app.config.insight.time_machine.presets[1] || {}).id, ""], result: null, floor: null, wipeWith: 1, wipe: 50, token: 0 };
    function tmOptions() {
      var opts = [["current", "Current plan"]];
      (app.store.project.scenarios || []).forEach(function (s) { opts.push(["scenario:" + s.id, "Saved scenario: " + s.name]); });
      app.config.insight.time_machine.presets.forEach(function (p) { opts.push(["preset:" + p.id, "What if: " + p.label]); });
      return opts;
    }
    function renderTime() {
      var host = tabs.time; host.textContent = "";
      host.appendChild(el("p", { class: "muted", text: "Compare up to four versions of your WiFi: your plan, saved scenarios and what-if upgrades. A is the baseline. The old two-scenario compare is still in the Scenarios tab. " + ESTIMATE + "." }));
      var tmCfg = app.config.insight.time_machine, opts = tmOptions(), selects = [];
      var row = el("div", { class: "tool-row" });
      for (var i = 0; i < tmCfg.max_items; i++) {
        (function (i) {
          var sel = el("select", { id: "tmSlot" + i, "aria-label": "Version " + String.fromCharCode(65 + i) + (i >= tmCfg.min_items ? " (optional)" : "") });
          if (i >= tmCfg.min_items) { sel.appendChild(el("option", { value: "", text: "None" })); }
          opts.forEach(function (o) { sel.appendChild(el("option", { value: o[0], text: o[1] })); });
          sel.value = opts.some(function (o) { return o[0] === tm.slots[i]; }) ? tm.slots[i] : (i >= tmCfg.min_items ? "" : opts[0][0]);
          sel.addEventListener("change", function () { tm.slots[i] = sel.value; });
          selects.push(sel);
          row.appendChild(el("label", { class: "inline" }, [String.fromCharCode(65 + i) + " ", sel]));
        })(i);
      }
      host.appendChild(row);
      var msg = el("p", { class: "muted", role: "status", id: "tmStatus" });
      host.appendChild(el("div", { class: "tool-row" }, [button("Compare versions", function () { tm.slots = selects.map(function (s) { return s.value; }); runTime(msg); }, { id: "tmRun" })]));
      host.appendChild(msg);
      tm.out = el("div", { id: "tmOut" }); host.appendChild(tm.out);
      if (tm.result && tm.floor === floorId()) { drawTime(); }
    }
    function runTime(msg) {
      var token = ++tm.token, t0 = now(), project = currentProject(), fid = floorId(), opts = insightOpts();
      var picks = tm.slots.filter(function (s) { return s; });
      if (picks.length < app.config.insight.time_machine.min_items) { msg.textContent = "Choose at least two different versions."; return; }
      if (picks.filter(function (s, i) { return picks.indexOf(s) === i; }).length !== picks.length) { msg.textContent = "Each version must be different."; return; }
      msg.textContent = "Comparing " + picks.length + " versions...";
      later(function () {
        if (token !== tm.token) { return; }
        try {
          var pool = I.scenarioItems(project).concat(picks.some(function (p) { return p.indexOf("preset:") === 0; }) ? I.presetItems(project, fid, opts) : []);
          var items = picks.map(function (id) { var it = pool.filter(function (x) { return x.id === id; })[0]; if (!it) { throw new Error("version '" + id + "' is not available"); } return it; });
          tm.items = items; tm.result = I.timeMachine(items, Object.assign({ floorId: fid }, opts)); tm.floor = fid;
          tm.heat = items.map(function (it) { return I.analyze(it.project, fid, { config: app.config, mode: opts.mode, band: opts.band }); });
        } catch (e) { msg.textContent = "The comparison failed: " + e.message; return; }
        msg.textContent = "Done in " + Math.round(now() - t0) + " ms.";
        drawTime();
      });
    }
    function heatImage(res) {
      var cv = doc.createElement("canvas"); cv.width = res.cols; cv.height = res.rows;
      var c = cv.getContext("2d"), img = c.createImageData(res.cols, res.rows), pal = app.paletteId || "classic";
      for (var i = 0; i < res.cols * res.rows; i++) { var col = H.colorAt(pal, res.grids.rssi[i]); img.data[i * 4] = col[0]; img.data[i * 4 + 1] = col[1]; img.data[i * 4 + 2] = col[2]; img.data[i * 4 + 3] = 215; }
      c.putImageData(img, 0, 0);
      return cv;
    }
    function drawPlan(canvas, imgs, res, label, wipePct) {
      var floor = RF.findFloor(res.project, res.floorId), dpr = root.devicePixelRatio || 1, w = canvas.clientWidth || 260, h = Math.round(w * floor.depth_m / floor.width_m);
      canvas.style.height = h + "px"; canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      var c = canvas.getContext("2d"), sc = w / floor.width_m;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.fillStyle = root.getComputedStyle(doc.documentElement).getPropertyValue("--bg").trim() || "#080b12"; c.fillRect(0, 0, w, h);
      function layer(img, r, x0, x1) {
        c.save(); c.beginPath(); c.rect(x0, 0, x1 - x0, h); c.clip(); c.imageSmoothingEnabled = true; c.drawImage(img, 0, 0, w, h);
        var f = RF.findFloor(r.project, r.floorId);
        c.strokeStyle = "#cbd5e1"; c.lineWidth = 1.5; c.beginPath();
        f.walls.forEach(function (wl) { c.moveTo(wl.x1 * sc, wl.y1 * sc); c.lineTo(wl.x2 * sc, wl.y2 * sc); });
        c.stroke(); c.fillStyle = "#a78bfa";
        f.aps.forEach(function (ap) { c.beginPath(); c.arc(ap.x * sc, ap.y * sc, 4, 0, Math.PI * 2); c.fill(); });
        c.restore();
      }
      if (wipePct === undefined) { layer(imgs[0], res, 0, w); }
      else { var x = w * wipePct / 100; layer(imgs[0], res, 0, x); layer(imgs[1], imgs[2], x, w); c.fillStyle = "#fff"; c.fillRect(x - 1, 0, 2, h); }
      c.fillStyle = "rgba(0,0,0,.55)"; c.fillRect(4, 4, Math.min(w - 8, label.length * 6.6 + 10), 18); c.fillStyle = "#fff"; c.font = "12px system-ui, sans-serif"; c.fillText(label, 9, 17);
      c.fillStyle = "#fbbf24"; c.fillText("MODEL ESTIMATE", 6, h - 7);
    }
    function drawTime() {
      var out = tm.out; out.textContent = "";
      var r = tm.result;
      out.appendChild(table("Versions against A (" + ESTIMATE + ")", ["Rank", "Version", "Coverage", "Dead zones", "Wi-Fi delay", "Grade (score)", "Change against A"], timeMachineRows(r)));
      var best = r.items.filter(function (it) { return it.rank === 1; })[0];
      out.appendChild(el("p", { class: "plan-sum", role: "status", text: "Best score: " + best.label + " (grade " + best.grade + ", " + best.score + ")." }));
      var thumbs = el("div", { class: "tm-thumbs" });
      tm.heat.forEach(function (res, i) {
        var cv = el("canvas", { class: "tm-canvas", role: "img", "aria-label": "Heat map of version " + String.fromCharCode(65 + i) + ", " + r.items[i].label + ". Coverage " + r.items[i].coverage_pct + " percent, " + r.items[i].dead_zones + " dead zones. Text equivalent is in the table." });
        thumbs.appendChild(el("figure", { class: "tm-fig" }, [cv, el("figcaption", { text: String.fromCharCode(65 + i) + ": " + r.items[i].label })]));
        tm.heat[i].img = heatImage(res);
        root.requestAnimationFrame(function () { drawPlan(cv, [tm.heat[i].img], res, String.fromCharCode(65 + i) + ": " + r.items[i].label); });
      });
      out.appendChild(thumbs);
      // wipe viewer between A and another version
      var other = el("select", { id: "tmWipeWith", "aria-label": "Compare version A with" });
      r.items.forEach(function (it, i) { if (i > 0) { other.appendChild(el("option", { value: String(i), text: String.fromCharCode(65 + i) + ": " + it.label })); } });
      other.value = String(Math.min(tm.wipeWith, r.items.length - 1));
      var slider = el("input", { type: "range", min: "0", max: "100", value: String(tm.wipe), id: "tmWipe", "aria-label": "Wipe position: left shows version A, right shows the chosen version" });
      var wipeCv = el("canvas", { class: "tm-wipe", id: "tmWipeCanvas", role: "img", "aria-label": "Wipe comparison of version A and the chosen version. Text equivalent is in the table." });
      function redraw() { var i = parseInt(other.value, 10); tm.wipeWith = i; tm.wipe = parseInt(slider.value, 10); drawPlan(wipeCv, [tm.heat[0].img, tm.heat[i].img, tm.heat[i]], tm.heat[0], "A | " + String.fromCharCode(65 + i), tm.wipe); }
      other.addEventListener("change", redraw); slider.addEventListener("input", redraw);
      out.appendChild(el("h3", { text: "Wipe between versions" }));
      out.appendChild(el("div", { class: "tool-row" }, [el("label", { class: "inline" }, ["Compare A with ", other])]));
      out.appendChild(wipeCv); out.appendChild(slider);
      root.requestAnimationFrame(redraw);
    }

    app.tabs.onSelect("rooms", renderRooms); app.tabs.onSelect("scorecard", renderScore); app.tabs.onSelect("assistant", function () { refreshChips(); });
    app.tabs.onSelect("mesh", renderMesh); app.tabs.onSelect("timemachine", renderTime);
    function renderTabs() {
      refreshChips();
      [["rooms", renderRooms], ["scorecard", renderScore]].forEach(function (p) { if (!$("panel-" + p[0]).hidden) { p[1](); } });
    }

    // ---------------------------------------------------------------- the plan changed
    app.store.subscribe(function (ev) {
      if (ev.source === "select" || ev.source === "meta") { return; }
      waves.cache = null;
      if (ev.source === "floor") { refreshChips(); renderTabs(); return; }
      if (ev.source === "load") { q.token++; q.card = q.gamer = q.res = q.placement = q.answer = null; q.ready = false; q.dirty = false; q.analysedOnce = false; q.pending = null; q.compare = null; mesh.result = null; tm.result = null; result.textContent = ""; setStatus("", false); refreshChips(); renderTabs(); return; }
      if (!q.analysedOnce) { refreshChips(); return; }
      q.dirty = true; q.ready = false; result.removeAttribute("data-ready"); renderResult();
      root.clearTimeout(q.timer); q.timer = root.setTimeout(function () { runAnalysis(); }, 700);
    });

    // ---------------------------------------------------------------- Find best spot for this router (AP tool)
    var findBtn = $("findSpotBtn"), findOut = $("findSpotOut");
    findBtn.addEventListener("click", function () {
      var f = app.currentFloor(), sel = app.store.selection && app.store.selection.ap, ap = f.aps.filter(function (a) { return a.id === sel; })[0] || f.aps[0];
      findOut.textContent = "Searching positions...";
      later(function () {
        var report;
        try { report = I.placementReport(currentProject(), f.id, Object.assign({}, insightOpts(), ap ? { apId: ap.id } : {})); }
        catch (e) { findOut.textContent = "Could not search: " + e.message; return; }
        var m = bestSpotModel(report);
        findOut.textContent = "";
        findOut.appendChild(el("span", { id: "findSpotLine", text: (ap ? ap.id + ": " : "") + m.line + ". " }));
        findOut.appendChild(button("Show", function () { showGhost(m.position, "best spot"); }, { id: "findSpotShow", "aria-label": "Show the best spot on the plan" }));
        findOut.appendChild(button("Apply", function () { try { applyChange(m.change, "Move the router to the best spot"); findOut.textContent = "Applied. Undo with Ctrl+Z."; } catch (e) { findOut.textContent = "Cannot apply: " + e.message; } },
          m.canApply ? { id: "findSpotApply" } : { id: "findSpotApply", disabled: "" }));
        showGhost(m.position, "best spot");
      });
    });

    // ---------------------------------------------------------------- Signal waves (an illustration drawn on the plan)
    var wc = app.config.signal_waves, toggle = $("tgWaves");
    var waves = { on: false, cache: null, raf: 0, t0: 0, last: 0, rays: null, cost: [], tier: null };
    function waveCache(floor, rays) {
      if (waves.cache && waves.cache.floor === floor.id && waves.cache.rays === rays) { return waves.cache; }
      var env = RF.makeEnv(app.config, app.store.project.materials), cache = { floor: floor.id, rays: rays, aps: [] };
      floor.aps.forEach(function (ap) {
        var band = ap.band || app.settings.band || app.config.planner.default_band, prep = RF.prepareFloor(env, floor, band);
        cache.aps.push({ x: ap.x, y: ap.y, losses: rayLosses(RF, env, prep, ap, rays, wc) });
      });
      waves.cache = cache;
      return cache;
    }
    function raysNow() {
      var base = waveRays(wc, quality()), tier = waves.tier;
      return tier !== null && tier < base ? tier : base;
    }
    app.overlay(function (c, view, floor) {
      if (!waves.on || !floor || !floor.aps.length) { return; }
      var t0 = now(), rays = raysNow(), cache = waveCache(floor, rays), t = reducedMotion() ? 0 : (t0 - waves.t0) / 1000, radii = ringRadii(wc, t);
      if (reducedMotion()) { radii = [wc.ring_spacing_m, 2 * wc.ring_spacing_m, 3 * wc.ring_spacing_m]; }   // one still frame, no animation
      var s = view.scale, ox = view.ox, oy = view.oy;
      c.save(); c.beginPath(); c.rect(ox, oy, floor.width_m * s, floor.depth_m * s); c.clip();
      c.lineWidth = Math.max(1.5, 0.09 * s); c.lineCap = "round";
      cache.aps.forEach(function (ap) {
        radii.forEach(function (R) {
          var buckets = [[], [], [], []];
          for (var i = 0; i < rays; i++) {
            var a = ringAlpha(ap.losses[i], R, wc), b = Math.min(buckets.length - 1, Math.floor(a * buckets.length));
            if (a <= 0.03) { continue; }
            var a0 = 2 * Math.PI * i / rays, a1 = 2 * Math.PI * (i + 1) / rays;
            buckets[b].push([a0, a1]);
          }
          buckets.forEach(function (segs, b) {
            if (!segs.length) { return; }
            c.strokeStyle = "rgba(94,234,212," + (0.18 + 0.2 * b).toFixed(2) + ")"; c.beginPath();
            segs.forEach(function (sg) { c.moveTo(ox + (ap.x + R * Math.cos(sg[0])) * s, oy + (ap.y + R * Math.sin(sg[0])) * s); c.lineTo(ox + (ap.x + R * Math.cos(sg[1])) * s, oy + (ap.y + R * Math.sin(sg[1])) * s); });
            c.stroke();
          });
        });
      });
      c.restore();
      // frame budget: if drawing is slow, use fewer rays (never fewer than the low setting)
      waves.cost.push(now() - t0);
      if (waves.cost.length >= 20) {
        var avg = waves.cost.reduce(function (x, y) { return x + y; }, 0) / waves.cost.length; waves.cost = [];
        if (avg > wc.frame_budget_ms && rays > waveRays(wc, "low")) { waves.tier = Math.max(waveRays(wc, "low"), Math.floor(rays / 2)); waves.cache = null; }
      }
    });
    function tick() {
      waves.raf = 0;
      if (!waves.on || reducedMotion() || doc.hidden) { return; }
      app.editor.invalidate();
      waves.raf = root.requestAnimationFrame(tick);
    }
    function setWaves(on, persist) {
      waves.on = !!on; toggle.checked = waves.on; waves.t0 = now(); waves.tier = null; waves.cost = [];
      if (persist) { try { root.localStorage.setItem("wallhack.waves", waves.on ? "on" : "off"); } catch (e) { /* storage unavailable */ } }
      if (waves.raf) { root.cancelAnimationFrame(waves.raf); waves.raf = 0; }
      app.editor.invalidate();
      if (waves.on && !reducedMotion() && !doc.hidden) { waves.raf = root.requestAnimationFrame(tick); }
    }
    toggle.addEventListener("change", function () { setWaves(toggle.checked, true); app.say(toggle.checked ? (reducedMotion() ? "Signal waves on, shown still because reduced motion is on" : "Signal waves on") : "Signal waves off"); });
    doc.addEventListener("visibilitychange", function () { if (waves.on) { if (doc.hidden) { if (waves.raf) { root.cancelAnimationFrame(waves.raf); waves.raf = 0; } } else if (!waves.raf && !reducedMotion()) { waves.raf = root.requestAnimationFrame(tick); } } });
    var saved = null;
    try { saved = root.localStorage.getItem("wallhack.waves"); } catch (e) { /* storage unavailable */ }
    setWaves(saved ? saved === "on" : (!reducedMotion() && quality() !== "low"), false);
    app.quick.waves = waves; app.quick.setWaves = function (on) { setWaves(on, false); };

    loadTemplates(); refreshChips(); renderRooms(); renderScore(); renderMesh(); renderTime();
    app.quick.analyse = function () { analyseClicked(); };
  }

  var api = { mount: mount, resultModel: resultModel, roomRows: roomRows, worstRoom: worstRoom, questionFor: questionFor, questionChips: questionChips, bestSpotModel: bestSpotModel, beforeAfterModel: beforeAfterModel,
              answerModel: answerModel, topologyColumns: topologyColumns, meshRows: meshRows, timeMachineRows: timeMachineRows, smartHomeRows: smartHomeRows,
              changeOps: changeOps, waveRays: waveRays, rayLosses: rayLosses, ringAlpha: ringAlpha, ringRadii: ringRadii, gradeClass: gradeClass };
  if (isNode) { module.exports = api; }
  root.PlannerQuick = api;
})(typeof self !== "undefined" ? self : this);
