"use strict";
// Educational mode, scenario presets and plain-language explanation for the RF planner.
//  - Pure functions (content validation, lesson checks, lesson solutions, "why is the signal weak",
//    the explain request body) run under node in tests/test_planner_learn.py.
//  - mount(app) adds the "Learn" tab, the contextual learning panel and the preset picker, and hooks an
//    "Explain this plan" button into the Smart planner panel.
// Lessons call the engine (rf-engine.js) for every check, so answers are computed, not hard-coded.
// Everything shown is a MODEL ESTIMATE. Content lives in learn-content.json, presets in scenarios.json.
(function (root) {
  var E = (typeof module !== "undefined" && module.exports) ? require("./rf-engine.js") : root.RFEngine;
  var S = (typeof module !== "undefined" && module.exports) ? require("./planner-state.js") : root.PlannerState;
  var STORAGE_KEY = "wallhack.planner.learn";
  var OPS = { ">=": function (a, b) { return a >= b; }, "<=": function (a, b) { return a <= b; }, "==": function (a, b) { return a === b; } };
  var METRICS = ["rssi_at", "coverage_pct", "dead_zone_pct", "mean_sinr_db", "cochannel_pairs", "setting_band"];
  var SOLUTION_OPS = ["ap.set", "ap.add", "wall.set", "interferer.remove"];

  function fail(msg) { var e = new Error(msg); e.name = "LearnContentError"; return e; }

  // ------------------------------------------------------------------ content
  /**
   * Check the lesson content against the scenario presets. Returns the content when valid, throws otherwise.
   * @param {any} content parsed learn-content.json
   * @param {Array<{id: string, project: any}>} presets validated scenario library
   */
  function validateContent(content, presets) {
    if (!content || content.schema_version !== 1 || !Array.isArray(content.topics) || !Array.isArray(content.lessons)) { throw fail("learn content: expected schema_version 1, topics and lessons"); }
    var topicIds = {}, lessonIds = {};
    content.topics.forEach(function (t, i) {
      ["id", "title", "summary", "try_it", "model_limit"].forEach(function (k) { if (typeof t[k] !== "string" || !t[k]) { throw fail("topics[" + i + "]." + k + ": must be a non-empty text"); } });
      if (topicIds[t.id]) { throw fail("topics[" + i + "]: duplicate id " + t.id); }
      topicIds[t.id] = true;
    });
    content.lessons.forEach(function (l, i) {
      var q = "lessons[" + i + "]";
      ["id", "title", "goal", "limit", "scenario", "floor", "topic"].forEach(function (k) { if (typeof l[k] !== "string" || !l[k]) { throw fail(q + "." + k + ": must be a non-empty text"); } });
      if (lessonIds[l.id]) { throw fail(q + ": duplicate id " + l.id); }
      lessonIds[l.id] = true;
      if (!topicIds[l.topic]) { throw fail(q + ".topic: unknown topic " + l.topic); }
      var preset = presets.filter(function (p) { return p.id === l.scenario; })[0];
      if (!preset) { throw fail(q + ".scenario: unknown scenario " + l.scenario); }
      if (!preset.project.floors.some(function (f) { return f.id === l.floor; })) { throw fail(q + ".floor: unknown floor " + l.floor); }
      if (!Array.isArray(l.steps) || !l.steps.length) { throw fail(q + ".steps: needs at least one step"); }
      l.steps.forEach(function (st, j) {
        var c = st.check;
        if (typeof st.instruction !== "string" || !st.instruction || !c || METRICS.indexOf(c.metric) < 0 || !OPS[c.op]) { throw fail(q + ".steps[" + j + "]: needs an instruction and a check with a known metric and operator"); }
      });
      var sol = l.solution;
      if (!sol || !Array.isArray(sol.ops)) { throw fail(q + ".solution: needs an ops list"); }
      sol.ops.forEach(function (o, j) { if (SOLUTION_OPS.indexOf(o.t) < 0) { throw fail(q + ".solution.ops[" + j + "]: unknown operation " + o.t); } });
    });
    return content;
  }

  // ------------------------------------------------------------------ checks
  /**
   * Value of one metric on the live project.
   * @param {any} project @param {string} floorId
   * @param {any} check lesson check @param {{env:any, settings:{band:(string|null), mode:string}}} ctx
   */
  function metricValue(project, floorId, check, ctx) {
    var st = ctx.settings || {}, band = st.band || undefined, mode = st.mode || "basic";
    if (check.metric === "setting_band") { return st.band || ""; }
    if (check.metric === "rssi_at") { return E.probeAt(project, floorId, check.x, check.y, { env: ctx.env, band: band, mode: mode }).rssi_dbm; }
    var an = E.analyzeFloor(project, floorId, { env: ctx.env, cellM: ctx.cellM || 1, band: band, mode: mode });
    if (check.metric === "coverage_pct") { return an.coverage_pct; }
    if (check.metric === "dead_zone_pct") { return an.dead_zone_pct; }
    if (check.metric === "mean_sinr_db") { return an.sinr ? an.sinr.mean_sinr_db : null; }
    var pairs = 0;
    an.aps.forEach(function (ap) { pairs += ap.cochannel_neighbours.length; });
    return pairs / 2;
  }

  /** {value, pass} for one check. A missing value (for example no SINR) never passes. */
  function evaluateCheck(project, floorId, check, ctx) {
    var v = metricValue(project, floorId, check, ctx);
    return { value: v, pass: v !== null && v !== undefined && OPS[check.op](v, check.value) };
  }

  function evaluateLesson(lesson, project, ctx) {
    return lesson.steps.map(function (st) { var r = evaluateCheck(project, lesson.floor, st.check, ctx); return { instruction: st.instruction, value: r.value, pass: r.pass }; });
  }

  // ------------------------------------------------------------------ solutions
  /** Store operations (undoable) that carry out a lesson solution on `project`. */
  function solutionOps(project, solution) {
    return solution.ops.map(function (o) {
      if (o.t === "ap.set") { return S.setOp("ap", project, o.floor, o.id, o.set); }
      if (o.t === "ap.add") { return S.addOp("ap", project, o.floor, o.ap); }
      if (o.t === "wall.set") { return S.setOp("wall", project, o.floor, o.id, o.set); }
      return S.removeOp("interferer", project, null, o.id);
    });
  }

  // ------------------------------------------------------------------ why is the signal weak here
  var CONTRIBUTIONS = [["distance", "Distance (path loss)", "path_loss_db"], ["walls", "Walls and doors", "walls_loss_db"], ["floors", "Floors crossed", "floor_loss_db"]];

  /**
   * Plain-language reading of a probeAt result made with {explain: true}. Uses only engine numbers.
   * Returns {headline, rows: [{id, label, db}] largest first, lines: [text], weak}.
   */
  function whyWeak(probe, config) {
    var ex = probe.explain;
    if (!ex) { throw new Error("whyWeak needs a probeAt result made with explain: true"); }
    var rows = CONTRIBUTIONS.map(function (c) { return { id: c[0], label: c[1], db: ex[c[2]] || 0 }; }).sort(function (a, b) { return b.db - a.db; });
    var weak = probe.rssi_dbm < config.analytics.weak_dbm, top = rows[0], total = ex.total_loss_db;
    var headline = "Signal here is " + probe.rssi_dbm + " dBm (" + probe.quality + ", " + (weak ? "weak" : "not weak") + "). " +
      (top.db > 0 ? "The largest loss is " + top.label.toLowerCase() + ": " + top.db + " dB of " + total + " dB in total." : "Nothing between the access point and this point removes signal.");
    var lines = ex.text.slice();
    if (ex.sinr) { lines.push("SINR is " + ex.sinr.sinr_db + " dB, which lowers the speed when other transmitters share the air."); }
    return { headline: headline, rows: rows, lines: lines, weak: weak };
  }

  // ------------------------------------------------------------------ explain request
  /**
   * Body for POST /api/planner/explain from a finished Smart planner run: engine numbers and texts only.
   * @param {any} plan worker "plan" result @param {Array<{text:string, confidence:(number|null), reason:string}>} recs
   */
  function payloadFromPlan(plan, recs) {
    var an = plan.analytics, body = { title: "Planner result for floor " + plan.floor,
      metrics: [{ label: "Coverage", value: an.coverage_pct, unit: "%" }, { label: "Dead zone", value: an.dead_zone_pct, unit: "%" },
                { label: "Access points advised in total", value: plan.count.total_aps, unit: "" }],
      issues: plan.issues.slice(0, 10).map(function (i) { return i.text; }), recommendations: [] };
    recs.slice(0, 10).forEach(function (r) {
      var item = { text: r.text, rationale: r.reason };
      if (r.confidence !== null) { item.confidence = r.confidence; }
      body.recommendations.push(item);
    });
    return body;
  }

  /** The topic shown while a control has focus: control id or tool name to topic id. */
  var CONTEXT = { bandSel: "frequencies", modeSel: "propagation", cellSel: "propagation", wallMaterial: "attenuation", palette: "attenuation", voidKind: "attenuation",
                  sourceKind: "interference", cEdit: "rssi", minimap: "rssi" };
  var TOOL_CONTEXT = { door: "attenuation", window: "attenuation", wall: "attenuation", ap: "propagation", void: "attenuation", interferer: "interference" };
  var LAYER_CONTEXT = { rssi: "rssi", snr: "snr", sinr: "sinr", wall_loss: "attenuation", interference: "interference" };

  // ------------------------------------------------------------------ UI
  function mount(app) {
    var P = root.PlannerPanels, doc = root.document, el = P.el, base = app.base || "";
    var demo = !!root.WALLHACK_DEMO;
    var data = { content: null, presets: null, lesson: null, on: false };
    function $(id) { return doc.getElementById(id); }
    function storage() { try { return root.localStorage; } catch (e) { return null; } }
    var panel = app.tabs.add("learn", "Learn");
    var ctxCard = el("section", { class: "card learn-ctx", id: "learnContext", "aria-labelledby": "learnCtxTitle", hidden: "" });
    var aside = doc.querySelector(".p-side"); aside.insertBefore(ctxCard, aside.firstChild);

    function getJson(name) {
      return root.fetch(base + name).then(function (r) { if (!r.ok) { throw new Error(name + " returned " + r.status); } return r.json(); });
    }
    function topic(id) { return data.content.topics.filter(function (t) { return t.id === id; })[0]; }
    function checkCtx() { return { env: app.env, settings: app.settings, cellM: 1 }; }

    // ---- contextual learning panel
    function showTopic(id) {
      if (!data.on || !data.content) { return; }
      var t = topic(id); if (!t) { return; }
      ctxCard.hidden = false; ctxCard.textContent = "";
      ctxCard.appendChild(el("h2", { id: "learnCtxTitle", text: "Learn: " + t.title }));
      ctxCard.appendChild(el("p", { text: t.summary }));
      ctxCard.appendChild(el("p", { class: "muted hint", text: "Try it: " + t.try_it }));
      ctxCard.appendChild(el("p", { class: "muted hint", text: "What the model leaves out: " + t.model_limit }));
    }
    function setLearn(on) {
      data.on = on; doc.body.classList.toggle("learn-on", on);
      $("learnBtn").setAttribute("aria-pressed", String(on)); $("learnBtn").textContent = on ? "Learn: on" : "Learn: off";
      var st = storage(); if (st) { try { st.setItem(STORAGE_KEY, on ? "1" : "0"); } catch (e) { /* storage full or blocked: the toggle still works for this visit */ } }
      if (on) { showTopic(LAYER_CONTEXT[app.view && app.view.layer] || "rssi"); } else { ctxCard.hidden = true; }
      app.say(on ? "Educational mode on" : "Educational mode off");
    }
    function contextFor(target) {
      if (target.dataset && target.dataset.tool && TOOL_CONTEXT[target.dataset.tool]) { return TOOL_CONTEXT[target.dataset.tool]; }
      if (target.id === "layerSel") { return LAYER_CONTEXT[target.value] || "rssi"; }
      var node = target; while (node && node !== doc.body) { if (CONTEXT[node.id]) { return CONTEXT[node.id]; } node = node.parentNode; }
      return null;
    }
    doc.addEventListener("focusin", function (e) { var id = e.target && contextFor(e.target); if (id) { showTopic(id); } });
    doc.addEventListener("change", function (e) { if (e.target && e.target.id === "layerSel") { showTopic(contextFor(e.target)); } });

    // ---- why is the signal weak here
    var whyOut = el("div", { id: "whyOut", "aria-live": "polite" });
    function explainProbe() {
      whyOut.textContent = "";
      var f = app.currentFloor(), pt = app.probe || { x: f.width_m / 2, y: f.depth_m / 2 };
      var r = root.RFEngine.probeAt(app.store.project, f.id, pt.x, pt.y, { env: app.env, band: app.settings.band, mode: app.settings.mode, explain: true });
      if (!r.ap_id) { whyOut.appendChild(el("p", { text: "No access point reaches this point. Add an access point on this floor first." })); return; }
      var w = whyWeak(r, app.config);
      whyOut.appendChild(el("p", { class: "plan-sum", text: "At (" + pt.x.toFixed(1) + " m, " + pt.y.toFixed(1) + " m). " + w.headline }));
      whyOut.appendChild(P.table("Where the signal went (dB lost between the access point and this point)", ["Cause", "Loss"], w.rows.map(function (x) { return [x.label, x.db + " dB"]; })));
      var ul = el("ul"); w.lines.forEach(function (t) { ul.appendChild(el("li", { text: t })); });
      whyOut.appendChild(ul);
      whyOut.appendChild(el("p", { class: "muted hint", text: r.explain.label }));
    }

    // ---- scenario presets
    function loadPreset(id) {
      var p = data.presets.filter(function (x) { return x.id === id; })[0];
      if (!p) { return; }
      if (app.store.canUndo() && !root.confirm("Replace the current project with the " + p.name + " preset? Export it first if you want to keep it.")) { return; }
      app.loadProject(JSON.parse(JSON.stringify(p.project)));
      app.notice(p.description + " " + p.learn, "note"); app.say("Loaded the " + p.name + " preset");
    }
    function mountPicker() {
      var sel = $("presetSel"); sel.appendChild(el("option", { value: "", text: "Choose a preset..." }));
      data.presets.forEach(function (p) { sel.appendChild(el("option", { value: p.id, text: p.name })); });
      $("presetLoad").addEventListener("click", function () { if (sel.value) { loadPreset(sel.value); } else { app.say("Choose a preset first"); } });
    }

    // ---- lessons
    var lessonBox = el("div", { id: "lessonBox" });
    function lessonById(id) { return data.content.lessons.filter(function (l) { return l.id === id; })[0]; }
    function renderLesson() {
      var l = data.lesson; lessonBox.textContent = "";
      if (!l) { lessonBox.appendChild(el("p", { class: "muted", text: "Choose a lesson to start. It loads a starting project, then checks your edits against the engine." })); return; }
      var t = topic(l.topic), results = evaluateLesson(l, app.store.project, checkCtx()), allPass = results.every(function (r) { return r.pass; });
      lessonBox.appendChild(el("h3", { text: l.title }));
      lessonBox.appendChild(el("p", { text: "Goal: " + l.goal }));
      var ol = el("ol", { class: "lesson-steps" });
      results.forEach(function (r) {
        ol.appendChild(el("li", { class: r.pass ? "applied" : "" }, [el("span", { text: r.instruction }), " ",
          el("strong", { class: "lesson-state", text: r.pass ? "Done" : "Not yet" }), el("span", { class: "muted", text: r.value === null || r.value === undefined || r.value === "" ? "" : " (now " + r.value + ")" })]));
      });
      lessonBox.appendChild(ol);
      lessonBox.appendChild(el("p", { class: "plan-sum", role: "status", text: allPass ? "Lesson complete. " + (t ? t.summary : "") : "Make the change on the plan. The checks update as you edit." }));
      lessonBox.appendChild(el("p", { class: "muted hint", text: "What the model leaves out: " + l.limit }));
      lessonBox.appendChild(el("div", { class: "tool-row" }, [
        P.button("Show me", function () { showSolution(l); }, { id: "lessonShow" }),
        P.button("Restart lesson", function () { startLesson(l.id); }, { id: "lessonRestart" })]));
    }
    function startLesson(id) {
      var l = lessonById(id), preset = data.presets.filter(function (p) { return p.id === l.scenario; })[0];
      data.lesson = null;   // the load below fires store events that must not check the old lesson against the new project
      app.loadProject(JSON.parse(JSON.stringify(preset.project)));
      app.store.setFloor(l.floor);
      setBand(null); data.lesson = l; renderLesson(); showTopic(l.topic);
      app.say("Started lesson: " + l.title);
    }
    function setBand(band) { $("bandSel").value = band || ""; $("bandSel").dispatchEvent(new root.Event("change")); }
    function showSolution(l) {
      var sol = l.solution;
      if (sol.ops.length) { app.store.exec({ label: "Lesson: " + l.title, ops: solutionOps(app.store.project, sol) }); }
      if (sol.settings && sol.settings.band) { setBand(sol.settings.band); }
      renderLesson(); app.say("Applied the lesson solution. Undo with Ctrl+Z.");
    }

    // ---- explain button inside the Smart planner panel (live server only)
    function explainWidget(plan, recs) {
      var out = el("div", { id: "explainOut", "aria-live": "polite" }), box = el("div", { id: "explainBox" });
      function ask(confirm) {
        out.textContent = "Asking...";
        var body = payloadFromPlan(plan, recs); if (confirm) { body.confirm_off_device = true; }
        root.fetch("/api/planner/explain", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
          .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
          .then(function (r) {
            out.textContent = "";
            if (r.status === 409) {
              out.appendChild(el("p", { text: r.body.detail }));
              out.appendChild(P.button("Send the numbers to the cloud provider", function () { ask(true); }, { id: "explainConfirm" }));
              return;
            }
            if (r.status !== 200) { out.appendChild(el("p", { text: "Could not explain: " + (typeof r.body.detail === "string" ? r.body.detail : "request refused") })); return; }
            var j = r.body;
            out.appendChild(el("p", { class: "muted hint", text: (j.source === "llm" ? "Reworded by " + j.provider + (j.off_device ? " (off-device)" : " (on this machine)") : "Rule-based text (no LLM used)") + ". " + j.note }));
            j.explanation.split("\n").forEach(function (line) { out.appendChild(el("p", { text: line })); });
            if (j.fallback_reason) { out.appendChild(el("p", { class: "muted hint", text: "Why rules were used: " + j.fallback_reason + "." })); }
          })
          .catch(function (e) { out.textContent = "Could not explain: " + e.message; });
      }
      box.appendChild(el("h3", { text: "Explain this plan" }));
      box.appendChild(el("p", { class: "muted hint", text: "Sends only the numbers above to the server. With no LLM configured you get a deterministic summary. Cloud providers ask for your confirmation first." }));
      box.appendChild(P.button("Explain in plain language", function () { ask(false); }, { id: "explainBtn" }));
      box.appendChild(out);
      return box;
    }
    app.planExtras = function (out, plan, recs) { if (!demo) { out.appendChild(explainWidget(plan, recs)); } };

    // ---- assemble
    function render() {
      panel.textContent = "";
      panel.appendChild(el("p", { class: "banner note", role: "note", text: data.content.label }));
      panel.appendChild(el("div", { class: "tool-row" }, [
        el("label", { class: "inline" }, ["Lesson ", (function () {
          var sel = el("select", { id: "lessonSel", "aria-label": "Lesson" }); sel.appendChild(el("option", { value: "", text: "Choose a lesson..." }));
          data.content.lessons.forEach(function (l) { sel.appendChild(el("option", { value: l.id, text: l.title })); });
          sel.addEventListener("change", function () { if (sel.value) { startLesson(sel.value); } });
          return sel; })()])]));
      panel.appendChild(lessonBox); renderLesson();
      panel.appendChild(el("h3", { text: "Why is the signal weak here?" }));
      panel.appendChild(el("p", { class: "muted hint", text: "Move the probe on the plan, then press the button. The answer uses the engine's explain output for that point." }));
      panel.appendChild(P.button("Explain the probe point", explainProbe, { id: "whyBtn" }));
      panel.appendChild(whyOut);
      panel.appendChild(el("h3", { text: "Topics" }));
      data.content.topics.forEach(function (t) {
        var d = el("details", { class: "learn-topic" }, [el("summary", { text: t.title }), el("p", { text: t.summary }), el("p", { class: "muted hint", text: "Try it: " + t.try_it }),
          el("p", { class: "muted hint", text: "What the model leaves out: " + t.model_limit })]);
        panel.appendChild(d);
      });
    }

    $("learnBtn").addEventListener("click", function () { setLearn(!data.on); });
    app.store.subscribe(function (ev) {
      if (ev.source === "load") { whyOut.textContent = ""; }   // the explanation belonged to the previous project
      if (!data.lesson || ev.source === "select") { return; }
      if (!app.store.project.floors.some(function (f) { return f.id === data.lesson.floor; })) { data.lesson = null; }   // another project was loaded
      renderLesson();
    });
    Promise.all([getJson("learn-content.json"), getJson("scenarios.json")]).then(function (r) {
      data.presets = S.validateScenarioLibrary(r[1], { config: app.config });
      data.content = validateContent(r[0], data.presets);
      render(); mountPicker();
      var st = storage(); if (st && st.getItem(STORAGE_KEY) === "1") { setLearn(true); }
      app.learn = { startLesson: startLesson, loadPreset: loadPreset, presets: data.presets, content: data.content, setLearn: setLearn };
      app.learnReady = true;
    }).catch(function (e) { panel.appendChild(el("p", { class: "banner error", role: "alert", text: "Learning content could not load: " + e.message })); });
  }

  var api = { validateContent: validateContent, metricValue: metricValue, evaluateCheck: evaluateCheck, evaluateLesson: evaluateLesson,
              solutionOps: solutionOps, whyWeak: whyWeak, payloadFromPlan: payloadFromPlan, mount: mount };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  root.PlannerLearn = api;
})(typeof self !== "undefined" ? self : this);
