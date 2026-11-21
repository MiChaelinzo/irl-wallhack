"use strict";
// Planner project model: validation of imported JSON, command based undo/redo history, selection,
// dirty tracking and localStorage persistence. Pure logic, no DOM, so it runs under node in
// tests/test_planner_state.py. The project format is the digital twin format (wallhack/twin.py)
// plus a schema_version and a few planner fields (floor labels, background image placement).
(function (root) {
  var SCHEMA_VERSION = 1;
  var HISTORY_CAP = 200;
  var MAX_FLOORS = 6, MAX_WALLS = 5000, MAX_APS = 64, MAX_LABELS = 500, MAX_FLOOR_M = 200, MIN_FLOOR_M = 1;
  var TX_DBM_MIN = 0, TX_DBM_MAX = 30, SCALE_RANGE = [0.0001, 100];
  var BACKGROUND_PATTERN = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
  var STORAGE_KEY = "wallhack.planner.project";
  var WALL_KINDS = ["interior", "exterior"];
  var DEFAULT_BG_OPACITY = 0.5;

  function ProjectError(message) {
    var e = new Error(message);
    e.name = "ProjectError";
    return e;
  }

  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

  function num(v, path, lo, hi) {
    if (!isNum(v)) { throw ProjectError(path + ": must be a finite number"); }
    if ((lo !== undefined && v < lo) || (hi !== undefined && v > hi)) {
      throw ProjectError(path + ": must be between " + lo + " and " + hi + ", got " + v);
    }
    return v;
  }

  function text(obj, key, path) {
    var v = obj[key];
    if (typeof v !== "string" || !v.length || v.length > 80) { throw ProjectError(path + "." + key + ": must be a text of 1 to 80 characters"); }
    return v;
  }

  function list(obj, key, path, max) {
    var v = obj[key] === undefined ? [] : obj[key];
    if (!Array.isArray(v)) { throw ProjectError(path + "." + key + ": must be a list"); }
    if (v.length > max) { throw ProjectError(path + "." + key + ": at most " + max + " items, got " + v.length); }
    return v;
  }

  function unique(ids, path) {
    var seen = {};
    ids.forEach(function (id) {
      if (seen[id]) { throw ProjectError(path + ": duplicate id '" + id + "'"); }
      seen[id] = true;
    });
  }

  /**
   * Validate and normalise imported project JSON (a twin or a saved planner project). Returns a deep
   * copy with every list present, or throws ProjectError with a message that names the bad field.
   * opts: {materialIds: string[], bands: string[], modes: string[]} from rf-config.json (optional).
   */
  function validateProject(data, opts) {
    opts = opts || {};
    if (!data || typeof data !== "object" || Array.isArray(data)) { throw ProjectError("project: must be a JSON object"); }
    var version = data.schema_version === undefined ? SCHEMA_VERSION : data.schema_version;
    if (!isNum(version) || version < 1 || version > SCHEMA_VERSION || Math.floor(version) !== version) {
      throw ProjectError("schema_version: " + JSON.stringify(data.schema_version) + " is not supported (this planner reads version 1 to " + SCHEMA_VERSION + ")");
    }
    if (!Array.isArray(data.floors) || data.floors.length < 1 || data.floors.length > MAX_FLOORS) {
      throw ProjectError("floors: must be a list of 1 to " + MAX_FLOORS + " floors");
    }
    var out = { schema_version: SCHEMA_VERSION, name: typeof data.name === "string" && data.name ? data.name.slice(0, 80) : "Untitled",
                units: "m", sample: !!data.sample, floors: [], scenarios: Array.isArray(data.scenarios) ? clone(data.scenarios) : [] };
    if (data.materials !== undefined) { out.materials = clone(data.materials); }
    if (data.mode !== undefined) {
      if (opts.modes && opts.modes.indexOf(data.mode) < 0) { throw ProjectError("mode: must be one of " + opts.modes.join(", ")); }
      out.mode = data.mode;
    }
    var materialIds = opts.materialIds ? opts.materialIds.concat(Object.keys(out.materials || {})) : null;
    data.floors.forEach(function (f, fi) {
      var p = "floors[" + fi + "]";
      if (!f || typeof f !== "object") { throw ProjectError(p + ": must be an object"); }
      var width = num(f.width_m, p + ".width_m", MIN_FLOOR_M, MAX_FLOOR_M), depth = num(f.depth_m, p + ".depth_m", MIN_FLOOR_M, MAX_FLOOR_M);
      var floor = { id: text(f, "id", p), name: text(f, "name", p), level: Math.round(num(f.level === undefined ? fi : f.level, p + ".level", -5, 50)),
                    height_m: num(f.height_m === undefined ? 2.5 : f.height_m, p + ".height_m", 2, 6),
                    width_m: width, depth_m: depth, rooms: [], walls: [], openings: [], furniture: [], sensors: [], aps: [], labels: [] };
      if (f.scale_m_per_px !== undefined) { floor.scale_m_per_px = num(f.scale_m_per_px, p + ".scale_m_per_px", SCALE_RANGE[0], SCALE_RANGE[1]); }
      if (f.background !== undefined) {
        if (typeof f.background !== "string" || !BACKGROUND_PATTERN.test(f.background)) {
          throw ProjectError(p + ".background: must be a png, jpeg or webp base64 data URL");
        }
        floor.background = f.background;
        floor.bg_opacity = num(f.bg_opacity === undefined ? DEFAULT_BG_OPACITY : f.bg_opacity, p + ".bg_opacity", 0, 1);
        if (f.bg_px !== undefined) {
          floor.bg_px = { w: num(f.bg_px.w, p + ".bg_px.w", 1), h: num(f.bg_px.h, p + ".bg_px.h", 1) };
        }
      }
      list(f, "rooms", p, 200).forEach(function (r, i) { floor.rooms.push(clone(r)); });
      list(f, "furniture", p, 200).forEach(function (r) { floor.furniture.push(clone(r)); });
      list(f, "sensors", p, 200).forEach(function (r) { floor.sensors.push(clone(r)); });
      list(f, "walls", p, MAX_WALLS).forEach(function (w, i) {
        var q = p + ".walls[" + i + "]";
        if (!w || typeof w !== "object") { throw ProjectError(q + ": must be an object"); }
        var wall = { id: text(w, "id", q), x1: num(w.x1, q + ".x1", 0, width), y1: num(w.y1, q + ".y1", 0, depth),
                     x2: num(w.x2, q + ".x2", 0, width), y2: num(w.y2, q + ".y2", 0, depth),
                     kind: WALL_KINDS.indexOf(w.kind) >= 0 ? w.kind : (function () { throw ProjectError(q + ".kind: must be one of " + WALL_KINDS.join(", ")); })() };
        if (wall.x1 === wall.x2 && wall.y1 === wall.y2) { throw ProjectError(q + ": wall has zero length"); }
        if (w.material !== undefined) {
          if (materialIds && materialIds.indexOf(w.material) < 0) { throw ProjectError(q + ".material: '" + w.material + "' is not a known material"); }
          wall.material = w.material;
        }
        if (w.name !== undefined) { wall.name = String(w.name).slice(0, 80); }
        floor.walls.push(wall);
      });
      var wallIds = floor.walls.map(function (w) { return w.id; });
      unique(wallIds, p + ".walls");
      list(f, "openings", p, MAX_WALLS).forEach(function (o, i) {
        var q = p + ".openings[" + i + "]";
        if (!o || wallIds.indexOf(o.wall) < 0) { throw ProjectError(q + ".wall: unknown wall id " + JSON.stringify(o && o.wall)); }
        if (o.kind !== "door" && o.kind !== "window") { throw ProjectError(q + ".kind: must be door or window"); }
        floor.openings.push({ id: text(o, "id", q), kind: o.kind, wall: o.wall, pos: num(o.pos, q + ".pos", 0), width: num(o.width, q + ".width", 0.1) });
      });
      list(f, "aps", p, MAX_APS).forEach(function (a, i) {
        var q = p + ".aps[" + i + "]";
        if (!a || typeof a !== "object") { throw ProjectError(q + ": must be an object"); }
        var ap = { id: text(a, "id", q), x: num(a.x, q + ".x", 0, width), y: num(a.y, q + ".y", 0, depth),
                   tx_dbm: num(a.tx_dbm === undefined ? 20 : a.tx_dbm, q + ".tx_dbm", TX_DBM_MIN, TX_DBM_MAX) };
        if (a.name !== undefined) { ap.name = String(a.name).slice(0, 80); }
        if (a.band !== undefined) {
          if (opts.bands && opts.bands.indexOf(a.band) < 0) { throw ProjectError(q + ".band: must be one of " + opts.bands.join(", ")); }
          ap.band = a.band;
        }
        if (a.channel !== undefined) { ap.channel = num(a.channel, q + ".channel", 1, 233); }
        floor.aps.push(ap);
      });
      list(f, "labels", p, MAX_LABELS).forEach(function (l, i) {
        var q = p + ".labels[" + i + "]";
        if (!l || typeof l !== "object") { throw ProjectError(q + ": must be an object"); }
        floor.labels.push({ id: text(l, "id", q), text: text(l, "text", q), x: num(l.x, q + ".x", 0, width), y: num(l.y, q + ".y", 0, depth) });
      });
      unique(floor.aps.map(function (a) { return a.id; }), p + ".aps");
      unique(floor.labels.map(function (l) { return l.id; }), p + ".labels");
      out.floors.push(floor);
    });
    unique(out.floors.map(function (f) { return f.id; }), "floors");
    unique(out.floors.map(function (f) { return String(f.level); }), "floors.level");
    return out;
  }

  /** Parse JSON text and validate it. Syntax errors become ProjectError too. */
  function parseProjectJson(textIn, opts) {
    var data;
    try { data = JSON.parse(textIn); } catch (e) { throw ProjectError("not valid JSON: " + e.message); }
    return validateProject(data, opts);
  }

  function exportProjectJson(project) { return JSON.stringify(project, null, 1); }

  // ------------------------------------------------------------------ lookups and ids
  function findFloor(project, floorId) {
    for (var i = 0; i < project.floors.length; i++) { if (project.floors[i].id === floorId) { return project.floors[i]; } }
    throw new Error("unknown floor id '" + floorId + "'");
  }
  function indexById(items, id) {
    for (var i = 0; i < items.length; i++) { if (items[i].id === id) { return i; } }
    return -1;
  }
  /** Smallest unused id of the form prefix + n, n starting at 1. */
  function nextId(items, prefix) {
    var used = {};
    items.forEach(function (it) { used[it.id] = true; });
    var n = 1;
    while (used[prefix + n]) { n++; }
    return prefix + n;
  }
  function wallLength(w) { return Math.hypot(w.x2 - w.x1, w.y2 - w.y1); }
  /** Padded bounding box {x0,y0,x1,y1} of a wall, used for dirty-tile tests. */
  function wallBox(w) {
    return { x0: Math.min(w.x1, w.x2), y0: Math.min(w.y1, w.y2), x1: Math.max(w.x1, w.x2), y1: Math.max(w.y1, w.y2) };
  }

  // ------------------------------------------------------------------ operations
  // An operation is plain data. applyOp mutates the project, invertOp returns the operation that
  // undoes it. Builders (below) capture everything an inverse needs, so no operation reads state later.
  var LISTS = { wall: "walls", ap: "aps", label: "labels" };

  function setProps(target, props) {
    Object.keys(props).forEach(function (k) { if (props[k] === undefined) { delete target[k]; } else { target[k] = clone(props[k]); } });
  }

  function applyOp(project, op) {
    var floor = findFloor(project, op.floor), parts = op.t.split("."), kind = parts[0], verb = parts[1];
    if (kind === "floor") { setProps(floor, op.after); return; }
    var items = floor[LISTS[kind]];
    if (verb === "add") {
      var at = op.index === undefined ? items.length : Math.min(op.index, items.length);
      items.splice(at, 0, clone(op.item));
      if (kind === "wall" && op.openings) {   // restore openings at their old positions, lowest index first
        op.openings.forEach(function (e) { floor.openings.splice(Math.min(e.index, floor.openings.length), 0, clone(e.item)); });
      }
    } else if (verb === "remove") {
      var i = indexById(items, op.id);
      if (i < 0) { throw new Error(kind + " '" + op.id + "' not found on floor '" + op.floor + "'"); }
      items.splice(i, 1);
      if (kind === "wall") { floor.openings = floor.openings.filter(function (o) { return o.wall !== op.id; }); }
    } else if (verb === "set") {
      var j = indexById(items, op.id);
      if (j < 0) { throw new Error(kind + " '" + op.id + "' not found on floor '" + op.floor + "'"); }
      setProps(items[j], op.after);
    } else { throw new Error("unknown operation " + op.t); }
  }

  function invertOp(op) {
    var parts = op.t.split("."), kind = parts[0], verb = parts[1];
    if (kind === "floor") { return { t: op.t, floor: op.floor, before: op.after, after: op.before }; }
    if (verb === "set") { return { t: op.t, floor: op.floor, id: op.id, before: op.after, after: op.before }; }
    if (verb === "add") { return { t: kind + ".remove", floor: op.floor, id: op.item.id, item: op.item, index: op.index, openings: op.openings }; }
    return { t: kind + ".add", floor: op.floor, item: op.item, index: op.index, openings: op.openings };
  }

  function addOp(kind, project, floorId, item) {
    var items = findFloor(project, floorId)[LISTS[kind]];
    return { t: kind + ".add", floor: floorId, item: clone(item), index: items.length };
  }
  function removeOp(kind, project, floorId, id) {
    var floor = findFloor(project, floorId), items = floor[LISTS[kind]], i = indexById(items, id);
    if (i < 0) { throw new Error(kind + " '" + id + "' not found on floor '" + floorId + "'"); }
    var op = { t: kind + ".remove", floor: floorId, id: id, item: clone(items[i]), index: i };
    if (kind === "wall") {
      op.openings = [];
      floor.openings.forEach(function (o, n) { if (o.wall === id) { op.openings.push({ item: clone(o), index: n }); } });
    }
    return op;
  }
  /** Set operation from the current values: only keys whose value changes are recorded. */
  function setOp(kind, project, floorId, id, after) {
    var floor = findFloor(project, floorId), target = kind === "floor" ? floor : floor[LISTS[kind]][indexById(floor[LISTS[kind]], id)];
    if (!target) { throw new Error(kind + " '" + id + "' not found on floor '" + floorId + "'"); }
    var before = {}, keep = {};
    Object.keys(after).forEach(function (k) {
      if (JSON.stringify(target[k]) !== JSON.stringify(after[k])) { before[k] = clone(target[k]); keep[k] = clone(after[k]); }
    });
    return kind === "floor" ? { t: "floor.set", floor: floorId, before: before, after: keep }
                            : { t: kind + ".set", floor: floorId, id: id, before: before, after: keep };
  }
  function isNoop(op) { return op.t.slice(-4) === ".set" && !Object.keys(op.after).length; }

  // ------------------------------------------------------------------ history store
  /**
   * Store: the project, undo/redo, selection and dirty state.
   * exec(entry) with entry {label, ops, key?} applies the operations. Entries sharing a key merge
   * into the previous entry when both consist only of set operations (drags are one undo step).
   * Subscribers get {source: "exec"|"undo"|"redo"|"load", ops, label} with the operations that were applied.
   */
  function createStore(project, options) {
    var cap = (options && options.cap) || HISTORY_CAP;
    var past = [], future = [], subs = [], savedPos = 0, floorId = project.floors[0].id;
    var selection = { walls: [], ap: null, label: null };

    function emit(ev) { subs.slice().forEach(function (fn) { fn(ev); }); }
    function onlySets(ops) { return ops.every(function (o) { return o.t.slice(-4) === ".set"; }); }
    function sameShape(a, b) {
      return a.length === b.length && a.every(function (o, i) { return o.t === b[i].t && o.floor === b[i].floor && o.id === b[i].id; });
    }
    function prune() {
      var ids = {};
      var floor = findFloor(store.project, floorId);
      floor.walls.forEach(function (w) { ids[w.id] = true; });
      selection.walls = selection.walls.filter(function (id) { return ids[id]; });
      if (selection.ap && indexById(floor.aps, selection.ap) < 0) { selection.ap = null; }
      if (selection.label && indexById(floor.labels, selection.label) < 0) { selection.label = null; }
    }

    var store = {
      project: project,
      get floorId() { return floorId; },
      selection: selection,
      subscribe: function (fn) { subs.push(fn); },
      setFloor: function (id) {
        findFloor(store.project, id);
        floorId = id; selection.walls = []; selection.ap = null; selection.label = null;
        emit({ source: "floor", ops: [] });
      },
      select: function (sel) {
        selection.walls = (sel.walls || []).slice(); selection.ap = sel.ap || null; selection.label = sel.label || null;
        emit({ source: "select", ops: [] });
      },
      exec: function (entry) {
        var ops = entry.ops.filter(function (o) { return !isNoop(o); });
        if (!ops.length) { return false; }
        ops.forEach(function (o) { applyOp(store.project, o); });
        var top = past[past.length - 1];
        if (entry.key && top && top.key === entry.key && !future.length && onlySets(ops) && onlySets(top.ops) && sameShape(top.ops, ops)) {
          top.ops.forEach(function (o, i) { o.after = Object.assign({}, o.after, ops[i].after); });
          if (savedPos === past.length) { savedPos = NaN; }   // the saved state no longer matches any history position
        } else {
          past.push({ label: entry.label, key: entry.key, ops: clone(ops) });
          future.length = 0;
          if (past.length > cap) { past.shift(); savedPos -= 1; if (savedPos < 0) { savedPos = NaN; } }
        }
        prune();
        emit({ source: "exec", ops: ops, label: entry.label });
        return true;
      },
      canUndo: function () { return past.length > 0; },
      canRedo: function () { return future.length > 0; },
      undoLabel: function () { return past.length ? past[past.length - 1].label : null; },
      redoLabel: function () { return future.length ? future[future.length - 1].label : null; },
      undo: function () {
        if (!past.length) { return false; }
        var entry = past.pop(), inv = entry.ops.slice().reverse().map(invertOp);
        inv.forEach(function (o) { applyOp(store.project, o); });
        future.push(entry); prune();
        emit({ source: "undo", ops: inv, label: entry.label });
        return true;
      },
      redo: function () {
        if (!future.length) { return false; }
        var entry = future.pop();
        entry.ops.forEach(function (o) { applyOp(store.project, o); });
        past.push(entry); prune();
        emit({ source: "redo", ops: entry.ops.slice(), label: entry.label });
        return true;
      },
      historyLength: function () { return past.length; },
      isDirty: function () { return savedPos !== past.length; },
      markSaved: function () { savedPos = past.length; },
      /** Replace the whole project (open, import, reset). Clears history. */
      load: function (next) {
        store.project = next; past.length = 0; future.length = 0; savedPos = 0;
        floorId = next.floors[0].id; selection.walls = []; selection.ap = null; selection.label = null;
        emit({ source: "load", ops: [] });
      }
    };
    return store;
  }

  // ------------------------------------------------------------------ persistence
  /** Save to a Storage-like object. Quota errors are caught and returned, never thrown. */
  function saveProject(storage, project) {
    var data = exportProjectJson(project);
    try {
      storage.setItem(STORAGE_KEY, data);
      return { ok: true, bytes: data.length };
    } catch (e) {
      var quota = e && (e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED" || e.code === 22 || e.code === 1014);
      return { ok: false, bytes: data.length, quota: !!quota,
               error: quota ? "Browser storage is full (" + Math.round(data.length / 1024) + " KB needed). Export the project as JSON to keep it, or remove the floor-plan image."
                            : "Could not save to browser storage: " + (e && e.message) };
    }
  }

  /** Load the saved project. Returns {project} or {project: null, error?}; a corrupt save is reported, not thrown. */
  function loadSavedProject(storage, opts) {
    var raw;
    try { raw = storage.getItem(STORAGE_KEY); } catch (e) { return { project: null, error: "Browser storage is unavailable: " + e.message }; }
    if (raw === null || raw === undefined) { return { project: null }; }
    try { return { project: parseProjectJson(raw, opts) }; } catch (e) { return { project: null, error: "Saved project ignored: " + e.message }; }
  }

  var api = { SCHEMA_VERSION: SCHEMA_VERSION, HISTORY_CAP: HISTORY_CAP, STORAGE_KEY: STORAGE_KEY, MAX_WALLS: MAX_WALLS,
              DEFAULT_BG_OPACITY: DEFAULT_BG_OPACITY, validateProject: validateProject, parseProjectJson: parseProjectJson,
              exportProjectJson: exportProjectJson, findFloor: findFloor, nextId: nextId, wallLength: wallLength, wallBox: wallBox,
              applyOp: applyOp, invertOp: invertOp, addOp: addOp, removeOp: removeOp, setOp: setOp, createStore: createStore,
              saveProject: saveProject, loadSavedProject: loadSavedProject, clone: clone };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  root.PlannerState = api;
})(typeof self !== "undefined" ? self : this);
