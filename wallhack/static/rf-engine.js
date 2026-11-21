"use strict";
// RF propagation engine, a port of wallhack/rfmodel.py (the source of truth). MODEL ESTIMATE, not a
// measurement. All numbers come from the config object (rf-config.json) passed in by the caller, so
// the engine has no config of its own. Works in the browser (window.RFEngine), in a Web Worker
// (importScripts) and under node (module.exports). tests/test_rf_parity.py compares it with Python.
// Formulas are documented in the docstring of wallhack/rfmodel.py and in docs/rf-planner.md.
(function (root) {
  /**
   * @typedef {{id:string,x1:number,y1:number,x2:number,y2:number,kind:string,material?:string}} Wall
   * @typedef {{id:string,kind:string,wall:string,pos:number,width:number}} Opening
   * @typedef {{id:string,x:number,y:number,tx_dbm:number,band?:string,channel?:number}} AccessPoint
   * @typedef {{id:string,level:number,width_m:number,depth_m:number,walls:Wall[],openings:Opening[],aps:AccessPoint[]}} Floor
   * @typedef {{floors:Floor[],materials?:Object,mode?:string}} Project
   * @typedef {{config:Object,materials:Object}} Env  built by makeEnv
   * @typedef {{floor:string,cell_m:number,cols:number,rows:number,rssi:number[][],threshold_dbm:number,coverage_pct:number,label:string}} Grid
   * @typedef {function(Object,number,number):number} ModeFn  (context, x, y) -> dBm before floor loss
   */
  var DEFAULT_BAND = "2.4";
  var DEFAULT_MODE = "basic";
  var LABEL = "ESTIMATE: log-distance model with wall attenuation, not a measurement";

  var modes = {};              // mode id -> ModeFn
  var registeredMaterials = {}; // shared extra materials, see registerMaterials

  function registerMode(id, fn) { modes[id] = fn; }
  function registerMaterials(table) { Object.keys(table).forEach(function (k) { registeredMaterials[k] = table[k]; }); }
  function modeIds() { return Object.keys(modes); }

  /** Env = config plus the material table: config < registered < project-defined. */
  function makeEnv(config, customMaterials) {
    var materials = {};
    [config.materials, registeredMaterials, customMaterials || {}].forEach(function (t) {
      Object.keys(t).forEach(function (k) { materials[k] = t[k]; });
    });
    return { config: config, materials: materials };
  }

  function checkBand(env, band) {
    if (!env.config.bands[band]) { throw new Error("band must be one of " + Object.keys(env.config.bands).join(", ")); }
    return band;
  }
  function checkMode(mode) {
    if (!modes[mode]) { throw new Error("mode must be one of " + modeIds().join(", ")); }
    return mode;
  }
  function round1(v) { return Math.round(v * 10) / 10; }

  // ---------------------------------------------------------------- geometry
  function cross(ax, ay, bx, by) { return ax * by - ay * bx; }

  /** Distance along the wall where segment p->q crosses it, or null. */
  function rayWallHit(env, px, py, qx, qy, w) {
    var rx = qx - px, ry = qy - py;
    var sx = w.x2 - w.x1, sy = w.y2 - w.y1;
    var denom = cross(rx, ry, sx, sy);
    if (Math.abs(denom) < env.config.engine.parallel_epsilon) { return null; }
    var t = cross(w.x1 - px, w.y1 - py, sx, sy) / denom;
    var u = cross(w.x1 - px, w.y1 - py, rx, ry) / denom;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) { return u * w.len; }
    return null;
  }

  function pointSegmentDistance(px, py, w) {
    var sx = w.x2 - w.x1, sy = w.y2 - w.y1;
    var t = Math.max(0, Math.min(1, ((px - w.x1) * sx + (py - w.y1) * sy) / (sx * sx + sy * sy)));
    return Math.hypot(px - (w.x1 + t * sx), py - (w.y1 + t * sy));
  }

  function touches(env, w, pt) {
    var eps = env.config.engine.corner_match_epsilon_m;
    return (Math.abs(w.x1 - pt[0]) <= eps && Math.abs(w.y1 - pt[1]) <= eps) ||
           (Math.abs(w.x2 - pt[0]) <= eps && Math.abs(w.y2 - pt[1]) <= eps);
  }

  // ---------------------------------------------------------------- floor preparation + spatial index
  /**
   * Walls of one floor with their losses at `band`, plus a uniform grid index over the wall
   * segments (cell size from floor size and wall count). `brute` skips the index (tests only).
   */
  function prepareFloor(env, floor, band, brute) {
    var cfg = env.config, idxCfg = cfg.engine.spatial_index;
    var byWall = {};
    floor.openings.forEach(function (o) {
      (byWall[o.wall] = byWall[o.wall] || []).push({
        from: o.pos, to: o.pos + o.width, loss: cfg.openings[o.kind].attenuation_db[band] });
    });
    var maxX = floor.width_m, maxY = floor.depth_m;
    var walls = floor.walls.map(function (w) {
      var name = w.material || cfg.kind_defaults[w.kind];
      var mat = env.materials[name];
      if (!mat) { throw new Error("unknown material '" + name + "' on wall '" + w.id + "'"); }
      maxX = Math.max(maxX, w.x1, w.x2); maxY = Math.max(maxY, w.y1, w.y2);
      return { id: w.id, x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2, len: Math.hypot(w.x2 - w.x1, w.y2 - w.y1),
               loss: mat.attenuation_db[band], refl: mat.reflection_loss_db[band], openings: byWall[w.id] || [] };
    });
    var prep = { walls: walls, band: band, index: null, seen: new Int32Array(walls.length), stamp: 0 };
    if (!brute && walls.length) {
      var cs = Math.max(idxCfg.min_cell_m, Math.sqrt(maxX * maxY * idxCfg.target_walls_per_cell / walls.length));
      var index = { cs: cs, cols: Math.max(1, Math.ceil(maxX / cs)), rows: Math.max(1, Math.ceil(maxY / cs)), cells: [] };
      for (var i = 0; i < index.cols * index.rows; i++) { index.cells.push([]); }
      var pad = idxCfg.bbox_pad_m;
      walls.forEach(function (w, n) {
        var c0 = cellOf(index, Math.min(w.x1, w.x2) - pad, true), c1 = cellOf(index, Math.max(w.x1, w.x2) + pad, true);
        var r0 = cellOf(index, Math.min(w.y1, w.y2) - pad, false), r1 = cellOf(index, Math.max(w.y1, w.y2) + pad, false);
        for (var r = r0; r <= r1; r++) { for (var c = c0; c <= c1; c++) { index.cells[r * index.cols + c].push(n); } }
      });
      prep.index = index;
    }
    return prep;
  }

  function cellOf(index, v, isX) {
    var n = isX ? index.cols : index.rows;
    return Math.min(n - 1, Math.max(0, Math.floor(v / index.cs)));
  }

  function collect(prep, n) {
    if (prep.seen[n] !== prep.stamp) { prep.seen[n] = prep.stamp; return true; }
    return false;
  }

  /** Indices (ascending) of walls whose cells the segment p->q passes through (DDA traversal). */
  function segmentCandidates(prep, px, py, qx, qy) {
    var ix = prep.index, out = [];
    prep.stamp++;
    function visit(c, r) {
      if (c < 0 || r < 0 || c >= ix.cols || r >= ix.rows) { return; }
      var cell = ix.cells[r * ix.cols + c];
      for (var i = 0; i < cell.length; i++) { if (collect(prep, cell[i])) { out.push(cell[i]); } }
    }
    var cx = cellOf(ix, px, true), cy = cellOf(ix, py, false), ex = cellOf(ix, qx, true), ey = cellOf(ix, qy, false);
    var dx = qx - px, dy = qy - py;
    var stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1;
    var tMaxX = dx !== 0 ? ((dx > 0 ? (cx + 1) * ix.cs - px : px - cx * ix.cs) / Math.abs(dx)) : Infinity;
    var tMaxY = dy !== 0 ? ((dy > 0 ? (cy + 1) * ix.cs - py : py - cy * ix.cs) / Math.abs(dy)) : Infinity;
    var tDx = dx !== 0 ? ix.cs / Math.abs(dx) : Infinity, tDy = dy !== 0 ? ix.cs / Math.abs(dy) : Infinity;
    var guard = ix.cols + ix.rows + 4;
    for (var s = 0; s < guard; s++) {
      visit(cx, cy);
      if (cx === ex && cy === ey) { break; }
      if (tMaxX < tMaxY) { cx += stepX; tMaxX += tDx; }
      else if (tMaxY < tMaxX) { cy += stepY; tMaxY += tDy; }
      else { visit(cx + stepX, cy); visit(cx, cy + stepY); cx += stepX; cy += stepY; tMaxX += tDx; tMaxY += tDy; }
    }
    return out.sort(function (a, b) { return a - b; });
  }

  /** Total loss of walls and openings crossed by p->q; same result with or without the index. */
  function wallLoss(env, prep, px, py, qx, qy, skipId, skipPoint) {
    var walls = prep.walls, total = 0;
    var list = null;
    if (prep.index) { list = segmentCandidates(prep, px, py, qx, qy); }
    var n = list ? list.length : walls.length;
    for (var i = 0; i < n; i++) {
      var w = walls[list ? list[i] : i];
      if (w.id === skipId || (skipPoint && touches(env, w, skipPoint))) { continue; }
      var along = rayWallHit(env, px, py, qx, qy, w);
      if (along === null) { continue; }
      var loss = w.loss;
      for (var k = 0; k < w.openings.length; k++) {
        if (w.openings[k].from <= along && along <= w.openings[k].to) { loss = w.openings[k].loss; break; }
      }
      total += loss;
    }
    return total;
  }

  /** Wall indices (ascending) within the reflector range of a point. */
  function reflectorsNear(env, prep, x, y) {
    var range = env.config.engine.max_reflector_range_m, ix = prep.index, out = [];
    var pool;
    if (ix) {
      pool = [];
      prep.stamp++;
      for (var r = cellOf(ix, y - range, false); r <= cellOf(ix, y + range, false); r++) {
        for (var c = cellOf(ix, x - range, true); c <= cellOf(ix, x + range, true); c++) {
          var cell = ix.cells[r * ix.cols + c];
          for (var i = 0; i < cell.length; i++) { if (collect(prep, cell[i])) { pool.push(cell[i]); } }
        }
      }
      pool.sort(function (a, b) { return a - b; });
    } else {
      pool = prep.walls.map(function (_, n) { return n; });
    }
    pool.forEach(function (n) { if (pointSegmentDistance(x, y, prep.walls[n]) <= range) { out.push(n); } });
    return out;
  }

  // ---------------------------------------------------------------- propagation
  function pathLoss(env, band, d) {
    var b = env.config.bands[band];
    return b.pl0_db + 10.0 * b.path_loss_exponent * Math.log10(Math.max(d, env.config.engine.min_distance_m));
  }

  function knifeEdge(env, v) {
    var k = env.config.engine.knife_edge;
    if (v <= k.v_min) { return 0; }
    return k.offset_db + k.log_scale * Math.log10(Math.sqrt(Math.pow(v - k.v_offset, 2) + 1.0) + v - k.v_offset);
  }

  function basicDbm(ctx, x, y) {
    var ap = ctx.ap, env = ctx.env, b = env.config.bands[ctx.band];
    var d = Math.max(Math.hypot(x - ap.x, y - ap.y), env.config.engine.min_distance_m);
    var path = b.pl0_db + 10.0 * b.path_loss_exponent * Math.log10(d);
    return ap.tx_dbm - path - wallLoss(env, ctx.prep, ap.x, ap.y, x, y);
  }

  function reflectedDbm(ctx, w, x, y) {
    var ap = ctx.ap, env = ctx.env, prep = ctx.prep;
    var sx = w.x2 - w.x1, sy = w.y2 - w.y1;
    var sideAp = cross(sx, sy, ap.x - w.x1, ap.y - w.y1), sideRx = cross(sx, sy, x - w.x1, y - w.y1);
    if (sideAp === 0 || sideRx === 0 || (sideAp > 0) !== (sideRx > 0)) { return null; }
    var t = ((ap.x - w.x1) * sx + (ap.y - w.y1) * sy) / (sx * sx + sy * sy);
    var ix = 2.0 * (w.x1 + t * sx) - ap.x, iy = 2.0 * (w.y1 + t * sy) - ap.y;
    var along = rayWallHit(env, ix, iy, x, y, w);
    if (along === null) { return null; }
    var frac = along / w.len;
    var rx = w.x1 + frac * sx, ry = w.y1 + frac * sy;
    var loss = pathLoss(env, ctx.band, Math.hypot(x - ix, y - iy)) + w.refl +
      wallLoss(env, prep, ap.x, ap.y, rx, ry, w.id, null) + wallLoss(env, prep, rx, ry, x, y, w.id, null);
    return ap.tx_dbm - loss;
  }

  function diffractedDbm(ctx, corner, x, y) {
    var ap = ctx.ap, env = ctx.env, e = env.config.engine;
    var d1 = Math.hypot(corner[0] - ap.x, corner[1] - ap.y), d2 = Math.hypot(x - corner[0], y - corner[1]);
    var delta = Math.max(0, d1 + d2 - Math.hypot(x - ap.x, y - ap.y));
    var wavelength = e.speed_of_light_mps / (env.config.bands[ctx.band].ghz * 1e9);
    var v = Math.sqrt(e.knife_edge.v_scale * delta / wavelength);
    var loss = pathLoss(env, ctx.band, d1 + d2) + knifeEdge(env, v) +
      wallLoss(env, ctx.prep, ap.x, ap.y, corner[0], corner[1], null, corner) +
      wallLoss(env, ctx.prep, corner[0], corner[1], x, y, null, corner);
    return ap.tx_dbm - loss;
  }

  /** Levels (dBm before floor loss) of every reflected and diffracted path to (x, y). */
  function indirectLevels(ctx, x, y) {
    var levels = [], prep = ctx.prep, ap = ctx.ap, env = ctx.env;
    ctx.reflectors.forEach(function (n) {
      var level = reflectedDbm(ctx, prep.walls[n], x, y);
      if (level !== null) { levels.push(level); }
    });
    var blockers = prep.index ? segmentCandidates(prep, ap.x, ap.y, x, y)
                              : prep.walls.map(function (_, n) { return n; });
    var corners = [];
    function addCorner(px, py) {
      for (var i = 0; i < corners.length; i++) { if (corners[i][0] === px && corners[i][1] === py) { return; } }
      corners.push([px, py]);
    }
    blockers.forEach(function (n) {
      var w = prep.walls[n];
      if (rayWallHit(env, ap.x, ap.y, x, y, w) !== null) { addCorner(w.x1, w.y1); addCorner(w.x2, w.y2); }
    });
    corners.forEach(function (c) { levels.push(diffractedDbm(ctx, c, x, y)); });
    return levels;
  }

  registerMode("basic", basicDbm);
  registerMode("enhanced", function (ctx, x, y) {
    return Math.max.apply(null, [basicDbm(ctx, x, y)].concat(indirectLevels(ctx, x, y)));
  });
  registerMode("multipath", function (ctx, x, y) {
    var sum = 0;
    [basicDbm(ctx, x, y)].concat(indirectLevels(ctx, x, y)).forEach(function (v) { sum += Math.pow(10.0, v / 10.0); });
    return 10.0 * Math.log10(sum);
  });

  // ---------------------------------------------------------------- grids
  function gridAxes(floor, cellM) {
    return { cols: Math.max(1, Math.ceil(floor.width_m / cellM)), rows: Math.max(1, Math.ceil(floor.depth_m / cellM)) };
  }

  function optionsOf(opts) {
    var env = opts.env || makeEnv(opts.config, opts.project && opts.project.materials);
    var cellM = opts.cellM || env.config.engine.default_cell_m;
    return { env: env, cellM: cellM, mode: checkMode(opts.mode || DEFAULT_MODE), band: opts.band || null,
             brute: !!opts.brute };
  }

  function fillApGrid(out, env, floor, ap, floorsApart, o, prepCache) {
    var band = checkBand(env, o.band || ap.band || DEFAULT_BAND);
    var key = floor.id + "|" + band;
    var prep = prepCache[key] || (prepCache[key] = prepareFloor(env, floor, band, o.brute));
    var ctx = { env: env, prep: prep, ap: ap, band: band, reflectors: null };
    var fn = modes[o.mode];
    if (o.mode !== DEFAULT_MODE) { ctx.reflectors = reflectorsNear(env, prep, ap.x, ap.y); }
    var floorLoss = env.config.floor_loss_db[band] * floorsApart;
    var ax = gridAxes(floor, o.cellM), i = 0;
    for (var r = 0; r < ax.rows; r++) {
      for (var c = 0; c < ax.cols; c++) { out[i++] = fn(ctx, (c + 0.5) * o.cellM, (r + 0.5) * o.cellM) - floorLoss; }
    }
    return out;
  }

  /**
   * RSSI of one AP over a floor, row-major, rows from north to south, unrounded.
   * opts: {env | config, cellM, band, mode, floorsApart, brute}. `floor` is the receiving floor.
   * @returns {Float32Array}
   */
  function computeApGrid(floor, ap, opts) {
    var o = optionsOf(opts), ax = gridAxes(floor, o.cellM);
    return fillApGrid(new Float32Array(ax.cols * ax.rows), o.env, floor, ap, opts.floorsApart || 0, o, {});
  }

  /** Per-cell maximum of several grids, never below the no-signal level. */
  function mergeBest(env, grids) {
    if (!grids.length) { return new Float32Array(0); }
    var out = new Float32Array(grids[0].length).fill(env.config.engine.no_signal_dbm);
    grids.forEach(function (g) { for (var i = 0; i < g.length; i++) { if (g[i] > out[i]) { out[i] = g[i]; } } });
    return out;
  }

  /**
   * Mirrors rfmodel.coverage_grid. opts: {env | config, cellM, band, mode, aps:[{ap,floor}], brute}.
   * @returns {Grid}
   */
  function coverageGrid(project, floorId, opts) {
    var o = optionsOf({ env: opts.env, config: opts.config, project: project, cellM: opts.cellM, band: opts.band,
                        mode: opts.mode, brute: opts.brute });
    var env = o.env, cfg = env.config;
    if (!(o.cellM >= 0.1 && o.cellM <= 5.0)) { throw new Error("cell_m must be between 0.1 and 5.0"); }
    var floor = project.floors.filter(function (f) { return f.id === floorId; })[0];
    if (!floor) { throw new Error("unknown floor id '" + floorId + "'"); }
    if (o.band) { checkBand(env, o.band); }
    var aps = opts.aps || [];
    if (!opts.aps) { project.floors.forEach(function (f) { f.aps.forEach(function (a) { aps.push({ ap: a, floor: f }); }); }); }
    var levels = {};
    project.floors.forEach(function (f) { levels[f.id] = f.level; });
    var ax = gridAxes(floor, o.cellM), cache = {};
    var best = new Float64Array(ax.cols * ax.rows).fill(cfg.engine.no_signal_dbm);
    var tmp = new Float64Array(best.length);
    aps.forEach(function (e) {
      fillApGrid(tmp, env, floor, e.ap, Math.abs(levels[e.floor.id] - levels[floor.id]), o, cache);
      for (var i = 0; i < best.length; i++) { if (tmp[i] > best[i]) { best[i] = tmp[i]; } }
    });
    var rssi = [], covered = 0;
    for (var r = 0; r < ax.rows; r++) {
      var row = [];
      for (var c = 0; c < ax.cols; c++) {
        var v = round1(best[r * ax.cols + c]);
        if (v >= cfg.analytics.coverage_dbm) { covered++; }
        row.push(v);
      }
      rssi.push(row);
    }
    var result = { floor: floorId, cell_m: o.cellM, cols: ax.cols, rows: ax.rows, rssi: rssi,
                   threshold_dbm: cfg.analytics.coverage_dbm,
                   coverage_pct: round1(100.0 * covered / (ax.cols * ax.rows)), label: LABEL };
    if (o.band || o.mode !== DEFAULT_MODE) {
      result.band = o.band; result.mode = o.mode;
      result.label = "MODEL ESTIMATE (" + o.mode + " mode, " + (o.band || "per-AP") + " GHz), not a measurement";
    }
    return result;
  }

  var api = { makeEnv: makeEnv, registerMode: registerMode, registerMaterials: registerMaterials, modeIds: modeIds,
              prepareFloor: prepareFloor, wallLoss: wallLoss, gridAxes: gridAxes, computeApGrid: computeApGrid,
              mergeBest: mergeBest, coverageGrid: coverageGrid };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  root.RFEngine = api;
})(typeof self !== "undefined" ? self : this);
