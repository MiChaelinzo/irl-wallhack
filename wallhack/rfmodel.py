"""Indoor WiFi coverage ESTIMATE from the digital twin (a MODEL, not a measurement).

All numbers live in wallhack/static/rf-config.json, which the browser engine (static/rf-engine.js)
reads too. Every value is a typical planning estimate and real buildings differ by 10 dB or more;
calibrate with a site survey before relying on any of it. Pure and deterministic.

Direct path (mode "basic", the default, identical to the original model at 2.4 GHz):

    RSSI = tx_dbm - PL(d) - sum(wall losses on the straight path) - floors_apart * FLOOR_LOSS(band)
    PL(d) = PL0(band) + 10 * n(band) * log10(max(d, 1 m))

PL0 follows free space, PL0(f) = 40 + 20 * log10(f / 2.4 GHz). Each wall loss is the attenuation of
its material at the band (wall "material", else the default for its kind). A door or window opening
replaces the wall loss where the path crosses it.

Mode "enhanced" is the strongest single path of:
  * direct (above);
  * first-order reflection off one wall (image method): mirror the AP across the wall line, the
    segment image->receiver must hit the wall segment and AP and receiver must be on the same side.
    Level = tx - PL(image distance) - reflection_loss(material, band) - losses of the other walls
    crossed on both legs. Walls within max_reflector_range_m of the AP are candidates;
  * diffraction around the endpoints of walls that block the direct path (knife-edge):
    path AP->corner->receiver, delta = d1 + d2 - d_direct, v = sqrt(4 * delta / lambda),
    J(v) = 6.9 + 20 * log10(sqrt((v - 0.1)^2 + 1) + v - 0.1) for v > -0.78 else 0.
    Level = tx - PL(d1 + d2) - J(v) - losses of other walls crossed on both legs.
Mode "multipath" adds the powers (mW, incoherent) of the direct, every reflected and every
diffracted path. So multipath >= enhanced >= basic. No fading, no antenna patterns, 2D plan geometry.
Openings are ignored when reflecting. Walls that touch the corner or reflection point are skipped
for the legs that start there.
"""
import json
import math
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

CONFIG_PATH = Path(__file__).parent / "static" / "rf-config.json"


def load_config(path: Path = CONFIG_PATH) -> dict:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


CONFIG = load_config()
ENGINE = CONFIG["engine"]
BANDS = CONFIG["bands"]
LIMITS = CONFIG["limits"]     # import limits shared with the planner (planner-state.js)
DEFAULT_BAND = "2.4"
PL0_DB = BANDS[DEFAULT_BAND]["pl0_db"]                   # free-space loss at 1 m, 2.4 GHz
PATH_LOSS_EXPONENT = BANDS[DEFAULT_BAND]["path_loss_exponent"]   # typical for an obstructed indoor space
MIN_DISTANCE_M = ENGINE["min_distance_m"]
KIND_DEFAULT_MATERIAL = CONFIG["kind_defaults"]
WALL_LOSS_DB = {k: CONFIG["materials"][m]["attenuation_db"][DEFAULT_BAND] for k, m in KIND_DEFAULT_MATERIAL.items()}
OPENING_LOSS_DB = {k: v["attenuation_db"][DEFAULT_BAND] for k, v in CONFIG["openings"].items()}
FLOOR_LOSS_DB = CONFIG["floor_loss_db"][DEFAULT_BAND]    # per floor crossed
COVERAGE_THRESHOLD_DBM = CONFIG["analytics"]["coverage_dbm"]
DEFAULT_CELL_M = ENGINE["default_cell_m"]
NO_SIGNAL_DBM = ENGINE["no_signal_dbm"]
MAX_REFLECTOR_RANGE_M = ENGINE["max_reflector_range_m"]
PARALLEL_EPSILON = ENGINE["parallel_epsilon"]
CORNER_MATCH_EPSILON_M = ENGINE["corner_match_epsilon_m"]
KNIFE_EDGE = ENGINE["knife_edge"]
LABEL = "ESTIMATE: log-distance model with wall attenuation, not a measurement"
MODE_LABEL = "MODEL ESTIMATE ({mode} mode, {band} GHz), not a measurement"


def check_band(band: str) -> str:
    if band not in BANDS:
        raise ValueError(f"band must be one of {list(BANDS)}")
    return band


def material_table(twin: Optional[dict] = None) -> Dict[str, dict]:
    """Configured materials plus any project-defined custom materials in `twin["materials"]`."""
    table = dict(CONFIG["materials"])
    if twin:
        table.update(twin.get("materials", {}))
    return table


def wall_material(wall: dict, materials: Dict[str, dict]) -> dict:
    """The material record of a wall: its own `material`, else the default for its kind."""
    name = wall.get("material") or KIND_DEFAULT_MATERIAL[wall["kind"]]
    if name not in materials:
        raise ValueError(f"unknown material {name!r} on wall {wall.get('id')!r}")
    return materials[name]


def _cross(ax: float, ay: float, bx: float, by: float) -> float:
    return ax * by - ay * bx


def _ray_wall_hit(px: float, py: float, qx: float, qy: float, wall: dict) -> Optional[float]:
    """Distance along the wall (from its first end) where segment p->q crosses it, or None."""
    rx, ry = qx - px, qy - py
    sx, sy = wall["x2"] - wall["x1"], wall["y2"] - wall["y1"]
    denom = _cross(rx, ry, sx, sy)
    if abs(denom) < PARALLEL_EPSILON:
        return None  # parallel: a ray running along a wall is not counted as crossing it
    t = _cross(wall["x1"] - px, wall["y1"] - py, sx, sy) / denom
    u = _cross(wall["x1"] - px, wall["y1"] - py, rx, ry) / denom
    if 0.0 <= t <= 1.0 and 0.0 <= u <= 1.0:
        return u * math.hypot(sx, sy)
    return None


def _touches(wall: dict, point: Tuple[float, float]) -> bool:
    return any(abs(wall[kx] - point[0]) <= CORNER_MATCH_EPSILON_M and abs(wall[ky] - point[1]) <= CORNER_MATCH_EPSILON_M
               for kx, ky in (("x1", "y1"), ("x2", "y2")))


def wall_loss_db(floor: dict, px: float, py: float, qx: float, qy: float, band: str = DEFAULT_BAND,
                 materials: Optional[Dict[str, dict]] = None, skip_id: Optional[str] = None,
                 skip_point: Optional[Tuple[float, float]] = None) -> float:
    """Total attenuation from the walls and openings the straight path p->q crosses on one floor.

    `skip_id` ignores one wall (the reflector) and `skip_point` ignores walls with an end at that
    point (the corner a diffracted path bends around).
    """
    materials = materials if materials is not None else CONFIG["materials"]
    openings: Dict[str, List[dict]] = {}
    for o in floor["openings"]:
        openings.setdefault(o["wall"], []).append(o)
    total = 0.0
    for wall in floor["walls"]:
        if wall["id"] == skip_id or (skip_point is not None and _touches(wall, skip_point)):
            continue
        along = _ray_wall_hit(px, py, qx, qy, wall)
        if along is None:
            continue
        loss = wall_material(wall, materials)["attenuation_db"][band]
        for o in openings.get(wall["id"], ()):
            if o["pos"] <= along <= o["pos"] + o["width"]:
                loss = CONFIG["openings"][o["kind"]]["attenuation_db"][band]
                break
        total += loss
    return total


def path_loss_db(distance_m: float, band: str = DEFAULT_BAND) -> float:
    b = BANDS[band]
    return b["pl0_db"] + 10.0 * b["path_loss_exponent"] * math.log10(max(distance_m, MIN_DISTANCE_M))


def _point_segment_distance(px: float, py: float, wall: dict) -> float:
    sx, sy = wall["x2"] - wall["x1"], wall["y2"] - wall["y1"]
    t = max(0.0, min(1.0, ((px - wall["x1"]) * sx + (py - wall["y1"]) * sy) / (sx * sx + sy * sy)))
    return math.hypot(px - (wall["x1"] + t * sx), py - (wall["y1"] + t * sy))


def _reflected_dbm(ap: dict, floor: dict, wall: dict, x: float, y: float, band: str,
                   materials: Dict[str, dict]) -> Optional[float]:
    """Level of the first-order reflection off `wall` (image method), or None if there is none."""
    ax, ay = ap["x"], ap["y"]
    sx, sy = wall["x2"] - wall["x1"], wall["y2"] - wall["y1"]
    side_ap, side_rx = _cross(sx, sy, ax - wall["x1"], ay - wall["y1"]), _cross(sx, sy, x - wall["x1"], y - wall["y1"])
    if side_ap == 0.0 or side_rx == 0.0 or (side_ap > 0.0) != (side_rx > 0.0):
        return None
    t = ((ax - wall["x1"]) * sx + (ay - wall["y1"]) * sy) / (sx * sx + sy * sy)
    ix, iy = 2.0 * (wall["x1"] + t * sx) - ax, 2.0 * (wall["y1"] + t * sy) - ay
    along = _ray_wall_hit(ix, iy, x, y, wall)
    if along is None:
        return None
    frac = along / math.hypot(sx, sy)
    rx_, ry_ = wall["x1"] + frac * sx, wall["y1"] + frac * sy
    loss = (path_loss_db(math.hypot(x - ix, y - iy), band)
            + wall_material(wall, materials)["reflection_loss_db"][band]
            + wall_loss_db(floor, ax, ay, rx_, ry_, band, materials, skip_id=wall["id"])
            + wall_loss_db(floor, rx_, ry_, x, y, band, materials, skip_id=wall["id"]))
    return ap["tx_dbm"] - loss


def knife_edge_loss_db(v: float) -> float:
    k = KNIFE_EDGE
    if v <= k["v_min"]:
        return 0.0
    return k["offset_db"] + k["log_scale"] * math.log10(math.sqrt((v - k["v_offset"]) ** 2 + 1.0) + v - k["v_offset"])


def _diffracted_dbm(ap: dict, floor: dict, corner: Tuple[float, float], x: float, y: float, band: str,
                    materials: Dict[str, dict]) -> float:
    ax, ay = ap["x"], ap["y"]
    d1, d2 = math.hypot(corner[0] - ax, corner[1] - ay), math.hypot(x - corner[0], y - corner[1])
    delta = max(0.0, d1 + d2 - math.hypot(x - ax, y - ay))
    wavelength = ENGINE["speed_of_light_mps"] / (BANDS[band]["ghz"] * 1e9)
    v = math.sqrt(KNIFE_EDGE["v_scale"] * delta / wavelength)
    loss = (path_loss_db(d1 + d2, band) + knife_edge_loss_db(v)
            + wall_loss_db(floor, ax, ay, corner[0], corner[1], band, materials, skip_point=corner)
            + wall_loss_db(floor, corner[0], corner[1], x, y, band, materials, skip_point=corner))
    return ap["tx_dbm"] - loss


def _indirect_levels(ap: dict, floor: dict, x: float, y: float, band: str, materials: Dict[str, dict]) -> List[float]:
    """Levels (dBm, before floor loss) of every reflected and diffracted path to (x, y)."""
    levels: List[float] = []
    blockers = []
    for wall in floor["walls"]:
        if _point_segment_distance(ap["x"], ap["y"], wall) <= MAX_REFLECTOR_RANGE_M:
            level = _reflected_dbm(ap, floor, wall, x, y, band, materials)
            if level is not None:
                levels.append(level)
        if _ray_wall_hit(ap["x"], ap["y"], x, y, wall) is not None:
            blockers.append(wall)
    corners: List[Tuple[float, float]] = []
    for wall in blockers:
        for corner in ((wall["x1"], wall["y1"]), (wall["x2"], wall["y2"])):
            if corner not in corners:
                corners.append(corner)
    levels.extend(_diffracted_dbm(ap, floor, c, x, y, band, materials) for c in corners)
    return levels


def _basic_dbm(ap: dict, floor: dict, x: float, y: float, band: str, materials: Dict[str, dict]) -> float:
    d = max(math.hypot(x - ap["x"], y - ap["y"]), MIN_DISTANCE_M)
    path = BANDS[band]["pl0_db"] + 10.0 * BANDS[band]["path_loss_exponent"] * math.log10(d)
    # On the same floor use that floor's walls; across floors use the receiving floor's walls.
    walls = wall_loss_db(floor, ap["x"], ap["y"], x, y, band, materials)
    return ap["tx_dbm"] - path - walls


def _enhanced_dbm(ap: dict, floor: dict, x: float, y: float, band: str, materials: Dict[str, dict]) -> float:
    return max([_basic_dbm(ap, floor, x, y, band, materials)] + _indirect_levels(ap, floor, x, y, band, materials))


def _multipath_dbm(ap: dict, floor: dict, x: float, y: float, band: str, materials: Dict[str, dict]) -> float:
    levels = [_basic_dbm(ap, floor, x, y, band, materials)] + _indirect_levels(ap, floor, x, y, band, materials)
    return 10.0 * math.log10(sum(10.0 ** (v / 10.0) for v in levels))


ModeFn = Callable[[dict, dict, float, float, str, Dict[str, dict]], float]
MODES: Dict[str, ModeFn] = {}


def register_mode(mode_id: str, fn: ModeFn) -> None:
    """Add a propagation mode: fn(ap, floor, x, y, band, materials) -> dBm before floor loss."""
    MODES[mode_id] = fn


register_mode("basic", _basic_dbm)
register_mode("enhanced", _enhanced_dbm)
register_mode("multipath", _multipath_dbm)


def check_mode(mode: str) -> str:
    if mode not in MODES:
        raise ValueError(f"mode must be one of {list(MODES)}")
    return mode


def rssi_from_ap(ap: dict, ap_floor: dict, floor: dict, x: float, y: float, floors_apart: int = 0,
                 band: Optional[str] = None, mode: str = "basic",
                 materials: Optional[Dict[str, dict]] = None) -> float:
    """Estimated RSSI at (x, y) on `floor` from `ap`, which sits on `ap_floor`.

    `band` overrides the AP's own band (default: the AP's `band`, else 2.4 GHz).
    """
    b = check_band(band or ap.get("band", DEFAULT_BAND))
    level = MODES[check_mode(mode)](ap, floor, x, y, b, materials if materials is not None else CONFIG["materials"])
    return level - CONFIG["floor_loss_db"][b] * floors_apart


def best_rssi(twin: dict, floor: dict, x: float, y: float, aps: Optional[List[Tuple[dict, dict]]] = None,
              band: Optional[str] = None, mode: str = "basic", materials: Optional[Dict[str, dict]] = None) -> float:
    """Strongest estimated RSSI at a point. `aps` is a list of (ap, ap_floor); default is every AP."""
    if aps is None:
        aps = [(a, f) for f in twin["floors"] for a in f["aps"]]
    if materials is None:
        materials = material_table(twin)
    best = NO_SIGNAL_DBM
    levels = {f["id"]: f["level"] for f in twin["floors"]}
    for ap, ap_floor in aps:
        apart = abs(levels[ap_floor["id"]] - levels[floor["id"]])
        best = max(best, rssi_from_ap(ap, ap_floor, floor, x, y, apart, band, mode, materials))
    return best


def grid_axes(floor: dict, cell_m: float) -> Tuple[int, int]:
    return max(1, int(math.ceil(floor["width_m"] / cell_m))), max(1, int(math.ceil(floor["depth_m"] / cell_m)))


def coverage_grid(twin: dict, floor_id: str, cell_m: float = DEFAULT_CELL_M,
                  aps: Optional[List[Tuple[dict, dict]]] = None, band: Optional[str] = None,
                  mode: str = "basic") -> dict:
    """Best-AP RSSI at the centre of every cell, rows from north (y=0) to south, values in 0.1 dBm.

    The default arguments reproduce the original model exactly. A non-default `band` or `mode` adds
    "band" and "mode" keys and a mode label to the result.
    """
    if band is not None:
        check_band(band)
    check_mode(mode)
    if not 0.1 <= cell_m <= 5.0:
        raise ValueError("cell_m must be between 0.1 and 5.0")
    floor = next((f for f in twin["floors"] if f["id"] == floor_id), None)
    if floor is None:
        raise ValueError(f"unknown floor id {floor_id!r}")
    cols, rows = grid_axes(floor, cell_m)
    materials = material_table(twin)
    values = [[round(best_rssi(twin, floor, (c + 0.5) * cell_m, (r + 0.5) * cell_m, aps, band, mode, materials), 1)
               for c in range(cols)] for r in range(rows)]
    result = {"floor": floor_id, "cell_m": cell_m, "cols": cols, "rows": rows, "rssi": values,
              "threshold_dbm": COVERAGE_THRESHOLD_DBM, "coverage_pct": coverage_percent(values),
              "label": LABEL}
    if band is not None or mode != "basic":
        result.update({"band": band, "mode": mode, "label": MODE_LABEL.format(mode=mode, band=band or "per-AP")})
    return result


def coverage_percent(values: List[List[float]], threshold_dbm: float = COVERAGE_THRESHOLD_DBM) -> float:
    cells = [v for row in values for v in row]
    if not cells:
        return 0.0
    return round(100.0 * sum(1 for v in cells if v >= threshold_dbm) / len(cells), 1)


def twin_coverage(twin: dict, cell_m: float = DEFAULT_CELL_M) -> dict:
    """Coverage grid and percentage for every floor."""
    return {f["id"]: coverage_grid(twin, f["id"], cell_m) for f in twin["floors"]}


# ---------------------------------------------------------------------------------------------
# Analytics. Every throughput, capacity and utilisation number is an ESTIMATE derived from RSSI
# through the typical PHY-rate tables in rf-config.json, not a measurement. Formulas are documented
# in docs/rf-planner.md ("Analytics"). rf-engine.js implements the same functions and
# tests/test_rf_planner_js.py compares the two.
# ---------------------------------------------------------------------------------------------
ANALYTICS = CONFIG["analytics"]
ANALYTICS_LABEL = "ESTIMATE: throughput, capacity and utilisation are derived from RSSI with typical PHY-rate tables"


def _round(value: float, decimals: int = 1) -> float:
    """Round half up, the same rule as JavaScript Math.round, so Python and JS agree on ties."""
    scale = 10.0 ** decimals
    return math.floor(value * scale + 0.5) / scale


def quality_band(rssi: float, config: dict = CONFIG) -> str:
    """Id of the first quality band whose minimum RSSI the value reaches."""
    for band in config["analytics"]["quality_bands"]:
        if band["min_dbm"] is None or rssi >= band["min_dbm"]:
            return band["id"]
    raise ValueError("quality_bands needs a closing band with min_dbm null")


def phy_rate_mbps(rssi: float, band: str, width_mhz: int, config: dict = CONFIG) -> float:
    """Typical PHY rate at an RSSI: the highest table entry the RSSI reaches, 0 below the lowest."""
    table = config["mcs_tables"][band].get(str(width_mhz))
    if table is None:
        raise ValueError(f"no rate table for {band} GHz at {width_mhz} MHz")
    rate = 0.0
    for entry in table:
        if rssi >= entry["min_dbm"]:
            rate = entry["phy_mbps"]
    return rate


def estimated_throughput_mbps(rssi: float, band: str, width_mhz: int, config: dict = CONFIG) -> float:
    """ESTIMATE of usable throughput: PHY rate times the MAC efficiency factor."""
    return phy_rate_mbps(rssi, band, width_mhz, config) * config["analytics"]["mac_efficiency"]


def _ap_radio(ap: dict, band: str) -> Tuple[int, int]:
    b = BANDS[band]
    return ap.get("channel", b["default_channel"]), ap.get("width_mhz", b["default_width_mhz"])


def ap_grids(twin: dict, floor_id: str, cell_m: float = DEFAULT_CELL_M, aps: Optional[List[Tuple[dict, dict]]] = None,
             band: Optional[str] = None, mode: str = "basic") -> List[dict]:
    """Per-AP RSSI grids (rows north to south, 0.1 dBm) on one floor, in the order of `aps`."""
    check_mode(mode)
    floor = floor_by_id(twin, floor_id)
    if aps is None:
        aps = [(a, f) for f in twin["floors"] for a in f["aps"]]
    cols, rows = grid_axes(floor, cell_m)
    materials = material_table(twin)
    levels = {f["id"]: f["level"] for f in twin["floors"]}
    out = []
    for ap, ap_floor in aps:
        used = check_band(band or ap.get("band", DEFAULT_BAND))
        apart = abs(levels[ap_floor["id"]] - levels[floor["id"]])
        grid = [[round(rssi_from_ap(ap, ap_floor, floor, (c + 0.5) * cell_m, (r + 0.5) * cell_m, apart, used, mode,
                                    materials), 1) for c in range(cols)] for r in range(rows)]
        channel, width = _ap_radio(ap, used)
        out.append({"id": ap["id"], "floor": ap_floor["id"], "x": ap["x"], "y": ap["y"], "tx_dbm": ap["tx_dbm"],
                    "band": used, "channel": channel, "width_mhz": width, "grid": grid})
    return out


def floor_by_id(twin: dict, floor_id: str) -> dict:
    floor = next((f for f in twin["floors"] if f["id"] == floor_id), None)
    if floor is None:
        raise ValueError(f"unknown floor id {floor_id!r}")
    return floor


def _regions(cells: List[bool], cols: int, rows: int, cell_m: float) -> List[dict]:
    """4-connected regions of True cells (flood fill), ordered by their first cell in row-major scan."""
    seen = [False] * len(cells)
    regions = []
    for start in range(len(cells)):
        if not cells[start] or seen[start]:
            continue
        stack, members = [start], []
        seen[start] = True
        while stack:
            n = stack.pop()
            members.append(n)
            r, c = divmod(n, cols)
            for rr, cc in ((r - 1, c), (r + 1, c), (r, c - 1), (r, c + 1)):
                m = rr * cols + cc
                if 0 <= rr < rows and 0 <= cc < cols and cells[m] and not seen[m]:
                    seen[m] = True
                    stack.append(m)
        rs = [n // cols for n in members]
        cs = [n % cols for n in members]
        regions.append({
            "cells": len(members), "area_m2": _round(len(members) * cell_m * cell_m, 2),
            "bbox": {"x_min": _round(min(cs) * cell_m, 2), "y_min": _round(min(rs) * cell_m, 2),
                     "x_max": _round((max(cs) + 1) * cell_m, 2), "y_max": _round((max(rs) + 1) * cell_m, 2)},
            "centroid": {"x": _round((sum(cs) / len(cs) + 0.5) * cell_m, 2),
                         "y": _round((sum(rs) / len(rs) + 0.5) * cell_m, 2)}})
    return regions


def analytics(grid_result: dict, aps: List[dict], config: dict = CONFIG) -> dict:
    """Coverage analytics of one floor. `grid_result` is a coverage_grid result, `aps` the ap_grids list.

    ESTIMATES only. See docs/rf-planner.md for every formula.
    """
    a = config["analytics"]
    rows, cols, cell_m = grid_result["rows"], grid_result["cols"], grid_result["cell_m"]
    area, total = cell_m * cell_m, rows * cols
    best = [v for row in grid_result["rssi"] for v in row]
    flats = [[v for row in ap["grid"] for v in row] for ap in aps]
    quality_counts = {b["id"]: 0 for b in a["quality_bands"]}
    for v in best:
        quality_counts[quality_band(v, config)] += 1
    dead = [v < a["dead_zone_dbm"] for v in best]
    dead_zones = _regions(dead, cols, rows, cell_m)
    best_ap, overlap_cells, roam_cells = [], [False] * total, [False] * total
    pair_cells: Dict[Tuple[int, int], int] = {}
    roam_pairs: Dict[Tuple[int, int], int] = {}
    for n in range(total):
        order = sorted(range(len(aps)), key=lambda i: (-flats[i][n], i))
        best_ap.append(order[0] if order and best[n] >= a["dead_zone_dbm"] else -1)
        if len(order) < 2:
            continue
        top = flats[order[0]][n]
        usable = [i for i in order if flats[i][n] >= a["overlap_min_dbm"] and flats[i][n] >= top - a["overlap_margin_db"]]
        if len(usable) >= 2:
            overlap_cells[n] = True
            for x in range(len(usable)):
                for y in range(x + 1, len(usable)):
                    key = tuple(sorted((usable[x], usable[y])))
                    pair_cells[key] = pair_cells.get(key, 0) + 1
        second = flats[order[1]][n]
        if top >= a["roam_min_dbm"] and second >= a["roam_min_dbm"] and top - second <= a["roam_margin_db"]:
            roam_cells[n] = True
            key = tuple(sorted((order[0], order[1])))
            roam_pairs[key] = roam_pairs.get(key, 0) + 1

    def pair_list(pairs: Dict[Tuple[int, int], int]) -> List[dict]:
        return [{"a": aps[i]["id"], "b": aps[j]["id"], "cells": k, "area_m2": _round(k * area, 2)}
                for (i, j), k in sorted(pairs.items())]

    rates = []
    for n in range(total):
        i = best_ap[n]
        rates.append(estimated_throughput_mbps(best[n], aps[i]["band"], aps[i]["width_mhz"], config) if i >= 0 else 0.0)
    served = [[r for n, r in enumerate(rates) if best_ap[n] == i and r > 0.0] for i in range(len(aps))]
    per_ap = []
    for i, ap in enumerate(aps):
        usable_mbps = len(served[i]) / sum(1.0 / r for r in served[i]) if served[i] else 0.0
        served_area = len(served[i]) * area
        clients = a["client_density_per_100m2"] * served_area / 100.0
        per_ap.append({"id": ap["id"], "band": ap["band"], "channel": ap["channel"], "width_mhz": ap["width_mhz"],
                       "served_cells": len(served[i]), "served_area_m2": _round(served_area, 2),
                       "usable_mbps": _round(usable_mbps, 1),
                       "client_capacity": int(usable_mbps // a["per_client_demand_mbps"]),
                       "expected_clients": _round(clients, 1),
                       "_own": (clients * a["per_client_demand_mbps"] / usable_mbps) if usable_mbps > 0 else 0.0})
    for i, ap in enumerate(aps):
        col = min(cols - 1, max(0, int(math.floor(ap["x"] / cell_m))))
        row = min(rows - 1, max(0, int(math.floor(ap["y"] / cell_m))))
        neighbours = [aps[j]["id"] for j in range(len(aps)) if j != i and aps[j]["band"] == ap["band"]
                      and aps[j]["channel"] == ap["channel"] and aps[j]["grid"][row][col] >= a["carrier_sense_dbm"]]
        shared = per_ap[i]["_own"] + sum(per_ap[j]["_own"] for j in range(len(aps)) if aps[j]["id"] in neighbours)
        per_ap[i].update({"own_utilisation_pct": _round(100.0 * per_ap[i]["_own"], 1),
                          "cochannel_neighbours": neighbours,
                          "channel_utilisation_pct": _round(100.0 * shared, 1), "saturated": shared >= 1.0})
    for entry in per_ap:
        del entry["_own"]
    weak = quality_counts[a["weak_band_id"]]
    dead_cells = sum(dead)
    return {
        "label": ANALYTICS_LABEL, "cell_m": cell_m, "cols": cols, "rows": rows,
        "coverage_pct": _round(100.0 * sum(1 for v in best if v >= a["coverage_dbm"]) / total, 1) if total else 0.0,
        "quality_pct": {k: _round(100.0 * v / total, 1) for k, v in quality_counts.items()},
        "avg_rssi_dbm": _round(sum(best) / total, 1) if total else a["dead_zone_dbm"],
        "weak_area_m2": _round(weak * area, 2), "weak_area_pct": _round(100.0 * weak / total, 1),
        "dead_zone_area_m2": _round(dead_cells * area, 2), "dead_zone_pct": _round(100.0 * dead_cells / total, 1),
        "dead_zones": dead_zones,
        "best_ap": [best_ap[r * cols:(r + 1) * cols] for r in range(rows)],
        "overlap": {"cells": sum(overlap_cells), "area_m2": _round(sum(overlap_cells) * area, 2),
                    "pct": _round(100.0 * sum(overlap_cells) / total, 1), "pairs": pair_list(pair_cells)},
        "roaming": {"cells": sum(roam_cells), "area_m2": _round(sum(roam_cells) * area, 2),
                    "pct": _round(100.0 * sum(roam_cells) / total, 1), "pairs": pair_list(roam_pairs),
                    "zones": _regions(roam_cells, cols, rows, cell_m)},
        "throughput_mbps": [[_round(r, 1) for r in rates[k * cols:(k + 1) * cols]] for k in range(rows)],
        "mean_throughput_mbps": _round(sum(rates) / total, 1) if total else 0.0,
        "aps": per_ap, "total_client_capacity": sum(e["client_capacity"] for e in per_ap)}


def analyze_floor(twin: dict, floor_id: str, cell_m: float = DEFAULT_CELL_M, band: Optional[str] = None,
                  mode: str = "basic") -> dict:
    """coverage_grid, ap_grids and analytics for one floor in one call."""
    grids = ap_grids(twin, floor_id, cell_m, None, band, mode)
    return analytics(coverage_grid(twin, floor_id, cell_m, None, band, mode), grids)


def _obstructions(floor: dict, px: float, py: float, qx: float, qy: float) -> Tuple[int, int]:
    """(walls, openings) the straight path p->q crosses. A crossing through an opening counts as an opening."""
    openings: Dict[str, List[dict]] = {}
    for o in floor["openings"]:
        openings.setdefault(o["wall"], []).append(o)
    walls = doors = 0
    for wall in floor["walls"]:
        along = _ray_wall_hit(px, py, qx, qy, wall)
        if along is None:
            continue
        if any(o["pos"] <= along <= o["pos"] + o["width"] for o in openings.get(wall["id"], ())):
            doors += 1
        else:
            walls += 1
    return walls, doors


def probe_at(twin: dict, floor_id: str, x: float, y: float, band: Optional[str] = None, mode: str = "basic") -> dict:
    """Point probe for hover tooltips: RSSI, best AP, distance, obstruction count, throughput estimate."""
    floor = floor_by_id(twin, floor_id)
    materials = material_table(twin)
    levels = {f["id"]: f["level"] for f in twin["floors"]}
    best = None
    for f in twin["floors"]:
        for ap in f["aps"]:
            used = check_band(band or ap.get("band", DEFAULT_BAND))
            rssi = round(rssi_from_ap(ap, f, floor, x, y, abs(levels[f["id"]] - levels[floor_id]), used, mode, materials), 1)
            if best is None or rssi > best[0]:
                best = (rssi, ap, f, used)
    out = {"x": x, "y": y, "floor": floor_id, "label": ANALYTICS_LABEL}
    if best is None:
        out.update({"rssi_dbm": NO_SIGNAL_DBM, "quality": quality_band(NO_SIGNAL_DBM), "ap_id": None,
                    "distance_m": None, "walls_crossed": 0, "openings_crossed": 0, "floors_crossed": 0,
                    "throughput_mbps": 0.0})
        return out
    rssi, ap, ap_floor, used = best
    rssi = max(rssi, NO_SIGNAL_DBM)
    walls, doors = _obstructions(floor, ap["x"], ap["y"], x, y)
    channel, width = _ap_radio(ap, used)
    out.update({"rssi_dbm": rssi, "quality": quality_band(rssi), "ap_id": ap["id"],
                "distance_m": _round(math.hypot(x - ap["x"], y - ap["y"]), ANALYTICS["probe_distance_decimals"]),
                "walls_crossed": walls, "openings_crossed": doors,
                "floors_crossed": abs(levels[ap_floor["id"]] - levels[floor_id]),
                "throughput_mbps": _round(estimated_throughput_mbps(rssi, used, width), 1)})
    return out
