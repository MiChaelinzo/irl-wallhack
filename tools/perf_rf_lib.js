"use strict";
// Shared by tools/perf_rf.js (node) and tools/perf_rf_browser.py (headless Chromium): a seeded stress
// floor and the measurements behind docs/perf-rf.md. Nothing here is used by the app itself.
(function (root) {
  var FLOOR_W = 100, FLOOR_H = 60, WALLS = 1000, GRID_M = 0.5;
  var AP_SPOTS = [[12, 10], [37, 10], [62, 10], [87, 10], [12, 45], [37, 45], [62, 45], [87, 45]];
  var MATERIALS = ["drywall", "drywall", "drywall", "glass", "wood", "brick", "concrete"];

  function mulberry(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Seeded 100 m x 60 m floor, 1000 axis-aligned walls of 2 to 8 m on a 0.5 m grid, `apCount` access points. */
  function stressProject(seed, apCount, walls) {
    var rnd = mulberry(seed), list = [], n = walls || WALLS;
    function snap(v, hi) { return Math.min(hi, Math.max(0, Math.round(v / GRID_M) * GRID_M)); }
    for (var i = 0; i < n; i++) {
      var len = 2 + Math.floor(rnd() * 13) * 0.5, x = snap(rnd() * FLOOR_W, FLOOR_W), y = snap(rnd() * FLOOR_H, FLOOR_H), horiz = rnd() < 0.5;
      var w = { id: "w" + (i + 1), x1: x, y1: y, x2: horiz ? Math.min(FLOOR_W, x + len) : x, y2: horiz ? y : Math.min(FLOOR_H, y + len), kind: "interior",
                material: MATERIALS[Math.floor(rnd() * MATERIALS.length)] };
      if (w.x1 === w.x2 && w.y1 === w.y2) { w.x2 = Math.min(FLOOR_W, w.x1 + 2); if (w.x1 === w.x2) { w.x1 -= 2; } }
      list.push(w);
    }
    var aps = AP_SPOTS.slice(0, apCount).map(function (p, k) { return { id: "ap" + (k + 1), x: p[0], y: p[1], tx_dbm: 20 }; });
    return { schema_version: 1, name: "perf", units: "m", floors: [{ id: "f1", name: "Stress floor", level: 0, height_m: 2.5, width_m: FLOOR_W, depth_m: FLOOR_H,
      rooms: [], walls: list, openings: [], furniture: [], sensors: [], aps: aps, labels: [] }] };
  }

  function median(a) { var s = a.slice().sort(function (x, y) { return x - y; }); return s[Math.floor(s.length / 2)]; }
  function round1(v) { return Math.round(v * 10) / 10; }

  /**
   * deps: {RF, State, now(), config}. backend: {send(msg), onmessage = fn}. Resolves a table of rows.
   * Each compute is timed from send until the first message (coarse pass) and until the final result.
   */
  function measure(deps, backend, opts) {
    var RF = deps.RF, State = deps.State, now = deps.now, config = deps.config, rows = [], REPEAT = (opts && opts.repeat) || 3, id = 0;
    var waiting = null;
    backend.onmessage = function (m) {
      if (!waiting || m.id !== waiting.id) { return; }
      if (!waiting.first && (m.type === "progress" || m.type === "result")) { waiting.first = now() - waiting.t0; }
      if (m.type === "result") { var w = waiting; waiting = null; w.done({ first: w.first, total: now() - w.t0, result: m }); }
    };
    function compute(cell) {
      return new Promise(function (resolve) {
        id += 1; waiting = { id: id, t0: now(), first: 0, done: resolve };
        backend.send({ type: "compute", id: id, floor: "f1", cell_m: cell });
      });
    }
    function load(project) { backend.send({ type: "setProject", project: project, mode: "basic", band: null }); }
    function add(group, name, values, extra) {
      rows.push(Object.assign({ group: group, name: name, median_ms: round1(median(values)), min_ms: round1(Math.min.apply(null, values)), max_ms: round1(Math.max.apply(null, values)), runs: values.length }, extra || {}));
    }
    function series(n, fn) {   // sequential async repetitions
      var out = [], p = Promise.resolve();
      for (var i = 0; i < n; i++) { (function (k) { p = p.then(function () { return fn(k).then(function (v) { out.push(v); }); }); })(i); }
      return p.then(function () { return out; });
    }
    var chain = Promise.resolve();
    backend.send({ type: "init", config: config });

    [1, 4, 8].forEach(function (apCount) {
      var project = State.clone(stressProject(7, apCount));
      [1.0, 0.5].forEach(function (cell) {
        chain = chain.then(function () {
          return series(REPEAT + 1, function () { load(project); return compute(cell); }).then(function (runs) {
            runs = runs.slice(1);   // first run warms the JIT
            var cells = Math.ceil(FLOOR_W / cell) * Math.ceil(FLOOR_H / cell);
            add("full grid", apCount + " AP, " + cell + " m cells (" + cells + " cells), final result", runs.map(function (r) { return r.total; }), { target_ms: null });
            add("coarse pass", apCount + " AP, " + cell + " m cells, first usable frame", runs.map(function (r) { return r.first; }), { target_ms: apCount === 4 && cell === 0.5 ? 250 : null });
          });
        });
      });
      chain = chain.then(function () {
        load(project);
        return compute(0.5).then(function () {
          return series(REPEAT + 2, function (k) {
            var ap = project.floors[0].aps[0], op = { t: "ap.set", floor: "f1", id: ap.id, before: {}, after: { x: ap.x + (k % 2 ? -3 : 3), y: ap.y } };
            State.applyOp(project, op); backend.send({ type: "update", ops: [op] });
            return compute(0.5);
          });
        }).then(function (runs) {
          runs = runs.slice(2);
          add("AP move", apCount + " AP, 0.5 m cells, first frame", runs.map(function (r) { return r.first; }));
          add("AP move", apCount + " AP, 0.5 m cells, final", runs.map(function (r) { return r.total; }), { tiles_computed: runs[0].result.stats.tiles_computed, tiles_total: runs[0].result.stats.tiles_total });
        });
      });
      chain = chain.then(function () {
        load(project);
        return compute(0.5).then(function () {
          return series(REPEAT + 2, function (k) {
            var w = project.floors[0].walls[10 + k], op = { t: "wall.set", floor: "f1", id: w.id, before: {}, after: { x1: w.x1, y1: w.y1, x2: w.x2 === w.x1 ? w.x2 : (w.x2 > 1 ? w.x2 - 0.5 : w.x2 + 0.5), y2: w.y2 === w.y1 ? w.y2 : (w.y2 > 1 ? w.y2 - 0.5 : w.y2 + 0.5) } };
            State.applyOp(project, op); backend.send({ type: "update", ops: [op] });
            return compute(0.5);
          });
        }).then(function (runs) {
          runs = runs.slice(2);
          add("wall edit", apCount + " AP, 0.5 m cells, final", runs.map(function (r) { return r.total; }), { tiles_computed: runs[0].result.stats.tiles_computed, tiles_total: runs[0].result.stats.tiles_total * apCount });
        });
      });
    });

    // spatial index against brute force: one AP, whole grid, same engine
    [1.0, 0.5].forEach(function (cell) {
      chain = chain.then(function () {
        var project = stressProject(7, 1), floor = project.floors[0], env = RF.makeEnv(config), ap = floor.aps[0], t = [], b = [];
        for (var i = 0; i < 3; i++) {
          var t0 = now(); RF.computeApGrid(floor, ap, { env: env, cellM: cell }); t.push(now() - t0);
          t0 = now(); RF.computeApGrid(floor, ap, { env: env, cellM: cell, brute: true }); b.push(now() - t0);
        }
        add("index vs brute force", "1 AP, " + cell + " m cells, spatial index", t);
        add("index vs brute force", "1 AP, " + cell + " m cells, brute force", b, { speedup: round1(median(b) / median(t)) });
      });
    });
    // tooltip probe
    chain = chain.then(function () {
      var project = stressProject(7, 8), env = RF.makeEnv(config), t = [];
      for (var i = 0; i < 30; i++) { var t0 = now(); RF.probeAt(project, "f1", 10 + i * 2.5, 20 + (i % 5) * 4, { env: env }); t.push(now() - t0); }
      add("hover probe", "8 AP, 1000 walls, one probeAt call", t);
    });
    return chain.then(function () { return rows; });
  }

  function table(rows) {
    var lines = ["| Measurement | Case | Median ms | Min | Max | Notes |", "|---|---|---|---|---|---|"];
    rows.forEach(function (r) {
      var notes = [];
      if (r.target_ms) { notes.push("target " + r.target_ms + " ms: " + (r.median_ms <= r.target_ms ? "met" : "MISSED")); }
      if (r.speedup) { notes.push("brute force is " + r.speedup + "x slower"); }
      if (r.tiles_total) { notes.push(r.tiles_computed + " of " + r.tiles_total + " tiles recomputed"); }
      lines.push("| " + [r.group, r.name, r.median_ms, r.min_ms, r.max_ms, notes.join("; ")].join(" | ") + " |");
    });
    return lines.join("\n");
  }

  var api = { stressProject: stressProject, measure: measure, table: table };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  root.RFPerf = api;
})(typeof self !== "undefined" ? self : this);
