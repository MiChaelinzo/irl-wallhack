"use strict";
// Planner heat-map renderer. MODEL ESTIMATE, not a measurement: the page labels every heat map so.
// Pure parts (colour scales, quality band lookup, marching-squares contours, tooltip text) run under
// node for tests. Browser parts: a WebGL renderer (RSSI grid as an 8-bit texture, colour LUT,
// bilinear smoothing, banded mode and dead-zone hatch in the fragment shader) with a canvas-2D fallback
// that is chosen when WebGL is unavailable or fails, a contour overlay, a legend and a mini-map.
(function (root) {
  var RSSI_MIN = -100, RSSI_MAX = -30;        // dBm range mapped onto the colour scale and the 8-bit texture
  var LUT_SIZE = 256;
  var HATCH_PERIOD_PX = 10, HATCH_WIDTH_PX = 2.5;
  var DEFAULT_OPACITY = 0.72;
  var CONTOUR_LABEL_MIN_PX = 60;
  var BAND_NAMES = { excellent: "Excellent", good: "Good", fair: "Fair", poor: "Poor", none: "No coverage" };
  // Professional RF scales: weak is warm/dark, strong is cool, so a printed or screen-shot map still reads.
  // "classic" follows site-survey tools; "aurora" maps the quality bands to emerald, cyan, amber and crimson; "cvd" is a colour-blind safe (viridis like) ramp.
  var PALETTES = {
    classic: [[-100, "#2b0a3d"], [-90, "#7a1230"], [-85, "#c0392b"], [-75, "#f39c12"], [-65, "#f1e05a"], [-55, "#4cc36b"], [-45, "#1fb5b0"], [-30, "#3b82f6"]],
    aurora: [[-100, "#450a0a"], [-90, "#991b1b"], [-80, "#dc2626"], [-70, "#f59e0b"], [-60, "#22d3ee"], [-48, "#10b981"], [-30, "#059669"]],
    cvd: [[-100, "#fde725"], [-85, "#b5de2b"], [-75, "#6ece58"], [-65, "#35b779"], [-55, "#21918c"], [-45, "#31688e"], [-30, "#440154"]],
    viridis: evenStops(["#440154", "#482878", "#3e4989", "#31688e", "#26828e", "#1f9e89", "#35b779", "#6ece58", "#b5de2b", "#fde725"]),
    cividis: evenStops(["#00204d", "#31446b", "#666970", "#958f78", "#cbba69", "#ffea46"])
  };
  var PALETTE_LABELS = { classic: "Classic RF", aurora: "Aurora (emerald, cyan, amber, crimson)", cvd: "Colour-blind safe (inverted viridis)", viridis: "Viridis (colour-blind safe)", cividis: "Cividis (colour-blind safe)" };
  var BAND_SAMPLE_DBM = { excellent: -48, good: -60, fair: -70, poor: -80, none: -95 };
  var MAX_CONTOUR_CELLS = 400000;

  /** Colour stops spread evenly over the RSSI range, weakest first. Used for perceptually uniform ramps. */
  function evenStops(hexes) {
    return hexes.map(function (h, i) { return [RSSI_MIN + (RSSI_MAX - RSSI_MIN) * i / (hexes.length - 1), h]; });
  }
  function hexToRgb(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }

  /** Colour [r,g,b] (0..255) for an RSSI on a palette: linear interpolation between stops. */
  function colorAt(paletteId, rssi) {
    var stops = PALETTES[paletteId] || PALETTES.classic;
    if (rssi <= stops[0][0]) { return hexToRgb(stops[0][1]); }
    for (var i = 1; i < stops.length; i++) {
      if (rssi <= stops[i][0]) {
        var a = stops[i - 1], b = stops[i], t = (rssi - a[0]) / (b[0] - a[0]), ca = hexToRgb(a[1]), cb = hexToRgb(b[1]);
        return [Math.round(ca[0] + (cb[0] - ca[0]) * t), Math.round(ca[1] + (cb[1] - ca[1]) * t), Math.round(ca[2] + (cb[2] - ca[2]) * t)];
      }
    }
    return hexToRgb(stops[stops.length - 1][1]);
  }

  /** RGBA lookup table (LUT_SIZE entries) over RSSI_MIN..RSSI_MAX. */
  function buildLut(paletteId) {
    var lut = new Uint8Array(LUT_SIZE * 4);
    for (var i = 0; i < LUT_SIZE; i++) {
      var c = colorAt(paletteId, RSSI_MIN + (RSSI_MAX - RSSI_MIN) * i / (LUT_SIZE - 1));
      lut[i * 4] = c[0]; lut[i * 4 + 1] = c[1]; lut[i * 4 + 2] = c[2]; lut[i * 4 + 3] = 255;
    }
    return lut;
  }

  /** Quality band ids from config in strong-to-weak order, with their lower bounds (null for the last). */
  function bandList(config) { return config.analytics.quality_bands; }
  /** Band id of an RSSI: the first band whose min_dbm the RSSI reaches. Mirrors rfmodel.quality_band. */
  function bandOf(config, rssi) {
    var bands = bandList(config);
    for (var i = 0; i < bands.length; i++) { if (bands[i].min_dbm === null || rssi >= bands[i].min_dbm) { return bands[i].id; } }
    return bands[bands.length - 1].id;
  }
  function bandColor(paletteId, id) { return colorAt(paletteId, BAND_SAMPLE_DBM[id]); }
  function rssiToByte(rssi) { return Math.max(0, Math.min(255, Math.round((rssi - RSSI_MIN) / (RSSI_MAX - RSSI_MIN) * 255))); }

  /** Legend rows [{id, name, range}] so the scale never relies on colour alone. */
  function legendRows(config) {
    var bands = bandList(config);
    return bands.map(function (b, i) {
      var upper = i > 0 ? bands[i - 1].min_dbm : null, range;
      if (b.min_dbm === null) { range = "below " + bands[i - 1].min_dbm + " dBm"; }
      else if (upper === null) { range = b.min_dbm + " dBm and stronger"; }
      else { range = b.min_dbm + " to " + upper + " dBm"; }
      return { id: b.id, name: BAND_NAMES[b.id] || b.id, range: range };
    });
  }

  // ------------------------------------------------------------------ contours (marching squares)
  var CASES = [[], [[3, 2]], [[2, 1]], [[3, 1]], [[0, 1]], null, [[0, 2]], [[0, 3]], [[0, 3]], [[0, 2]], null, [[0, 1]], [[3, 1]], [[1, 2]], [[2, 3]], []];

  /**
   * Contour segments of a row-major RSSI grid at `level` dBm, in metres (cell centres are the samples).
   * Returns a Float32Array of x1,y1,x2,y2 quadruples.
   */
  function contourSegments(grid, cols, rows, cellM, level) {
    var out = [];
    function pt(edge, i, j, tl, tr, br, bl) {
      var x0 = (i + 0.5) * cellM, y0 = (j + 0.5) * cellM, x1 = x0 + cellM, y1 = y0 + cellM, t;
      if (edge === 0) { t = (level - tl) / (tr - tl); return [x0 + t * cellM, y0]; }
      if (edge === 1) { t = (level - tr) / (br - tr); return [x1, y0 + t * cellM]; }
      if (edge === 2) { t = (level - bl) / (br - bl); return [x0 + t * cellM, y1]; }
      t = (level - tl) / (bl - tl); return [x0, y0 + t * cellM];
    }
    for (var j = 0; j < rows - 1; j++) {
      for (var i = 0; i < cols - 1; i++) {
        var tl = grid[j * cols + i], tr = grid[j * cols + i + 1], bl = grid[(j + 1) * cols + i], br = grid[(j + 1) * cols + i + 1];
        var idx = (tl >= level ? 8 : 0) | (tr >= level ? 4 : 0) | (br >= level ? 2 : 0) | (bl >= level ? 1 : 0), segs = CASES[idx];
        if (segs === null) {
          var centre = (tl + tr + br + bl) / 4 >= level;
          if (idx === 5) { segs = centre ? [[0, 3], [1, 2]] : [[0, 1], [3, 2]]; } else { segs = centre ? [[0, 1], [3, 2]] : [[0, 3], [1, 2]]; }
        }
        for (var s = 0; s < segs.length; s++) {
          var a = pt(segs[s][0], i, j, tl, tr, br, bl), b = pt(segs[s][1], i, j, tl, tr, br, bl);
          out.push(a[0], a[1], b[0], b[1]);
        }
      }
    }
    return new Float32Array(out);
  }

  /** Contours at the lower bounds of the quality bands (the edges between bands). */
  function bandContours(config, grid, cols, rows, cellM) {
    if (cols * rows > MAX_CONTOUR_CELLS) { return []; }
    return bandList(config).filter(function (b) { return b.min_dbm !== null; }).map(function (b) {
      return { level: b.min_dbm, id: b.id, segs: contourSegments(grid, cols, rows, cellM, b.min_dbm) };
    });
  }


  // ------------------------------------------------------------------ map layers (heat map modes)
  // A layer is a per-cell value over the analysis grid. The renderer only knows RSSI, so a layer is turned into a
  // "goodness" 0..1 (1 = good end of the scale, flipped for latency, loss and the like) and drawn through the same
  // colour scale as a pseudo RSSI. The legend and probe text always show the real values and units.
  var COMBINED_ID = "combined";
  var COMBINED_SPEC = { label: "Combined (weakest of the selected layers)", unit: "% of best", lo: 0, hi: 100, higher_is_better: true, needs: null };
  var NEEDS_SINR_REASON = "Needs an access point with a WiFi standard. Choose one in the access point list (Standard).";

  function layerIds(config) { return Object.keys(config.planner_layers.layers); }
  function layerSpec(config, id) { return id === COMBINED_ID ? COMBINED_SPEC : config.planner_layers.layers[id]; }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  /** 0 (worst end) to 1 (best end) of a value on a layer, NaN stays NaN. */
  function goodness(spec, v) {
    if (v !== v) { return NaN; }
    var t = clamp01((v - spec.lo) / (spec.hi - spec.lo));
    return spec.higher_is_better ? t : 1 - t;
  }
  function pseudoDbm(t) { return RSSI_MIN + t * (RSSI_MAX - RSSI_MIN); }
  function flatten(rows, cols, n) {
    var out = new Float32Array(n);
    for (var r = 0; r < rows.length; r++) {
      for (var c = 0; c < cols; c++) { var v = rows[r][c]; out[r * cols + c] = v === null || v === undefined ? NaN : v; }
    }
    return out;
  }

  /**
   * Per-cell values of one layer. ctx: {config, RF, analytics, rssi (Float32Array, best RSSI per cell), nowall (same with walls
   * removed, only for wall_loss), values (optional {id: result} already computed)}. Returns {values: Float32Array (NaN where the layer has no value), reason: string|null}.
   * Layers that need SINR return reason when no AP has a WiFi standard. ESTIMATES, see planner_layers.source in rf-config.json.
   */
  function layerValues(id, ctx) {
    if (ctx.values && ctx.values[id]) { return ctx.values[id]; }   // computed in the worker, where the full analysis lives
    var cfg = ctx.config, pl = cfg.planner_layers, a = ctx.analytics, cols = a.cols, rows = a.rows, n = cols * rows, out = new Float32Array(n), i;
    var spec = pl.layers[id];
    if (!spec) { throw new Error("unknown layer " + id); }
    if (spec.needs === "sinr" && !a.sinr) { out.fill(NaN); return { values: out, reason: NEEDS_SINR_REASON }; }
    var bestAp = flatten(a.best_ap, cols, n);   // index into a.aps, -1 for no service
    function perAp(key) { for (i = 0; i < n; i++) { var k = bestAp[i]; out[i] = k >= 0 ? a.aps[k][key] : NaN; } }
    function snr() {
      var o = new Float32Array(n);
      for (i = 0; i < n; i++) {
        var k = bestAp[i], width = k >= 0 ? a.aps[k].width_mhz : pl.default_width_mhz;
        o[i] = ctx.rssi[i] - ctx.RF.noiseFloorDbm(cfg, width);
      }
      return o;
    }
    if (id === "rssi") { out.set(ctx.rssi); }
    else if (id === "snr") { out.set(snr()); }
    else if (id === "sinr") { out.set(flatten(a.sinr.sinr_db, cols, n)); }
    else if (id === "bandwidth") { out.set(flatten(a.sinr ? a.sinr.throughput_mbps : a.throughput_mbps, cols, n)); }
    else if (id === "latency") { out.set(flatten(a.sinr.reliability.latency_ms, cols, n)); }
    else if (id === "loss") { out.set(flatten(a.sinr.reliability.loss_pct, cols, n)); }
    else if (id === "quality") {
      var rate = flatten(a.sinr ? a.sinr.throughput_mbps : a.throughput_mbps, cols, n), dead = cfg.analytics.dead_zone_dbm, best = cfg.analytics.quality_bands[0].min_dbm, w = pl.quality_weights;
      var bw = pl.layers.bandwidth.hi;
      for (i = 0; i < n; i++) { out[i] = 100 * (w.signal * clamp01((ctx.rssi[i] - dead) / (best - dead)) + w.throughput * clamp01(rate[i] / bw)); }
    } else if (id === "wall_loss") {
      if (!ctx.nowall) { out.fill(NaN); return { values: out, reason: "Wall attenuation needs the wall-free reference map, which was not computed." }; }
      for (i = 0; i < n; i++) { out[i] = Math.max(0, ctx.nowall[i] - ctx.rssi[i]); }
    } else if (id === "interference") {
      var s = snr(), sinr = flatten(a.sinr.sinr_db, cols, n);
      for (i = 0; i < n; i++) { out[i] = sinr[i] !== sinr[i] ? NaN : Math.max(0, s[i] - sinr[i]); }
    } else if (id === "utilisation") { perAp("channel_utilisation_pct"); }
    else if (id === "capacity") { perAp("client_capacity"); }
    return { values: out, reason: null };
  }

  /**
   * Heat grid for the renderer from a layer or from the combined layer (per cell minimum goodness of `combinedIds`).
   * Returns {rssi: Float32Array (pseudo dBm), cols, rows, cellM, layer: true, id, spec, values, reason, stats}.
   */
  function layerGrid(id, ctx, combinedIds) {
    var a = ctx.analytics, n = a.cols * a.rows, spec = layerSpec(ctx.config, id), values, reason = null, ids = [], i, k;
    var grid = new Float32Array(n);
    if (id === COMBINED_ID) {
      var parts = [], skipped = [];
      (combinedIds || []).forEach(function (cid) {
        var r = layerValues(cid, ctx);
        if (r.reason) { skipped.push(layerSpec(ctx.config, cid).label); } else { parts.push({ spec: layerSpec(ctx.config, cid), values: r.values }); ids.push(cid); }
      });
      values = new Float32Array(n);
      for (i = 0; i < n; i++) {
        var lowest = 1, any = false;
        for (k = 0; k < parts.length; k++) { var g = goodness(parts[k].spec, parts[k].values[i]); if (g === g) { any = true; if (g < lowest) { lowest = g; } } }
        values[i] = any ? 100 * lowest : NaN;
      }
      if (!parts.length) { reason = "Select at least one layer to combine."; }
      else if (skipped.length) { reason = "Not included (no data): " + skipped.join(", ") + "."; }
    } else {
      var r2 = layerValues(id, ctx);
      values = r2.values; reason = r2.reason;
    }
    var sum = 0, count = 0, min = Infinity, max = -Infinity;
    for (i = 0; i < n; i++) {
      var v = values[i], t = goodness(spec, v);
      grid[i] = pseudoDbm(t === t ? t : 0);
      if (v === v) { sum += v; count++; if (v < min) { min = v; } if (v > max) { max = v; } }
    }
    return { rssi: grid, cols: a.cols, rows: a.rows, cellM: a.cell_m, layer: true, id: id, spec: spec, values: values, reason: reason, combined: ids,
             stats: count ? { min: min, mean: sum / count, max: max, cells: count } : null };
  }

  /** CSS gradient from the bad end to the good end of a layer on a palette. */
  function gradientCss(paletteId, steps) {
    var n = steps || 8, parts = [];
    for (var i = 0; i < n; i++) {
      var c = colorAt(paletteId, pseudoDbm(i / (n - 1)));
      parts.push("rgb(" + c.join(",") + ") " + Math.round(100 * i / (n - 1)) + "%");
    }
    return "linear-gradient(to right, " + parts.join(", ") + ")";
  }
  /** Legend text for the ends of a layer scale: [bad end, good end] with units. */
  function layerEnds(spec) {
    var lo = spec.lo + " " + spec.unit, hi = spec.hi + " " + spec.unit;
    return spec.higher_is_better ? [lo + " (weak)", hi + " (strong)"] : [hi + " (worst)", lo + " (best)"];
  }

  // ------------------------------------------------------------------ tooltip text
  /** Rows [label, value] for a probeAt result. */
  function describeProbe(p, config) {
    var rows = [["Signal", p.rssi_dbm.toFixed(1) + " dBm (" + (BAND_NAMES[p.quality] || p.quality) + ")"],
                ["Throughput", p.ap_id ? "about " + Math.round(p.throughput_mbps) + " Mbps (estimate)" : "none"]];
    if (p.ap_id) {
      var parts = [p.walls_crossed + (p.walls_crossed === 1 ? " wall" : " walls")];
      if (p.openings_crossed) { parts.push(p.openings_crossed + (p.openings_crossed === 1 ? " opening" : " openings")); }
      if (p.floors_crossed) { parts.push(p.floors_crossed + (p.floors_crossed === 1 ? " floor" : " floors")); }
      rows.push(["Best AP", p.ap_id], ["Distance", p.distance_m.toFixed(1) + " m"], ["Obstructions", parts.join(", ")]);
    }
    rows.push(["", "MODEL ESTIMATE, not a measurement"]);
    return rows;
  }

  var api = { RSSI_MIN: RSSI_MIN, RSSI_MAX: RSSI_MAX, PALETTES: PALETTES, PALETTE_LABELS: PALETTE_LABELS, BAND_NAMES: BAND_NAMES, COMBINED_ID: COMBINED_ID,
              layerIds: layerIds, layerSpec: layerSpec, goodness: goodness, layerValues: layerValues, layerGrid: layerGrid, gradientCss: gradientCss, layerEnds: layerEnds, colorAt: colorAt, buildLut: buildLut,
              bandOf: bandOf, bandColor: bandColor, rssiToByte: rssiToByte, legendRows: legendRows, contourSegments: contourSegments,
              bandContours: bandContours, describeProbe: describeProbe };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  root.PlannerHeat = api;
  if (!root.document) { return; }

  // ------------------------------------------------------------------ browser renderer
  var doc = root.document;
  var VERT = "attribute vec2 a_pos; attribute vec2 a_uv; varying vec2 v_uv; void main() { v_uv = a_uv; gl_Position = vec4(a_pos, 0.0, 1.0); }";
  var FRAG = [
    "precision mediump float;",
    "uniform sampler2D u_grid; uniform sampler2D u_lut;",
    "uniform float u_opacity; uniform float u_banded; uniform float u_hatch; uniform float u_dead; uniform float u_dpr;",
    "uniform vec4 u_th; uniform vec3 u_band0; uniform vec3 u_band1; uniform vec3 u_band2; uniform vec3 u_band3; uniform vec3 u_band4;",
    "varying vec2 v_uv;",
    "void main() {",
    "  float t = texture2D(u_grid, v_uv).r;",
    "  vec3 col = texture2D(u_lut, vec2(t, 0.5)).rgb;",
    "  if (u_banded > 0.5) { col = t >= u_th.x ? u_band0 : t >= u_th.y ? u_band1 : t >= u_th.z ? u_band2 : t >= u_th.w ? u_band3 : u_band4; }",
    "  if (u_hatch > 0.5 && t < u_dead) {",
    "    float s = mod((gl_FragCoord.x + gl_FragCoord.y) / u_dpr, " + HATCH_PERIOD_PX.toFixed(1) + ");",
    "    if (s < " + HATCH_WIDTH_PX.toFixed(1) + ") { col = vec3(0.04, 0.04, 0.08); }",
    "  }",
    "  gl_FragColor = vec4(col * u_opacity, u_opacity);",
    "}"
  ].join("\n");

  function shader(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { throw new Error("shader: " + gl.getShaderInfoLog(s)); }
    return s;
  }

  function initGl(canvas) {
    var gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: false })
          || canvas.getContext("experimental-webgl");
    if (!gl) { throw new Error("WebGL is not available"); }
    var prog = gl.createProgram();
    gl.attachShader(prog, shader(gl, gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, shader(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { throw new Error("program: " + gl.getProgramInfoLog(prog)); }
    gl.useProgram(prog);
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    var aPos = gl.getAttribLocation(prog, "a_pos"), aUv = gl.getAttribLocation(prog, "a_uv");
    gl.enableVertexAttribArray(aPos); gl.enableVertexAttribArray(aUv);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0); gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8);
    function texture(unit) {
      var t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }
    var u = {};
    ["u_grid", "u_lut", "u_opacity", "u_banded", "u_hatch", "u_dead", "u_dpr", "u_th", "u_band0", "u_band1", "u_band2", "u_band3", "u_band4"]
      .forEach(function (n) { u[n] = gl.getUniformLocation(prog, n); });
    gl.uniform1i(u.u_grid, 0); gl.uniform1i(u.u_lut, 1);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    var dbg = gl.getExtension("WEBGL_debug_renderer_info");
    return { gl: gl, buf: buf, gridTex: texture(0), lutTex: texture(1), u: u,
             info: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) };
  }

  /**
   * create({heat, over, config, forceCanvas2d}). heat: canvas under the editor (replaced if WebGL cannot be used,
   * read renderer.canvas); over: 2D canvas for contour lines. Options: opacity, palette, banded, contours, deadZones.
   */
  api.createRenderer = function (o) {
    var config = o.config, canvas = o.heat, over = o.over, octx = over.getContext("2d");
    var r = { kind: "canvas2d", info: "", canvas: canvas, opts: { opacity: DEFAULT_OPACITY, palette: "classic", banded: false, contours: true, deadZones: true },
              lastDrawMs: 0, grid: null, contours: [] };
    var gl = null, c2 = null, thumb = doc.createElement("canvas"), thumbCtx = thumb.getContext("2d"), lutDirty = true, thumbDirty = true, gridDirty = true;
    var hatchTile = null;
    r.thumb = thumb;

    function useCanvas2d(reason) {
      if (gl) {   // a canvas that had a WebGL context cannot give a 2D one: swap in a fresh element
        var fresh = canvas.cloneNode(false);
        canvas.parentNode.replaceChild(fresh, canvas); canvas = fresh; r.canvas = fresh;
      }
      gl = null; c2 = canvas.getContext("2d"); r.kind = "canvas2d"; r.info = reason || "canvas 2D";
      if (o.onKind) { o.onKind(r); }
    }
    if (!o.forceCanvas2d) {
      try { gl = initGl(canvas); r.kind = "webgl"; r.info = gl.info; } catch (e) { gl = null; useCanvas2d("WebGL unavailable (" + e.message + "), using canvas 2D"); }
    } else { useCanvas2d("canvas 2D (requested)"); }
    if (gl) {
      canvas.addEventListener("webglcontextlost", function (e) { e.preventDefault(); useCanvas2d("WebGL context lost, using canvas 2D"); r.draw(r.lastView); }, false);
      if (o.onKind) { o.onKind(r); }
    }

    function buildThumb() {
      var g = r.grid;
      if (!g) { return; }
      thumb.width = g.cols; thumb.height = g.rows;
      var img = thumbCtx.createImageData(g.cols, g.rows), d = img.data, ids = bandList(config);
      var bandRgb = {};
      ids.forEach(function (b) { bandRgb[b.id] = bandColor(r.opts.palette, b.id); });
      var lut = buildLut(r.opts.palette);
      for (var i = 0; i < g.rssi.length; i++) {
        var v = g.rssi[i], c;
        if (r.opts.banded && !r.layerMode) { c = bandRgb[bandOf(config, v)]; } else { var k = rssiToByte(v) * 4; c = [lut[k], lut[k + 1], lut[k + 2]]; }
        d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255;
      }
      thumbCtx.putImageData(img, 0, 0);
      thumbDirty = false;
    }

    r.setGrid = function (g) {
      r.grid = g; gridDirty = true; thumbDirty = true;
      r.layerMode = !!g.layer;   // layers other than RSSI have no dBm bands: no contours, banding or dead-zone hatch
      r.contours = r.layerMode ? [] : bandContours(config, g.rssi, g.cols, g.rows, g.cellM);
    };
    r.clearGrid = function () { r.grid = null; r.contours = []; r.layerMode = false; if (r.lastView) { r.draw(r.lastView); } };
    r.setOptions = function (patch) {
      Object.keys(patch).forEach(function (k) { r.opts[k] = patch[k]; });
      lutDirty = true; thumbDirty = true;
    };

    function ensureSize(view) {
      var w = Math.round(view.w * view.dpr), h = Math.round(view.h * view.dpr);
      [canvas, over].forEach(function (c) { if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } });
    }

    function drawGl(view, rect) {
      var g = r.grid, u = gl.u, ctx = gl.gl;
      if (gridDirty) {
        var bytes = new Uint8Array(g.rssi.length);
        for (var i = 0; i < bytes.length; i++) { bytes[i] = rssiToByte(g.rssi[i]); }
        ctx.activeTexture(ctx.TEXTURE0); ctx.bindTexture(ctx.TEXTURE_2D, gl.gridTex);
        ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.LUMINANCE, g.cols, g.rows, 0, ctx.LUMINANCE, ctx.UNSIGNED_BYTE, bytes);
        gridDirty = false;
      }
      if (lutDirty) {
        ctx.activeTexture(ctx.TEXTURE1); ctx.bindTexture(ctx.TEXTURE_2D, gl.lutTex);
        ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA, LUT_SIZE, 1, 0, ctx.RGBA, ctx.UNSIGNED_BYTE, buildLut(r.opts.palette));
        var th = bandList(config).filter(function (b) { return b.min_dbm !== null; }).map(function (b) { return (b.min_dbm - RSSI_MIN) / (RSSI_MAX - RSSI_MIN); });
        ctx.uniform4f(u.u_th, th[0], th[1], th[2], th[3]);
        ["excellent", "good", "fair", "poor", "none"].forEach(function (id, n) {
          var c = bandColor(r.opts.palette, id); ctx.uniform3f(u["u_band" + n], c[0] / 255, c[1] / 255, c[2] / 255);
        });
        ctx.uniform1f(u.u_dead, (config.analytics.dead_zone_dbm - RSSI_MIN) / (RSSI_MAX - RSSI_MIN));
        lutDirty = false;
      }
      ctx.uniform1f(u.u_opacity, r.opts.opacity); ctx.uniform1f(u.u_banded, r.opts.banded && !r.layerMode ? 1 : 0);
      ctx.uniform1f(u.u_hatch, r.opts.deadZones && !r.layerMode ? 1 : 0); ctx.uniform1f(u.u_dpr, view.dpr);
      ctx.viewport(0, 0, canvas.width, canvas.height);
      ctx.clearColor(0, 0, 0, 0); ctx.clear(ctx.COLOR_BUFFER_BIT);
      function cx(x) { return x / view.w * 2 - 1; }
      function cy(y) { return 1 - y / view.h * 2; }
      var x0 = cx(rect.x0), x1 = cx(rect.x1), y0 = cy(rect.y0), y1 = cy(rect.y1);
      ctx.bindBuffer(ctx.ARRAY_BUFFER, gl.buf);
      ctx.bufferData(ctx.ARRAY_BUFFER, new Float32Array([x0, y0, 0, 0, x1, y0, 1, 0, x0, y1, 0, 1, x1, y1, 1, 1]), ctx.DYNAMIC_DRAW);
      ctx.drawArrays(ctx.TRIANGLE_STRIP, 0, 4);
    }

    function hatchPattern() {
      if (!hatchTile) {
        hatchTile = doc.createElement("canvas"); hatchTile.width = hatchTile.height = HATCH_PERIOD_PX;
        var h = hatchTile.getContext("2d");
        h.strokeStyle = "rgba(10,10,20,1)"; h.lineWidth = HATCH_WIDTH_PX;
        h.beginPath(); h.moveTo(0, HATCH_PERIOD_PX); h.lineTo(HATCH_PERIOD_PX, 0); h.moveTo(-2, 2); h.lineTo(2, -2); h.moveTo(HATCH_PERIOD_PX - 2, HATCH_PERIOD_PX + 2); h.lineTo(HATCH_PERIOD_PX + 2, HATCH_PERIOD_PX - 2); h.stroke();
      }
      return hatchTile;
    }

    function drawC2d(view, rect) {
      if (thumbDirty) { buildThumb(); }
      var c = c2, g = r.grid;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, canvas.width, canvas.height);
      c.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      c.imageSmoothingEnabled = true; c.imageSmoothingQuality = "low";
      c.globalAlpha = r.opts.opacity;
      c.drawImage(thumb, rect.x0, rect.y0, rect.x1 - rect.x0, rect.y1 - rect.y0);
      c.globalAlpha = 1;
      if (r.opts.deadZones && !r.layerMode) {   // hatch the dead cells: draw a pattern clipped to a nearest-neighbour mask of them
        var mask = r.deadMask || (r.deadMask = doc.createElement("canvas")), mctx = mask.getContext("2d");
        mask.width = g.cols; mask.height = g.rows;
        var img = mctx.createImageData(g.cols, g.rows), dead = config.analytics.dead_zone_dbm;
        for (var i = 0; i < g.rssi.length; i++) { img.data[i * 4 + 3] = g.rssi[i] < dead ? 255 : 0; }
        mctx.putImageData(img, 0, 0);
        var tmp = r.hatchLayer || (r.hatchLayer = doc.createElement("canvas")), t = tmp.getContext("2d");
        tmp.width = Math.max(1, Math.round(view.w)); tmp.height = Math.max(1, Math.round(view.h));
        t.imageSmoothingEnabled = false;
        t.drawImage(mask, rect.x0, rect.y0, rect.x1 - rect.x0, rect.y1 - rect.y0);
        t.globalCompositeOperation = "source-in"; t.fillStyle = t.createPattern(hatchPattern(), "repeat"); t.fillRect(0, 0, tmp.width, tmp.height);
        t.globalCompositeOperation = "source-over";
        c.drawImage(tmp, 0, 0);
      }
    }

    function drawContours(view, rect) {
      var c = octx;
      c.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      c.clearRect(0, 0, view.w, view.h);
      if (!r.opts.contours) { return; }
      c.lineWidth = 1.5; c.lineJoin = "round";
      r.contours.forEach(function (ct) {
        var col = bandColor(r.opts.palette, ct.id);
        c.strokeStyle = "rgba(255,255,255,.85)"; c.lineWidth = 2.6; strokeSegs(c, ct.segs, view);
        c.strokeStyle = "rgb(" + col[0] + "," + col[1] + "," + col[2] + ")"; c.lineWidth = 1.4; strokeSegs(c, ct.segs, view);
        labelContour(c, ct, view);
      });
    }
    function strokeSegs(c, segs, view) {
      c.beginPath();
      for (var i = 0; i < segs.length; i += 4) {
        c.moveTo(view.ox + segs[i] * view.scale, view.oy + segs[i + 1] * view.scale); c.lineTo(view.ox + segs[i + 2] * view.scale, view.oy + segs[i + 3] * view.scale);
      }
      c.stroke();
    }
    // One dBm label per contour level, on the segment nearest the middle of the list that is long enough on screen.
    function labelContour(c, ct, view) {
      var n = ct.segs.length / 4, start = Math.floor(n / 2);
      for (var k = 0; k < Math.min(n, 400); k++) {
        var i = ((start + k) % n) * 4, x = view.ox + (ct.segs[i] + ct.segs[i + 2]) / 2 * view.scale, y = view.oy + (ct.segs[i + 1] + ct.segs[i + 3]) / 2 * view.scale;
        if (x > 8 && y > 8 && x < view.w - 8 && y < view.h - 8 && view.scale >= CONTOUR_LABEL_MIN_PX / 10) {
          c.font = "600 10px system-ui, sans-serif"; c.textAlign = "center"; c.textBaseline = "middle";
          c.lineWidth = 3; c.strokeStyle = "rgba(10,12,20,.85)"; c.strokeText(ct.level + " dBm", x, y); c.fillStyle = "#fff"; c.fillText(ct.level + " dBm", x, y);
          return;
        }
      }
    }

    r.draw = function (view) {
      r.lastView = view;
      if (!view) { return; }
      var t0 = root.performance.now();
      ensureSize(view);
      if (!r.grid) {
        if (c2) { c2.setTransform(1, 0, 0, 1, 0, 0); c2.clearRect(0, 0, canvas.width, canvas.height); }
        octx.setTransform(1, 0, 0, 1, 0, 0); octx.clearRect(0, 0, over.width, over.height);
        return;
      }
      var g = r.grid, rect = { x0: view.ox, y0: view.oy, x1: view.ox + g.cols * g.cellM * view.scale, y1: view.oy + g.rows * g.cellM * view.scale };
      if (gl) {
        try { drawGl(view, rect); } catch (e) { useCanvas2d("WebGL failed (" + e.message + "), using canvas 2D"); ensureSize(view); drawC2d(view, rect); }
      } else { drawC2d(view, rect); }
      drawContours(view, rect);
      r.lastDrawMs = root.performance.now() - t0;
    };
    return r;
  };

  // ------------------------------------------------------------------ legend
  /** Fill `list` with one item per quality band: swatch, name and dBm range (text, so it is not colour-only). */
  api.fillLegend = function (list, config, paletteId) {
    list.textContent = "";
    legendRows(config).forEach(function (row) {
      var li = doc.createElement("li"), sw = doc.createElement("i"), name = doc.createElement("b"), rng = doc.createElement("span"), c = bandColor(paletteId, row.id);
      sw.style.background = "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")"; sw.setAttribute("aria-hidden", "true");
      if (row.id === "none") { sw.className = "hatch"; }
      name.textContent = row.name; rng.textContent = row.range; rng.className = "muted";
      li.appendChild(sw); li.appendChild(name); li.appendChild(doc.createTextNode(" ")); li.appendChild(rng); list.appendChild(li);
    });
  };

  /**
   * Legend for a layer: a gradient bar from the bad to the good end with the real values and units at both ends,
   * so the scale never relies on colour alone. `info` is a layerGrid result (or null while it is computed).
   */
  api.fillLayerLegend = function (list, config, layerId, paletteId, info) {
    list.textContent = "";
    var spec = layerSpec(config, layerId), ends = layerEnds(spec);
    var li = doc.createElement("li"), bar = doc.createElement("i"), lo = doc.createElement("span"), hi = doc.createElement("span");
    li.className = "legend-ramp"; bar.className = "ramp"; bar.setAttribute("aria-hidden", "true"); bar.style.background = gradientCss(paletteId);
    lo.textContent = ends[0]; hi.textContent = ends[1];
    li.appendChild(lo); li.appendChild(bar); li.appendChild(hi); list.appendChild(li);
    var note = doc.createElement("li"), txt = spec.label + ", " + spec.unit + ". ";
    if (info && info.reason) { txt += info.reason; }
    else if (info && info.stats) { txt += "Floor: min " + info.stats.min.toFixed(1) + ", mean " + info.stats.mean.toFixed(1) + ", max " + info.stats.max.toFixed(1) + " " + spec.unit + ". Cells without service are drawn at the worst end."; }
    else { txt += "Computing..."; }
    note.textContent = txt; note.className = "muted"; list.appendChild(note);
  };

  // ------------------------------------------------------------------ mini-map
  /**
   * create({canvas, getFloor, getView, thumb, onNavigate}). Draws the whole floor with the heat map thumbnail and
   * the viewport rectangle; click or drag (or arrow keys) navigates by calling onNavigate(xMetres, yMetres).
   */
  api.createMinimap = function (o) {
    var cv = o.canvas, ctx = cv.getContext("2d"), pad = 4, dragging = false;
    function map() {
      var f = o.getFloor(), k = Math.min((cv.width - 2 * pad) / f.width_m, (cv.height - 2 * pad) / f.depth_m);
      return { f: f, k: k, x0: pad, y0: pad };
    }
    function draw() {
      var m = map(), f = m.f, v = o.getView(), thumb = o.getThumb();
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.fillStyle = "rgba(128,140,170,.18)"; ctx.fillRect(m.x0, m.y0, f.width_m * m.k, f.depth_m * m.k);
      if (thumb && thumb.width > 1) { ctx.globalAlpha = 0.85; ctx.drawImage(thumb, m.x0, m.y0, f.width_m * m.k, f.depth_m * m.k); ctx.globalAlpha = 1; }
      ctx.strokeStyle = "rgba(230,235,245,.8)"; ctx.lineWidth = 1; ctx.beginPath();
      f.walls.forEach(function (w) { ctx.moveTo(m.x0 + w.x1 * m.k, m.y0 + w.y1 * m.k); ctx.lineTo(m.x0 + w.x2 * m.k, m.y0 + w.y2 * m.k); });
      ctx.stroke();
      ctx.fillStyle = "#a78bfa";
      f.aps.forEach(function (a) { ctx.beginPath(); ctx.arc(m.x0 + a.x * m.k, m.y0 + a.y * m.k, 2.5, 0, Math.PI * 2); ctx.fill(); });
      var vx = (-v.ox / v.scale) * m.k + m.x0, vy = (-v.oy / v.scale) * m.k + m.y0, vw = v.w / v.scale * m.k, vh = v.h / v.scale * m.k;
      ctx.strokeStyle = "#2dd4bf"; ctx.lineWidth = 2; ctx.strokeRect(vx, vy, vw, vh);
    }
    function nav(e) {
      var r = cv.getBoundingClientRect(), m = map(), sx = cv.width / r.width;
      o.onNavigate(((e.clientX - r.left) * sx - m.x0) / m.k, ((e.clientY - r.top) * sx - m.y0) / m.k);
    }
    cv.addEventListener("pointerdown", function (e) { dragging = true; cv.setPointerCapture(e.pointerId); nav(e); });
    cv.addEventListener("pointermove", function (e) { if (dragging) { nav(e); } });
    cv.addEventListener("pointerup", function () { dragging = false; });
    cv.addEventListener("keydown", function (e) {
      var d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!d) { return; }
      var v = o.getView(), cx = (v.w / 2 - v.ox) / v.scale, cy = (v.h / 2 - v.oy) / v.scale, step = 2;
      o.onNavigate(cx + d[0] * step, cy + d[1] * step); e.preventDefault();
    });
    return { draw: draw };
  };
})(typeof self !== "undefined" ? self : this);
