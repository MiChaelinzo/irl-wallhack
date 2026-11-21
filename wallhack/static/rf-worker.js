"use strict";
// Incremental RF heat-map computation. Runs as a Web Worker (importScripts below) and, when workers are
// unavailable (file://, blocked), the same core runs on the main thread in short time slices.
// MODEL ESTIMATE, not a measurement. Messages in: init, setProject, update, compute, cancel.
// Messages out: ready, progress (coarse then refinements), result, cancelled, error.
// Analysis jobs (analyze, compare, rank, plan, stack) run as a chain of steps with a pause between steps, so a
// newer request or a cancel message takes effect at the next step boundary. Results: analysis, comparison,
// ranking, plan, stack; progress messages carry {job, step, steps, text}.
//
// How it stays fast: the floor is cut into tiles of TILE x TILE cells. Each access point keeps its own
// grid with a per-tile valid flag, once at COARSE_FACTOR x the cell size and once at the requested
// size. Moving or changing an AP replaces only that AP's entry. Editing a wall invalidates only the
// tiles whose (AP to tile) bounding box meets the wall's bounding box, which is conservative because
// in basic mode a ray from the AP to a cell cannot leave that box. Enhanced and multipath modes add
// reflected and diffracted paths that can leave the box, so any wall edit recomputes everything in
// those modes. A new compute request supersedes older ones at the next time-slice boundary.
(function (root) {
  var TILE = 16;                 // cells per tile side
  var COARSE_FACTOR = 4;         // coarse pass uses cells this many times larger
  var SLICE_MS = 8;              // work per time slice before yielding to incoming messages
  var POST_EVERY_MS = 60;        // minimum time between progress messages
  var BOX_PAD_M = 0.05;          // padding on wall boxes in the dirty test

  var inWorker = typeof importScripts === "function" && typeof root.document === "undefined";
  if (inWorker) { root.importScripts("rf-engine.js", "planner-state.js", "rf-optimizer.js"); }

  function Stale() { this.stale = true; }

  /**
   * createCore({RF, State}, post, yieldFn?). `post(message, transferList)` sends results out;
   * the returned object's handle(message) receives requests.
   */
  function createCore(deps, post, hooks) {
    var RF = deps.RF, State = deps.State, Opt = deps.Opt, clock = (hooks && hooks.now) || function () { return Date.now(); };
    var pause = (hooks && hooks.pause) || function () { return new Promise(function (r) { setTimeout(r, 0); }); };
    var config = null, env = null, project = null, matsSig = "{}", mode = "basic", band = null;
    var cache = {};              // "receivingFloor|apFloor|apId" -> entry
    var latestId = -1, cancelled = {}, sliceStart = 0;

    function noSignal() { return config.engine.no_signal_dbm; }

    // ------------------------------------------------------------ geometry of tiles
    function levelOf(floor, cellM) {
      var ax = RF.gridAxes(floor, cellM), tc = Math.ceil(ax.cols / TILE), tr = Math.ceil(ax.rows / TILE);
      return { cellM: cellM, cols: ax.cols, rows: ax.rows, tc: tc, tr: tr, grid: new Float32Array(ax.cols * ax.rows),
               valid: new Uint8Array(tc * tr) };
    }
    function tileRegion(lv, t) {
      var tx = t % lv.tc, ty = Math.floor(t / lv.tc);
      return { c0: tx * TILE, r0: ty * TILE, c1: Math.min(lv.cols, (tx + 1) * TILE), r1: Math.min(lv.rows, (ty + 1) * TILE) };
    }

    // ------------------------------------------------------------ entries (one per AP and receiving floor)
    function apList() {
      var list = [];
      project.floors.forEach(function (f) { f.aps.forEach(function (a) { list.push({ ap: a, floor: f }); }); });
      return list;
    }
    function levelOfFloor(id) { return State.findFloor(project, id).level; }

    function entrySig(e, floor, cellM) {
      var a = e.ap;
      return JSON.stringify([e.floor.id, a.x, a.y, a.tx_dbm, a.band || null, a.channel === undefined ? null : a.channel, mode, band, cellM,
                             floor.width_m, floor.depth_m, Math.abs(e.floor.level - floor.level), matsSig]);
    }

    function refreshEntries(floor, cellM) {
      var wanted = {}, out = [];
      apList().forEach(function (e) {
        var key = floor.id + "|" + e.floor.id + "|" + e.ap.id, sig = entrySig(e, floor, cellM);
        wanted[key] = true;
        var entry = cache[key];
        if (!entry || entry.sig !== sig) {
          entry = cache[key] = { sig: sig, key: key, coarse: levelOf(floor, cellM * COARSE_FACTOR), fine: levelOf(floor, cellM) };
        }
        entry.src = e;
        out.push(entry);
      });
      Object.keys(cache).forEach(function (k) { if (k.indexOf(floor.id + "|") === 0 && !wanted[k]) { delete cache[k]; } });
      return out;
    }

    // ------------------------------------------------------------ dirty tracking
    function invalidateBox(floorId, box) {
      if (mode !== "basic") { cache = pruneFloor(floorId); return; }
      Object.keys(cache).forEach(function (k) {
        var entry = cache[k];
        if (k.indexOf(floorId + "|") !== 0 || !entry.src) { return; }
        var ap = entry.src.ap;
        [entry.coarse, entry.fine].forEach(function (lv) {
          for (var t = 0; t < lv.valid.length; t++) {
            if (!lv.valid[t]) { continue; }
            var r = tileRegion(lv, t);
            var x0 = Math.min(ap.x, r.c0 * lv.cellM) - lv.cellM, x1 = Math.max(ap.x, r.c1 * lv.cellM) + lv.cellM;
            var y0 = Math.min(ap.y, r.r0 * lv.cellM) - lv.cellM, y1 = Math.max(ap.y, r.r1 * lv.cellM) + lv.cellM;
            if (x0 <= box.x1 + BOX_PAD_M && x1 >= box.x0 - BOX_PAD_M && y0 <= box.y1 + BOX_PAD_M && y1 >= box.y0 - BOX_PAD_M) { lv.valid[t] = 0; }
          }
        });
      });
    }
    function pruneFloor(floorId) {
      var next = {};
      Object.keys(cache).forEach(function (k) { if (k.indexOf(floorId + "|") !== 0) { next[k] = cache[k]; } });
      return next;
    }
    function wallOf(floorId, id) {
      var f = State.findFloor(project, floorId), i;
      for (i = 0; i < f.walls.length; i++) { if (f.walls[i].id === id) { return f.walls[i]; } }
      return null;
    }
    function unionBox(a, b) {
      if (!a) { return b; }
      return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
    }

    function applyDelta(ops) {
      ops.forEach(function (op) {
        if (op.t === "mode") { mode = op.mode; return; }
        if (op.t === "band") { band = op.band || null; return; }
        var kind = op.t.split(".")[0], box = null;
        if (kind === "wall") {
          if (op.t === "wall.add" || op.t === "wall.remove") { box = State.wallBox(op.item); }
          else { var old = wallOf(op.floor, op.id); if (old) { box = State.wallBox(old); } }
        }
        State.applyOp(project, op);
        if (kind === "wall") {
          if (op.t === "wall.set") { box = unionBox(box, State.wallBox(wallOf(op.floor, op.id))); }
          if (box) { invalidateBox(op.floor, box); }
        } else if (op.t === "floor.set" && (op.after.width_m !== undefined || op.after.depth_m !== undefined)) {
          cache = pruneFloor(op.floor);
        }
      });
    }

    // ------------------------------------------------------------ time slicing
    function checkpoint(job) {
      if (clock() - sliceStart < SLICE_MS) { return null; }
      return pause().then(function () {
        sliceStart = clock();
        if (job.id !== latestId || cancelled[job.id]) { throw new Stale(); }
      });
    }

    // ------------------------------------------------------------ one request
    function upsample(coarseGrid, clv, fine, c0, r0, c1, r1, out) {
      for (var r = r0; r < r1; r++) {
        var v = ((r + 0.5) * fine.cellM) / clv.cellM - 0.5, j = Math.max(0, Math.min(clv.rows - 1, Math.floor(v))), j2 = Math.min(clv.rows - 1, j + 1);
        var fy = Math.max(0, Math.min(1, v - j));
        for (var c = c0; c < c1; c++) {
          var u = ((c + 0.5) * fine.cellM) / clv.cellM - 0.5, i = Math.max(0, Math.min(clv.cols - 1, Math.floor(u))), i2 = Math.min(clv.cols - 1, i + 1);
          var fx = Math.max(0, Math.min(1, u - i));
          var top = coarseGrid[j * clv.cols + i] * (1 - fx) + coarseGrid[j * clv.cols + i2] * fx;
          var bot = coarseGrid[j2 * clv.cols + i] * (1 - fx) + coarseGrid[j2 * clv.cols + i2] * fx;
          out[r * fine.cols + c] = top * (1 - fy) + bot * fy;
        }
      }
    }

    function mergeInto(entries, lvName, lv, region, out) {
      for (var r = region.r0; r < region.r1; r++) {
        for (var c = region.c0; c < region.c1; c++) {
          var i = r * lv.cols + c, best = noSignal();
          for (var k = 0; k < entries.length; k++) { var v = entries[k][lvName].grid[i]; if (v > best) { best = v; } }
          out[i] = best;
        }
      }
    }

    function stats(grid) {
      var cov = 0, dead = 0, cc = config.analytics.coverage_dbm, dd = config.analytics.dead_zone_dbm;
      for (var i = 0; i < grid.length; i++) { if (grid[i] >= cc) { cov++; } if (grid[i] < dd) { dead++; } }
      return { coverage_pct: 100 * cov / grid.length, dead_zone_pct: 100 * dead / grid.length };
    }

    function computeTile(entry, lvName, floor, cellM, t, prepCache) {
      var lv = entry[lvName], e = entry.src;
      RF.computeApRegion(floor, e.ap, { env: env, cellM: lv.cellM, band: band, mode: mode, floorsApart: Math.abs(e.floor.level - floor.level), prepCache: prepCache },
                         tileRegion(lv, t), lv.grid);
      lv.valid[t] = 1;
    }

    function run(job) {
      var t0 = clock(), floor = State.findFloor(project, job.floor), cellM = job.cell_m;
      var entries = refreshEntries(floor, cellM), prepCache = {}, tilesComputed = 0, lastPost = 0;
      var fine = levelOf(floor, cellM), coarseRef = levelOf(floor, cellM * COARSE_FACTOR);
      var merged = new Float32Array(fine.cols * fine.rows).fill(noSignal()), coarseMerged = new Float32Array(coarseRef.cols * coarseRef.rows);
      var tilesTotal = fine.tc * fine.tr, dirtyAtStart = 0;
      sliceStart = clock();

      function post1(type, extra) {
        var copy = merged.slice();
        var msg = { type: type, id: job.id, floor: job.floor, cols: fine.cols, rows: fine.rows, cell_m: cellM, grid: copy };
        post(Object.assign(msg, extra || {}), [copy.buffer]);
        lastPost = clock();
      }

      // coarse pass: every AP, every invalid coarse tile
      var coarseTiles = [];
      entries.forEach(function (en) { for (var t = 0; t < en.coarse.valid.length; t++) { if (!en.coarse.valid[t]) { coarseTiles.push([en, t]); } } });
      var steps = Promise.resolve();
      var ci = 0;
      function coarseStep() {
        while (ci < coarseTiles.length) {
          var item = coarseTiles[ci++];
          computeTile(item[0], "coarse", floor, cellM * COARSE_FACTOR, item[1], prepCache);
          var wait = checkpoint(job);
          if (wait) { return wait.then(coarseStep); }
        }
        return null;
      }
      steps = steps.then(coarseStep).then(function () {
        var coarseMs = clock() - t0;
        if (entries.length) { mergeInto(entries, "coarse", coarseRef, { c0: 0, r0: 0, c1: coarseRef.cols, r1: coarseRef.rows }, coarseMerged); }
        var dirty = [];
        for (var t = 0; t < tilesTotal; t++) {
          var rg = tileRegion(fine, t), clean = entries.length > 0 && entries.every(function (en) { return en.fine.valid[t]; });
          if (clean) { mergeInto(entries, "fine", fine, rg, merged); }
          else { dirty.push(t); upsample(coarseMerged, coarseRef, fine, rg.c0, rg.r0, rg.c1, rg.r1, merged); }
        }
        dirtyAtStart = dirty.length;
        if (!entries.length) { merged.fill(noSignal()); }
        post1("progress", { stage: "coarse", done: tilesTotal - dirty.length, total: tilesTotal, coarse_ms: coarseMs });
        var di = 0;
        function fineStep() {
          while (di < dirty.length) {
            var t2 = dirty[di++], rg2 = tileRegion(fine, t2);
            entries.forEach(function (en) { if (!en.fine.valid[t2]) { computeTile(en, "fine", floor, cellM, t2, prepCache); tilesComputed++; } });
            mergeInto(entries, "fine", fine, rg2, merged);
            var wait = checkpoint(job);
            if (wait) {
              return wait.then(function () {
                if (clock() - lastPost >= POST_EVERY_MS) { post1("progress", { stage: "fine", done: tilesTotal - dirty.length + di, total: tilesTotal }); }
                return fineStep();
              });
            }
          }
          return null;
        }
        return fineStep();
      }).then(function () {
        var s = stats(merged);
        post1("result", { coverage_pct: s.coverage_pct, dead_zone_pct: s.dead_zone_pct, aps: entries.length, label: "MODEL ESTIMATE, not a measurement",
                          mode: mode, band: band, stats: { ms: clock() - t0, tiles_total: tilesTotal, tiles_dirty: dirtyAtStart, tiles_computed: tilesComputed } });
      });
      return steps;
    }


    // ------------------------------------------------------------ analysis jobs (analytics, compare, rank, plan, stack)
    // Each job is a list of steps {text, run}. A step runs, then the core yields so cancel or a newer job of the same
    // kind is noticed. Results are plain data. All figures are MODEL ESTIMATES.
    var jobLatest = {}, jobCancelled = {};
    function slim(an) { var o = Object.assign({}, an); delete o.throughput_mbps; return o; }
    function flat(rows) { var cols = rows[0] ? rows[0].length : 0, out = new Float32Array(rows.length * cols); rows.forEach(function (r, i) { out.set(r, i * cols); }); return out; }
    function settings(msg) { return { env: env, cellM: msg.cell_m, band: msg.band === undefined ? band : msg.band, mode: msg.mode || mode }; }
    function scoreRow(item, an, cfg) {
      var sc = RF.scoreAnalytics(an, cfg);
      return { id: item.id, name: item.name, score: sc.score, breakdown: sc.breakdown, coverage_pct: an.coverage_pct, avg_rssi_dbm: an.avg_rssi_dbm,
               dead_zone_pct: an.dead_zone_pct, overlap_pct: an.overlap.pct, mean_throughput_mbps: an.mean_throughput_mbps, aps: an.aps.length,
               client_capacity: an.total_client_capacity };
    }

    function buildJob(msg) {
      var steps = [], result = {}, o;
      if (msg.type === "analyze") {
        steps.push({ text: "analysing", run: function () { result = { type: "analysis", floor: msg.floor, analytics: slim(RF.analyzeFloor(project, msg.floor, settings(msg))) }; } });
      } else if (msg.type === "compare") {
        steps.push({ text: "comparing", run: function () {
          o = settings(msg);
          var c = RF.compareScenarios(msg.a, msg.b, { config: config, floorId: msg.floor, cellM: o.cellM, band: o.band, mode: o.mode });
          result = { type: "comparison", floor: msg.floor, cols: c.a.grid.cols, rows: c.a.grid.rows, cell_m: c.a.grid.cell_m, label: c.label,
                     rssi_a: flat(c.a.grid.rssi), rssi_b: flat(c.b.grid.rssi), delta: flat(c.delta_db),
                     a: { analytics: slim(c.a.analytics), score: c.a.score }, b: { analytics: slim(c.b.analytics), score: c.b.score },
                     coverage_delta_pct: c.coverage_delta_pct, mean_rssi_delta_db: c.mean_rssi_delta_db, dead_zone_delta_m2: c.dead_zone_delta_m2,
                     mean_throughput_delta_mbps: c.mean_throughput_delta_mbps, ap_count_delta: c.ap_count_delta, score_delta: c.score_delta };
        } });
      } else if (msg.type === "rank") {
        result = { type: "ranking", floor: msg.floor, rows: [] };
        msg.items.forEach(function (item) {
          steps.push({ text: "scoring " + item.name, run: function () {
            var s = settings(msg), env2 = RF.makeEnv(config, item.project.materials);
            var an = RF.analyzeFloor(item.project, msg.floor, { env: env2, cellM: s.cellM, band: s.band, mode: s.mode });
            result.rows.push(scoreRow(item, an, config));
          } });
        });
        steps.push({ text: "ranking", run: function () { result.rows.sort(function (p, q) { return (q.score - p.score) || (p.name < q.name ? -1 : 1); }); } });
      } else if (msg.type === "stack") {
        result = { type: "stack", floors: [] };
        project.floors.forEach(function (f) {
          steps.push({ text: "analysing " + f.name, run: function () {
            var s = settings(msg), all = RF.analyzeFloor(project, f.id, s);
            var own = State.clone(project); own.floors.forEach(function (g) { if (g.id !== f.id) { g.aps = []; } });
            var alone = RF.analyzeFloor(own, f.id, s);
            result.floors.push({ id: f.id, name: f.name, level: f.level, aps: f.aps.length, coverage_pct: all.coverage_pct, own_coverage_pct: alone.coverage_pct,
                                 avg_rssi_dbm: all.avg_rssi_dbm, dead_zone_pct: all.dead_zone_pct });
          } });
        });
      } else if (msg.type === "plan") {
        if (!Opt) { throw new Error("the smart planner is not loaded (rf-optimizer.js)"); }
        o = settings(msg);
        var po = { env: env, band: o.band, mode: o.mode }, target = msg.target_pct || config.planner.target_coverage_pct, maxAps = msg.max_aps || 12;
        result = { type: "plan", floor: msg.floor, target_pct: target };
        [["finding coverage issues", function () { var r = Opt.detectIssues(project, msg.floor, po); result.issues = r.issues; result.label = r.label; result.analytics = slim(r.analytics); }],
         ["suggesting AP positions", function () { result.placements = Opt.suggestPlacements(project, msg.floor, Object.assign({ targetPct: target }, po)); }],
         ["estimating the AP count", function () { result.count = Opt.recommendApCount(project, msg.floor, target, maxAps, po); }],
         ["checking transmit power", function () { result.power = Opt.detectPowerIssues(project, msg.floor, po); }],
         ["planning channels", function () { result.channels = Opt.planChannels(project, msg.floor, po); }]
        ].forEach(function (s) { steps.push({ text: s[0], run: s[1] }); });
      } else { throw new Error("unknown job type " + msg.type); }
      return { steps: steps, result: function () { return result; } };
    }

    function startJob(msg) {
      var job;
      try { job = buildJob(msg); } catch (e) { post({ type: "error", id: msg.id, job: msg.type, message: String(e && e.message || e) }); return Promise.resolve(); }
      jobLatest[msg.type] = msg.id;
      var i = 0;
      function alive() { return jobLatest[msg.type] === msg.id && !jobCancelled[msg.id]; }
      function next() {
        if (!alive()) { post({ type: "cancelled", id: msg.id, job: msg.type }); return null; }
        if (i >= job.steps.length) { post(Object.assign({ id: msg.id }, job.result())); return null; }
        var step = job.steps[i];
        post({ type: "progress", job: msg.type, id: msg.id, step: i, steps: job.steps.length, text: step.text });
        i += 1;
        return pause().then(function () {
          if (!alive()) { return next(); }
          step.run();
          return next();
        });
      }
      return Promise.resolve().then(next).catch(function (e) { post({ type: "error", id: msg.id, job: msg.type, message: String(e && e.message || e) }); });
    }

    function handle(msg) {
      try {
        if (msg.type === "init") { config = msg.config; env = RF.makeEnv(config); post({ type: "ready" }); }
        else if (msg.type === "setProject") {
          project = State.clone(msg.project); cache = {}; matsSig = JSON.stringify(project.materials || {});
          env = RF.makeEnv(config, project.materials);
          if (msg.mode) { mode = msg.mode; }
          if (msg.band !== undefined) { band = msg.band || null; }
        } else if (msg.type === "update") { applyDelta(msg.ops); }
        else if (msg.type === "cancel") { cancelled[msg.id] = true; jobCancelled[msg.id] = true; }
        else if (msg.type === "analyze" || msg.type === "compare" || msg.type === "rank" || msg.type === "plan" || msg.type === "stack") { return startJob(msg); }
        else if (msg.type === "compute") {
          latestId = msg.id;
          return run({ id: msg.id, floor: msg.floor, cell_m: msg.cell_m }).catch(function (e) {
            if (e && e.stale) { post({ type: "cancelled", id: msg.id }); } else { post({ type: "error", id: msg.id, message: String(e && e.message || e) }); }
          });
        } else { post({ type: "error", id: msg.id, message: "unknown message type " + msg.type }); }
      } catch (e) { post({ type: "error", id: msg.id, message: String(e && e.message || e) }); }
      return null;
    }
    return { handle: handle };
  }

  var api = { createCore: createCore, TILE: TILE, COARSE_FACTOR: COARSE_FACTOR };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  root.RFWorkerCore = api;
  if (inWorker) {
    var core = createCore({ RF: root.RFEngine, State: root.PlannerState, Opt: root.RFOptimizer }, function (m, t) { root.postMessage(m, t || []); });
    root.onmessage = function (e) { core.handle(e.data); };
  }
})(typeof self !== "undefined" ? self : this);
