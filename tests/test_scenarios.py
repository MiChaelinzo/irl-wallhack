"""Scenario library: every preset validates, analyses deterministically, matches its generator and gets recommendations."""
import json
import shutil
import subprocess

import pytest

from tools import make_scenarios
from wallhack import rfmodel, twin
from wallhack.app import STATIC

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")

EXPECTED_IDS = ["small_apartment", "large_home", "office_floor", "school_building", "warehouse", "hotel_floor", "coffee_shop"]
PRELUDE = """
const S = require(process.argv[1] + '/planner-state.js'), E = require(process.argv[1] + '/rf-engine.js'), O = require(process.argv[1] + '/rf-optimizer.js');
const config = JSON.parse(require('fs').readFileSync(0, 'utf8')), env = E.makeEnv(config);
const lib = S.validateScenarioLibrary(JSON.parse(require('fs').readFileSync(process.argv[1] + '/scenarios.json', 'utf8')));
const out = (v) => console.log(JSON.stringify(v));
"""


def run_js(body):
    res = subprocess.run(["node", "-e", PRELUDE + body, str(STATIC)], capture_output=True, text=True, input=json.dumps(rfmodel.CONFIG))
    assert res.returncode == 0, res.stderr
    return json.loads(res.stdout)


def test_checked_in_library_matches_generator():
    assert (STATIC / "scenarios.json").read_text(encoding="utf-8") == make_scenarios.render()


def test_every_scenario_validates_in_js_and_python():
    data = json.loads((STATIC / "scenarios.json").read_text(encoding="utf-8"))
    assert [s["id"] for s in data["scenarios"]] == EXPECTED_IDS
    for s in data["scenarios"]:
        twin.validate_twin(s["project"])
        assert s["description"] and s["learn"]
    assert run_js("out(lib.map(s => s.id))") == EXPECTED_IDS


def test_library_rejects_bad_input():
    bad = """
      const good = JSON.parse(require('fs').readFileSync(process.argv[1] + '/scenarios.json', 'utf8'));
      const tries = [
        {schema_version: 2, scenarios: good.scenarios},
        {schema_version: 1, scenarios: []},
        {schema_version: 1, scenarios: [good.scenarios[0], good.scenarios[0]]},
        {schema_version: 1, scenarios: [Object.assign({}, good.scenarios[0], {project: {floors: []}})]},
      ];
      out(tries.map(t => { try { S.validateScenarioLibrary(t); return 'accepted'; } catch (e) { return e.name + ': ' + e.message.slice(0, 40); } }));
    """
    results = run_js(bad)
    assert all(r.startswith("ProjectError") for r in results), results


def test_analysis_is_deterministic_and_python_matches():
    js = run_js("""out(lib.map(s => s.project.floors.map(f => {
        const a = E.analyzeFloor(s.project, f.id, {env, cellM: 1}), b = E.analyzeFloor(s.project, f.id, {env, cellM: 1});
        return {id: s.id, floor: f.id, same: JSON.stringify(a) === JSON.stringify(b), coverage: a.coverage_pct, aps: f.aps.length};
      })).flat())""")
    assert all(r["same"] for r in js)
    by_id = {s["id"]: s for s in json.loads((STATIC / "scenarios.json").read_text(encoding="utf-8"))["scenarios"]}
    for r in js:
        py = rfmodel.twin_coverage(twin.validate_twin(by_id[r["id"]]["project"]), 1.0)[r["floor"]]["coverage_pct"] if r["aps"] else None
        if py is not None:
            assert abs(py - r["coverage"]) <= 0.11, r


def test_recommendations_are_deterministic_and_carry_confidence_and_rationale():
    res = run_js("""out(lib.map(s => {
        const f = s.project.floors[0].id, a = O.recommendationsFor(s.project, f, {env, config}), b = O.recommendationsFor(s.project, f, {env, config});
        return {id: s.id, same: JSON.stringify(a) === JSON.stringify(b), recs: a.recommendations.map(r => [r.kind, r.confidence, !!r.rationale, !!r.text, r.confidence_word])};
      }))""")
    kinds = set()
    for r in res:
        assert r["same"], r["id"]
        for kind, conf, rationale, text, word in r["recs"]:
            kinds.add(kind)
            assert 0 <= conf <= 1 and rationale and text and word in ("high", "moderate", "low")
    assert {"ap_placement", "channel", "dead_zone"} <= kinds


def test_sinr_channel_plan_fixes_cochannel_office():
    r = run_js("""const s = lib.find(x => x.id === 'office_floor'); out(O.planChannelsSinr(s.project, 'office', {env, config}))""")
    assert r["changed"] >= 1 and r["sinr_after_db"] > r["sinr_before_db"] and 0 <= r["confidence"] <= 1
    assert len({a["to_channel"] for a in r["assignments"]}) >= 2


def test_mesh_and_explain_payload():
    r = run_js("""const s = lib.find(x => x.id === 'large_home'), p = JSON.parse(JSON.stringify(s.project));
      const mesh = O.suggestMeshNodes(p, 'upper', {env, config}), rec = O.recommendationsFor(p, 'ground', {env, config});
      out({mesh, payload: O.explainPayload(rec)})""")
    assert r["mesh"]["nodes"], "the upper floor of the large home should get a mesh node"
    assert all(n["backhaul_dbm"] >= r["mesh"]["weak_backhaul_dbm"] and n["parent_ap_id"] for n in r["mesh"]["nodes"])
    from wallhack import llm
    llm.validate_planner_payload(r["payload"])
