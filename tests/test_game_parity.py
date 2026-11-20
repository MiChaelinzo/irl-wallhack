"""The browser game scoring (static/game.js) must match wallhack.game.score_selection exactly."""
import itertools
import json
import shutil
import subprocess

import pytest

from wallhack import game
from wallhack.app import STATIC

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")

SCRIPT = """
const g = require(process.argv[1]);
const { scenario, selections } = JSON.parse(require('fs').readFileSync(0, 'utf8'));
console.log(JSON.stringify(selections.map(s => g.scoreSelection(scenario, s))));
"""


def test_js_scoring_matches_python_on_every_selection():
    scenario = game.build_scenario()
    ids = [c["id"] for c in scenario["candidates"]]
    selections = [list(c) for n in range(len(ids) + 1) for c in itertools.combinations(ids, n)]
    selections.append(["c-hall", "c-hall", "c-balcony"])   # duplicates are ignored
    res = subprocess.run(["node", "-e", SCRIPT, str(STATIC / "game.js")], capture_output=True, text=True,
                         input=json.dumps({"scenario": scenario, "selections": selections}))
    assert res.returncode == 0, res.stderr
    js = json.loads(res.stdout)
    assert len(js) == len(selections) == 257
    for sel, got in zip(selections, js):
        assert got == game.score_selection(scenario, sel), sel


def test_js_rejects_unknown_candidate():
    scenario = game.build_scenario()
    res = subprocess.run(["node", "-e", SCRIPT, str(STATIC / "game.js")], capture_output=True, text=True,
                         input=json.dumps({"scenario": scenario, "selections": [["nope"]]}))
    assert res.returncode != 0 and "unknown candidate" in res.stderr
