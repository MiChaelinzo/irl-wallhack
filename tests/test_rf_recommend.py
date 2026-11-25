"""What-if diff, recommendation engine and "Design my network" (rf-optimizer.js, run under node).

The optimizer is JavaScript only, so these tests check determinism, that every delta is a measured difference of two
engine runs, and that the plan payload keeps the number grounding of POST /api/planner/explain. The LLM reply path is
mock tested only: real model output is UNVERIFIED in this repository."""
import json
import shutil
import subprocess

import pytest

from tests.test_explain import fake_opener
from wallhack import llm, rfmodel, twin
from wallhack.app import STATIC

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")

PRELUDE = """
const E = require(process.argv[1] + '/rf-engine.js'), O = require(process.argv[1] + '/rf-optimizer.js');
const config = JSON.parse(require('fs').readFileSync(0, 'utf8')), env = E.makeEnv(config);
const lib = JSON.parse(require('fs').readFileSync(process.argv[1] + '/scenarios.json', 'utf8')).scenarios;
const scenario = (id) => lib.find(s => s.id === id);
const out = (v) => console.log(JSON.stringify(v));
"""


def run_js(body):
    res = subprocess.run(["node", "-e", PRELUDE + body, str(STATIC)], capture_output=True, text=True, input=json.dumps(rfmodel.CONFIG))
    assert res.returncode == 0, res.stderr
    return json.loads(res.stdout)


def test_whatif_kinds_measure_before_and_after_and_do_not_touch_the_input():
    r = run_js("""
      const p = scenario('large_home').project, snapshot = JSON.stringify(p), opts = {env, config};
      const changes = [
        {kind: 'move_ap', ap_id: 'router', x: 8, y: 5},
        {kind: 'upgrade_standard', ap_id: 'router', standard: 'wifi7'},
        {kind: 'upgrade_profile', ap_id: 'router', profile_id: 'enterprise'},
        {kind: 'remove_wall', floor: 'ground', wall_id: p.floors[0].walls.find(w => w.kind === 'interior').id},
        {kind: 'add_mesh_node', floor: 'upper', x: 8, y: 5, parent_ap_id: 'router'},
        {kind: 'set_channels', assignments: [{ap_id: 'router', channel: 11}]}];
      out({same: JSON.stringify(p) === snapshot, runs: changes.map(c => O.whatIf(p, 'ground', c, opts)), mesh: O.whatIf(p, 'ground', changes[4], Object.assign({floor: 'upper'}, opts))});
    """)
    assert r["same"]
    for w in r["runs"]:
        assert set(w["delta"]) == {"coverage_pct", "dead_zone_pct", "mean_throughput_mbps", "client_capacity", "score", "optimiser_score"}
        for k, v in w["delta"].items():
            assert v == pytest.approx(w["after"][k] - w["before"][k], abs=0.011), (w["change"]["kind"], k)
        assert 0 <= w["confidence"] <= 1
    assert r["mesh"]["floor"] == "upper" and r["mesh"]["delta"]["coverage_pct"] > 0 and r["mesh"]["confidence"] > 0
    assert r["runs"][3]["delta"]["coverage_pct"] >= 0, "removing a wall cannot lower coverage"


def test_whatif_rejects_bad_changes():
    r = run_js("""
      const p = scenario('small_apartment').project;
      const bad = [{kind: 'teleport'}, {kind: 'move_ap', ap_id: 'nope', x: 1, y: 1}, {kind: 'remove_wall', floor: 'main', wall_id: 'nope'},
                   {kind: 'upgrade_standard', ap_id: 'router', standard: 'wifi99'}];
      out(bad.map(c => { try { O.whatIf(p, 'main', c, {env, config}); return 'accepted'; } catch (e) { return e.message; } }));
    """)
    assert all(m != "accepted" for m in r), r


def test_recommendations_are_deterministic_ranked_and_each_has_a_measured_delta():
    r = run_js("""
      out(['small_apartment', 'large_home', 'office_floor', 'hospital_ward', 'smart_home', 'apartment_neighbours'].map(id => {
        const s = scenario(id), f = s.project.floors[0].id, a = O.recommend(s.project, f, {env, config}), b = O.recommend(s.project, f, {env, config});
        const checks = a.actions.map(x => {
          const again = O.whatIf(s.project, f, x.change, {env, config, floor: x.floor});
          return {id: x.id, same: JSON.stringify(again.delta) === JSON.stringify(x.delta)};
        });
        return {id, same: JSON.stringify(a) === JSON.stringify(b), score: a.score, actions: a.actions, checks};
      }))
    """)
    total = 0
    for s in r:
        assert s["same"], s["id"]
        assert 0 <= s["score"] <= 100
        assert all(c["same"] for c in s["checks"]), s["id"]
        gains = [a["delta"]["score"] for a in s["actions"]]
        assert gains == sorted(gains, reverse=True), s["id"]
        min_gain = rfmodel.CONFIG["recommendations"]["min_score_gain"]
        for a in s["actions"]:
            total += 1
            assert a["delta"]["score"] >= min_gain and a["text"] and 0 <= a["confidence"] <= 1 and a["rank"] >= 1
            assert a["after"]["score"] - a["before"]["score"] == pytest.approx(a["delta"]["score"], abs=0.011)
    assert total >= 3
    by_id = {s["id"]: s for s in r}
    assert any(a["kind"] == "add_mesh_node" and a["floor"] == "upper" for a in by_id["large_home"]["actions"]), "mesh node upstairs"
    assert any(a["kind"] == "set_channels" and a["text"].startswith("Reduce interference on channel") for a in by_id["hospital_ward"]["actions"] + by_id["office_floor"]["actions"])


def test_design_network_is_deterministic_and_reaches_the_target_on_a_blank_floor():
    r = run_js("""
      const s = scenario('large_home'), p = JSON.parse(JSON.stringify(s.project)), snapshot = JSON.stringify(p);
      const a = O.designNetwork(p, 'ground', {env, config}), b = O.designNetwork(p, 'ground', {env, config});
      const wall = O.designNetwork(scenario('warehouse').project, 'hall', {env, config});
      out({same: JSON.stringify(a) === JSON.stringify(b), untouched: JSON.stringify(p) === snapshot, plan: a, warehouse: wall});
    """)
    assert r["same"] and r["untouched"]
    plan = r["plan"]
    assert plan["reached"] and plan["after"]["coverage_pct"] >= plan["target_pct"]
    assert all({"id", "x", "y", "tx_dbm", "band", "standard", "channel", "pattern"} <= set(a) for a in plan["aps"])
    assert [m["floor"] for m in plan["mesh_nodes"]] == ["upper"] and plan["mesh_nodes"][0]["backhaul_dbm"] >= rfmodel.CONFIG["planner_modes"]["mesh"]["weak_backhaul_dbm"]
    assert "MODEL ESTIMATE" in plan["text"] and len(r["warehouse"]["aps"]) >= 1
    assert all(a["pattern"] == "sector" for a in plan["aps"] if "azimuth_deg" in a)


def test_new_presets_exist_with_their_story():
    r = run_js("""out({ids: lib.map(s => s.id),
      hospital: scenario('hospital_ward').project.floors[0].aps.map(a => a.channel),
      flat: scenario('apartment_neighbours').project.interferers.length,
      home: scenario('smart_home').project.floors.map(f => [f.aps.length, (f.clients || []).length])})""")
    assert {"hospital_ward", "smart_home", "apartment_neighbours"} <= set(r["ids"])
    assert len(set(r["hospital"])) == 1 and len(r["hospital"]) == 3
    assert r["flat"] == 3 and r["home"] == [[1, 4], [0, 2]]


# ---------------------------------------------------------------- narration through POST /api/planner/explain
def plan_payload():
    return run_js("out(O.planPayload(O.designNetwork(scenario('large_home').project, 'ground', {env, config})))")


def test_plan_payload_is_valid_and_the_rule_text_is_grounded():
    payload = plan_payload()
    clean = llm.validate_planner_payload(payload)
    out = llm.explain_planner(payload, "")
    assert out["source"] == "rules" and "MODEL ESTIMATE" in out["explanation"]
    assert llm.ungrounded_numbers(out["explanation"], clean) == []


def test_mocked_llm_reply_with_invented_numbers_falls_back_to_rules():
    payload = plan_payload()
    metrics = {m["label"]: m["value"] for m in payload["metrics"]}
    good = f"The plan uses {metrics['Access points']} access points and lifts coverage to {metrics['Coverage after']}%. Estimate only."
    ok = llm.explain_planner(payload, "ollama", opener=fake_opener(good))
    assert ok["source"] == "llm"
    bad = llm.explain_planner(payload, "ollama", opener=fake_opener("Coverage reaches 99.9% with 7 access points."))
    assert bad["source"] == "rules" and bad["rejected_numbers"]
