"""View-model builders of planner-quick.js (run under node): result text, grade chips, question chips, best spot line,
store operations, Smart Home rows and the signal wave geometry. The DOM wiring (mount) is covered by tools/planner_smoke.py
and tools/a11y_check.py, which need a browser."""
import copy
import json
import shutil
import subprocess

import pytest

from tests.test_rf_config_schema import SCHEMA, validate
from wallhack import rfmodel
from wallhack.app import STATIC

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")

PRELUDE = """
const E = require(process.argv[1] + '/rf-engine.js'), I = require(process.argv[1] + '/rf-insight.js'), S = require(process.argv[1] + '/planner-state.js');
global.window = undefined;
const Q = require(process.argv[1] + '/planner-quick.js');
const config = JSON.parse(require('fs').readFileSync(0, 'utf8')), opts = {config};
const lib = JSON.parse(require('fs').readFileSync(process.argv[1] + '/scenarios.json', 'utf8')).scenarios;
const scenario = (id) => lib.find(s => s.id === id).project;
const out = (v) => console.log(JSON.stringify(v));
"""


def run_js(body):
    res = subprocess.run(["node", "-e", PRELUDE + body, str(STATIC)], capture_output=True, text=True, input=json.dumps(rfmodel.CONFIG))
    assert res.returncode == 0, res.stderr
    return json.loads(res.stdout)


def test_result_room_and_question_text_come_from_the_computed_numbers():
    r = run_js("""
      const p = scenario('small_apartment'), card = I.scoreCard(p, 'main', opts), gamer = I.gamerMode(p, 'main', opts);
      out({m: Q.resultModel(card), rows: Q.roomRows(gamer), worst: Q.worstRoom(gamer).name, chips: Q.questionChips(p.floors[0]), card: {grade: card.grade, score: card.score}});
    """)
    assert r["m"]["grade"] == r["card"]["grade"] and str(r["card"]["score"]) in r["m"]["gradeLabel"]
    assert r["m"]["gradeClass"] == "grade-" + r["card"]["grade"][0].lower()
    assert [c["key"] for c in r["m"]["chips"]] == ["gaming", "streaming", "video"]
    assert r["m"]["chips"][0]["text"].startswith("Gaming grade ")
    assert "Gaming grade " in r["m"]["headline"] and "Gaming: Excellent" not in r["m"]["chips"][0]["text"]
    assert {x["name"] for x in r["rows"]} == {"Living room", "Kitchen", "Bedroom"}
    assert all("packet loss risk" in x["text"] and x["ping"] for x in r["rows"])
    assert "Why is my bedroom WiFi slow?" in [c["text"] for c in r["chips"]]
    assert r["worst"] in {x["name"] for x in r["rows"]}


def test_best_spot_line_is_computed_not_literal_and_apply_change_is_undoable():
    r = run_js("""
      const p = scenario('small_apartment'), rep = I.placementReport(p, 'main', opts), m = Q.bestSpotModel(rep);
      const none = Q.bestSpotModel(Object.assign({}, rep, {moved: false, had_router: true}));
      const stronger = Q.bestSpotModel(Object.assign({}, rep, {moved: true, had_router: true, coverage_increase_pts: 0, dead_zones_removed: 0, mean_rssi_delta_db: 2.4}));
      const unavailable = Q.bestSpotModel({position: null, text: 'No position found'});
      const add = Q.bestSpotModel(Object.assign({}, rep, {had_router: false}));
      const schoolRep = I.placementReport(scenario('school_building'), 'school', opts), school = Q.bestSpotModel(schoolRep);
      const ops = Q.changeOps(S, p, 'main', m.change, config);
      const store = S.createStore(JSON.parse(JSON.stringify(p)));
      const before = JSON.stringify(store.project.floors[0].aps);
      store.exec({label: 'move', ops});
      const moved = JSON.stringify(store.project.floors[0].aps);
      store.undo();
      const mesh = Q.changeOps(S, p, 'main', {kind: 'add_mesh_node', x: 3, y: 3, parent_ap_id: 'router'}, config)[0];
      const ch = Q.changeOps(S, p, 'main', {kind: 'set_channels', assignments: [{ap_id: 'router', channel: 1}]}, config);
      let badCh = null; try { Q.changeOps(S, p, 'main', {kind: 'set_channels', assignments: [{ap_id: 'gone', channel: 1}]}, config); } catch (e) { badCh = e.message; }
      let bad = null; try { Q.changeOps(S, p, 'main', {kind: 'move_ap', ap_id: 'gone', x: 1, y: 1}, config); } catch (e) { bad = e.message; }
      out({m, rep: {room: rep.room, pts: rep.coverage_increase_pts, dz: rep.dead_zones_removed}, none: none.line, noneApply: none.canApply, stronger: stronger.line,
           unavailable: {line: unavailable.line, canApply: unavailable.canApply}, school: {line: school.line, canApply: school.canApply, report: schoolRep}, add: add.line,
           addKind: add.change.kind, changed: before !== moved, restored: before === JSON.stringify(store.project.floors[0].aps), mesh: mesh.item, bad, chOps: ch.length, badCh, chStore: (() => { const st = S.createStore(JSON.parse(JSON.stringify(p))); st.exec({label: 'ch', ops: ch}); return st.project.floors[0].aps[0].channel; })()});
    """)
    assert r["m"]["line"].startswith(r["rep"]["room"]) and "points coverage" in r["m"]["line"] and "dead zone" in r["m"]["line"]
    assert ("+" + str(r["rep"]["pts"]) in r["m"]["line"]) or r["rep"]["pts"] <= 0
    assert r["m"]["canApply"] and r["m"]["change"]["kind"] == "move_ap"
    assert "already at the best spot" in r["none"] and r["noneApply"] is False
    assert "stronger average signal (+2.4 dB)" in r["stronger"] and "coverage and dead zones unchanged" in r["stronger"]
    assert r["unavailable"]["canApply"] is False and "No better router spot" in r["unavailable"]["line"]
    assert r["school"]["report"]["coverage_increase_pts"] == 0 and r["school"]["report"]["dead_zones_removed"] == 0
    assert r["school"]["report"]["mean_rssi_delta_db"] > 0 and r["school"]["canApply"] is True
    assert "stronger average signal" in r["school"]["line"] and "0 points coverage" not in r["school"]["line"]
    assert r["add"].startswith("Add a router") and r["addKind"] == "add_ap"
    assert r["changed"] and r["restored"]
    assert r["mesh"]["id"] == "mesh1" and r["mesh"]["mesh_parent"] == "router" and r["mesh"]["tx_dbm"] == rfmodel.CONFIG["planner"]["default_tx_dbm"]
    assert "no longer exists" in r["bad"]
    assert r["chOps"] == 1 and r["chStore"] == 1 and "gone no longer exists" in r["badCh"]


def test_answer_mesh_time_machine_and_smart_home_models():
    r = run_js("""
      const p = scenario('small_apartment'), fid = 'main';
      const d = I.diagnose(p, fid, 'why is my bedroom wifi slow?', opts), a = Q.answerModel(d);
      const amb = Q.answerModel(I.diagnose(p, fid, 'why is it slow?', opts));
      const mesh = I.meshTopologies(p, fid, opts), rows = Q.meshRows(mesh);
      const items = I.scenarioItems(p).concat(I.presetItems(p, fid, opts)).slice(0, 3), tmr = I.timeMachine(items, Object.assign({floorId: fid}, opts));
      const home = scenario('smart_home'), hf = home.floors[0], res = I.analyze(home, hf.id, opts), g = I.gamerMode(home, hf.id, Object.assign({result: res}, opts));
      const sh = Q.smartHomeRows(hf, g, res.analytics.clients || null, I.placeName);
      out({a, amb, rows, tm: Q.timeMachineRows(tmr), cols: mesh.topologies.length, sh, clients: (hf.clients || []).length, g: g.rooms.map(r => r.name)});
    """)
    assert r["a"]["status"] == "diagnosed" and r["a"]["title"] == "WiFi in Bedroom" and r["a"]["causes"]
    assert all(f["change"]["kind"] in ("move_ap", "add_mesh_node", "set_channels") for f in r["a"]["fixes"])
    assert r["amb"]["status"] != "diagnosed" and r["amb"]["rooms"]
    assert len(r["rows"]) == 10 and all(len(row) == 1 + r["cols"] for row in r["rows"])
    assert r["tm"][0][6] == "baseline" and len(r["tm"]) == 3 and r["tm"][1][1].startswith("B: ")
    assert [x["room"] for x in r["sh"]] == r["g"]
    assert all(set(x) >= {"coverage", "bandwidth", "reliability"} for x in r["sh"])
    if r["clients"]:
        assert any("device" in x["bandwidth"] for x in r["sh"])


def test_next_action_model_uses_the_measured_fix_and_reports_residual_cause():
    r = run_js("""
      const O = require(process.argv[1] + '/rf-optimizer.js');
      const p = scenario('two_bedroom_condo'), fid = 'condo';
      const gamer = I.gamerMode(p, fid, opts), weak = Q.worstRoom(gamer);
      const diagnosis = I.diagnose(p, fid, Q.questionFor(weak.name), opts);
      const action = Q.nextActionModel(gamer, diagnosis, score => I.gradeFor(config, 'gaming', score));
      const changed = O.applyChange(p, action.fix.change, config);
      const afterGamer = I.gamerMode(changed, fid, opts);
      const afterDiagnosis = I.diagnose(changed, fid, Q.questionFor(action.room.name), opts);
      const outcome = Q.nextActionModel(afterGamer, afterDiagnosis, score => I.gradeFor(config, 'gaming', score), action.context);
      const noAp = JSON.parse(JSON.stringify(p)); noAp.floors[0].aps = [];
      const noApGamer = I.gamerMode(noAp, fid, opts), noApWeak = Q.worstRoom(noApGamer);
      const noApDiagnosis = I.diagnose(noAp, fid, Q.questionFor(noApWeak.name), opts);
      const noFix = Q.nextActionModel(noApGamer, noApDiagnosis, score => I.gradeFor(config, 'gaming', score));
      const fakeGamer = {rooms: [{id: 'r', name: 'Room', grade: 'B', stability_score: 82}]};
      const wallOutcome = Q.nextActionModel(fakeGamer, {status: 'diagnosed', causes: [{kind: 'wall', id: 'w2'}], other_causes: [], primary: {kind: 'wall', id: 'w2'}},
        score => 'B', {room: {id: 'r', name: 'Room', grade: 'B', score: 82}, cause: {kind: 'wall', id: 'w1'}});
      const mixedInterference = Q.nextActionModel(fakeGamer, {status: 'diagnosed', causes: [{kind: 'interference', sources: ['A', 'C'], db: 10}], other_causes: [], primary: {kind: 'interference', sources: ['A', 'C'], db: 10}},
        score => 'B', {room: {id: 'r', name: 'Room', grade: 'B', score: 82}, cause: {kind: 'interference', sources: ['A', 'B'], db: 20}});
      out({action, outcome, noFix, wallOutcome, mixedInterference});
    """)
    action, outcome = r["action"], r["outcome"]
    assert action["status"] == "ready" and action["room"]["name"] == "Bedroom 2"
    assert action["fix"]["rank"] == 1 and action["fix"]["change"] == {"kind": "set_channels", "assignments": [{"ap_id": "router", "channel": 1}]}
    assert "Expected: gaming grade" in action["effect"] and "whole-floor coverage" in action["effect"]
    assert outcome["status"] == "outcome" and outcome["causeRemains"] is True
    assert "was reduced from about" in outcome["causeLine"] and "but it was not eliminated" in outcome["causeLine"]
    assert "gaming grade" in outcome["line"]
    assert r["noFix"]["status"] == "no_fix" and "no access point reaches" in r["noFix"]["recommendation"]
    assert r["wallOutcome"]["causeRemains"] is False and "no longer listed" in r["wallOutcome"]["causeLine"]
    assert r["mixedInterference"]["causeRemains"] is True
    assert "source list changed" in r["mixedInterference"]["causeLine"] and "not directly comparable" in r["mixedInterference"]["causeLine"]


def test_wave_rings_fade_across_walls_and_are_deterministic():
    r = run_js("""
      const wc = config.signal_waves;
      const plan = (material) => ({name: 'w', units: 'm', interferers: [], floors: [{id: 'f', name: 'F', level: 0, width_m: 20, depth_m: 10, height_m: 2.7, rooms: [],
        walls: [{id: 'm', kind: 'interior', material, x1: 6, y1: 0, x2: 6, y2: 10}], openings: [], furniture: [], sensors: [], labels: [], annotations: [], devices: [],
        aps: [{id: 'a', x: 3, y: 5, tx_dbm: 18, band: '5'}]}]});
      const alphaThrough = (material) => {
        const p = plan(material), env = E.makeEnv(config, p.materials), floor = p.floors[0], prep = E.prepareFloor(env, floor, '5');
        const rows = Q.rayLosses(E, env, prep, floor.aps[0], 4, wc);   // ray 0 points along +x, through the wall at x = 6
        return {east: Q.ringAlpha(rows[0], 9, wc), west: Q.ringAlpha(rows[2], 3, wc), eastBefore: Q.ringAlpha(rows[0], 2, wc), rows: rows.map(x => Array.from(x).slice(0, 12))};
      };
      const concrete = alphaThrough('concrete'), glass = alphaThrough('glass'), again = alphaThrough('concrete');
      out({concrete, glass, same: JSON.stringify(concrete) === JSON.stringify(again), r0: Q.ringRadii(wc, 0), r1: Q.ringRadii(wc, 0.5), many: Q.ringRadii(wc, 100).length,
           rays: [Q.waveRays(wc, 'low'), Q.waveRays(wc, 'high'), Q.waveRays(wc, 'bogus')], wc});
    """)
    assert r["same"]
    assert r["concrete"]["east"] < r["concrete"]["west"] and r["concrete"]["eastBefore"] > r["concrete"]["east"]
    assert r["concrete"]["east"] < r["glass"]["east"], "a concrete wall must dim the ring more than glass"
    assert r["rays"] == [24, 96, 48]
    assert r["many"] <= r["wc"]["max_rings"] and all(x <= r["wc"]["max_radius_m"] for x in r["r1"])


def test_signal_waves_block_and_new_client_devices_are_documented_and_validated():
    wc = rfmodel.CONFIG["signal_waves"]
    assert "ILLUSTRATION" in wc["label"] and "not physical" in wc["source"]
    assert wc["rays_by_quality"]["low"] < wc["rays_by_quality"]["medium"] < wc["rays_by_quality"]["high"]
    broken = copy.deepcopy(rfmodel.CONFIG)
    broken["signal_waves"]["max_rings"] = 0
    assert any("max_rings" in e for e in validate(broken, SCHEMA, SCHEMA))
    devices = rfmodel.CONFIG["client_devices"]["devices"]
    for kind in ("camera", "doorbell", "speaker", "thermostat", "robot_vacuum", "tv", "console"):
        assert kind in devices, kind
    src = rfmodel.CONFIG["client_devices"]["source"]
    for word in ("doorbell", "speaker", "thermostat", "robot vacuum"):
        assert word in src, "demand figure of %s is not documented" % word


def test_wifi_assessment_pdf_pages_footer_and_determinism():
    from tests.test_planner_panels import pdf_problems
    r = run_js("""
      const X = require(process.argv[1] + '/planner-export.js');
      const p = scenario('small_apartment'), res = I.analyze(p, 'main', opts), o2 = Object.assign({}, opts, {result: res});
      const card = I.scoreCard(p, 'main', o2), gamer = I.gamerMode(p, 'main', o2), answer = I.diagnose(p, 'main', 'Why is my bedroom WiFi slow?', opts);
      const mesh = I.meshTopologies(p, 'main', opts);
      const jpeg = new Uint8Array(200).map((_, i) => (i * 5) & 255); jpeg[0] = 0xff; jpeg[1] = 0xd8;
      const data = {project: 'Flat', floor: 'main', date: '2025-01-01', card, gamer, answer, placement: null, mesh, timeMachine: null, image: {bytes: jpeg, w: 40, h: 30}};
      const a = X.buildAssessment(data), b = X.buildAssessment(data), bare = X.buildAssessment(Object.assign({}, data, {answer: null, mesh: null, image: null}));
      out({a: Array.from(a), same: Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0, bare: Array.from(bare), grade: card.grade, rooms: gamer.rooms.map(r => r.name),
           csv: X.toCsv(X.assessmentCsvRows(data))});
    """)
    data, bare = bytes(r["a"]), bytes(r["bare"])
    assert r["same"] and pdf_problems(data) == [] and pdf_problems(bare) == []
    assert data.startswith(b"%PDF-1.4")
    pages = data.count(b"/Type /Page ")
    assert pages >= 4 and bare.count(b"/Type /Page ") == 3   # grade, rooms, diagnosis (+ mesh and Time Machine page when present)
    assert data.count(b"MODEL ESTIMATE, not a measurement. Values come from a propagation model") == pages
    assert bare.count(b"MODEL ESTIMATE, not a measurement. Values come from a propagation model") == 3
    assert ("Grade %s" % r["grade"]).encode() in data and b"/Filter /DCTDecode" in data and b"Mesh topologies" in data
    assert b"Gaming grade" in data and b"Excellent (grade" not in data
    assert all(name.encode() in data for name in r["rooms"])
    assert r["csv"].startswith("Wallhack Wi-Fi assessment,")
    assert "Room,Coverage,Ping range,Jitter,Loss risk,Stability,Gaming grade" in r["csv"]


def test_before_after_model_reports_grade_and_score_change():
    r = run_js("""
      const p = scenario('small_apartment'), before = I.scoreCard(p, 'main', opts);
      before.ratings.gaming.word = 'Excellent'; before.ratings.gaming.grade = 'B';
      const up = JSON.parse(JSON.stringify(before)); up.score = before.score + 7; up.grade = 'A'; up.ratings.gaming.grade = 'A';
      const down = JSON.parse(JSON.stringify(before)); down.score = before.score - 3;
      const same = Q.beforeAfterModel(before, before, 'x');
      out({up: Q.beforeAfterModel(before, up, 'Move router'), down: Q.beforeAfterModel(before, down, 'y'), same, g: before.grade});
    """)
    assert r["up"]["direction"] == "up" and "went up 7 points" in r["up"]["verdict"] and r["up"]["after"]["gradeClass"] == "grade-a"
    assert r["up"]["gradeText"].endswith("grade A (%d)" % round(r["up"]["after"]["score"])) and [x["name"] for x in r["up"]["rows"]] == ["Gaming grade", "Streaming", "Video calls"]
    assert r["up"]["rows"][0] == {"name": "Gaming grade", "before": "B", "after": "A", "changed": True}
    assert r["down"]["direction"] == "down" and "went down 3 points" in r["down"]["verdict"] and "Undo" in r["down"]["verdict"]
    assert r["same"]["direction"] == "same" and not any(x["changed"] for x in r["same"]["rows"])


def test_candidate_grid_cache_keeps_results_identical_on_reuse():
    r = run_js("""
      const p = scenario('large_home'), fid = 'ground', fresh = () => Object.assign({}, opts, {env: E.makeEnv(config)});
      const a = I.meshTopologies(p, fid, fresh()), shared = fresh(), b = I.meshTopologies(p, fid, shared), c = I.meshTopologies(p, fid, shared);
      out({same: JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(b) === JSON.stringify(c)});
    """)
    assert r["same"], "a reused environment changed the mesh result"


# Each case changes one input of the shared candidate grid key. The cache slot is keyed by the config object, so the warm
# call and the changed call share one config (the slot a stale key would reuse). The reference call uses a deep copy of the
# config, which has its own empty slot and therefore cannot be stale. Removing that dimension from geometryKey must fail it.
INVALIDATION_CASES = {
    "walls": "project.floors[0].walls.forEach(w => { w.material = 'concrete'; });",
    "materials": "const heavy = (m) => Object.assign({}, m, {attenuation_db: {'2.4': 40, '5': 40, '6': 40}}); o.env = E.makeEnv(o.config, {brick: heavy(o.config.materials.brick), drywall: heavy(o.config.materials.drywall)});",
    "cell_size": "o.cellM = 1.0;",
    "mode": "o.mode = 'multipath';",
    "band": "o.band = '2.4';",
}


@pytest.mark.parametrize("dimension", sorted(INVALIDATION_CASES))
def test_candidate_grid_cache_is_invalidated_by_every_key_dimension(dimension):
    r = run_js("""
      const O = require(process.argv[1] + '/rf-optimizer.js'), fid = 'ground', base = scenario('large_home'), clone = (c) => JSON.parse(JSON.stringify(c));
      const run = (project, o) => O.suggestPlacements(project, fid, Object.assign({count: 5}, o));
      const make = (cfg) => ({config: cfg, env: E.makeEnv(cfg), cellM: 0.5, mode: 'basic', band: '5'});
      const change = (project, o) => { %s };
      const warm = make(config), project = clone(base), o = make(config);
      run(base, warm);                       // fills the slot of `config` with the unchanged inputs
      change(project, o);
      const cached = run(project, o);        // same config object: would reuse the slot if the key missed it
      const cfg2 = clone(config), project2 = clone(base), o2 = make(cfg2);
      change(project2, o2);
      const reference = run(project2, o2);   // own empty slot
      const unchanged = run(base, make(clone(config)));
      out({match: JSON.stringify(cached) === JSON.stringify(reference), differs: JSON.stringify(reference) !== JSON.stringify(unchanged)});
    """ % INVALIDATION_CASES[dimension])
    assert r["differs"], "the %s change does not alter the suggested placements, so the test cannot detect a stale cache" % dimension
    assert r["match"], "a %s change did not invalidate the cached candidate grids" % dimension
