"""Planner 3D view: floor stack, camera and projection, slicing and volume interpolation, scene model, beam pattern, generation table, load balance."""
import json
import shutil
import subprocess

import pytest

from wallhack import rfmodel
from wallhack.app import STATIC

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")

PRELUDE = """
const D = process.argv[1], fs = require('fs');
const P3 = require(D + '/planner-3d.js'), E = require(D + '/rf-engine.js'), S = require(D + '/planner-state.js'), H = require(D + '/planner-heat.js'), M = require(D + '/planner-modes.js');
require(D + '/planner-panels.js');
const config = JSON.parse(fs.readFileSync(0, 'utf8')), env = E.makeEnv(config);
const presets = S.validateScenarioLibrary(JSON.parse(fs.readFileSync(D + '/scenarios.json', 'utf8')));
const home = presets.find(p => p.id === 'large_home').project;
const out = (v) => console.log(JSON.stringify(v));
function volumeOf(project) {
  const levels = P3.floorLevels(project, config), grids = {};
  levels.forEach(l => { grids[l.id] = E.coverageGrid(project, l.id, { env, cellM: 1 }); });
  return { levels, grids, vol: P3.prepareVolume(levels, grids, config) };
}
"""


def run_js(body):
    res = subprocess.run(["node", "-e", PRELUDE + body, str(STATIC)], capture_output=True, text=True, input=json.dumps(rfmodel.CONFIG))
    assert res.returncode == 0, res.stderr
    return json.loads(res.stdout)


def test_floor_stack_uses_elevation_and_basements():
    r = run_js("""
      const p = JSON.parse(JSON.stringify(home));
      p.floors[0].elevation_m = -3; p.floors[1].elevation_m = 4.5;
      const l = P3.floorLevels(p, config);
      out({legacy: P3.floorLevels(home, config).map(x => [x.id, x.elevation_m]), custom: l.map(x => [x.id, x.elevation_m, x.basement]), draw: l[0].draw_height_m});""")
    assert r["legacy"] == [["ground", 0], ["upper", 3]]      # no elevation_m: level times reference height
    assert r["custom"] == [["ground", -3, True], ["upper", 4.5, False]]
    assert 0 < r["draw"] <= 7.5 - 0.25


def test_projection_matches_the_webgl_matrix_and_behind_camera_is_rejected():
    r = run_js("""
      const levels = P3.floorLevels(home, config), b = P3.buildingBounds(levels), cam = P3.defaultCamera(b), view = {w: 800, h: 480}, o = {};
      const m = P3.viewProjection(cam, view.w / view.h, b), diffs = [];
      [[0, 0, 0], [16, 3, 10], [8, 1.5, 5], [3, 2, 9]].forEach(p => {
        const ok = P3.project(p, cam, view, o);
        const v = [p[0], p[1], p[2], 1], clip = [0, 1, 2, 3].map(r => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3]);
        const sx = (clip[0] / clip[3] * 0.5 + 0.5) * view.w, sy = (1 - (clip[1] / clip[3] * 0.5 + 0.5)) * view.h;
        diffs.push([ok, Math.abs(sx - o.x), Math.abs(sy - o.y)]);
      });
      const centre = P3.project(cam.target, cam, view, o);
      const eye = P3.cameraBasis(cam).eye, behind = P3.project([eye[0] * 2 - cam.target[0], eye[1] * 2 - cam.target[1], eye[2] * 2 - cam.target[2]], cam, view, {});
      out({diffs, centre, cx: o.x, cy: o.y, behind});""")
    assert all(ok and dx < 1e-3 and dy < 1e-3 for ok, dx, dy in r["diffs"])
    assert r["centre"] and abs(r["cx"] - 400) < 1e-6 and abs(r["cy"] - 240) < 1e-6
    assert r["behind"] is False


def test_camera_controls_are_deterministic_and_clamped():
    r = run_js("""
      const b = P3.buildingBounds(P3.floorLevels(home, config)), c = P3.defaultCamera(b);
      const a1 = P3.orbitCamera(c, 0.3, 5, b), a2 = P3.orbitCamera(c, 0.3, 5, b);
      const z = P3.zoomCamera(c, 1e-6, b), zf = P3.zoomCamera(c, 1e6, b), f = P3.flyCamera(c, 1, 0, 0, b);
      let far = c; for (let i = 0; i < 500; i++) { far = P3.flyCamera(far, 1, 1, 1, b); }
      out({same: JSON.stringify(a1) === JSON.stringify(a2), pitch: a1.pitch, near: z.dist < c.dist, far: zf.dist > c.dist, moved: f.target.join() !== c.target.join(), orig: c.yaw,
           tx: far.target[0] <= b.maxX + 0.5 * Math.hypot(b.maxX, b.maxY - b.minY, b.maxZ) + 1e-6, tour: [0, 0.5, 1].map(t => P3.tourPose(t, b).target[1])});""")
    assert r["same"] and r["pitch"] <= 1.45 and r["near"] and r["far"] and r["moved"] and r["tx"]
    assert r["tour"][0] > r["tour"][1] > r["tour"][2]            # the fly-through descends through the stack


def test_slicing_blends_floors_in_db_and_never_extrapolates():
    r = run_js("""
      const {levels, grids, vol} = volumeOf(home);
      const g = vol.cells, lo = P3.sliceAt(levels, vol, 0), hi = P3.sliceAt(levels, vol, 3), mid = P3.sliceAt(levels, vol, 1.2);
      const i = 17, expected = g.ground[i] * 0.6 + g.upper[i] * 0.4;
      out({kinds: [lo.kind, hi.kind, mid.kind], t: mid.t, same: Array.from(lo.cells).join() === Array.from(g.ground).join(), blend: Math.abs(mid.cells[i] - expected) < 1e-4,
           above: P3.sliceAt(levels, vol, 3.5), below: P3.sliceAt(levels, vol, -0.5), n: P3.volumeSlices(levels, vol, config.planner_3d.slices_per_gap).length,
           between: mid.cells.every((v, k) => v >= Math.min(g.ground[k], g.upper[k]) - 1e-4 && v <= Math.max(g.ground[k], g.upper[k]) + 1e-4)});""")
    assert r["kinds"] == ["floor", "floor", "interpolated"] and abs(r["t"] - 0.4) < 1e-9
    assert r["same"] and r["blend"] and r["between"]
    assert r["above"] is None and r["below"] is None
    assert r["n"] == rfmodel.CONFIG["planner_3d"]["slices_per_gap"]


def test_scene_is_deterministic_and_text_alternative_names_the_limits():
    r = run_js("""
      const {levels, vol} = volumeOf(home), colorOf = (v) => H.colorAt('classic', v);
      const mk = (z) => P3.buildScene(home, config, {levels, vol, colorOf, sliceZ: z, showVolume: true, showWalls: true, showAps: true, version: 1});
      const a = mk(1.5), b = mk(1.5), none = mk(9);
      const kinds = {}; a.quads.forEach(q => { kinds[q.kind] = (kinds[q.kind] || 0) + 1; });
      const batches = P3.batchLines(a.lines);
      const text = P3.describeBuilding(home, levels, config, {}, a.plane, {x: 3, y: 3}).join(' ');
      const noText = P3.describeBuilding(home, levels, config, {}, none.plane, null).join(' ');
      out({same: JSON.stringify(a.quads.map(q => [q.id, q.corners, Array.from(q.pixels || [])])) === JSON.stringify(b.quads.map(q => [q.id, q.corners, Array.from(q.pixels || [])])),
           kinds, plane: !!none.plane, lines: a.lines.length === batches.reduce((n, g) => n + g.verts.length / 6, 0),
           sorted: P3.sortBackToFront(a.quads, P3.defaultCamera(a.bounds)).length === a.quads.length, text, noText});""")
    assert r["same"] and r["lines"] and r["sorted"] and not r["plane"]
    assert r["kinds"]["floor"] == 2 and r["kinds"]["slab"] == 2 and r["kinds"]["volume"] == 3 and r["kinds"]["plane"] == 1
    assert "not a 3D simulation" in r["text"] and "interpolated" in r["text"] and "no data" in r["noText"]


def test_beam_pattern_peaks_at_steer_with_engine_gain_and_omni_is_flat():
    r = run_js("""
      const ap = {id: 'a', x: 1, y: 1, tx_dbm: 18, standard: 'wifi6', spatial_streams: 4};
      const p = M.beamPattern(config, ap, 90), old = M.beamPattern(config, {id: 'b', x: 1, y: 1, tx_dbm: 18, standard: 'wifi4'}, 90);
      const at = (list, d) => list.find(s => s.deg === d).gain_dbi;
      out({bf: p.beamforming_gain_db, expected: E.beamformingGainDb(config, Object.assign({beamforming: true}, ap)), peak: at(p.steered, 90), back: at(p.steered, 270), omniFlat: new Set(p.omni.map(s => s.gain_dbi)).size,
           again: JSON.stringify(M.beamPattern(config, ap, 90)) === JSON.stringify(p), oldSupported: old.supported, oldSame: old.steered.every((s, i) => s.gain_dbi === old.omni[i].gain_dbi), label: p.label});""")
    assert r["bf"] == r["expected"] == 3 and r["peak"] == 3 and r["back"] == 3 - rfmodel.CONFIG["antenna"]["patterns"]["sector"]["default_front_to_back_db"]
    assert r["omniFlat"] == 1 and r["again"] and not r["oldSupported"] and r["oldSame"] and "ILLUSTRATION" in r["label"]


def test_generation_table_follows_the_engine_formulas():
    r = run_js("""
      const t = M.generationTable(config, '5'), by = Object.fromEntries(t.map(x => [x.id, x])), six = M.generationTable(config, '6');
      out({ids: t.map(x => x.id), supported5: t.map(x => x.supported), supported6: six.map(x => x.supported),
           peak7: by.wifi7.peak_mbps, expected7: Math.round(E.standardPhyRateMbps(config, 'wifi7', 13, 160, 2) * 10) / 10,
           ranges: t.filter(x => x.supported).map(x => x.range_m), walls: by.wifi6.behind_wall.map(w => w.loss_db),
           wallLoss: ['drywall', 'brick', 'reinforced_concrete'].map(m => config.materials[m].attenuation_db['5']), ofdma4: by.wifi4.ofdma_gain, ofdma6: by.wifi6.ofdma_gain, bf4: by.wifi4.beamforming_db, bf6: by.wifi6.beamforming_db});""")
    assert r["ids"] == ["wifi4", "wifi5", "wifi6", "wifi6e", "wifi7"]
    assert r["supported5"] == [True] * 5 and r["supported6"] == [False, False, False, True, True]
    assert abs(r["peak7"] - r["expected7"]) < 0.11
    assert r["walls"] == r["wallLoss"] and r["ofdma4"] == 1.0 and r["ofdma6"] > 1.0 and r["bf4"] == 0 and r["bf6"] > 0
    assert all(x > 0 for x in r["ranges"])


def test_generation_projection_copy_and_load_balance():
    r = run_js("""
      const office = presets.find(p => p.id === 'office_floor').project, copy = M.projectWithStandard(office, config, 'wifi7', '6');
      const before = JSON.stringify(office), none = M.projectWithStandard(office, config, 'wifi5', '6');
      const an = E.analyzeFloor(office, 'office', {env, cellM: 1}), lb = M.loadBalance(an);
      const rings = M.coverageRings(config, office.floors[0].aps[0], '5');
      out({std: copy.floors[0].aps.map(a => [a.standard, a.band, a.width_mhz]), untouched: JSON.stringify(office) === before, none,
           served: lb.rows.reduce((n, x) => n + x.served_pct, 0), fair: lb.fairness, n: lb.rows.length, rings: rings.map(x => x.radius_m)});""")
    assert all(s == ["wifi7", "6", None] for s in r["std"]) and r["untouched"] and r["none"] is None
    assert abs(r["served"] - 100) < 0.5 and 0 < r["fair"] <= 1 and r["n"] == 3
    assert r["rings"] == sorted(r["rings"]) and r["rings"][0] > 0


def test_config_block_and_page_wiring():
    cfg = rfmodel.CONFIG["planner_3d"]
    assert "not a 3D propagation simulation" in cfg["label"] or "it is not a 3D propagation simulation" in cfg["label"]
    html = (STATIC / "planner.html").read_text()
    assert '<script src="/static/planner-3d.js"></script>' in html
    assert html.index("planner-3d.js") < html.index("/static/planner.js")
    import re
    assert not re.search(r"<script(?![^>]*\bsrc=)[^>]*>", html)
    src = (STATIC / "planner-3d.js").read_text()
    assert "http://" not in src and "https://" not in src and "eval(" not in src
