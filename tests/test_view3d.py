import json
import shutil
import subprocess

import pytest

from wallhack.app import STATIC

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")

SCRIPT = """
const v = require(process.argv[1]);
const out = {};
const view = { w: 800, h: 600 }, p = { x: 0, y: 0, depth: 0, scale: 0 };
const cam = { yaw: 0, pitch: 0, dist: 10, fov: 1 };
out.originOk = v.project([0, 0, 0], cam, view, p);
out.origin = [p.x, p.y, p.depth];
out.behind = v.project([0, 0, 20], cam, view, p);
v.project([1, 0, 0], cam, view, p); out.right = p.x;
v.project([0, 1, 0], cam, view, p); out.up = p.y;
v.project([0, 0, 2], cam, {w: 800, h: 600}, p); out.nearScale = p.scale;
v.project([0, 0, -2], cam, {w: 800, h: 600}, p); out.farScale = p.scale;
const a = [0, 0, 0], b = [4, 0, 0], o = [0, 0, 0];
out.arcMid = v.arcPoint(a, b, 0.5, 1, o).slice();
out.arcEnd = v.arcPoint(a, b, 1, 1, o).slice();
out.rects = v.zoneRects(["b", "a"]).map(r => r.zone);
out.quiet = v.volumeHeight(0, 0, false);
out.full = v.volumeHeight(1e6, 0, false);
out.again = v.zoneRects(["b", "a"]).map(r => [r.x0, r.x1]);
out.again2 = v.zoneRects(["a", "b"]).map(r => [r.x0, r.x1]);
out.dust = v.dustParticles(5);
out.dustAgain = v.dustParticles(5);
out.qualities = ["bogus", "high", null].map(q => v.normaliseQuality(q));
out.slow = v.qualityForFrameTime("high", v.SLOW_FRAME_MS + 1);
out.fast = v.qualityForFrameTime("high", 16);
console.log(JSON.stringify(out));
"""


@pytest.fixture(scope="module")
def result():
    res = subprocess.run(["node", "-e", SCRIPT, str(STATIC / "view3d.js")], capture_output=True, text=True)
    assert res.returncode == 0, res.stderr
    return json.loads(res.stdout)


def test_origin_projects_to_screen_centre(result):
    assert result["originOk"] is True
    assert result["origin"] == [400, 300, 10]


def test_point_behind_camera_is_rejected(result):
    assert result["behind"] is False


def test_axes_orientation(result):
    assert result["right"] > 400
    assert result["up"] < 300  # screen y grows downward


def test_perspective_nearer_is_larger(result):
    assert result["nearScale"] > result["farScale"]


def test_arc_hits_endpoints_and_lifts(result):
    assert result["arcEnd"] == [4, 0, 0]
    assert result["arcMid"][1] == pytest.approx(0.5)  # lift 1 at t=0.5 gives 2*0.25*1


def test_zone_layout_is_deterministic_and_sorted(result):
    assert result["rects"] == ["a", "b"]
    assert result["again"] == result["again2"]


def test_volume_height_scales_and_saturates(result):
    assert result["quiet"] < result["full"]
    assert result["full"] == pytest.approx(2.2)


def test_dust_is_seeded_and_inside_room(result):
    assert result["dust"] == result["dustAgain"]
    assert len({d["x"] for d in result["dust"]}) == 5
    assert all(abs(d["x"]) <= 3 and 0 <= d["y"] <= 2.6 and abs(d["z"]) <= 2.5 for d in result["dust"])


def test_quality_helpers(result):
    assert result["qualities"] == ["medium", "high", "medium"]
    assert result["slow"] == "low"
    assert result["fast"] == "high"


TWIN_SCRIPT = """
const v = require(process.argv[1]);
const twin = { floors: [{ width_m: 10, depth_m: 8, height_m: 2.6, level: 0 }, { width_m: 10, depth_m: 8, height_m: 2.5, level: 1 }] };
const ext = v.twinExtent(twin), s = v.twinScale(twin);
console.log(JSON.stringify({
  scale: s, ext,
  centre: v.twinPoint(5, 4, 0, s, ext), corner: v.twinPoint(0, 0, 0, s, ext),
  stacked: [0, 1].map(l => v.floorElevation(twin.floors[l], true, ext, s)),
  single: v.floorElevation(twin.floors[1], false, ext, s),
  span: v.openingSpan({ x1: 0, y1: 0, x2: 10, y2: 0 }, { pos: 2, width: 1 }),
  clipped: v.openingSpan({ x1: 0, y1: 0, x2: 4, y2: 0 }, { pos: 3.5, width: 2 }),
  heat: [-45, -65, -95].map(r => v.heatColor(r)),
}));
"""


def test_twin_geometry_helpers():
    res = subprocess.run(["node", "-e", TWIN_SCRIPT, str(STATIC / "view3d.js")], capture_output=True, text=True)
    assert res.returncode == 0, res.stderr
    out = json.loads(res.stdout)
    assert out["scale"] == pytest.approx(0.6)               # 6 m / 10 m fits the schematic room
    assert out["centre"] == [0, 0, 0]
    assert out["corner"][0] < 0 and out["corner"][2] < 0
    assert out["stacked"][0] == 0 and out["stacked"][1] > 0 and out["single"] == 0
    assert out["span"] == [[2, 0], [3, 0]]
    assert out["clipped"] == [[3.5, 0], [4, 0]]
    assert out["heat"][0] != out["heat"][2]                  # strong and weak signal use different colours


EFFECTS_SCRIPT = """
const v = require(process.argv[1]);
const P = v.QUALITY_PROFILES;
const a = JSON.stringify(v.effectSeeds()), b = JSON.stringify(v.effectSeeds());
console.log(JSON.stringify([
  P.low.flow, P.low.bloom, P.low.dof, P.low.dust, P.medium.flow > 0, P.medium.dof, P.high.flow > P.medium.flow, P.high.bloom, P.high.dof,
  a === b, v.effectSeeds().length,
  v.focusBlur(8, 8), v.focusBlur(100, 8), v.focusBlur(9, 8) < v.focusBlur(12, 8)]));
"""


def test_effects_follow_quality_levels_and_are_deterministic():
    res = subprocess.run(["node", "-e", EFFECTS_SCRIPT, str(STATIC / "view3d.js")], capture_output=True, text=True)
    assert res.returncode == 0, res.stderr
    (low_flow, low_bloom, low_dof, low_dust, med_flow, med_dof, high_more, high_bloom, high_dof,
     same, count, at_focus, far, grows) = json.loads(res.stdout)
    assert low_flow == 0 and not low_bloom and not low_dof and low_dust == 0   # low disables particles and bloom
    assert med_flow and not med_dof and high_more and high_bloom and high_dof
    assert same and count == 64 and at_focus == 0 and far == 1 and grows
