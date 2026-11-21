"""Scenarios, exports (CSV, PDF, registry), recommendation operations and the bonus mode calculations (pytest spawns node)."""
import json
import re
import shutil
import subprocess

import pytest

from wallhack import rfmodel
from wallhack.app import STATIC

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")

PRELUDE = """
const D = process.argv[1];
const S = require(D + '/planner-state.js'), E = require(D + '/rf-engine.js'), X = require(D + '/planner-export.js'),
      M = require(D + '/planner-modes.js'), PP = require(D + '/planner-panels.js');
const P = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const config = P.config, env = E.makeEnv(config);
const out = (v) => console.log(JSON.stringify(v));
const floor = (id, level, w, d, aps, extra) => Object.assign({id, name: id, level, width_m: w, depth_m: d, aps}, extra || {});
const ap = (id, x, y, tx, extra) => Object.assign({id, x, y, tx_dbm: tx === undefined ? 20 : tx}, extra || {});
const proj = (floors) => S.validateProject({name: 'T', floors});
"""


def run_js(body, payload=None):
    data = dict(payload or {}, config=rfmodel.CONFIG)
    res = subprocess.run(["node", "-e", PRELUDE + body, str(STATIC)], capture_output=True, text=True, input=json.dumps(data))
    assert res.returncode == 0, res.stderr
    return json.loads(res.stdout)


def test_scenario_save_load_round_trip_and_compare():
    r = run_js("""
      const p = proj([floor('g', 0, 20, 10, [ap('a', 2, 5, 10)], {walls: [{id: 'w', x1: 10, y1: 0, x2: 10, y2: 10, kind: 'exterior'}]})]);
      const sc = S.makeScenario(p, 'Before', {mode: 'basic', band: null}, '2025-01-01T00:00:00Z', 64);
      p.scenarios = [sc];
      const added = S.clone(p); added.floors[0].aps.push(ap('b', 15, 5, 10));
      p.scenarios = S.duplicateScenario(p.scenarios, 's1', 'now', 64);
      p.scenarios = S.renameScenario(p.scenarios, 's2', 'Copy renamed', 64);
      const text = S.exportProjectJson(p), back = S.parseProjectJson(text);
      const before = S.computeProject(S.scenarioProject(back, back.scenarios[0]));
      const cmp = E.compareScenarios(before, S.computeProject(added), {env, floorId: 'g', cellM: 1});
      out({names: back.scenarios.map(s => s.name), ids: back.scenarios.map(s => s.id), same: JSON.stringify(back.scenarios) === JSON.stringify(p.scenarios),
           deleted: S.deleteScenario(back.scenarios, 's1').map(s => s.id), scoreDelta: cmp.score_delta, covDelta: cmp.coverage_delta_pct, apDelta: cmp.ap_count_delta,
           hasBg: 'background' in back.scenarios[0].floors[0], deltaCells: cmp.delta_db.length * cmp.delta_db[0].length,
           rows: PP.diffRows(cmp).map(r => r[0])})""")
    assert r["names"] == ["Before", "Copy renamed"] and r["ids"] == ["s1", "s2"] and r["same"]
    assert r["deleted"] == ["s2"] and r["apDelta"] == 1 and r["covDelta"] > 0 and r["scoreDelta"] != 0
    assert r["deltaCells"] == 200 and "Optimisation score" in r["rows"] and not r["hasBg"]


def test_old_schema_loads_and_new_fields_validate():
    r = run_js("""
      const v1 = S.validateProject({schema_version: 1, name: 'old', floors: [floor('g', 0, 10, 10, [ap('a', 1, 1)])]});
      const errs = [];
      const bad = (label, f) => { try { f(); errs.push(label + ': accepted'); } catch (e) { errs.push(e.message); } };
      bad('loop', () => proj([floor('g', 0, 10, 10, [ap('a', 1, 1, 20, {mesh_parent: 'b'}), ap('b', 2, 2, 20, {mesh_parent: 'a'})])]));
      bad('missing', () => proj([floor('g', 0, 10, 10, [ap('a', 1, 1, 20, {mesh_parent: 'zz'})])]));
      bad('note', () => proj([floor('g', 0, 10, 10, [], {annotations: [{id: 'n', kind: 'text', x: 1, y: 1}]})]));
      bad('device', () => S.validateProject({name: 'x', floors: [floor('g', 0, 10, 10, [], {devices: [{id: 'd', cls: 'toaster', x: 1, y: 1}]})]}, {deviceClasses: ['sensor']}));
      bad('capacity', () => S.validateCapacity({'g/r': {users: 1.5, profile: 'x'}}, 64));
      out({v: v1.schema_version, notes: v1.floors[0].annotations, devices: v1.floors[0].devices, errs});""")
    assert r["v"] == 2 and r["notes"] == [] and r["devices"] == []
    assert "loops back" in r["errs"][0] and "not an access point" in r["errs"][1] and "text" in r["errs"][2] and "one of sensor" in r["errs"][3] and "whole number" in r["errs"][4]


def test_floors_and_notes_are_undoable():
    r = run_js("""
      const store = S.createStore(proj([floor('g', 0, 10, 10, [])])), before = JSON.stringify(store.project);
      const nf = S.newFloor(store.project);
      store.exec({label: 'floor', ops: [S.addFloorOp(store.project, nf)]});
      store.setFloor(nf.id);
      store.exec({label: 'note', ops: [S.addOp('annotation', store.project, nf.id, {id: 'n1', kind: 'pin', x: 1, y: 1})]});
      const mid = store.project.floors.length;
      store.undo(); store.undo();
      const afterUndo = JSON.stringify(store.project), floorId = store.floorId;
      store.redo(); store.redo();
      out({mid, level: nf.level, id: nf.id, same: afterUndo === before, floorId, redone: store.project.floors[1].annotations.length});""")
    assert r["mid"] == 2 and r["level"] == 1 and r["id"] == "f1" and r["same"] and r["floorId"] == "g" and r["redone"] == 1


def test_csv_escaping_and_formula_injection():
    r = run_js("""
      const cells = ['=1+1', '+SUM(A1)', '-2+3', '@cmd', 'plain', 'a,b', 'say "hi"', 'two\\nlines', '\\t=x', null, -72.5, 3];
      out({cells: cells.map(X.csvCell), row: X.toCsv([['a', '=HYPERLINK("x")', -5]]),
           an: X.analyticsRows({cell_m: 1, coverage_pct: 90, avg_rssi_dbm: -60, weak_area_m2: 1, dead_zone_area_m2: 0, dead_zones: [], overlap: {pct: 1}, roaming: {pct: 2},
             mean_throughput_mbps: 100, total_client_capacity: 9, quality_pct: {good: 100}, aps: [{id: '=evil', band: '5', channel: 36, width_mhz: 80, served_area_m2: 1, usable_mbps: 1,
             client_capacity: 1, expected_clients: 1, channel_utilisation_pct: 1, cochannel_neighbours: ['a', 'b']}]}, {project: '+proj', floor: '@f'}).map(r => r.map(X.csvCell).join(','))});""")
    assert r["cells"] == ["'=1+1", "'+SUM(A1)", "'-2+3", "'@cmd", "plain", '"a,b"', '"say ""hi"""', '"two\nlines"', "'\t=x", "", "-72.5", "3"]
    assert r["row"] == "a,\"'=HYPERLINK(\"\"x\"\")\",-5\r\n"
    joined = "\n".join(r["an"])
    assert "'=evil" in joined and "'+proj" in joined and "'@f" in joined and "MODEL ESTIMATE" in joined and "(ESTIMATE" in joined


def pdf_problems(data: bytes):
    """Structural PDF check without third-party libraries: header, xref offsets, stream lengths, trailer and EOF."""
    problems = []
    if not data.startswith(b"%PDF-1.4\n"):
        problems.append("header")
    if not data.rstrip().endswith(b"%%EOF"):
        problems.append("eof")
    m = re.search(rb"startxref\n(\d+)\n%%EOF", data)
    if not m:
        return problems + ["startxref"]
    xref = int(m.group(1))
    if data[xref:xref + 5] != b"xref\n":
        return problems + ["xref offset"]
    head = re.match(rb"xref\n0 (\d+)\n", data[xref:])
    n = int(head.group(1))
    entries = re.findall(rb"(\d{10}) (\d{5}) ([nf]) \n", data[xref:xref + 20 * n + 40])
    if len(entries) != n or entries[0][2] != b"f":
        problems.append("xref entries")
    for i, (off, _, kind) in enumerate(entries[1:], start=1):
        if data[int(off):int(off) + len(b"%d 0 obj" % i)] != b"%d 0 obj" % i:
            problems.append("object %d offset" % i)
    for sm in re.finditer(rb"/Length (\d+) >>\nstream\n", data):
        start = sm.end()
        if data[start + int(sm.group(1)):start + int(sm.group(1)) + 10] != b"\nendstream":
            problems.append("stream length at %d" % start)
    if b"/Size %d" % n not in data:
        problems.append("trailer size")
    return problems


def test_pdf_structure_with_jpeg_and_text_escaping():
    r = run_js("""
      const jpeg = new Uint8Array(300).map((_, i) => (i * 7) & 255); jpeg[0] = 0xff; jpeg[1] = 0xd8;
      const long = 'word '.repeat(400);
      const bytes = X.buildReport({title: 'Report (draft) \\\\ with \\u2019 quote \\u4e2d', project: 'P', floor: 'F', date: '2025-01-01',
        summary: [['Metric', 'Value'], ['Coverage', '90 %']], aps: [['AP', 'Band'], ['ap1', '5 GHz']], issues: [long], recommendations: ['Add an AP'], image: {bytes: jpeg, w: 40, h: 30}});
      out({bytes: Array.from(bytes), jpegAt: Array.from(jpeg).slice(0, 4)});""")
    data = bytes(r["bytes"])
    assert pdf_problems(data) == []
    assert b"/Filter /DCTDecode" in data and b"/Width 40 /Height 30" in data and b"/BaseFont /Helvetica " in data
    assert data.count(b"/Type /Page ") >= 2   # the long issue text flows onto a second page
    assert b"Report \\(draft\\) \\\\ with ' quote ?" in data and b"MODEL ESTIMATE, not a measurement" in data
    jpeg = bytes([0xff, 0xd8]) + bytes((i * 7) & 255 for i in range(2, 300))
    assert jpeg in data   # the image stream is embedded unchanged


def test_exporter_registry_and_builtins():
    r = run_js("""
      const ids = X.list().map(x => x.id);
      let err = null; try { X.register('bad', {label: 'x'}); } catch (e) { err = e.message; }
      X.register('custom', {label: 'Custom', run: () => ({name: 'a.txt', mime: 'text/plain', data: 'hi'})});
      out({ids, err, custom: X.get('custom').run({}).data, after: X.list().map(x => x.id)});""")
    assert r["ids"] == ["png", "csv", "json", "pdf", "print"] and "needs a label" in r["err"] and r["custom"] == "hi" and r["after"][-1] == "custom"


def test_recommendation_operations_are_distinct_and_undoable():
    r = run_js("""
      const p = proj([floor('g', 0, 20, 10, [ap('ap1', 2, 5, 10)]), floor('u', 1, 20, 10, [ap('ap2', 2, 5, 12)])]);
      const store = S.createStore(p), before = JSON.stringify(p);
      const plan = {placements: {recommendations: [{x: 15, y: 5, tx_dbm: 20, band: '2.4', text: 't1', reason: 'r', confidence: 0.8}, {x: 5, y: 8, tx_dbm: 20, band: '2.4', text: 't2', reason: 'r', confidence: 0.6}]},
        power: {overpowered: [{kind: 'overpowered', ap_id: 'ap2', to_tx_dbm: 9, text: 'p', reason: 'r', confidence: 0.5}], underpowered: []},
        channels: {conflicts_before: 1, conflicts_after: 0, assignments: [{ap_id: 'ap1', band: '2.4', from_channel: 6, to_channel: 1, changed: true}, {ap_id: 'ap2', band: '2.4', from_channel: 6, to_channel: 6, changed: false}]}};
      const recs = PP.buildRecommendations(plan), added = [];
      let ops = []; recs.forEach(r => { ops = ops.concat(PP.recommendationOps(S, store.project, 'g', r, added)); });
      store.exec({label: 'all', ops});
      const g = store.project.floors[0].aps.map(a => a.id + ':' + a.tx_dbm + ':' + (a.channel || '')), u = store.project.floors[1].aps.map(a => a.id + ':' + a.tx_dbm);
      store.undo();
      out({kinds: recs.map(r => r.kind), conf: recs.map(r => r.confidence), g, u, restored: JSON.stringify(store.project) === before, ghosts: recs.map(r => !!r.ghost)});""")
    assert r["kinds"] == ["add_ap", "add_ap", "overpowered", "channel"] and r["conf"] == [0.8, 0.6, 0.5, None]
    assert r["g"] == ["ap1:10:1", "ap3:20:", "ap4:20:"] and r["u"] == ["ap2:9"] and r["restored"] and r["ghosts"] == [True, True, False, False]


def test_mesh_report_hand_checked():
    r = run_js("""
      const p = proj([floor('g', 0, 30, 10, [ap('root', 2, 5, 20), ap('m1', 12, 5, 20, {mesh_parent: 'root'}), ap('m2', 22, 5, 20, {mesh_parent: 'm1'})])]);
      const rows = M.meshReport(p, config, {env, usable: {m1: 1000, m2: 1000}});
      const only = (id) => ({name: 'x', floors: [Object.assign({}, p.floors[0], {aps: p.floors[0].aps.filter(a => a.id === id)})]});
      const l1 = E.probeAt(only('root'), 'g', 12, 5, {env}), l2 = E.probeAt(only('m1'), 'g', 22, 5, {env});
      out({rows, l1: [l1.rssi_dbm, l1.throughput_mbps], l2: [l2.rssi_dbm, l2.throughput_mbps], loopA: M.wouldLoop(p, 'root', 'm2'), loopB: M.wouldLoop(p, 'm2', 'root')});""")
    m1, m2 = r["rows"]
    assert m1["id"] == "m1" and m1["hops"] == 1 and m1["backhaul_rssi_dbm"] == r["l1"][0]
    assert m1["e2e_mbps"] == pytest.approx(r["l1"][1] * 0.5, abs=0.06)
    assert m2["hops"] == 2 and m2["e2e_mbps"] == pytest.approx(min(r["l1"][1], r["l2"][1]) * 0.25, abs=0.06)
    assert "clients limited by backhaul" in m1["notes"] and r["loopA"] and not r["loopB"]


def test_capacity_report_hand_checked():
    r = run_js("""
      const p = proj([floor('g', 0, 10, 10, [], {rooms: [{id: 'a', name: 'A', x: 0, y: 0, w: 5, d: 10}, {id: 'b', name: 'B', x: 5, y: 0, w: 5, d: 10}]})]);
      p.capacity = {'g/a': {users: 10, profile: 'office'}, 'g/b': {users: 2, profile: 'heavy'}};
      const an = {cols: 2, rows: 1, cell_m: 5, best_ap: [[0, -1]], aps: [{id: 'ap1', usable_mbps: 25}]};
      out(M.capacityReport(p, 'g', an, config));""")
    assert r["zones"][0] == {"room": "A", "users": 10, "profile": "office", "demand_mbps": 30.0, "ap_id": "ap1"}
    assert r["zones"][1]["ap_id"] is None and r["zones"][1]["demand_mbps"] == 40.0
    assert r["aps"] == [{"id": "ap1", "demand_mbps": 30.0, "usable_mbps": 25, "utilisation_pct": 120.0, "over": True}]


def test_iot_report_flags_far_devices_and_suggests_fixes():
    r = run_js("""
      const p = proj([floor('g', 0, 100, 10, [ap('a', 2, 5, 15)], {devices: [{id: 'near', cls: 'sensor', x: 4, y: 5}, {id: 'far', cls: 'camera', x: 98, y: 5}, {id: 'sens', cls: 'sensor', x: 98, y: 5}]})]);
      out(M.iotReport(p, 'g', config, {env}));""")
    near, far, sens = r
    assert near["status"] == "ok" and near["fix"] == ""
    assert far["status"] == "fail" and far["min_dbm"] == -70 and far["margin_db"] < 0 and "Add an AP" in far["fix"]
    assert sens["min_dbm"] == -90 and sens["rssi_dbm"] == far["rssi_dbm"] and sens["margin_db"] == far["margin_db"] + 20


def test_enterprise_layout_is_deterministic_and_neighbours_differ():
    r = run_js("""
      const f = floor('g', 0, 40, 20, []);
      const a = M.enterpriseLayout(f, config, {band: '5'}), b = M.enterpriseLayout(f, config, {band: '5'}), c = M.enterpriseLayout(f, config, {band: '2.4', spacing_m: 10});
      const boq = M.billOfQuantities(a.aps, config, 'g');
      out({same: JSON.stringify(a) === JSON.stringify(b), cols: a.cols, rows: a.rows, xs: a.aps.slice(0, 4).map(p => p.x), ys: [a.aps[0].y, a.aps[4].y],
           ch: a.aps.map(p => p.channel), c24: c.aps.map(p => [p.channel, p.x, p.y]), boq});""")
    assert r["same"] and (r["cols"], r["rows"]) == (4, 2) and r["xs"] == [5, 15, 25, 35] and r["ys"] == [5, 15]
    # 5 GHz set 36,40,44,48,149,153,157,161: channel index (col + 2 * row) mod 8
    assert r["ch"] == [36, 40, 44, 48, 44, 48, 149, 153]
    assert len({c for c, _, _ in r["c24"]}) == 3 and all(a[0] != b[0] for a, b in zip(r["c24"], r["c24"][1:]) if a[2] == b[2])
    q = {row[0]: row for row in r["boq"]}
    assert q["Access point, 5 GHz primary"][1] == 8 and q["PoE switch ports"][1] == 10 and q["PoE switch, 24 ports"][1] == 1 and q["Cat6A cable"][1] == 264
