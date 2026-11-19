"""Apartment WiFi placement game: pick access point positions to reach 95 % coverage cheaply.

Python is the source of truth. The RF model runs here: every candidate position gets a precomputed
single-AP RSSI grid, so the browser only takes a per-cell maximum, applies the threshold and adds up
costs (see score_selection, mirrored in JS and checked by a parity test on shared vectors).
All numbers are MODEL ESTIMATES, and the scenario is simulated.
"""
import itertools
from typing import Dict, Iterable, List

from . import rfmodel

GOAL_COVERAGE_PCT = 95.0
BUDGET = 200
GAME_THRESHOLD_DBM = -60.0      # stricter than the -70 dBm planning threshold: the goal is "good" WiFi
CELL_M = 0.5
WEIGHTS = {"coverage": 0.5, "signal_quality": 0.3, "cost": 0.2}   # sum to 1.0
QUALITY_WORST_DBM, QUALITY_BEST_DBM = -90.0, -50.0
EXISTING_AP = {"id": "router", "x": 0.8, "y": 6.2, "tx_dbm": 4.0}   # an old, weak router in the corner
CANDIDATE_TX_DBM = 8.0                                              # cheap repeaters are weak too
CANDIDATES = (
    {"id": "c-living", "label": "Living room centre", "x": 3.0, "y": 3.5, "cost": 40},
    {"id": "c-hall", "label": "Hallway shelf", "x": 6.0, "y": 3.5, "cost": 30},
    {"id": "c-kitchen", "label": "Kitchen corner", "x": 6.4, "y": 0.8, "cost": 45},
    {"id": "c-bed", "label": "Bedroom wall", "x": 9.6, "y": 1.5, "cost": 50},
    {"id": "c-bath", "label": "Bathroom ceiling", "x": 7.6, "y": 5.4, "cost": 60},
    {"id": "c-balcony", "label": "Balcony door", "x": 11.0, "y": 5.5, "cost": 45},
    {"id": "c-north", "label": "North window sill", "x": 1.5, "y": 0.6, "cost": 35},
    {"id": "c-desk", "label": "Desk corner", "x": 4.2, "y": 6.2, "cost": 55},
)


def apartment_floor() -> dict:
    """Single-floor apartment, 12 m x 7 m, in the digital twin format."""
    w, d = 12.0, 7.0
    return {
        "id": "apartment", "name": "Apartment", "level": 0, "height_m": 2.5, "width_m": w, "depth_m": d,
        "rooms": [{"id": "living", "name": "Living room", "x": 0, "y": 0, "w": 5, "d": 7},
                  {"id": "kitchen", "name": "Kitchen", "x": 5, "y": 0, "w": 3, "d": 3.5},
                  {"id": "hall", "name": "Hall", "x": 5, "y": 3.5, "w": 3, "d": 3.5},
                  {"id": "bedroom", "name": "Bedroom", "x": 8, "y": 0, "w": 4, "d": 3.5},
                  {"id": "bath", "name": "Bathroom", "x": 8, "y": 3.5, "w": 4, "d": 3.5}],
        "walls": [{"id": "n", "x1": 0, "y1": 0, "x2": w, "y2": 0, "kind": "exterior"},
                  {"id": "e", "x1": w, "y1": 0, "x2": w, "y2": d, "kind": "exterior"},
                  {"id": "s", "x1": w, "y1": d, "x2": 0, "y2": d, "kind": "exterior"},
                  {"id": "w", "x1": 0, "y1": d, "x2": 0, "y2": 0, "kind": "exterior"},
                  {"id": "i1", "x1": 5, "y1": 0, "x2": 5, "y2": d, "kind": "interior"},
                  {"id": "i2", "x1": 8, "y1": 0, "x2": 8, "y2": d, "kind": "interior"},
                  {"id": "i3", "x1": 5, "y1": 3.5, "x2": w, "y2": 3.5, "kind": "interior"}],
        "openings": [{"id": "d1", "kind": "door", "wall": "i1", "pos": 3.0, "width": 0.9},
                     {"id": "d2", "kind": "door", "wall": "i2", "pos": 1.2, "width": 0.9},
                     {"id": "d3", "kind": "door", "wall": "i2", "pos": 5.0, "width": 0.9},
                     {"id": "w1", "kind": "window", "wall": "n", "pos": 1.0, "width": 1.5}],
        "furniture": [], "sensors": [], "aps": [],
    }


def _single_ap_grid(floor: dict, ap: dict) -> List[List[float]]:
    twin = {"floors": [floor]}
    grid = rfmodel.coverage_grid(twin, floor["id"], CELL_M, [(dict(ap, tx_dbm=ap.get("tx_dbm", CANDIDATE_TX_DBM)), floor)])
    return grid["rssi"]


def build_scenario() -> dict:
    """Everything the browser needs. Deterministic: no randomness anywhere."""
    floor = apartment_floor()
    cands = []
    for c in CANDIDATES:
        cands.append(dict(c, rssi=_single_ap_grid(floor, c)))
    scenario = {
        "id": "apartment", "name": "Fix the dead zones", "simulated": True, "label": rfmodel.LABEL,
        "floor": floor, "cell_m": CELL_M, "cols": len(cands[0]["rssi"][0]), "rows": len(cands[0]["rssi"]),
        "threshold_dbm": GAME_THRESHOLD_DBM, "goal_pct": GOAL_COVERAGE_PCT, "budget": BUDGET,
        "weights": WEIGHTS, "quality_range_dbm": [QUALITY_WORST_DBM, QUALITY_BEST_DBM],
        "existing_ap": EXISTING_AP, "base_rssi": _single_ap_grid(floor, EXISTING_AP), "candidates": cands,
    }
    scenario["par"] = par_solution(scenario)
    return scenario


def _cell_best(scenario: dict, selected: Iterable[str]) -> List[float]:
    chosen = [c for c in scenario["candidates"] if c["id"] in set(selected)]
    cols = scenario["cols"]
    best = [v for row in scenario["base_rssi"] for v in row]
    for c in chosen:
        flat = [v for row in c["rssi"] for v in row]
        best = [max(a, b) for a, b in zip(best, flat)]
    assert len(best) == cols * scenario["rows"]
    return best


def score_selection(scenario: dict, selected: Iterable[str]) -> dict:
    """Score a set of candidate ids. The JavaScript copy must return identical numbers."""
    ids = list(dict.fromkeys(selected))
    known = {c["id"]: c for c in scenario["candidates"]}
    unknown = [i for i in ids if i not in known]
    if unknown:
        raise ValueError(f"unknown candidate ids {unknown}")
    best = _cell_best(scenario, ids)
    coverage = round(100.0 * sum(1 for v in best if v >= scenario["threshold_dbm"]) / len(best), 1)
    lo, hi = scenario["quality_range_dbm"]
    quality = round(100.0 * sum(max(0.0, min(1.0, (v - lo) / (hi - lo))) for v in best) / len(best), 1)
    cost = sum(known[i]["cost"] for i in ids)
    efficiency = round(max(0.0, 100.0 * (1.0 - cost / scenario["budget"])), 1)
    w = scenario["weights"]
    score = round(w["coverage"] * coverage + w["signal_quality"] * quality + w["cost"] * efficiency)
    return {"selected": ids, "coverage_pct": coverage, "signal_quality": quality, "cost": cost,
            "cost_efficiency": efficiency, "goal_met": coverage >= scenario["goal_pct"], "score": score}


def par_solution(scenario: dict) -> dict:
    """The cheapest selection that meets the coverage goal (ties broken by score, then id order)."""
    ids = [c["id"] for c in scenario["candidates"]]
    best = None
    for n in range(len(ids) + 1):
        for combo in itertools.combinations(ids, n):
            r = score_selection(scenario, combo)
            if r["goal_met"]:
                key = (r["cost"], -r["score"])
                if best is None or key < best[0]:
                    best = (key, r)
    return best[1] if best else {"selected": [], "goal_met": False}
