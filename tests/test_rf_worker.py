"""rf-worker.js core: incremental tiles must equal a fresh full computation (pytest spawns node)."""
import json
import shutil
import subprocess

import pytest

from tests.test_rf_parity import random_project
from wallhack import rfmodel
from wallhack.app import STATIC

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")

PRELUDE = """
const D = process.argv[1], E = require(D + '/rf-engine.js'), S = require(D + '/planner-state.js'), W = require(D + '/rf-worker.js');
const P = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const config = P.config, env = E.makeEnv(config);
const out = (v) => console.log(JSON.stringify(v));
const msgs = [];
const core = W.createCore({ RF: E, State: S }, (m) => msgs.push(m));
core.handle({ type: 'init', config });
function load(project, mode) { core.handle({ type: 'setProject', project, mode: mode || 'basic' }); }
async function compute(id, cell) {
  msgs.length = 0;
  await core.handle({ type: 'compute', id, floor: 'f0', cell_m: cell || 1 });
  return msgs.slice();
}
function finalOf(ms) { return ms.filter(m => m.type === 'result')[0]; }
// reference: fresh brute-force merge with the engine, no tiles
function reference(project, mode, cell, band) {
  const floor = project.floors.filter(f => f.id === 'f0')[0], best = new Float64Array(E.gridAxes(floor, cell || 1).cols * E.gridAxes(floor, cell || 1).rows).fill(config.engine.no_signal_dbm);
  project.floors.forEach(f => f.aps.forEach(ap => {
    const g = E.computeApGrid(floor, ap, { env, cellM: cell || 1, mode, band: band || null, floorsApart: Math.abs(f.level - floor.level) });
    g.forEach((v, i) => { if (v > best[i]) best[i] = v; });
  }));
  return best;
}
function maxDiff(a, b) { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; }
"""


def run_js(body, project):
    data = {"config": rfmodel.CONFIG, "project": project}
    res = subprocess.run(["node", "-e", PRELUDE + "(async () => {" + body + "})().catch(e => { console.error(e); process.exit(1); });", str(STATIC)],
                         capture_output=True, text=True, input=json.dumps(data), timeout=120)
    assert res.returncode == 0, res.stderr
    return json.loads(res.stdout)


@pytest.mark.parametrize("mode", ["basic", "enhanced", "multipath"])
def test_worker_result_equals_fresh_engine_computation(mode):
    r = run_js("""
      load(P.project, '%s');
      const ms = await compute(1), fin = finalOf(ms);
      out({diff: maxDiff(fin.grid, reference(P.project, '%s')), types: ms.map(m => m.type), stage: ms[0].stage, cols: fin.cols, label: fin.label});
    """ % (mode, mode), random_project(5, 40, 24, 16))
    assert r["diff"] < 1e-3 and r["types"][0] == "progress" and r["types"][-1] == "result" and r["stage"] == "coarse"
    assert "not a measurement" in r["label"]


def test_incremental_edits_match_a_fresh_computation_and_touch_fewer_tiles():
    r = run_js("""
      const project = JSON.parse(JSON.stringify(P.project));
      load(project);
      const first = finalOf(await compute(1));
      const none = finalOf(await compute(2));          // nothing changed: no tile recomputed
      const f = project.floors[0], w = f.walls[3], res = {};
      const moved = { x1: w.x1, y1: w.y1, x2: Math.min(f.width_m, w.x2 + 0.7), y2: w.y2 };
      const ops = [{ t: 'wall.set', floor: 'f0', id: w.id, before: {}, after: moved },
                   { t: 'wall.add', floor: 'f0', item: { id: 'nw', x1: 20, y1: 1, x2: 22, y2: 1, kind: 'interior', material: 'concrete' }, index: f.walls.length },
                   { t: 'wall.remove', floor: 'f0', id: f.walls[5].id, item: f.walls[5], index: 5, openings: [] }];
      S.applyOp(project, ops[0]); S.applyOp(project, ops[1]); S.applyOp(project, ops[2]);
      core.handle({ type: 'update', ops: [{ t: 'wall.set', floor: 'f0', id: w.id, before: {}, after: moved }].concat(ops.slice(1)) });
      const wallEdit = finalOf(await compute(3)), diffWall = maxDiff(wallEdit.grid, reference(project, 'basic'));
      const ap = project.floors[0].aps[0], moveAp = { t: 'ap.set', floor: 'f0', id: ap.id, before: {}, after: { x: ap.x + 2, y: ap.y - 1 } };
      S.applyOp(project, moveAp);
      core.handle({ type: 'update', ops: [moveAp] });
      const apEdit = finalOf(await compute(4));
      out({none: none.stats, wallEdit: wallEdit.stats, apEdit: apEdit.stats, first: first.stats, diffWall, diffAp: maxDiff(apEdit.grid, reference(project, 'basic'))});
    """, random_project(11, 60, 40, 30))
    assert r["none"]["tiles_computed"] == 0 and r["none"]["tiles_dirty"] == 0
    assert r["first"]["tiles_computed"] == r["first"]["tiles_total"] * 4   # four access points, every tile
    assert 0 < r["wallEdit"]["tiles_computed"] < r["first"]["tiles_computed"]
    assert 0 < r["apEdit"]["tiles_computed"] <= r["first"]["tiles_total"]
    assert r["diffAp"] < 1e-3 and r["diffWall"] < 1e-3


def test_new_request_supersedes_older_one_and_stale_result_is_dropped():
    r = run_js("""
      load(P.project);
      msgs.length = 0;
      const a = core.handle({ type: 'compute', id: 1, floor: 'f0', cell_m: 0.5 });
      const b = core.handle({ type: 'compute', id: 2, floor: 'f0', cell_m: 0.5 });
      await Promise.all([a, b]);
      out({types: msgs.map(m => [m.id, m.type]).filter(x => x[1] !== 'progress')});
    """, random_project(3, 30, 40, 30))
    assert r["types"] == [[1, "cancelled"], [2, "result"]]


def test_unknown_message_and_bad_floor_report_errors_instead_of_throwing():
    r = run_js("""
      load(P.project);
      msgs.length = 0;
      core.handle({ type: 'bogus', id: 9 });
      await core.handle({ type: 'compute', id: 10, floor: 'nope', cell_m: 1 });
      out(msgs.map(m => [m.type, m.message]));
    """, random_project(3, 10))
    assert r[0][0] == "error" and "unknown message type" in r[0][1] and r[1][0] == "error" and "unknown floor" in r[1][1]


def test_region_computation_matches_whole_grid():
    r = run_js("""
      const floor = P.project.floors[0], ap = floor.aps[0], full = E.computeApGrid(floor, ap, { env, cellM: 0.5 });
      const ax = E.gridAxes(floor, 0.5), part = new Float32Array(full.length).fill(-999);
      E.computeApRegion(floor, ap, { env, cellM: 0.5 }, { c0: 3, r0: 2, c1: 10, r1: 9 }, part);
      let bad = 0, set = 0;
      for (let r = 0; r < ax.rows; r++) for (let c = 0; c < ax.cols; c++) {
        const i = r * ax.cols + c, inside = c >= 3 && c < 10 && r >= 2 && r < 9;
        if (inside) { set++; if (part[i] !== full[i]) bad++; } else if (part[i] !== -999) bad++;
      }
      out({bad, set});
    """, random_project(2, 20))
    assert r == {"bad": 0, "set": 49}


JOB_PRELUDE = """
const O = require(D + '/rf-optimizer.js');
const jobCore = W.createCore({ RF: E, State: S, Opt: O }, (m) => msgs.push(m));
jobCore.handle({ type: 'init', config });
"""


def test_analysis_jobs_in_worker_core():
    project = {"name": "T", "floors": [{"id": "f0", "name": "f0", "level": 0, "width_m": 24, "depth_m": 10, "aps": [{"id": "a", "x": 2, "y": 5, "tx_dbm": 8}],
                                        "walls": [{"id": "w", "x1": 12, "y1": 0, "x2": 12, "y2": 10, "kind": "exterior"}]}]}
    r = run_js(JOB_PRELUDE + """
      const p = S.validateProject(P.project);
      jobCore.handle({ type: 'setProject', project: p });
      msgs.length = 0;
      await jobCore.handle({ type: 'analyze', id: 1000001, floor: 'f0', cell_m: 1 });
      const analysis = msgs.filter(m => m.type === 'analysis')[0];
      msgs.length = 0;
      await jobCore.handle({ type: 'plan', id: 1000002, floor: 'f0', target_pct: 90, max_aps: 4 });
      const plan = msgs.filter(m => m.type === 'plan')[0], steps = msgs.filter(m => m.type === 'progress').map(m => m.text);
      // a cancel posted while a job waits between steps stops it
      msgs.length = 0;
      const pending = jobCore.handle({ type: 'plan', id: 1000003, floor: 'f0' });
      jobCore.handle({ type: 'cancel', id: 1000003 });
      await pending;
      const cancelled = msgs.filter(m => m.type === 'cancelled').length, planned = msgs.filter(m => m.type === 'plan').length;
      // the same analysis computed directly
      const direct = E.analyzeFloor(p, 'f0', { env, cellM: 1 });
      msgs.length = 0;
      await jobCore.handle({ type: 'rank', id: 1000004, floor: 'f0', cell_m: 1, items: [{ id: 'x', name: 'X', project: p }, { id: 'y', name: 'Y', project: Object.assign({}, p, { floors: [Object.assign({}, p.floors[0], { aps: p.floors[0].aps.concat([{ id: 'b', x: 20, y: 5, tx_dbm: 8 }]) })] }) }] });
      const rank = msgs.filter(m => m.type === 'ranking')[0];
      out({ coverage: analysis.analytics.coverage_pct, direct: direct.coverage_pct, hasGrid: 'throughput_mbps' in analysis.analytics, steps, placements: plan.placements.recommendations.length,
            keys: Object.keys(plan), cancelled, planned, rank: rank.rows.map(x => [x.id, x.score]) });
    """, project)
    assert r["coverage"] == r["direct"] and not r["hasGrid"]
    assert len(r["steps"]) == 8 and r["steps"][0] == "finding coverage issues" and r["placements"] >= 1
    assert {"issues", "placements", "count", "power", "channels"} <= set(r["keys"])
    assert r["cancelled"] == 1 and r["planned"] == 0
    assert [x[0] for x in r["rank"]] == ["y", "x"] and r["rank"][0][1] > r["rank"][1][1]


def test_perf_lib_small_scenario_is_deterministic():
    """tools/perf_rf_lib.js: the seeded floor repeats exactly and every wall index strategy yields the engine's grid."""
    body = """
    const Perf = require(process.argv[1] + '/../../tools/perf_rf_lib.js');
    const a = Perf.stressProject(7, 4, 200, 100), b = Perf.stressProject(7, 4, 200, 100);
    let tick = 0;
    const deps = { RF: E, config, now: () => tick++ };
    const rows = Perf.indexComparison(deps, { repeat: 1, points: 2000, apCount: 2, walls: 200 });
    out({ same: JSON.stringify(a) === JSON.stringify(b), walls: a.floors[0].walls.length, depth: a.floors[0].depth_m,
          names: rows.map(r => r.name.split(', ').pop()), points: rows[0].points, parity: rows.parity_db });
    """
    res = run_js(body, {})
    assert res["same"] and res["walls"] == 200 and res["depth"] == 100
    assert res["names"] == ["engine uniform grid", "engine brute force", "bench brute force", "bench uniform grid", "bench quadtree"]
    assert res["points"] >= 2000
    assert res["parity"] < 1e-3
