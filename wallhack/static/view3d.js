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

  var api = { project: project, arcPoint: arcPoint, zoneRects: zoneRects, zoneCenter: zoneCenter,
              linkNodePos: linkNodePos, volumeHeight: volumeHeight, pulsePhase: pulsePhase, clamp: clamp,
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
  var drag = null, lastFrame = 0, running = false;

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

  function zoneColor(z, pal) { return z.motion ? pal.bad : (z.presence ? pal.ok : pal.muted); }

  function maxMotion(zoneName) {
    var m = 0;
    data.links.forEach(function (l) { if (l.zone === zoneName) { m = Math.max(m, l.motion_value); } });
    return m;
  }

  function drawScene(tSec) {
    var pal = data.palette, w = view.w, h = view.h;
    g.clearRect(0, 0, w, h);
    var halfW = ROOM_W / 2, halfD = ROOM_D / 2, i;

    // floor grid
    g.lineWidth = 1; g.strokeStyle = pal.line; g.beginPath();
    for (i = -halfW; i <= halfW; i += GRID_STEP) { tmp[0] = i; tmp[1] = 0; tmp[2] = -halfD; tmpB[0] = i; tmpB[1] = 0; tmpB[2] = halfD; line(tmp, tmpB); }
    for (i = -halfD; i <= halfD; i += GRID_STEP) { tmp[0] = -halfW; tmp[1] = 0; tmp[2] = i; tmpB[0] = halfW; tmpB[1] = 0; tmpB[2] = i; line(tmp, tmpB); }
    g.stroke();
    // room wireframe
    g.strokeStyle = pal.accent; g.globalAlpha = 0.5; g.beginPath();
    drawBox(-halfW, halfW, 0, ROOM_H, -halfD, halfD); g.stroke(); g.globalAlpha = 1;

    var rects = zoneRects(data.zones.map(function (z) { return z.zone; }));
    var rectByZone = {};
    rects.forEach(function (r) { rectByZone[r.zone] = r; });
    var heartBpm = data.vitals && data.vitals.heart_bpm;

    // zone floor patches and volumes
    data.zones.forEach(function (z) {
      var r = rectByZone[z.zone], col = zoneColor(z, pal);
      g.globalAlpha = z.presence ? 0.3 : 0.1;
      fillQuad([[r.x0, 0, r.z0], [r.x1, 0, r.z0], [r.x1, 0, r.z1], [r.x0, 0, r.z1]], col);
      g.globalAlpha = 1;
      var breathing = z.breathing_bpm !== null && z.breathing_bpm !== undefined;
      var vol = volumeHeight(maxMotion(z.zone), breathing ? pulsePhase(z.breathing_bpm, tSec) : 0, breathing);
      if (z.presence || z.motion) {
        g.globalAlpha = 0.16; g.fillStyle = col;
        fillQuad([[r.x0, vol, r.z0], [r.x1, vol, r.z0], [r.x1, vol, r.z1], [r.x0, vol, r.z1]], col);
        g.globalAlpha = 0.85; g.strokeStyle = col; g.lineWidth = 1.5; g.shadowColor = col; g.shadowBlur = 12;
        g.beginPath(); drawBox(r.x0, r.x1, 0, vol, r.z0, r.z1); g.stroke();
        g.shadowBlur = 0; g.globalAlpha = 1;
        var zHeart = z.heart_bpm !== null && z.heart_bpm !== undefined ? z.heart_bpm : heartBpm;
        if (zHeart) { drawHeartRing(zoneCenter(r), vol, zHeart, tSec, pal); }
      }
      tmp[0] = (r.x0 + r.x1) / 2; tmp[1] = 0.02; tmp[2] = r.z0 + 0.1;
      if (project(tmp, cam, view, pt)) {
        g.fillStyle = pal.fg; g.font = "12px system-ui, sans-serif"; g.textAlign = "center";
        g.fillText(z.zone.replace(/_/g, " "), pt.x, pt.y);
      }
    });

    drawLinks(rects, tSec, pal);
    drawRouter(pal);
  }

  function drawHeartRing(center, top, bpm, tSec, pal) {
    var beat = Math.pow(Math.max(0, Math.sin(pulsePhase(bpm, tSec))), 4);
    tmp[0] = center[0]; tmp[1] = top; tmp[2] = center[2];
    if (!project(tmp, cam, view, pt)) { return; }
    g.strokeStyle = pal.accent2; g.globalAlpha = 0.9 - 0.5 * beat; g.lineWidth = 2;
    g.beginPath(); g.arc(pt.x, pt.y, (6 + 14 * beat) * pt.scale / 60, 0, TWO_PI); g.stroke();
    g.fillStyle = pal.accent2; g.globalAlpha = 1;
    g.beginPath(); g.arc(pt.x, pt.y, 3 + 2 * beat, 0, TWO_PI); g.fill();
  }

  function drawLinks(rects, tSec, pal) {
    var perZone = {}, index = {};
    data.links.forEach(function (l) { perZone[l.zone] = (perZone[l.zone] || 0) + 1; });
    data.links.forEach(function (l) {
      var r = null;
      for (var k = 0; k < rects.length; k++) { if (rects[k].zone === l.zone) { r = rects[k]; } }
      if (!r) { return; }
      var n = index[l.zone] = (index[l.zone] === undefined ? 0 : index[l.zone] + 1);
      var node = linkNodePos(r, n, perZone[l.zone]);
      var strength = clamp((l.rssi + 90) / 50, 0.1, 1);
      g.strokeStyle = l.motion ? pal.bad : pal.accent; g.globalAlpha = 0.25 + 0.5 * strength; g.lineWidth = 1.4;
      g.beginPath();
      for (var s = 0; s <= ARC_SEGMENTS; s++) {
        arcPoint(ROUTER_POS, node, s / ARC_SEGMENTS, ARC_LIFT, tmp);
        if (!project(tmp, cam, view, pt)) { continue; }
        if (s === 0) { g.moveTo(pt.x, pt.y); } else { g.lineTo(pt.x, pt.y); }
      }
      g.stroke(); g.globalAlpha = 1;
      g.fillStyle = pal.accent2;
      for (var p = 0; p < PACKET_COUNT; p++) {
        arcPoint(ROUTER_POS, node, (tSec * PACKET_SPEED + p / PACKET_COUNT) % 1, ARC_LIFT, tmp);
        if (project(tmp, cam, view, pt)) { g.beginPath(); g.arc(pt.x, pt.y, 2.4, 0, TWO_PI); g.fill(); }
      }
      if (project(node, cam, view, pt)) {
        g.fillStyle = l.motion ? pal.bad : pal.accent; g.beginPath(); g.arc(pt.x, pt.y, 4, 0, TWO_PI); g.fill();
        g.fillStyle = pal.muted; g.font = "11px system-ui, sans-serif"; g.textAlign = "center";
        g.fillText(l.link, pt.x, pt.y + 14);
      }
    });
  }

  function drawRouter(pal) {
    if (!project(ROUTER_POS, cam, view, pt)) { return; }
    g.fillStyle = pal.accent; g.shadowColor = pal.accent; g.shadowBlur = 14;
    g.fillRect(pt.x - 6, pt.y - 6, 12, 12); g.shadowBlur = 0;
    g.fillStyle = pal.fg; g.font = "11px system-ui, sans-serif"; g.textAlign = "center";
    g.fillText("access point", pt.x, pt.y - 12);
  }

  function resize() {
    var rect = canvas.getBoundingClientRect(), dpr = Math.min(root.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.round(rect.width * dpr)), h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    view.w = w; view.h = h;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.scale(dpr, dpr); view.w = w / dpr; view.h = h / dpr;
    view.distScale = Math.max(1, MIN_ASPECT / (view.w / view.h));
  }

  function frame(now) {
    if (!running) { return; }
    var dt = lastFrame ? (now - lastFrame) / 1000 : 0;
    lastFrame = now;
    if (autoRotate && !drag) { cam.yaw += AUTO_ROTATE_RAD_S * dt; }
    resize();
    if (data.palette) { drawScene(now / 1000); }
    root.requestAnimationFrame(frame);
  }

  function setRunning(on) {
    if (on && !running) { running = true; lastFrame = 0; root.requestAnimationFrame(frame); }
    if (!on) { running = false; }
  }

  function zoom(factor) { cam.dist = clamp(cam.dist * factor, DIST_MIN, DIST_MAX); }

  function init(el) {
    canvas = el; g = canvas.getContext("2d");
    canvas.addEventListener("pointerdown", function (e) { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener("pointermove", function (e) {
      if (!drag) { return; }
      cam.yaw += (e.clientX - drag.x) * 0.008;
      cam.pitch = clamp(cam.pitch + (e.clientY - drag.y) * 0.006, PITCH_MIN, PITCH_MAX);
      drag.x = e.clientX; drag.y = e.clientY;
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
      e.preventDefault();
    });
    root.document.addEventListener("visibilitychange", function () { setRunning(!root.document.hidden); });
    setRunning(true);
  }

  root.Room3D = {
    init: init,
    update: function (zones, links, vitals, palette) { data.zones = zones; data.links = links; data.vitals = vitals; data.palette = palette; },
    zoomIn: function () { zoom(1 / ZOOM_STEP); },
    zoomOut: function () { zoom(ZOOM_STEP); },
    reset: function () { cam.yaw = CAMERA.yaw; cam.pitch = CAMERA.pitch; cam.dist = CAMERA.dist; },
    setAutoRotate: function (on) { autoRotate = on; },
    isAutoRotating: function () { return autoRotate; }
  };
})(typeof window !== "undefined" ? window : null);
