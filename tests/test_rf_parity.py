"""The browser RF engine (static/rf-engine.js) must match wallhack.rfmodel (the source of truth)."""
import json
import random
import shutil
import subprocess

import pytest

from wallhack import rfmodel, twin
from wallhack.app import STATIC

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")

TOLERANCE_DB = 0.1 + 1e-9
BANDS = ("2.4", "5", "6")
MODES = ("basic", "enhanced", "multipath")
MATERIALS = list(rfmodel.CONFIG["materials"])

SCRIPT = """
const E = require(process.argv[1]);
const { config, jobs } = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const env = E.makeEnv(config);
const out = jobs.map(j => {
  if (j.kind === 'compare_index') {
    const floor = j.project.floors[0], opts = { env, cellM: j.cell_m, mode: j.mode, band: j.band };
    const a = E.coverageGrid(j.project, floor.id, opts);
    const b = E.coverageGrid(j.project, floor.id, Object.assign({ brute: true }, opts));
    const ga = E.computeApGrid(floor, floor.aps[0], opts), gb = E.computeApGrid(floor, floor.aps[0], Object.assign({ brute: true }, opts));
    return { same: JSON.stringify(a) === JSON.stringify(b) && ga.every((v, i) => v === gb[i]) };
  }
  return E.coverageGrid(j.project, j.floor, { env, cellM: j.cell_m, band: j.band, mode: j.mode });
});
console.log(JSON.stringify(out));
"""


def run_node(jobs):
    res = subprocess.run(["node", "-e", SCRIPT, str(STATIC / "rf-engine.js")], capture_output=True, text=True,
                         input=json.dumps({"config": rfmodel.CONFIG, "jobs": jobs}))
    assert res.returncode == 0, res.stderr
    return json.loads(res.stdout)


def random_project(seed, n_walls, width=24.0, depth=16.0, grid=0.5):
    """Seeded layout on two floors with mixed materials, openings and per-AP bands."""
    rng = random.Random(seed)

    def snap(v, hi):
        return round(min(max(v, 0.0), hi) / grid) * grid + rng.choice((0.0, 0.013))

    floors = []
    for level, fid in enumerate(("f0", "f1")):
        walls = []
        for i in range(n_walls):
            x1, y1 = snap(rng.uniform(0, width), width - 1), snap(rng.uniform(0, depth), depth - 1)
            horizontal = rng.random() < 0.5
            length = rng.uniform(1.0, 8.0)
            x2, y2 = (min(x1 + length, width), y1 + 0.37 * rng.random()) if horizontal else (x1 + 0.21 * rng.random(), min(y1 + length, depth))
            if rng.random() < 0.7:
                walls.append({"id": f"{fid}-w{i}", "x1": x1, "y1": y1, "x2": x2, "y2": y2,
                              "kind": rng.choice(("interior", "exterior")), "material": rng.choice(MATERIALS)})
            else:
                walls.append({"id": f"{fid}-w{i}", "x1": x1, "y1": y1, "x2": x2, "y2": y2,
                              "kind": rng.choice(("interior", "exterior"))})
        openings = []
        for i, w in enumerate(walls[: n_walls // 5]):
            length = ((w["x2"] - w["x1"]) ** 2 + (w["y2"] - w["y1"]) ** 2) ** 0.5
            if length > 1.2:
                openings.append({"id": f"{fid}-o{i}", "kind": rng.choice(("door", "window")), "wall": w["id"],
                                 "pos": round(length * 0.3, 3), "width": 0.9})
        aps = [{"id": f"{fid}-ap{i}", "x": rng.uniform(1, width - 1), "y": rng.uniform(1, depth - 1),
                "tx_dbm": rng.choice((15.0, 20.0)), "band": rng.choice(BANDS)} for i in range(2)]
        floors.append({"id": fid, "name": fid, "level": level, "height_m": 2.5, "width_m": width, "depth_m": depth,
                       "rooms": [], "walls": walls, "openings": openings, "furniture": [], "sensors": [], "aps": aps})
    return {"name": f"random-{seed}", "units": "m", "floors": floors}


def assert_grids_match(py, js, label):
    assert (py["cols"], py["rows"]) == (js["cols"], js["rows"]), label
    worst = max(abs(a - b) for pr, jr in zip(py["rssi"], js["rssi"]) for a, b in zip(pr, jr))
    assert worst <= TOLERANCE_DB, f"{label}: worst difference {worst} dB"
    assert abs(py["coverage_pct"] - js["coverage_pct"]) <= 100.0 * 2 / (py["cols"] * py["rows"]) + 0.1, label
    assert py.get("mode") == js.get("mode") and py.get("band") == js.get("band")


def build_jobs(projects, cell_m, combos):
    return [{"kind": "grid", "project": p, "floor": f["id"], "cell_m": cell_m, "band": band, "mode": mode}
            for p in projects for f in p["floors"] for band, mode in combos]


def check(projects, cell_m, combos):
    jobs = build_jobs(projects, cell_m, combos)
    got = run_node(jobs)
    for job, js in zip(jobs, got):
        py = rfmodel.coverage_grid(job["project"], job["floor"], cell_m, band=job["band"], mode=job["mode"])
        assert_grids_match(py, js, f"{job['project']['name']}/{job['floor']}/{job['band']}/{job['mode']}")
    return len(jobs)


def test_sample_twin_all_bands_and_modes():
    combos = [(b, m) for b in BANDS for m in MODES] + [(None, "basic"), (None, "multipath")]
    assert check([twin.sample_twin()], 0.5, combos) == 2 * len(combos)


def test_random_layouts_all_bands_and_modes():
    projects = [random_project(1, 30), random_project(2, 60)]
    combos = [(b, m) for b in BANDS for m in MODES] + [(None, "enhanced")]
    check(projects, 2.0, combos)


def test_random_layout_with_150_walls():
    check([random_project(3, 150)], 2.5, [("5", "multipath"), (None, "enhanced"), ("2.4", "basic")])


def test_spatial_index_equals_brute_force_on_1000_walls():
    project = random_project(4, 1000, width=60.0, depth=40.0)
    project["floors"] = project["floors"][:1]
    jobs = [{"kind": "compare_index", "project": project, "cell_m": 4.0, "mode": m, "band": b}
            for m, b in (("basic", None), ("enhanced", "5"), ("multipath", "6"))]
    assert [r["same"] for r in run_node(jobs)] == [True, True, True]


def test_js_rejects_bad_band_and_mode():
    jobs = [{"kind": "grid", "project": twin.sample_twin(), "floor": "ground", "cell_m": 1.0, "band": "9", "mode": "basic"}]
    res = subprocess.run(["node", "-e", SCRIPT, str(STATIC / "rf-engine.js")], capture_output=True, text=True,
                         input=json.dumps({"config": rfmodel.CONFIG, "jobs": jobs}))
    assert res.returncode != 0 and "band must be one of" in res.stderr


def test_js_diffraction_matches_python_on_knife_edge_geometry():
    """A thin metal wall with its end 1 m off the line of sight: the diffracted path decides the level."""
    f = {"id": "f", "name": "F", "level": 0, "width_m": 24.0, "depth_m": 24.0, "rooms": [], "furniture": [],
         "sensors": [], "openings": [], "aps": [{"id": "a", "x": 2.5, "y": 10.5, "tx_dbm": 20.0}],
         "walls": [{"id": "m", "x1": 12.5, "y1": 5.5, "x2": 12.5, "y2": 9.5, "kind": "interior", "material": "metal"}]}
    project = {"name": "knife", "units": "m", "floors": [f]}
    expected = rfmodel.rssi_from_ap(f["aps"][0], f, f, 22.5, 7.5, mode="enhanced")
    grid = run_node([{"kind": "grid", "project": project, "floor": "f", "cell_m": 1.0, "band": "2.4", "mode": "enhanced"}])[0]
    assert grid["rssi"][7][22] == pytest.approx(expected, abs=TOLERANCE_DB)
