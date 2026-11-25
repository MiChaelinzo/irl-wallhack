"""Planner project state (undo/redo, coalescing, validation, persistence) and editor geometry, run in node."""
import json
import shutil
import subprocess

import pytest

from wallhack import twin
from wallhack.app import STATIC

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")

PRELUDE = """
const S = require(process.argv[1] + '/planner-state.js');
const G = require(process.argv[1] + '/planner-editor.js');
const input = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const out = (v) => console.log(JSON.stringify(v));
const wall = (id, x1, y1, x2, y2) => ({ id, x1, y1, x2, y2, kind: 'interior' });
const mk = () => S.validateProject(input.twin);
"""


def run_js(body, payload=None):
    data = dict(payload or {}, twin=twin.sample_twin())
    res = subprocess.run(["node", "-e", PRELUDE + body, str(STATIC)], capture_output=True, text=True, input=json.dumps(data))
    assert res.returncode == 0, res.stderr
    return json.loads(res.stdout)


def test_sample_twin_validates_and_round_trips():
    r = run_js("const p = mk(); out({ids: p.floors.map(f => f.id), v: p.schema_version, again: S.parseProjectJson(S.exportProjectJson(p)).floors[0].walls.length, n: p.floors[0].walls.length})")
    assert r["ids"] == ["ground", "upper"] and r["v"] == 2 and r["again"] == r["n"]


def test_undo_redo_restores_exact_state():
    r = run_js("""
      const store = S.createStore(mk()), before = JSON.stringify(store.project);
      const f = store.floorId;
      store.exec({label: 'add', ops: [S.addOp('wall', store.project, f, wall('w1', 1, 1, 3, 1))]});
      store.exec({label: 'move', ops: [S.setOp('wall', store.project, f, 'w1', {x2: 4})]});
      store.exec({label: 'rm', ops: [S.removeOp('wall', store.project, f, 'g-i1')]});
      const after = JSON.stringify(store.project);
      store.undo(); store.undo(); store.undo();
      const undone = JSON.stringify(store.project), cannotUndo = !store.canUndo();
      store.redo(); store.redo(); store.redo();
      out({same: before === undone, redone: after === JSON.stringify(store.project), cannotUndo, redoEmpty: !store.canRedo()});
    """)
    assert r == {"same": True, "redone": True, "cannotUndo": True, "redoEmpty": True}


def test_removing_a_wall_restores_its_openings_on_undo():
    r = run_js("""
      const store = S.createStore(mk()), f = store.floorId, n = store.project.floors[0].openings.length;
      store.exec({label: 'rm', ops: [S.removeOp('wall', store.project, f, 'g-i1')]});
      const during = store.project.floors[0].openings.length;
      store.undo();
      out({n, during, back: store.project.floors[0].openings.length});
    """)
    assert r["during"] == r["n"] - 1 and r["back"] == r["n"]


def test_drag_entries_with_same_key_coalesce_into_one_undo_step():
    r = run_js("""
      const store = S.createStore(mk()), f = store.floorId;
      const start = store.project.floors[0].walls.find(w => w.id === 'g-i1').x1;
      for (let i = 1; i <= 20; i++) {
        store.exec({label: 'move', key: 'drag:1', ops: [S.setOp('wall', store.project, f, 'g-i1', {x1: start - i * 0.1})]});
      }
      const len = store.historyLength(), moved = store.project.floors[0].walls.find(w => w.id === 'g-i1').x1;
      store.undo();
      out({len, moved, back: store.project.floors[0].walls.find(w => w.id === 'g-i1').x1, start});
    """)
    assert r["len"] == 1 and r["moved"] == pytest.approx(r["start"] - 2.0) and r["back"] == r["start"]


def test_different_keys_do_not_coalesce():
    r = run_js("""
      const store = S.createStore(mk()), f = store.floorId;
      store.exec({label: 'a', key: 'drag:1', ops: [S.setOp('wall', store.project, f, 'g-i1', {y1: 1})]});
      store.exec({label: 'b', key: 'drag:2', ops: [S.setOp('wall', store.project, f, 'g-i1', {y1: 2})]});
      out(store.historyLength());
    """)
    assert r == 2


def test_history_is_capped_at_200():
    r = run_js("""
      const store = S.createStore(mk()), f = store.floorId;
      for (let i = 0; i < 260; i++) { store.exec({label: 'n' + i, ops: [S.addOp('label', store.project, f, {id: 'l' + i, text: 't', x: 1, y: 1})]}); }
      let undone = 0; while (store.undo()) { undone++; }
      out({len: S.HISTORY_CAP, undone, labels: store.project.floors[0].labels.length});
    """)
    assert r == {"len": 200, "undone": 200, "labels": 60}


def test_new_edit_clears_redo_and_noop_edits_are_ignored():
    r = run_js("""
      const store = S.createStore(mk()), f = store.floorId;
      store.exec({label: 'a', ops: [S.setOp('wall', store.project, f, 'g-i1', {y1: 1})]});
      store.undo();
      const had = store.canRedo();
      const noop = store.exec({label: 'same', ops: [S.setOp('wall', store.project, f, 'g-i1', {y1: store.project.floors[0].walls.find(w => w.id === 'g-i1').y1})]});
      store.exec({label: 'b', ops: [S.setOp('wall', store.project, f, 'g-i1', {y1: 2})]});
      out({had, noop, redo: store.canRedo()});
    """)
    assert r == {"had": True, "noop": False, "redo": False}


def test_dirty_tracking_follows_history_position():
    r = run_js("""
      const store = S.createStore(mk()), f = store.floorId, seen = [];
      seen.push(store.isDirty());
      store.exec({label: 'a', ops: [S.setOp('wall', store.project, f, 'g-i1', {y1: 1})]});
      seen.push(store.isDirty());
      store.markSaved(); seen.push(store.isDirty());
      store.undo(); seen.push(store.isDirty());
      store.redo(); seen.push(store.isDirty());
      out(seen);
    """)
    assert r == [False, True, False, True, False]


def test_subscribers_get_the_applied_operations():
    r = run_js("""
      const store = S.createStore(mk()), f = store.floorId, events = [];
      store.subscribe(e => events.push([e.source, e.ops.map(o => o.t)]));
      store.exec({label: 'a', ops: [S.addOp('ap', store.project, f, {id: 'n', x: 1, y: 1, tx_dbm: 20})]});
      store.undo();
      out(events);
    """)
    assert r == [["exec", ["ap.add"]], ["undo", ["ap.remove"]]]


def test_selection_drops_deleted_items():
    r = run_js("""
      const store = S.createStore(mk()), f = store.floorId;
      store.select({walls: ['g-i1', 'g-i2']});
      store.exec({label: 'rm', ops: [S.removeOp('wall', store.project, f, 'g-i1')]});
      out(store.selection.walls);
    """)
    assert r == ["g-i2"]


@pytest.mark.parametrize("mutate,message", [
    ("d.floors = []", "floors: must be a list of 1 to 6"),
    ("d.schema_version = 99", "schema_version"),
    ("d.floors[0].walls[0].x1 = 'a'", "floors[0].walls[0].x1: must be a finite number"),
    ("d.floors[0].walls[0].x1 = 999", "floors[0].walls[0].x1: must be between"),
    ("d.floors[0].walls[0].x2 = d.floors[0].walls[0].x1; d.floors[0].walls[0].y2 = d.floors[0].walls[0].y1", "zero length"),
    ("d.floors[0].walls[1].id = d.floors[0].walls[0].id", "duplicate id"),
    ("d.floors[0].openings[0].wall = 'nope'", "unknown wall id"),
    ("d.floors[0].aps[0].tx_dbm = 99", "tx_dbm"),
    ("d.floors[0].background = 'http://evil.example/x.png'", "data URL"),
    ("d.floors[0].walls[0].material = 'unobtainium'", "not a known material"),
    ("d.floors[1].level = 0", "floors.level"),
])
def test_import_validation_names_the_bad_field(mutate, message):
    body = """
      const d = JSON.parse(JSON.stringify(input.twin));
      %s;
      try { S.validateProject(d, {materialIds: ['drywall', 'brick']}); out('accepted'); } catch (e) { out(e.name + ': ' + e.message); }
    """ % mutate
    r = run_js(body)
    assert r.startswith("ProjectError") and message in r, r


def test_invalid_json_text_is_reported():
    assert "not valid JSON" in run_js("try { S.parseProjectJson('{oops'); } catch (e) { out(e.message); }")


def test_save_reports_quota_errors_and_load_reports_corrupt_saves():
    r = run_js("""
      const quota = { setItem() { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; } };
      const saved = S.saveProject(quota, mk());
      const mem = {}; const storage = { setItem: (k, v) => { mem[k] = v; }, getItem: k => (k in mem ? mem[k] : null) };
      const ok = S.saveProject(storage, mk()), loaded = S.loadSavedProject(storage);
      mem[S.STORAGE_KEY] = '{"floors": []}';
      out({quota: saved.quota, ok: saved.ok, okSave: ok.ok, name: loaded.project.name, corrupt: S.loadSavedProject(storage).error});
    """)
    assert r["quota"] is True and r["ok"] is False and r["okSave"] is True and r["name"] == "Sample house"
    assert "Saved project ignored" in r["corrupt"]


# ---------------------------------------------------------------- editor geometry
def test_snap_to_grid_and_endpoints():
    r = run_js("""
      out([G.snapPoint({x: 1.26, y: 2.74}, {grid: true, step: 0.25}),
           G.snapPoint({x: 1.26, y: 2.74}, {grid: false, step: 0.25}),
           G.snapPoint({x: 3.05, y: 1.02}, {grid: true, step: 0.5, endpoints: [{x: 3.1, y: 1.0}], endpointRadius: 0.2}),
           G.snapPoint({x: 3.5, y: 1.0}, {grid: true, step: 1, endpoints: [{x: 3.1, y: 1.0}], endpointRadius: 0.2}),
           G.snapValue(0.34, 0.1)]);
    """)
    assert r[0] == {"x": 1.25, "y": 2.75, "snapped": "grid"}
    assert r[1] == {"x": 1.26, "y": 2.74, "snapped": None}
    assert r[2] == {"x": 3.1, "y": 1.0, "snapped": "endpoint"}
    assert r[3]["snapped"] == "grid" and r[3]["x"] in (3.0, 4.0)
    assert r[4] == pytest.approx(0.3)


def test_rotation_keeps_midpoint_and_length_and_snaps_to_15_degrees():
    r = run_js("""
      const w = {x1: 2, y1: 2, x2: 6, y2: 2}, q = G.rotateWall(w, 90), z = G.rotateWallBy(w, 180);
      out({q, z, angle: G.angleDeg(q), snapped: [G.snapAngle(37, 15, false), G.snapAngle(37, 15, true), G.snapAngle(-52, 15, false)]});
    """)
    assert r["q"] == {"x1": 4.0, "y1": 0.0, "x2": 4.0, "y2": 4.0}
    assert r["z"] == {"x1": 6.0, "y1": 2.0, "x2": 2.0, "y2": 2.0}
    assert r["angle"] == pytest.approx(90.0) and r["snapped"] == [30, 37, -45]


def test_hit_test_prefers_handles_then_aps_then_walls():
    r = run_js("""
      const f = {walls: [wall('a', 0, 0, 4, 0), wall('b', 0, 2, 4, 2)], aps: [{id: 'ap1', x: 2, y: 0.05, tx_dbm: 20}], labels: [{id: 'l1', text: 'x', x: 1, y: 3}]};
      const sel = {walls: ['a']}, tol = 0.2;
      const h = G.wallHandles(f.walls[0], 0.6);
      out([G.hitTest(f, sel, {x: 0.05, y: 0.02}, tol, 0.6), G.hitTest(f, sel, h.rot, tol, 0.6), G.hitTest(f, sel, {x: 2, y: 0.05}, tol, 0.6),
           G.hitTest(f, {walls: []}, {x: 2, y: 0.05}, tol, 0.6), G.hitTest(f, {walls: []}, {x: 3, y: 2.1}, tol), G.hitTest(f, {walls: []}, {x: 1.1, y: 3.05}, tol),
           G.hitTest(f, {walls: []}, {x: 9, y: 9}, tol)]);
    """)
    assert r[0] == {"type": "handle", "id": "a", "handle": "p1"}
    assert r[1] == {"type": "handle", "id": "a", "handle": "rot"}
    assert r[2] == {"type": "handle", "id": "a", "handle": "mid"}
    assert r[3] == {"type": "ap", "id": "ap1"}
    assert r[4] == {"type": "wall", "id": "b"} and r[5] == {"type": "label", "id": "l1"} and r[6] is None


def test_box_selection_calibration_and_image_fit():
    r = run_js("""
      const f = {walls: [wall('a', 0, 0, 1, 0), wall('b', 5, 5, 6, 5), wall('c', 0.5, 4, 5.5, 4)]};
      out({box: G.wallsInBox(f, {x0: -1, y0: -1, x1: 2, y1: 1}), scale: G.calibratedScale(0.02, {x: 0, y: 0}, {x: 100, y: 0}, 4),
           small: G.fitWithin(800, 600, 2048), big: G.fitWithin(4096, 2048, 2048), bad: (() => { try { G.calibratedScale(1, {x: 1, y: 1}, {x: 1, y: 1}, 3); } catch (e) { return e.message; } })()});
    """)
    assert r["box"] == ["a"] and r["scale"] == pytest.approx(0.0008)
    assert r["small"] == {"w": 800, "h": 600} and r["big"] == {"w": 2048, "h": 1024} and "two different points" in r["bad"]


# ---------------------------------------------------------------- import validation parity with twin.py
def _rejects(mutate, message):
    body = """
      const d = JSON.parse(JSON.stringify(input.twin));
      %s;
      try { S.validateProject(d); out('accepted'); } catch (e) { out(e.name + ': ' + e.message); }
    """ % mutate
    r = run_js(body)
    assert r.startswith("ProjectError") and message in r, r


@pytest.mark.parametrize("mutate,message", [
    ("d.materials = {x: {label: 'X', attenuation_db: {'2.4': 3}, reflection_loss_db: {'2.4': 3, '5': 3, '6': 3}}}", "materials.x.attenuation_db"),
    ("d.materials = {x: {label: 'X', attenuation_db: {'2.4': 3, '5': 3, '6': 999}, reflection_loss_db: {'2.4': 3, '5': 3, '6': 3}}}", "must be between"),
    ("d.materials = {x: {label: '', attenuation_db: {'2.4': 3, '5': 3, '6': 3}, reflection_loss_db: {'2.4': 3, '5': 3, '6': 3}}}", "materials.x.label"),
    ("d.materials = {x: 5}", "materials.x"),
    ("d.materials = Object.fromEntries(Array.from({length: 21}, (_, i) => ['m' + i, 1]))", "at most 20"),
    ("d.floors[0].rooms[0].w = 'wide'", "rooms[0].w"),
    ("delete d.floors[0].rooms[0].x", "rooms[0].x"),
    ("d.floors[0].rooms[0].w = 99", "outside the floor"),
    ("d.floors[0].rooms[0].name = 'n'.repeat(500)", "rooms[0].name"),
    ("d.floors[0].furniture[0].kind = 'piano'", "furniture[0].kind"),
    ("d.floors[0].furniture[0].w = null", "furniture[0].w"),
    ("d.floors[0].sensors[0].x = 'a'", "sensors[0].x"),
    ("d.floors[0].sensors[0].kind = 'laser'", "sensors[0].kind"),
    ("d.floors[0].aps[0].channel = 149", "aps[0].channel"),
    ("d.floors[0].aps[0].band = '5'; d.floors[0].aps[0].channel = 6", "aps[0].channel"),
    ("d.floors[0].labels = Array.from({length: 201}, (_, i) => ({id: 'l' + i, text: 't', x: 1, y: 1}))", "at most 200"),
    ("d.floors[0].furniture = Array.from({length: 201}, (_, i) => ({id: 'f' + i, kind: 'sofa', x: 1, y: 1, w: 1, d: 1}))", "at most 200"),
    ("d.floors[0].background = 'data:image/png;base64,' + 'A'.repeat(600001)", "at most 600000"),
    ("d.floors[0].openings[0].pos = 50", "pos"),
    ("d.floors[0].openings[0].width = 50", "extends past"),
])
def test_import_validation_matches_twin_limits(mutate, message):
    _rejects(mutate, message)


def test_every_js_rejection_is_also_a_python_rejection():
    """Anything the planner refuses for these fields must also fail twin.validate_twin, so the two stay aligned."""
    for mutate in ("d.floors[0].aps[0].channel = 149", "d.floors[0].rooms[0].w = 99", "d.floors[0].furniture[0].kind = 'piano'"):
        d = twin.sample_twin()
        exec(mutate.replace("d.floors[0].aps[0].channel = 149", "d['floors'][0]['aps'][0]['channel'] = 149")
                   .replace("d.floors[0].rooms[0].w = 99", "d['floors'][0]['rooms'][0]['w'] = 99")
                   .replace("d.floors[0].furniture[0].kind = 'piano'", "d['floors'][0]['furniture'][0]['kind'] = 'piano'"), {"d": d})
        with pytest.raises(twin.TwinError):
            twin.validate_twin(d)


def test_limits_come_from_the_shared_config():
    from wallhack import rfmodel
    r = run_js("out(require(process.argv[1] + '/rf-config.json').limits)")
    assert r == rfmodel.LIMITS
    assert twin.MAX_ITEMS_PER_LIST == r["max_items_per_list"] and twin.MAX_BACKGROUND_CHARS == r["max_background_chars"]


def test_custom_materials_round_trip_and_valid_channels_pass():
    r = run_js("""
      const d = JSON.parse(JSON.stringify(input.twin));
      d.materials = {foam: {label: 'Foam', attenuation_db: {'2.4': 1, '5': 2, '6': 3}, reflection_loss_db: {'2.4': 4, '5': 5, '6': 6}}};
      d.floors[0].walls[0].material = 'foam';
      d.floors[0].aps[0].band = '5'; d.floors[0].aps[0].channel = 36;
      const p = S.validateProject(d, {materialIds: ['drywall']});
      out({foam: p.materials.foam, ch: p.floors[0].aps[0].channel});
    """)
    assert r["ch"] == 36 and r["foam"]["attenuation_db"] == {"2.4": 1, "5": 2, "6": 3}


@pytest.mark.parametrize("name", ["constructor", "toString", "__proto__", "hasOwnProperty"])
def test_prototype_names_are_ordinary_ids(name):
    r = run_js("""
      const d = JSON.parse(JSON.stringify(input.twin));
      const n = input.name;
      const old = d.floors[0].walls[0].id;
      d.floors[0].walls[0].id = n; d.floors[0].openings.forEach(o => { if (o.wall === old) { o.wall = n; } });
      d.floors[0].aps[0].id = n;
      d.capacity = JSON.parse('{"' + n + '": {"users": 3, "profile": "p"}}');
      d.materials = JSON.parse('{"' + n + '": {"label": "L", "attenuation_db": {"2.4": 1, "5": 1, "6": 1}, "reflection_loss_db": {"2.4": 1, "5": 1, "6": 1}}}');
      const p = S.validateProject(d);
      let dup = 'accepted';
      d.floors[0].walls[1].id = n;
      try { S.validateProject(d); } catch (e) { dup = e.message; }
      out({wall: p.floors[0].walls[0].id, ap: p.floors[0].aps[0].id, cap: Object.keys(p.capacity), mat: Object.keys(p.materials), proto: Object.getPrototypeOf(p.floors[0]) === Object.prototype, dup});
    """, {"name": name})
    assert r["wall"] == name and r["ap"] == name and r["cap"] == [name] and r["mat"] == [name] and r["proto"]
    assert "duplicate id" in r["dup"]


def test_dirty_flag_survives_meta_changes_and_returns_to_clean_on_undo():
    r = run_js("""
      const store = S.createStore(mk()), f = store.floorId;
      const states = [store.isDirty()];
      store.exec({label: 'a', ops: [S.addOp('wall', store.project, f, wall('w1', 1, 1, 3, 1))]});
      states.push(store.isDirty());
      store.markSaved(); states.push(store.isDirty());
      store.setMeta('capacity', {}); states.push(store.isDirty());       // meta change: dirty
      store.markSaved(); states.push(store.isDirty());                   // saved again: clean
      store.undo(); states.push(store.isDirty());                        // before the saved state: dirty
      store.redo(); states.push(store.isDirty());                        // back at the saved state: clean again
      out(states);
    """)
    assert r == [False, True, False, True, False, True, False]


def _big_twin(n_walls, n_openings=None):
    """A valid twin with n_walls walls (and as many openings, one per wall) on a 200 x 200 m floor."""
    d = twin.sample_twin()
    f = d["floors"][0]
    f["width_m"] = f["depth_m"] = 200
    f["walls"] = [{"id": f"w{i}", "x1": 1.2345 + (i % 100) * 1.5, "y1": 1.2345 + (i // 100) * 3.25,
                   "x2": 2.5678 + (i % 100) * 1.5, "y2": 1.2345 + (i // 100) * 3.25, "kind": "interior"} for i in range(n_walls)]
    n_openings = n_walls if n_openings is None else n_openings
    f["openings"] = [{"id": f"o{i}", "kind": "door", "wall": f"w{i}", "pos": 0.2, "width": 0.9} for i in range(n_openings)]
    return d


@pytest.mark.parametrize("n", [1000, 5000])
def test_large_projects_validate_in_python_and_js(n):
    d = _big_twin(n)
    assert len(twin.validate_twin(d)["floors"][0]["walls"]) == n
    r = run_js("const p = S.validateProject(input.big); out([p.floors[0].walls.length, p.floors[0].openings.length]);", {"big": d})
    assert r == [n, n]


def test_walls_over_the_limit_get_a_clear_error_in_both():
    from wallhack import rfmodel
    limit = rfmodel.LIMITS["max_walls_per_floor"]
    assert limit >= 5000 and rfmodel.LIMITS["max_openings_per_floor"] >= 5000
    d = _big_twin(limit + 1, 0)
    with pytest.raises(twin.TwinError, match=rf"floors\[0\]\.walls: must be a list of at most {limit} items"):
        twin.validate_twin(d)
    r = run_js("try { S.validateProject(input.big); out('accepted'); } catch (e) { out(e.message); }", {"big": d})
    assert f"floors[0].walls: at most {limit} items, got {limit + 1}" in r


def test_other_lists_keep_the_small_limit():
    d = twin.sample_twin()
    d["floors"][0]["sensors"] = [{"id": f"s{i}", "kind": "air", "x": 1, "y": 1} for i in range(201)]
    with pytest.raises(twin.TwinError, match="sensors: must be a list of at most 200 items"):
        twin.validate_twin(d)


def test_label_made_with_editor_functions_survives_save_and_reload():
    """A 70 character label is clipped to the shared limit at input time, so the saved project reloads."""
    r = run_js("""
      const store = S.createStore(mk()), f = store.floorId, max = S.textLimit({});
      const clip = S.clipText('L'.repeat(70), max);
      store.exec({label: 'Add label', ops: [S.addOp('label', store.project, f, {id: 'l1', text: clip.text, x: 1, y: 1})]});
      const mem = {d: {}, setItem(k, v) { this.d[k] = v; }, getItem(k) { return this.d[k] === undefined ? null : this.d[k]; }};
      const saved = S.saveProject(mem, store.project), loaded = S.loadSavedProject(mem);
      out({max, clipped: clip.clipped, ok: saved.ok, error: loaded.error || null, len: loaded.project && loaded.project.floors[0].labels[0].text.length});
    """)
    assert r == {"max": 64, "clipped": True, "ok": True, "error": None, "len": 64}


def test_scenario_helpers_clip_names_to_the_shared_limit():
    r = run_js("""
      const p = mk(), max = S.textLimit({});
      const sc = S.makeScenario(p, 'N'.repeat(80), null, 'now', max);
      const list = S.renameScenario([sc], sc.id, 'R'.repeat(80), max);
      const dup = S.duplicateScenario([sc], sc.id, 'now', max);
      p.scenarios = dup;
      out({a: sc.name.length, b: list[0].name.length, c: dup[1].name.length, reloads: S.parseProjectJson(S.exportProjectJson(p)).scenarios.length});
    """)
    assert r == {"a": 64, "b": 64, "c": 64, "reloads": 2}


def test_legacy_long_names_are_truncated_on_import_not_rejected():
    r = run_js("""
      const d = JSON.parse(JSON.stringify(input.twin)), long = 'x'.repeat(80);
      d.floors[0].labels = [{id: 'l1', text: long, x: 1, y: 1}];
      d.floors[0].aps[0].name = long; d.floors[0].walls[0].name = long;
      d.scenarios = [{id: 's1', name: long, floors: d.floors}];
      const p = S.validateProject(d);
      out([p.floors[0].labels[0].text, p.floors[0].aps[0].name, p.floors[0].walls[0].name, p.scenarios[0].name].map(s => s.length));
    """)
    assert r == [64] * 4


def test_ids_are_still_rejected_when_too_long():
    _rejects("d.floors[0].walls[0].id = 'i'.repeat(65)", "walls[0].id")


def test_unknown_band_is_a_project_error_without_band_list():
    r = run_js("""
      const d = JSON.parse(JSON.stringify(input.twin));
      d.floors[0].aps[0].band = '60'; d.floors[0].aps[0].channel = 1;
      try { S.validateProject(d, {}); out({err: null}); } catch (e) { out({err: e.name, msg: e.message}); }
    """)
    assert r["err"] == "ProjectError" and "aps[0].band: must be one of" in r["msg"]


def test_validator_has_no_module_level_text_limit():
    """The limit is passed explicitly, so a different limits block in one call never leaks into the next."""
    r = run_js("""
      const cfg = JSON.parse(JSON.stringify(require(process.argv[1] + '/rf-config.json')));
      cfg.limits.max_text_chars = 5;
      const d = {name: 'T', floors: [{id: 'f1', name: 'Floor', level: 0, width_m: 10, depth_m: 10, labels: [{id: 'l1', text: 'abcdefgh', x: 1, y: 1}]}]};
      const small = S.validateProject(d, {config: cfg}).floors[0].labels[0].text;
      const normal = S.validateProject(d, {}).floors[0].labels[0].text;
      out({small, normal});
    """)
    assert r == {"small": "abcde", "normal": "abcdefgh"}


def test_unknown_band_is_rejected_without_a_band_list():
    _rejects("d.floors[0].aps[0].band = '60'", "aps[0].band")


@pytest.mark.parametrize("name", ["", "   ", "\\t\\n"])
def test_blank_project_name_loads_as_default_in_js_and_python(name):
    r = run_js("""
      const d = JSON.parse(JSON.stringify(input.twin));
      d.name = '%s';
      out(S.validateProject(d).name);
    """ % name)
    assert r == "Untitled"
    d = twin.sample_twin()
    d["name"] = name.encode().decode("unicode_escape")
    assert twin.validate_twin(d)["name"] == "Untitled"
