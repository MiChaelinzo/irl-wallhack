"use strict";
// Incremental RF heat-map computation. Runs as a Web Worker (importScripts below) and, when workers are
// unavailable (file://, blocked), the same core runs on the main thread in short time slices.
// MODEL ESTIMATE, not a measurement. Messages in: init, setProject, update, compute, cancel.
// Messages out: ready, progress (coarse then refinements), result, cancelled, error.
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
  if (inWorker) { root.importScripts("rf-engine.js", "planner-state.js"); }

  function Stale() { this.stale = true; }

  /**
   * createCore({RF, State}, post, yieldFn?). `post(message, transferList)` sends results out;
   * the returned object's handle(message) receives requests.
   */
  function createCore(deps, post, hooks) {
    var RF = deps.RF, State = deps.State, clock = (hooks && hooks.now) || function () { return Date.now(); };
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

    function handle(msg) {
      try {
        if (msg.type === "init") { config = msg.config; env = RF.makeEnv(config); post({ type: "ready" }); }
        else if (msg.type === "setProject") {
          project = State.clone(msg.project); cache = {}; matsSig = JSON.stringify(project.materials || {});
          env = RF.makeEnv(config, project.materials);
          if (msg.mode) { mode = msg.mode; }
          if (msg.band !== undefined) { band = msg.band || null; }
        } else if (msg.type === "update") { applyDelta(msg.ops); }
        else if (msg.type === "cancel") { cancelled[msg.id] = true; }
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
    var core = createCore({ RF: root.RFEngine, State: root.PlannerState }, function (m, t) { root.postMessage(m, t || []); });
    root.onmessage = function (e) { core.handle(e.data); };
  }
})(typeof self !== "undefined" ? self : this);
