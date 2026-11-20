import json

import pytest
from fastapi.testclient import TestClient

from wallhack import game
from wallhack.app import create_app
from wallhack.config import Config


@pytest.fixture(scope="module")
def scenario():
    return game.build_scenario()


def test_scenario_is_deterministic_and_json_safe(scenario):
    assert json.dumps(scenario, sort_keys=True) == json.dumps(game.build_scenario(), sort_keys=True)
    assert scenario["simulated"] is True and "ESTIMATE" in scenario["label"]
    assert len(scenario["candidates"]) == len(game.CANDIDATES)
    for c in scenario["candidates"]:
        assert len(c["rssi"]) == scenario["rows"] and len(c["rssi"][0]) == scenario["cols"]
    assert abs(sum(scenario["weights"].values()) - 1.0) < 1e-9


def test_game_starts_below_goal_and_has_a_par_solution(scenario):
    start = game.score_selection(scenario, [])
    assert start["goal_met"] is False and start["cost"] == 0 and start["coverage_pct"] < game.GOAL_COVERAGE_PCT
    par = scenario["par"]
    assert par["goal_met"] and par["selected"]
    # nothing cheaper reaches the goal
    for c in scenario["candidates"]:
        r = game.score_selection(scenario, [c["id"]])
        assert not r["goal_met"] or r["cost"] >= par["cost"]


def test_scoring_rules(scenario):
    one = game.score_selection(scenario, ["c-hall"])
    assert one["cost"] == 30 and one["cost_efficiency"] == 85.0
    assert game.score_selection(scenario, ["c-hall", "c-hall"]) == one   # duplicates ignored
    more = game.score_selection(scenario, ["c-hall", "c-bed"])
    assert more["coverage_pct"] >= one["coverage_pct"] and more["cost"] == 80
    everything = game.score_selection(scenario, [c["id"] for c in scenario["candidates"]])
    assert everything["coverage_pct"] >= more["coverage_pct"] and everything["cost_efficiency"] < more["cost_efficiency"]
    assert 0 <= everything["score"] <= 100
    with pytest.raises(ValueError):
        game.score_selection(scenario, ["nope"])


def test_endpoint():
    app = create_app(Config(source="simulator", background=False))
    with TestClient(app, base_url="http://localhost") as c:
        j = c.get("/api/game/scenario").json()
    assert j["id"] == "apartment" and j["goal_pct"] == 95.0 and j["par"]["goal_met"]
