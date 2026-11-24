"""Signal timeline and handoff events: Python (rfmodel.signal_timeline) is the reference, rf-engine.js must match exactly."""
import copy
import json
import shutil
import subprocess

import pytest

from tests.test_rf_parity import random_project
from wallhack import rfmodel, twin
from wallhack.app import STATIC

needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
ROAM_MIN = rfmodel.ANALYTICS["roam_min_dbm"]


def corridor(aps):
    """One 30 m x 6 m floor, no walls, the given (x, y) APs on channel defaults."""
    return {"name": "corridor", "units": "m", "floors": [{
        "id": "g", "name": "g", "level": 0, "height_m": 2.5, "width_m": 30.0, "depth_m": 6.0, "rooms": [], "walls": [],
        "openings": [], "furniture": [], "sensors": [],
        "aps": [{"id": f"ap{i}", "x": x, "y": y, "tx_dbm": 18.0} for i, (x, y) in enumerate(aps)]}]}


WALK = [{"floor": "g", "x": 1.0, "y": 3.0}, {"floor": "g", "x": 29.0, "y": 3.0}]


def test_samples_are_fixed_step_and_end_on_the_waypoint():
    res = rfmodel.signal_timeline(corridor([(5.0, 3.0), (25.0, 3.0)]), WALK, step_m=2.0)
    s = res["samples"]
    assert [x["s_m"] for x in s[:3]] == [0.0, 2.0, 4.0] and s[-1]["s_m"] == 28.0 and s[-1]["x"] == 29.0
    assert res["summary"]["length_m"] == 28.0 and res["summary"]["samples"] == len(s) == 15


def test_walk_between_two_aps_hands_off_once_with_hysteresis():
    res = rfmodel.signal_timeline(corridor([(5.0, 3.0), (25.0, 3.0)]), WALK)
    handoffs = [e for e in res["events"] if e["kind"] == "handoff"]
    assert len(handoffs) == 1 and (handoffs[0]["from_ap"], handoffs[0]["to_ap"]) == ("ap0", "ap1")
    # the client is sticky: it leaves only when the new AP wins by the hysteresis, so there is a gap
    assert handoffs[0]["to_rssi_dbm"] - handoffs[0]["from_rssi_dbm"] >= rfmodel.TIMELINE["hysteresis_db"]
    assert res["summary"]["sticky_samples"] > 0 and res["summary"]["max_sticky_gap_db"] > 0
    assert any(x["in_handoff_zone"] for x in res["samples"])
    assert res["samples"][0]["ap_id"] == "ap0" and res["samples"][-1]["ap_id"] == "ap1"


def test_larger_hysteresis_delays_the_handoff():
    twin_ = corridor([(5.0, 3.0), (25.0, 3.0)])
    early = rfmodel.signal_timeline(twin_, WALK, hysteresis_db=0.0)["events"]
    late = rfmodel.signal_timeline(twin_, WALK, hysteresis_db=12.0)["events"]
    assert early[0]["s_m"] < late[0]["s_m"]


def test_single_ap_never_hands_off_and_no_aps_is_no_signal():
    one = rfmodel.signal_timeline(corridor([(5.0, 3.0)]), WALK)
    assert one["summary"]["handoffs"] == 0 and not any(s["in_handoff_zone"] for s in one["samples"])
    none = rfmodel.signal_timeline(corridor([]), WALK)
    assert none["summary"]["dead_samples_pct"] == 100.0 and all(s["ap_id"] is None for s in none["samples"])


def test_coverage_lost_and_regained_events():
    far = corridor([(1.0, 3.0)])
    far["floors"][0]["width_m"] = 400.0
    path = [{"floor": "g", "x": 1.0, "y": 3.0}, {"floor": "g", "x": 300.0, "y": 3.0}, {"floor": "g", "x": 1.0, "y": 3.0}]
    res = rfmodel.signal_timeline(far, path, band="5", step_m=1.0)
    assert [e["kind"] for e in res["events"]] == ["coverage_lost", "coverage_regained"]
    assert res["events"][0]["rssi_dbm"] < rfmodel.ANALYTICS["dead_zone_dbm"] <= res["events"][1]["rssi_dbm"]


def test_floor_change_is_a_jump_and_input_is_validated():
    d = twin.sample_twin()
    a, b = d["floors"][0], d["floors"][1]
    path = [{"floor": a["id"], "x": 2.0, "y": 2.0}, {"floor": b["id"], "x": 2.0, "y": 2.0}]
    res = rfmodel.signal_timeline(d, path)
    assert [s["floor"] for s in res["samples"]] == [a["id"], b["id"]] and res["summary"]["length_m"] == 0.0
    for bad in ([], [{"floor": "nope", "x": 1, "y": 1}]):
        with pytest.raises((ValueError, KeyError)):
            rfmodel.signal_timeline(d, bad)
    with pytest.raises(ValueError):
        rfmodel.signal_timeline(corridor([(5.0, 3.0)]), WALK, step_m=0.0)
    with pytest.raises(ValueError):
        rfmodel.signal_timeline(corridor([(5.0, 3.0)]), WALK, step_m=0.001)


def test_timeline_is_deterministic():
    d = twin.sample_twin()
    f = d["floors"][0]
    path = [{"floor": f["id"], "x": 1.0, "y": 1.0}, {"floor": f["id"], "x": f["width_m"] - 1, "y": f["depth_m"] - 1}]
    assert json.dumps(rfmodel.signal_timeline(d, path)) == json.dumps(rfmodel.signal_timeline(copy.deepcopy(d), path))


def paths_for(project):
    out = []
    for f in project["floors"]:
        w, d = f["width_m"], f["depth_m"]
        out.append([{"floor": f["id"], "x": 0.5, "y": 0.5}, {"floor": f["id"], "x": w * 0.6, "y": d * 0.4}, {"floor": f["id"], "x": w - 0.5, "y": d - 0.5}])
    if len(project["floors"]) > 1:
        a, b = project["floors"][0], project["floors"][1]
        out.append([{"floor": a["id"], "x": 1.0, "y": 1.0}, {"floor": a["id"], "x": a["width_m"] / 2, "y": a["depth_m"] / 2},
                    {"floor": b["id"], "x": b["width_m"] / 2, "y": b["depth_m"] / 2}, {"floor": b["id"], "x": 1.0, "y": 1.0}])
    return out


@needs_node
def test_javascript_timeline_matches_python_exactly():
    projects = [twin.sample_twin(), random_project(5, 30), random_project(6, 60), corridor([(5.0, 3.0), (25.0, 3.0)])]
    jobs = [{"project": p, "path": path, "band": band, "mode": mode}
            for p in projects for path in (paths_for(p) if len(p["floors"]) else [WALK])
            for band, mode in ((None, "basic"), ("5", "enhanced"), ("6", "multipath"))]
    js = """
      const E = require(process.argv[1] + '/rf-engine.js');
      const P = JSON.parse(require('fs').readFileSync(0, 'utf8')), env = E.makeEnv(P.config);
      console.log(JSON.stringify(P.jobs.map(j => E.signalTimeline(j.project, j.path, {env, band: j.band || undefined, mode: j.mode}))));
    """
    res = subprocess.run(["node", "-e", js, str(STATIC)], capture_output=True, text=True,
                         input=json.dumps({"config": rfmodel.CONFIG, "jobs": jobs}))
    assert res.returncode == 0, res.stderr
    got = json.loads(res.stdout)
    assert len(got) == len(jobs) >= 9
    handoffs = 0
    for job, js_res in zip(jobs, got):
        py = rfmodel.signal_timeline(job["project"], job["path"], job["band"], job["mode"])
        py["band"] = job["band"]
        assert js_res["events"] == py["events"], (job["band"], job["mode"])
        assert js_res["samples"] == py["samples"]
        assert js_res["summary"] == py["summary"]
        handoffs += py["summary"]["handoffs"]
    assert handoffs > 0, "the parity jobs must include at least one handoff"
