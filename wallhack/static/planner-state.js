"use strict";
// Planner project model: validation of imported JSON, command based undo/redo history, selection,
// dirty tracking and localStorage persistence. Pure logic, no DOM, so it runs under node in
// tests/test_planner_state.py. The project format is the digital twin format (wallhack/twin.py)
// plus a schema_version and a few planner fields (floor labels, background image placement).
(function (root) {
  var SCHEMA_VERSION = 2;   // 2 adds annotations, devices, scenarios, capacity and ap.mesh_parent; version 1 files still load
  var HISTORY_CAP = 200;
  // Count, text and material limits shared with wallhack/twin.py come from rf-config.json "limits" (see limitsOf).
  var MAX_APS = 64, MAX_FLOOR_M = 200, MIN_FLOOR_M = 1;
  var MAX_SCENARIOS = 20, MAX_CAPACITY_ZONES = 200, MAX_USERS = 5000;
  var ANNOTATION_KINDS = ["text", "arrow", "pin"];
  var TX_DBM_MIN = 0, TX_DBM_MAX = 30, SCALE_RANGE = [0.0001, 100];
  var BACKGROUND_PATTERN = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
  var STORAGE_KEY = "wallhack.planner.project";
  var WALL_KINDS = ["interior", "exterior"];
  var DEFAULT_BG_OPACITY = 0.5;
  var DEFAULT_BAND = "2.4";   // same default as rf-engine.js and rfmodel.py

  function ProjectError(message) {
    var e = new Error(message);
    e.name = "ProjectError";
    return e;
  }

  var nodeConfig = null;
  /** The RF config: opts.config in the browser, the shared rf-config.json file when run under node. */
  function configOf(opts) {
    if (opts.config) { return opts.config; }
    if (!nodeConfig) {
      // @ts-ignore require exists only under Node (tests); the browser passes opts.config. No @types/node by design.
      if (typeof require !== "function") { throw ProjectError("validateProject needs opts.config (the rf-config.json content)"); }
      // @ts-ignore see above
      nodeConfig = require("./rf-config.json");
    }
    return nodeConfig;
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

  /** Strict text for ids and enum-like fields: 1 to max characters, otherwise ProjectError. Never truncated, because ids are references. */
  function text(obj, key, path, max) {
    var v = obj[key];
    if (typeof v !== "string" || !v.trim().length || v.length > max) { throw ProjectError(path + "." + key + ": must be a text of 1 to " + max + " characters"); }
    return v;
  }
  /** Text for fields the editor wrote (wall, AP and device names, labels, notes, scenario names): non-empty, truncated to max characters so older saved projects still load. */
  function nameText(obj, key, path, max) {
    var v = obj[key];
    if (typeof v !== "string" || !v.trim().length) { throw ProjectError(path + "." + key + ": must be a non-empty text"); }
    return v.slice(0, max);
  }
  /** The single text limit (characters) for names, labels, notes and scenario names, from rf-config.json limits. */
  function textLimit(opts) { return configOf(opts || {}).limits.max_text_chars; }
  /** Fit user input to the limit. Returns {text, clipped} so the caller can tell the user. Used by the editor, notes and scenarios. */
  function clipText(value, max) {
    var v = String(value);
    return { text: v.slice(0, max), clipped: v.length > max };
  }
  function choice(obj, key, allowed, path) {
    if (allowed.indexOf(obj[key]) < 0) { throw ProjectError(path + "." + key + ": must be one of " + allowed.join(", ")); }
    return obj[key];
  }
  function object(v, path) {
    if (!v || typeof v !== "object" || Array.isArray(v)) { throw ProjectError(path + ": must be an object"); }
    return v;
  }

  function list(obj, key, path, max) {
    var v = obj[key] === undefined ? [] : obj[key];
    if (!Array.isArray(v)) { throw ProjectError(path + "." + key + ": must be a list"); }
    if (v.length > max) { throw ProjectError(path + "." + key + ": at most " + max + " items, got " + v.length); }
    return v;
  }

  function unique(ids, path) {
    var seen = Object.create(null);   // no prototype: ids such as "constructor" and "__proto__" are ordinary names
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
    var cfg = configOf(opts), limits = cfg.limits, maxItems = limits.max_items_per_list;
    var maxWalls = limits.max_walls_per_floor, maxOpenings = limits.max_openings_per_floor;
    var maxText = limits.max_text_chars;
    if (!data || typeof data !== "object" || Array.isArray(data)) { throw ProjectError("project: must be a JSON object"); }
    var version = data.schema_version === undefined ? SCHEMA_VERSION : data.schema_version;
    if (!isNum(version) || version < 1 || version > SCHEMA_VERSION || Math.floor(version) !== version) {
      throw ProjectError("schema_version: " + JSON.stringify(data.schema_version) + " is not supported (this planner reads version 1 to " + SCHEMA_VERSION + ")");
    }
    if (!Array.isArray(data.floors) || data.floors.length < 1 || data.floors.length > limits.max_floors) {
      throw ProjectError("floors: must be a list of 1 to " + limits.max_floors + " floors");
    }
    var out = { schema_version: SCHEMA_VERSION, name: typeof data.name === "string" && data.name.trim() ? data.name.slice(0, maxText) : "Untitled",
                units: "m", sample: !!data.sample, floors: [], scenarios: [], capacity: {} };
    if (data.materials !== undefined) { out.materials = validateMaterials(data.materials, limits, Object.keys(cfg.bands)); }
    if (data.mode !== undefined) {
      if (opts.modes && opts.modes.indexOf(data.mode) < 0) { throw ProjectError("mode: must be one of " + opts.modes.join(", ")); }
      out.mode = data.mode;
    }
    var materialIds = (opts.materialIds || Object.keys(cfg.materials)).concat(Object.keys(out.materials || {}));
    data.floors.forEach(function (f, fi) {
      var p = "floors[" + fi + "]";
      object(f, p);
      var width = num(f.width_m, p + ".width_m", MIN_FLOOR_M, MAX_FLOOR_M), depth = num(f.depth_m, p + ".depth_m", MIN_FLOOR_M, MAX_FLOOR_M);
      var floor = { id: text(f, "id", p, maxText), name: text(f, "name", p, maxText), level: Math.round(num(f.level === undefined ? fi : f.level, p + ".level", -5, 50)),
                    height_m: num(f.height_m === undefined ? 2.5 : f.height_m, p + ".height_m", 2, 6),
                    width_m: width, depth_m: depth, rooms: [], walls: [], openings: [], furniture: [], sensors: [], aps: [], labels: [], annotations: [], devices: [] };
      if (f.scale_m_per_px !== undefined) { floor.scale_m_per_px = num(f.scale_m_per_px, p + ".scale_m_per_px", SCALE_RANGE[0], SCALE_RANGE[1]); }
      if (f.background !== undefined) {
        if (typeof f.background !== "string" || !BACKGROUND_PATTERN.test(f.background)) {
          throw ProjectError(p + ".background: must be a png, jpeg or webp base64 data URL");
        }
        if (f.background.length > limits.max_background_chars) { throw ProjectError(p + ".background: at most " + limits.max_background_chars + " characters"); }
        floor.background = f.background;
        floor.bg_opacity = num(f.bg_opacity === undefined ? DEFAULT_BG_OPACITY : f.bg_opacity, p + ".bg_opacity", 0, 1);
        if (f.bg_px !== undefined) {
          floor.bg_px = { w: num(f.bg_px.w, p + ".bg_px.w", 1), h: num(f.bg_px.h, p + ".bg_px.h", 1) };
        }
      }
      list(f, "rooms", p, maxItems).forEach(function (r, i) {
        var q = p + ".rooms[" + i + "]";
        object(r, q);
        var rx = num(r.x, q + ".x", 0, width), ry = num(r.y, q + ".y", 0, depth), rw = num(r.w, q + ".w", 0.1), rd = num(r.d, q + ".d", 0.1);
        if (rx + rw > width + 1e-9 || ry + rd > depth + 1e-9) { throw ProjectError(q + ": room extends outside the floor"); }
        var room = { id: text(r, "id", q, maxText), name: text(r, "name", q, maxText), x: rx, y: ry, w: rw, d: rd };
        if (r.label !== undefined) { room.label = text(r, "label", q, maxText); }
        floor.rooms.push(room);
      });
      list(f, "furniture", p, maxItems).forEach(function (r, i) {
        var q = p + ".furniture[" + i + "]";
        object(r, q);
        floor.furniture.push({ id: text(r, "id", q, maxText), kind: choice(r, "kind", limits.furniture_kinds, q), x: num(r.x, q + ".x", 0, width), y: num(r.y, q + ".y", 0, depth),
                               w: num(r.w, q + ".w", 0.05), d: num(r.d, q + ".d", 0.05) });
      });
      list(f, "sensors", p, maxItems).forEach(function (r, i) {
        var q = p + ".sensors[" + i + "]";
        object(r, q);
        floor.sensors.push({ id: text(r, "id", q, maxText), kind: choice(r, "kind", limits.sensor_kinds, q), x: num(r.x, q + ".x", 0, width), y: num(r.y, q + ".y", 0, depth) });
      });
      list(f, "walls", p, maxWalls).forEach(function (w, i) {
        var q = p + ".walls[" + i + "]";
        object(w, q);
        var wall = { id: text(w, "id", q, maxText), x1: num(w.x1, q + ".x1", 0, width), y1: num(w.y1, q + ".y1", 0, depth),
                     x2: num(w.x2, q + ".x2", 0, width), y2: num(w.y2, q + ".y2", 0, depth),
                     kind: WALL_KINDS.indexOf(w.kind) >= 0 ? w.kind : (function () { throw ProjectError(q + ".kind: must be one of " + WALL_KINDS.join(", ")); })() };
        if (wall.x1 === wall.x2 && wall.y1 === wall.y2) { throw ProjectError(q + ": wall has zero length"); }
        if (w.material !== undefined) {
          if (materialIds.indexOf(w.material) < 0) { throw ProjectError(q + ".material: '" + w.material + "' is not a known material"); }
          wall.material = w.material;
        }
        if (w.name !== undefined) { wall.name = nameText(w, "name", q, maxText); }
        floor.walls.push(wall);
      });
      var wallIds = floor.walls.map(function (w) { return w.id; });
      unique(wallIds, p + ".walls");
      var wallById = Object.create(null);
      floor.walls.forEach(function (w) { wallById[w.id] = w; });
      list(f, "openings", p, maxOpenings).forEach(function (o, i) {
        var q = p + ".openings[" + i + "]";
        if (!o || typeof o !== "object" || !wallById[o.wall]) { throw ProjectError(q + ".wall: unknown wall id " + JSON.stringify(o && o.wall)); }
        if (o.kind !== "door" && o.kind !== "window") { throw ProjectError(q + ".kind: must be door or window"); }
        var wl = wallLength(wallById[o.wall]), opos = num(o.pos, q + ".pos", 0, wl), ow = num(o.width, q + ".width", 0.1);
        if (opos + ow > wl + 1e-9) { throw ProjectError(q + ": opening extends past the end of wall '" + o.wall + "'"); }
        floor.openings.push({ id: text(o, "id", q, maxText), kind: o.kind, wall: o.wall, pos: opos, width: ow });
      });
      list(f, "aps", p, Math.min(MAX_APS, maxItems)).forEach(function (a, i) {
        var q = p + ".aps[" + i + "]";
        object(a, q);
        var ap = { id: text(a, "id", q, maxText), x: num(a.x, q + ".x", 0, width), y: num(a.y, q + ".y", 0, depth),
                   tx_dbm: num(a.tx_dbm === undefined ? 20 : a.tx_dbm, q + ".tx_dbm", TX_DBM_MIN, TX_DBM_MAX) };
        if (a.name !== undefined) { ap.name = nameText(a, "name", q, maxText); }
        if (a.band !== undefined) {
          var knownBands = opts.bands || Object.keys(cfg.bands);
          if (knownBands.indexOf(a.band) < 0) { throw ProjectError(q + ".band: must be one of " + knownBands.join(", ")); }
          ap.band = a.band;
        }
        if (a.channel !== undefined) {
          var bandId = ap.band || DEFAULT_BAND;
          if (!cfg.bands[bandId]) { throw ProjectError(q + ".band: unknown band '" + bandId + "', must be one of " + Object.keys(cfg.bands).join(", ")); }
          var channels = cfg.bands[bandId].channels;
          if (channels.indexOf(a.channel) < 0) { throw ProjectError(q + ".channel: must be one of " + channels.join(", ") + " for this band"); }
          ap.channel = a.channel;
        }
        if (a.mesh_parent !== undefined && a.mesh_parent !== null) { ap.mesh_parent = text(a, "mesh_parent", q, maxText); }
        floor.aps.push(ap);
      });
      list(f, "labels", p, maxItems).forEach(function (l, i) {
        var q = p + ".labels[" + i + "]";
        if (!l || typeof l !== "object") { throw ProjectError(q + ": must be an object"); }
        floor.labels.push({ id: text(l, "id", q, maxText), text: nameText(l, "text", q, maxText), x: num(l.x, q + ".x", 0, width), y: num(l.y, q + ".y", 0, depth) });
      });
      list(f, "annotations", p, maxItems).forEach(function (a, i) {
        var q = p + ".annotations[" + i + "]";
        if (!a || typeof a !== "object") { throw ProjectError(q + ": must be an object"); }
        if (ANNOTATION_KINDS.indexOf(a.kind) < 0) { throw ProjectError(q + ".kind: must be one of " + ANNOTATION_KINDS.join(", ")); }
        var note = { id: text(a, "id", q, maxText), kind: a.kind, x: num(a.x, q + ".x", 0, width), y: num(a.y, q + ".y", 0, depth) };
        if (a.kind === "arrow") { note.x2 = num(a.x2, q + ".x2", 0, width); note.y2 = num(a.y2, q + ".y2", 0, depth); }
        if (a.text !== undefined) { note.text = nameText(a, "text", q, maxText); } else if (a.kind === "text") { throw ProjectError(q + ".text: required for a text note"); }
        floor.annotations.push(note);
      });
      list(f, "devices", p, maxItems).forEach(function (d, i) {
        var q = p + ".devices[" + i + "]";
        if (!d || typeof d !== "object") { throw ProjectError(q + ": must be an object"); }
        var cls = text(d, "cls", q, maxText);
        if (opts.deviceClasses && opts.deviceClasses.indexOf(cls) < 0) { throw ProjectError(q + ".cls: must be one of " + opts.deviceClasses.join(", ")); }
        var dev = { id: text(d, "id", q, maxText), cls: cls, x: num(d.x, q + ".x", 0, width), y: num(d.y, q + ".y", 0, depth) };
        if (d.name !== undefined) { dev.name = nameText(d, "name", q, maxText); }
        floor.devices.push(dev);
      });
      unique(floor.aps.map(function (a) { return a.id; }), p + ".aps");
      unique(floor.labels.map(function (l) { return l.id; }), p + ".labels");
      unique(floor.annotations.map(function (a) { return a.id; }), p + ".annotations");
      unique(floor.devices.map(function (d) { return d.id; }), p + ".devices");
      out.floors.push(floor);
    });
    unique(out.floors.map(function (f) { return f.id; }), "floors");
    unique(out.floors.map(function (f) { return String(f.level); }), "floors.level");
    var apIds = Object.create(null);
    out.floors.forEach(function (f) { f.aps.forEach(function (a) { apIds[a.id] = a; }); });
    Object.keys(apIds).forEach(function (id) {
      var seen = Object.create(null), cur = apIds[id];
      while (cur && cur.mesh_parent !== undefined) {
        if (!apIds[cur.mesh_parent]) { throw ProjectError("aps: mesh_parent '" + cur.mesh_parent + "' of '" + cur.id + "' is not an access point"); }
        if (seen[cur.id]) { throw ProjectError("aps: mesh backhaul of '" + id + "' loops back on itself"); }
        seen[cur.id] = true; cur = apIds[cur.mesh_parent];
      }
    });
    if (data.capacity !== undefined) { out.capacity = validateCapacity(data.capacity, maxText); }
    if (data.scenarios !== undefined) {
      if (!Array.isArray(data.scenarios) || data.scenarios.length > MAX_SCENARIOS) { throw ProjectError("scenarios: must be a list of at most " + MAX_SCENARIOS + " scenarios"); }
      data.scenarios.forEach(function (sc, i) {
        var q = "scenarios[" + i + "]";
        if (!sc || typeof sc !== "object") { throw ProjectError(q + ": must be an object"); }
        var inner = validateProject({ name: "scenario", floors: sc.floors, materials: out.materials }, opts);
        var item = { id: text(sc, "id", q, maxText), name: nameText(sc, "name", q, maxText), created: typeof sc.created === "string" ? sc.created.slice(0, 40) : "", floors: inner.floors };
        if (sc.settings && typeof sc.settings === "object") { item.settings = { mode: typeof sc.settings.mode === "string" ? sc.settings.mode : undefined, band: typeof sc.settings.band === "string" ? sc.settings.band : null }; }
        out.scenarios.push(item);
      });
      unique(out.scenarios.map(function (sc) { return sc.id; }), "scenarios");
    }
    return out;
  }

  /** Project-defined materials, same rules as twin._custom_materials: {id: {label, attenuation_db{band}, reflection_loss_db{band}}}. */
  function validateMaterials(m, limits, bands) {
    if (!m || typeof m !== "object" || Array.isArray(m) || Object.keys(m).length > limits.max_custom_materials) {
      throw ProjectError("materials: must be an object with at most " + limits.max_custom_materials + " entries");
    }
    var out = Object.create(null);
    Object.keys(m).forEach(function (mid) {
      var q = "materials." + mid, e = m[mid];
      if (!mid.trim().length || mid.length > limits.max_text_chars || !e || typeof e !== "object" || Array.isArray(e)) {
        throw ProjectError(q + ": must be an object with an id of up to " + limits.max_text_chars + " characters");
      }
      var entry = { label: text(e, "label", q, limits.max_text_chars) };
      ["attenuation_db", "reflection_loss_db"].forEach(function (key) {
        var table = e[key];
        if (!table || typeof table !== "object" || Array.isArray(table) || Object.keys(table).sort().join("|") !== bands.slice().sort().join("|")) {
          throw ProjectError(q + "." + key + ": must give a value for each band " + bands.join(", "));
        }
        entry[key] = {};
        bands.forEach(function (b) { entry[key][b] = num(table[b], q + "." + key + "." + b, limits.material_db_range[0], limits.material_db_range[1]); });
      });
      out[mid] = entry;
    });
    return out;
  }

  /** Capacity planning input: {"floorId/roomId": {users, profile}}. */
  function validateCapacity(c, maxText) {
    if (!c || typeof c !== "object" || Array.isArray(c)) { throw ProjectError("capacity: must be an object"); }
    var keys = Object.keys(c), out = Object.create(null);
    if (keys.length > MAX_CAPACITY_ZONES) { throw ProjectError("capacity: at most " + MAX_CAPACITY_ZONES + " zones"); }
    keys.forEach(function (k) {
      var z = c[k], q = "capacity[" + JSON.stringify(k) + "]";
      if (!z || typeof z !== "object") { throw ProjectError(q + ": must be an object"); }
      var users = num(z.users, q + ".users", 0, MAX_USERS);
      if (Math.floor(users) !== users) { throw ProjectError(q + ".users: must be a whole number"); }
      out[k] = { users: users, profile: text(z, "profile", q, maxText) };
    });
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
    var used = Object.create(null);
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
  var LISTS = { wall: "walls", ap: "aps", label: "labels", annotation: "annotations", device: "devices" };

  function setProps(target, props) {
    Object.keys(props).forEach(function (k) { if (props[k] === undefined || props[k] === null) { delete target[k]; } else { target[k] = clone(props[k]); } });
  }

  function applyOp(project, op) {
    if (op.t === "floors.add") { project.floors.splice(Math.min(op.index, project.floors.length), 0, clone(op.item)); return; }
    if (op.t === "floors.remove") {
      var fi = indexById(project.floors, op.id);
      if (fi < 0) { throw new Error("floor '" + op.id + "' not found"); }
      project.floors.splice(fi, 1);
      return;
    }
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
    if (op.t === "floors.add") { return { t: "floors.remove", id: op.item.id, item: op.item, index: op.index }; }
    if (op.t === "floors.remove") { return { t: "floors.add", item: op.item, index: op.index }; }
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
    // An absent value is recorded as null (JSON keeps null, it would drop undefined, which broke undo of "remove channel").
    function orNull(v) { return v === undefined ? null : clone(v); }
    Object.keys(after).forEach(function (k) {
      if (JSON.stringify(orNull(target[k])) !== JSON.stringify(orNull(after[k]))) { before[k] = orNull(target[k]); keep[k] = orNull(after[k]); }
    });
    return kind === "floor" ? { t: "floor.set", floor: floorId, before: before, after: keep }
                            : { t: kind + ".set", floor: floorId, id: id, before: before, after: keep };
  }
  /** Operation that appends a new empty floor (a whole floor record, see newFloor). */
  function addFloorOp(project, floor) { return { t: "floors.add", item: clone(floor), index: project.floors.length }; }
  /** An empty floor above the highest level, same footprint as the first floor. */
  function newFloor(project) {
    var top = project.floors.reduce(function (m, f) { return Math.max(m, f.level); }, -Infinity), first = project.floors[0];
    var id = nextId(project.floors, "f"), n = project.floors.length + 1;
    return { id: id, name: "Floor " + n, level: top + 1, height_m: first.height_m, width_m: first.width_m, depth_m: first.depth_m,
             rooms: [], walls: [], openings: [], furniture: [], sensors: [], aps: [], labels: [], annotations: [], devices: [] };
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
    var past = [], future = [], subs = [], savedPos = 0, metaRev = 0, savedMetaRev = 0, floorId = project.floors[0].id;
    var selection = { walls: [], ap: null, label: null };

    function emit(ev) { subs.slice().forEach(function (fn) { fn(ev); }); }
    function onlySets(ops) { return ops.every(function (o) { return o.t.slice(-4) === ".set"; }); }
    function sameShape(a, b) {
      return a.length === b.length && a.every(function (o, i) { return o.t === b[i].t && o.floor === b[i].floor && o.id === b[i].id; });
    }
    function prune() {
      var ids = {};
      if (indexById(store.project.floors, floorId) < 0) { floorId = store.project.floors[0].id; selection.walls = []; selection.ap = null; selection.label = null; }
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
      /** Replace project.scenarios or project.capacity. Not part of undo history: it marks the project unsaved and emits "meta". */
      setMeta: function (key, value) {
        if (key !== "scenarios" && key !== "capacity") { throw new Error("unknown project field " + key); }
        store.project[key] = clone(value); metaRev += 1;
        emit({ source: "meta", key: key, ops: [] });
      },
      historyLength: function () { return past.length; },
      isDirty: function () { return savedPos !== past.length || savedMetaRev !== metaRev; },
      markSaved: function () { savedPos = past.length; savedMetaRev = metaRev; },
      /** Replace the whole project (open, import, reset). Clears history. */
      load: function (next) {
        store.project = next; past.length = 0; future.length = 0; savedPos = 0; metaRev = 0; savedMetaRev = 0;
        floorId = next.floors[0].id; selection.walls = []; selection.ap = null; selection.label = null;
        emit({ source: "load", ops: [] });
      }
    };
    return store;
  }

  // ------------------------------------------------------------------ scenarios
  // A scenario is a named snapshot of the floors (without floor-plan images, which stay in the project)
  // plus the heat map settings. They live in project.scenarios, so they are saved with the project.
  function snapshotFloors(project) {
    return project.floors.map(function (f) { var c = clone(f); delete c.background; delete c.bg_px; delete c.bg_opacity; return c; });
  }
  function makeScenario(project, name, settings, now, max) {
    return { id: nextId(project.scenarios || [], "s"), name: clipText(name || "Scenario", max).text, created: now || "",
             floors: snapshotFloors(project), settings: settings ? { mode: settings.mode, band: settings.band || null } : undefined };
  }
  /** The project a scenario describes: its floors, with the live project's images carried over by floor id. */
  function scenarioProject(project, scenario) {
    var out = clone(project);
    out.scenarios = []; out.floors = clone(scenario.floors); out.name = scenario.name;
    out.floors.forEach(function (f) {
      var live = project.floors.filter(function (g) { return g.id === f.id; })[0];
      if (live && live.background) { f.background = live.background; f.bg_opacity = live.bg_opacity; if (live.bg_px) { f.bg_px = clone(live.bg_px); } }
    });
    return out;
  }
  /** Project with images and scenarios removed, for computation (worker messages). */
  function computeProject(project) {
    var out = Object.assign({}, project, { scenarios: [] });
    out.floors = project.floors.map(function (f) { var c = Object.assign({}, f); delete c.background; return c; });
    return out;
  }
  function renameScenario(list, id, name, max) {
    return list.map(function (s) { return s.id === id ? Object.assign({}, s, { name: clipText(name, max).text || s.name }) : s; });
  }
  function deleteScenario(list, id) { return list.filter(function (s) { return s.id !== id; }); }
  function duplicateScenario(list, id, now, max) {
    var src = list.filter(function (s) { return s.id === id; })[0];
    if (!src) { throw new Error("scenario '" + id + "' not found"); }
    var copy = clone(src);
    copy.id = nextId(list, "s"); copy.name = clipText(src.name + " copy", max).text; copy.created = now || "";
    return list.concat([copy]);
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

  var api = { textLimit: textLimit, clipText: clipText, SCHEMA_VERSION: SCHEMA_VERSION, HISTORY_CAP: HISTORY_CAP, STORAGE_KEY: STORAGE_KEY,
              DEFAULT_BG_OPACITY: DEFAULT_BG_OPACITY, validateProject: validateProject, parseProjectJson: parseProjectJson,
              exportProjectJson: exportProjectJson, findFloor: findFloor, nextId: nextId, wallLength: wallLength, wallBox: wallBox,
              applyOp: applyOp, invertOp: invertOp, addOp: addOp, removeOp: removeOp, setOp: setOp, createStore: createStore,
              saveProject: saveProject, loadSavedProject: loadSavedProject, clone: clone,
              addFloorOp: addFloorOp, newFloor: newFloor, makeScenario: makeScenario, scenarioProject: scenarioProject, computeProject: computeProject,
              renameScenario: renameScenario, deleteScenario: deleteScenario, duplicateScenario: duplicateScenario, validateCapacity: validateCapacity,
              MAX_SCENARIOS: MAX_SCENARIOS };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  root.PlannerState = api;
})(typeof self !== "undefined" ? self : this);
