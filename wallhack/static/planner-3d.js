"use strict";
// Planner 3D building view. MODEL ESTIMATE, not a measurement, and NOT a 3D propagation simulation:
// every floor shows its own 2D result from rf-engine.js, and the slices between floors are interpolated
// from those 2D results (linear in dB with the height fraction). The engine floor loss is already inside
// each 2D grid. See docs/platform/adr-3d-view.md for why this is in-house WebGL plus a canvas projection
// and not three.js.
//
// Pure parts (floor stack, camera, projection, slicing, volume interpolation, scene model, tour poses,
// text description) run under node for tests. Browser parts: a small WebGL renderer (textured quads and
// lines), a canvas 2D projection renderer used when WebGL is missing or lost, keyboard, mouse and touch
// controls, and the "3D view" tab. World axes: x = plan x, y = height (up), z = plan y.
(function (root) {
  var NEAR = 0.1, FAR_FACTOR = 8, FOV_RAD = 0.9;
  var PITCH_MIN = -1.2, PITCH_MAX = 1.45, YAW_START = -0.7, PITCH_START = 0.55;
  var DIST_MIN_FACTOR = 0.15, DIST_MAX_FACTOR = 4;
  var ORBIT_KEY_RAD = 0.12, ZOOM_KEY = 1.12, FLY_KEY_FRACTION = 0.06, ORBIT_DRAG_RAD_PER_PX = 0.008, WHEEL_ZOOM = 1.0015;
  var RSSI_MIN = -100;            // dBm at or below which a texel is transparent (same range as planner-heat.js)
  var FLOOR_ALPHA = 0.88, SLICE_ALPHA = 0.22, SLAB_COLOR = [148, 163, 184, 0.16], SLAB_EDGE = [148, 163, 184, 0.9];
  var WALL_COLOR = [226, 232, 240, 0.95], VOID_COLOR = [251, 191, 36, 0.95], AP_COLOR = [45, 212, 191, 1], MESH_COLOR = [167, 139, 250, 1];
  var AP_CROSS_M = 0.4, SLICE_COLOR = [56, 189, 248, 0.9];
  var TOUR_VIEWS = 6, TOUR_SECONDS = 24, EPS = 1e-6;

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function round(v, d) { var s = Math.pow(10, d === undefined ? 1 : d); return Math.round(v * s) / s; }

  // ------------------------------------------------------------------ floor stack
  /**
   * Floors sorted bottom to top with their elevation. A floor without elevation_m sits at level times
   * floor_elevation.reference_height_m, the same rule the engine uses for floor loss.
   * @param {any} project @param {any} config rf-config.json
   * @returns {Array<{id:string,name:string,level:number,elevation_m:number,height_m:number,width_m:number,depth_m:number,basement:boolean,floor:any}>}
   */
  function floorLevels(project, config) {
    var ref = config.floor_elevation.reference_height_m;
    var list = project.floors.map(function (f) {
      var z = f.elevation_m !== undefined ? f.elevation_m : f.level * ref;
      return { id: f.id, name: f.name || f.id, level: f.level, elevation_m: z, height_m: f.height_m || ref, width_m: f.width_m, depth_m: f.depth_m, basement: z < 0, floor: f };
    });
    list.sort(function (a, b) { return a.elevation_m - b.elevation_m; });
    // a wall must not poke through the slab above: limit the drawn height to the gap to the next floor
    var slab = config.planner_3d.slab_thickness_m;
    list.forEach(function (l, i) {
      var next = list[i + 1];
      l.draw_height_m = next ? Math.max(slab * 2, Math.min(l.height_m, next.elevation_m - l.elevation_m - slab)) : l.height_m;
    });
    return list;
  }

  /** Axis aligned box of the whole building: {minX,maxX,minY,maxY,minZ,maxZ}. */
  function buildingBounds(levels) {
    var b = { minX: 0, maxX: 1, minY: Infinity, maxY: -Infinity, minZ: 0, maxZ: 1 };
    levels.forEach(function (l) {
      b.maxX = Math.max(b.maxX, l.width_m); b.maxZ = Math.max(b.maxZ, l.depth_m);
      b.minY = Math.min(b.minY, l.elevation_m); b.maxY = Math.max(b.maxY, l.elevation_m + l.draw_height_m);
    });
    if (!isFinite(b.minY)) { b.minY = 0; b.maxY = 3; }
    return b;
  }

  function diagonal(b) { return Math.sqrt(Math.pow(b.maxX - b.minX, 2) + Math.pow(b.maxY - b.minY, 2) + Math.pow(b.maxZ - b.minZ, 2)); }

  // ------------------------------------------------------------------ camera
  /** An orbit camera looking at the middle of the building. yaw and pitch in radians, dist in metres. */
  function defaultCamera(b) {
    return { yaw: YAW_START, pitch: PITCH_START, dist: diagonal(b) * 1.1, fov: FOV_RAD,
             target: [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2] };
  }

  function copyCamera(c) { return { yaw: c.yaw, pitch: c.pitch, dist: c.dist, fov: c.fov, target: c.target.slice() }; }

  function limitCamera(c, b) {
    var d = diagonal(b), pad = d * 0.5;
    c.pitch = clamp(c.pitch, PITCH_MIN, PITCH_MAX);
    c.dist = clamp(c.dist, d * DIST_MIN_FACTOR, d * DIST_MAX_FACTOR);
    c.yaw = ((c.yaw + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    c.target = [clamp(c.target[0], b.minX - pad, b.maxX + pad), clamp(c.target[1], b.minY - pad, b.maxY + pad), clamp(c.target[2], b.minZ - pad, b.maxZ + pad)];
    return c;
  }

  /** New camera orbited by dYaw and dPitch (radians). Pitch is limited so the view never flips. */
  function orbitCamera(cam, dYaw, dPitch, b) { var c = copyCamera(cam); c.yaw += dYaw; c.pitch += dPitch; return limitCamera(c, b); }
  /** New camera with the distance multiplied by `factor` (below 1 moves closer). */
  function zoomCamera(cam, factor, b) { var c = copyCamera(cam); c.dist *= factor; return limitCamera(c, b); }

  /** Eye position and orthonormal basis {eye, right, up, fwd} (arrays of 3). */
  function cameraBasis(cam) {
    var cp = Math.cos(cam.pitch), eye = [cam.target[0] + cam.dist * cp * Math.sin(cam.yaw), cam.target[1] + cam.dist * Math.sin(cam.pitch), cam.target[2] + cam.dist * cp * Math.cos(cam.yaw)];
    var f = normalize([cam.target[0] - eye[0], cam.target[1] - eye[1], cam.target[2] - eye[2]]);
    var r = normalize(cross3(f, [0, 1, 0])), u = cross3(r, f);
    return { eye: eye, right: r, up: u, fwd: f };
  }
  function cross3(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function normalize(a) { var l = Math.sqrt(dot3(a, a)) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

  /**
   * Fly the camera: move the target along the ground-plane forward and right directions and straight up.
   * Each argument is in steps (-1, 0, 1); one step is a fraction of the building size.
   */
  function flyCamera(cam, forward, right, up, b) {
    var c = copyCamera(cam), step = diagonal(b) * FLY_KEY_FRACTION, fx = -Math.sin(cam.yaw), fz = -Math.cos(cam.yaw), rx = Math.cos(cam.yaw), rz = -Math.sin(cam.yaw);
    c.target[0] += (fx * forward + rx * right) * step; c.target[2] += (fz * forward + rz * right) * step; c.target[1] += up * step;
    return limitCamera(c, b);
  }

  /**
   * Project a world point to canvas pixels. Writes {x, y, depth, scale} into `out` and returns false when the
   * point is behind the camera. `view` is {w, h} in pixels. Pure and allocation light, used by the canvas
   * renderer and checked against the WebGL matrix in the tests.
   */
  function project(p, cam, view, out, basis) {
    var B = basis || cameraBasis(cam), vx = p[0] - B.eye[0], vy = p[1] - B.eye[1], vz = p[2] - B.eye[2];
    var depth = vx * B.fwd[0] + vy * B.fwd[1] + vz * B.fwd[2];
    if (depth <= NEAR) { return false; }
    var f = 1 / Math.tan(cam.fov / 2), aspect = view.w / view.h;
    var xc = vx * B.right[0] + vy * B.right[1] + vz * B.right[2], yc = vx * B.up[0] + vy * B.up[1] + vz * B.up[2];
    out.x = (f * xc / (depth * aspect) * 0.5 + 0.5) * view.w; out.y = (1 - (f * yc / depth * 0.5 + 0.5)) * view.h;
    out.depth = depth; out.scale = f / depth * view.h * 0.5;
    return true;
  }

  /** Column-major 4x4 view-projection matrix (Float32Array(16)) for WebGL, same camera model as project(). */
  function viewProjection(cam, aspect, b) {
    var B = cameraBasis(cam), f = 1 / Math.tan(cam.fov / 2), far = diagonal(b) * FAR_FACTOR, n = NEAR;
    var rows = [[B.right[0], B.right[1], B.right[2], -dot3(B.right, B.eye)], [B.up[0], B.up[1], B.up[2], -dot3(B.up, B.eye)],
                [-B.fwd[0], -B.fwd[1], -B.fwd[2], dot3(B.fwd, B.eye)], [0, 0, 0, 1]];
    var P = [[f / aspect, 0, 0, 0], [0, f, 0, 0], [0, 0, (far + n) / (n - far), 2 * far * n / (n - far)], [0, 0, -1, 0]];
    var m = new Float32Array(16);
    for (var r = 0; r < 4; r++) { for (var c = 0; c < 4; c++) { var s = 0; for (var k = 0; k < 4; k++) { s += P[r][k] * rows[k][c]; } m[c * 4 + r] = s; } }
    return m;
  }

  /** Camera pose k of n for the fly-through: a spiral that descends through the stack. t in [0,1]. */
  function tourPose(t, b) {
    var u = clamp(t, 0, 1), base = defaultCamera(b), d = diagonal(b);
    var c = copyCamera(base);
    c.yaw = YAW_START + u * Math.PI * 1.5; c.pitch = 0.9 - u * 0.75; c.dist = d * (1.2 - u * 0.45);
    c.target = [base.target[0], b.maxY - u * (b.maxY - b.minY), base.target[2]];
    return limitCamera(c, b);
  }
  /** Poses for reduced motion: the tour as TOUR_VIEWS fixed viewpoints, stepped with a button. */
  function tourViewCount() { return TOUR_VIEWS; }
  function tourSeconds() { return TOUR_SECONDS; }

  // ------------------------------------------------------------------ grids and volume (interpolated, NOT simulated)
  /** Cell counts of a grid reduced to at most `max` cells on the long side, never below 2. */
  function fitCells(cols, rows, max) {
    var s = Math.min(1, max / Math.max(cols, rows));
    return { cols: Math.max(2, Math.round(cols * s)), rows: Math.max(2, Math.round(rows * s)) };
  }

  /** Bilinear resample of a coverageGrid() result (rssi[row][col]) to outCols x outRows, as a Float32Array in dBm. */
  function resample(grid, outCols, outRows) {
    var out = new Float32Array(outCols * outRows);
    for (var j = 0; j < outRows; j++) {
      var gy = clamp((j + 0.5) / outRows * grid.rows - 0.5, 0, grid.rows - 1), y0 = Math.floor(gy), y1 = Math.min(grid.rows - 1, y0 + 1), fy = gy - y0;
      for (var i = 0; i < outCols; i++) {
        var gx = clamp((i + 0.5) / outCols * grid.cols - 0.5, 0, grid.cols - 1), x0 = Math.floor(gx), x1 = Math.min(grid.cols - 1, x0 + 1), fx = gx - x0;
        var top = grid.rssi[y0][x0] * (1 - fx) + grid.rssi[y0][x1] * fx, bot = grid.rssi[y1][x0] * (1 - fx) + grid.rssi[y1][x1] * fx;
        out[j * outCols + i] = top * (1 - fy) + bot * fy;
      }
    }
    return out;
  }

  /**
   * Per-floor 2D results on one common resolution so floors can be blended.
   * @param {Array} levels floorLevels() @param {Object<string,any>} grids coverageGrid() result by floor id
   * @returns {{cols:number, rows:number, cells:Object<string,Float32Array>, ids:string[]}} ids are the floors that have a grid, bottom to top
   */
  function prepareVolume(levels, grids, config) {
    var ids = levels.filter(function (l) { return grids[l.id]; }).map(function (l) { return l.id; });
    var max = config.planner_3d.texture_max_cells, big = ids.reduce(function (m, id) { return grids[id].cols * grids[id].rows > m.cols * m.rows ? grids[id] : m; }, { cols: 0, rows: 0 });
    var fit = ids.length ? fitCells(big.cols, big.rows, max) : { cols: 2, rows: 2 }, cells = {};
    ids.forEach(function (id) { cells[id] = resample(grids[id], fit.cols, fit.rows); });
    return { cols: fit.cols, rows: fit.rows, cells: cells, ids: ids };
  }

  /**
   * RSSI cells of the horizontal slice at height z (metres). On a floor the slice is that floor's 2D result.
   * Between two floors it is the blend, linear in dB with the height fraction. Above the top floor and below
   * the lowest there is no data and the result is null: nothing is extrapolated.
   * @returns {null|{z:number, kind:"floor"|"interpolated", from:string, to:string, t:number, width_m:number, depth_m:number, cols:number, rows:number, cells:Float32Array}}
   */
  function sliceAt(levels, vol, z) {
    var L = levels.filter(function (l) { return vol.cells[l.id]; });
    if (!L.length || z < L[0].elevation_m - EPS || z > L[L.length - 1].elevation_m + EPS) { return null; }
    for (var i = 0; i < L.length; i++) {
      if (Math.abs(z - L[i].elevation_m) <= EPS) { return { z: z, kind: "floor", from: L[i].id, to: L[i].id, t: 0, width_m: L[i].width_m, depth_m: L[i].depth_m, cols: vol.cols, rows: vol.rows, cells: vol.cells[L[i].id] }; }
    }
    for (var k = 0; k < L.length - 1; k++) {
      var lo = L[k], hi = L[k + 1];
      if (z > lo.elevation_m && z < hi.elevation_m) {
        var t = (z - lo.elevation_m) / (hi.elevation_m - lo.elevation_m), a = vol.cells[lo.id], c = vol.cells[hi.id], out = new Float32Array(a.length);
        for (var n = 0; n < a.length; n++) { out[n] = a[n] * (1 - t) + c[n] * t; }
        return { z: z, kind: "interpolated", from: lo.id, to: hi.id, t: t, width_m: lo.width_m + (hi.width_m - lo.width_m) * t, depth_m: lo.depth_m + (hi.depth_m - lo.depth_m) * t,
                 cols: vol.cols, rows: vol.rows, cells: out };
      }
    }
    return null;
  }

  /** The translucent slices that stack between each pair of neighbouring floors (perGap per gap, not the floors themselves). */
  function volumeSlices(levels, vol, perGap) {
    var L = levels.filter(function (l) { return vol.cells[l.id]; }), out = [];
    for (var k = 0; k < L.length - 1; k++) {
      for (var s = 1; s <= perGap; s++) {
        var z = L[k].elevation_m + (L[k + 1].elevation_m - L[k].elevation_m) * s / (perGap + 1), sl = sliceAt(levels, vol, z);
        if (sl) { out.push(sl); }
      }
    }
    return out;
  }

  /** Value in dBm of a slice at plan point (x, y) metres, nearest cell. */
  function sliceValueAt(slice, x, y) {
    var i = clamp(Math.floor(x / slice.width_m * slice.cols), 0, slice.cols - 1), j = clamp(Math.floor(y / slice.depth_m * slice.rows), 0, slice.rows - 1);
    return slice.cells[j * slice.cols + i];
  }

  /** RGBA bytes (Uint8Array) of cells: `colorOf(rssi)` gives [r,g,b]; texels at or below -100 dBm are transparent. */
  function pixelsFromCells(cells, colorOf, alpha) {
    var px = new Uint8Array(cells.length * 4);
    for (var i = 0; i < cells.length; i++) {
      var c = colorOf(cells[i]); px[i * 4] = c[0]; px[i * 4 + 1] = c[1]; px[i * 4 + 2] = c[2]; px[i * 4 + 3] = cells[i] <= RSSI_MIN ? 0 : Math.round(255 * alpha);
    }
    return px;
  }

  // ------------------------------------------------------------------ scene model (pure)
  function quadCorners(w, d, y) { return [[0, y, 0], [w, y, 0], [w, y, d], [0, y, d]]; }
  function addLine(lines, a, b, color) { lines.push({ a: a, b: b, color: color }); }
  function boxEdges(lines, w, d, y0, y1, color) {
    var c0 = quadCorners(w, d, y0), c1 = quadCorners(w, d, y1);
    for (var i = 0; i < 4; i++) { addLine(lines, c0[i], c0[(i + 1) % 4], color); addLine(lines, c1[i], c1[(i + 1) % 4], color); addLine(lines, c0[i], c1[i], color); }
  }

  /**
   * Everything the renderers draw, as plain data: textured quads (floor heat maps, slabs, translucent
   * volume slices, the slicing plane) and coloured lines (slab edges, walls, floor openings, access
   * points, mesh links). `version` changes whenever the data changes so renderers can reuse textures.
   * @param {any} project @param {any} config
   * @param {{levels:Array, vol:any, colorOf:function(number):number[], sliceZ:(number|null), showVolume:boolean, showWalls:boolean, showAps:boolean, version:number}} o
   */
  function buildScene(project, config, o) {
    var c3 = config.planner_3d, levels = o.levels, quads = [], lines = [], slab = c3.slab_thickness_m;
    levels.forEach(function (l) {
      var f = l.floor, y = l.elevation_m;
      quads.push({ id: "slab-" + l.id, kind: "slab", corners: quadCorners(l.width_m, l.depth_m, y - slab), color: SLAB_COLOR });
      boxEdges(lines, l.width_m, l.depth_m, y - slab, y, SLAB_EDGE);
      if (o.vol && o.vol.cells[l.id]) {
        quads.push({ id: "floor-" + l.id, kind: "floor", corners: quadCorners(l.width_m, l.depth_m, y + 0.01), cols: o.vol.cols, rows: o.vol.rows, pixels: pixelsFromCells(o.vol.cells[l.id], o.colorOf, FLOOR_ALPHA) });
      }
      if (o.showWalls) {
        f.walls.forEach(function (w) {
          var top = y + l.draw_height_m;
          addLine(lines, [w.x1, y, w.y1], [w.x2, y, w.y2], WALL_COLOR); addLine(lines, [w.x1, top, w.y1], [w.x2, top, w.y2], WALL_COLOR);
          addLine(lines, [w.x1, y, w.y1], [w.x1, top, w.y1], WALL_COLOR); addLine(lines, [w.x2, y, w.y2], [w.x2, top, w.y2], WALL_COLOR);
        });
      }
      (f.voids || []).forEach(function (v) {
        var pts = v.points || v.pts || [];
        pts.forEach(function (p, i) { var q = pts[(i + 1) % pts.length]; addLine(lines, [p[0] !== undefined ? p[0] : p.x, y + 0.02, p[1] !== undefined ? p[1] : p.y], [q[0] !== undefined ? q[0] : q.x, y + 0.02, q[1] !== undefined ? q[1] : q.y], VOID_COLOR); });
      });
    });
    var apPos = {};
    levels.forEach(function (l) {
      l.floor.aps.forEach(function (a) { apPos[a.id] = [a.x, l.elevation_m + c3.ap_height_m, a.y]; });
    });
    if (o.showAps) {
      levels.forEach(function (l) {
        l.floor.aps.forEach(function (a) {
          var p = apPos[a.id], r = AP_CROSS_M;
          addLine(lines, [p[0], l.elevation_m, p[2]], p, AP_COLOR);
          addLine(lines, [p[0] - r, p[1], p[2]], [p[0] + r, p[1], p[2]], AP_COLOR); addLine(lines, [p[0], p[1] - r, p[2]], [p[0], p[1] + r, p[2]], AP_COLOR); addLine(lines, [p[0], p[1], p[2] - r], [p[0], p[1], p[2] + r], AP_COLOR);
          if (a.mesh_parent !== undefined && apPos[a.mesh_parent]) { addLine(lines, p, apPos[a.mesh_parent], MESH_COLOR); }
        });
      });
    }
    if (o.showVolume && o.vol) {
      volumeSlices(levels, o.vol, c3.slices_per_gap).forEach(function (s, i) {
        quads.push({ id: "volume-" + i, kind: "volume", corners: quadCorners(s.width_m, s.depth_m, s.z), cols: s.cols, rows: s.rows, pixels: pixelsFromCells(s.cells, o.colorOf, SLICE_ALPHA) });
      });
    }
    var plane = (o.sliceZ === null || o.sliceZ === undefined || !o.vol) ? null : sliceAt(levels, o.vol, o.sliceZ);
    if (plane) {
      quads.push({ id: "plane", kind: "plane", corners: quadCorners(plane.width_m, plane.depth_m, plane.z), cols: plane.cols, rows: plane.rows, pixels: pixelsFromCells(plane.cells, o.colorOf, 0.8) });
      var pc = quadCorners(plane.width_m, plane.depth_m, plane.z);
      for (var i = 0; i < 4; i++) { addLine(lines, pc[i], pc[(i + 1) % 4], SLICE_COLOR); }
    }
    quads.forEach(function (q) { q.centre = [0, 1, 2].map(function (k) { return (q.corners[0][k] + q.corners[1][k] + q.corners[2][k] + q.corners[3][k]) / 4; }); });
    return { levels: levels, bounds: buildingBounds(levels), quads: quads, lines: lines, plane: plane, version: o.version || 0 };
  }

  /** Quads ordered far to near for the camera, so translucent layers blend correctly (painter's algorithm). */
  function sortBackToFront(quads, cam) {
    var eye = cameraBasis(cam).eye;
    function d2(q) { var dx = q.centre[0] - eye[0], dy = q.centre[1] - eye[1], dz = q.centre[2] - eye[2]; return dx * dx + dy * dy + dz * dz; }
    return quads.slice().sort(function (a, b) { return d2(b) - d2(a); });
  }

  /** Group lines by colour for batched drawing: [{color, verts: Float32Array}]. */
  function batchLines(lines) {
    var groups = {}, order = [];
    lines.forEach(function (l) {
      var key = l.color.join(",");
      if (!groups[key]) { groups[key] = { color: l.color, list: [] }; order.push(key); }
      groups[key].list.push(l.a[0], l.a[1], l.a[2], l.b[0], l.b[1], l.b[2]);
    });
    return order.map(function (k) { return { color: groups[k].color, verts: new Float32Array(groups[k].list) }; });
  }

  // ------------------------------------------------------------------ text alternative
  /**
   * Plain-language description of the building and the slicing plane, for screen readers and for the
   * canvas fallback. `analyses` maps floor id to {coverage_pct, dead_zone_pct}.
   */
  function describeBuilding(project, levels, config, analyses, slice, probe) {
    var lines = [config.planner_3d.label + "."];
    var basements = levels.filter(function (l) { return l.basement; }).length;
    lines.push(levels.length + " floors" + (basements ? ", " + basements + " below ground" : "") + " from " + round(levels[0].elevation_m) + " m to " + round(levels[levels.length - 1].elevation_m) + " m.");
    levels.slice().reverse().forEach(function (l) {
      var an = analyses && analyses[l.id], aps = l.floor.aps.map(function (a) { return a.id; });
      lines.push(l.name + " at " + round(l.elevation_m) + " m: " + l.width_m + " by " + l.depth_m + " m, " + (aps.length ? aps.length + (aps.length === 1 ? " access point (" : " access points (") + aps.join(", ") + ")" : "no access points") +
                 (an ? ", " + an.coverage_pct + "% covered, " + an.dead_zone_pct + "% dead zone" : "") + ".");
    });
    if (slice) {
      lines.push("Slicing plane at " + round(slice.z) + " m: " + (slice.kind === "floor" ? "the 2D result of floor " + slice.from + "." :
        "interpolated, " + Math.round((1 - slice.t) * 100) + "% " + slice.from + " and " + Math.round(slice.t * 100) + "% " + slice.to + ", not a 3D simulation.") +
        (probe ? " At " + round(probe.x) + " m, " + round(probe.y) + " m the plane reads about " + round(sliceValueAt(slice, probe.x, probe.y)) + " dBm." : ""));
    } else { lines.push("Slicing plane at this height has no data: nothing is extrapolated above the top floor or below the lowest."); }
    return lines;
  }

  // ------------------------------------------------------------------ renderers (browser)
  var VERT = "attribute vec3 a_pos; attribute vec2 a_uv; uniform mat4 u_mvp; varying vec2 v_uv; void main() { v_uv = a_uv; gl_Position = u_mvp * vec4(a_pos, 1.0); }";
  var FRAG = "precision mediump float; varying vec2 v_uv; uniform sampler2D u_tex; uniform vec4 u_color; uniform float u_use_tex; void main() { vec4 c = u_color; if (u_use_tex > 0.5) { c = texture2D(u_tex, v_uv); } gl_FragColor = c; }";
  var QUAD_UV = [[0, 0], [1, 0], [1, 1], [0, 1]], QUAD_TRIS = [0, 1, 2, 0, 2, 3];

  /** WebGL renderer, or null when WebGL is not available. Draw order: sorted translucent quads, then lines. No depth test. */
  function createGlRenderer(canvas, onLost) {
    var gl = null;
    try { gl = canvas.getContext("webgl", { antialias: true, alpha: true, premultipliedAlpha: false }); } catch (e) { gl = null; }
    if (!gl) { return null; }
    function compile(type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null; }
    var vs = compile(gl.VERTEX_SHADER, VERT), fs = compile(gl.FRAGMENT_SHADER, FRAG), prog = gl.createProgram();
    if (!vs || !fs) { return null; }
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { return null; }
    var loc = { pos: gl.getAttribLocation(prog, "a_pos"), uv: gl.getAttribLocation(prog, "a_uv"), mvp: gl.getUniformLocation(prog, "u_mvp"), tex: gl.getUniformLocation(prog, "u_tex"),
                color: gl.getUniformLocation(prog, "u_color"), useTex: gl.getUniformLocation(prog, "u_use_tex") };
    var buf = gl.createBuffer(), textures = {}, batches = null, batchVersion = -1, lost = false;
    canvas.addEventListener("webglcontextlost", function (e) { e.preventDefault(); lost = true; if (onLost) { onLost(); } }, false);

    function texture(q, version) {
      var t = textures[q.id];
      if (t && t.version === version) { return t.tex; }
      if (!t) { t = textures[q.id] = { tex: gl.createTexture(), version: -1 }; }
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, q.cols, q.rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, q.pixels);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      t.version = version;
      return t.tex;
    }
    function draw(scene, cam) {
      if (lost) { return; }
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(prog);
      gl.uniformMatrix4fv(loc.mvp, false, viewProjection(cam, canvas.width / canvas.height, scene.bounds));
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(loc.pos); gl.enableVertexAttribArray(loc.uv);
      gl.vertexAttribPointer(loc.pos, 3, gl.FLOAT, false, 20, 0); gl.vertexAttribPointer(loc.uv, 2, gl.FLOAT, false, 20, 12);
      sortBackToFront(scene.quads, cam).forEach(function (q) {
        var v = new Float32Array(30);
        QUAD_TRIS.forEach(function (ci, n) { var p = q.corners[ci], uv = QUAD_UV[ci]; v.set([p[0], p[1], p[2], uv[0], uv[1]], n * 5); });
        gl.bufferData(gl.ARRAY_BUFFER, v, gl.DYNAMIC_DRAW);
        if (q.pixels) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture(q, scene.version)); gl.uniform1i(loc.tex, 0); gl.uniform1f(loc.useTex, 1); }
        else { gl.uniform1f(loc.useTex, 0); gl.uniform4f(loc.color, q.color[0] / 255, q.color[1] / 255, q.color[2] / 255, q.color[3]); }
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      });
      if (batchVersion !== scene.version || !batches) { batches = batchLines(scene.lines); batchVersion = scene.version; }
      gl.uniform1f(loc.useTex, 0);
      batches.forEach(function (b) {
        var v = new Float32Array(b.verts.length / 3 * 5);
        for (var i = 0, n = b.verts.length / 3; i < n; i++) { v[i * 5] = b.verts[i * 3]; v[i * 5 + 1] = b.verts[i * 3 + 1]; v[i * 5 + 2] = b.verts[i * 3 + 2]; }
        gl.bufferData(gl.ARRAY_BUFFER, v, gl.DYNAMIC_DRAW);
        gl.uniform4f(loc.color, b.color[0] / 255, b.color[1] / 255, b.color[2] / 255, b.color[3]);
        gl.drawArrays(gl.LINES, 0, b.verts.length / 3);
      });
    }
    /** Wait for the GPU to finish the last draw (reads one pixel). Only used by tools/perf_3d.py to time frames. */
    function finish() { gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); }
    return { kind: "webgl", draw: draw, finish: finish };
  }

  /** Canvas 2D projection renderer, the fallback. Textured quads are drawn as a coarse grid of projected cells. */
  function createCanvasRenderer(canvas, config) {
    var ctx = canvas.getContext("2d");
    if (!ctx) { return null; }
    var cells = config.planner_3d.canvas_fallback_cells, pt = { x: 0, y: 0, depth: 0, scale: 0 };
    function toScreen(p, cam, view, B) { return project(p, cam, view, pt, B) ? [pt.x, pt.y] : null; }
    function cellColors(q) {
      if (q._cells && q._cellsFor === q.pixels) { return q._cells; }
      var nx = Math.min(cells, q.cols), ny = Math.min(cells, q.rows), out = [];
      for (var j = 0; j < ny; j++) { for (var i = 0; i < nx; i++) {
        var sx = Math.min(q.cols - 1, Math.floor((i + 0.5) / nx * q.cols)), sy = Math.min(q.rows - 1, Math.floor((j + 0.5) / ny * q.rows)), o = (sy * q.cols + sx) * 4;
        out.push(q.pixels[o + 3] ? "rgba(" + q.pixels[o] + "," + q.pixels[o + 1] + "," + q.pixels[o + 2] + "," + (q.pixels[o + 3] / 255).toFixed(2) + ")" : null);
      } }
      q._cells = { nx: nx, ny: ny, colors: out }; q._cellsFor = q.pixels;
      return q._cells;
    }
    function lerpPt(c, u, v) {
      var a = [c[0][0] + (c[1][0] - c[0][0]) * u, c[0][1] + (c[1][1] - c[0][1]) * u, c[0][2] + (c[1][2] - c[0][2]) * u], b = [c[3][0] + (c[2][0] - c[3][0]) * u, c[3][1] + (c[2][1] - c[3][1]) * u, c[3][2] + (c[2][2] - c[3][2]) * u];
      return [a[0] + (b[0] - a[0]) * v, a[1] + (b[1] - a[1]) * v, a[2] + (b[2] - a[2]) * v];
    }
    function draw(scene, cam) {
      var view = { w: canvas.width, h: canvas.height }, B = cameraBasis(cam);
      ctx.clearRect(0, 0, view.w, view.h);
      sortBackToFront(scene.quads, cam).forEach(function (q) {
        if (!q.pixels) {
          var s = q.corners.map(function (p) { return toScreen(p, cam, view, B); });
          if (s.some(function (p) { return !p; })) { return; }
          ctx.fillStyle = "rgba(" + q.color[0] + "," + q.color[1] + "," + q.color[2] + "," + q.color[3] + ")"; ctx.beginPath();
          s.forEach(function (p, i) { if (i) { ctx.lineTo(p[0], p[1]); } else { ctx.moveTo(p[0], p[1]); } }); ctx.fill();
          return;
        }
        var cc = cellColors(q);
        for (var j = 0; j < cc.ny; j++) { for (var i = 0; i < cc.nx; i++) {
          var col = cc.colors[j * cc.nx + i];
          if (!col) { continue; }
          var corners = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]].map(function (uv) { return toScreen(lerpPt(q.corners, uv[0] / cc.nx, uv[1] / cc.ny), cam, view, B); });
          if (corners.some(function (p) { return !p; })) { continue; }
          ctx.fillStyle = col; ctx.beginPath();
          corners.forEach(function (p, n) { if (n) { ctx.lineTo(p[0], p[1]); } else { ctx.moveTo(p[0], p[1]); } }); ctx.fill();
        } }
      });
      ctx.lineWidth = Math.max(1, view.w / 700);
      scene.lines.forEach(function (l) {
        var a = toScreen(l.a, cam, view, B), b = a && toScreen(l.b, cam, view, B);
        if (!a || !b) { return; }
        ctx.strokeStyle = "rgba(" + l.color[0] + "," + l.color[1] + "," + l.color[2] + "," + l.color[3] + ")"; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      });
    }
    return { kind: "canvas", draw: draw };
  }

  // ------------------------------------------------------------------ tab (browser only)
  function prefersReducedMotion() { return !!(root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches); }

  function mount(app) {
    var P = root.PlannerPanels, H = root.PlannerHeat, E_ = root.RFEngine, doc = root.document, el = P.el, c3 = app.config.planner_3d;
    if (!c3 || !app.tabs) { return; }
    var panel = app.tabs.add("view3d", "3D view");
    var st = { levels: [], vol: null, grids: {}, analyses: {}, cam: null, scene: null, renderer: null, sliceZ: 0, volume: true, walls: true, aps: true, version: 0, dirty: false, active: false,
               tour: null, tourStep: 0, reduced: prefersReducedMotion(), timer: 0, computing: 0, pointers: {}, lastPinch: 0 };
    var canvas = el("canvas", { id: "view3dCanvas", class: "view3d-canvas", tabindex: "0", role: "img", "aria-describedby": "view3dText", "aria-label": "3D view of the building floors with the signal map. Drag to orbit, scroll or pinch to zoom, arrow keys orbit, W A S D Q E fly, plus and minus zoom, Home resets." });
    var chip = el("span", { id: "view3dRenderer", class: "chip", role: "status", text: "3D renderer: starting" });
    var msg = el("p", { id: "view3dMsg", class: "muted", role: "status", "aria-live": "polite" });
    var text = el("div", { id: "view3dText", class: "view3d-text", role: "region", "aria-label": "Text description of the 3D view", "aria-live": "polite" });
    var slider = el("input", { id: "view3dSlice", type: "range", min: "0", max: "3", step: "0.1", value: "0", "aria-label": "Slicing plane height in metres" });
    var sliceOut = el("output", { id: "view3dSliceOut", for: "view3dSlice" });

    function check(id, label, key, on) {
      var box = el("input", { id: id, type: "checkbox" }); box.checked = on;
      box.addEventListener("change", function () { st[key] = box.checked; rebuild(); });
      return el("label", { class: "check" }, [box, doc.createTextNode(" " + label)]);
    }
    var tourBtn = P.button("Fly-through", function () { toggleTour(); }, { id: "view3dTour" });
    var tools = el("div", { class: "tool-row" }, [P.button("Reset view", function () { st.cam = defaultCamera(boundsNow()); stopTour(); invalidate(); }, { id: "view3dReset" }), tourBtn,
      P.button("Refresh", function () { compute(); }, { id: "view3dRefresh" }), chip]);
    panel.appendChild(el("p", { class: "muted hint", text: c3.label + ". Floors come from the elevation model; the signal between floors is blended from the two floor maps and includes the floor loss of each map." }));
    panel.appendChild(tools);
    panel.appendChild(el("div", { class: "checks" }, [check("view3dVolume", "Signal volume (translucent slices between floors, interpolated)", "volume", true), check("view3dWalls", "Walls", "walls", true), check("view3dAps", "Access points and mesh links", "aps", true)]));
    panel.appendChild(el("div", { class: "tool-row" }, [el("label", { class: "field", for: "view3dSlice" }, [doc.createTextNode("Slicing plane height (m) ")]), slider, sliceOut]));
    panel.appendChild(msg); panel.appendChild(canvas); panel.appendChild(text);

    function boundsNow() { return st.scene ? st.scene.bounds : buildingBounds(st.levels.length ? st.levels : floorLevels(app.store.project, app.config)); }
    function colorOf(rssi) { return H.colorAt(app.paletteId || "classic", rssi); }

    function setRenderer() {
      var r = null;
      if (!/[?&]renderer=canvas2d/.test(root.location.search)) { r = createGlRenderer(canvas, function () { st.renderer = null; useCanvas("WebGL context lost"); }); }
      if (r) { st.renderer = r; chip.textContent = "3D renderer: WebGL"; return; }
      useCanvas("WebGL is not available");
    }
    function useCanvas(reason) {
      // a canvas that already has a webgl context cannot give a 2d context: replace the element
      var fresh = canvas.cloneNode(false); canvas.parentNode.replaceChild(fresh, canvas); canvas = fresh; bindInput();
      st.renderer = createCanvasRenderer(canvas, app.config);
      chip.textContent = st.renderer ? "3D renderer: canvas projection" : "3D renderer: text only";
      st.note = reason + ": drawing a canvas projection" + (st.renderer ? "" : " is not possible either, the text description below carries the same facts") + ".";
      msg.textContent = st.note;
      invalidate();
    }

    function sizeCanvas() {
      var w = Math.max(320, Math.floor(canvas.clientWidth || panel.clientWidth || 640)), h = Math.round(w * 0.6), dpr = Math.min(root.devicePixelRatio || 1, 1.5);
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    }
    function render() {
      st.dirty = false;
      if (!st.active || !st.scene || !st.renderer) { return; }
      sizeCanvas(); st.renderer.draw(st.scene, st.cam);
    }
    function invalidate() {
      if (st.dirty || !st.active) { return; }
      st.dirty = true; root.requestAnimationFrame(render);
    }

    function describe() {
      var probe = app.probe ? { x: app.probe.x, y: app.probe.y } : null, slice = st.scene && st.scene.plane;
      text.textContent = "";
      describeBuilding(app.store.project, st.levels, app.config, st.analyses, slice, probe).forEach(function (l) { text.appendChild(el("p", { text: l })); });
    }
    function rebuild() {
      st.levels = floorLevels(app.store.project, app.config);
      if (!st.levels.length) { return; }
      st.vol = st.vol && Object.keys(st.grids).length ? prepareVolume(st.levels, st.grids, app.config) : null;
      var b = buildingBounds(st.levels);
      slider.min = String(round(b.minY, 1)); slider.max = String(round(Math.max(b.minY + 0.1, st.levels[st.levels.length - 1].elevation_m), 1));
      st.sliceZ = clamp(st.sliceZ, parseFloat(slider.min), parseFloat(slider.max));
      slider.value = String(st.sliceZ); sliceOut.textContent = round(st.sliceZ) + " m";
      st.version += 1;
      st.scene = buildScene(app.store.project, app.config, { levels: st.levels, vol: st.vol, colorOf: colorOf, sliceZ: st.sliceZ, showVolume: st.volume, showWalls: st.walls, showAps: st.aps, version: st.version });
      if (!st.cam) { st.cam = defaultCamera(b); }
      describe(); invalidate();
    }

    function compute() {
      var token = ++st.computing, p = app.store.project, levels = floorLevels(p, app.config), i = 0;
      msg.textContent = "Computing the floor maps for the 3D view...";
      st.grids = {}; st.analyses = {};
      function next() {
        if (token !== st.computing) { return; }
        if (i >= levels.length) { st.vol = {}; rebuild(); msg.textContent = "Ready. MODEL ESTIMATE, not a measurement." + (st.note ? " " + st.note : ""); return; }
        var l = levels[i++], cell = P.analysisCell(l.floor) * 2;
        try {
          var g = E_.coverageGrid(p, l.id, { env: app.env, cellM: cell, band: app.settings.band || undefined, mode: app.settings.mode });
          st.grids[l.id] = g; st.analyses[l.id] = { coverage_pct: g.coverage_pct, dead_zone_pct: round(100 * g.rssi.reduce(function (n, row) { return n + row.filter(function (v) { return v < app.config.analytics.dead_dbm; }).length; }, 0) / (g.cols * g.rows), 1) };
        } catch (e) { msg.textContent = "Could not compute floor " + l.id + ": " + e.message; }
        root.setTimeout(next, 0);
      }
      next();
    }
    function schedule() { if (!st.active) { return; } root.clearTimeout(st.timer); st.timer = root.setTimeout(compute, 400); }

    // ---- input: mouse, touch (pointer events), wheel, keyboard
    function change(cam) { st.cam = cam; stopTour(); invalidate(); }
    function onPointerDown(e) {
      canvas.focus(); st.pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer ids cannot be captured */ } }
      st.lastPinch = 0;
    }
    function onPointerMove(e) {
      var prev = st.pointers[e.pointerId];
      if (!prev || !st.cam) { return; }
      var ids = Object.keys(st.pointers), b = boundsNow();
      if (ids.length >= 2) {
        st.pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
        var a = st.pointers[ids[0]], c = st.pointers[ids[1]], d = Math.hypot(a.x - c.x, a.y - c.y);
        if (st.lastPinch) { change(zoomCamera(st.cam, st.lastPinch / Math.max(d, 1), b)); }
        st.lastPinch = d; return;
      }
      change(orbitCamera(st.cam, -(e.clientX - prev.x) * ORBIT_DRAG_RAD_PER_PX, (e.clientY - prev.y) * ORBIT_DRAG_RAD_PER_PX, b));
      st.pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    }
    function onPointerUp(e) { delete st.pointers[e.pointerId]; st.lastPinch = 0; }
    function onWheel(e) { if (!st.cam) { return; } e.preventDefault(); change(zoomCamera(st.cam, Math.pow(WHEEL_ZOOM, e.deltaY), boundsNow())); }
    function onKey(e) {
      if (!st.cam || e.ctrlKey || e.metaKey || e.altKey) { return; }
      var b = boundsNow(), k = e.key, cam = null;
      if (k === "ArrowLeft") { cam = orbitCamera(st.cam, ORBIT_KEY_RAD, 0, b); } else if (k === "ArrowRight") { cam = orbitCamera(st.cam, -ORBIT_KEY_RAD, 0, b); }
      else if (k === "ArrowUp") { cam = orbitCamera(st.cam, 0, ORBIT_KEY_RAD, b); } else if (k === "ArrowDown") { cam = orbitCamera(st.cam, 0, -ORBIT_KEY_RAD, b); }
      else if (k === "+" || k === "=") { cam = zoomCamera(st.cam, 1 / ZOOM_KEY, b); } else if (k === "-" || k === "_") { cam = zoomCamera(st.cam, ZOOM_KEY, b); }
      else if (k === "w" || k === "W") { cam = flyCamera(st.cam, 1, 0, 0, b); } else if (k === "s" || k === "S") { cam = flyCamera(st.cam, -1, 0, 0, b); }
      else if (k === "a" || k === "A") { cam = flyCamera(st.cam, 0, -1, 0, b); } else if (k === "d" || k === "D") { cam = flyCamera(st.cam, 0, 1, 0, b); }
      else if (k === "q" || k === "Q") { cam = flyCamera(st.cam, 0, 0, -1, b); } else if (k === "e" || k === "E") { cam = flyCamera(st.cam, 0, 0, 1, b); }
      else if (k === "Home") { cam = defaultCamera(b); }
      if (cam) { e.preventDefault(); change(cam); }
    }
    function bindInput() {
      canvas.addEventListener("pointerdown", onPointerDown); canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerup", onPointerUp); canvas.addEventListener("pointercancel", onPointerUp);
      canvas.addEventListener("wheel", onWheel, { passive: false }); canvas.addEventListener("keydown", onKey);
    }

    // ---- fly-through: animated spiral, or stepped viewpoints when motion is reduced
    function stopTour() { if (st.tour) { st.tour = null; tourBtn.textContent = st.reduced ? "Next viewpoint" : "Fly-through"; tourBtn.setAttribute("aria-pressed", "false"); } }
    function toggleTour() {
      var b = boundsNow();
      if (st.reduced) { st.tourStep = (st.tourStep + 1) % tourViewCount(); st.cam = tourPose(st.tourStep / (tourViewCount() - 1), b); invalidate(); msg.textContent = "Viewpoint " + (st.tourStep + 1) + " of " + tourViewCount() + "."; return; }
      if (st.tour) { stopTour(); return; }
      st.tour = { start: 0 }; tourBtn.textContent = "Stop fly-through"; tourBtn.setAttribute("aria-pressed", "true");
      function frame(now) {
        if (!st.tour || !st.active) { return; }
        if (!st.tour.start) { st.tour.start = now; }
        var t = ((now - st.tour.start) / 1000 / tourSeconds()) % 2; st.cam = tourPose(t <= 1 ? t : 2 - t, boundsNow());
        st.dirty = false; render(); root.requestAnimationFrame(frame);
      }
      root.requestAnimationFrame(frame);
    }
    if (st.reduced) { tourBtn.textContent = "Next viewpoint"; tourBtn.title = "Reduced motion is on: steps through fixed viewpoints instead of animating"; }
    else { tourBtn.setAttribute("aria-pressed", "false"); }

    slider.addEventListener("input", function () { st.sliceZ = parseFloat(slider.value); rebuild(); });
    bindInput();
    root.addEventListener("resize", invalidate);
    app.tabs.onSelect("view3d", function () { st.active = true; if (!st.renderer) { setRenderer(); } if (!st.scene || !st.vol) { compute(); } else { rebuild(); } });
    app.store.subscribe(function (ev) { if (ev.source !== "select") { schedule(); } });
    app.view3d = { state: st, compute: compute, rebuild: rebuild, render: render };
  }

  var api = { floorLevels: floorLevels, buildingBounds: buildingBounds, defaultCamera: defaultCamera, orbitCamera: orbitCamera, zoomCamera: zoomCamera, flyCamera: flyCamera,
              cameraBasis: cameraBasis, project: project, viewProjection: viewProjection, tourPose: tourPose, tourViewCount: tourViewCount, fitCells: fitCells, resample: resample,
              prepareVolume: prepareVolume, sliceAt: sliceAt, volumeSlices: volumeSlices, sliceValueAt: sliceValueAt, pixelsFromCells: pixelsFromCells, buildScene: buildScene,
              sortBackToFront: sortBackToFront, batchLines: batchLines, describeBuilding: describeBuilding, createGlRenderer: createGlRenderer, createCanvasRenderer: createCanvasRenderer, mount: mount };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  root.Planner3D = api;
})(typeof self !== "undefined" ? self : this);
