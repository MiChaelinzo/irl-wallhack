"""Pure parts of planner-heat.js: colour scales, quality bands, contours, legend and tooltip text (node)."""
import json
import shutil
import subprocess

import pytest

from wallhack import rfmodel
from wallhack.app import STATIC

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")

PRELUDE = """
const H = require(process.argv[1] + '/planner-heat.js'), E = require(process.argv[1] + '/rf-engine.js');
const P = JSON.parse(require('fs').readFileSync(0, 'utf8')), config = P.config;
const out = (v) => console.log(JSON.stringify(v));
"""


def run_js(body, payload=None):
    res = subprocess.run(["node", "-e", PRELUDE + body, str(STATIC)], capture_output=True, text=True,
                         input=json.dumps(dict(payload or {}, config=rfmodel.CONFIG)))
    assert res.returncode == 0, res.stderr
    return json.loads(res.stdout)


def test_band_lookup_matches_the_python_quality_bands():
    r = run_js("out(P.samples.map(v => [v, H.bandOf(config, v), E.qualityBand(config, v)]))", {"samples": [-30, -55, -55.1, -65, -70, -75, -80, -85, -85.1, -119]})
    assert all(js == engine for _, js, engine in r)
    assert [rfmodel.quality_band(v) for v, _, _ in r] == [js for _, js, _ in r]


def test_colour_scale_is_ordered_and_clamped():
    r = run_js("out({lo: H.colorAt('classic', -150), hi: H.colorAt('classic', 0), weak: H.colorAt('classic', -85), strong: H.colorAt('classic', -45), lut: H.buildLut('classic').length, cvd: H.colorAt('cvd', -60),"
               " bytes: [H.rssiToByte(-200), H.rssiToByte(-30), H.rssiToByte(-65)]})")
    assert r["lo"] == [0x2b, 0x0a, 0x3d] and r["hi"] == [0x3b, 0x82, 0xf6]
    assert r["weak"][0] > r["weak"][2] and r["strong"][2] > r["strong"][0]   # weak is warm, strong is cool
    assert r["lut"] == 256 * 4 and r["bytes"][0] == 0 and r["bytes"][1] == 255 and 0 < r["bytes"][2] < 255


def test_contour_of_a_linear_ramp_is_a_straight_line_at_the_right_place():
    r = run_js("""
      const cols = 10, rows = 6, g = new Float32Array(cols * rows);
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) g[j * cols + i] = -90 + 4 * i;   // -90 .. -54 across x
      const s = H.contourSegments(g, cols, rows, 1, -70);   // crossed at i = 5, x = 5.5 m
      const xs = []; for (let k = 0; k < s.length; k += 2) xs.push(s[k]);
      out({n: s.length / 4, xs: Array.from(new Set(xs.map(v => Math.round(v * 1000) / 1000))), none: H.contourSegments(g, cols, rows, 1, -10).length});
    """)
    assert r["n"] == 5 and r["xs"] == [5.5] and r["none"] == 0


def test_saddle_cells_produce_two_segments():
    r = run_js("out(H.contourSegments(new Float32Array([0, 10, 10, 0]), 2, 2, 1, 5).length / 4)")
    assert r == 2


def test_band_contours_sit_at_band_edges_and_legend_names_every_band():
    r = run_js("""
      const g = new Float32Array(100); for (let i = 0; i < 100; i++) g[i] = -100 + (i % 10) * 7;
      out({levels: H.bandContours(config, g, 10, 10, 1).map(c => c.level), legend: H.legendRows(config)});
    """)
    assert r["levels"] == [-55.0, -65.0, -75.0, -85.0]
    assert [row["name"] for row in r["legend"]] == ["Excellent", "Good", "Fair", "Poor", "No coverage"]
    assert all("dBm" in row["range"] for row in r["legend"])


def test_tooltip_rows_carry_rssi_throughput_distance_obstructions_and_the_estimate_label():
    r = run_js("""
      const project = P.project, p = E.probeAt(project, 'g', 9, 2, { config });
      out({rows: H.describeProbe(p, config), none: H.describeProbe(E.probeAt({floors: [Object.assign({}, project.floors[0], {aps: []})]}, 'g', 5, 5, { config }), config)});
    """, {"project": {"name": "t", "floors": [{"id": "g", "name": "g", "level": 0, "height_m": 2.5, "width_m": 10, "depth_m": 8, "rooms": [], "furniture": [], "sensors": [], "openings": [],
                                               "walls": [{"id": "w", "x1": 5, "y1": 0, "x2": 5, "y2": 8, "kind": "interior"}], "aps": [{"id": "ap1", "x": 1, "y": 2, "tx_dbm": 20}]}]}})
    labels = [k for k, _ in r["rows"]]
    assert labels == ["Signal", "Throughput", "Best AP", "Distance", "Obstructions", ""]
    assert "dBm" in r["rows"][0][1] and "1 wall" in r["rows"][4][1] and r["rows"][3][1] == "8.0 m"
    assert r["rows"][-1][1] == "MODEL ESTIMATE, not a measurement" and r["none"][1][1] == "none"


def test_colour_blind_palettes_are_ordered_dark_to_bright_and_distinct():
    r = run_js("out({v: [-100, -65, -30].map(x => H.colorAt('viridis', x)), c: [-100, -30].map(x => H.colorAt('cividis', x)), ids: Object.keys(H.PALETTES)})")
    assert r["v"][0] == [0x44, 0x01, 0x54] and r["v"][2] == [0xfd, 0xe7, 0x25] and r["v"][1] != r["v"][0]
    assert r["c"][0] == [0x00, 0x20, 0x4d] and r["c"][1] == [0xff, 0xea, 0x46] and {"classic", "cvd", "viridis", "cividis"} <= set(r["ids"])


def test_layer_grids_flip_bad_is_low_layers_and_report_missing_sinr():
    r = run_js("""
      const a = {cols: 2, rows: 1, cell_m: 1, best_ap: [[0, -1]], aps: [{width_mhz: 20, channel_utilisation_pct: 30, client_capacity: 12}], throughput_mbps: [[100, 0]]};
      const ctx = {config, RF: E, analytics: a, rssi: Float32Array.from([-40, -90])};
      const snr = H.layerValues('snr', ctx), sinr = H.layerValues('sinr', ctx), q = H.layerGrid('quality', ctx), u = H.layerGrid('utilisation', ctx);
      const comb = H.layerGrid('combined', ctx, ['rssi', 'utilisation']);
      out({snr: Array.from(snr.values), sinrReason: !!sinr.reason, sinrNaN: Array.from(sinr.values).every(Number.isNaN),
           q: Array.from(q.values), uGrid: Array.from(u.rssi), comb: Array.from(comb.values), ends: H.layerEnds(config.planner_layers.layers.latency),
           good: [H.goodness({lo: 0, hi: 10, higher_is_better: false}, 0), H.goodness({lo: 0, hi: 10, higher_is_better: true}, 20), H.goodness({lo: 0, hi: 1, higher_is_better: true}, NaN)]});
    """)
    assert abs(r["snr"][0] - (-40 - rfmodel.noise_floor_dbm(20))) < 1e-3   # the Python model is the source of truth
    assert r["sinrReason"] and r["sinrNaN"]
    assert r["q"][0] > r["q"][1] and r["uGrid"][0] > r["uGrid"][1] == -100
    assert r["comb"][0] > r["comb"][1] and r["good"][0] == 1 and r["good"][1] == 1 and r["good"][2] is None
    assert "worst" in r["ends"][0] and "best" in r["ends"][1]
