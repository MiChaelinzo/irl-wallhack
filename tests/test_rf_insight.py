"""Insight library (rf-insight.js, run under node): per-room analysis, Gamer Mode, Score Card, Predictive WiFi Assistant,
placement report, mesh topologies and the Time Machine.

The library is JavaScript only. These tests check determinism, that every number traces to an engine run, the grade
thresholds, the question parser rules and the delta arithmetic. The LLM rephrase path is mock tested only: real model
output is UNVERIFIED in this repository."""
import json
import shutil
import subprocess

import pytest

from tests.test_explain import fake_opener
from wallhack import llm, rfmodel
from wallhack.app import STATIC

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")

PRELUDE = """
const E = require(process.argv[1] + '/rf-engine.js'), O = require(process.argv[1] + '/rf-optimizer.js'), I = require(process.argv[1] + '/rf-insight.js');
const config = JSON.parse(require('fs').readFileSync(0, 'utf8')), env = E.makeEnv(config), opts = {env, config};
const lib = JSON.parse(require('fs').readFileSync(process.argv[1] + '/scenarios.json', 'utf8')).scenarios;
const scenario = (id) => lib.find(s => s.id === id).project;
const out = (v) => console.log(JSON.stringify(v));
// Two rooms side by side, router in the Office, one wall (material given) between it and the Bedroom, no other sources.
const twoRooms = (material, thicknessCm) => ({name: 't', units: 'm', interferers: [], floors: [{id: 'f', name: 'Flat', level: 0, width_m: 8, depth_m: 5, height_m: 2.5,
  rooms: [{id: 'office', name: 'Office', x: 0, y: 0, w: 4, d: 5}, {id: 'bed', name: 'Bedroom', x: 4, y: 0, w: 4, d: 5}],
  walls: [{id: 'mid', kind: 'interior', material, x1: 4, y1: 0, x2: 4, y2: 5, thickness_cm: thicknessCm}],
  openings: [], furniture: [], sensors: [], labels: [{id: 'l1', text: 'Hallway', x: 4, y: 4.8}], annotations: [], devices: [],
  aps: [{id: 'router', x: 3, y: 2.5, tx_dbm: 18, band: '5', standard: 'wifi6'}]}]});
"""


def run_js(body):
    res = subprocess.run(["node", "-e", PRELUDE + body, str(STATIC)], capture_output=True, text=True, input=json.dumps(rfmodel.CONFIG))
    assert res.returncode == 0, res.stderr
    return json.loads(res.stdout)


def test_every_function_is_deterministic_and_leaves_the_input_alone():
    r = run_js("""
      const p = scenario('large_home'), snapshot = JSON.stringify(p);
      const calls = () => [I.roomStats(p, 'ground', null, opts), I.gamerMode(p, 'ground', opts), I.scoreCard(p, 'ground', opts),
        I.diagnose(p, 'upper', 'Why is my Bedroom 1 laggy?', opts), I.placementReport(p, 'upper', opts), I.meshTopologies(p, 'upper', opts),
        I.timeMachine([{id: 'a', label: 'A', project: p}, ...I.presetItems(p, 'ground', opts)], Object.assign({floorId: 'ground'}, opts))];
      const a = JSON.stringify(calls()), b = JSON.stringify(calls());
      out({same: a === b, untouched: JSON.stringify(p) === snapshot});
    """)
    assert r == {"same": True, "untouched": True}


def test_room_stats_aggregate_the_engine_grid_over_each_room():
    r = run_js("""
      const p = scenario('small_apartment'), res = I.analyze(p, 'main', opts), rooms = I.roomStats(p, 'main', res);
      const living = rooms[0], f = p.floors[0];
      // recompute the living room by hand from the engine's own grid
      const cells = []; for (let r = 0; r < res.rows; r++) for (let c = 0; c < res.cols; c++) {
        const cx = (c + 0.5) * res.cellM, cy = (r + 0.5) * res.cellM; if (cx < 4 && cy < 6) cells.push(res.grids.rssi[r * res.cols + c]); }
      const noRooms = JSON.parse(JSON.stringify(p)); noRooms.floors[0].rooms = [];
      out({names: rooms.map(x => x.name), cells: living.cells, expected: cells.length, mean: living.mean_rssi_dbm,
           handMean: Math.round(10 * cells.reduce((s, v) => s + v, 0) / cells.length) / 10, min: living.min_rssi_dbm, handMin: Math.min(...cells),
           fallback: I.roomStats(noRooms, 'main', null, opts).map(x => [x.name, x.whole_floor, x.cells]), area: f.width_m * f.depth_m});
    """)
    assert r["names"] == ["Living room", "Kitchen", "Bedroom"]
    assert r["cells"] == r["expected"] and r["mean"] == r["handMean"] and r["min"] == r["handMin"]
    assert r["fallback"] == [["Apartment", True, r["area"]]]


def test_gaming_ping_is_always_a_labelled_range_and_the_isp_base_is_adjustable():
    r = run_js("""
      const p = scenario('large_home');
      const a = I.gamerMode(p, 'ground', opts), b = I.gamerMode(p, 'ground', Object.assign({ispBaseMs: 40}, opts));
      out({a, b});
    """)
    for room_a, room_b in zip(r["a"]["rooms"], r["b"]["rooms"]):
        lo, hi = room_a["ping_ms"]
        assert lo < hi and lo >= r["a"]["isp_base_ms"] and room_a["estimate"] is True and "no standard formula" in room_a["note"]
        assert room_a["loss_risk"] in {"Low", "Medium", "High"} and 0 <= room_a["stability_score"] <= 100
        assert room_b["ping_ms"][0] == pytest.approx(lo + 25, abs=0.11) and room_b["ping_ms"][1] == pytest.approx(hi + 25, abs=0.11)
        assert room_b["stability_score"] <= room_a["stability_score"]


def test_grade_and_rating_thresholds_at_the_boundaries():
    r = run_js("""
      const g = (s) => I.gradeFor(config, 'gaming', s), c = (s) => I.gradeFor(config, 'card', s), w = (s) => I.wordFor(config, s);
      out({gaming: [100, 95, 94.9, 90, 89.9, 80, 79.9, 70, 69.9, 60, 59.9, 0].map(g), card: [100, 90, 89.9, 80, 79.9, 70, 69.9, 60, 59.9, 0].map(c),
           words: [100, 85, 84.9, 70, 69.9, 50, 49.9, 0].map(w)});
    """)
    assert r["gaming"] == ["A+", "A+", "A", "A", "B", "B", "C", "C", "D", "D", "F", "F"]
    assert r["card"] == ["A", "A", "B", "B", "C", "C", "D", "D", "F", "F"]
    assert r["words"] == ["Excellent", "Excellent", "Good", "Good", "Fair", "Fair", "Poor", "Poor"]


def test_score_card_grade_follows_its_inputs():
    r = run_js("""
      const good = I.scoreCard(twoRooms('drywall'), 'f', opts), bad = I.scoreCard(twoRooms('reinforced_concrete', 30), 'f', opts);
      out({good, bad});
    """)
    good, bad = r["good"], r["bad"]
    assert good["score"] > bad["score"] and good["coverage_pct"] >= bad["coverage_pct"]
    assert good["grade"] <= bad["grade"] and set(good["ratings"]) == {"gaming", "streaming", "video"}
    assert good["ratings"]["streaming"]["word"] in {"Excellent", "Good", "Fair", "Poor"} and "Model estimate" in good["text"]
    assert [x["name"] for x in good["rooms"]] == ["Office", "Bedroom"]


def test_concrete_wall_is_the_primary_cause_with_material_and_db():
    r = run_js("""
      const d = I.diagnose(twoRooms('concrete', 20), 'f', 'Why is my bedroom WiFi slow?', opts);
      const probe = E.probeAt(twoRooms('concrete', 20), 'f', 6, 2.5, Object.assign({explain: true}, {env}));
      out({d, wallDb: probe.explain.walls[0].loss_db, text: d.text});
    """)
    d = r["d"]
    assert d["status"] == "diagnosed" and d["room"]["name"] == "Bedroom" and d["intents"] == ["slow"]
    assert d["primary"]["kind"] == "wall" and d["primary"]["material"] == "concrete"
    assert d["primary"]["db"] == pytest.approx(r["wallDb"], abs=0.06)
    assert d["primary"]["text"].startswith("Concrete wall: ") and d["primary"]["text"].endswith(" dB")
    assert d["secondary"] is not None and d["secondary"]["db"] <= d["primary"]["db"]
    assert any(line.startswith("Main cause: " + d["primary"]["text"]) for line in r["text"])
    assert len(d["fixes"]) >= 1
    for f in d["fixes"]:
        assert f["room"]["coverage_after_pct"] - f["room"]["coverage_before_pct"] == pytest.approx(f["room"]["coverage_delta_pts"], abs=0.11)
        assert f["room"]["ping_before_ms"] and f["room"]["ping_after_ms"] and f["what_if"]["confidence"] >= 0
        assert f["room"]["score_after"] > f["room"]["score_before"] or f["room"]["coverage_delta_pts"] > 0


def test_bedroom_question_on_a_preset_gives_causes_in_db_and_a_measured_fix():
    d = run_js("out(I.diagnose(scenario('small_apartment'), 'main', 'Why is my bedroom WiFi slow?', opts))")
    assert d["room"]["name"] == "Bedroom" and d["primary"]["db"] > 0 and d["secondary"]["db"] > 0
    assert d["primary"]["text"].endswith(" dB") and d["primary"]["db"] >= d["secondary"]["db"]
    fix = d["fixes"][0]
    assert fix["room"]["ping_before_ms"] and fix["room"]["ping_after_ms"] and "(model estimate)" in fix["line"]
    assert fix["floor"]["coverage_after_pct"] >= fix["floor"]["coverage_before_pct"]


def test_assistant_asks_which_room_when_unsure_and_parses_intents():
    r = run_js("""
      const p = scenario('two_bedroom_condo'), f = p.floors[0], cfg = config;
      const q = (t, fl) => I.parseQuestion(fl || f, t, cfg);
      out({unknown: I.diagnose(p, 'condo', 'Why is the garage slow?', opts), ambiguous: q('my bedroom keeps dropping'),
           exact: q('Bedroom 2 is laggy on my PS5'), plural: q('the bathrooms have no signal'), words: q("Netflix keeps buffering in the living room"),
           none: q('hello')});
    """)
    assert r["unknown"]["status"] == "needs_room" and [x["name"] for x in r["unknown"]["rooms"]] == ["Living and kitchen", "Bedroom 1", "Bathroom", "Bedroom 2"]
    assert r["unknown"]["fixes"] == [] and "Which one do you mean" in r["unknown"]["text"][0]
    assert r["ambiguous"]["status"] == "ambiguous" and r["ambiguous"]["intents"] == ["drops"]
    assert r["exact"]["status"] == "matched" and r["exact"]["place"]["name"] == "Bedroom 2" and r["exact"]["intents"] == ["lag"] and r["exact"]["devices"] == ["ps5"]
    assert r["plural"]["place"]["name"] == "Bathroom" and r["plural"]["intents"] == ["dead"]
    assert r["words"]["place"]["name"] == "Living and kitchen" and r["words"]["match_rule"] == "words" and r["words"]["intents"] == ["buffering"]
    assert r["none"]["status"] == "unknown" and r["none"]["intents"] == ["slow"] and r["none"]["intents_found"] == []


def test_assistant_matches_label_text():
    r = run_js("""
      const d = I.diagnose(twoRooms('drywall'), 'f', 'no signal near the hallway', opts);
      out({status: d.status, room: d.room, which: d.point.which});
    """)
    assert r == {"status": "diagnosed", "room": {"kind": "label", "id": "l1", "name": "Hallway"}, "which": "worst cell"}


def test_placement_report_searches_the_lattice_and_reports_measured_differences():
    r = run_js("""
      const p = scenario('large_home'), rep = I.placementReport(p, 'ground', opts);
      const lattice = O.candidatePositions(p, 'ground', opts), before = E.analyzeFloor(p, 'ground', {env, cellM: config.planner.cell_m});
      out({rep, lattice: lattice.length, routerRoom: I.placeName(p.floors[0], rep.position.x, rep.position.y), none: I.placementReport(twoRooms('drywall'), 'f', opts)});
    """)
    rep = r["rep"]
    assert rep["positions_evaluated"] == r["lattice"] + 1 and rep["room"] == r["routerRoom"]
    assert rep["coverage_increase_pts"] == pytest.approx(rep["coverage_after_pct"] - rep["coverage_before_pct"], abs=0.11)
    assert rep["coverage_increase_pts"] >= 0 and rep["dead_zones_removed"] == rep["dead_zones_before"] - rep["dead_zones_after"]
    assert f"{rep['positions_evaluated']} positions evaluated" in rep["text"] and "percentage points" in rep["text"]
    assert r["none"]["positions_evaluated"] >= 1


def test_mesh_topologies_never_lose_coverage_and_deltas_are_differences():
    r = run_js("""
      const p = scenario('large_home'), m = I.meshTopologies(p, 'upper', opts);
      const hop = config.planner_modes.mesh.hop_throughput_factor;
      out({m, hop, hopMs: config.insight.mesh.hop_latency_ms});
    """)
    single, dual, whole = r["m"]["topologies"]
    assert [t["id"] for t in r["m"]["topologies"]] == ["single", "dual_mesh", "whole_home_mesh"]
    assert dual["coverage_pct"] >= single["coverage_pct"] and whole["coverage_pct"] >= dual["coverage_pct"] - 0.05
    assert len(dual["nodes"]) <= 1 and len(whole["nodes"]) <= rfmodel.CONFIG["insight"]["mesh"]["max_nodes"]
    assert dual["nodes"], "the upper floor of large_home has no AP, so a node is suggested"
    assert dual["mean_latency_ms"] >= single["mean_latency_ms"], "the backhaul hop adds latency"
    for t in (dual, whole):
        assert t["delta"]["coverage_pts"] == pytest.approx(t["coverage_pct"] - single["coverage_pct"], abs=0.11)
        assert t["delta"]["dead_zones"] == t["dead_zones"] - single["dead_zones"]
    assert single["delta"]["coverage_pts"] == 0 and r["m"]["assumptions"]["hop_latency_ms"] == r["hopMs"]


def test_time_machine_deltas_ranking_and_limits():
    r = run_js("""
      const p = scenario('large_home'), items = [{id: 'now', label: 'Now', project: p}, ...I.presetItems(p, 'ground', opts)];
      const tm = I.timeMachine(items, Object.assign({floorId: 'ground'}, opts));
      const err = (list) => { try { I.timeMachine(list, Object.assign({floorId: 'ground'}, opts)); return 'ok'; } catch (e) { return e.message; } };
      out({tm, ids: items.map(i => i.id), one: err(items.slice(0, 1)), five: err(items.concat(items.slice(1, 3))),
           saved: I.scenarioItems(Object.assign({}, p, {scenarios: []})).map(i => i.id)});
    """)
    tm = r["tm"]
    assert r["ids"] == ["now", "preset:isp_router", "preset:isp_router_mesh", "preset:high_end_router"]
    first = tm["items"][0]
    assert first["delta"]["coverage_pts"] == 0 and first["delta"]["grade_change"] == f"{first['grade']} to {first['grade']}"
    for it in tm["items"]:
        assert it["delta"]["coverage_pts"] == pytest.approx(it["coverage_pct"] - first["coverage_pct"], abs=0.11)
        assert it["delta"]["dead_zones"] == it["dead_zones"] - first["dead_zones"]
        if first["mean_latency_ms"]:
            assert it["delta"]["mean_latency_pct"] == pytest.approx(100 * (it["mean_latency_ms"] - first["mean_latency_ms"]) / first["mean_latency_ms"], abs=0.2)
    scores = [next(i for i in tm["items"] if i["id"] == x)["score"] for x in tm["ranking"]]
    assert scores == sorted(scores, reverse=True) and sorted(i["rank"] for i in tm["items"]) == [1, 2, 3, 4]
    assert "2 to 4 items" in r["one"] and "got 6" in r["five"] and r["saved"] == ["current"]


# ---------------------------------------------------------------- optional LLM rephrase through POST /api/planner/explain (mock only)
def diagnosis_payload():
    return run_js("out(I.assistantPayload(I.diagnose(twoRooms('concrete', 20), 'f', 'Why is my bedroom WiFi slow?', opts)))")


def test_assistant_payload_is_valid_and_a_mocked_llm_with_invented_numbers_is_rejected():
    payload = diagnosis_payload()
    clean = llm.validate_planner_payload(payload)
    rules = llm.explain_planner(payload, "")
    assert rules["source"] == "rules" and llm.ungrounded_numbers(rules["explanation"], clean) == []
    metrics = {m["label"]: m["value"] for m in payload["metrics"]}
    ok = llm.explain_planner(payload, "ollama", opener=fake_opener(f"The signal is about {metrics['Signal']} dBm. Estimate only."))
    assert ok["source"] == "llm"
    bad = llm.explain_planner(payload, "ollama", opener=fake_opener("The wall costs 77.7 dB."))
    assert bad["source"] == "rules" and bad["rejected_numbers"]


def test_placement_report_without_router_and_without_lattice_returns_no_position():
    r = run_js("""
      const p = twoRooms('drywall'); p.floors[0].aps = []; p.floors[0].width_m = 0.2; p.floors[0].depth_m = 0.2;
      p.floors[0].rooms = []; p.floors[0].walls = []; p.floors[0].labels = [];
      let rep = null, err = null;
      try { rep = I.placementReport(p, 'f', opts); } catch (e) { err = String(e); }
      out({rep, err, lattice: O.candidatePositions(p, 'f', opts).length});
    """)
    assert r["err"] is None, r["err"]
    if r["lattice"] == 0:
        assert r["rep"]["position"] is None and r["rep"]["moved"] is False and "No position found" in r["rep"]["text"]


def test_assistant_never_recommends_a_fix_that_lowers_whole_floor_coverage():
    r = run_js("""
      const out_ = [];
      for (const id of ['small_apartment', 'large_home']) {
        const p = scenario(id), f = p.floors[0];
        for (const room of f.rooms) { out_.push(...I.diagnose(p, f.id, 'Why is my ' + room.name + ' WiFi slow?', opts).fixes.map(x => x.floor.coverage_delta_pts)); }
      }
      out(out_);
    """)
    assert all(d >= 0 for d in r)


def test_thickness_factor_clamps_to_the_validated_minimum_in_both_languages():
    r = run_js("out({js: [0, -5, 0.5].map(t => E.thicknessFactor(config, 'concrete', t))})")
    py = [rfmodel.thickness_factor({"thickness_cm": t}, "concrete") for t in (0, -5, 0.5)]
    assert r["js"] == py and py[0] == py[1] == py[2] > 0
