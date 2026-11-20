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
  var QUALITY_PROFILES = {
    low:    { dprCap: 1,   fps: 20, dust: 0,   rings: 2, glow: false },
    medium: { dprCap: 1.5, fps: 0,  dust: 36,  rings: 3, glow: true },
    high:   { dprCap: 2,   fps: 0,  dust: 110, rings: 4, glow: true }
  };
  var SLOW_FRAME_MS = 40;          // average frame time above this drops the quality to low
  var FRAME_SAMPLES = 45, WARMUP_FRAMES = 20;
  var DUST_SEED = 0x57A11, DUST_DRIFT = 0.12, DUST_SPEED_MIN = 0.15, DUST_SPEED_SPAN = 0.4;
  var WAVE_SPEED = 0.18, WAVE_RADIUS = 7.5, WAVE_SEGMENTS = 48;
  var STILL_TIME = 2.2;            // frozen animation clock (s) used under prefers-reduced-motion
  var UINT32 = 4294967296;
  var GRID_ALPHA = 0.55, GRID_ALPHA_MIN = 0.1, GRID_FADE = 0.12;
  var WAVE_ALPHA = 0.55, DUST_ALPHA = 0.5, DUST_SIZE = 0.012, VOLUME_FILL_ALPHA = 0.07;
  var PERSON_SHOULDER_Y = 1.3, PERSON_HEAD_Y = 1.62, PERSON_CHEST_Y = 1.0, PERSON_HEAD_R = 0.15;
  var PERSON_BODY_W = 0.26, PERSON_BREATH_SWELL = 0.12, PERSON_ALPHA = 0.55, HEART_RING_GROW = 0.35;
  var ARC_GLOW_W = 6, PULSE_TAIL = 4, PULSE_TAIL_STEP = 0.018, ROUTER_PULSE = 2.2;
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

  function normaliseQuality(name) { return QUALITY_LEVELS.indexOf(name) >= 0 ? name : DEFAULT_QUALITY; }

  // Quality to use after observing an average frame time in ms: only ever drops to low.
  function qualityForFrameTime(current, avgMs) { return avgMs > SLOW_FRAME_MS ? "low" : current; }

  var api = { project: project, arcPoint: arcPoint, zoneRects: zoneRects, zoneCenter: zoneCenter,
              linkNodePos: linkNodePos, volumeHeight: volumeHeight, pulsePhase: pulsePhase, clamp: clamp,
              dustParticles: dustParticles, normaliseQuality: normaliseQuality, qualityForFrameTime: qualityForFrameTime,
              QUALITY_LEVELS: QUALITY_LEVELS, DEFAULT_QUALITY: DEFAULT_QUALITY, SLOW_FRAME_MS: SLOW_FRAME_MS,
              ROOM: { w: ROOM_W, d: ROOM_D, h: ROOM_H }, MOTION_FULL_SCALE: MOTION_FULL_SCALE };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  if (!root || !root.document) { return; }

  // ---- canvas scene (browser only) ----------------------------------------
  var cam = { yaw: CAMERA.yaw, pitch: CAMERA.pitch, dist: CAMERA.dist, fov: CAMERA.fov };
  var pt = { x: 0, y: 0, depth: 0, scale: 0 };
  var pa = { x: 0, y: 0, depth: 0, scale: 0 };
  var tmp = [0, 0, 0], tmpB = [0, 0, 0];
  var autoRotate = true, canvas = null, g = null, view = { w: 0, h: 0 };
  var data = { zones: [], links: [], vitals: null, palette: null };
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
        g.fillText(l.link, pt.x, pt.y + 14);
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

  function drawVignette() {
    var w = view.w, h = view.h;
    var grad = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * VIGNETTE_INNER, w / 2, h / 2, Math.max(w, h) * VIGNETTE_OUTER);
    grad.addColorStop(0, "rgba(0,0,0,0)"); grad.addColorStop(1, "rgba(0,0,0," + VIGNETTE_ALPHA + ")");
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
  }

  function drawScene(tSec) {
    var pal = data.palette;
    g.clearRect(0, 0, view.w, view.h);
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
