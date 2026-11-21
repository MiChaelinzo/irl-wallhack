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
