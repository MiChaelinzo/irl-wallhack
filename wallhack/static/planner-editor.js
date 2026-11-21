"use strict";
// Planner floor-plan editor. The first half is pure geometry (snapping, rotation, hit testing,
// calibration, image sizing) and runs under node for tests/test_planner_state.py. The second half is
// the canvas editor: tools, handles, context menu, shortcuts, pan/zoom/pinch and image import.
// Every change goes through PlannerState (store.exec), so everything is undoable and the rest of the
// page (worker, renderer) only has to listen to the store.
(function (root) {
  var ANGLE_STEP_DEG = 15;
  var GRID_STEPS_M = [0.1, 0.25, 0.5, 1];
  var DEFAULT_GRID_M = 0.5;
  var ENDPOINT_SNAP_PX = 10;
  var HIT_PX = 8, HANDLE_PX = 9, ROT_OFFSET_PX = 30;
  var MIN_WALL_M = 0.1, DROP_WALL_M = 2;
  var MIN_SCALE = 2, MAX_SCALE = 400;
  var IMAGE_MAX_PX = 2048, JPEG_QUALITY = 0.85;
  var DEFAULT_TX_DBM = 20;

  // ------------------------------------------------------------------ pure geometry
  function snapValue(v, step) { return Math.round(v / step) * step; }

  /**
   * Snap a point. Endpoints of other walls win over the grid when within endpointRadius metres.
   * opts: {grid: bool, step, endpoints: [{x,y}], endpointRadius}. Returns {x, y, snapped: "endpoint"|"grid"|null}.
   */
  function snapPoint(pt, opts) {
    var best = null, bestD = opts.endpointRadius === undefined ? 0 : opts.endpointRadius;
    (opts.endpoints || []).forEach(function (e) {
      var d = Math.hypot(e.x - pt.x, e.y - pt.y);
      if (d <= bestD) { best = e; bestD = d; }
    });
    if (best) { return { x: best.x, y: best.y, snapped: "endpoint" }; }
    if (opts.grid) { return { x: round6(snapValue(pt.x, opts.step)), y: round6(snapValue(pt.y, opts.step)), snapped: "grid" }; }
    return { x: pt.x, y: pt.y, snapped: null };
  }
  function round6(v) { return Math.round(v * 1e6) / 1e6; }

  function wallEndpoints(walls, excludeIds) {
    var out = [];
    walls.forEach(function (w) {
      if (excludeIds && excludeIds.indexOf(w.id) >= 0) { return; }
      out.push({ x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 });
    });
    return out;
  }

  function angleDeg(w) { return Math.atan2(w.y2 - w.y1, w.x2 - w.x1) * 180 / Math.PI; }
  /** Snap an angle to `step` degrees unless `free` (Shift held). */
  function snapAngle(deg, step, free) { return free ? deg : snapValue(deg, step || ANGLE_STEP_DEG); }

  /** Wall rotated to `deg` (screen angle, y down) around its midpoint, same length. */
  function rotateWall(w, deg) {
    var mx = (w.x1 + w.x2) / 2, my = (w.y1 + w.y2) / 2, h = Math.hypot(w.x2 - w.x1, w.y2 - w.y1) / 2, a = deg * Math.PI / 180;
    var dx = Math.cos(a) * h, dy = Math.sin(a) * h;
    return { x1: round6(mx - dx), y1: round6(my - dy), x2: round6(mx + dx), y2: round6(my + dy) };
  }
  function rotateWallBy(w, deltaDeg) { return rotateWall(w, angleDeg(w) + deltaDeg); }

  function distToSegment(px, py, w) {
    var dx = w.x2 - w.x1, dy = w.y2 - w.y1, len2 = dx * dx + dy * dy;
    var t = len2 ? Math.max(0, Math.min(1, ((px - w.x1) * dx + (py - w.y1) * dy) / len2)) : 0;
    return Math.hypot(px - (w.x1 + t * dx), py - (w.y1 + t * dy));
  }

  /** Handle positions of a wall: end points, midpoint (move) and the rotation handle beside the midpoint. */
  function wallHandles(w, rotOffsetM) {
    var mx = (w.x1 + w.x2) / 2, my = (w.y1 + w.y2) / 2, len = Math.hypot(w.x2 - w.x1, w.y2 - w.y1) || 1;
    var nx = (w.y2 - w.y1) / len, ny = -(w.x2 - w.x1) / len;   // normal pointing to the left of the direction
    return { p1: { x: w.x1, y: w.y1 }, p2: { x: w.x2, y: w.y2 }, mid: { x: mx, y: my }, rot: { x: mx + nx * rotOffsetM, y: my + ny * rotOffsetM } };
  }

  /**
   * What is under the point. Priority: handles of selected walls, access point, label, wall (nearest).
   * `tol` is the pick radius in metres. selection: {walls:[ids], ap, label}.
   * Returns {type:"handle", id, handle:"p1"|"p2"|"mid"|"rot"} | {type:"ap"|"label"|"wall", id} | null.
   */
  function hitTest(floor, selection, pt, tol, rotOffsetM) {
    var i, h;
    var selected = (selection && selection.walls) || [];
    for (i = 0; i < floor.walls.length; i++) {
      var w = floor.walls[i];
      if (selected.indexOf(w.id) < 0) { continue; }
      h = wallHandles(w, rotOffsetM === undefined ? tol * 3 : rotOffsetM);
      var names = ["rot", "p1", "p2", "mid"];
      for (var n = 0; n < names.length; n++) {
        if (Math.hypot(h[names[n]].x - pt.x, h[names[n]].y - pt.y) <= tol) { return { type: "handle", id: w.id, handle: names[n] }; }
      }
    }
    for (i = floor.aps.length - 1; i >= 0; i--) {
      if (Math.hypot(floor.aps[i].x - pt.x, floor.aps[i].y - pt.y) <= tol * 1.4) { return { type: "ap", id: floor.aps[i].id }; }
    }
    var labels = floor.labels || [];
    for (i = labels.length - 1; i >= 0; i--) {
      if (Math.abs(labels[i].x - pt.x) <= tol * 4 && Math.abs(labels[i].y - pt.y) <= tol * 1.5) { return { type: "label", id: labels[i].id }; }
    }
    var bestId = null, bestD = tol;
    for (i = 0; i < floor.walls.length; i++) {
      var d = distToSegment(pt.x, pt.y, floor.walls[i]);
      if (d <= bestD) { bestD = d; bestId = floor.walls[i].id; }
    }
    return bestId ? { type: "wall", id: bestId } : null;
  }

  /** Ids of walls whose midpoint or an end point lies in the box {x0,y0,x1,y1}. */
  function wallsInBox(floor, box) {
    function inside(x, y) { return x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1; }
    return floor.walls.filter(function (w) {
      return inside(w.x1, w.y1) || inside(w.x2, w.y2) || inside((w.x1 + w.x2) / 2, (w.y1 + w.y2) / 2);
    }).map(function (w) { return w.id; });
  }

  function clampPoint(pt, floor) { return { x: Math.min(floor.width_m, Math.max(0, pt.x)), y: Math.min(floor.depth_m, Math.max(0, pt.y)) }; }

  /** New metres-per-pixel after the user says the distance between two clicked points is `realM`. */
  function calibratedScale(oldMPerPx, p1, p2, realM) {
    var d = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (!(d > 0) || !(realM > 0)) { throw new Error("calibration needs two different points and a distance above zero"); }
    return oldMPerPx * realM / d;
  }

  /** Size that fits within max px on the longer side, never enlarging. */
  function fitWithin(w, h, max) {
    var k = Math.min(1, max / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
  }

  var api = { GRID_STEPS_M: GRID_STEPS_M, ANGLE_STEP_DEG: ANGLE_STEP_DEG, IMAGE_MAX_PX: IMAGE_MAX_PX, snapValue: snapValue, snapPoint: snapPoint,
              wallEndpoints: wallEndpoints, angleDeg: angleDeg, snapAngle: snapAngle, rotateWall: rotateWall, rotateWallBy: rotateWallBy,
              distToSegment: distToSegment, wallHandles: wallHandles, hitTest: hitTest, wallsInBox: wallsInBox, clampPoint: clampPoint,
              calibratedScale: calibratedScale, fitWithin: fitWithin };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  root.PlannerEditor = api;
  if (!root.document) { return; }

  // ------------------------------------------------------------------ canvas editor (browser only)
  var S = root.PlannerState;
  var doc = root.document;
  // Wall colours by material id; unknown (custom) materials get a hue derived from the id.
  var MATERIAL_COLORS = { glass: "#38bdf8", drywall: "#a8b3c7", wood: "#c08a4a", brick: "#e0624a", concrete: "#8a94a6",
                          reinforced_concrete: "#5b6578", metal: "#e5e7eb", elevator: "#f472b6" };
  function materialColor(id) {
    if (MATERIAL_COLORS[id]) { return MATERIAL_COLORS[id]; }
    var h = 0;
    for (var i = 0; i < id.length; i++) { h = (h * 31 + id.charCodeAt(i)) % 360; }
    return "hsl(" + h + ",60%,60%)";
  }
  function css(name, fallback) { return getComputedStyle(doc.documentElement).getPropertyValue(name).trim() || fallback; }

  /**
   * create({base, edit, store, materials: {id: {label}}, onDraw, onFrame, announce, onArrowWithoutSelection})
   * base: canvas under the heat map (floor, image, grid). edit: canvas on top (walls, APs, handles), gets the pointer.
   */
  api.create = function (o) {
    var store = o.store, stage = o.edit.parentNode;
    var bctx = o.base.getContext("2d"), ectx = o.edit.getContext("2d");
    var view = { scale: 30, ox: 20, oy: 20, w: 1, h: 1, dpr: 1 };
    var st = { tool: "select", material: "drywall", gridOn: true, step: DEFAULT_GRID_M, layers: { walls: true, labels: true, image: true },
               drag: null, hover: null, draft: null, marquee: null, calib: [], panKey: false, pointers: {}, pinch: null, gesture: 0,
               images: {}, frame: 0, menu: null };
    var frameHooks = o.onFrame ? [o.onFrame] : [];
    var self = {};

    function floor() { return S.findFloor(store.project, store.floorId); }
    function toWorld(cx, cy) {
      var r = o.edit.getBoundingClientRect();
      return { x: (cx - r.left - view.ox) / view.scale, y: (cy - r.top - view.oy) / view.scale };
    }
    function say(msg) { if (o.announce) { o.announce(msg); } }
    function tolM() { return HIT_PX / view.scale; }
    function snap(pt, excludeIds, free) {
      var f = floor();
      return snapPoint(pt, { grid: st.gridOn && !free, step: st.step, endpointRadius: ENDPOINT_SNAP_PX / view.scale,
                             endpoints: wallEndpoints(f.walls, excludeIds) });
    }

    // ---------------------------------------------------------------- drawing
    function resize() {
      var r = stage.getBoundingClientRect(), dpr = Math.min(2, root.devicePixelRatio || 1);
      view.w = Math.max(1, Math.round(r.width)); view.h = Math.max(1, Math.round(r.height)); view.dpr = dpr;
      [o.base, o.edit].forEach(function (c) { c.width = Math.round(view.w * dpr); c.height = Math.round(view.h * dpr); });
      self.invalidate();
    }

    function backgroundImage(f) {
      if (!f.background) { return null; }
      var entry = st.images[f.background];
      if (!entry) {
        entry = st.images[f.background] = { img: new root.Image(), ready: false };
        entry.img.onload = function () { entry.ready = true; self.invalidate(); };
        entry.img.src = f.background;
      }
      return entry.ready ? entry.img : null;
    }

    function gridPx() {
      var step = st.step;
      while (step * view.scale < 8) { step *= 2; }
      return step;
    }

    function drawBase() {
      var f = floor(), c = bctx;
      c.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      c.clearRect(0, 0, view.w, view.h);
      c.save();
      c.translate(view.ox, view.oy); c.scale(view.scale, view.scale);
      c.fillStyle = css("--card-solid", "#161b28");
      c.fillRect(0, 0, f.width_m, f.depth_m);
      var img = st.layers.image ? backgroundImage(f) : null;
      if (img && f.scale_m_per_px) {
        c.globalAlpha = f.bg_opacity === undefined ? S.DEFAULT_BG_OPACITY : f.bg_opacity;
        var px = f.bg_px || { w: img.naturalWidth, h: img.naturalHeight };
        c.drawImage(img, 0, 0, px.w * f.scale_m_per_px, px.h * f.scale_m_per_px);
        c.globalAlpha = 1;
      }
      if (st.gridOn) {
        var g = gridPx(), lw = 1 / view.scale;
        c.lineWidth = lw; c.strokeStyle = css("--line", "#2a3248"); c.globalAlpha = 0.55;
        c.beginPath();
        for (var x = 0; x <= f.width_m + 1e-9; x += g) { c.moveTo(x, 0); c.lineTo(x, f.depth_m); }
        for (var y = 0; y <= f.depth_m + 1e-9; y += g) { c.moveTo(0, y); c.lineTo(f.width_m, y); }
        c.stroke(); c.globalAlpha = 1;
      }
      c.lineWidth = 2 / view.scale; c.strokeStyle = css("--muted", "#97a3b8");
      c.strokeRect(0, 0, f.width_m, f.depth_m);
      c.restore();
    }

    function drawLabel(c, text, x, y, size, color) {
      c.font = "600 " + size + "px system-ui, sans-serif"; c.textAlign = "center"; c.textBaseline = "middle";
      c.lineWidth = 3; c.strokeStyle = css("--card-solid", "#161b28"); c.strokeText(text, x, y);
      c.fillStyle = color; c.fillText(text, x, y);
    }

    function drawOpenings(c, f, wallsById) {
      f.openings.forEach(function (op) {
        var w = wallsById[op.wall];
        if (!w) { return; }
        var len = S.wallLength(w) || 1, ux = (w.x2 - w.x1) / len, uy = (w.y2 - w.y1) / len;
        c.strokeStyle = op.kind === "door" ? css("--ok", "#4ade80") : css("--accent", "#2dd4bf");
        c.lineWidth = Math.max(4, 0.16 * view.scale); c.lineCap = "butt";
        if (op.kind === "door") { c.setLineDash([6, 3]); }
        c.beginPath();
        c.moveTo(view.ox + (w.x1 + ux * op.pos) * view.scale, view.oy + (w.y1 + uy * op.pos) * view.scale);
        c.lineTo(view.ox + (w.x1 + ux * (op.pos + op.width)) * view.scale, view.oy + (w.y1 + uy * (op.pos + op.width)) * view.scale);
        c.stroke(); c.setLineDash([]);
      });
    }

    function drawEdit() {
      var f = floor(), c = ectx, sel = store.selection, i;
      c.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      c.clearRect(0, 0, view.w, view.h);
      function sx(x) { return view.ox + x * view.scale; }
      function sy(y) { return view.oy + y * view.scale; }
      if (st.layers.labels) {
        f.rooms.forEach(function (r) {
          c.strokeStyle = css("--line", "#2a3248"); c.setLineDash([4, 4]); c.lineWidth = 1;
          c.strokeRect(sx(r.x), sy(r.y), r.w * view.scale, r.d * view.scale); c.setLineDash([]);
          drawLabel(c, r.label || r.name, sx(r.x + r.w / 2), sy(r.y + r.d / 2), 12, css("--muted", "#97a3b8"));
        });
      }
      if (st.layers.walls) {
        var byId = {}, widthPx = Math.min(6, Math.max(2, 0.1 * view.scale));
        f.walls.forEach(function (w) { byId[w.id] = w; });
        var groups = {};
        f.walls.forEach(function (w) { (groups[w.material || (w.kind === "exterior" ? "brick" : "drywall")] = groups[w.material || (w.kind === "exterior" ? "brick" : "drywall")] || []).push(w); });
        c.lineCap = "round"; c.lineWidth = widthPx;
        Object.keys(groups).forEach(function (m) {
          c.strokeStyle = materialColor(m); c.beginPath();
          groups[m].forEach(function (w) { c.moveTo(sx(w.x1), sy(w.y1)); c.lineTo(sx(w.x2), sy(w.y2)); });
          c.stroke();
        });
        drawOpenings(c, f, byId);
        sel.walls.forEach(function (id) {
          var w = byId[id];
          if (!w) { return; }
          c.strokeStyle = css("--accent", "#2dd4bf"); c.lineWidth = widthPx + 4; c.globalAlpha = 0.45;
          c.beginPath(); c.moveTo(sx(w.x1), sy(w.y1)); c.lineTo(sx(w.x2), sy(w.y2)); c.stroke(); c.globalAlpha = 1;
        });
        if (sel.walls.length === 1 && byId[sel.walls[0]]) {
          var h = wallHandles(byId[sel.walls[0]], ROT_OFFSET_PX / view.scale);
          c.strokeStyle = css("--accent", "#2dd4bf"); c.lineWidth = 1;
          c.beginPath(); c.moveTo(sx(h.mid.x), sy(h.mid.y)); c.lineTo(sx(h.rot.x), sy(h.rot.y)); c.stroke();
          c.fillStyle = css("--card-solid", "#161b28"); c.lineWidth = 2;
          ["p1", "p2"].forEach(function (k) { c.fillRect(sx(h[k].x) - 5, sy(h[k].y) - 5, 10, 10); c.strokeRect(sx(h[k].x) - 5, sy(h[k].y) - 5, 10, 10); });
          ["mid", "rot"].forEach(function (k) { c.beginPath(); c.arc(sx(h[k].x), sy(h[k].y), 5.5, 0, Math.PI * 2); c.fill(); c.stroke(); });
        }
      }
      f.aps.forEach(function (ap) {
        var on = sel.ap === ap.id;
        c.beginPath(); c.arc(sx(ap.x), sy(ap.y), 9, 0, Math.PI * 2);
        c.fillStyle = css("--accent2", "#a78bfa"); c.fill();
        c.lineWidth = on ? 3 : 1.5; c.strokeStyle = on ? css("--fg", "#e8edf6") : css("--card-solid", "#161b28"); c.stroke();
        c.beginPath(); c.arc(sx(ap.x), sy(ap.y), 3, 0, Math.PI * 2); c.fillStyle = "#0b0b16"; c.fill();
        drawLabel(c, (ap.name || ap.id) + " " + ap.tx_dbm + " dBm", sx(ap.x), sy(ap.y) - 17, 11, css("--fg", "#e8edf6"));
      });
      if (st.layers.labels) {
        (f.labels || []).forEach(function (l) {
          drawLabel(c, l.text, sx(l.x), sy(l.y), 13, sel.label === l.id ? css("--accent", "#2dd4bf") : css("--fg", "#e8edf6"));
        });
      }
      if (st.draft) {
        var d = st.draft, len = Math.hypot(d.x2 - d.x1, d.y2 - d.y1);
        c.strokeStyle = materialColor(st.material); c.lineWidth = 4; c.setLineDash([8, 4]); c.beginPath();
        c.moveTo(sx(d.x1), sy(d.y1)); c.lineTo(sx(d.x2), sy(d.y2)); c.stroke(); c.setLineDash([]);
        drawLabel(c, len.toFixed(2) + " m  " + Math.round(((angleDeg(d) % 360) + 360) % 360) + " deg", sx((d.x1 + d.x2) / 2), sy((d.y1 + d.y2) / 2) - 14, 12, css("--fg", "#e8edf6"));
      }
      if (st.marquee) {
        var m = st.marquee;
        c.fillStyle = "rgba(45,212,191,.12)"; c.strokeStyle = css("--accent", "#2dd4bf"); c.lineWidth = 1;
        c.fillRect(sx(m.x0), sy(m.y0), (m.x1 - m.x0) * view.scale, (m.y1 - m.y0) * view.scale);
        c.strokeRect(sx(m.x0), sy(m.y0), (m.x1 - m.x0) * view.scale, (m.y1 - m.y0) * view.scale);
      }
      st.calib.forEach(function (p, n) {
        c.fillStyle = css("--warn", "#fbbf24"); c.beginPath(); c.arc(sx(p.x), sy(p.y), 6, 0, Math.PI * 2); c.fill();
        if (n === 1) { c.strokeStyle = css("--warn", "#fbbf24"); c.lineWidth = 2; c.beginPath(); c.moveTo(sx(st.calib[0].x), sy(st.calib[0].y)); c.lineTo(sx(p.x), sy(p.y)); c.stroke(); }
      });
      // scale bar
      var bar = 1;
      while (bar * view.scale < 60) { bar *= bar < 5 ? 5 : 2; }
      c.strokeStyle = css("--fg", "#e8edf6"); c.lineWidth = 2; c.beginPath();
      c.moveTo(12, view.h - 14); c.lineTo(12 + bar * view.scale, view.h - 14); c.stroke();
      drawLabel(c, bar + " m", 12 + bar * view.scale / 2, view.h - 24, 11, css("--fg", "#e8edf6"));
      if (o.onDraw) { o.onDraw(c, view, f); }
      i = 0;
    }

    function frame() {
      st.frame = 0;
      drawBase(); drawEdit();
      frameHooks.forEach(function (fn) { fn(view); });
    }
    self.invalidate = function () { if (!st.frame) { st.frame = root.requestAnimationFrame(frame); } };
    self.drawNow = function () { if (st.frame) { root.cancelAnimationFrame(st.frame); st.frame = 0; } frame(); };
    self.addFrameHook = function (fn) { frameHooks.push(fn); };

    // ---------------------------------------------------------------- view
    self.view = view;
    self.floor = floor;
    self.toWorld = toWorld;
    self.fit = function () {
      var f = floor(), pad = 28;
      view.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.min((view.w - 2 * pad) / f.width_m, (view.h - 2 * pad) / f.depth_m)));
      view.ox = (view.w - f.width_m * view.scale) / 2; view.oy = (view.h - f.depth_m * view.scale) / 2;
      self.invalidate();
    };
    self.zoomAt = function (factor, cx, cy) {
      var next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, view.scale * factor)), k = next / view.scale;
      view.ox = cx - (cx - view.ox) * k; view.oy = cy - (cy - view.oy) * k; view.scale = next;
      self.invalidate();
    };
    self.panBy = function (dx, dy) { view.ox += dx; view.oy += dy; self.invalidate(); };
    /** Centre the viewport on a world point (mini-map navigation). */
    self.centerOn = function (x, y) { view.ox = view.w / 2 - x * view.scale; view.oy = view.h / 2 - y * view.scale; self.invalidate(); };

    // ---------------------------------------------------------------- settings
    self.setTool = function (t) {
      st.tool = t; st.draft = null; st.marquee = null; if (t !== "calibrate") { st.calib = []; }
      o.edit.style.cursor = t === "pan" ? "grab" : t === "select" ? "default" : "crosshair";
      if (o.onTool) { o.onTool(t); }
      say({ select: "Select tool", wall: "Draw wall tool: drag on the plan", ap: "Place access point tool: click on the plan",
            label: "Room label tool: click on the plan", pan: "Pan tool", calibrate: "Calibrate: click two points on the floor-plan image",
            "note-text": "Text note tool: click on the plan", "note-arrow": "Arrow note tool: drag on the plan", "note-pin": "Pin note tool: click on the plan",
            "device": "IoT device tool: click on the plan" }[t]);
      self.invalidate();
    };
    self.getTool = function () { return st.tool; };
    self.setMaterial = function (id) { st.material = id; if (o.onMaterial) { o.onMaterial(id); } };
    self.getMaterial = function () { return st.material; };
    self.setStep = function (m) { st.step = m; self.invalidate(); };
    self.getStep = function () { return st.step; };
    self.toggleGrid = function () { st.gridOn = !st.gridOn; if (o.onGrid) { o.onGrid(st.gridOn); } say("Grid snapping " + (st.gridOn ? "on" : "off")); self.invalidate(); };
    self.isGridOn = function () { return st.gridOn; };
    self.setLayer = function (k, on) { st.layers[k] = on; self.invalidate(); };

    // ---------------------------------------------------------------- commands
    function addWall(x1, y1, x2, y2, material) {
      var f = floor(), id = S.nextId(f.walls, "w");
      var wall = { id: id, x1: x1, y1: y1, x2: x2, y2: y2, kind: "interior", material: material || st.material };
      store.exec({ label: "Add wall", ops: [S.addOp("wall", store.project, f.id, wall)] });
      store.select({ walls: [id] });
      return id;
    }
    self.deleteSelection = function () {
      var f = floor(), sel = store.selection, ops = [];
      sel.walls.forEach(function (id) { ops.push(S.removeOp("wall", store.project, f.id, id)); });
      if (sel.ap) { ops.push(S.removeOp("ap", store.project, f.id, sel.ap)); }
      if (sel.label) { ops.push(S.removeOp("label", store.project, f.id, sel.label)); }
      if (store.exec({ label: "Delete", ops: ops })) { say("Deleted"); }
    };
    self.duplicateSelection = function () {
      var f = floor(), sel = store.selection, ops = [], off = Math.max(st.step, 0.5), made = { walls: [] };
      var walls = f.walls.slice(), aps = f.aps.slice(), labels = f.labels.slice();
      function shifted(x, y) { return clampPoint({ x: x + off, y: y + off }, f); }
      sel.walls.forEach(function (id) {
        var w = f.walls.filter(function (x) { return x.id === id; })[0], a = shifted(w.x1, w.y1), b = shifted(w.x2, w.y2);
        var copy = Object.assign({}, S.clone(w), { id: S.nextId(walls, "w"), x1: a.x, y1: a.y, x2: b.x, y2: b.y });
        walls.push(copy); made.walls.push(copy.id); ops.push(S.addOp("wall", store.project, f.id, copy));
      });
      if (sel.ap) {
        var ap = f.aps.filter(function (x) { return x.id === sel.ap; })[0], p = shifted(ap.x, ap.y);
        var acopy = Object.assign({}, S.clone(ap), { id: S.nextId(aps, "ap"), x: p.x, y: p.y });
        made.ap = acopy.id; ops.push(S.addOp("ap", store.project, f.id, acopy));
      }
      if (sel.label) {
        var l = f.labels.filter(function (x) { return x.id === sel.label; })[0], q = shifted(l.x, l.y);
        var lcopy = Object.assign({}, l, { id: S.nextId(labels, "l"), x: q.x, y: q.y });
        made.label = lcopy.id; ops.push(S.addOp("label", store.project, f.id, lcopy));
      }
      if (store.exec({ label: "Duplicate", ops: ops })) { store.select(made); say("Duplicated"); }
    };
    self.rotateSelection = function (deg) {
      var f = floor(), ops = [];
      store.selection.walls.forEach(function (id) {
        var w = f.walls.filter(function (x) { return x.id === id; })[0], r = rotateWallBy(w, deg);
        if (r.x1 < 0 || r.y1 < 0 || r.x2 < 0 || r.y2 < 0 || Math.max(r.x1, r.x2) > f.width_m || Math.max(r.y1, r.y2) > f.depth_m) { return; }
        ops.push(S.setOp("wall", store.project, f.id, id, r));
      });
      if (store.exec({ label: "Rotate", ops: ops })) { say("Rotated " + deg + " degrees"); } else { say("Rotation would leave the floor"); }
    };
    self.setSelectionMaterial = function (material) {
      var f = floor(), ops = store.selection.walls.map(function (id) { return S.setOp("wall", store.project, f.id, id, { material: material }); });
      store.exec({ label: "Change material", ops: ops });
    };
    self.nudge = function (dx, dy) {
      var f = floor(), sel = store.selection, ops = [], key = "nudge:" + sel.walls.join(",") + sel.ap + sel.label;
      var step = st.gridOn ? st.step : 0.1;
      sel.walls.forEach(function (id) {
        var w = f.walls.filter(function (x) { return x.id === id; })[0];
        var a = clampPoint({ x: w.x1 + dx * step, y: w.y1 + dy * step }, f), b = clampPoint({ x: w.x2 + dx * step, y: w.y2 + dy * step }, f);
        ops.push(S.setOp("wall", store.project, f.id, id, { x1: a.x, y1: a.y, x2: b.x, y2: b.y }));
      });
      if (sel.ap) {
        var ap = f.aps.filter(function (x) { return x.id === sel.ap; })[0], p = clampPoint({ x: ap.x + dx * step, y: ap.y + dy * step }, f);
        ops.push(S.setOp("ap", store.project, f.id, ap.id, p));
      }
      if (sel.label) {
        var l = f.labels.filter(function (x) { return x.id === sel.label; })[0], q = clampPoint({ x: l.x + dx * step, y: l.y + dy * step }, f);
        ops.push(S.setOp("label", store.project, f.id, l.id, q));
      }
      return store.exec({ label: "Nudge", key: key, ops: ops });
    };
    self.addApAt = function (pt) {
      var f = floor(), id = S.nextId(f.aps, "ap"), p = clampPoint(pt, f);
      store.exec({ label: "Add access point", ops: [S.addOp("ap", store.project, f.id, { id: id, x: p.x, y: p.y, tx_dbm: DEFAULT_TX_DBM })] });
      store.select({ ap: id });
    };

    // ---------------------------------------------------------------- floating text input (labels, calibration)
    function askText(title, initial, wx, wy, done) {
      var input = doc.createElement("input");
      input.type = "text"; input.maxLength = textMax(); input.value = initial || ""; input.className = "planner-input"; input.setAttribute("aria-label", title); input.placeholder = title;
      input.style.left = Math.max(4, Math.min(view.w - 190, view.ox + wx * view.scale - 90)) + "px"; input.style.top = Math.max(4, view.oy + wy * view.scale - 14) + "px";
      stage.appendChild(input); input.focus(); input.select();
      var closed = false;
      function close(accept) {
        if (closed) { return; }
        closed = true; var v = input.value.trim(); input.remove(); o.edit.focus();
        if (accept && v) { done(v); }
      }
      input.addEventListener("keydown", function (e) { e.stopPropagation(); if (e.key === "Enter") { close(true); } else if (e.key === "Escape") { close(false); } });
      input.addEventListener("blur", function () { close(false); });
    }
    function textMax() { return o.textLimit(); }
    /** Fit label text to the shared limit (the same one validateProject enforces) and say so when it was shortened. */
    function clipLabel(txt) {
      var r = S.clipText(txt, textMax());
      if (r.clipped) { say("Label shortened to " + textMax() + " characters"); }
      return r.text;
    }
    self.addLabelAt = function (pt) {
      var f = floor(), p = clampPoint(pt, f);
      askText("Room label", "", p.x, p.y, function (txt) {
        var id = S.nextId(f.labels, "l");
        store.exec({ label: "Add label", ops: [S.addOp("label", store.project, f.id, { id: id, text: clipLabel(txt), x: p.x, y: p.y })] });
        store.select({ label: id });
      });
    };
    self.editLabel = function (id) {
      var f = floor(), l = f.labels.filter(function (x) { return x.id === id; })[0];
      if (!l) { return; }
      askText("Room label", l.text, l.x, l.y, function (txt) { store.exec({ label: "Edit label", ops: [S.setOp("label", store.project, f.id, id, { text: clipLabel(txt) })] }); });
    };

    // ---------------------------------------------------------------- floor-plan image and calibration
    /** Read an image file, downscale to at most 2048 px, store as a data URL on the floor. Resolves with a message. */
    self.importImage = function (file) {
      return new Promise(function (resolve, reject) {
        if (!file || !/^image\/(png|jpeg|webp)$/.test(file.type)) { reject(new Error("Choose a PNG, JPEG or WebP image.")); return; }
        var reader = new root.FileReader();
        reader.onerror = function () { reject(new Error("Could not read the file.")); };
        reader.onload = function () {
          var img = new root.Image();
          img.onerror = function () { reject(new Error("The file is not a readable image.")); };
          img.onload = function () {
            var size = fitWithin(img.naturalWidth, img.naturalHeight, IMAGE_MAX_PX), cv = doc.createElement("canvas");
            cv.width = size.w; cv.height = size.h;
            cv.getContext("2d").drawImage(img, 0, 0, size.w, size.h);
            var f = floor(), url = file.type === "image/png" ? cv.toDataURL("image/png") : cv.toDataURL("image/jpeg", JPEG_QUALITY);
            store.exec({ label: "Import floor plan image", ops: [S.setOp("floor", store.project, f.id, null, {
              background: url, bg_px: { w: size.w, h: size.h }, bg_opacity: S.DEFAULT_BG_OPACITY, scale_m_per_px: f.width_m / size.w })] });
            resolve("Image placed at " + size.w + " x " + size.h + " px, scaled to the floor width. Use Calibrate to set the real scale.");
          };
          img.src = reader.result;
        };
        reader.readAsDataURL(file);
      });
    };
    self.removeImage = function () {
      var f = floor();
      store.exec({ label: "Remove image", ops: [S.setOp("floor", store.project, f.id, null, { background: undefined, bg_px: undefined, bg_opacity: undefined, scale_m_per_px: undefined })] });
    };
    self.setBgOpacity = function (v) {
      store.exec({ label: "Image opacity", key: "bg-opacity:" + store.floorId, ops: [S.setOp("floor", store.project, store.floorId, null, { bg_opacity: v })] });
    };
    function finishCalibration() {
      var f = floor(), p1 = st.calib[0], p2 = st.calib[1];
      askText("Real distance in metres", "", (p1.x + p2.x) / 2, (p1.y + p2.y) / 2, function (v) {
        var m = parseFloat(v.replace(",", "."));
        try {
          var ratio = calibratedScale(1, p1, p2, m);
          var oldScale = f.scale_m_per_px || (f.bg_px ? f.width_m / f.bg_px.w : 1);
          store.exec({ label: "Calibrate scale", ops: [S.setOp("floor", store.project, f.id, null, { scale_m_per_px: oldScale * ratio })] });
          say("Scale set: " + (oldScale * ratio).toFixed(5) + " metres per image pixel");
        } catch (e) { say(e.message); }
        st.calib = []; self.setTool("select");
      });
    }

    // ---------------------------------------------------------------- context menu
    function closeMenu() { if (st.menu) { st.menu.remove(); st.menu = null; } }
    function openMenu(cx, cy, items) {
      closeMenu();
      var menu = doc.createElement("div");
      menu.className = "ctxmenu"; menu.setAttribute("role", "menu"); menu.setAttribute("aria-label", "Plan actions");
      items.forEach(function (it) {
        if (it.heading) { var h = doc.createElement("div"); h.className = "ctx-head"; h.setAttribute("role", "presentation"); h.textContent = it.heading; menu.appendChild(h); return; }
        var b = doc.createElement("button");
        b.type = "button"; b.setAttribute("role", "menuitem"); b.textContent = it.label; if (it.hint) { b.title = it.hint; }
        b.addEventListener("click", function () { closeMenu(); o.edit.focus(); it.run(); });
        menu.appendChild(b);
      });
      menu.addEventListener("keydown", function (e) {
        var btns = Array.prototype.slice.call(menu.querySelectorAll("button")), i = btns.indexOf(doc.activeElement);
        if (e.key === "ArrowDown") { btns[(i + 1) % btns.length].focus(); e.preventDefault(); }
        else if (e.key === "ArrowUp") { btns[(i - 1 + btns.length) % btns.length].focus(); e.preventDefault(); }
        else if (e.key === "Escape") { closeMenu(); o.edit.focus(); e.stopPropagation(); }
        else if (e.key === "Tab") { closeMenu(); }
      });
      doc.body.appendChild(menu);
      var r = menu.getBoundingClientRect();
      menu.style.left = Math.max(4, Math.min(cx, root.innerWidth - r.width - 4)) + "px";
      menu.style.top = Math.max(4, Math.min(cy, root.innerHeight - r.height - 4)) + "px";
      st.menu = menu;
      menu.querySelector("button").focus();
    }
    function contextItems(hit, pt) {
      var items = [], f = floor(), sel = store.selection;
      var at = clampPoint(snap(pt).snapped ? snap(pt) : pt, f);
      if (hit && hit.type === "wall") {
        if (sel.walls.indexOf(hit.id) < 0) { store.select({ walls: [hit.id] }); }
        items.push({ heading: "Material" });
        Object.keys(o.materials).forEach(function (id) { items.push({ label: o.materials[id].label || id, run: function () { self.setSelectionMaterial(id); } }); });
        items.push({ heading: "Wall" },
          { label: "Duplicate (Ctrl+D)", run: self.duplicateSelection }, { label: "Rotate 90 degrees (R)", run: function () { self.rotateSelection(90); } },
          { label: "Delete (Del)", run: self.deleteSelection });
      } else if (hit && hit.type === "ap") {
        store.select({ ap: hit.id });
        items.push({ heading: "Access point" }, { label: "Duplicate (Ctrl+D)", run: self.duplicateSelection }, { label: "Delete (Del)", run: self.deleteSelection });
      } else if (hit && hit.type === "label") {
        store.select({ label: hit.id });
        items.push({ heading: "Label" }, { label: "Edit text", run: function () { self.editLabel(hit.id); } }, { label: "Delete (Del)", run: self.deleteSelection });
      } else {
        items.push({ heading: "Here" }, { label: "Add access point here", run: function () { self.addApAt(at); } },
          { label: "Set label here", run: function () { self.addLabelAt(at); } }, { label: "Fit view (0)", run: self.fit });
      }
      return items;
    }

    // ---------------------------------------------------------------- pointer input
    function pointerCount() { return Object.keys(st.pointers).length; }
    function startPinch() {
      var ids = Object.keys(st.pointers), a = st.pointers[ids[0]], b = st.pointers[ids[1]];
      st.pinch = { d: Math.hypot(b.x - a.x, b.y - a.y) || 1, scale: view.scale, ox: view.ox, oy: view.oy, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      st.drag = null; st.draft = null; st.marquee = null;
    }
    function localXY(e) { var r = o.edit.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

    function onDown(e) {
      closeMenu();
      o.edit.focus();
      try { o.edit.setPointerCapture(e.pointerId); } catch (err) { /* capture not available */ }
      st.pointers[e.pointerId] = localXY(e);
      if (pointerCount() === 2) { startPinch(); return; }
      if (e.button === 2) { return; }
      var raw = toWorld(e.clientX, e.clientY), f = floor(), tool = st.tool;
      st.gesture += 1;
      if (e.button === 1 || tool === "pan" || st.panKey) { st.drag = { type: "pan", x: e.clientX, y: e.clientY }; o.edit.style.cursor = "grabbing"; return; }
      if (o.onToolPointer && o.onToolPointer(tool, "down", raw, e)) { st.drag = { type: "ext", tool: tool }; self.invalidate(); return; }
      if (tool === "wall") {
        var p = snap(raw, null, e.altKey);
        st.drag = { type: "wall" }; st.draft = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
      } else if (tool === "ap") {
        self.addApAt(snap(raw, null, e.altKey));
      } else if (tool === "label") {
        self.addLabelAt(raw);
      } else if (tool === "calibrate") {
        if (st.calib.length >= 2) { st.calib = []; }
        st.calib.push(raw); self.invalidate();
        if (st.calib.length === 2) { finishCalibration(); }
      } else {
        var hit = hitTest(f, store.selection, raw, tolM(), ROT_OFFSET_PX / view.scale);
        if (hit && hit.type === "handle") {
          st.drag = { type: hit.handle, id: hit.id, start: S.clone(f.walls.filter(function (w) { return w.id === hit.id; })[0]), raw: raw };
          if (hit.handle === "mid") { st.drag.type = "move"; st.drag.ids = [hit.id]; st.drag.starts = [st.drag.start]; }
        } else if (hit && hit.type === "wall") {
          var sel = store.selection.walls.slice();
          if (e.shiftKey) { var i = sel.indexOf(hit.id); if (i >= 0) { sel.splice(i, 1); } else { sel.push(hit.id); } }
          else if (sel.indexOf(hit.id) < 0) { sel = [hit.id]; }
          store.select({ walls: sel });
          st.drag = { type: "move", raw: raw, ids: sel, starts: sel.map(function (id) { return S.clone(f.walls.filter(function (w) { return w.id === id; })[0]); }) };
        } else if (hit && hit.type === "ap") {
          store.select({ ap: hit.id });
          st.drag = { type: "ap", id: hit.id };
        } else if (hit && hit.type === "label") {
          store.select({ label: hit.id });
          st.drag = { type: "label", id: hit.id };
        } else {
          if (!e.shiftKey) { store.select({}); }
          st.drag = { type: "marquee", x0: raw.x, y0: raw.y, add: e.shiftKey, base: store.selection.walls.slice() };
        }
      }
      self.invalidate();
    }

    function onMove(e) {
      if (st.pointers[e.pointerId]) { st.pointers[e.pointerId] = localXY(e); }
      if (st.pinch && pointerCount() >= 2) {
        var ids = Object.keys(st.pointers), a = st.pointers[ids[0]], b = st.pointers[ids[1]], p = st.pinch;
        var next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, p.scale * (Math.hypot(b.x - a.x, b.y - a.y) / p.d))), k = next / p.scale;
        var cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        view.scale = next; view.ox = cx - (p.cx - p.ox) * k; view.oy = cy - (p.cy - p.oy) * k;
        self.invalidate(); return;
      }
      var raw = toWorld(e.clientX, e.clientY), f = floor(), d = st.drag;
      if (o.onPointer) { o.onPointer(raw, e); }
      if (!d) {
        var hit = st.tool === "select" ? hitTest(f, store.selection, raw, tolM(), ROT_OFFSET_PX / view.scale) : null;
        var key = hit ? hit.type + hit.id + (hit.handle || "") : "";
        if (key !== st.hover) {
          st.hover = key;
          o.edit.style.cursor = st.tool !== "select" ? (st.tool === "pan" ? "grab" : "crosshair") : !hit ? "default" : hit.type === "handle" ? (hit.handle === "rot" ? "alias" : "pointer") : "move";
        }
        return;
      }
      if (d.type === "pan") { self.panBy(e.clientX - d.x, e.clientY - d.y); d.x = e.clientX; d.y = e.clientY; return; }
      if (d.type === "ext") { o.onToolPointer(d.tool, "move", raw, e); self.invalidate(); return; }
      if (d.type === "wall") {
        var q = snap(raw, null, e.altKey);
        if (e.shiftKey && !e.altKey) { var ang = snapAngle(angleDeg({ x1: st.draft.x1, y1: st.draft.y1, x2: q.x, y2: q.y }), ANGLE_STEP_DEG, false) * Math.PI / 180, len = Math.hypot(q.x - st.draft.x1, q.y - st.draft.y1); q = { x: st.draft.x1 + Math.cos(ang) * len, y: st.draft.y1 + Math.sin(ang) * len }; }
        var c = clampPoint(q, f); st.draft.x2 = c.x; st.draft.y2 = c.y; self.invalidate(); return;
      }
      if (d.type === "marquee") {
        st.marquee = { x0: Math.min(d.x0, raw.x), y0: Math.min(d.y0, raw.y), x1: Math.max(d.x0, raw.x), y1: Math.max(d.y0, raw.y) };
        var inBox = wallsInBox(f, st.marquee);
        store.select({ walls: d.add ? d.base.concat(inBox.filter(function (id) { return d.base.indexOf(id) < 0; })) : inBox });
        self.invalidate(); return;
      }
      var key2 = "drag:" + st.gesture;
      if (d.type === "p1" || d.type === "p2") {
        var other = d.type === "p1" ? { x: d.start.x2, y: d.start.y2 } : { x: d.start.x1, y: d.start.y1 };
        var s = clampPoint(snap(raw, [d.id], e.altKey), f);
        if (Math.hypot(s.x - other.x, s.y - other.y) < MIN_WALL_M) { return; }
        store.exec({ label: "Move wall end", key: key2, ops: [S.setOp("wall", store.project, f.id, d.id, d.type === "p1" ? { x1: s.x, y1: s.y } : { x2: s.x, y2: s.y })] });
      } else if (d.type === "rot") {
        var mx = (d.start.x1 + d.start.x2) / 2, my = (d.start.y1 + d.start.y2) / 2;
        var a2 = Math.atan2(raw.y - my, raw.x - mx) * 180 / Math.PI;
        // The handle sits at (wall angle - 90 deg), so the wall follows the pointer angle + 90 deg.
        var r = rotateWall(d.start, snapAngle(a2 + 90, ANGLE_STEP_DEG, e.shiftKey));
        if (Math.min(r.x1, r.x2, r.y1, r.y2) < 0 || Math.max(r.x1, r.x2) > f.width_m || Math.max(r.y1, r.y2) > f.depth_m) { return; }
        store.exec({ label: "Rotate wall", key: key2, ops: [S.setOp("wall", store.project, f.id, d.id, r)] });
      } else if (d.type === "move") {
        var first = d.starts[0], anchor = snap({ x: first.x1 + raw.x - d.raw.x, y: first.y1 + raw.y - d.raw.y }, d.ids, e.altKey);
        var dx = anchor.x - first.x1, dy = anchor.y - first.y1, ok = true;
        d.starts.forEach(function (w) {
          if (Math.min(w.x1, w.x2) + dx < 0 || Math.max(w.x1, w.x2) + dx > f.width_m || Math.min(w.y1, w.y2) + dy < 0 || Math.max(w.y1, w.y2) + dy > f.depth_m) { ok = false; }
        });
        if (!ok) { return; }
        store.exec({ label: "Move wall", key: key2, ops: d.starts.map(function (w) {
          return S.setOp("wall", store.project, f.id, w.id, { x1: round6(w.x1 + dx), y1: round6(w.y1 + dy), x2: round6(w.x2 + dx), y2: round6(w.y2 + dy) });
        }) });
      } else if (d.type === "ap") {
        var pa = clampPoint(snap(raw, null, e.altKey), f);
        store.exec({ label: "Move access point", key: key2, ops: [S.setOp("ap", store.project, f.id, d.id, { x: pa.x, y: pa.y })] });
      } else if (d.type === "label") {
        var pl = clampPoint(snap(raw, null, e.altKey), f);
        store.exec({ label: "Move label", key: key2, ops: [S.setOp("label", store.project, f.id, d.id, { x: pl.x, y: pl.y })] });
      }
    }

    function onUp(e) {
      delete st.pointers[e.pointerId];
      try { o.edit.releasePointerCapture(e.pointerId); } catch (err) { /* not captured */ }
      if (st.pinch) { if (pointerCount() < 2) { st.pinch = null; } return; }
      var d = st.drag;
      st.drag = null;
      if (d && d.type === "ext") { o.onToolPointer(d.tool, "up", toWorld(e.clientX, e.clientY), e); }
      if (d && d.type === "wall" && st.draft) {
        var dr = st.draft;
        st.draft = null;
        if (Math.hypot(dr.x2 - dr.x1, dr.y2 - dr.y1) >= MIN_WALL_M) { addWall(dr.x1, dr.y1, dr.x2, dr.y2); } else { say("Wall too short, drag further"); }
      }
      st.marquee = null;
      if (d && d.type === "pan") { o.edit.style.cursor = st.tool === "pan" ? "grab" : "default"; }
      self.invalidate();
    }

    function onWheel(e) {
      e.preventDefault();
      var r = o.edit.getBoundingClientRect();
      self.zoomAt(Math.pow(1.0015, -e.deltaY * (e.deltaMode === 1 ? 16 : 1)), e.clientX - r.left, e.clientY - r.top);
    }

    function onContext(e) {
      e.preventDefault();
      var pt = toWorld(e.clientX, e.clientY);
      openMenu(e.clientX, e.clientY, contextItems(hitTest(floor(), store.selection, pt, tolM(), ROT_OFFSET_PX / view.scale), pt));
    }

    function onDblClick(e) {
      var pt = toWorld(e.clientX, e.clientY), hit = hitTest(floor(), store.selection, pt, tolM());
      if (hit && hit.type === "label") { self.editLabel(hit.id); }
    }

    // palette drag and drop: a wall of DROP_WALL_M lands centred on the drop point
    function onDragOver(e) { if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "text/plain") >= 0) { e.preventDefault(); } }
    function onDrop(e) {
      var data = e.dataTransfer && e.dataTransfer.getData("text/plain");
      if (!data || data.indexOf("wall:") !== 0) { return; }
      e.preventDefault();
      var material = data.slice(5), f = floor();
      if (!o.materials[material]) { return; }
      var pt = toWorld(e.clientX, e.clientY), a = snap({ x: pt.x - DROP_WALL_M / 2, y: pt.y }), b = { x: a.x + DROP_WALL_M, y: a.y };
      if (b.x > f.width_m) { a.x -= b.x - f.width_m; b.x = f.width_m; }
      a = clampPoint(a, f); b = clampPoint(b, f);
      addWall(a.x, a.y, b.x, b.y, material);
      self.setMaterial(material);
    }

    // ---------------------------------------------------------------- keyboard
    function typing(t) { return t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable); }
    function onKey(e) {
      if (typing(e.target) || (st.menu && st.menu.contains(e.target))) { return; }
      var k = e.key, ctrl = e.ctrlKey || e.metaKey, handled = true;
      if (ctrl && (k === "z" || k === "Z")) { if (e.shiftKey) { store.redo(); } else { store.undo(); } }
      else if (ctrl && (k === "y" || k === "Y")) { store.redo(); }
      else if (ctrl && (k === "d" || k === "D")) { self.duplicateSelection(); }
      else if (ctrl && (k === "a" || k === "A")) { store.select({ walls: floor().walls.map(function (w) { return w.id; }) }); }
      else if (ctrl || e.altKey) { handled = false; }
      else if (k === "v" || k === "V") { self.setTool("select"); }
      else if (k === "w" || k === "W") { self.setTool("wall"); }
      else if (k === "a" || k === "A") { self.setTool("ap"); }
      else if (k === "l" || k === "L") { self.setTool("label"); }
      else if (k === "c" || k === "C") { self.setTool("calibrate"); }
      else if (k === "h" || k === "H") { self.setTool("pan"); }
      else if (k === "g" || k === "G") { self.toggleGrid(); }
      else if (k === "r" || k === "R") { self.rotateSelection(90); }
      else if (k === " ") { st.panKey = true; o.edit.style.cursor = "grab"; }
      else if (k === "Delete" || k === "Backspace") { self.deleteSelection(); }
      else if (k === "+" || k === "=") { self.zoomAt(1.25, view.w / 2, view.h / 2); }
      else if (k === "-" || k === "_") { self.zoomAt(0.8, view.w / 2, view.h / 2); }
      else if (k === "0") { self.fit(); }
      else if (k === "?") { if (o.onHelp) { o.onHelp(); } }
      else if (k === "Escape") { st.draft = null; st.drag = null; st.calib = []; st.marquee = null; store.select({}); self.setTool("select"); }
      else if (k.indexOf("Arrow") === 0) {
        var dx = k === "ArrowLeft" ? -1 : k === "ArrowRight" ? 1 : 0, dy = k === "ArrowUp" ? -1 : k === "ArrowDown" ? 1 : 0;
        var sel = store.selection;
        if (sel.walls.length || sel.ap || sel.label) { self.nudge(dx, dy); }
        else if (o.onArrowWithoutSelection) { o.onArrowWithoutSelection(dx, dy, e.shiftKey); } else { handled = false; }
      } else { handled = false; }
      if (handled) { e.preventDefault(); self.invalidate(); }
    }
    function onKeyUp(e) { if (e.key === " " && st.panKey) { st.panKey = false; o.edit.style.cursor = st.tool === "select" ? "default" : "crosshair"; } }

    // ---------------------------------------------------------------- palette
    /** Fill `container` with one draggable button per material. Click selects the drawing material. */
    self.buildPalette = function (container) {
      container.textContent = "";
      Object.keys(o.materials).forEach(function (id) {
        var b = doc.createElement("button"), sw = doc.createElement("i"), label = o.materials[id].label || id;
        b.type = "button"; b.draggable = true; b.dataset.material = id; b.className = "mat";
        b.setAttribute("aria-pressed", String(id === st.material)); b.title = label + ": click to draw with it, or drag onto the plan";
        sw.style.background = materialColor(id); sw.setAttribute("aria-hidden", "true");
        b.appendChild(sw); b.appendChild(doc.createTextNode(label));
        b.addEventListener("click", function () { self.setMaterial(id); self.setTool("wall"); });
        b.addEventListener("dragstart", function (e) { e.dataTransfer.setData("text/plain", "wall:" + id); e.dataTransfer.effectAllowed = "copy"; });
        container.appendChild(b);
      });
      o.onMaterial = (function (prev) { return function (id) {
        Array.prototype.forEach.call(container.children, function (c) { c.setAttribute("aria-pressed", String(c.dataset.material === id)); });
        if (prev) { prev(id); }
      }; })(o.onMaterial);
    };

    // ---------------------------------------------------------------- wiring
    o.edit.addEventListener("mousedown", function (e) { e.preventDefault(); });   // keep a text box opened by pointerdown focused
    o.edit.addEventListener("pointerdown", onDown);
    o.edit.addEventListener("pointermove", onMove);
    o.edit.addEventListener("pointerup", onUp);
    o.edit.addEventListener("pointercancel", onUp);
    o.edit.addEventListener("wheel", onWheel, { passive: false });
    o.edit.addEventListener("contextmenu", onContext);
    o.edit.addEventListener("dblclick", onDblClick);
    o.edit.addEventListener("dragover", onDragOver);
    o.edit.addEventListener("drop", onDrop);
    doc.addEventListener("keydown", onKey);
    doc.addEventListener("keyup", onKeyUp);
    doc.addEventListener("pointerdown", function (e) { if (st.menu && !st.menu.contains(e.target)) { closeMenu(); } });
    store.subscribe(function () { self.invalidate(); });
    if (root.ResizeObserver) { new root.ResizeObserver(resize).observe(stage); } else { root.addEventListener("resize", resize); }
    o.edit.style.touchAction = "none";
    resize(); self.fit(); self.setTool("select");
    return self;
  };
})(typeof self !== "undefined" ? self : this);
