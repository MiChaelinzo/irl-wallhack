"""Educational mode: lesson content, checks that fail at the start and pass on the solution, probe explanation, explain body, report sections."""
import json
import shutil
import subprocess

import pytest

from tests.test_planner_panels import pdf_problems
from wallhack import llm, rfmodel
from wallhack.app import STATIC

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")

PRELUDE = """
const D = process.argv[1];
const S = require(D + '/planner-state.js'), E = require(D + '/rf-engine.js'), L = require(D + '/planner-learn.js'), X = require(D + '/planner-export.js'),
      PP = require(D + '/planner-panels.js'), O = require(D + '/rf-optimizer.js');
const fs = require('fs'), config = JSON.parse(fs.readFileSync(0, 'utf8')), env = E.makeEnv(config);
const presets = S.validateScenarioLibrary(JSON.parse(fs.readFileSync(D + '/scenarios.json', 'utf8')));
const content = JSON.parse(fs.readFileSync(D + '/learn-content.json', 'utf8'));
const out = (v) => console.log(JSON.stringify(v));
"""


def run_js(body):
    res = subprocess.run(["node", "-e", PRELUDE + body, str(STATIC)], capture_output=True, text=True, input=json.dumps(rfmodel.CONFIG))
    assert res.returncode == 0, res.stderr
    return json.loads(res.stdout)


def test_content_validates_and_covers_the_required_topics():
    r = run_js("L.validateContent(content, presets); out(content.topics.map(t => t.id))")
    assert {"rssi", "snr", "sinr", "attenuation", "propagation", "frequencies", "channels", "interference"} <= set(r)


def test_content_validation_rejects_bad_lessons():
    r = run_js("""
      const bad = (mut) => { const c = JSON.parse(JSON.stringify(content)); mut(c); try { L.validateContent(c, presets); return 'accepted'; } catch (e) { return e.name; } };
      out([bad(c => { c.lessons[0].scenario = 'nowhere'; }), bad(c => { c.lessons[0].steps[0].check.metric = 'magic'; }),
           bad(c => { c.lessons[0].topic = 'x'; }), bad(c => { c.lessons[0].solution.ops[0].t = 'rm -rf'; }), bad(c => { c.lessons[1].id = c.lessons[0].id; })]);""")
    assert r == ["LearnContentError"] * 5


def test_every_lesson_fails_at_the_start_and_passes_on_its_solution():
    r = run_js("""out(content.lessons.map(l => {
        const project = JSON.parse(JSON.stringify(presets.find(p => p.id === l.scenario).project));
        const ctx = (settings) => ({env, settings, cellM: 1});
        const before = L.evaluateLesson(l, project, ctx({band: null, mode: 'basic'})).map(x => x.pass);
        const store = S.createStore(project);
        if (l.solution.ops.length) { store.exec({label: 'solution', ops: L.solutionOps(store.project, l.solution)}); }
        const settings = Object.assign({band: null, mode: 'basic'}, l.solution.settings || {});
        const after = L.evaluateLesson(l, store.project, ctx(settings)).map(x => x.pass);
        if (l.solution.ops.length) { store.undo(); }
        const undone = JSON.stringify(store.project) === JSON.stringify(project);
        return {id: l.id, before, after, undone};
      }))""")
    assert len(r) >= 6
    for lesson in r:
        assert not any(lesson["before"]) and all(lesson["after"]) and lesson["undone"], lesson


def test_why_weak_uses_engine_explain_numbers():
    r = run_js("""
      const p = presets.find(x => x.id === 'small_apartment').project;
      const probe = E.probeAt(p, 'main', 6, 5, {env, explain: true});
      const w = L.whyWeak(probe, config);
      let err = null; try { L.whyWeak(E.probeAt(p, 'main', 6, 5, {env}), config); } catch (e) { err = e.message; }
      out({w, probe: probe.explain, err});""")
    assert r["w"]["rows"][0]["db"] == max(row["db"] for row in r["w"]["rows"])
    assert str(r["probe"]["total_loss_db"]) in r["w"]["headline"] and "needs a probeAt" in r["err"]


def test_plan_payload_is_accepted_by_the_explain_endpoint_validator():
    r = run_js("""
      const p = presets.find(x => x.id === 'hotel_floor').project, po = {env, config};
      const plan = {floor: 'hotel', issues: O.detectIssues(p, 'hotel', po).issues, analytics: E.analyzeFloor(p, 'hotel', {env, cellM: 1}),
        placements: O.suggestPlacements(p, 'hotel', po), count: O.recommendApCount(p, 'hotel', 95, 12, po), power: O.detectPowerIssues(p, 'hotel', po),
        channels: O.planChannels(p, 'hotel', po), channels_sinr: O.planChannelsSinr(p, 'hotel', po), mesh: O.suggestMeshNodes(p, 'hotel', po),
        dead_zone_fixes: O.suggestDeadZoneFixes(p, 'hotel', po)};
      const recs = PP.buildRecommendations(plan);
      out({payload: L.payloadFromPlan(plan, recs), kinds: recs.map(r => r.kind), conf: recs.map(r => r.confidence), why: recs.map(r => !!r.reason)});""")
    clean = llm.validate_planner_payload(r["payload"])
    assert clean["metrics"] and clean["recommendations"]
    assert {"add_ap", "dead_zone_fix"} <= set(r["kinds"]) and all(r["why"])
    assert "channel" in r["kinds"] and all(c is not None for k, c in zip(r["kinds"], r["conf"]) if k == "channel")
    text = llm.rule_based_planner_text(clean)
    assert not llm.ungrounded_numbers(text, clean)


def test_report_has_the_new_sections():
    r = run_js("""
      const jpeg = new Uint8Array(100).map((_, i) => (i * 5) & 255); jpeg[0] = 0xff; jpeg[1] = 0xd8;
      const img = {bytes: jpeg, w: 10, h: 10};
      const bytes = X.buildReport({title: 'Report', project: 'P', floor: 'F', date: '2025-01-01', summary: [['Metric', 'Value'], ['Coverage', '90 %']],
        aps: [['AP', 'Band'], ['ap1', '5 GHz']], issues: ['dead zone'], recommendations: ['Add an AP (confidence 90%. Why: stable)'], image: img,
        floors: [['Floor', 'Level'], ['Ground', 0]], ap_locations: [['AP', 'Floor'], ['ap1', 'Ground']], spectrum: [['AP', 'Band'], ['ap1', '5 GHz']],
        performance: [['Metric', 'Value'], ['Heat map compute time', '12 ms']], mode_maps: [{label: 'Basic', coverage_pct: 91.5, image: img}, {label: 'Enhanced', coverage_pct: 92, image: img}],
        accessible_text: 'Floor F of P: coverage 90 percent.'});
      out(Array.from(bytes));""")
    data = bytes(r)
    assert pdf_problems(data) == []
    for text in (b"Floor overview", b"Coverage maps per propagation mode", b"Basic: coverage 91.5", b"Access point locations", b"Spectrum summary",
                 b"Performance of this analysis", b"Text summary", b"Why: stable", b"MODEL ESTIMATE, not a measurement"):
        assert text in data, text
    assert data.count(b"/Subtype /Image") == 3
