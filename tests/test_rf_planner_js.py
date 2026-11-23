"""JS analytics, probe, scenario comparison and Smart WiFi Planner (pytest spawns node)."""
import json
import shutil
import subprocess

import pytest

from tests.test_rf_parity import BANDS, random_project
from wallhack import rfmodel, twin
from wallhack.app import STATIC

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")

PRELUDE = """
const E = require(process.argv[1] + '/rf-engine.js'), O = require(process.argv[1] + '/rf-optimizer.js');
const P = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const config = P.config, env = E.makeEnv(config);
const out = (v) => console.log(JSON.stringify(v));
"""


def run_js(body, payload=None):
    data = dict(payload or {}, config=rfmodel.CONFIG)
    res = subprocess.run(["node", "-e", PRELUDE + body, str(STATIC)], capture_output=True, text=True, input=json.dumps(data))
    assert res.returncode == 0, res.stderr
    return json.loads(res.stdout)


def open_project(width, depth, aps, walls=()):
    return {"name": "open", "units": "m", "floors": [{
        "id": "g", "name": "g", "level": 0, "height_m": 2.5, "width_m": float(width), "depth_m": float(depth), "rooms": [],
        "walls": [dict(w) for w in walls], "openings": [], "furniture": [], "sensors": [],
        "aps": [{"id": f"ap{i}", "x": x, "y": y, "tx_dbm": tx} for i, (x, y, tx) in enumerate(aps)]}]}


def assert_close(py, js, path="$"):
    if isinstance(py, dict):
        assert py.keys() == js.keys(), path
        for k in py:
            assert_close(py[k], js[k], f"{path}.{k}")
    elif isinstance(py, list):
        assert len(py) == len(js), path
        for i, (p, j) in enumerate(zip(py, js)):
            assert_close(p, j, f"{path}[{i}]")
    elif isinstance(py, float) or isinstance(js, float):
        assert abs(py - js) <= 0.11, f"{path}: {py} vs {js}"
    else:
        assert py == js, path


def test_analytics_parity_with_python():
    projects = [twin.sample_twin(), random_project(5, 30), random_project(6, 60)]
    jobs = [(p, f["id"], band, mode, cell) for p in projects for f in p["floors"]
            for band, mode, cell in ((None, "basic", 1.0), ("5", "enhanced", 2.0), ("6", "multipath", 2.0))]
    got = run_js("out(P.jobs.map(j => E.analyzeFloor(j[0], j[1], {env, cellM: j[4], band: j[2], mode: j[3]})))", {"jobs": jobs})
    for (p, fid, band, mode, cell), js in zip(jobs, got):
        py = rfmodel.analyze_floor(p, fid, cell, band, mode)
        # best-AP index and tie breaks are exact, dB-derived values may differ by one rounding step
        assert_close({k: v for k, v in py.items() if k not in ("throughput_mbps", "best_ap")},
                     {k: v for k, v in js.items() if k not in ("throughput_mbps", "best_ap")}, f"{p['name']}/{fid}/{band}/{mode}")
        mismatched = sum(a != b for pr, jr in zip(py["best_ap"], js["best_ap"]) for a, b in zip(pr, jr))
        assert mismatched <= 0.01 * py["cols"] * py["rows"]


def test_probe_parity_with_python():
    projects = [twin.sample_twin(), random_project(7, 40)]
    points = [(1.0, 1.0), (5.3, 4.2), (9.1, 7.7), (12.4, 3.3), (0.2, 7.9)]
    jobs = [(p, f["id"], x, y, band, mode) for p in projects for f in p["floors"] for x, y in points
            for band, mode in ((None, "basic"), ("5", "enhanced"))]
    got = run_js("out(P.jobs.map(j => E.probeAt(j[0], j[1], j[2], j[3], {env, band: j[4], mode: j[5]})))", {"jobs": jobs})
    for (p, fid, x, y, band, mode), js in zip(jobs, got):
        assert_close(rfmodel.probe_at(p, fid, x, y, band, mode), js, f"{p['name']}/{fid}/{x},{y}")


def test_analytics_and_planner_are_deterministic():
    project = open_project(20, 10, [(1, 1, 20.0)])
    body = """
const run = () => ({a: E.analyzeFloor(P.p, 'g', {env, cellM: 1}), s: O.suggestPlacements(P.p, 'g', {config}),
  c: O.recommendApCount(P.p, 'g', 90, 5, {config}), w: O.detectPowerIssues(P.p, 'g', {config}),
  h: O.planChannels(P.p, 'g', {config}), i: O.detectIssues(P.p, 'g', {config})});
out(JSON.stringify(run()) === JSON.stringify(run()));
"""
    assert run_js(body, {"p": project}) is True


def test_scenario_deltas_sum_and_score_breakdown():
    before = open_project(20, 10, [(1, 1, 5.0)])
    after = open_project(20, 10, [(1, 1, 5.0), (15, 5, 5.0)])
    r = run_js("out(E.compareScenarios(P.a, P.b, {env, floorId: 'g', cellM: 1}))", {"a": before, "b": after})
    flat = lambda rows: [v for row in rows for v in row]
    cov_a = rfmodel.coverage_grid(before, "g", 1.0)["rssi"]
    cov_b = rfmodel.coverage_grid(after, "g", 1.0)["rssi"]
    assert sum(flat(r["delta_db"])) == pytest.approx(sum(flat(cov_b)) - sum(flat(cov_a)), abs=0.5)
    assert r["coverage_delta_pct"] == pytest.approx(r["b"]["analytics"]["coverage_pct"] - r["a"]["analytics"]["coverage_pct"], abs=0.01)
    assert r["coverage_delta_pct"] > 0 and r["ap_count_delta"] == 1
    for side in ("a", "b"):
        score = r[side]["score"]
        assert score["score"] == pytest.approx(sum(p["contribution"] for p in score["breakdown"]), abs=0.02)
        assert {p["id"] for p in score["breakdown"]} == set(rfmodel.CONFIG["scoring"]["weights"])
    assert r["score_delta"] == pytest.approx(r["b"]["score"]["score"] - r["a"]["score"]["score"], abs=0.01)
    assert r["score_delta"] > 0


def test_scenario_size_mismatch_is_an_error():
    res = subprocess.run(["node", "-e", PRELUDE + "E.compareScenarios(P.a, P.b, {env, floorId: 'g', cellM: 1})", str(STATIC)],
                         capture_output=True, text=True, input=json.dumps({"a": open_project(20, 10, [(1, 1, 20.0)]),
                                                                          "b": open_project(10, 10, [(1, 1, 20.0)]), "config": rfmodel.CONFIG}))
    assert res.returncode != 0 and "same floor size" in res.stderr


def corner_project():
    """30 x 12 m floor, one weak AP in the north-west corner and two concrete walls."""
    return open_project(30, 12, [(1, 1, 8.0)], walls=[
        {"id": "w1", "x1": 9.0, "y1": 0.0, "x2": 9.0, "y2": 9.0, "kind": "interior", "material": "concrete"},
        {"id": "w2", "x1": 18.0, "y1": 3.0, "x2": 18.0, "y2": 12.0, "kind": "interior", "material": "concrete"}])


def test_router_in_corner_gets_a_placement_in_the_weak_area():
    project = corner_project()
    r = run_js("""
const s = O.suggestPlacements(P.p, 'g', {config});
const probes = s.recommendations.map(x => E.probeAt(P.p, 'g', x.x, x.y, {env}));
out({s, probes});""", {"p": project})
    s = r["s"]
    assert s["coverage_pct"] < 95 and s["coverage_after_pct"] > s["coverage_pct"]
    first = s["recommendations"][0]
    assert first["gain_pct"] > 0 and 0.0 <= first["confidence"] <= 1.0 and first["perturbations"] == 8
    assert r["probes"][0]["rssi_dbm"] < rfmodel.CONFIG["analytics"]["coverage_dbm"]  # it was uncovered before
    assert rfmodel.probe_at(project, "g", first["x"], first["y"])["rssi_dbm"] < rfmodel.CONFIG["analytics"]["coverage_dbm"]
    assert "not real-world accuracy" in first["reason"]


def test_candidate_count_is_bounded():
    r = run_js("""
const big = P.p; big.floors[0].width_m = 200; big.floors[0].depth_m = 200;
const s = O.suggestPlacements(big, 'g', {config, count: 1});
out({n: s.recommendations.length});""", {"p": corner_project()})
    assert r["n"] <= 1


def test_ap_count_is_monotonic_in_target():
    project = corner_project()
    r = run_js("out([50, 70, 85, 95, 100].map(t => O.recommendApCount(P.p, 'g', t, 8, {config})))", {"p": project})
    totals = [x["total_aps"] for x in r]
    assert totals == sorted(totals)
    assert all(0.0 <= x["confidence"] <= 1.0 for x in r)
    assert r[0]["reached"] and "Estimated" in r[0]["message"] or "already" in r[0]["message"]
    tight = run_js("out(O.recommendApCount(P.p, 'g', 100, 1, {config}))", {"p": project})
    assert tight["total_aps"] == 1 and not tight["reached"] and "Best effort" in tight["message"]


def test_overpowered_and_underpowered_findings():
    small = open_project(6, 4, [(3, 2, 20.0)])
    r = run_js("out(O.detectPowerIssues(P.p, 'g', {config}))", {"p": small})
    assert [f["ap_id"] for f in r["overpowered"]] == ["ap0"] and r["underpowered"] == []
    assert r["overpowered"][0]["to_tx_dbm"] == 20.0 - rfmodel.CONFIG["planner"]["power_step_db"]
    assert 0.0 <= r["overpowered"][0]["confidence"] <= 1.0

    corridor = open_project(30, 6, [(1, 3, 10.0)])
    r = run_js("out(O.detectPowerIssues(P.p, 'g', {config}))", {"p": corridor})
    assert r["overpowered"] == []
    under = r["underpowered"][0]
    assert under["ap_id"] == "ap0" and under["to_tx_dbm"] == rfmodel.CONFIG["planner"]["max_tx_dbm"]
    assert under["coverage_after_pct"] > under["coverage_before_pct"] and 0.0 <= under["confidence"] <= 1.0

    long_hall = open_project(80, 6, [(1, 3, 10.0)])
    r = run_js("out(O.detectPowerIssues(P.p, 'g', {config}))", {"p": long_hall})
    assert r["underpowered"] and r["underpowered"][0]["closes_deficit"] is False
    assert r["underpowered"][0]["fallback"] == "add_ap" and "add an AP" in r["underpowered"][0]["text"]


def test_fragile_recommendation_has_lower_confidence_than_robust_one():
    project = corner_project()
    r = run_js("""
const robust = O.suggestPlacements(P.p, 'g', {config, count: 1}).recommendations[0];
let fragile = null;
for (let x = 0.5; x < 30; x += 3) { for (let y = 0.5; y < 12; y += 3) {
  const e = O.evaluatePlacement(P.p, 'g', x, y, {config});
  if (e.gain_pct > 0 && (!fragile || e.gain_pct < fragile.gain_pct)) { fragile = e; }
} }
const none = O.evaluatePlacement(P.covered, 'g', 1.5, 1.5, {config});
out({robust, fragile, none});""", {"p": project, "covered": open_project(6, 4, [(3, 2, 20.0)])})
    assert 0.0 <= r["fragile"]["confidence"] < r["robust"]["confidence"] <= 1.0
    assert r["none"]["gain_pct"] == 0 and r["none"]["confidence"] == 0.0


def test_channel_plan_separates_neighbours():
    project = open_project(10, 6, [(2, 3, 20.0), (8, 3, 20.0), (5, 5, 20.0)])
    r = run_js("out(O.planChannels(P.p, 'g', {config}))", {"p": project})
    assert r["conflicts_before"] > r["conflicts_after"] == 0
    assert {a["to_channel"] for a in r["assignments"]} <= {1, 6, 11}
    assert len({a["to_channel"] for a in r["assignments"]}) == 3


def test_detect_issues_reports_dead_zone_and_cochannel():
    project = corner_project()
    project["floors"][0]["aps"].append({"id": "ap1", "x": 5.0, "y": 8.0, "tx_dbm": 8.0})
    r = run_js("out(O.detectIssues(P.p, 'g', {config}))", {"p": project})
    kinds = {i["kind"] for i in r["issues"]}
    assert "dead_zone" in kinds and "cochannel" in kinds
    assert r["issues"][0]["severity"] == "high"
    assert all(set(BANDS) >= {"2.4"} and i["text"] for i in r["issues"])


def test_analyze_floor_with_grid_matches_separate_calls():
    """The worker reuses the analysis's coverage grid for map layers (perf, FEAT-005); it must equal a separate coverageGrid."""
    proj = random_project(11, 40)
    fid = proj["floors"][0]["id"]
    got = run_js("""const s = {env, cellM: 1}, w = E.analyzeFloorWithGrid(P.p, P.f, s);
out({same_analytics: JSON.stringify(w.analytics) === JSON.stringify(E.analyzeFloor(P.p, P.f, s)),
     same_grid: JSON.stringify(w.grid) === JSON.stringify(E.coverageGrid(P.p, P.f, s))});""", {"p": proj, "f": fid})
    assert got == {"same_analytics": True, "same_grid": True}
