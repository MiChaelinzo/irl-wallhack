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
   * @typedef {(ctx:Object,x:number,y:number)=>number} ModeFn  dBm before floor loss
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
        from: o.pos, to: o.pos + o.width, loss: cfg.openings[o.kind].attenuation_db[band], kind: o.kind });
    });
    var maxX = floor.width_m, maxY = floor.depth_m;
    var walls = floor.walls.map(function (w) {
      var name = w.material || cfg.kind_defaults[w.kind];
      var mat = env.materials[name];
      if (!mat) { throw new Error("unknown material '" + name + "' on wall '" + w.id + "'"); }
      maxX = Math.max(maxX, w.x1, w.x2); maxY = Math.max(maxY, w.y1, w.y2);
      return { id: w.id, x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2, len: Math.hypot(w.x2 - w.x1, w.y2 - w.y1),
               loss: mat.attenuation_db[band], refl: mat.reflection_loss_db[band], openings: byWall[w.id] || [],
               material: name, label: mat.label };
    });
    var prep = { walls: walls, band: band, index: null, seen: new Int32Array(walls.length), stamp: 0, scratch: [], hits: [], hitLosses: [] };
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

  /** Appends the walls of one index cell that this query has not seen yet to `out` (stamp marks them). */
  function visitCell(prep, out, c, r) {
    var ix = prep.index;
    if (c < 0 || r < 0 || c >= ix.cols || r >= ix.rows) { return; }
    var cell = ix.cells[r * ix.cols + c];
    for (var i = 0; i < cell.length; i++) {
      var n = cell[i];
      if (prep.seen[n] !== prep.stamp) { prep.seen[n] = prep.stamp; out.push(n); }
    }
  }

  /** Ascending order of the candidate indices keeps the loss summation order identical to Python. Short lists: insertion sort. */
  function sortAscending(list) {
    for (var i = 1; i < list.length; i++) {
      var v = list[i], j = i - 1;
      while (j >= 0 && list[j] > v) { list[j + 1] = list[j]; j--; }
      list[j + 1] = v;
    }
    return list;
  }

  /** Fills `out` (emptied first) with the indices, in visiting order, of walls whose cells the segment p->q passes through (DDA traversal). */
  function fillCandidates(prep, px, py, qx, qy, out) {
    var ix = prep.index;
    out.length = 0;
    prep.stamp++;
    var cx = cellOf(ix, px, true), cy = cellOf(ix, py, false), ex = cellOf(ix, qx, true), ey = cellOf(ix, qy, false);
    var dx = qx - px, dy = qy - py;
    var stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1;
    var tMaxX = dx !== 0 ? ((dx > 0 ? (cx + 1) * ix.cs - px : px - cx * ix.cs) / Math.abs(dx)) : Infinity;
    var tMaxY = dy !== 0 ? ((dy > 0 ? (cy + 1) * ix.cs - py : py - cy * ix.cs) / Math.abs(dy)) : Infinity;
    var tDx = dx !== 0 ? ix.cs / Math.abs(dx) : Infinity, tDy = dy !== 0 ? ix.cs / Math.abs(dy) : Infinity;
    var guard = ix.cols + ix.rows + 4;
    for (var s = 0; s < guard; s++) {
      visitCell(prep, out, cx, cy);
      if (cx === ex && cy === ey) { break; }
      if (tMaxX < tMaxY) { cx += stepX; tMaxX += tDx; }
      else if (tMaxY < tMaxX) { cy += stepY; tMaxY += tDy; }
      else { visitCell(prep, out, cx + stepX, cy); visitCell(prep, out, cx, cy + stepY); cx += stepX; cy += stepY; tMaxX += tDx; tMaxY += tDy; }
    }
    return out;
  }

  /** Indices (ascending) of walls the segment p->q may touch, in a new array. */
  function segmentCandidates(prep, px, py, qx, qy) { return sortAscending(fillCandidates(prep, px, py, qx, qy, [])); }

  /**
   * Total loss of walls and openings crossed by p->q; same result with or without the index. The losses are added in
   * ascending wall order, as rfmodel.py does. With the index only the crossed walls are sorted (few), not every candidate.
   */
  function wallLoss(env, prep, px, py, qx, qy, skipId, skipPoint) {
    var walls = prep.walls, hits = prep.hits, losses = prep.hitLosses, count = 0;
    var list = prep.index ? fillCandidates(prep, px, py, qx, qy, prep.scratch) : null;
    var n = list ? list.length : walls.length;
    for (var i = 0; i < n; i++) {
      var id = list ? list[i] : i, w = walls[id];
      if (w.id === skipId || (skipPoint && touches(env, w, skipPoint))) { continue; }
      var along = rayWallHit(env, px, py, qx, qy, w);
      if (along === null) { continue; }
      var loss = w.loss;
      for (var k = 0; k < w.openings.length; k++) {
        if (w.openings[k].from <= along && along <= w.openings[k].to) { loss = w.openings[k].loss; break; }
      }
      var at = count++;
      while (at > 0 && hits[at - 1] > id) { hits[at] = hits[at - 1]; losses[at] = losses[at - 1]; at--; }
      hits[at] = id; losses[at] = loss;
    }
    var total = 0;
    for (var h = 0; h < count; h++) { total += losses[h]; }
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

  /** Antenna gain (dBi) of `ap` towards a bearing in degrees (0 = +x east, clockwise on the plan). Mirrors rfmodel.antenna_gain_db. */
  function antennaGainDb(config, ap, bearingDeg) {
    var gain = ap.antenna_gain_dbi !== undefined ? ap.antenna_gain_dbi : 0;
    if ((ap.pattern || "omni") === "omni") { return gain; }
    var sector = config.antenna.patterns.sector;
    var off = ((bearingDeg - (ap.azimuth_deg !== undefined ? ap.azimuth_deg : 0) + 540) % 360) - 180;
    var ratio = off / (ap.beamwidth_deg !== undefined ? ap.beamwidth_deg : sector.default_beamwidth_deg);
    return gain - Math.min(config.antenna.parabolic_coefficient * ratio * ratio,
                           ap.front_to_back_db !== undefined ? ap.front_to_back_db : sector.default_front_to_back_db);
  }

  /** Gain towards the point (x, y), 0 for a plain AP without computing a bearing (rfmodel.antenna_gain_toward). */
  function antennaGainToward(config, ap, x, y) {
    if (ap.antenna_gain_dbi === undefined && ap.pattern === undefined) { return 0; }
    return antennaGainDb(config, ap, Math.atan2(y - ap.y, x - ap.x) * 180 / Math.PI);
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
    return ap.tx_dbm + antennaGainToward(env.config, ap, x, y) - path - wallLoss(env, ctx.prep, ap.x, ap.y, x, y);
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
    return ap.tx_dbm + antennaGainToward(env.config, ap, rx, ry) - loss;
  }

  /** Knife-edge loss (dB) of the path AP -> corner -> (x, y), like rfmodel._knife_edge_for. */
  function knifeEdgeFor(env, ap, band, corner, x, y) {
    var e = env.config.engine;
    var d1 = Math.hypot(corner[0] - ap.x, corner[1] - ap.y), d2 = Math.hypot(x - corner[0], y - corner[1]);
    var delta = Math.max(0, d1 + d2 - Math.hypot(x - ap.x, y - ap.y));
    var wavelength = e.speed_of_light_mps / (env.config.bands[band].ghz * 1e9);
    return knifeEdge(env, Math.sqrt(e.knife_edge.v_scale * delta / wavelength));
  }

  function diffractedDbm(ctx, corner, x, y) {
    var ap = ctx.ap, env = ctx.env;
    var d1 = Math.hypot(corner[0] - ap.x, corner[1] - ap.y), d2 = Math.hypot(x - corner[0], y - corner[1]);
    var loss = pathLoss(env, ctx.band, d1 + d2) + knifeEdgeFor(env, ap, ctx.band, corner, x, y) +
      wallLoss(env, ctx.prep, ap.x, ap.y, corner[0], corner[1], null, corner) +
      wallLoss(env, ctx.prep, corner[0], corner[1], x, y, null, corner);
    return ap.tx_dbm + antennaGainToward(env.config, ap, corner[0], corner[1]) - loss;
  }

  /** Levels (dBm before floor loss) of every reflected and diffracted path to (x, y). */
  function indirectLevels(ctx, x, y, detail) {
    var levels = [], prep = ctx.prep, ap = ctx.ap, env = ctx.env;
    ctx.reflectors.forEach(function (n) {
      var level = reflectedDbm(ctx, prep.walls[n], x, y);
      if (level !== null) { levels.push(level); if (detail) { detail.push({ kind: "reflection", ref: prep.walls[n], level: level }); } }
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
    corners.forEach(function (c) {
      var level = diffractedDbm(ctx, c, x, y);
      levels.push(level);
      if (detail) { detail.push({ kind: "diffraction", ref: c, level: level }); }
    });
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

  // ---------------------------------------------------------------- floor openings (stairwell, atrium, shaft)
  /** Even-odd ray casting, like rfmodel._in_polygon. */
  function inPolygon(x, y, pts) {
    var inside = false;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      var xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) { inside = !inside; }
    }
    return inside;
  }

  /** True if (x, y) lies in a void of the floor (rfmodel.in_void). Floors without `voids` never do. */
  function inVoid(floor, x, y) {
    var voids = floor.voids || [];
    for (var i = 0; i < voids.length; i++) {
      var v = voids[i];
      if (v.points ? inPolygon(x, y, v.points) : (v.x <= x && x <= v.x + v.w && v.y <= y && y <= v.y + v.d)) { return true; }
    }
    return false;
  }

  /** Floors crossed for the floor loss (rfmodel.floors_crossed): the level difference, or with elevation_m on both floors
   *  |elevation difference| / reference_height_m, at least one. */
  function floorsCrossed(config, apFloor, floor, apart) {
    if (apart === 0 || !apFloor || apFloor.elevation_m === undefined || floor.elevation_m === undefined) { return apart; }
    return Math.max(1.0, Math.abs(floor.elevation_m - apFloor.elevation_m) / config.floor_elevation.reference_height_m);
  }

  /** Floor loss between the AP floor and the receiving floor with voids (rfmodel.floor_penetration_db). */
  function floorPenetrationDb(config, ap, apFloor, floor, x, y, apart, band) {
    var base = config.floor_loss_db[band] * floorsCrossed(config, apFloor, floor, apart);
    if (apart === 0 || !apFloor) { return base; }
    var open = (inVoid(apFloor, ap.x, ap.y) ? 1 : 0) + (inVoid(floor, x, y) ? 1 : 0);
    if (open === 0) { return base; }
    return base * (1.0 - Math.min(1.0, open * config.voids.open_end_reduction));
  }

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

  function fillApGrid(out, env, floor, ap, floorsApart, o, prepCache, region, apFloor) {
    var band = checkBand(env, o.band || ap.band || DEFAULT_BAND);
    var key = floor.id + "|" + band;
    var prep = prepCache[key] || (prepCache[key] = prepareFloor(env, floor, band, o.brute));
    var ctx = { env: env, prep: prep, ap: ap, band: band, reflectors: null };
    var fn = modes[o.mode];
    if (o.mode !== DEFAULT_MODE) { ctx.reflectors = reflectorsNear(env, prep, ap.x, ap.y); }
    var floorLoss = env.config.floor_loss_db[band] * floorsCrossed(env.config, apFloor, floor, floorsApart), cfg = env.config;
    var hasVoids = floorsApart > 0 && !!((apFloor && apFloor.voids && apFloor.voids.length) || (floor.voids && floor.voids.length));
    var ax = gridAxes(floor, o.cellM), i = 0;
    if (region) {   // cells [c0,c1) x [r0,r1) only, written at their place in the full row-major grid
      for (var rr = region.r0; rr < region.r1; rr++) {
        for (var cc = region.c0; cc < region.c1; cc++) { var px = (cc + 0.5) * o.cellM, py = (rr + 0.5) * o.cellM;
          out[rr * ax.cols + cc] = fn(ctx, px, py) - (hasVoids ? floorPenetrationDb(cfg, ap, apFloor, floor, px, py, floorsApart, band) : floorLoss); }
      }
      return out;
    }
    for (var r = 0; r < ax.rows; r++) {
      for (var c = 0; c < ax.cols; c++) {
        var qx = (c + 0.5) * o.cellM, qy = (r + 0.5) * o.cellM;
        out[i++] = fn(ctx, qx, qy) - (hasVoids ? floorPenetrationDb(cfg, ap, apFloor, floor, qx, qy, floorsApart, band) : floorLoss);
      }
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
    return fillApGrid(new Float32Array(ax.cols * ax.rows), o.env, floor, ap, opts.floorsApart || 0, o, {}, undefined, opts.apFloor);
  }

  /**
   * Fill only the cells of `region` {c0,r0,c1,r1} (end exclusive) of one AP's grid into `out`, a full
   * row-major array (Float32Array or Float64Array). Same values as computeApGrid for those cells. The
   * Web Worker uses it for tiles. opts as computeApGrid plus prepCache (object reused between calls so the
   * wall index is built once) and floorsApart.
   */
  function computeApRegion(floor, ap, opts, region, out) {
    var o = optionsOf(opts);
    return fillApGrid(out, o.env, floor, ap, opts.floorsApart || 0, o, opts.prepCache || {}, region, opts.apFloor);
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
      fillApGrid(tmp, env, floor, e.ap, Math.abs(levels[e.floor.id] - levels[floor.id]), o, cache, undefined, e.floor);
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

  // ---------------------------------------------------------------- analytics (ESTIMATES)
  // Mirror of the analytics section of wallhack/rfmodel.py. Throughput, capacity and utilisation are
  // derived from RSSI with typical PHY-rate tables, not measured. Formulas: docs/rf-planner.md.
  var ANALYTICS_LABEL = "ESTIMATE: throughput, capacity and utilisation are derived from RSSI with typical PHY-rate tables";

  /** Round half up to `decimals` places (the same rule as rfmodel._round). */
  function roundTo(v, decimals) { var s = Math.pow(10, decimals || 1); return Math.floor(v * s + 0.5) / s; }

  function qualityBand(config, rssi) {
    var bands = config.analytics.quality_bands;
    for (var i = 0; i < bands.length; i++) { if (bands[i].min_dbm === null || rssi >= bands[i].min_dbm) { return bands[i].id; } }
    throw new Error("quality_bands needs a closing band with min_dbm null");
  }

  function phyRateMbps(config, rssi, band, widthMhz) {
    var table = config.mcs_tables[band][String(widthMhz)];
    if (!table) { throw new Error("no rate table for " + band + " GHz at " + widthMhz + " MHz"); }
    var rate = 0;
    table.forEach(function (e) { if (rssi >= e.min_dbm) { rate = e.phy_mbps; } });
    return rate;
  }

  function throughputMbps(config, rssi, band, widthMhz) {
    return phyRateMbps(config, rssi, band, widthMhz) * config.analytics.mac_efficiency;
  }

  /** Width to look up in the legacy mcs_tables for an AP with a standard (rfmodel.legacy_table_width). */
  function legacyTableWidth(config, band, widthMhz) {
    var widths = Object.keys(config.mcs_tables[band]).map(Number).sort(function (a, b) { return a - b; });
    if (widths.indexOf(widthMhz) >= 0) { return widthMhz; }
    var below = widths.filter(function (w) { return w <= widthMhz; });
    return below.length ? Math.max.apply(null, below) : widths[0];
  }

  function tableWidth(config, ap) { return ap.standard !== undefined ? legacyTableWidth(config, ap.band, ap.width_mhz) : ap.width_mhz; }

  function apRadio(config, ap, band) {
    var b = config.bands[band], width;
    if (ap.width_mhz !== undefined) { width = ap.width_mhz; }
    else if (ap.standard !== undefined) { width = defaultWidthMhz(config, ap.standard, band); }   // Wi-Fi 4 has no 80 MHz channel on 5 GHz
    else { width = b.default_width_mhz; }
    return { channel: ap.channel !== undefined ? ap.channel : b.default_channel, width: width };
  }

  // ---------------------------------------------------------------- WiFi standards, SINR, MLO (ESTIMATES)
  // Mirror of the wifi_standards, interference and MLO functions of wallhack/rfmodel.py. Formulas: docs/rf-planner.md.
  var AP_MODEL_FIELDS = ["standard", "spatial_streams", "mlo_bands", "antenna_gain_dbi", "azimuth_deg", "pattern",
                         "beamwidth_deg", "front_to_back_db", "beamforming"];
  var SINR_LABEL = "MODEL ESTIMATE: SINR throughput from co-channel and adjacent-channel interference, not a measurement";

  function standardSpec(config, standard) {
    var spec = config.wifi_standards.standards[standard];
    if (!spec) { throw new Error("standard must be one of " + Object.keys(config.wifi_standards.standards).join(", ")); }
    return spec;
  }

  function standardWidths(config, standard, band) {
    var widths = standardSpec(config, standard).widths_mhz_by_band[band];
    if (!widths) { throw new Error(standard + " is not allowed on the " + band + " GHz band"); }
    return widths;
  }

  function defaultWidthMhz(config, standard, band) {
    var limit = config.bands[band].default_width_mhz;
    return Math.max.apply(null, standardWidths(config, standard, band).filter(function (w) { return w <= limit; }));
  }

  function defaultStreams(config, standard) {
    return Math.min(config.wifi_standards.default_streams, standardSpec(config, standard).max_streams);
  }

  function noiseFloorDbm(config, widthMhz) {
    var i = config.interference;
    return i.thermal_noise_dbm_per_hz + 10.0 * Math.log10(widthMhz * 1e6) + i.noise_figure_db;
  }

  function standardPhyRateMbps(config, standard, mcs, widthMhz, streams) {
    var spec = standardSpec(config, standard), entry = config.wifi_standards.mcs[mcs];
    var subcarriers = spec.data_subcarriers[String(widthMhz)];
    if (subcarriers === undefined) { throw new Error(standard + " has no " + widthMhz + " MHz channel"); }
    return subcarriers * entry.bits_per_subcarrier * (entry.coding_rate[0] / entry.coding_rate[1]) * streams /
      (spec.symbol_us + config.wifi_standards.default_guard_interval_us);
  }

  function highestMcs(config, standard, sinrDb) {
    var best = null;
    config.wifi_standards.mcs.slice(0, standardSpec(config, standard).max_mcs + 1).forEach(function (e) {
      if (sinrDb >= e.min_snr_db) { best = e.index; }
    });
    return best;
  }

  function sinrPhyRateMbps(config, standard, sinrDb, widthMhz, streams) {
    var mcs = highestMcs(config, standard, sinrDb);
    return mcs === null ? 0 : standardPhyRateMbps(config, standard, mcs, widthMhz, streams);
  }

  function channelCentreMhz(config, band, channel) {
    return config.interference.channel_base_mhz[band] + config.interference.channel_step_mhz * channel;
  }

  function interferenceCoupling(config, band, channelA, widthA, channelB, widthB) {
    var i = config.interference, ca = channelCentreMhz(config, band, channelA), cb = channelCentreMhz(config, band, channelB);
    var overlap = Math.max(0, Math.min(ca + widthA / 2, cb + widthB / 2) - Math.max(ca - widthA / 2, cb - widthB / 2));
    var inband = overlap / widthB;
    var gap = Math.max(0, Math.abs(ca - cb) - (widthA + widthB) / 2);
    if (inband === 0 && gap > i.negligible_gap_mhz) { return 0; }
    var rejection = 0;
    i.rejection_table.forEach(function (row) { if (gap >= row.min_gap_mhz) { rejection = row.rejection_db; } });
    return inband + (1 - inband) * Math.pow(10, -rejection / 10);
  }

  function mloCapacityMbps(config, linkRates) {
    var sorted = linkRates.slice().sort(function (a, b) { return b - a; });
    return sorted.slice(0, config.wifi_standards.mlo.max_links).reduce(function (s, v) { return s + v; }, 0);
  }

  /**
   * Non-WiFi and neighbour sources of the project with every default filled in (rfmodel.resolve_interferers).
   * MODEL: planning assumptions from config.external_sources.
   */
  function resolveInterferers(project, config) {
    var kinds = config.external_sources.kinds;
    return (project.interferers || []).map(function (src) {
      var spec = kinds[src.kind];
      var entry = { id: src.id, kind: src.kind, floor: src.floor, x: src.x, y: src.y,
                    tx_dbm: src.tx_dbm !== undefined ? src.tx_dbm : spec.tx_dbm,
                    duty_cycle: src.duty_cycle !== undefined ? src.duty_cycle : spec.duty_cycle };
      if (src.kind === "neighbour_wifi") {
        var band = src.band !== undefined ? src.band : spec.default_band, b = config.bands[band];
        entry.band = band;
        entry.channel = src.channel !== undefined ? src.channel : b.default_channel;
        entry.width_mhz = src.width_mhz !== undefined ? src.width_mhz : b.default_width_mhz;
      } else {
        entry.band = spec.band; entry.centre_mhz = spec.centre_mhz; entry.width_mhz = spec.width_mhz;
      }
      return entry;
    });
  }

  /** Low and high edge (MHz) of the band a source occupies (rfmodel.source_span_mhz). */
  function sourceSpanMhz(config, src) {
    var centre = src.channel !== undefined ? channelCentreMhz(config, src.band, src.channel) : src.centre_mhz;
    return [centre - src.width_mhz / 2, centre + src.width_mhz / 2];
  }

  /** Share of a resolved source's power inside the victim receive band (rfmodel.external_coupling). */
  function externalCoupling(config, src, band, channel, widthMhz) {
    if (src.band !== band) { return 0; }
    if (src.channel !== undefined) { return interferenceCoupling(config, band, channel, widthMhz, src.channel, src.width_mhz); }
    var centre = channelCentreMhz(config, band, channel), span = sourceSpanMhz(config, src);
    return Math.max(0, Math.min(centre + widthMhz / 2, span[1]) - Math.max(centre - widthMhz / 2, span[0])) / src.width_mhz;
  }

  /** ESTIMATE of the packet error rate at an SINR for an MCS (rfmodel.packet_error_rate). */
  function packetErrorRate(config, sinrDb, mcs) {
    var r = config.reliability, p0 = r.per_at_min_snr;
    var x = (sinrDb - config.wifi_standards.mcs[mcs].min_snr_db) / r.per_scale_db + Math.log((1 - p0) / p0);
    return 1 / (1 + Math.exp(x));
  }

  /** ESTIMATES of PER, loss after retries, latency and airtime for one cell (rfmodel.link_reliability). */
  function linkReliability(config, standard, sinrDb, rateMbps, busy) {
    var r = config.reliability, mcs = highestMcs(config, standard, sinrDb);
    var per = mcs === null ? 1 : packetErrorRate(config, sinrDb, mcs);
    busy = Math.min(busy, r.max_busy_fraction);
    var term = 1, transmissions = 0;
    for (var k = 0; k < r.retry_limit + 1; k++) { transmissions += term; term *= per; }
    var goodput = rateMbps * (1 - per) * (1 - busy);
    var airtime = goodput <= 0 ? 100 : Math.min(100, 100 * config.analytics.per_client_demand_mbps / goodput);
    var latency = r.base_latency_ms + (transmissions - 1) * r.retry_penalty_ms + busy / (1 - busy) * r.medium_wait_ms;
    return { per_pct: 100 * per, loss_pct: 100 * term, latency_ms: latency, airtime_pct: airtime };
  }

  function meanOf(values, decimals) {
    return values.length ? roundTo(values.reduce(function (s, v) { return s + v; }, 0) / values.length, decimals === undefined ? 1 : decimals) : null;
  }

  /** SINR, SINR-based throughput and MLO capacity for the cells each AP serves, like rfmodel._sinr_section. */
  function sinrSection(aps, bestAp, flats, cols, rows, config, mloGrids, external, cellM) {
    var interf = config.interference, mac = config.analytics.mac_efficiency, total = rows * cols, i, j, n;
    external = external || [];
    var radios = aps.map(function (ap) {
      var std = ap.standard || interf.fallback_standard[ap.band];
      return { standard: std, streams: ap.spatial_streams !== undefined ? ap.spatial_streams : defaultStreams(config, std),
               noise: noiseFloorDbm(config, ap.width_mhz) };
    });
    var coupling = aps.map(function (a, ia) {
      return aps.map(function (b, ib) {
        return ia !== ib && a.band === b.band ? interferenceCoupling(config, a.band, a.channel, a.width_mhz, b.channel, b.width_mhz) : 0;
      });
    });
    var extCoupling = aps.map(function (ap) {
      return external.map(function (src) { return externalCoupling(config, src, ap.band, ap.channel, ap.width_mhz); });
    });
    var sinr = new Array(total).fill(null), phy = new Array(total).fill(0), rate = new Array(total).fill(0);
    for (n = 0; n < total; n++) {
      i = bestAp[n];
      if (i < 0) { continue; }
      var powerMw = 0;
      for (j = 0; j < aps.length; j++) {
        if (coupling[i][j] > 0) { powerMw += coupling[i][j] * interf.activity_factor * Math.pow(10, flats[j][n] / 10); }
      }
      for (var k = 0; k < external.length; k++) {
        if (extCoupling[i][k] > 0) { powerMw += extCoupling[i][k] * external[k].duty_cycle * Math.pow(10, external[k].grid[n] / 10); }
      }
      sinr[n] = flats[i][n] - 10 * Math.log10(Math.pow(10, radios[i].noise / 10) + powerMw);
      phy[n] = sinrPhyRateMbps(config, radios[i].standard, sinr[n], aps[i].width_mhz, radios[i].streams);
      rate[n] = phy[n] * mac;
    }
    var busy = aps.map(function (ap, idx) {
      var col = Math.min(cols - 1, Math.max(0, Math.floor(ap.x / cellM))), row = Math.min(rows - 1, Math.max(0, Math.floor(ap.y / cellM)));
      var sum = 0;
      external.forEach(function (src, k) {
        if (extCoupling[idx][k] > 0 && src.grid[row * cols + col] + 10 * Math.log10(extCoupling[idx][k]) >= config.analytics.carrier_sense_dbm) { sum += src.duty_cycle; }
      });
      return sum;
    });
    var rel = new Array(total).fill(null);
    for (n = 0; n < total; n++) {
      if (bestAp[n] >= 0) { rel[n] = linkReliability(config, radios[bestAp[n]].standard, sinr[n], rate[n], busy[bestAp[n]]); }
    }
    var perAp = aps.map(function (ap, idx) {
      var cells = [];
      for (n = 0; n < total; n++) { if (bestAp[n] === idx) { cells.push(n); } }
      var r = radios[idx], spec = standardSpec(config, r.standard);
      var entry = { id: ap.id, standard: r.standard, band: ap.band, channel: ap.channel, width_mhz: ap.width_mhz,
                    streams: r.streams, noise_floor_dbm: roundTo(r.noise, 1),
                    max_phy_mbps: roundTo(standardPhyRateMbps(config, r.standard, spec.max_mcs, ap.width_mhz, r.streams), 1),
                    served_cells: cells.length, mean_sinr_db: meanOf(cells.map(function (k) { return sinr[k]; })),
                    mean_throughput_mbps: meanOf(cells.map(function (k) { return rate[k]; })),
                    interferers: aps.filter(function (o, k) { return coupling[idx][k] > 0; }).map(function (o) { return o.id; }),
                    external_sources: external.filter(function (src, k) { return extCoupling[idx][k] > 0; }).map(function (src) { return src.id; }),
                    reliability: { channel_busy_pct: roundTo(100 * Math.min(busy[idx], config.reliability.max_busy_fraction), 1),
                                   mean_per_pct: meanOf(cells.map(function (k) { return rel[k].per_pct; }), 2),
                                   mean_loss_pct: meanOf(cells.map(function (k) { return rel[k].loss_pct; }), 3),
                                   mean_latency_ms: meanOf(cells.map(function (k) { return rel[k].latency_ms; }), 1),
                                   mean_airtime_pct: meanOf(cells.map(function (k) { return rel[k].airtime_pct; }), 1) } };
      var extra = mloGrids && mloGrids[ap.id];
      if (extra) {
        var capacity = cells.map(function (k) {
          var links = [phy[k]];
          ap.mlo_bands.forEach(function (b) {
            var width = defaultWidthMhz(config, r.standard, b);
            links.push(sinrPhyRateMbps(config, r.standard, extra[b][Math.floor(k / cols)][k % cols] - noiseFloorDbm(config, width), width, r.streams));
          });
          return mloCapacityMbps(config, links) * mac;
        });
        entry.mlo = { label: config.wifi_standards.mlo.label, links: [ap.band].concat(ap.mlo_bands), mean_capacity_mbps: meanOf(capacity) };
      }
      return entry;
    });
    var sinrRows = [], rateRows = [];
    for (var r = 0; r < rows; r++) {
      sinrRows.push(sinr.slice(r * cols, (r + 1) * cols).map(function (v) { return v === null ? null : roundTo(v, 1); }));
      rateRows.push(rate.slice(r * cols, (r + 1) * cols).map(function (v) { return roundTo(v, 1); }));
    }
    function relRows(key, decimals) {
      var out = [];
      for (var q = 0; q < rows; q++) {
        var row = [];
        for (var c = 0; c < cols; c++) { var cell = rel[q * cols + c]; row.push(cell === null ? null : roundTo(cell[key], decimals)); }
        out.push(row);
      }
      return out;
    }
    var served = rel.filter(function (v) { return v !== null; });
    var reliability = { label: config.reliability.label, per_pct: relRows("per_pct", 2), loss_pct: relRows("loss_pct", 3),
                        latency_ms: relRows("latency_ms", 1), airtime_pct: relRows("airtime_pct", 1),
                        mean_per_pct: meanOf(served.map(function (v) { return v.per_pct; }), 2),
                        mean_loss_pct: meanOf(served.map(function (v) { return v.loss_pct; }), 3),
                        mean_latency_ms: meanOf(served.map(function (v) { return v.latency_ms; }), 1),
                        mean_airtime_pct: meanOf(served.map(function (v) { return v.airtime_pct; }), 1) };
    return { label: SINR_LABEL, noise_figure_db: interf.noise_figure_db, reliability: reliability,
             external_label: config.external_sources.label,
             external: external.map(function (src) { var o = {}; Object.keys(src).forEach(function (k) { if (k !== "grid") { o[k] = src[k]; } }); return o; }),
             sinr_db: sinrRows, throughput_mbps: rateRows,
             mean_sinr_db: meanOf(sinr.filter(function (v) { return v !== null; })),
             mean_throughput_mbps: total ? roundTo(rate.reduce(function (s, v) { return s + v; }, 0) / total, 1) : 0, aps: perAp };
  }

  function findFloor(project, floorId) {
    var floor = project.floors.filter(function (f) { return f.id === floorId; })[0];
    if (!floor) { throw new Error("unknown floor id '" + floorId + "'"); }
    return floor;
  }

  /**
   * Per-AP RSSI grids on one floor (rows north to south, rounded to 0.1 dBm), like rfmodel.ap_grids.
   * opts: {env | config, cellM, band, mode, aps:[{ap,floor}]}.
   */
  function apGrids(project, floorId, opts) {
    var o = optionsOf({ env: opts.env, config: opts.config, project: project, cellM: opts.cellM, band: opts.band,
                        mode: opts.mode, brute: opts.brute });
    var floor = findFloor(project, floorId), ax = gridAxes(floor, o.cellM), cache = {};
    var list = opts.aps;
    if (!list) { list = []; project.floors.forEach(function (f) { f.aps.forEach(function (a) { list.push({ ap: a, floor: f }); }); }); }
    var levels = {};
    project.floors.forEach(function (f) { levels[f.id] = f.level; });
    return list.map(function (e) {
      var band = checkBand(o.env, o.band || e.ap.band || DEFAULT_BAND);
      var flat = fillApGrid(new Float64Array(ax.cols * ax.rows), o.env, floor, e.ap,
                            Math.abs(levels[e.floor.id] - levels[floor.id]), o, cache, undefined, e.floor);
      var grid = [];
      for (var r = 0; r < ax.rows; r++) {
        var row = [];
        for (var c = 0; c < ax.cols; c++) { row.push(round1(flat[r * ax.cols + c])); }
        grid.push(row);
      }
      var radio = apRadio(o.env.config, e.ap, band);
      var entry = { id: e.ap.id, floor: e.floor.id, x: e.ap.x, y: e.ap.y, tx_dbm: e.ap.tx_dbm, band: band,
                    channel: radio.channel, width_mhz: radio.width, grid: grid };
      AP_MODEL_FIELDS.forEach(function (k) { if (e.ap[k] !== undefined) { entry[k] = e.ap[k]; } });
      return entry;
    });
  }

  /** 4-connected regions of true cells (flood fill), ordered by first cell in a row-major scan. */
  function regionsOf(cells, cols, rows, cellM) {
    var seen = new Uint8Array(cells.length), out = [];
    for (var start = 0; start < cells.length; start++) {
      if (!cells[start] || seen[start]) { continue; }
      var stack = [start], members = [];
      seen[start] = 1;
      while (stack.length) {
        var n = stack.pop();
        members.push(n);
        var r = Math.floor(n / cols), c = n % cols;
        [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]].forEach(function (p) {
          var m = p[0] * cols + p[1];
          if (p[0] >= 0 && p[0] < rows && p[1] >= 0 && p[1] < cols && cells[m] && !seen[m]) { seen[m] = 1; stack.push(m); }
        });
      }
      var rs = members.map(function (n) { return Math.floor(n / cols); }), cs = members.map(function (n) { return n % cols; });
      var sum = function (a) { return a.reduce(function (x, y) { return x + y; }, 0); };
      var region = { cells: members.length, area_m2: roundTo(members.length * cellM * cellM, 2) };
      region.bbox = { x_min: roundTo(Math.min.apply(null, cs) * cellM, 2), y_min: roundTo(Math.min.apply(null, rs) * cellM, 2),
                      x_max: roundTo((Math.max.apply(null, cs) + 1) * cellM, 2), y_max: roundTo((Math.max.apply(null, rs) + 1) * cellM, 2) };
      region.centroid = { x: roundTo((sum(cs) / cs.length + 0.5) * cellM, 2), y: roundTo((sum(rs) / rs.length + 0.5) * cellM, 2) };
      out.push(region);
    }
    return out;
  }

  /**
   * Coverage analytics of one floor, same output as rfmodel.analytics. `gridResult` is a coverageGrid
   * result, `aps` the apGrids list. ESTIMATES only.
   */
  function analytics(gridResult, aps, config, mloGrids, external, placedClients) {
    var a = config.analytics, rows = gridResult.rows, cols = gridResult.cols, cellM = gridResult.cell_m;
    var area = cellM * cellM, total = rows * cols, n, i, j;
    var best = [].concat.apply([], gridResult.rssi);
    var flats = aps.map(function (ap) { return [].concat.apply([], ap.grid); });
    var qualityCounts = {};
    a.quality_bands.forEach(function (b) { qualityCounts[b.id] = 0; });
    best.forEach(function (v) { qualityCounts[qualityBand(config, v)]++; });
    var dead = best.map(function (v) { return v < a.dead_zone_dbm; });
    var bestAp = [], overlapCells = new Array(total).fill(false), roamCells = new Array(total).fill(false);
    var pairCells = {}, roamPairs = {};
    var secondAp = new Array(total).fill(-1), margin = new Array(total).fill(null), zone = new Array(total).fill(0), blend = new Array(total).fill(null);
    var zoneIds = config.roaming.zone_ids;
    function bump(map, x, y) { var k = Math.min(x, y) + "," + Math.max(x, y); map[k] = (map[k] || 0) + 1; }
    for (n = 0; n < total; n++) {
      var order = aps.map(function (_, k) { return k; }).sort(function (p, q) { return (flats[q][n] - flats[p][n]) || (p - q); });
      bestAp.push(order.length && best[n] >= a.dead_zone_dbm ? order[0] : -1);
      if (bestAp[n] >= 0) { blend[n] = 100; }
      if (order.length < 2) { continue; }
      var top = flats[order[0]][n];
      if (bestAp[n] >= 0) { secondAp[n] = order[1]; margin[n] = top - flats[order[1]][n]; }
      var usable = order.filter(function (k) { return flats[k][n] >= a.overlap_min_dbm && flats[k][n] >= top - a.overlap_margin_db; });
      if (usable.length >= 2) {
        overlapCells[n] = true;
        zone[n] = zoneIds.indexOf("overlap");
        for (i = 0; i < usable.length; i++) { for (j = i + 1; j < usable.length; j++) { bump(pairCells, usable[i], usable[j]); } }
      }
      var second = flats[order[1]][n];
      if (top >= a.roam_min_dbm && second >= a.roam_min_dbm && top - second <= a.roam_margin_db) {
        roamCells[n] = true; bump(roamPairs, order[0], order[1]);
        zone[n] = zoneIds.indexOf("handoff");
        blend[n] = 50 + 50 * Math.min(top - second, a.roam_margin_db) / a.roam_margin_db;
      }
    }
    function pairList(map) {
      return Object.keys(map).map(function (k) { return k.split(",").map(Number).concat([map[k]]); })
        .sort(function (p, q) { return (p[0] - q[0]) || (p[1] - q[1]); })
        .map(function (p) { return { a: aps[p[0]].id, b: aps[p[1]].id, cells: p[2], area_m2: roundTo(p[2] * area, 2) }; });
    }
    var rates = best.map(function (v, k) {
      var ap = aps[bestAp[k]];
      return bestAp[k] >= 0 ? throughputMbps(config, v, ap.band, tableWidth(config, ap)) : 0;
    });
    var perAp = aps.map(function (ap, idx) {
      var served = rates.filter(function (r, k) { return bestAp[k] === idx && r > 0; });
      var usableMbps = served.length ? served.length / served.reduce(function (s, r) { return s + 1 / r; }, 0) : 0;
      var servedArea = served.length * area, clients = a.client_density_per_100m2 * servedArea / 100;
      return { id: ap.id, band: ap.band, channel: ap.channel, width_mhz: ap.width_mhz, served_cells: served.length,
               served_area_m2: roundTo(servedArea, 2), usable_mbps: roundTo(usableMbps, 1),
               client_capacity: Math.floor(usableMbps / a.per_client_demand_mbps), expected_clients: roundTo(clients, 1),
               own: usableMbps > 0 ? clients * a.per_client_demand_mbps / usableMbps : 0 };
    });
    aps.forEach(function (ap, idx) {
      var col = Math.min(cols - 1, Math.max(0, Math.floor(ap.x / cellM))), row = Math.min(rows - 1, Math.max(0, Math.floor(ap.y / cellM)));
      var neighbours = [], shared = perAp[idx].own;
      aps.forEach(function (o, k) {
        if (k !== idx && o.band === ap.band && o.channel === ap.channel && o.grid[row][col] >= a.carrier_sense_dbm) {
          neighbours.push(o.id); shared += perAp[k].own;
        }
      });
      perAp[idx].own_utilisation_pct = roundTo(100 * perAp[idx].own, 1);
      perAp[idx].cochannel_neighbours = neighbours;
      perAp[idx].channel_utilisation_pct = roundTo(100 * shared, 1);
      perAp[idx].saturated = shared >= 1;
    });
    perAp.forEach(function (e) { delete e.own; });
    var weak = qualityCounts[a.weak_band_id], deadCells = dead.filter(Boolean).length;
    var overlapN = overlapCells.filter(Boolean).length, roamN = roamCells.filter(Boolean).length;
    var pct = function (k) { return roundTo(100 * k / total, 1); };
    var qualityPct = {};
    Object.keys(qualityCounts).forEach(function (k) { qualityPct[k] = pct(qualityCounts[k]); });
    var rateRows = [], bestRows = [], secondRows = [], marginRows = [], zoneRows = [], blendRows = [];
    function round1Or(v) { return v === null ? null : roundTo(v, 1); }
    for (var r = 0; r < rows; r++) {
      secondRows.push(secondAp.slice(r * cols, (r + 1) * cols));
      marginRows.push(margin.slice(r * cols, (r + 1) * cols).map(round1Or));
      zoneRows.push(zone.slice(r * cols, (r + 1) * cols));
      blendRows.push(blend.slice(r * cols, (r + 1) * cols).map(round1Or));
      rateRows.push(rates.slice(r * cols, (r + 1) * cols).map(function (v) { return roundTo(v, 1); }));
      bestRows.push(bestAp.slice(r * cols, (r + 1) * cols));
    }
    var result = {
      label: ANALYTICS_LABEL, cell_m: cellM, cols: cols, rows: rows,
      coverage_pct: total ? pct(best.filter(function (v) { return v >= a.coverage_dbm; }).length) : 0,
      quality_pct: qualityPct,
      avg_rssi_dbm: total ? roundTo(best.reduce(function (s, v) { return s + v; }, 0) / total, 1) : a.dead_zone_dbm,
      weak_area_m2: roundTo(weak * area, 2), weak_area_pct: pct(weak),
      dead_zone_area_m2: roundTo(deadCells * area, 2), dead_zone_pct: pct(deadCells),
      dead_zones: regionsOf(dead, cols, rows, cellM), best_ap: bestRows,
      overlap: { cells: overlapN, area_m2: roundTo(overlapN * area, 2), pct: pct(overlapN), pairs: pairList(pairCells) },
      roaming: { cells: roamN, area_m2: roundTo(roamN * area, 2), pct: pct(roamN), pairs: pairList(roamPairs),
                 zones: regionsOf(roamCells, cols, rows, cellM),
                 map: { label: config.roaming.label, zone_ids: zoneIds, second_ap: secondRows, margin_db: marginRows, zone: zoneRows, blend_pct: blendRows } },
      throughput_mbps: rateRows,
      mean_throughput_mbps: total ? roundTo(rates.reduce(function (s, v) { return s + v; }, 0) / total, 1) : 0,
      aps: perAp, total_client_capacity: perAp.reduce(function (s, e) { return s + e.client_capacity; }, 0)
    };
    if (aps.some(function (ap) { return ap.standard !== undefined; })) { result.sinr = sinrSection(aps, bestAp, flats, cols, rows, config, mloGrids, external, cellM); }
    if (placedClients && placedClients.length) { result.clients = clientCapacitySection(placedClients, aps, bestAp, best, cols, rows, cellM, config); }
    return result;
  }

  // ---------------------------------------------------------------- v2 data models (ESTIMATES)
  // Mirror of the "v2 data models" section of wallhack/rfmodel.py: derived material fields, AP class profiles,
  // and the OFDMA, MU-MIMO and beamforming CAPACITY MODELS with the Smart Home client section.
  var CLIENT_LABEL = "CAPACITY MODEL: client demand against estimated link rates, OFDMA, MU-MIMO and beamforming are planning models, not measurements";
  var MATERIAL_BAND_FIELDS = { "2.4": "attenuation24GHz", "5": "attenuation5GHz", "6": "attenuation6GHz" };
  function has(obj, key) { return Object.prototype.hasOwnProperty.call(obj, String(key)); }

  function dbToPowerFraction(lossDb) { return Math.pow(10, -lossDb / 10); }

  /** Derived, read-only material fields (rfmodel.material_fields): attenuationNGHz in dB, penetrationRate and reflectionRate as power fractions at `band`. */
  function materialFields(config, material, band) {
    band = band || DEFAULT_BAND;
    if (!config.bands[band]) { throw new Error("band must be one of " + Object.keys(config.bands).join(", ")); }
    var out = {};
    Object.keys(MATERIAL_BAND_FIELDS).forEach(function (b) { out[MATERIAL_BAND_FIELDS[b]] = has(material.attenuation_db, b) ? material.attenuation_db[b] : null; });
    out.penetrationRate = roundTo(dbToPowerFraction(material.attenuation_db[band]), 4);
    out.reflectionRate = roundTo(dbToPowerFraction(material.reflection_loss_db[band]), 4);
    return out;
  }

  /** A copy of `ap` with the radio fields of a generic class profile (rfmodel.apply_ap_profile). */
  function applyApProfile(config, ap, profileId, band) {
    var profiles = config.ap_profiles.profiles;
    if (!has(profiles, profileId)) { throw new Error("profile must be one of " + Object.keys(profiles).join(", ")); }
    var profile = profiles[profileId], chosen = band || profile.band;
    if (profile.bands.indexOf(chosen) < 0) { throw new Error("profile '" + profileId + "' supports the bands " + profile.bands.join(", ")); }
    var out = {};
    ["id", "x", "y", "name"].forEach(function (k) { if (ap[k] !== undefined) { out[k] = ap[k]; } });
    out.tx_dbm = profile.tx_dbm[chosen]; out.band = chosen; out.standard = profile.standard;
    out.spatial_streams = profile.spatial_streams; out.antenna_gain_dbi = profile.antenna_gain_dbi;
    out.pattern = profile.pattern; out.beamforming = profile.beamforming; out.profile = profileId;
    return out;
  }

  function apStreams(config, ap) { return ap.spatial_streams || defaultStreams(config, ap.standard); }

  function ofdmaCapacityGain(config, standard, nClients) {
    var m = config.capacity_models.ofdma;
    if (standard === undefined || !has(m.gain_by_standard, standard) || nClients < 2) { return 1.0; }
    return 1.0 + m.gain_by_standard[standard] * Math.min(1.0, (nClients - 1) / m.saturation_clients);
  }

  function muMimoUsers(config, standard, streams, nClients) {
    var limits = config.capacity_models.mu_mimo.max_users_by_standard;
    if (standard === undefined || !has(limits, standard) || nClients < 1) { return 1; }
    return Math.max(1, Math.min(nClients, streams, limits[standard]));
  }

  function muMimoCapacityGain(config, users) { return 1.0 + (users - 1) * config.capacity_models.mu_mimo.spatial_efficiency; }

  function beamformingGainDb(config, ap) {
    var m = config.capacity_models.beamforming;
    if (!ap.beamforming || m.standards.indexOf(ap.standard) < 0) { return 0.0; }
    return Math.min(m.max_gain_db, m.array_gain_db_per_doubling * Math.log2(apStreams(config, ap)) * m.steering_efficiency);
  }

  /** Smart Home client demand against estimated links (rfmodel.client_capacity_section). */
  function clientCapacitySection(clients, aps, bestAp, best, cols, rows, cellM, config) {
    var devices = config.client_devices.devices, attached = {}, entries = [];
    clients.forEach(function (c) {
      var dev = devices[c.device];
      var col = Math.min(cols - 1, Math.max(0, Math.floor(c.x / cellM))), row = Math.min(rows - 1, Math.max(0, Math.floor(c.y / cellM)));
      var n = row * cols + col, i = bestAp[n];
      var entry = { id: c.id, device: c.device, ap: i >= 0 ? aps[i].id : null, status: "ok", rssi_dbm: roundTo(best[n], 1),
                    beamforming_gain_db: 0.0, link_mbps: 0.0, demand_mbps: dev.demand_mbps, airtime_pct: 0.0, delivered_mbps: 0.0, satisfied: false };
      var airtime = 0;
      entries.push(entry);
      if (i < 0) { entry.status = "no_coverage"; return; }
      if (dev.bands.indexOf(aps[i].band) < 0) { entry.status = "band_unsupported"; return; }
      var gain = beamformingGainDb(config, aps[i]);
      var link = throughputMbps(config, best[n] + gain, aps[i].band, tableWidth(config, aps[i]));
      if (link <= 0) { entry.status = "no_link"; return; }
      entry.beamforming_gain_db = roundTo(gain, 2); entry.link_mbps = roundTo(link, 1);
      airtime = dev.demand_mbps / link;
      (attached[i] = attached[i] || []).push({ entry: entry, airtime: airtime });
    });
    var perAp = aps.map(function (ap, i) {
      var members = attached[i] || [], standard = ap.standard;
      var users = muMimoUsers(config, standard, standard !== undefined ? apStreams(config, ap) : 1, members.length);
      var ofdma = ofdmaCapacityGain(config, standard, members.length), mu = muMimoCapacityGain(config, users);
      var raw = members.reduce(function (s, m) { return s + m.airtime; }, 0), load = raw / (ofdma * mu);
      members.forEach(function (m) {
        m.entry.airtime_pct = roundTo(100.0 * m.airtime / (ofdma * mu), 1);
        m.entry.delivered_mbps = roundTo(m.entry.demand_mbps / Math.max(1.0, load), 2);
        m.entry.satisfied = load <= 1.0;
      });
      return { id: ap.id, clients: members.length, demand_mbps: roundTo(members.reduce(function (s, m) { return s + m.entry.demand_mbps; }, 0), 2),
               raw_airtime_pct: roundTo(100.0 * raw, 1), ofdma_gain: roundTo(ofdma, 3), mu_mimo_users: users,
               mu_mimo_gain: roundTo(mu, 3), airtime_pct: roundTo(100.0 * load, 1), saturated: load > 1.0 };
    });
    return { label: CLIENT_LABEL, clients: entries, aps: perAp,
             demand_mbps: roundTo(entries.reduce(function (s, e) { return s + e.demand_mbps; }, 0), 2),
             delivered_mbps: roundTo(entries.reduce(function (s, e) { return s + e.delivered_mbps; }, 0), 2),
             satisfied_pct: entries.length ? roundTo(100.0 * entries.filter(function (e) { return e.satisfied; }).length / entries.length, 1) : 0.0 };
  }

  /** coverageGrid, apGrids and analytics for one floor in one call (like rfmodel.analyze_floor). */
  function analyzeFloor(project, floorId, opts) { return analyzeFloorWithGrid(project, floorId, opts).analytics; }

  /** Same as analyzeFloor, but also returns the best-signal coverageGrid it computed, so callers need not compute it again. */
  function analyzeFloorWithGrid(project, floorId, opts) {
    var o = optionsOf({ env: opts.env, config: opts.config, project: project, cellM: opts.cellM, band: opts.band,
                        mode: opts.mode });
    var shared = { env: o.env, cellM: o.cellM, band: opts.band, mode: o.mode };
    var mloGrids = {};
    project.floors.forEach(function (f) {
      f.aps.forEach(function (ap) {
        if (!ap.mlo_bands || !ap.mlo_bands.length) { return; }
        mloGrids[ap.id] = {};
        ap.mlo_bands.forEach(function (b) {
          mloGrids[ap.id][b] = apGrids(project, floorId, { env: o.env, cellM: o.cellM, band: b, mode: o.mode, aps: [{ ap: ap, floor: f }] })[0].grid;
        });
      });
    });
    var external = resolveInterferers(project, o.env.config).map(function (src) {
      var pseudo = { id: src.id, x: src.x, y: src.y, tx_dbm: src.tx_dbm, band: src.band };
      var grid = apGrids(project, floorId, { env: o.env, cellM: o.cellM, band: src.band, mode: o.mode, aps: [{ ap: pseudo, floor: findFloor(project, src.floor) }] })[0].grid;
      return Object.assign({}, src, { grid: [].concat.apply([], grid) });
    });
    var grid = coverageGrid(project, floorId, shared);
    return { analytics: analytics(grid, apGrids(project, floorId, shared), o.env.config, mloGrids, external, findFloor(project, floorId).clients), grid: grid };
  }

  /** (walls, openings) crossed by the straight path p->q; a crossing through an opening counts as an opening. */
  function obstructions(env, prep, px, py, qx, qy) {
    var walls = 0, openings = 0;
    prep.walls.forEach(function (w) {
      var along = rayWallHit(env, px, py, qx, qy, w);
      if (along === null) { return; }
      var inOpening = w.openings.some(function (o) { return o.from <= along && along <= o.to; });
      if (inOpening) { openings++; } else { walls++; }
    });
    return { walls: walls, openings: openings };
  }

  /** Level (dBm) of `ap` on `apFloor` at (x, y) of `floor`, floor loss with voids included. cache holds the floor preparation. */
  function levelAt(env, floor, ap, apFloor, x, y, band, mode, cache) {
    var key = floor.id + "|" + band;
    var prep = cache[key] || (cache[key] = prepareFloor(env, floor, band, false));
    var ctx = { env: env, prep: prep, ap: ap, band: band, reflectors: null };
    if (mode !== DEFAULT_MODE) { ctx.reflectors = reflectorsNear(env, prep, ap.x, ap.y); }
    var apart = Math.abs(apFloor.level - floor.level);
    return modes[mode](ctx, x, y) - floorPenetrationDb(env.config, ap, apFloor, floor, x, y, apart, band);
  }

  /**
   * Point probe for hover tooltips (like rfmodel.probe_at): RSSI, best AP, distance, obstruction count,
   * throughput ESTIMATE. opts: {env | config, band, mode, explain}. With explain the result gains an "explain" entry.
   */
  function probeAt(project, floorId, x, y, opts) {
    var o = optionsOf({ env: opts.env, config: opts.config, project: project, band: opts.band, mode: opts.mode });
    var env = o.env, cfg = env.config, floor = findFloor(project, floorId), cache = {};
    var best = null;
    project.floors.forEach(function (f) {
      f.aps.forEach(function (ap) {
        var band = checkBand(env, o.band || ap.band || DEFAULT_BAND);
        var rssi = round1(levelAt(env, floor, ap, f, x, y, band, o.mode, cache));
        if (!best || rssi > best.rssi) { best = { rssi: rssi, ap: ap, floor: f, band: band, prep: cache[floor.id + "|" + band], apart: Math.abs(f.level - floor.level) }; }
      });
    });
    var out = { x: x, y: y, floor: floorId, label: ANALYTICS_LABEL };
    if (!best) {
      return Object.assign(out, { rssi_dbm: cfg.engine.no_signal_dbm, quality: qualityBand(cfg, cfg.engine.no_signal_dbm),
        ap_id: null, distance_m: null, walls_crossed: 0, openings_crossed: 0, floors_crossed: 0, throughput_mbps: 0 });
    }
    var rssi = Math.max(best.rssi, cfg.engine.no_signal_dbm), ob = obstructions(env, best.prep, best.ap.x, best.ap.y, x, y);
    var radio = apRadio(cfg, best.ap, best.band);
    Object.assign(out, { rssi_dbm: rssi, quality: qualityBand(cfg, rssi), ap_id: best.ap.id,
      distance_m: roundTo(Math.hypot(x - best.ap.x, y - best.ap.y), cfg.analytics.probe_distance_decimals),
      walls_crossed: ob.walls, openings_crossed: ob.openings, floors_crossed: best.apart,
      throughput_mbps: roundTo(throughputMbps(cfg, rssi, best.band,
        best.ap.standard !== undefined ? legacyTableWidth(cfg, best.band, radio.width) : radio.width), 1) });
    if (opts.explain) { out.explain = explainPoint(env, project, floor, best.ap, best.floor, x, y, best.band, o.mode, rssi, cache); }
    return out;
  }

  // ---------------------------------------------------------------- explanation of one point (MODEL)
  var EXPLAIN_LABEL = "MODEL ESTIMATE: explanation of the modelled level at one point, each term is a typical planning value, not a measurement";

  /** One decimal, rounded half up first so the text matches rfmodel._f1. */
  function f1(v) { return roundTo(v, 1).toFixed(1); }

  function explainSinr(env, project, floor, ap, apFloor, x, y, band, mode, rssi, cache) {
    var cfg = env.config, interf = cfg.interference, radio = apRadio(cfg, ap, band);
    var std = ap.standard || interf.fallback_standard[band];
    var noise = noiseFloorDbm(cfg, radio.width), terms = [], powerMw = 0;
    project.floors.forEach(function (f) {
      f.aps.forEach(function (other) {
        var ob = other.band || DEFAULT_BAND;
        if (other === ap || ob !== band) { return; }
        var oRadio = apRadio(cfg, other, ob);
        var coupling = interferenceCoupling(cfg, band, radio.channel, radio.width, oRadio.channel, oRadio.width);
        if (coupling <= 0) { return; }
        var level = roundTo(levelAt(env, floor, other, f, x, y, ob, mode, cache), 1);
        var mw = coupling * interf.activity_factor * Math.pow(10, level / 10);
        powerMw += mw;
        terms.push({ id: other.id, kind: "ap", level_dbm: level, coupling: roundTo(coupling, 4), duty_cycle: interf.activity_factor,
                     power_dbm: roundTo(10 * Math.log10(mw), 1) });
      });
    });
    resolveInterferers(project, cfg).forEach(function (src) {
      var coupling = externalCoupling(cfg, src, band, radio.channel, radio.width);
      if (coupling <= 0) { return; }
      var pseudo = { id: src.id, x: src.x, y: src.y, tx_dbm: src.tx_dbm, band: src.band };
      var level = roundTo(levelAt(env, floor, pseudo, findFloor(project, src.floor), x, y, src.band, mode, cache), 1);
      var mw = coupling * src.duty_cycle * Math.pow(10, level / 10);
      powerMw += mw;
      terms.push({ id: src.id, kind: src.kind, level_dbm: level, coupling: roundTo(coupling, 4), duty_cycle: src.duty_cycle,
                   power_dbm: roundTo(10 * Math.log10(mw), 1) });
    });
    var sinr = rssi - 10 * Math.log10(Math.pow(10, noise / 10) + powerMw);
    var mcs = highestMcs(cfg, std, sinr);
    var streams = ap.spatial_streams !== undefined ? ap.spatial_streams : defaultStreams(cfg, std);
    var rate = sinrPhyRateMbps(cfg, std, sinr, radio.width, streams) * cfg.analytics.mac_efficiency;
    var rel = linkReliability(cfg, std, sinr, rate, 0);
    return { standard: std, noise_floor_dbm: roundTo(noise, 1), interference: terms, sinr_db: roundTo(sinr, 1), mcs: mcs,
             throughput_mbps: roundTo(rate, 1), per_pct: roundTo(rel.per_pct, 2), latency_ms: roundTo(rel.latency_ms, 1),
             loss_pct: roundTo(rel.loss_pct, 3), label: SINR_LABEL };
  }

  /** Every term of the level of `ap` at (x, y), in numbers and text (rfmodel._explain). */
  function explainPoint(env, project, floor, ap, apFloor, x, y, band, mode, rssi, cache) {
    var cfg = env.config, prep = cache[floor.id + "|" + band];
    var apart = Math.abs(apFloor.level - floor.level);
    var d = Math.hypot(x - ap.x, y - ap.y), gain = antennaGainToward(cfg, ap, x, y), path = pathLoss(env, band, d);
    var walls = [];
    prep.walls.forEach(function (w) {
      var along = rayWallHit(env, ap.x, ap.y, x, y, w);
      if (along === null) { return; }
      var loss = w.loss, through = "wall";
      for (var k = 0; k < w.openings.length; k++) {
        if (w.openings[k].from <= along && along <= w.openings[k].to) { loss = w.openings[k].loss; through = w.openings[k].kind; break; }
      }
      walls.push({ wall: w.id, material: w.material, material_label: w.label, through: through, loss_db: roundTo(loss, 2) });
    });
    var wallsDb = walls.reduce(function (sum, w) { return sum + w.loss_db; }, 0);
    var floorFull = cfg.floor_loss_db[band] * floorsCrossed(cfg, apFloor, floor, apart), floorDb = floorPenetrationDb(cfg, ap, apFloor, floor, x, y, apart, band);
    var total = roundTo(path, 2) + wallsDb + roundTo(floorDb, 2);
    var direct = ap.tx_dbm + gain - total;
    var indirect = [];
    if (mode !== DEFAULT_MODE) {
      var ctx = { env: env, prep: prep, ap: ap, band: band, reflectors: reflectorsNear(env, prep, ap.x, ap.y) }, detail = [];
      indirectLevels(ctx, x, y, detail);
      detail.forEach(function (p) {
        var level = p.level - floorDb;
        if (p.kind === "reflection") {
          var mat = env.materials[p.ref.material];
          indirect.push({ type: "reflection", wall: p.ref.id, material: p.ref.material, material_label: mat.label,
                          reflection_loss_db: mat.reflection_loss_db[band], level_dbm: roundTo(level, 1) });
        } else {
          indirect.push({ type: "diffraction", corner: [p.ref[0], p.ref[1]],
                          knife_edge_loss_db: roundTo(knifeEdgeFor(env, ap, band, p.ref, x, y), 2), level_dbm: roundTo(level, 1) });
        }
      });
    }
    var dominant = "direct", dominantLevel = direct;
    indirect.forEach(function (e) {
      if (e.level_dbm > dominantLevel) { dominantLevel = e.level_dbm; dominant = e.type + (e.type === "reflection" ? " via " + e.wall : ""); }
    });
    var out = { label: EXPLAIN_LABEL, ap_id: ap.id, band: band, mode: mode, distance_m: roundTo(d, 2), tx_dbm: ap.tx_dbm,
                antenna_gain_db: roundTo(gain, 2), eirp_dbm: roundTo(ap.tx_dbm + gain, 2), path_loss_db: roundTo(path, 2),
                walls: walls, walls_loss_db: roundTo(wallsDb, 2), floors_crossed: apart, floor_loss_db: roundTo(floorDb, 2),
                floor_loss_without_voids_db: roundTo(floorFull, 2), total_loss_db: roundTo(total, 2), direct_dbm: roundTo(direct, 2),
                indirect: indirect, dominant_path: dominant, rssi_dbm: rssi };
    var lines = ["Strongest AP " + ap.id + " on " + band + " GHz, " + mode + " mode, " + f1(d) + " m away.",
                 "Transmit " + f1(ap.tx_dbm) + " dBm plus antenna gain " + f1(gain) + " dB gives " + f1(ap.tx_dbm + gain) + " dBm EIRP.",
                 "Path loss " + f1(path) + " dB at " + f1(d) + " m (log-distance, exponent " + cfg.bands[band].path_loss_exponent + ")."];
    walls.forEach(function (w) {
      lines.push("Crosses " + (w.through !== "wall" ? w.through + " in wall " + w.wall : "wall " + w.wall) + " (" + w.material_label + "): " + f1(w.loss_db) + " dB.");
    });
    if (!walls.length) { lines.push("Crosses no walls."); }
    if (apart) {
      lines.push("Floor loss " + f1(floorDb) + " dB for " + apart + " floor(s)" + (floorDb < floorFull ? " (reduced by a stairwell or atrium opening)" : "") + ".");
    }
    lines.push("Total loss " + f1(total) + " dB, so the direct path arrives at " + f1(direct) + " dBm.");
    indirect.forEach(function (e) {
      if (e.type === "reflection") {
        lines.push("Reflection off wall " + e.wall + " (" + e.material_label + ", reflection loss " + f1(e.reflection_loss_db) + " dB) arrives at " + f1(e.level_dbm) + " dBm.");
      } else {
        lines.push("Diffraction around the corner at (" + f1(e.corner[0]) + ", " + f1(e.corner[1]) + ") m (knife edge " + f1(e.knife_edge_loss_db) + " dB) arrives at " + f1(e.level_dbm) + " dBm.");
      }
    });
    if (mode === "multipath") { lines.push("Multipath adds the powers of all paths: " + f1(rssi) + " dBm (strongest path: " + dominant + ")."); }
    else if (mode === "enhanced") { lines.push("Enhanced takes the strongest path (" + dominant + "): " + f1(rssi) + " dBm."); }
    else { lines.push("Basic mode uses the direct path only: " + f1(rssi) + " dBm."); }
    var anyStandard = project.floors.some(function (f) { return f.aps.some(function (a) { return !!a.standard; }); });
    if (ap.standard || anyStandard) {
      var sinr = explainSinr(env, project, floor, ap, apFloor, x, y, band, mode, rssi, cache);
      out.sinr = sinr;
      lines.push("Noise floor " + f1(sinr.noise_floor_dbm) + " dBm.");
      sinr.interference.forEach(function (t) {
        lines.push("Interference from " + t.id + " (" + t.kind + "): " + f1(t.power_dbm) + " dBm after coupling " + t.coupling + " and duty cycle " + t.duty_cycle + ".");
      });
      lines.push("SINR " + f1(sinr.sinr_db) + " dB" + (sinr.mcs !== null
        ? ", MCS " + sinr.mcs + ", about " + f1(sinr.throughput_mbps) + " Mbps, packet error " + sinr.per_pct + " %, latency " + f1(sinr.latency_ms) + " ms (estimates)."
        : ", below the lowest MCS: no usable link."));
    }
    out.text = lines;
    return out;
  }

  // ---------------------------------------------------------------- spectrum analysis and signal decay (ESTIMATES)
  /** Id of the first congestion level whose max the value does not exceed (rfmodel.congestion_level). */
  function congestionLevel(config, congestion) {
    var levels = config.spectrum.levels;
    for (var i = 0; i < levels.length; i++) { if (levels[i].max === null || congestion <= levels[i].max) { return levels[i].id; } }
    throw new Error("spectrum levels need a closing level with max null");
  }

  /** Channel occupancy, overlap and congestion of one band with channel suggestions (rfmodel.spectrum_analysis). */
  function spectrumAnalysis(project, band, opts) {
    opts = opts || {};
    var config = opts.config || opts.env.config, spec = config.spectrum;
    if (!config.bands[band]) { throw new Error("band must be one of " + Object.keys(config.bands).join(", ")); }
    var width = opts.widthMhz !== undefined && opts.widthMhz !== null ? opts.widthMhz : spec.width_mhz[band];
    if (config.bands[band].widths_mhz.indexOf(width) < 0) { throw new Error("width_mhz must be one of " + config.bands[band].widths_mhz.join(", ") + " on the " + band + " GHz band"); }
    var sources = [];
    project.floors.forEach(function (f) {
      f.aps.forEach(function (ap) {
        if ((ap.band || DEFAULT_BAND) === band && ap.id !== opts.excludeAp) {
          var radio = apRadio(config, ap, band);
          sources.push({ id: ap.id, kind: "ap", band: band, channel: radio.channel, width_mhz: radio.width, duty_cycle: config.interference.activity_factor });
        }
      });
    });
    resolveInterferers(project, config).forEach(function (src) { if (src.band === band) { sources.push(src); } });
    var channels = config.bands[band].channels.map(function (channel) {
      var centre = channelCentreMhz(config, band, channel), entries = [], congestion = 0;
      sources.forEach(function (src) {
        var coupling = externalCoupling(config, src, band, channel, width);
        if (coupling <= 0) { return; }
        var span = sourceSpanMhz(config, src);
        entries.push({ id: src.id, kind: src.kind, coupling: roundTo(coupling, 4),
                       overlap_mhz: roundTo(Math.max(0, Math.min(centre + width / 2, span[1]) - Math.max(centre - width / 2, span[0])), 1) });
        congestion += coupling * src.duty_cycle;
      });
      return { channel: channel, centre_mhz: centre, sources: entries, overlapping_sources: entries.length, congestion: roundTo(congestion, 3),
               occupancy_pct: roundTo(100 * Math.min(1, congestion), 1), level: congestionLevel(config, congestion), raw: congestion };
    });
    var preferred = spec.preferred_channels && spec.preferred_channels[band];
    var candidates = channels.filter(function (c) { return !preferred || preferred.indexOf(c.channel) >= 0; });
    var ranked = candidates.map(function (c, i) { return i; }).sort(function (p, q) { return (candidates[p].raw - candidates[q].raw) || (p - q); });
    var suggestions = ranked.slice(0, spec.suggestions).map(function (i) {
      return { channel: candidates[i].channel, congestion: candidates[i].congestion, level: candidates[i].level };
    });
    channels.forEach(function (c) { delete c.raw; });
    return { label: spec.label, band: band, width_mhz: width, channels: channels, suggestions: suggestions };
  }

  /** RSSI against distance along a ray from an AP (rfmodel.signal_decay). opts: {env | config, floorId, band, mode, stepM, maxDistanceM}. */
  function signalDecay(project, apId, bearingDeg, opts) {
    var o = optionsOf({ env: opts.env, config: opts.config, project: project, band: opts.band, mode: opts.mode });
    var env = o.env, cfg = env.config, found = null;
    project.floors.forEach(function (f) { f.aps.forEach(function (a) { if (a.id === apId && !found) { found = { ap: a, floor: f }; } }); });
    if (!found) { throw new Error("unknown AP id '" + apId + "'"); }
    var floor = findFloor(project, opts.floorId || found.floor.id), ap = found.ap;
    var band = checkBand(env, o.band || ap.band || DEFAULT_BAND);
    var step = opts.stepM !== undefined ? opts.stepM : cfg.decay.step_m, limit = opts.maxDistanceM !== undefined ? opts.maxDistanceM : cfg.decay.max_distance_m;
    if (step <= 0 || limit <= 0 || limit / step > cfg.decay.max_samples) {
      throw new Error("step_m and max_distance_m must be positive and give at most " + cfg.decay.max_samples + " samples");
    }
    var cache = {}, prep = prepareFloor(env, floor, band, false);
    var rad = bearingDeg * (Math.PI / 180), dx = Math.cos(rad), dy = Math.sin(rad), samples = [];
    for (var k = 0; k <= Math.floor(limit / step); k++) {
      var d = k * step, x = ap.x + dx * d, y = ap.y + dy * d;
      if (!(x >= 0 && x <= floor.width_m && y >= 0 && y <= floor.depth_m)) { break; }
      var ob = obstructions(env, prep, ap.x, ap.y, x, y);
      samples.push({ distance_m: roundTo(d, 2), rssi_dbm: roundTo(Math.max(cfg.engine.no_signal_dbm, levelAt(env, floor, ap, found.floor, x, y, band, o.mode, cache)), 1),
                     distance_only_dbm: roundTo(ap.tx_dbm + antennaGainToward(cfg, ap, x, y) - pathLoss(env, band, d), 1),
                     walls_crossed: ob.walls, openings_crossed: ob.openings });
    }
    return { label: cfg.decay.label, ap_id: apId, floor: floor.id, band: band, mode: o.mode, bearing_deg: bearingDeg, step_m: step, samples: samples };
  }

  // ---------------------------------------------------------------- scenario comparison
  /**
   * Optimisation score of an analytics result: a weighted sum of estimates, higher is better. Weights
   * live in config.scoring. Returns the total and a breakdown that explains it.
   */
  function scoreAnalytics(result, config) {
    var s = config.scoring, w = s.weights;
    var rssiNorm = Math.min(1, Math.max(0, (result.avg_rssi_dbm - s.rssi_floor_dbm) / (s.rssi_ceiling_dbm - s.rssi_floor_dbm)));
    var parts = [
      { id: "coverage", value: result.coverage_pct / 100, sign: 1 },
      { id: "mean_rssi", value: rssiNorm, sign: 1 },
      { id: "dead_zone", value: result.dead_zone_pct / 100, sign: -1 },
      { id: "overlap", value: result.overlap.pct / 100, sign: -1 },
      { id: "ap_count", value: Math.min(1, result.aps.length / s.ap_count_full_penalty), sign: -1 }
    ].map(function (p) {
      return { id: p.id, value: roundTo(p.value, 3), weight: w[p.id], contribution: roundTo(p.sign * w[p.id] * p.value, 2) };
    });
    var total = parts.reduce(function (sum, p) { return sum + p.contribution; }, 0);
    return { score: roundTo(total, 2), breakdown: parts, label: s.label };
  }

  /**
   * Before/after comparison of two projects on one floor: per-cell dB delta grid (b minus a), coverage,
   * dead-zone, throughput and AP-count deltas, and both optimisation scores with breakdowns.
   * opts: {env | config, floorId, cellM, band, mode}.
   */
  function compareScenarios(a, b, opts) {
    var o = optionsOf({ env: opts.env, config: opts.config, project: a, cellM: opts.cellM, band: opts.band, mode: opts.mode });
    var floorId = opts.floorId;
    function run(project) {
      var s = { env: makeEnv(o.env.config, project.materials), cellM: o.cellM, band: opts.band, mode: o.mode };
      var grid = coverageGrid(project, floorId, s);
      var an = analytics(grid, apGrids(project, floorId, s), s.env.config);
      return { grid: grid, analytics: an, score: scoreAnalytics(an, s.env.config) };
    }
    var ra = run(a), rb = run(b);
    if (ra.grid.cols !== rb.grid.cols || ra.grid.rows !== rb.grid.rows) { throw new Error("scenarios must have the same floor size"); }
    var delta = ra.grid.rssi.map(function (row, r) { return row.map(function (v, c) { return roundTo(rb.grid.rssi[r][c] - v, 1); }); });
    var diff = function (k) { return roundTo(rb.analytics[k] - ra.analytics[k], 2); };
    return { label: o.env.config.scoring.label, delta_db: delta, a: ra, b: rb,
             coverage_delta_pct: diff("coverage_pct"), mean_rssi_delta_db: diff("avg_rssi_dbm"),
             dead_zone_delta_m2: diff("dead_zone_area_m2"), mean_throughput_delta_mbps: diff("mean_throughput_mbps"),
             ap_count_delta: rb.analytics.aps.length - ra.analytics.aps.length,
             score_delta: roundTo(rb.score.score - ra.score.score, 2) };
  }

  var api = { makeEnv: makeEnv, registerMode: registerMode, registerMaterials: registerMaterials, modeIds: modeIds,
              prepareFloor: prepareFloor, wallLoss: wallLoss, gridAxes: gridAxes, computeApGrid: computeApGrid, computeApRegion: computeApRegion,
              mergeBest: mergeBest, coverageGrid: coverageGrid, apGrids: apGrids, analytics: analytics,
              analyzeFloor: analyzeFloor, analyzeFloorWithGrid: analyzeFloorWithGrid, probeAt: probeAt, scoreAnalytics: scoreAnalytics,
              compareScenarios: compareScenarios, phyRateMbps: phyRateMbps, throughputMbps: throughputMbps,
              qualityBand: qualityBand, antennaGainDb: antennaGainDb, noiseFloorDbm: noiseFloorDbm,
              standardPhyRateMbps: standardPhyRateMbps, sinrPhyRateMbps: sinrPhyRateMbps, interferenceCoupling: interferenceCoupling,
              mloCapacityMbps: mloCapacityMbps, roundTo: roundTo, findFloor: findFloor,
              resolveInterferers: resolveInterferers, externalCoupling: externalCoupling, packetErrorRate: packetErrorRate,
              linkReliability: linkReliability, spectrumAnalysis: spectrumAnalysis, signalDecay: signalDecay,
              inVoid: inVoid, floorPenetrationDb: floorPenetrationDb, apRadio: apRadio, sourceSpanMhz: sourceSpanMhz,
              channelCentreMhz: channelCentreMhz,
              floorsCrossed: floorsCrossed, materialFields: materialFields, applyApProfile: applyApProfile,
              ofdmaCapacityGain: ofdmaCapacityGain, muMimoUsers: muMimoUsers, muMimoCapacityGain: muMimoCapacityGain,
              beamformingGainDb: beamformingGainDb, clientCapacitySection: clientCapacitySection };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  root.RFEngine = api;
})(typeof self !== "undefined" ? self : this);
