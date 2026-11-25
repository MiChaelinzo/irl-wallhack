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
    assert [c["key"] for c in r["m"]["chips"]] == ["gaming", "streaming", "video"] and "Gaming:" in r["m"]["chips"][0]["text"]
    assert {x["name"] for x in r["rows"]} == {"Living room", "Kitchen", "Bedroom"}
    assert all("packet loss risk" in x["text"] and x["ping"] for x in r["rows"])
    assert "Why is my bedroom WiFi slow?" in [c["text"] for c in r["chips"]]
    assert r["worst"] in {x["name"] for x in r["rows"]}


def test_best_spot_line_is_computed_not_literal_and_apply_change_is_undoable():
    r = run_js("""
      const p = scenario('small_apartment'), rep = I.placementReport(p, 'main', opts), m = Q.bestSpotModel(rep);
      const none = Q.bestSpotModel(Object.assign({}, rep, {moved: false, had_router: true}));
      const add = Q.bestSpotModel(Object.assign({}, rep, {had_router: false}));
      const ops = Q.changeOps(S, p, 'main', m.change, config);
      const store = S.createStore(JSON.parse(JSON.stringify(p)));
      const before = JSON.stringify(store.project.floors[0].aps);
      store.exec({label: 'move', ops});
      const moved = JSON.stringify(store.project.floors[0].aps);
      store.undo();
      const mesh = Q.changeOps(S, p, 'main', {kind: 'add_mesh_node', x: 3, y: 3, parent_ap_id: 'router'}, config)[0];
      let bad = null; try { Q.changeOps(S, p, 'main', {kind: 'move_ap', ap_id: 'gone', x: 1, y: 1}, config); } catch (e) { bad = e.message; }
      out({m, rep: {room: rep.room, pts: rep.coverage_increase_pts, dz: rep.dead_zones_removed}, none: none.line, noneApply: none.canApply, add: add.line,
           addKind: add.change.kind, changed: before !== moved, restored: before === JSON.stringify(store.project.floors[0].aps), mesh: mesh.item, bad});
    """)
    assert r["m"]["line"].startswith(r["rep"]["room"]) and "points coverage" in r["m"]["line"] and "dead zone" in r["m"]["line"]
    assert ("+" + str(r["rep"]["pts"]) in r["m"]["line"]) or r["rep"]["pts"] <= 0
    assert r["m"]["canApply"] and r["m"]["change"]["kind"] == "move_ap"
    assert "already at the best spot" in r["none"] and r["noneApply"] is False
    assert r["add"].startswith("Add a router") and r["addKind"] == "add_ap"
    assert r["changed"] and r["restored"]
    assert r["mesh"]["id"] == "mesh1" and r["mesh"]["mesh_parent"] == "router" and r["mesh"]["tx_dbm"] == rfmodel.CONFIG["planner"]["default_tx_dbm"]
    assert "no longer exists" in r["bad"]


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
    assert all(f["change"]["kind"] in ("move_ap", "add_mesh_node") for f in r["a"]["fixes"])
    assert r["amb"]["status"] != "diagnosed" and r["amb"]["rooms"]
    assert len(r["rows"]) == 10 and all(len(row) == 1 + r["cols"] for row in r["rows"])
    assert r["tm"][0][6] == "baseline" and len(r["tm"]) == 3 and r["tm"][1][1].startswith("B: ")
    assert [x["room"] for x in r["sh"]] == r["g"]
    assert all(set(x) >= {"coverage", "bandwidth", "reliability"} for x in r["sh"])
    if r["clients"]:
        assert any("device" in x["bandwidth"] for x in r["sh"])


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
