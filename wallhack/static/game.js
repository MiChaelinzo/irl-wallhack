"use strict";
// Apartment WiFi placement game. The RF model runs in Python (wallhack/game.py) and arrives as
// precomputed per-candidate RSSI grids. This file only takes the per-cell maximum, applies the
// threshold and adds up costs. scoreSelection mirrors game.score_selection; tests/test_game_parity.py
// runs both on shared vectors. All signal values are MODEL ESTIMATES in a simulated scenario.
(function (root) {
  // Python round() rounds halves to even; Math.round does not. Used for the integer score.
  function roundHalfEven(v) {
    var f = Math.floor(v), diff = v - f;
    if (diff === 0.5) { return f % 2 === 0 ? f : f + 1; }
    return Math.round(v);
  }
  function round1(v) { return Math.round(v * 10) / 10; }
  function clamp01(v) { return Math.min(1, Math.max(0, v)); }
  function flat(grid) { var out = []; grid.forEach(function (row) { row.forEach(function (v) { out.push(v); }); }); return out; }

  // Strongest signal per cell from the existing router plus the chosen candidates.
  function cellBest(scenario, ids) {
    var best = flat(scenario.base_rssi);
    scenario.candidates.forEach(function (c) {
      if (ids.indexOf(c.id) < 0) { return; }
      var cells = flat(c.rssi);
      for (var i = 0; i < best.length; i++) { best[i] = Math.max(best[i], cells[i]); }
    });
    return best;
  }

  function scoreSelection(scenario, selected) {
    var ids = [];
    selected.forEach(function (id) { if (ids.indexOf(id) < 0) { ids.push(id); } });
    var known = {};
    scenario.candidates.forEach(function (c) { known[c.id] = c; });
    var unknown = ids.filter(function (id) { return !known[id]; });
    if (unknown.length) { throw new Error("unknown candidate ids " + unknown.join(", ")); }
    var best = cellBest(scenario, ids), n = best.length, covered = 0, qualitySum = 0, cost = 0;
    var lo = scenario.quality_range_dbm[0], hi = scenario.quality_range_dbm[1];
    best.forEach(function (v) {
      if (v >= scenario.threshold_dbm) { covered += 1; }
      qualitySum += clamp01((v - lo) / (hi - lo));
    });
    ids.forEach(function (id) { cost += known[id].cost; });
    var coverage = round1(100 * covered / n), quality = round1(100 * qualitySum / n);
    var efficiency = round1(Math.max(0, 100 * (1 - cost / scenario.budget)));
    var w = scenario.weights;
    var score = roundHalfEven(w.coverage * coverage + w.signal_quality * quality + w.cost * efficiency);
    return { selected: ids, coverage_pct: coverage, signal_quality: quality, cost: cost,
             cost_efficiency: efficiency, goal_met: coverage >= scenario.goal_pct, score: score };
  }

  var api = { scoreSelection: scoreSelection, cellBest: cellBest, roundHalfEven: roundHalfEven };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  if (!root || !root.document || !root.Wallhack) { return; }

  // ---- browser UI -------------------------------------------------------------
  var W = root.Wallhack, scenario = null, chosen = [];
  var MARGIN = 20, MARKER_R = 11;
  function $(id) { return root.document.getElementById(id); }
  function css(name) { return root.getComputedStyle(root.document.documentElement).getPropertyValue(name).trim(); }

  function layout(canvas) {
    var f = scenario.floor, k = Math.min((canvas.width - 2 * MARGIN) / f.width_m, (canvas.height - 2 * MARGIN) / f.depth_m);
    return { k: k, x: function (m) { return MARGIN + m * k; }, y: function (m) { return MARGIN + m * k; } };
  }

  function cellColor(v) {
    if (v >= scenario.threshold_dbm) { return css("--ok"); }
    return v >= scenario.threshold_dbm - 10 ? css("--warn") : css("--bad");
  }

  function draw() {
    var canvas = $("gameCanvas"), g = canvas.getContext("2d"), L = layout(canvas), f = scenario.floor, cell = scenario.cell_m;
    var best = cellBest(scenario, chosen);
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.globalAlpha = 0.45;
    best.forEach(function (v, i) {
      g.fillStyle = cellColor(v);
      g.fillRect(L.x((i % scenario.cols) * cell), L.y(Math.floor(i / scenario.cols) * cell), cell * L.k + 1, cell * L.k + 1);
    });
    g.globalAlpha = 1; g.strokeStyle = css("--fg"); g.lineWidth = 2;
    f.walls.forEach(function (w) {
      g.globalAlpha = w.kind === "exterior" ? 1 : 0.6;
      g.beginPath(); g.moveTo(L.x(w.x1), L.y(w.y1)); g.lineTo(L.x(w.x2), L.y(w.y2)); g.stroke();
    });
    g.globalAlpha = 1; g.fillStyle = css("--fg"); g.font = "12px system-ui, sans-serif"; g.textAlign = "center";
    f.rooms.forEach(function (r) { g.fillText(r.name, L.x(r.x + r.w / 2), L.y(r.y + 0.4)); });
    var ap = scenario.existing_ap;
    g.fillStyle = css("--muted"); g.fillRect(L.x(ap.x) - 7, L.y(ap.y) - 7, 14, 14);
    g.fillStyle = css("--fg"); g.fillText("old router", L.x(ap.x), L.y(ap.y) - 12);
    scenario.candidates.forEach(function (c) {
      var on = chosen.indexOf(c.id) >= 0;
      g.beginPath(); g.arc(L.x(c.x), L.y(c.y), MARKER_R, 0, 2 * Math.PI);
      g.fillStyle = on ? css("--accent") : css("--card-solid"); g.fill();
      g.strokeStyle = css("--accent"); g.lineWidth = 2; g.stroke();
      g.fillStyle = on ? "#06121a" : css("--fg"); g.fillText(String(c.cost), L.x(c.x), L.y(c.y) + 4);
    });
    g.textAlign = "left";
  }

  function renderScore() {
    var r = scoreSelection(scenario, chosen), box = $("gameScore");
    box.textContent = "";
    [["Coverage", r.coverage_pct + " %" + (r.goal_met ? " (goal met)" : " (goal " + scenario.goal_pct + " %)")],
     ["Cost", r.cost + " of " + scenario.budget + (r.cost > scenario.budget ? " (over budget)" : "")],
     ["Signal quality", String(r.signal_quality)], ["Score", String(r.score)]].forEach(function (p) {
      var d = root.document.createElement("div"); d.className = "tl-val";
      var l = root.document.createElement("div"); l.className = "label"; l.textContent = p[0];
      var v = root.document.createElement("div"); v.className = "val"; v.textContent = p[1];
      d.appendChild(l); d.appendChild(v); box.appendChild(d);
    });
    draw();
  }

  function toggle(id) {
    var at = chosen.indexOf(id);
    if (at < 0) { chosen.push(id); } else { chosen.splice(at, 1); }
    var btn = $("cand-" + id);
    if (btn) { btn.setAttribute("aria-pressed", String(at < 0)); }
    renderScore();
  }

  function setSelection(ids) {
    chosen = ids.slice();
    scenario.candidates.forEach(function (c) { $("cand-" + c.id).setAttribute("aria-pressed", String(chosen.indexOf(c.id) >= 0)); });
    renderScore();
  }

  function build() {
    $("gameGoal").textContent = "Goal: " + scenario.goal_pct + " % of the apartment above " + scenario.threshold_dbm +
      " dBm. Pick router positions. Each has a cost, and the budget is " + scenario.budget + ". " + scenario.label;
    var row = $("gameCands");
    scenario.candidates.forEach(function (c) {
      var b = root.document.createElement("button");
      b.type = "button"; b.id = "cand-" + c.id; b.textContent = c.label + " (" + c.cost + ")"; b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", function () { toggle(c.id); });
      row.appendChild(b);
    });
    $("gameReset").addEventListener("click", function () { setSelection([]); });
    $("gamePar").addEventListener("click", function () { setSelection(scenario.par.selected); });
    renderScore();
  }

  W.getJson("/api/game/scenario").then(function (s) { scenario = s; build(); })
    .catch(function (e) { $("gameGoal").textContent = "Game unavailable: " + e.message; });
})(typeof window !== "undefined" ? window : null);
