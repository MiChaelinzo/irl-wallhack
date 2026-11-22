"use strict";
// Shared by tools/perf_rf.js (node) and tools/perf_rf_browser.py (headless Chromium): a seeded stress
// floor and the measurements behind docs/perf-rf.md. Nothing here is used by the app itself.
(function (root) {
  var FLOOR_W = 100, FLOOR_D = 60, SCALE_DEPTH = 100, WALLS = 1000, GRID_M = 0.5;
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
  function stressProject(seed, apCount, walls, depthM) {
    var rnd = mulberry(seed), list = [], n = walls || WALLS, FLOOR_H = depthM || FLOOR_D;
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
            var cells = Math.ceil(FLOOR_W / cell) * Math.ceil(FLOOR_D / cell);
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

  // ---------------------------------------------------------------- bench-local wall indexes (not used by the app)
  var QUAD_LEAF_ITEMS = 8, QUAD_MAX_DEPTH = 8, QUAD_PAD_M = 1e-6;

  /** Region quadtree over padded wall boxes. A wall is listed in every leaf its box overlaps, like the engine's uniform grid. */
  function buildQuadtree(walls, w, h) {
    function overlaps(n, b) { return b.x0 <= n.x1 && b.x1 >= n.x0 && b.y0 <= n.y1 && b.y1 >= n.y0; }
    function insert(n, ids, depth) {
      n.items = ids;
      if (ids.length <= QUAD_LEAF_ITEMS || depth >= QUAD_MAX_DEPTH) { return; }
      var mx = (n.x0 + n.x1) / 2, my = (n.y0 + n.y1) / 2;
      n.kids = [[n.x0, n.y0, mx, my], [mx, n.y0, n.x1, my], [n.x0, my, mx, n.y1], [mx, my, n.x1, n.y1]].map(function (c) {
        var kid = { x0: c[0], y0: c[1], x1: c[2], y1: c[3], items: null, kids: null };
        insert(kid, ids.filter(function (i) { return overlaps(kid, boxes[i]); }), depth + 1);
        return kid;
      });
      n.items = null;
    }
    var boxes = walls.map(function (k) {
      return { x0: Math.min(k.x1, k.x2) - QUAD_PAD_M, x1: Math.max(k.x1, k.x2) + QUAD_PAD_M, y0: Math.min(k.y1, k.y2) - QUAD_PAD_M, y1: Math.max(k.y1, k.y2) + QUAD_PAD_M };
    });
    var root = { x0: 0, y0: 0, x1: w, y1: h, items: null, kids: null };
    insert(root, walls.map(function (_, i) { return i; }), 0);
    return { root: root, seen: new Int32Array(walls.length), stamp: 0 };
  }

  /** Uniform grid over padded wall boxes with the engine's cell size rule (config.engine.spatial_index) and a DDA traversal. */
  function buildUniformGrid(walls, w, h, idxCfg) {
    var cs = Math.max(idxCfg.min_cell_m, Math.sqrt(w * h * idxCfg.target_walls_per_cell / walls.length)), cols = Math.max(1, Math.ceil(w / cs)), rows = Math.max(1, Math.ceil(h / cs)), cells = [];
    function at(v, n) { return Math.min(n - 1, Math.max(0, Math.floor(v / cs))); }
    for (var i = 0; i < cols * rows; i++) { cells.push([]); }
    walls.forEach(function (k, n) {
      var c0 = at(Math.min(k.x1, k.x2) - idxCfg.bbox_pad_m, cols), c1 = at(Math.max(k.x1, k.x2) + idxCfg.bbox_pad_m, cols);
      var r0 = at(Math.min(k.y1, k.y2) - idxCfg.bbox_pad_m, rows), r1 = at(Math.max(k.y1, k.y2) + idxCfg.bbox_pad_m, rows);
      for (var r = r0; r <= r1; r++) { for (var c = c0; c <= c1; c++) { cells[r * cols + c].push(n); } }
    });
    return { cs: cs, cols: cols, rows: rows, cells: cells, at: at, seen: new Int32Array(walls.length), stamp: 0 };
  }

  function gridCandidates(g, px, py, qx, qy, out) {
    g.stamp++; out.length = 0;
    function visit(c, r) {
      if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) { return; }
      var cell = g.cells[r * g.cols + c];
      for (var i = 0; i < cell.length; i++) { if (g.seen[cell[i]] !== g.stamp) { g.seen[cell[i]] = g.stamp; out.push(cell[i]); } }
    }
    var cx = g.at(px, g.cols), cy = g.at(py, g.rows), ex = g.at(qx, g.cols), ey = g.at(qy, g.rows), dx = qx - px, dy = qy - py;
    var stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1;
    var tMaxX = dx !== 0 ? ((dx > 0 ? (cx + 1) * g.cs - px : px - cx * g.cs) / Math.abs(dx)) : Infinity;
    var tMaxY = dy !== 0 ? ((dy > 0 ? (cy + 1) * g.cs - py : py - cy * g.cs) / Math.abs(dy)) : Infinity;
    var tDx = dx !== 0 ? g.cs / Math.abs(dx) : Infinity, tDy = dy !== 0 ? g.cs / Math.abs(dy) : Infinity;
    for (var s = 0, guard = g.cols + g.rows + 4; s < guard; s++) {
      visit(cx, cy);
      if (cx === ex && cy === ey) { break; }
      if (tMaxX < tMaxY) { cx += stepX; tMaxX += tDx; }
      else if (tMaxY < tMaxX) { cy += stepY; tMaxY += tDy; }
      else { visit(cx + stepX, cy); visit(cx, cy + stepY); cx += stepX; cy += stepY; tMaxX += tDx; tMaxY += tDy; }
    }
    return out;
  }

  function segmentMeetsBox(n, px, py, dx, dy) {   // slab test on the parameter range [0, 1]
    var t0 = 0, t1 = 1, lo = [n.x0, n.y0], hi = [n.x1, n.y1], p = [px, py], d = [dx, dy];
    for (var a = 0; a < 2; a++) {
      if (d[a] === 0) { if (p[a] < lo[a] || p[a] > hi[a]) { return false; } continue; }
      var ta = (lo[a] - p[a]) / d[a], tb = (hi[a] - p[a]) / d[a];
      t0 = Math.max(t0, Math.min(ta, tb)); t1 = Math.min(t1, Math.max(ta, tb));
      if (t0 > t1) { return false; }
    }
    return true;
  }

  function quadCandidates(tree, px, py, qx, qy, out) {
    tree.stamp++; out.length = 0;
    var dx = qx - px, dy = qy - py;
    (function walk(n) {
      if (!segmentMeetsBox(n, px, py, dx, dy)) { return; }
      if (n.kids) { for (var k = 0; k < 4; k++) { walk(n.kids[k]); } return; }
      for (var i = 0; i < n.items.length; i++) { if (tree.seen[n.items[i]] !== tree.stamp) { tree.seen[n.items[i]] = tree.stamp; out.push(n.items[i]); } }
    })(tree.root);
    return out;
  }

  /**
   * Basic-mode RSSI grid with the same arithmetic as rf-engine.js (no openings, no antenna pattern), wall candidates from
   * `pick(px, py, qx, qy)`: all walls (local brute force) or a quadtree query.
   */
  function localGrid(config, floor, ap, cellM, pick) {
    var band = config.bands["2.4"], eps = config.engine.parallel_epsilon, minD = config.engine.min_distance_m, W = floor.walls;
    var cols = Math.max(1, Math.ceil(floor.width_m / cellM)), rows = Math.max(1, Math.ceil(floor.depth_m / cellM)), out = new Float32Array(cols * rows), i = 0;
    var mats = config.materials, lens = W.map(function (k) { return Math.hypot(k.x2 - k.x1, k.y2 - k.y1); });
    var loss = W.map(function (k) { return mats[k.material].attenuation_db["2.4"]; });
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var x = (c + 0.5) * cellM, y = (r + 0.5) * cellM, rx = x - ap.x, ry = y - ap.y, total = 0, list = pick(ap.x, ap.y, x, y);
        for (var j = 0; j < list.length; j++) {
          var n = list[j], w = W[n], sx = w.x2 - w.x1, sy = w.y2 - w.y1, denom = rx * sy - ry * sx;
          if (Math.abs(denom) < eps) { continue; }
          var t = ((w.x1 - ap.x) * sy - (w.y1 - ap.y) * sx) / denom, u = ((w.x1 - ap.x) * ry - (w.y1 - ap.y) * rx) / denom;
          if (t >= 0 && t <= 1 && u >= 0 && u <= 1) { total += loss[n]; }
        }
        var d = Math.max(Math.hypot(rx, ry), minD);
        out[i++] = ap.tx_dbm - (band.pl0_db + 10 * band.path_loss_exponent * Math.log10(d)) - total;
      }
    }
    return out;
  }

  /** Cell size that gives at least `points` grid points on a w x h floor. */
  function cellForPoints(points, w, h) { return Math.floor(Math.sqrt(w * h / points) * 10000) / 10000; }

  /**
   * Wall index strategies on a large floor (100 m x 100 m, 1000 walls, `apCount` APs, at least `points` grid points):
   * the engine's uniform grid, the engine's brute force, and bench-local brute force, uniform grid and quadtree on one shared kernel.
   * Index construction is inside the timed region for every indexed strategy (once per AP, like the engine). Each strategy is run 1 + repeat times; the first run is reported as cold, the median of the rest as warm.
   * Also checks that the quadtree grid equals the engine grid (max difference in dB is returned in `parity_db`).
   */
  function indexComparison(deps, opts) {
    var RF = deps.RF, now = deps.now, config = deps.config, repeat = opts.repeat || 5, apCount = opts.apCount || 4;
    var project = stressProject(7, apCount, opts.walls || WALLS, SCALE_DEPTH), floor = project.floors[0], env = RF.makeEnv(config);
    var cell = cellForPoints(opts.points, FLOOR_W, SCALE_DEPTH), ax = RF.gridAxes(floor, cell), buf = [], idxCfg = config.engine.spatial_index;
    var all = floor.walls.map(function (_, i) { return i; });
    var strategies = [
      ["engine uniform grid", function (ap) { return RF.computeApGrid(floor, ap, { env: env, cellM: cell }); }],
      ["engine brute force", function (ap) { return RF.computeApGrid(floor, ap, { env: env, cellM: cell, brute: true }); }],
      ["bench brute force", function (ap) { return localGrid(config, floor, ap, cell, function () { return all; }); }],
      ["bench uniform grid", function (ap) { var g = buildUniformGrid(floor.walls, FLOOR_W, SCALE_DEPTH, idxCfg); return localGrid(config, floor, ap, cell, function (a, b, c, d) { return gridCandidates(g, a, b, c, d, buf); }); }],
      ["bench quadtree", function (ap) { var tree = buildQuadtree(floor.walls, FLOOR_W, SCALE_DEPTH); return localGrid(config, floor, ap, cell, function (a, b, c, d) { return quadCandidates(tree, a, b, c, d, buf); }); }]
    ];
    var grids = {}, rows = [], base = { points: ax.cols * ax.rows, cell_m: cell, aps: apCount, walls: floor.walls.length };
    strategies.forEach(function (s) {
      var times = [];
      for (var k = 0; k < repeat + 1; k++) {
        var t0 = now(); grids[s[0]] = floor.aps.map(s[1]); times.push(now() - t0);
      }
      var warm = times.slice(1);
      rows.push(Object.assign({ group: "index strategies", name: apCount + " AP, " + base.points + " points, " + s[0], median_ms: round1(median(warm)), min_ms: round1(Math.min.apply(null, warm)),
                                max_ms: round1(Math.max.apply(null, warm)), runs: warm.length, cold_ms: round1(times[0]) }, base));
    });
    var ref = grids["engine uniform grid"], parity = 0;
    ["bench quadtree", "bench uniform grid", "bench brute force"].forEach(function (name) {
      grids[name].forEach(function (g, a) { for (var i = 0; i < g.length; i++) { parity = Math.max(parity, Math.abs(g[i] - ref[a][i])); } });
    });
    var gridMs = rows[0].median_ms;
    rows.forEach(function (r) { r.vs_grid = round1(r.median_ms / gridMs); });
    rows.parity_db = parity;
    return rows;
  }

  /**
   * Final result of a full compute through the worker core or a real Web Worker on the large floor: cold (first run
   * after loading) and warm (median of `repeat` later cold-cache reloads). `backend` as in measure().
   */
  function scaleCompute(deps, backend, opts) {
    var State = deps.State, now = deps.now, repeat = opts.repeat || 5, apCount = opts.apCount || 4, id = 100000, waiting = null;
    var cell = cellForPoints(opts.points, FLOOR_W, SCALE_DEPTH), project = State.clone(stressProject(7, apCount, opts.walls || WALLS, SCALE_DEPTH));
    backend.onmessage = function (m) {
      if (!waiting || m.id !== waiting.id) { return; }
      if (!waiting.first && (m.type === "progress" || m.type === "result")) { waiting.first = now() - waiting.t0; }
      if (m.type === "result") { var w = waiting; waiting = null; w.done({ first: w.first, total: now() - w.t0, stats: m.stats }); }
    };
    backend.send({ type: "init", config: deps.config });
    var runs = [], p = Promise.resolve();
    for (var k = 0; k < repeat + 1; k++) {
      p = p.then(function () {
        backend.send({ type: "setProject", project: project, mode: "basic", band: null });
        return new Promise(function (resolve) { id += 1; waiting = { id: id, t0: now(), first: 0, done: resolve }; backend.send({ type: "compute", id: id, floor: "f1", cell_m: cell }); });
      }).then(function (r) { runs.push(r); });
    }
    return p.then(function () {
      var cells = Math.ceil(FLOOR_W / cell) * Math.ceil(SCALE_DEPTH / cell), warm = runs.slice(1), out = [];
      function row(name, key) {
        var v = warm.map(function (r) { return r[key]; });
        out.push({ group: "worker 100k", name: apCount + " AP, " + cells + " points, " + name, median_ms: round1(median(v)), min_ms: round1(Math.min.apply(null, v)), max_ms: round1(Math.max.apply(null, v)),
                   runs: v.length, cold_ms: round1(runs[0][key]) });
      }
      row("first usable frame (coarse pass)", "first"); row("final result", "total");
      return out;
    });
  }

  function table(rows) {
    var lines = ["| Measurement | Case | Median ms | Min | Max | Notes |", "|---|---|---|---|---|---|"];
    rows.forEach(function (r) {
      var notes = [];
      if (r.target_ms) { notes.push("target " + r.target_ms + " ms: " + (r.median_ms <= r.target_ms ? "met" : "MISSED")); }
      if (r.cold_ms !== undefined) { notes.push("cold first run " + r.cold_ms + " ms"); }
      if (r.vs_grid !== undefined) { notes.push(r.vs_grid + "x the engine grid time"); }
      if (r.speedup) { notes.push("brute force is " + r.speedup + "x slower"); }
      if (r.tiles_total) { notes.push(r.tiles_computed + " of " + r.tiles_total + " tiles recomputed"); }
      lines.push("| " + [r.group, r.name, r.median_ms, r.min_ms, r.max_ms, notes.join("; ")].join(" | ") + " |");
    });
    return lines.join("\n");
  }

  var api = { stressProject: stressProject, measure: measure, table: table, indexComparison: indexComparison, scaleCompute: scaleCompute, cellForPoints: cellForPoints, buildQuadtree: buildQuadtree, quadCandidates: quadCandidates };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  root.RFPerf = api;
})(typeof self !== "undefined" ? self : this);
