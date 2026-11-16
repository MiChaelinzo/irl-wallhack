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
