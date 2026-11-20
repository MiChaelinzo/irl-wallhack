"use strict";
// Digital twin controls: floor and view selectors, signal heat overlay and the twin designer.
// Rendering lives in view3d.js and every RF number comes from the server (/api/rf/coverage).
// In the static demo the designer is read-only.
(function () {
  var W = window.Wallhack;
  if (!W || !window.Room3D) { return; }
  var FURNITURE_KINDS = ["sofa", "bed", "table", "desk", "wardrobe", "counter", "other"];
  var SENSOR_KINDS = ["air", "presence", "rssi"];
  var DEFAULT_TX_DBM = 20;
  // Editable fields per item type: [property, label, input type or option list]
  var FIELDS = {
    room: [["name", "Name", "text"], ["x", "X (m)", "number"], ["y", "Y (m)", "number"], ["w", "Width (m)", "number"], ["d", "Depth (m)", "number"]],
    furniture: [["kind", "Kind", FURNITURE_KINDS], ["x", "X (m)", "number"], ["y", "Y (m)", "number"], ["w", "Width (m)", "number"], ["d", "Depth (m)", "number"]],
    door: [["wall", "Wall", "walls"], ["pos", "Position along wall (m)", "number"], ["width", "Width (m)", "number"]],
    window: [["wall", "Wall", "walls"], ["pos", "Position along wall (m)", "number"], ["width", "Width (m)", "number"]],
    sensor: [["kind", "Kind", SENSOR_KINDS], ["x", "X (m)", "number"], ["y", "Y (m)", "number"]],
    ap: [["x", "X (m)", "number"], ["y", "Y (m)", "number"], ["tx_dbm", "Transmit power (dBm)", "number"]]
  };
  var LIST_KEY = { room: "rooms", furniture: "furniture", door: "openings", window: "openings", sensor: "sensors", ap: "aps" };
  var model = null, saved = null, heatLoaded = {}, selected = null, readOnly = !!W.demo;

  function $(id) { return document.getElementById(id); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function option(value, label) { var o = document.createElement("option"); o.value = value; o.textContent = label; return o; }
  function msg(text) { $("dsMsg").textContent = text; }

  function floorById(id) { return model.floors.filter(function (f) { return f.id === id; })[0]; }
  function currentFloor() { return floorById($("dsFloor").value) || model.floors[0]; }

  // ---- floor and view selectors -------------------------------------------
  function fillFloorSelectors() {
    var sel = $("floorSel"), ds = $("dsFloor"), keepSel = sel.value, keepDs = ds.value;
    sel.textContent = ""; ds.textContent = "";
    sel.appendChild(option("all", "All floors (stacked)"));
    model.floors.forEach(function (f) { sel.appendChild(option(f.id, f.name)); ds.appendChild(option(f.id, f.name)); });
    sel.value = keepSel && (keepSel === "all" || floorById(keepSel)) ? keepSel : "all";
    ds.value = keepDs && floorById(keepDs) ? keepDs : model.floors[0].id;
    Room3D.setTwinFloor(sel.value);
  }

  function loadHeat() {
    model.floors.forEach(function (f) {
      if (heatLoaded[f.id]) { return; }
      heatLoaded[f.id] = true;
      W.getJson("/api/rf/coverage?floor=" + encodeURIComponent(f.id)).then(function (grid) {
        Room3D.setHeat(f.id, grid);
      }).catch(function (e) { heatLoaded[f.id] = false; msg("Could not load signal heat: " + e.message); });
    });
  }

  // ---- designer -----------------------------------------------------------
  function itemsOf(floor) {
    var out = [];
    Object.keys(LIST_KEY).forEach(function (type) {
      (floor[LIST_KEY[type]] || []).forEach(function (obj) {
        var t = LIST_KEY[type] === "openings" ? obj.kind : type;
        if (t === type) { out.push({ type: type, obj: obj, list: LIST_KEY[type] }); }
      });
    });
    return out;
  }

  function describe(item) {
    var o = item.obj;
    if (o.wall) { return item.type + " " + o.id + " on " + o.wall; }
    return item.type + " " + o.id + " (" + o.x + ", " + o.y + ")";
  }

  function renderList(keepIndex) {
    var list = $("dsList"), items = itemsOf(currentFloor());
    list.textContent = "";
    items.forEach(function (it, i) { list.appendChild(option(String(i), describe(it))); });
    selected = null;
    if (items.length) { list.value = String(Math.min(keepIndex || 0, items.length - 1)); selected = items[Number(list.value)]; }
    renderFields();
  }

  function renderFields() {
    var box = $("dsFields");
    box.textContent = "";
    if (!selected) { var p = document.createElement("p"); p.className = "muted"; p.textContent = "Select or add an item."; box.appendChild(p); return; }
    FIELDS[selected.type].forEach(function (f) {
      var label = document.createElement("label"), input;
      label.textContent = f[1];
      if (f[2] === "number" || f[2] === "text") {
        input = document.createElement("input"); input.type = f[2];
        if (f[2] === "number") { input.step = "any"; }
      } else {
        input = document.createElement("select");
        var choices = f[2] === "walls" ? currentFloor().walls.map(function (w) { return w.id; }) : f[2];
        choices.forEach(function (c) { input.appendChild(option(c, c)); });
      }
      input.id = "dsf-" + f[0]; input.value = selected.obj[f[0]]; input.disabled = readOnly;
      label.appendChild(input); box.appendChild(label);
    });
  }

  function newId(floor, type) {
    var n = 1, taken = {};
    itemsOf(floor).forEach(function (it) { taken[it.obj.id] = true; });
    while (taken[floor.id + "-" + type + "-" + n]) { n += 1; }
    return floor.id + "-" + type + "-" + n;
  }

  function addItem() {
    var floor = currentFloor(), type = $("dsKind").value, id = newId(floor, type), step = 1;
    var obj;
    if (type === "room") { obj = { id: id, name: "New room", x: step, y: step, w: 2, d: 2 }; }
    else if (type === "furniture") { obj = { id: id, kind: "table", x: step, y: step, w: 1, d: 1 }; }
    else if (type === "sensor") { obj = { id: id, kind: "air", x: step, y: step }; }
    else if (type === "ap") { obj = { id: id, x: step, y: step, tx_dbm: DEFAULT_TX_DBM }; }
    else {
      if (!floor.walls.length) { msg("This floor has no walls to attach a " + type + " to."); return; }
      obj = { id: id, kind: type, wall: floor.walls[0].id, pos: 1, width: type === "door" ? 0.9 : 1.2 };
    }
    floor[LIST_KEY[type]].push(obj);
    renderList(itemsOf(floor).length - 1);
    $("dsList").value = String(itemsOf(floor).length - 1);
    selected = itemsOf(floor).filter(function (it) { return it.obj === obj; })[0];
    $("dsList").value = String(itemsOf(floor).indexOf(selected));
    renderFields(); Room3D.setTwin(model); msg("Added " + id + ". Not saved yet.");
  }

  function applyFields() {
    if (!selected) { return; }
    var next = {};
    for (var i = 0; i < FIELDS[selected.type].length; i++) {
      var f = FIELDS[selected.type][i], raw = $("dsf-" + f[0]).value;
      if (f[2] === "number") {
        var n = parseFloat(raw);
        if (!isFinite(n)) { msg(f[1] + " must be a number."); return; }
        next[f[0]] = n;
      } else { next[f[0]] = raw; }
    }
    Object.keys(next).forEach(function (k) { selected.obj[k] = next[k]; });
    var at = Number($("dsList").value);
    renderList(at); Room3D.setTwin(model); msg("Applied to " + selected.obj.id + ". Not saved yet.");
  }

  function deleteItem() {
    if (!selected) { return; }
    var list = currentFloor()[selected.list], at = list.indexOf(selected.obj), idx = Number($("dsList").value);
    list.splice(at, 1);
    renderList(Math.max(0, idx - 1)); Room3D.setTwin(model); msg("Deleted. Not saved yet.");
  }

  function save() {
    fetch("/api/twin", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(model) })
      .then(function (r) {
        if (!r.ok) { return r.json().then(function (e) { throw new Error(typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail)); }); }
        return r.json();
      }).then(function (twin) {
        adopt(twin && twin.floors ? twin : model);
        heatLoaded = {}; loadHeatIfShown();
        msg("Saved. Coverage will recompute.");
      }).catch(function (e) { msg("Save failed: " + e.message); });
  }

  function loadHeatIfShown() { if ($("heatToggle").checked) { loadHeat(); } }

  function adopt(twin) {
    saved = twin; model = clone(twin);
    Room3D.setTwin(model); fillFloorSelectors(); renderList(0);
  }

  function init() {
    $("viewMode").addEventListener("change", function () { Room3D.setViewMode($("viewMode").value); });
    $("floorSel").addEventListener("change", function () { Room3D.setTwinFloor($("floorSel").value); });
    $("heatToggle").addEventListener("change", function () {
      Room3D.showHeat($("heatToggle").checked); loadHeatIfShown();
    });
    $("dsFloor").addEventListener("change", function () { renderList(0); });
    $("dsList").addEventListener("change", function () { selected = itemsOf(currentFloor())[Number($("dsList").value)] || null; renderFields(); });
    $("dsAdd").addEventListener("click", addItem);
    $("dsApply").addEventListener("click", applyFields);
    $("dsDelete").addEventListener("click", deleteItem);
    $("dsSave").addEventListener("click", save);
    if (readOnly) {
      ["dsAdd", "dsApply", "dsDelete", "dsSave", "dsKind"].forEach(function (id) { $(id).disabled = true; });
      $("dsNotice").textContent = "Read-only in the static demo. Run Wallhack locally to design your own building.";
    } else {
      $("dsNotice").textContent = "Edit rooms, furniture, doors, windows, sensors and access points. Changes preview at once and are saved to a local file only when you press Save twin.";
    }
    W.getJson("/api/twin").then(adopt).catch(function (e) { msg("Could not load the digital twin: " + e.message); });
  }
  init();
  window.TwinUi = { getModel: function () { return model; } };
})();
