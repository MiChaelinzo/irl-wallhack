"""Indoor WiFi coverage ESTIMATE from the digital twin (a MODEL, not a measurement).

    RSSI(dBm) = tx_dbm - PL0 - 10 * n * log10(max(d, 1 m)) - sum(wall losses) - floors * FLOOR_LOSS

Log-distance path loss with per-obstacle attenuation. The constants are textbook 2.4 GHz values
(ITU-R P.1238 style) and real buildings differ by 10 dB or more; calibrate before relying on it.
Pure and deterministic: the same twin and parameters always give the same grid.
"""
import math
from typing import Dict, List, Optional, Tuple

PL0_DB = 40.0                  # free-space loss at 1 m, 2.4 GHz
PATH_LOSS_EXPONENT = 3.0       # typical for an obstructed indoor space
MIN_DISTANCE_M = 1.0
WALL_LOSS_DB = {"interior": 4.0, "exterior": 9.0}
OPENING_LOSS_DB = {"door": 2.0, "window": 3.0}   # replaces the wall loss where the ray passes through
FLOOR_LOSS_DB = 13.0           # per floor crossed
COVERAGE_THRESHOLD_DBM = -70.0
DEFAULT_CELL_M = 0.5
NO_SIGNAL_DBM = -120.0
LABEL = "ESTIMATE: log-distance model with wall attenuation, not a measurement"


def _cross(ax: float, ay: float, bx: float, by: float) -> float:
    return ax * by - ay * bx


def _ray_wall_hit(px: float, py: float, qx: float, qy: float, wall: dict) -> Optional[float]:
    """Distance along the wall (from its first end) where segment p->q crosses it, or None."""
    rx, ry = qx - px, qy - py
    sx, sy = wall["x2"] - wall["x1"], wall["y2"] - wall["y1"]
    denom = _cross(rx, ry, sx, sy)
    if abs(denom) < 1e-12:
        return None  # parallel: a ray running along a wall is not counted as crossing it
    t = _cross(wall["x1"] - px, wall["y1"] - py, sx, sy) / denom
    u = _cross(wall["x1"] - px, wall["y1"] - py, rx, ry) / denom
    if 0.0 <= t <= 1.0 and 0.0 <= u <= 1.0:
        return u * math.hypot(sx, sy)
    return None


def wall_loss_db(floor: dict, px: float, py: float, qx: float, qy: float) -> float:
    """Total attenuation from the walls and openings the straight path p->q crosses on one floor."""
    openings: Dict[str, List[dict]] = {}
    for o in floor["openings"]:
        openings.setdefault(o["wall"], []).append(o)
    total = 0.0
    for wall in floor["walls"]:
        along = _ray_wall_hit(px, py, qx, qy, wall)
        if along is None:
            continue
        loss = WALL_LOSS_DB[wall["kind"]]
        for o in openings.get(wall["id"], ()):
            if o["pos"] <= along <= o["pos"] + o["width"]:
                loss = OPENING_LOSS_DB[o["kind"]]
                break
        total += loss
    return total


def rssi_from_ap(ap: dict, ap_floor: dict, floor: dict, x: float, y: float, floors_apart: int = 0) -> float:
    """Estimated RSSI at (x, y) on `floor` from `ap`, which sits on `ap_floor`."""
    d = max(math.hypot(x - ap["x"], y - ap["y"]), MIN_DISTANCE_M)
    path = PL0_DB + 10.0 * PATH_LOSS_EXPONENT * math.log10(d)
    # On the same floor use that floor's walls; across floors use the receiving floor's walls.
    walls = wall_loss_db(floor, ap["x"], ap["y"], x, y)
    return ap["tx_dbm"] - path - walls - FLOOR_LOSS_DB * floors_apart


def best_rssi(twin: dict, floor: dict, x: float, y: float, aps: Optional[List[Tuple[dict, dict]]] = None) -> float:
    """Strongest estimated RSSI at a point. `aps` is a list of (ap, ap_floor); default is every AP."""
    if aps is None:
        aps = [(a, f) for f in twin["floors"] for a in f["aps"]]
    best = NO_SIGNAL_DBM
    levels = {f["id"]: f["level"] for f in twin["floors"]}
    for ap, ap_floor in aps:
        apart = abs(levels[ap_floor["id"]] - levels[floor["id"]])
        best = max(best, rssi_from_ap(ap, ap_floor, floor, x, y, apart))
    return best


def grid_axes(floor: dict, cell_m: float) -> Tuple[int, int]:
    return max(1, int(math.ceil(floor["width_m"] / cell_m))), max(1, int(math.ceil(floor["depth_m"] / cell_m)))


def coverage_grid(twin: dict, floor_id: str, cell_m: float = DEFAULT_CELL_M,
                  aps: Optional[List[Tuple[dict, dict]]] = None) -> dict:
    """Best-AP RSSI at the centre of every cell, rows from north (y=0) to south, values in 0.1 dBm."""
    if not 0.1 <= cell_m <= 5.0:
        raise ValueError("cell_m must be between 0.1 and 5.0")
    floor = next((f for f in twin["floors"] if f["id"] == floor_id), None)
    if floor is None:
        raise ValueError(f"unknown floor id {floor_id!r}")
    cols, rows = grid_axes(floor, cell_m)
    values = [[round(best_rssi(twin, floor, (c + 0.5) * cell_m, (r + 0.5) * cell_m, aps), 1)
               for c in range(cols)] for r in range(rows)]
    return {"floor": floor_id, "cell_m": cell_m, "cols": cols, "rows": rows, "rssi": values,
            "threshold_dbm": COVERAGE_THRESHOLD_DBM, "coverage_pct": coverage_percent(values),
            "label": LABEL}


def coverage_percent(values: List[List[float]], threshold_dbm: float = COVERAGE_THRESHOLD_DBM) -> float:
    cells = [v for row in values for v in row]
    if not cells:
        return 0.0
    return round(100.0 * sum(1 for v in cells if v >= threshold_dbm) / len(cells), 1)


def twin_coverage(twin: dict, cell_m: float = DEFAULT_CELL_M) -> dict:
    """Coverage grid and percentage for every floor."""
    return {f["id"]: coverage_grid(twin, f["id"], cell_m) for f in twin["floors"]}
