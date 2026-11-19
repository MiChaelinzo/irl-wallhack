"use strict";
// Wallhack 3D room view: own projection maths on a plain 2D canvas, no libraries.
// This is a signal-activity visualisation with schematic positions. It is not imaging.
(function (root) {
  // ---- layout constants (metres, schematic) -------------------------------
  var ROOM_W = 6, ROOM_D = 5, ROOM_H = 2.6;
  var GRID_STEP = 1;
  var ROUTER_POS = [-ROOM_W / 2 + 0.3, 1.9, -ROOM_D / 2 + 0.3];
  var ZONE_MARGIN = 0.25;
  var ZONE_MAX_H = 2.2;            // volume height at full motion
  var ZONE_MIN_H = 0.35;           // volume height for a quiet zone
  var MOTION_FULL_SCALE = 3;       // motion_value that fills a volume
  var BREATH_SWELL = 0.08;         // fraction of height the breathing pulse adds
  var ARC_LIFT = 0.9, ARC_SEGMENTS = 18, PACKET_COUNT = 3, PACKET_SPEED = 0.35;
  var CAMERA = { yaw: 0.7, pitch: 0.5, dist: 8, fov: 1.0 };
  var PITCH_MIN = 0.1, PITCH_MAX = 1.45, DIST_MIN = 4, DIST_MAX = 14, ZOOM_STEP = 1.15;
  var AUTO_ROTATE_RAD_S = 0.15, NEAR_PLANE = 0.1;
  var MIN_ASPECT = 1.3;            // narrower canvases pull the camera back so the room stays in frame
  var TWO_PI = Math.PI * 2;

  // ---- visual constants ----------------------------------------------------
  var QUALITY_LEVELS = ["low", "medium", "high"];
  var DEFAULT_QUALITY = "medium";
  // Per level: devicePixelRatio cap, frame cap (0 = display rate), dust particles, wave rings, glow on/off.
  // flow: WiFi and activity particles per source (0 = none); bloom: additive blending; dof: depth-of-field blur on particles.
  // heatStep: coverage overlay samples every Nth cell, so low quality draws far fewer quads.
  var QUALITY_PROFILES = {
    low:    { dprCap: 1,   fps: 20, dust: 0,   rings: 2, glow: false, heatStep: 2, flow: 0,  bloom: false, dof: false },
    medium: { dprCap: 1.5, fps: 0,  dust: 36,  rings: 3, glow: true,  heatStep: 1, flow: 8,  bloom: false, dof: false },
    high:   { dprCap: 2,   fps: 0,  dust: 110, rings: 4, glow: true,  heatStep: 1, flow: 22, bloom: true,  dof: true }
  };
  var SLOW_FRAME_MS = 40;          // average frame time above this drops the quality to low
  var FRAME_SAMPLES = 45, WARMUP_FRAMES = 20;
  var DUST_SEED = 0x57A11, DUST_DRIFT = 0.12, DUST_SPEED_MIN = 0.15, DUST_SPEED_SPAN = 0.4;
  var WAVE_SPEED = 0.18, WAVE_RADIUS = 7.5, WAVE_SEGMENTS = 48;
  var FX_SEED = 0xF10A, FX_SEEDS = 64, FLOW_SPEED = 0.12, FLOW_LIFT = 0.6, FLOW_DOT = 0.035;
  var RISE_SPEED = 0.18, RISE_HEIGHT = 1.6, RISE_SPREAD = 1.2, DOF_RATE = 0.18, DOF_GROW = 2.2, DOF_FADE = 0.6;
  var STILL_TIME = 2.2;            // frozen animation clock (s) used under prefers-reduced-motion
  var UINT32 = 4294967296;
  var GRID_ALPHA = 0.55, GRID_ALPHA_MIN = 0.1, GRID_FADE = 0.12;
  var WAVE_ALPHA = 0.55, DUST_ALPHA = 0.5, DUST_SIZE = 0.012, VOLUME_FILL_ALPHA = 0.07;
  var PERSON_SHOULDER_Y = 1.3, PERSON_HEAD_Y = 1.62, PERSON_CHEST_Y = 1.0, PERSON_HEAD_R = 0.15;
  var PERSON_BODY_W = 0.26, PERSON_BREATH_SWELL = 0.12, PERSON_ALPHA = 0.55, HEART_RING_GROW = 0.35;
  var ARC_GLOW_W = 6, PULSE_TAIL = 4, PULSE_TAIL_STEP = 0.018, ROUTER_PULSE = 2.2;
  // digital twin layer
  var TWIN_FURNITURE_H = { sofa: 0.8, bed: 0.5, table: 0.75, desk: 0.75, wardrobe: 1.9, counter: 0.9, other: 0.6 };
  var TWIN_STACK_GAP = 1.5;        // floor spacing as a multiple of the tallest floor when stacked
  var TWIN_DIM_ALPHA = 0.3, TWIN_ROOM_ALPHA = 0.1, TWIN_OCCUPIED_ALPHA = 0.32;
  var TWIN_WALL_FILL_ALPHA = 0.07, TWIN_STACKED_SHRINK = 0.7;   // stacked floors need extra vertical room in frame
  var DOOR_H = 2.0, WINDOW_LO = 0.9, WINDOW_HI = 1.8;
  var HEAT_BANDS = [[-50, [74, 222, 128]], [-60, [163, 230, 53]], [-70, [250, 204, 21]], [-80, [251, 146, 60]], [-120, [251, 113, 133]]];
  var HEAT_ALPHA = 0.42;
  var LABEL_STAGGER_PX = 12;       // link labels in the same zone alternate rows so they cannot overlap
  var VIGNETTE_INNER = 0.35, VIGNETTE_OUTER = 0.75, VIGNETTE_ALPHA = 0.4;

  // ---- pure maths ----------------------------------------------------------
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  // World point (x right, y up, z toward viewer at yaw 0) to screen pixels.
  // cam = {yaw, pitch, dist, fov}; view = {w, h, distScale?} (distScale pulls the camera back on narrow canvases). Returns false when the point is behind the camera.
  function project(p, cam, view, out) {
    var cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
    var cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    var x1 = p[0] * cy - p[2] * sy;
    var z1 = p[0] * sy + p[2] * cy;
    var y2 = p[1] * cp - z1 * sp;
    var z2 = p[1] * sp + z1 * cp;
    var depth = cam.dist * (view.distScale || 1) - z2;
    if (depth < NEAR_PLANE) { return false; }
    var scale = (view.h / 2) / Math.tan(cam.fov / 2) / depth;
    out.x = view.w / 2 + x1 * scale;
    out.y = view.h / 2 - y2 * scale;
    out.depth = depth;
    out.scale = scale;
    return true;
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  // Quadratic bezier lifted above the straight line, written into out[0..2].
  function arcPoint(a, b, t, lift, out) {
    var u = 1 - t;
    out[0] = u * u * a[0] + 2 * u * t * ((a[0] + b[0]) / 2) + t * t * b[0];
    out[1] = u * u * a[1] + 2 * u * t * ((a[1] + b[1]) / 2 + lift) + t * t * b[1];
    out[2] = u * u * a[2] + 2 * u * t * ((a[2] + b[2]) / 2) + t * t * b[2];
    return out;
  }

  // Schematic floor patch per zone: zones are laid side by side along the room width in sorted order.
  function zoneRects(zoneNames) {
    var names = zoneNames.slice().sort();
    var n = Math.max(1, names.length), w = ROOM_W / n;
    return names.map(function (name, i) {
      return { zone: name, x0: -ROOM_W / 2 + i * w + ZONE_MARGIN, x1: -ROOM_W / 2 + (i + 1) * w - ZONE_MARGIN,
               z0: -ROOM_D / 2 + ZONE_MARGIN + 1, z1: ROOM_D / 2 - ZONE_MARGIN };
    });
  }

  function zoneCenter(rect) { return [(rect.x0 + rect.x1) / 2, 0, (rect.z0 + rect.z1) / 2]; }

  // Deterministic node position for a link inside its zone (index spreads links of one zone apart).
  function linkNodePos(rect, indexInZone, countInZone) {
    var f = (indexInZone + 1) / (countInZone + 1);
    return [lerp(rect.x0, rect.x1, f), 0.15, (rect.z0 + rect.z1) / 2];
  }

  function volumeHeight(motionValue, breathPhase, breathing) {
    var h = lerp(ZONE_MIN_H, ZONE_MAX_H, clamp(motionValue / MOTION_FULL_SCALE, 0, 1));
    return breathing ? h * (1 + BREATH_SWELL * Math.sin(breathPhase)) : h;
  }

  // Phase in radians at time t seconds for a rate in beats per minute.
  function pulsePhase(bpm, tSeconds) { return TWO_PI * (bpm / 60) * tSeconds; }

  // Small seeded PRNG (mulberry32) so dust positions are identical on every run.
  function seededRandom(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / UINT32;
    };
  }

  // Deterministic ambient dust positions inside the room.
  function dustParticles(count) {
    var rnd = seededRandom(DUST_SEED), list = [];
    for (var i = 0; i < count; i++) {
      list.push({ x: (rnd() - 0.5) * ROOM_W, y: rnd() * ROOM_H, z: (rnd() - 0.5) * ROOM_D,
                  phase: rnd() * TWO_PI, speed: DUST_SPEED_MIN + rnd() * DUST_SPEED_SPAN });
    }
    return list;
  }

  // Fixed random offsets for the particle effects, so every run draws the same particles.
  function effectSeeds() {
    var rnd = seededRandom(FX_SEED), list = [];
    for (var i = 0; i < FX_SEEDS; i++) { list.push({ a: rnd(), b: rnd(), c: rnd() }); }
    return list;
  }

  // Depth-of-field: 0 at the focal depth, growing to 1 as a point gets nearer or farther.
  function focusBlur(depth, focusDepth) { return clamp(Math.abs(depth - focusDepth) * DOF_RATE, 0, 1); }

  function normaliseQuality(name) { return QUALITY_LEVELS.indexOf(name) >= 0 ? name : DEFAULT_QUALITY; }

  // Quality to use after observing an average frame time in ms: only ever drops to low.
  function qualityForFrameTime(current, avgMs) { return avgMs > SLOW_FRAME_MS ? "low" : current; }

  // Uniform scale that fits the largest floor of a twin into the schematic room volume.
  function twinScale(twin) {
    var w = 1, d = 1;
    twin.floors.forEach(function (f) { w = Math.max(w, f.width_m); d = Math.max(d, f.depth_m); });
    return Math.min(ROOM_W / w, ROOM_D / d);
  }

  // Twin floor-plane point (x east, y south, metres) to world space. extent = {w, d} of the largest floor.
  function twinPoint(x, y, elevation, scale, extent) {
    return [(x - extent.w / 2) * scale, elevation, (y - extent.d / 2) * scale];
  }

  function twinExtent(twin) {
    var e = { w: 1, d: 1, h: 1 };
    twin.floors.forEach(function (f) { e.w = Math.max(e.w, f.width_m); e.d = Math.max(e.d, f.depth_m); e.h = Math.max(e.h, f.height_m); });
    return e;
  }

  // Elevation in world units. Stacked floors are spread apart; a single selected floor sits on the ground.
  function floorElevation(floor, stacked, extent, scale) {
    return stacked ? floor.level * extent.h * scale * TWIN_STACK_GAP : 0;
  }

  // Where a door or window sits on its wall: two floor-plane points. pos and width are metres along the wall.
  function openingSpan(wall, opening) {
    var dx = wall.x2 - wall.x1, dy = wall.y2 - wall.y1, len = Math.sqrt(dx * dx + dy * dy) || 1;
    var a = clamp(opening.pos, 0, len), b = clamp(opening.pos + opening.width, 0, len);
    return [[wall.x1 + dx * a / len, wall.y1 + dy * a / len], [wall.x1 + dx * b / len, wall.y1 + dy * b / len]];
  }

  // Colour for an RSSI value in dBm: green when strong, red when weak.
  function heatColor(rssi) {
    for (var i = 0; i < HEAT_BANDS.length; i++) {
      if (rssi >= HEAT_BANDS[i][0]) { return HEAT_BANDS[i][1]; }
    }
    return HEAT_BANDS[HEAT_BANDS.length - 1][1];
  }

  var api = { project: project, twinScale: twinScale, twinPoint: twinPoint, twinExtent: twinExtent, floorElevation: floorElevation,
              openingSpan: openingSpan, heatColor: heatColor, arcPoint: arcPoint, zoneRects: zoneRects, zoneCenter: zoneCenter,
              linkNodePos: linkNodePos, volumeHeight: volumeHeight, pulsePhase: pulsePhase, clamp: clamp,
              dustParticles: dustParticles, effectSeeds: effectSeeds, focusBlur: focusBlur, QUALITY_PROFILES: QUALITY_PROFILES, normaliseQuality: normaliseQuality, qualityForFrameTime: qualityForFrameTime,
              QUALITY_LEVELS: QUALITY_LEVELS, DEFAULT_QUALITY: DEFAULT_QUALITY, SLOW_FRAME_MS: SLOW_FRAME_MS,
              ROOM: { w: ROOM_W, d: ROOM_D, h: ROOM_H }, MOTION_FULL_SCALE: MOTION_FULL_SCALE };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  if (!root || !root.document) { return; }

  // ---- canvas scene (browser only) ----------------------------------------
  var cam = { yaw: CAMERA.yaw, pitch: CAMERA.pitch, dist: CAMERA.dist, fov: CAMERA.fov };
  var pt = { x: 0, y: 0, depth: 0, scale: 0 };
  var pa = { x: 0, y: 0, depth: 0, scale: 0 };
  var tmp = [0, 0, 0], tmpB = [0, 0, 0];
  var FX_SEEDS_LIST = effectSeeds();
  var autoRotate = true, canvas = null, g = null, view = { w: 0, h: 0 };
  var data = { zones: [], links: [], vitals: null, palette: null };
  // twin: model, floor ("all" stacks every floor), mode ("twin" or "signal"), heat = {floorId: coverage grid},
  // showHeat, offsetDb (playback shifts the modelled signal), occupancy (0..1 from playback, null when live)
  var twin = { model: null, floor: "all", mode: "twin", heat: {}, showHeat: false, offsetDb: 0, occupancy: null };
  var drag = null, lastFrame = 0, lastDraw = 0, running = false, dirty = true;
  var quality = DEFAULT_QUALITY, profile = QUALITY_PROFILES[quality], dust = dustParticles(profile.dust);
  var reducedMotion = false, onQualityChange = null, frameTimes = [], framesSeen = 0;

  function line(a, b) {
    if (!project(a, cam, view, pt)) { return; }
    if (!project(b, cam, view, pa)) { return; }
    g.moveTo(pt.x, pt.y); g.lineTo(pa.x, pa.y);
  }

  function drawBox(x0, x1, y0, y1, z0, z1) {
    var c = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]];
    var edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    edges.forEach(function (e) { line(c[e[0]], c[e[1]]); });
  }

  function fillQuad(pts, fillStyle) {
    g.beginPath();
    for (var i = 0; i < pts.length; i++) {
      if (!project(pts[i], cam, view, pt)) { return; }
      if (i === 0) { g.moveTo(pt.x, pt.y); } else { g.lineTo(pt.x, pt.y); }
    }
    g.closePath(); g.fillStyle = fillStyle; g.fill();
  }

  function setGlow(color, blur) {
    if (profile.glow) { g.shadowColor = color; g.shadowBlur = blur; }
  }
  function clearGlow() { g.shadowBlur = 0; }

  function zoneColor(z, pal) { return z.motion ? pal.bad : (z.presence ? pal.ok : pal.muted); }

  function maxMotion(zoneName) {
    var m = 0;
    data.links.forEach(function (l) { if (l.zone === zoneName) { m = Math.max(m, l.motion_value); } });
    return m;
  }

  // Floor with a far-to-near gradient and a grid that fades with distance.
  function drawFloor(pal) {
    var halfW = ROOM_W / 2, halfD = ROOM_D / 2, i;
    tmp[0] = 0; tmp[1] = 0; tmp[2] = -halfD; tmpB[0] = 0; tmpB[1] = 0; tmpB[2] = halfD;
    if (project(tmp, cam, view, pt) && project(tmpB, cam, view, pa)) {
      var grad = g.createLinearGradient(pt.x, pt.y, pa.x, pa.y);
      grad.addColorStop(0, pal.accent); grad.addColorStop(1, pal.line);
      g.globalAlpha = 0.16;
      fillQuad([[-halfW, 0, -halfD], [halfW, 0, -halfD], [halfW, 0, halfD], [-halfW, 0, halfD]], grad);
      g.globalAlpha = 1;
    }
    g.lineWidth = 1; g.strokeStyle = pal.accent;
    function gridLine(ax, az, bx, bz) {
      tmp[0] = ax; tmp[1] = 0; tmp[2] = az; tmpB[0] = bx; tmpB[1] = 0; tmpB[2] = bz;
      if (!project([(ax + bx) / 2, 0, (az + bz) / 2], cam, view, pa)) { return; }
      g.globalAlpha = clamp(GRID_ALPHA - (pa.depth - cam.dist * (view.distScale || 1)) * GRID_FADE, GRID_ALPHA_MIN, GRID_ALPHA);
      g.beginPath(); line(tmp, tmpB); g.stroke();
    }
    for (i = -halfW; i <= halfW; i += GRID_STEP) { gridLine(i, -halfD, i, halfD); }
    for (i = -halfD; i <= halfD; i += GRID_STEP) { gridLine(-halfW, i, halfW, i); }
    g.globalAlpha = 1;
  }

  function drawRoomFrame(pal) {
    var halfW = ROOM_W / 2, halfD = ROOM_D / 2;
    g.strokeStyle = pal.accent; g.globalAlpha = 0.45; g.lineWidth = 1; g.beginPath();
    drawBox(-halfW, halfW, 0, ROOM_H, -halfD, halfD); g.stroke(); g.globalAlpha = 1;
  }

  // Expanding rings on the floor around the access point; the clock is frozen under reduced motion.
  function drawWaves(tSec, pal) {
    var n = profile.rings;
    g.strokeStyle = pal.accent; g.lineWidth = 1.6;
    for (var k = 0; k < n; k++) {
      var phase = (tSec * WAVE_SPEED + k / n) % 1, radius = phase * WAVE_RADIUS;
      g.globalAlpha = (1 - phase) * WAVE_ALPHA;
      g.beginPath();
      var started = false;
      for (var s = 0; s <= WAVE_SEGMENTS; s++) {
        var a = (s / WAVE_SEGMENTS) * TWO_PI;
        tmp[0] = ROUTER_POS[0] + Math.cos(a) * radius; tmp[1] = 0.01; tmp[2] = ROUTER_POS[2] + Math.sin(a) * radius;
        if (Math.abs(tmp[0]) > ROOM_W / 2 || Math.abs(tmp[2]) > ROOM_D / 2) { started = false; continue; }
        if (!project(tmp, cam, view, pt)) { started = false; continue; }
        if (started) { g.lineTo(pt.x, pt.y); } else { g.moveTo(pt.x, pt.y); started = true; }
      }
      g.stroke();
    }
    g.globalAlpha = 1;
  }

  function drawDust(tSec, pal) {
    g.fillStyle = pal.fg;
    for (var i = 0; i < dust.length; i++) {
      var d = dust[i];
      tmp[0] = d.x + Math.sin(tSec * d.speed + d.phase) * DUST_DRIFT;
      tmp[1] = d.y + Math.cos(tSec * d.speed * 0.7 + d.phase) * DUST_DRIFT;
      tmp[2] = d.z;
      if (!project(tmp, cam, view, pt)) { continue; }
      g.globalAlpha = DUST_ALPHA * (0.5 + 0.5 * Math.sin(tSec * d.speed * 2 + d.phase));
      g.beginPath(); g.arc(pt.x, pt.y, Math.max(0.6, pt.scale * DUST_SIZE), 0, TWO_PI); g.fill();
    }
    g.globalAlpha = 1;
  }

  // One soft particle. With depth-of-field, points away from the focal depth grow, fade and get a halo.
  function fxDot(p, radius, color, alpha) {
    if (!project(p, cam, view, pt)) { return; }
    var blur = profile.dof ? focusBlur(pt.depth, cam.dist * (view.distScale || 1)) : 0;
    var r = Math.max(0.8, radius * pt.scale * (1 + DOF_GROW * blur));
    g.fillStyle = color;
    g.globalAlpha = alpha * (1 - DOF_FADE * blur); g.beginPath(); g.arc(pt.x, pt.y, r, 0, TWO_PI); g.fill();
    if (blur > 0.15) {
      g.globalAlpha = alpha * 0.25 * blur; g.beginPath(); g.arc(pt.x, pt.y, r * 1.8, 0, TWO_PI); g.fill();
    }
  }

  // WiFi particles flow from each access point along arcs toward the rooms. CSI activity particles rise
  // from occupied rooms. Both vanish on low quality and hold still under reduced motion (frozen clock).
  function drawFlows(tSec, pal, sources, targets, active) {
    var n = profile.flow;
    if (!n || !targets.length) { return; }
    g.globalCompositeOperation = profile.bloom ? "lighter" : "source-over";
    sources.forEach(function (src, si) {
      for (var k = 0; k < n; k++) {
        var sd = FX_SEEDS_LIST[(k + si * n) % FX_SEEDS];
        var phase = (tSec * FLOW_SPEED * (0.6 + sd.b) + sd.a) % 1;
        arcPoint(src, targets[k % targets.length], phase, FLOW_LIFT, tmp);
        fxDot(tmp, FLOW_DOT, pal.accent, Math.sin(Math.PI * phase) * 0.8);
      }
    });
    active.forEach(function (c, ci) {
      for (var k = 0; k < Math.ceil(n / 2); k++) {
        var sd = FX_SEEDS_LIST[(k * 3 + ci * 7) % FX_SEEDS];
        var phase = (tSec * RISE_SPEED * (0.6 + sd.b) + sd.a) % 1;
        tmp[0] = c.p[0] + (sd.c - 0.5) * RISE_SPREAD + Math.sin(tSec + sd.a * TWO_PI) * 0.08;
        tmp[1] = c.p[1] + phase * RISE_HEIGHT;
        tmp[2] = c.p[2] + (sd.b - 0.5) * RISE_SPREAD;
        fxDot(tmp, FLOW_DOT * 0.8, c.color, (1 - phase) * 0.8);
      }
    });
    g.globalCompositeOperation = "source-over"; g.globalAlpha = 1;
  }

  function drawZone(r, z, tSec, pal, heartBpm) {
    var col = zoneColor(z, pal), occupied = z.presence || z.motion;
    g.globalAlpha = occupied ? 0.3 : 0.1;
    fillQuad([[r.x0, 0, r.z0], [r.x1, 0, r.z0], [r.x1, 0, r.z1], [r.x0, 0, r.z1]], col);
    g.globalAlpha = 1;
    var breathing = z.breathing_bpm !== null && z.breathing_bpm !== undefined;
    var breath = breathing ? Math.sin(pulsePhase(z.breathing_bpm, tSec)) : 0;
    var vol = volumeHeight(maxMotion(z.zone), breath ? pulsePhase(z.breathing_bpm, tSec) : 0, breathing);
    if (occupied) {
      // soft glowing volume: translucent walls and lid, then glowing edges
      g.globalAlpha = VOLUME_FILL_ALPHA;
      fillQuad([[r.x0, 0, r.z0], [r.x1, 0, r.z0], [r.x1, vol, r.z0], [r.x0, vol, r.z0]], col);
      fillQuad([[r.x0, 0, r.z0], [r.x0, 0, r.z1], [r.x0, vol, r.z1], [r.x0, vol, r.z0]], col);
      fillQuad([[r.x1, 0, r.z0], [r.x1, 0, r.z1], [r.x1, vol, r.z1], [r.x1, vol, r.z0]], col);
      fillQuad([[r.x0, 0, r.z1], [r.x1, 0, r.z1], [r.x1, vol, r.z1], [r.x0, vol, r.z1]], col);
      fillQuad([[r.x0, vol, r.z0], [r.x1, vol, r.z0], [r.x1, vol, r.z1], [r.x0, vol, r.z1]], col);
      g.globalAlpha = 0.85; g.strokeStyle = col; g.lineWidth = 1.5; setGlow(col, 12);
      g.beginPath(); drawBox(r.x0, r.x1, 0, vol, r.z0, r.z1); g.stroke();
      clearGlow(); g.globalAlpha = 1;
      var zHeart = z.heart_bpm !== null && z.heart_bpm !== undefined ? z.heart_bpm : heartBpm;
      drawPerson(zoneCenter(r), breath, zHeart, tSec, col, pal);
    }
    tmp[0] = (r.x0 + r.x1) / 2; tmp[1] = 0.02; tmp[2] = r.z0 + 0.1;
    if (project(tmp, cam, view, pt)) {
      g.fillStyle = pal.fg; g.font = "12px system-ui, sans-serif"; g.textAlign = "center";
      g.fillText(z.zone.replace(/_/g, " "), pt.x, pt.y);
    }
  }

  // Stylised person: capsule torso and head, chest swells with breath, ring pulses with the heart rate.
  function drawPerson(center, breath, heartBpm, tSec, col, pal) {
    var swell = 1 + PERSON_BREATH_SWELL * breath;
    var foot = [center[0], 0, center[2]], neck = [center[0], PERSON_SHOULDER_Y, center[2]];
    var head = [center[0], PERSON_HEAD_Y, center[2]];
    if (!project(foot, cam, view, pt) || !project(neck, cam, view, pa)) { return; }
    g.lineCap = "round"; g.strokeStyle = col; g.globalAlpha = PERSON_ALPHA; setGlow(col, 16);
    g.lineWidth = PERSON_BODY_W * swell * pa.scale;
    g.beginPath(); g.moveTo(pt.x, pt.y); g.lineTo(pa.x, pa.y); g.stroke();
    if (project(head, cam, view, pt)) {
      g.fillStyle = col; g.beginPath(); g.arc(pt.x, pt.y, PERSON_HEAD_R * pt.scale, 0, TWO_PI); g.fill();
    }
    clearGlow(); g.lineCap = "butt"; g.globalAlpha = 1;
    if (heartBpm) {
      var beat = Math.pow(Math.max(0, Math.sin(pulsePhase(heartBpm, tSec))), 4);
      tmp[0] = center[0]; tmp[1] = PERSON_CHEST_Y; tmp[2] = center[2];
      if (project(tmp, cam, view, pt)) {
        g.strokeStyle = pal.accent2; g.globalAlpha = 0.9 - 0.7 * beat; g.lineWidth = 2;
        g.beginPath(); g.arc(pt.x, pt.y, (PERSON_BODY_W * 0.6 + HEART_RING_GROW * beat) * pt.scale, 0, TWO_PI); g.stroke();
        g.fillStyle = pal.accent2; g.globalAlpha = 1;
        g.beginPath(); g.arc(pt.x, pt.y, 2.5 + 2.5 * beat, 0, TWO_PI); g.fill();
      }
    }
  }

  function linkPoints(l, rects, perZone, index) {
    var r = null;
    for (var k = 0; k < rects.length; k++) { if (rects[k].zone === l.zone) { r = rects[k]; } }
    if (!r) { return null; }
    var n = index[l.zone] = (index[l.zone] === undefined ? 0 : index[l.zone] + 1);
    l.labelRow = n % 2;
    return linkNodePos(r, n, perZone[l.zone]);
  }

  function strokeArc(node) {
    g.beginPath();
    for (var s = 0; s <= ARC_SEGMENTS; s++) {
      arcPoint(ROUTER_POS, node, s / ARC_SEGMENTS, ARC_LIFT, tmp);
      if (!project(tmp, cam, view, pt)) { continue; }
      if (s === 0) { g.moveTo(pt.x, pt.y); } else { g.lineTo(pt.x, pt.y); }
    }
    g.stroke();
  }

  function drawLinks(rects, tSec, pal) {
    var perZone = {}, index = {};
    data.links.forEach(function (l) { perZone[l.zone] = (perZone[l.zone] || 0) + 1; });
    data.links.forEach(function (l) {
      var node = linkPoints(l, rects, perZone, index);
      if (!node) { return; }
      var strength = clamp((l.rssi + 90) / 50, 0.1, 1), col = l.motion ? pal.bad : pal.accent;
      g.strokeStyle = col;
      if (profile.glow) { g.globalAlpha = 0.12 + 0.18 * strength; g.lineWidth = ARC_GLOW_W; strokeArc(node); }
      g.globalAlpha = 0.3 + 0.5 * strength; g.lineWidth = 1.4; setGlow(col, 8); strokeArc(node); clearGlow();
      g.globalAlpha = 1; g.fillStyle = pal.accent2;
      for (var p = 0; p < PACKET_COUNT; p++) {
        var head = (tSec * PACKET_SPEED + p / PACKET_COUNT) % 1;
        for (var tail = PULSE_TAIL - 1; tail >= 0; tail--) {
          var tt = head - tail * PULSE_TAIL_STEP;
          if (tt < 0) { continue; }
          arcPoint(ROUTER_POS, node, tt, ARC_LIFT, tmp);
          if (!project(tmp, cam, view, pt)) { continue; }
          g.globalAlpha = 1 - tail / PULSE_TAIL;
          g.beginPath(); g.arc(pt.x, pt.y, 2.6 - tail * 0.5, 0, TWO_PI); g.fill();
        }
      }
      g.globalAlpha = 1;
      if (project(node, cam, view, pt)) {
        g.fillStyle = col; setGlow(col, 10); g.beginPath(); g.arc(pt.x, pt.y, 4, 0, TWO_PI); g.fill(); clearGlow();
        g.fillStyle = pal.muted; g.font = "11px system-ui, sans-serif"; g.textAlign = "center";
        g.fillText(l.link, pt.x, pt.y + 14 + LABEL_STAGGER_PX * (l.labelRow || 0));
      }
    });
  }

  function drawRouter(tSec, pal) {
    if (!project(ROUTER_POS, cam, view, pt)) { return; }
    var pulse = 0.5 + 0.5 * Math.sin(tSec * ROUTER_PULSE);
    g.fillStyle = pal.accent; setGlow(pal.accent, 10 + 10 * pulse);
    g.fillRect(pt.x - 6, pt.y - 6, 12, 12); clearGlow();
    g.fillStyle = pal.fg; g.font = "11px system-ui, sans-serif"; g.textAlign = "center";
    g.fillText("access point", pt.x, pt.y - 12);
  }


  // ---- digital twin layer ----------------------------------------------------
  function zoneState(roomId) {
    for (var i = 0; i < data.zones.length; i++) { if (data.zones[i].zone === roomId) { return data.zones[i]; } }
    return null;
  }

  function visibleFloors() {
    var floors = twin.model.floors.slice().sort(function (a, b) { return a.level - b.level; });
    if (twin.floor === "all") { return floors; }
    return floors.filter(function (f) { return f.id === twin.floor; });
  }

  function rectQuad(x, y, w, d, e, s, ext) {
    return [twinPoint(x, y, e, s, ext), twinPoint(x + w, y, e, s, ext), twinPoint(x + w, y + d, e, s, ext), twinPoint(x, y + d, e, s, ext)];
  }

  function drawHeat(floor, e, s, ext) {
    var grid = twin.heat[floor.id];
    if (!grid || !twin.showHeat) { return; }
    var step = profile.heatStep, cell = grid.cell_m;
    var base = g.globalAlpha;
    g.globalAlpha = HEAT_ALPHA * base;
    for (var r = 0; r < grid.rows; r += step) {
      for (var c = 0; c < grid.cols; c += step) {
        var col = heatColor(grid.rssi[r][c] + twin.offsetDb);
        fillQuad(rectQuad(c * cell, r * cell, cell * step, cell * step, e + 0.01, s, ext), "rgb(" + col[0] + "," + col[1] + "," + col[2] + ")");
      }
    }
    g.globalAlpha = base;
  }

  function drawTwinFloor(floor, active, tSec, pal, ext, s, stacked) {
    var e = floorElevation(floor, stacked, ext, s), wallH = floor.height_m * s, dim = active ? 1 : TWIN_DIM_ALPHA, byWall = {};
    g.globalAlpha = dim;
    drawHeat(floor, e, s, ext);
    g.globalAlpha = dim;
    floor.rooms.forEach(function (room) {
      var zs = zoneState(room.id), occupied = zs && (zs.presence || zs.motion);
      var col = zs && zs.motion ? pal.bad : (occupied ? pal.ok : pal.accent);
      var tint = occupied ? TWIN_OCCUPIED_ALPHA : TWIN_ROOM_ALPHA;
      if (twin.occupancy !== null) { tint = TWIN_ROOM_ALPHA + (TWIN_OCCUPIED_ALPHA - TWIN_ROOM_ALPHA) * twin.occupancy; col = pal.ok; }
      g.globalAlpha = dim * tint;
      fillQuad(rectQuad(room.x, room.y, room.w, room.d, e, s, ext), col);
      g.globalAlpha = dim;
      if (occupied && twin.occupancy === null) {
        g.strokeStyle = col; g.lineWidth = 1.4; setGlow(col, 10); g.beginPath();
        drawBox(twinPoint(room.x, room.y, e, s, ext)[0], twinPoint(room.x + room.w, room.y, e, s, ext)[0], e, e + wallH * 0.5,
                twinPoint(room.x, room.y, e, s, ext)[2], twinPoint(room.x, room.y + room.d, e, s, ext)[2]);
        g.stroke(); clearGlow();
      }
      tmp[0] = twinPoint(room.x + room.w / 2, 0, e, s, ext)[0]; tmp[1] = e + 0.02; tmp[2] = twinPoint(0, room.y + room.d / 2, e, s, ext)[2];
      if (project(tmp, cam, view, pt)) {
        g.fillStyle = pal.fg; g.font = "11px system-ui, sans-serif"; g.textAlign = "center"; g.fillText(room.name, pt.x, pt.y);
      }
    });
    g.strokeStyle = pal.accent; g.lineWidth = 1.4;
    floor.walls.forEach(function (w) {
      byWall[w.id] = w;
      var a = twinPoint(w.x1, w.y1, e, s, ext), b = twinPoint(w.x2, w.y2, e, s, ext);
      g.globalAlpha = dim * TWIN_WALL_FILL_ALPHA;
      fillQuad([a, b, [b[0], e + wallH, b[2]], [a[0], e + wallH, a[2]]], pal.accent2 || pal.accent);
      g.globalAlpha = dim * (w.kind === "exterior" ? 0.9 : 0.55);
      g.beginPath(); line(a, b); line([a[0], e + wallH, a[2]], [b[0], e + wallH, b[2]]); line(a, [a[0], e + wallH, a[2]]); g.stroke();
    });
    floor.openings.forEach(function (o) {
      var w = byWall[o.wall];
      if (!w) { return; }
      var span = openingSpan(w, o), lo = o.kind === "door" ? 0 : WINDOW_LO * s, hi = (o.kind === "door" ? DOOR_H : WINDOW_HI) * s;
      var a = twinPoint(span[0][0], span[0][1], e, s, ext), b = twinPoint(span[1][0], span[1][1], e, s, ext);
      g.globalAlpha = dim; g.strokeStyle = o.kind === "door" ? pal.warn || pal.accent2 : pal.fg; g.lineWidth = 2.2;
      g.beginPath(); line([a[0], e + lo, a[2]], [b[0], e + lo, b[2]]); line([a[0], e + hi, a[2]], [b[0], e + hi, b[2]]);
      line([a[0], e + lo, a[2]], [a[0], e + hi, a[2]]); line([b[0], e + lo, b[2]], [b[0], e + hi, b[2]]); g.stroke();
    });
    g.strokeStyle = pal.muted; g.lineWidth = 1.2; g.globalAlpha = dim * 0.9;
    floor.furniture.forEach(function (f) {
      var a = twinPoint(f.x, f.y, e, s, ext), b = twinPoint(f.x + f.w, f.y + f.d, e, s, ext);
      g.beginPath(); drawBox(a[0], b[0], e, e + (TWIN_FURNITURE_H[f.kind] || TWIN_FURNITURE_H.other) * s, a[2], b[2]); g.stroke();
    });
    g.globalAlpha = dim;
    floor.sensors.forEach(function (sn) {
      var p = twinPoint(sn.x, sn.y, e + 0.12, s, ext);
      if (!project(p, cam, view, pt)) { return; }
      g.fillStyle = sn.kind === "air" ? pal.ok : pal.accent2; g.beginPath();
      g.moveTo(pt.x, pt.y - 6); g.lineTo(pt.x + 6, pt.y); g.lineTo(pt.x, pt.y + 6); g.lineTo(pt.x - 6, pt.y); g.closePath(); g.fill();
      g.fillStyle = pal.muted; g.font = "10px system-ui, sans-serif"; g.textAlign = "center"; g.fillText(sn.id, pt.x, pt.y + 16);
    });
    if (profile.glow) {      // neon edge on the outer walls
      g.strokeStyle = pal.accent; g.lineWidth = 2.4; g.globalAlpha = dim * 0.55; setGlow(pal.accent, 10); g.beginPath();
      floor.walls.forEach(function (w) {
        if (w.kind === "exterior") { line(twinPoint(w.x1, w.y1, e + wallH, s, ext), twinPoint(w.x2, w.y2, e + wallH, s, ext)); }
      });
      g.stroke(); clearGlow(); g.globalAlpha = dim;
    }
    var fxTargets = [], fxActive = [];
    floor.rooms.forEach(function (room) {
      var zs = zoneState(room.id), c = twinPoint(room.x + room.w / 2, room.y + room.d / 2, e + 0.3, s, ext);
      fxTargets.push(c);
      if (active && ((zs && (zs.presence || zs.motion)) || (twin.occupancy !== null && twin.occupancy > 0.5))) {
        fxActive.push({ p: c, color: zs && zs.motion ? pal.bad : pal.ok });
      }
    });
    drawFlows(tSec, pal, floor.aps.map(function (ap) { return twinPoint(ap.x, ap.y, e + 0.2, s, ext); }), fxTargets, fxActive);
    g.globalAlpha = dim;
    var pulse = 0.5 + 0.5 * Math.sin(tSec * ROUTER_PULSE);
    floor.aps.forEach(function (ap) {
      var p = twinPoint(ap.x, ap.y, e + 0.2, s, ext);
      if (!project(p, cam, view, pt)) { return; }
      g.fillStyle = pal.accent; setGlow(pal.accent, 8 + 8 * pulse); g.fillRect(pt.x - 6, pt.y - 6, 12, 12); clearGlow();
      g.fillStyle = pal.fg; g.font = "11px system-ui, sans-serif"; g.textAlign = "center"; g.fillText(ap.id, pt.x, pt.y - 12);
    });
    g.globalAlpha = 1;
  }

  function drawTwin(tSec, pal) {
    var ext = twinExtent(twin.model), stacked = twin.floor === "all" && twin.model.floors.length > 1;
    var s = twinScale(twin.model) * (stacked ? TWIN_STACKED_SHRINK : 1);
    var shown = visibleFloors();
    shown.forEach(function (f) { drawTwinFloor(f, true, tSec, pal, ext, s, stacked); });
    g.textAlign = "left";
  }

  function drawVignette() {
    var w = view.w, h = view.h;
    var grad = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * VIGNETTE_INNER, w / 2, h / 2, Math.max(w, h) * VIGNETTE_OUTER);
    grad.addColorStop(0, "rgba(0,0,0,0)"); grad.addColorStop(1, "rgba(0,0,0," + VIGNETTE_ALPHA + ")");
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
  }

  function drawScene(tSec) {
    var pal = data.palette;
    g.clearRect(0, 0, view.w, view.h);
    if (twin.model && twin.mode === "twin") {
      drawTwin(tSec, pal);
      if (profile.dust) { drawDust(tSec, pal); }
      drawVignette();
      return;
    }
    drawFloor(pal);
    drawRoomFrame(pal);
    drawWaves(tSec, pal);
    if (profile.dust) { drawDust(tSec, pal); }
    var rects = zoneRects(data.zones.map(function (z) { return z.zone; }));
    var rectByZone = {};
    rects.forEach(function (r) { rectByZone[r.zone] = r; });
    var heartBpm = data.vitals && data.vitals.heart_bpm;
    // far zones first so nearer volumes blend over them
    var order = data.zones.map(function (z) {
      var c = zoneCenter(rectByZone[z.zone]);
      return { z: z, depth: project(c, cam, view, pt) ? pt.depth : 0 };
    }).sort(function (a, b) { return b.depth - a.depth; });
    order.forEach(function (o) { drawZone(rectByZone[o.z.zone], o.z, tSec, pal, heartBpm); });
    drawLinks(rects, tSec, pal);
    drawRouter(tSec, pal);
    var fxTargets = [], fxActive = [];
    data.zones.forEach(function (z) {
      var c = zoneCenter(rectByZone[z.zone]); c[1] = 0.3; fxTargets.push(c);
      if (z.presence || z.motion) { fxActive.push({ p: c, color: zoneColor(z, pal) }); }
    });
    drawFlows(tSec, pal, [ROUTER_POS], fxTargets, fxActive);
    drawVignette();
  }

  function resize() {
    var rect = canvas.getBoundingClientRect(), dpr = Math.min(root.devicePixelRatio || 1, profile.dprCap);
    var w = Math.max(1, Math.round(rect.width * dpr)), h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; dirty = true; }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.scale(dpr, dpr); view.w = w / dpr; view.h = h / dpr;
    view.distScale = Math.max(1, MIN_ASPECT / (view.w / view.h));
  }

  function setQuality(name) {
    quality = normaliseQuality(name); profile = QUALITY_PROFILES[quality];
    dust = dustParticles(profile.dust); frameTimes = []; framesSeen = 0; dirty = true;
  }

  // Averages recent frame intervals and drops to low when the device cannot keep up.
  function watchFrameTime(interval) {
    if (quality === "low" || ++framesSeen <= WARMUP_FRAMES) { return; }
    frameTimes.push(interval);
    if (frameTimes.length < FRAME_SAMPLES) { return; }
    var sum = 0;
    frameTimes.forEach(function (v) { sum += v; });
    var next = qualityForFrameTime(quality, sum / frameTimes.length);
    frameTimes = [];
    if (next !== quality) { setQuality(next); if (onQualityChange) { onQualityChange(next); } }
  }

  function frame(now) {
    if (!running) { return; }
    root.requestAnimationFrame(frame);
    if (profile.fps && now - lastDraw < 1000 / profile.fps) { return; }
    if (reducedMotion && !dirty) { lastFrame = now; return; }
    var dt = lastFrame ? (now - lastFrame) / 1000 : 0;
    if (lastFrame) { watchFrameTime(now - lastFrame); }
    lastFrame = now; lastDraw = now;
    if (autoRotate && !drag && !reducedMotion) { cam.yaw += AUTO_ROTATE_RAD_S * dt; }
    resize();
    if (data.palette) { drawScene(reducedMotion ? STILL_TIME : now / 1000); }
    dirty = false;
  }

  function setRunning(on) {
    if (on && !running) { running = true; lastFrame = 0; root.requestAnimationFrame(frame); }
    if (!on) { running = false; }
  }

  function zoom(factor) { cam.dist = clamp(cam.dist * factor, DIST_MIN, DIST_MAX); dirty = true; }

  function init(el) {
    canvas = el; g = canvas.getContext("2d");
    var mq = root.matchMedia ? root.matchMedia("(prefers-reduced-motion: reduce)") : null;
    reducedMotion = !!(mq && mq.matches);
    if (reducedMotion) { autoRotate = false; }
    if (mq && mq.addEventListener) {
      mq.addEventListener("change", function (e) { reducedMotion = e.matches; if (reducedMotion) { autoRotate = false; } dirty = true; });
    }
    canvas.addEventListener("pointerdown", function (e) { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener("pointermove", function (e) {
      if (!drag) { return; }
      cam.yaw += (e.clientX - drag.x) * 0.008;
      cam.pitch = clamp(cam.pitch + (e.clientY - drag.y) * 0.006, PITCH_MIN, PITCH_MAX);
      drag.x = e.clientX; drag.y = e.clientY; dirty = true;
    });
    function end() { drag = null; }
    canvas.addEventListener("pointerup", end); canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("wheel", function (e) { e.preventDefault(); zoom(e.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP); }, { passive: false });
    canvas.addEventListener("keydown", function (e) {
      if (e.key === "ArrowLeft") { cam.yaw -= 0.1; } else if (e.key === "ArrowRight") { cam.yaw += 0.1; }
      else if (e.key === "ArrowUp") { cam.pitch = clamp(cam.pitch + 0.05, PITCH_MIN, PITCH_MAX); }
      else if (e.key === "ArrowDown") { cam.pitch = clamp(cam.pitch - 0.05, PITCH_MIN, PITCH_MAX); }
      else if (e.key === "+" || e.key === "=") { zoom(1 / ZOOM_STEP); } else if (e.key === "-") { zoom(ZOOM_STEP); }
      else { return; }
      dirty = true; e.preventDefault();
    });
    root.document.addEventListener("visibilitychange", function () { setRunning(!root.document.hidden); });
    setRunning(true);
  }

  root.Room3D = {
    init: init,
    setTwin: function (model) { twin.model = model; dirty = true; },
    setTwinFloor: function (id) { twin.floor = id; dirty = true; },
    setViewMode: function (mode) { twin.mode = mode === "signal" ? "signal" : "twin"; dirty = true; },
    getViewMode: function () { return twin.mode; },
    setHeat: function (floorId, grid) { twin.heat[floorId] = grid; dirty = true; },
    showHeat: function (on) { twin.showHeat = !!on; dirty = true; },
    // Playback: shifts the modelled signal by dB and tints rooms by occupancy (0..1). null restores live.
    setPlayback: function (offsetDb, occupancy) { twin.offsetDb = offsetDb || 0; twin.occupancy = occupancy === undefined ? null : occupancy; dirty = true; },
    update: function (zones, links, vitals, palette) { data.zones = zones; data.links = links; data.vitals = vitals; data.palette = palette; dirty = true; },
    zoomIn: function () { zoom(1 / ZOOM_STEP); },
    zoomOut: function () { zoom(ZOOM_STEP); },
    reset: function () { cam.yaw = CAMERA.yaw; cam.pitch = CAMERA.pitch; cam.dist = CAMERA.dist; dirty = true; },
    setAutoRotate: function (on) { autoRotate = on && !reducedMotion; },
    isAutoRotating: function () { return autoRotate; },
    setQuality: setQuality,
    getQuality: function () { return quality; },
    onQualityChange: function (fn) { onQualityChange = fn; }
  };
})(typeof window !== "undefined" ? window : null);
