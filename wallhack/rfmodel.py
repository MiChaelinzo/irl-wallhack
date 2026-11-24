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
diffracted path. So multipath >= enhanced >= basic. No fading, 2D plan geometry. Antenna gain and a sector pattern are optional per AP (default omni, 0 dBi);
each path leaves the AP towards its first segment (receiver, reflection point or corner). Refraction is
not modelled (negligible indoors).
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
WIFI = CONFIG["wifi_standards"]
INTERFERENCE = CONFIG["interference"]
ANTENNA = CONFIG["antenna"]
EXTERNAL = CONFIG["external_sources"]
RELIABILITY = CONFIG["reliability"]
VOIDS = CONFIG["voids"]
SPECTRUM = CONFIG["spectrum"]
DECAY = CONFIG["decay"]
ROAMING = CONFIG["roaming"]
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


def wall_crossings(floor: dict, px: float, py: float, qx: float, qy: float, band: str = DEFAULT_BAND,
                   materials: Optional[Dict[str, dict]] = None, skip_id: Optional[str] = None,
                   skip_point: Optional[Tuple[float, float]] = None):
    """Yield (wall, loss_db, opening) for every wall the straight path p->q crosses on one floor, in wall order.

    `opening` is the door or window the path goes through (its loss replaces the wall loss), else None.
    `skip_id` ignores one wall (the reflector) and `skip_point` ignores walls with an end at that
    point (the corner a diffracted path bends around).
    """
    materials = materials if materials is not None else CONFIG["materials"]
    openings: Dict[str, List[dict]] = {}
    for o in floor["openings"]:
        openings.setdefault(o["wall"], []).append(o)
    for wall in floor["walls"]:
        if wall["id"] == skip_id or (skip_point is not None and _touches(wall, skip_point)):
            continue
        along = _ray_wall_hit(px, py, qx, qy, wall)
        if along is None:
            continue
        loss = wall_material(wall, materials)["attenuation_db"][band]
        through = None
        for o in openings.get(wall["id"], ()):
            if o["pos"] <= along <= o["pos"] + o["width"]:
                loss = CONFIG["openings"][o["kind"]]["attenuation_db"][band]
                through = o
                break
        yield wall, loss, through


def wall_loss_db(floor: dict, px: float, py: float, qx: float, qy: float, band: str = DEFAULT_BAND,
                 materials: Optional[Dict[str, dict]] = None, skip_id: Optional[str] = None,
                 skip_point: Optional[Tuple[float, float]] = None) -> float:
    """Total attenuation from the walls and openings the straight path p->q crosses on one floor (see wall_crossings)."""
    total = 0.0
    for _wall, loss, _opening in wall_crossings(floor, px, py, qx, qy, band, materials, skip_id, skip_point):
        total += loss
    return total


def path_loss_db(distance_m: float, band: str = DEFAULT_BAND) -> float:
    b = BANDS[band]
    return b["pl0_db"] + 10.0 * b["path_loss_exponent"] * math.log10(max(distance_m, MIN_DISTANCE_M))


def antenna_gain_db(ap: dict, bearing_deg: float) -> float:
    """Antenna gain (dBi) of `ap` towards a bearing in degrees (0 = +x east, clockwise on the plan).

    Omni (the default) is the AP's `antenna_gain_dbi` (default 0). Sector adds the 3GPP TR 36.814
    horizontal pattern -min(12 * (phi / beamwidth)^2, front_to_back), phi the angle off `azimuth_deg`.
    """
    gain = ap.get("antenna_gain_dbi", 0.0)
    if ap.get("pattern", "omni") == "omni":
        return gain
    sector = ANTENNA["patterns"]["sector"]
    off = ((bearing_deg - ap.get("azimuth_deg", 0.0) + 540.0) % 360.0) - 180.0
    ratio = off / ap.get("beamwidth_deg", sector["default_beamwidth_deg"])
    return gain - min(ANTENNA["parabolic_coefficient"] * ratio * ratio,
                      ap.get("front_to_back_db", sector["default_front_to_back_db"]))


def antenna_gain_toward(ap: dict, x: float, y: float) -> float:
    """antenna_gain_db towards the point (x, y); 0 without computing a bearing for a plain AP."""
    if "antenna_gain_dbi" not in ap and "pattern" not in ap:
        return 0.0
    return antenna_gain_db(ap, math.atan2(y - ap["y"], x - ap["x"]) * 180.0 / math.pi)


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
    return ap["tx_dbm"] + antenna_gain_toward(ap, rx_, ry_) - loss


def knife_edge_loss_db(v: float) -> float:
    k = KNIFE_EDGE
    if v <= k["v_min"]:
        return 0.0
    return k["offset_db"] + k["log_scale"] * math.log10(math.sqrt((v - k["v_offset"]) ** 2 + 1.0) + v - k["v_offset"])


def _knife_edge_for(ap: dict, corner: Tuple[float, float], x: float, y: float, band: str) -> float:
    """Knife-edge loss (dB) of the path AP -> corner -> (x, y)."""
    ax, ay = ap["x"], ap["y"]
    d1, d2 = math.hypot(corner[0] - ax, corner[1] - ay), math.hypot(x - corner[0], y - corner[1])
    delta = max(0.0, d1 + d2 - math.hypot(x - ax, y - ay))
    wavelength = ENGINE["speed_of_light_mps"] / (BANDS[band]["ghz"] * 1e9)
    return knife_edge_loss_db(math.sqrt(KNIFE_EDGE["v_scale"] * delta / wavelength))


def _diffracted_dbm(ap: dict, floor: dict, corner: Tuple[float, float], x: float, y: float, band: str,
                    materials: Dict[str, dict]) -> float:
    ax, ay = ap["x"], ap["y"]
    d1, d2 = math.hypot(corner[0] - ax, corner[1] - ay), math.hypot(x - corner[0], y - corner[1])
    loss = (path_loss_db(d1 + d2, band) + _knife_edge_for(ap, corner, x, y, band)
            + wall_loss_db(floor, ax, ay, corner[0], corner[1], band, materials, skip_point=corner)
            + wall_loss_db(floor, corner[0], corner[1], x, y, band, materials, skip_point=corner))
    return ap["tx_dbm"] + antenna_gain_toward(ap, corner[0], corner[1]) - loss


def _indirect_paths(ap: dict, floor: dict, x: float, y: float, band: str, materials: Dict[str, dict]) -> List[tuple]:
    """Every reflected and diffracted path to (x, y) as ("reflection", wall, dBm) or ("diffraction", corner, dBm),
    levels before floor loss, reflections in wall order then diffractions in corner order."""
    paths: List[tuple] = []
    blockers = []
    for wall in floor["walls"]:
        if _point_segment_distance(ap["x"], ap["y"], wall) <= MAX_REFLECTOR_RANGE_M:
            level = _reflected_dbm(ap, floor, wall, x, y, band, materials)
            if level is not None:
                paths.append(("reflection", wall, level))
        if _ray_wall_hit(ap["x"], ap["y"], x, y, wall) is not None:
            blockers.append(wall)
    corners: List[Tuple[float, float]] = []
    for wall in blockers:
        for corner in ((wall["x1"], wall["y1"]), (wall["x2"], wall["y2"])):
            if corner not in corners:
                corners.append(corner)
    paths.extend(("diffraction", c, _diffracted_dbm(ap, floor, c, x, y, band, materials)) for c in corners)
    return paths


def _indirect_levels(ap: dict, floor: dict, x: float, y: float, band: str, materials: Dict[str, dict]) -> List[float]:
    """Levels (dBm, before floor loss) of every reflected and diffracted path to (x, y)."""
    return [level for _kind, _ref, level in _indirect_paths(ap, floor, x, y, band, materials)]


def _basic_dbm(ap: dict, floor: dict, x: float, y: float, band: str, materials: Dict[str, dict]) -> float:
    d = max(math.hypot(x - ap["x"], y - ap["y"]), MIN_DISTANCE_M)
    path = BANDS[band]["pl0_db"] + 10.0 * BANDS[band]["path_loss_exponent"] * math.log10(d)
    # On the same floor use that floor's walls; across floors use the receiving floor's walls.
    walls = wall_loss_db(floor, ap["x"], ap["y"], x, y, band, materials)
    return ap["tx_dbm"] + antenna_gain_toward(ap, x, y) - path - walls


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


def _in_polygon(x: float, y: float, points: List[List[float]]) -> bool:
    """Even-odd ray casting. Points on the edge may fall either way, the same in rf-engine.js."""
    inside = False
    j = len(points) - 1
    for i in range(len(points)):
        xi, yi, xj, yj = points[i][0], points[i][1], points[j][0], points[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def in_void(floor: dict, x: float, y: float) -> bool:
    """True if (x, y) lies inside a stairwell, atrium or shaft opening of the floor. Floors without `voids` never do."""
    for v in floor.get("voids", ()):
        if "points" in v:
            if _in_polygon(x, y, v["points"]):
                return True
        elif v["x"] <= x <= v["x"] + v["w"] and v["y"] <= y <= v["y"] + v["d"]:
            return True
    return False


def floors_crossed(ap_floor: dict, floor: dict, floors_apart: int, config: dict = CONFIG) -> float:
    """Floors the signal crosses for the floor loss. It is `floors_apart` (the level difference) unless both floors set
    `elevation_m`, then |elevation difference| / floor_elevation.reference_height_m, at least one, so a tall or a deep
    floor-to-floor gap costs more than one standard floor. Legacy projects without elevation_m keep the whole count."""
    if floors_apart == 0 or "elevation_m" not in ap_floor or "elevation_m" not in floor:
        return floors_apart
    return max(1.0, abs(floor["elevation_m"] - ap_floor["elevation_m"]) / config["floor_elevation"]["reference_height_m"])


def floor_penetration_db(ap: dict, ap_floor: dict, floor: dict, x: float, y: float, floors_apart: int, band: str) -> float:
    """Floor loss between the AP floor and the receiving floor. Every path end that sits inside a void on its own
    floor removes `voids.open_end_reduction` of it (capped at all of it). Without voids it is floor_loss_db x floors."""
    base = CONFIG["floor_loss_db"][band] * floors_crossed(ap_floor, floor, floors_apart)
    if floors_apart == 0:
        return base
    open_ends = int(in_void(ap_floor, ap["x"], ap["y"])) + int(in_void(floor, x, y))
    if open_ends == 0:
        return base
    return base * (1.0 - min(1.0, open_ends * VOIDS["open_end_reduction"]))


def rssi_from_ap(ap: dict, ap_floor: dict, floor: dict, x: float, y: float, floors_apart: int = 0,
                 band: Optional[str] = None, mode: str = "basic",
                 materials: Optional[Dict[str, dict]] = None) -> float:
    """Estimated RSSI at (x, y) on `floor` from `ap`, which sits on `ap_floor`.

    `band` overrides the AP's own band (default: the AP's `band`, else 2.4 GHz).
    """
    b = check_band(band or ap.get("band", DEFAULT_BAND))
    level = MODES[check_mode(mode)](ap, floor, x, y, b, materials if materials is not None else CONFIG["materials"])
    return level - floor_penetration_db(ap, ap_floor, floor, x, y, floors_apart, b)


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


def legacy_table_width(band: str, width_mhz: int, config: dict = CONFIG) -> int:
    """Width to look up in the legacy `mcs_tables` for an AP with a `standard`: its own width if the table has
    it, else the widest table width below it (the narrowest if none), so the legacy throughput stays defined."""
    widths = sorted(int(w) for w in config["mcs_tables"][band])
    return width_mhz if width_mhz in widths else max([w for w in widths if w <= width_mhz] or widths[:1])


def _ap_radio(ap: dict, band: str) -> Tuple[int, int]:
    b = BANDS[band]
    if "width_mhz" in ap:
        width = ap["width_mhz"]
    elif "standard" in ap:
        width = default_width_mhz(ap["standard"], band)   # Wi-Fi 4 has no 80 MHz channel on 5 GHz
    else:
        width = b["default_width_mhz"]
    return ap.get("channel", b["default_channel"]), width


AP_MODEL_FIELDS = ("standard", "spatial_streams", "mlo_bands", "antenna_gain_dbi", "azimuth_deg", "pattern",
                   "beamwidth_deg", "front_to_back_db", "beamforming")   # optional AP fields, copied to ap_grids output when set
SINR_LABEL = "MODEL ESTIMATE: SINR throughput from co-channel and adjacent-channel interference, not a measurement"


def standard_spec(standard: str, config: dict = CONFIG) -> dict:
    spec = config["wifi_standards"]["standards"].get(standard)
    if spec is None:
        raise ValueError(f"standard must be one of {list(config['wifi_standards']['standards'])}")
    return spec


def standard_widths(standard: str, band: str, config: dict = CONFIG) -> List[int]:
    """Channel widths (MHz) the standard allows on a band. A band the standard does not use is an error."""
    widths = standard_spec(standard, config)["widths_mhz_by_band"].get(band)
    if widths is None:
        raise ValueError(f"{standard} is not allowed on the {band} GHz band")
    return widths


def default_width_mhz(standard: str, band: str, config: dict = CONFIG) -> int:
    """The band's default width, or the widest allowed width below it."""
    return max(w for w in standard_widths(standard, band, config) if w <= config["bands"][band]["default_width_mhz"])


def check_standard_radio(standard: str, band: str, width_mhz: Optional[int] = None,
                         streams: Optional[int] = None) -> None:
    """Raise ValueError unless the standard is known, allowed on the band, and allows the width and stream count."""
    widths = standard_widths(standard, band)
    if width_mhz is not None and width_mhz not in widths:
        raise ValueError(f"{standard} allows {widths} MHz on the {band} GHz band")
    if streams is not None and not 1 <= streams <= standard_spec(standard)["max_streams"]:
        raise ValueError(f"{standard} allows 1 to {standard_spec(standard)['max_streams']} spatial streams")


def default_streams(standard: str, config: dict = CONFIG) -> int:
    return min(config["wifi_standards"]["default_streams"], standard_spec(standard, config)["max_streams"])


def noise_floor_dbm(width_mhz: float, config: dict = CONFIG) -> float:
    """Thermal noise floor: -174 dBm/Hz + 10 log10(bandwidth in Hz) + receiver noise figure."""
    i = config["interference"]
    return i["thermal_noise_dbm_per_hz"] + 10.0 * math.log10(width_mhz * 1e6) + i["noise_figure_db"]


def standard_phy_rate_mbps(standard: str, mcs: int, width_mhz: int, streams: int, config: dict = CONFIG) -> float:
    """PHY rate in Mbps: data subcarriers x bits x coding rate x streams / (symbol time + guard interval)."""
    spec, entry = standard_spec(standard, config), config["wifi_standards"]["mcs"][mcs]
    subcarriers = spec["data_subcarriers"].get(str(width_mhz))
    if subcarriers is None:
        raise ValueError(f"{standard} has no {width_mhz} MHz channel")
    num, den = entry["coding_rate"]
    return (subcarriers * entry["bits_per_subcarrier"] * (num / den) * streams
            / (spec["symbol_us"] + config["wifi_standards"]["default_guard_interval_us"]))


def highest_mcs(standard: str, sinr_db: float, config: dict = CONFIG) -> Optional[int]:
    """Highest MCS (up to the standard's maximum) whose minimum SNR the SINR reaches, else None."""
    best = None
    for entry in config["wifi_standards"]["mcs"][:standard_spec(standard, config)["max_mcs"] + 1]:
        if sinr_db >= entry["min_snr_db"]:
            best = entry["index"]
    return best


def sinr_phy_rate_mbps(standard: str, sinr_db: float, width_mhz: int, streams: int, config: dict = CONFIG) -> float:
    """PHY rate the SINR supports through the standard's MCS table, 0 below MCS 0."""
    mcs = highest_mcs(standard, sinr_db, config)
    return 0.0 if mcs is None else standard_phy_rate_mbps(standard, mcs, width_mhz, streams, config)


def channel_centre_mhz(band: str, channel: int, config: dict = CONFIG) -> int:
    i = config["interference"]
    return i["channel_base_mhz"][band] + i["channel_step_mhz"] * channel


def interference_coupling(band: str, channel_a: int, width_a: float, channel_b: float, width_b: float,
                          config: dict = CONFIG) -> float:
    """Fraction (linear) of interferer B's power that lands in victim A's receive band.

    The channel number is taken as the centre of the occupied bandwidth. B's power is spread evenly over
    its width, so the in-band part is overlap / width_b. The rest leaks in through the transmit mask,
    reduced by the rejection table at the gap between the band edges. Beyond `negligible_gap_mhz` it is 0.
    """
    i = config["interference"]
    ca, cb = channel_centre_mhz(band, channel_a, config), channel_centre_mhz(band, channel_b, config)
    overlap = max(0.0, min(ca + width_a / 2.0, cb + width_b / 2.0) - max(ca - width_a / 2.0, cb - width_b / 2.0))
    inband = overlap / width_b
    gap = max(0.0, abs(ca - cb) - (width_a + width_b) / 2.0)
    if inband == 0.0 and gap > i["negligible_gap_mhz"]:
        return 0.0
    rejection = 0.0
    for row in i["rejection_table"]:
        if gap >= row["min_gap_mhz"]:
            rejection = row["rejection_db"]
    return inband + (1.0 - inband) * 10.0 ** (-rejection / 10.0)


def mlo_capacity_mbps(link_rates: List[float], config: dict = CONFIG) -> float:
    """CAPACITY MODEL for Multi-Link Operation: the sum of the fastest `max_links` link rates."""
    return sum(sorted(link_rates, reverse=True)[:config["wifi_standards"]["mlo"]["max_links"]])


def resolve_interferers(twin: dict, config: dict = CONFIG) -> List[dict]:
    """Non-WiFi and neighbour sources of the twin (`twin["interferers"]`) with every default filled in from rf-config.json.

    Each entry has id, kind, floor, x, y, tx_dbm, duty_cycle, band, width_mhz and either `channel` (neighbour WiFi)
    or `centre_mhz` (microwave oven, Bluetooth). MODEL: planning assumptions, see rf-config.json external_sources.
    """
    kinds = config["external_sources"]["kinds"]
    out = []
    for src in twin.get("interferers", ()):
        spec = kinds[src["kind"]]
        entry = {"id": src["id"], "kind": src["kind"], "floor": src["floor"], "x": src["x"], "y": src["y"],
                 "tx_dbm": src.get("tx_dbm", spec["tx_dbm"]), "duty_cycle": src.get("duty_cycle", spec["duty_cycle"])}
        if src["kind"] == "neighbour_wifi":
            band = src.get("band", spec["default_band"])
            entry.update({"band": band, "channel": src.get("channel", config["bands"][band]["default_channel"]),
                          "width_mhz": src.get("width_mhz", config["bands"][band]["default_width_mhz"])})
        else:
            entry.update({"band": spec["band"], "centre_mhz": spec["centre_mhz"], "width_mhz": spec["width_mhz"]})
        out.append(entry)
    return out


def source_span_mhz(src: dict, config: dict = CONFIG) -> Tuple[float, float]:
    """Low and high edge (MHz) of the band a source occupies."""
    centre = channel_centre_mhz(src["band"], src["channel"], config) if "channel" in src else src["centre_mhz"]
    return centre - src["width_mhz"] / 2.0, centre + src["width_mhz"] / 2.0


def external_coupling(src: dict, band: str, channel: int, width_mhz: float, config: dict = CONFIG) -> float:
    """Fraction (linear) of a resolved external source's power that lands in the receive band (channel, width) of a victim.

    Neighbour WiFi uses interference_coupling (transmit-mask skirt included). A non-WiFi source spreads its power evenly
    over its span (Bluetooth hopping over the 78 MHz hop set), so the share is overlap / span width, no skirt.
    """
    if src["band"] != band:
        return 0.0
    if "channel" in src:
        return interference_coupling(band, channel, width_mhz, src["channel"], src["width_mhz"], config)
    centre = channel_centre_mhz(band, channel, config)
    lo, hi = source_span_mhz(src, config)
    return max(0.0, min(centre + width_mhz / 2.0, hi) - max(centre - width_mhz / 2.0, lo)) / src["width_mhz"]


def packet_error_rate(sinr_db: float, mcs: int, config: dict = CONFIG) -> float:
    """ESTIMATE of the packet error rate at an SINR for an MCS: a logistic curve that equals `per_at_min_snr` at the MCS minimum SNR."""
    r = config["reliability"]
    p0 = r["per_at_min_snr"]
    x = (sinr_db - config["wifi_standards"]["mcs"][mcs]["min_snr_db"]) / r["per_scale_db"] + math.log((1.0 - p0) / p0)
    return 1.0 / (1.0 + math.exp(x))


def link_reliability(standard: str, sinr_db: float, rate_mbps: float, busy: float, config: dict = CONFIG) -> dict:
    """ESTIMATES for one cell: PER, loss after retries, latency and the airtime one client needs. `rate_mbps` is the
    throughput the SINR supports (PHY rate times MAC efficiency), `busy` the share of time external sources hold the channel.
    No standard formula exists, the mapping and its assumptions are in rf-config.json reliability."""
    r = config["reliability"]
    mcs = highest_mcs(standard, sinr_db, config)
    per = 1.0 if mcs is None else packet_error_rate(sinr_db, mcs, config)
    busy = min(busy, r["max_busy_fraction"])
    term, transmissions = 1.0, 0.0
    for _ in range(r["retry_limit"] + 1):
        transmissions += term
        term *= per
    goodput = rate_mbps * (1.0 - per) * (1.0 - busy)
    airtime = 100.0 if goodput <= 0.0 else min(100.0, 100.0 * config["analytics"]["per_client_demand_mbps"] / goodput)
    latency = r["base_latency_ms"] + (transmissions - 1.0) * r["retry_penalty_ms"] + busy / (1.0 - busy) * r["medium_wait_ms"]
    return {"per_pct": 100.0 * per, "loss_pct": 100.0 * term, "latency_ms": latency, "airtime_pct": airtime}


def _mean(values: List[float], decimals: int = 1) -> Optional[float]:
    return _round(sum(values) / len(values), decimals) if values else None


def _sinr_section(aps: List[dict], best_ap: List[int], flats: List[List[float]], cols: int, rows: int,
                  config: dict, mlo_grids: Optional[dict], external: Optional[List[dict]] = None,
                  cell_m: float = DEFAULT_CELL_M) -> dict:
    """SINR, SINR-based throughput, MLO capacity and reliability for the cells each AP serves. ESTIMATES only.

    `external` lists resolved non-WiFi and neighbour sources, each with its flat RSSI `grid` on this floor (see analyze_floor).
    They add interference power coupling x duty cycle x level to every cell and, when they are above the carrier sense
    level at the serving AP, busy airtime.
    """
    external = external or []
    interf, mac = config["interference"], config["analytics"]["mac_efficiency"]
    radios = []
    for ap in aps:
        std = ap.get("standard") or interf["fallback_standard"][ap["band"]]
        radios.append({"standard": std, "streams": ap.get("spatial_streams", default_streams(std, config)),
                       "noise": noise_floor_dbm(ap["width_mhz"], config)})
    coupling = [[(interference_coupling(a["band"], a["channel"], a["width_mhz"], b["channel"], b["width_mhz"], config)
                  if i != j and a["band"] == b["band"] else 0.0) for j, b in enumerate(aps)] for i, a in enumerate(aps)]
    ext_coupling = [[external_coupling(src, ap["band"], ap["channel"], ap["width_mhz"], config) for src in external] for ap in aps]
    total = rows * cols
    sinr: List[Optional[float]] = [None] * total
    phy, rate = [0.0] * total, [0.0] * total
    for n in range(total):
        i = best_ap[n]
        if i < 0:
            continue
        power_mw = 0.0
        for j in range(len(aps)):
            if coupling[i][j] > 0.0:
                power_mw += coupling[i][j] * interf["activity_factor"] * 10.0 ** (flats[j][n] / 10.0)
        for k, src in enumerate(external):
            if ext_coupling[i][k] > 0.0:
                power_mw += ext_coupling[i][k] * src["duty_cycle"] * 10.0 ** (src["grid"][n] / 10.0)
        sinr[n] = flats[i][n] - 10.0 * math.log10(10.0 ** (radios[i]["noise"] / 10.0) + power_mw)
        phy[n] = sinr_phy_rate_mbps(radios[i]["standard"], sinr[n], aps[i]["width_mhz"], radios[i]["streams"], config)
        rate[n] = phy[n] * mac
    busy = []
    for i, ap in enumerate(aps):
        col = min(cols - 1, max(0, int(math.floor(ap["x"] / cell_m))))
        row = min(rows - 1, max(0, int(math.floor(ap["y"] / cell_m))))
        busy.append(sum(src["duty_cycle"] for k, src in enumerate(external) if ext_coupling[i][k] > 0.0
                        and src["grid"][row * cols + col] + 10.0 * math.log10(ext_coupling[i][k]) >= config["analytics"]["carrier_sense_dbm"]))
    rel: List[Optional[dict]] = [None] * total
    for n in range(total):
        if best_ap[n] >= 0:
            rel[n] = link_reliability(radios[best_ap[n]]["standard"], sinr[n], rate[n], busy[best_ap[n]], config)
    per_ap = []
    for i, ap in enumerate(aps):
        cells = [n for n in range(total) if best_ap[n] == i]
        r = radios[i]
        spec = standard_spec(r["standard"], config)
        entry = {"id": ap["id"], "standard": r["standard"], "band": ap["band"], "channel": ap["channel"],
                 "width_mhz": ap["width_mhz"], "streams": r["streams"], "noise_floor_dbm": _round(r["noise"], 1),
                 "max_phy_mbps": _round(standard_phy_rate_mbps(r["standard"], spec["max_mcs"], ap["width_mhz"],
                                                               r["streams"], config), 1),
                 "served_cells": len(cells), "mean_sinr_db": _mean([sinr[n] for n in cells]),
                 "mean_throughput_mbps": _mean([rate[n] for n in cells]),
                 "interferers": [aps[j]["id"] for j in range(len(aps)) if coupling[i][j] > 0.0],
                 "external_sources": [src["id"] for k, src in enumerate(external) if ext_coupling[i][k] > 0.0],
                 "reliability": {"channel_busy_pct": _round(100.0 * min(busy[i], config["reliability"]["max_busy_fraction"]), 1),
                                 "mean_per_pct": _mean([rel[n]["per_pct"] for n in cells], 2),
                                 "mean_loss_pct": _mean([rel[n]["loss_pct"] for n in cells], 3),
                                 "mean_latency_ms": _mean([rel[n]["latency_ms"] for n in cells], 1),
                                 "mean_airtime_pct": _mean([rel[n]["airtime_pct"] for n in cells], 1)}}
        extra = (mlo_grids or {}).get(ap["id"])
        if extra:
            capacity = []
            for n in cells:
                links = [phy[n]]
                for band_id in ap["mlo_bands"]:
                    grid = extra[band_id]
                    width = default_width_mhz(r["standard"], band_id, config)
                    links.append(sinr_phy_rate_mbps(r["standard"], grid[n // cols][n % cols] - noise_floor_dbm(width, config),
                                                    width, r["streams"], config))
                capacity.append(mlo_capacity_mbps(links, config) * mac)
            entry["mlo"] = {"label": config["wifi_standards"]["mlo"]["label"], "links": [ap["band"]] + list(ap["mlo_bands"]),
                            "mean_capacity_mbps": _mean(capacity)}
        per_ap.append(entry)
    def rel_rows(key: str, decimals: int) -> List[List[Optional[float]]]:
        return [[None if rel[n] is None else _round(rel[n][key], decimals) for n in range(k * cols, (k + 1) * cols)]
                for k in range(rows)]

    served = [r for r in rel if r is not None]
    reliability = {"label": config["reliability"]["label"], "per_pct": rel_rows("per_pct", 2),
                   "loss_pct": rel_rows("loss_pct", 3), "latency_ms": rel_rows("latency_ms", 1),
                   "airtime_pct": rel_rows("airtime_pct", 1),
                   "mean_per_pct": _mean([r["per_pct"] for r in served], 2),
                   "mean_loss_pct": _mean([r["loss_pct"] for r in served], 3),
                   "mean_latency_ms": _mean([r["latency_ms"] for r in served], 1),
                   "mean_airtime_pct": _mean([r["airtime_pct"] for r in served], 1)}
    return {"label": SINR_LABEL, "noise_figure_db": interf["noise_figure_db"], "reliability": reliability,
            "external_label": config["external_sources"]["label"],
            "external": [{k: v for k, v in src.items() if k != "grid"} for src in external],
            "sinr_db": [[None if v is None else _round(v, 1) for v in sinr[k * cols:(k + 1) * cols]] for k in range(rows)],
            "throughput_mbps": [[_round(v, 1) for v in rate[k * cols:(k + 1) * cols]] for k in range(rows)],
            "mean_sinr_db": _mean([v for v in sinr if v is not None]),
            "mean_throughput_mbps": _round(sum(rate) / total, 1) if total else 0.0, "aps": per_ap}


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
        out[-1].update({k: ap[k] for k in AP_MODEL_FIELDS if k in ap})
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
        region = {"cells": len(members), "area_m2": _round(len(members) * cell_m * cell_m, 2)}
        region["bbox"] = {"x_min": _round(min(cs) * cell_m, 2), "y_min": _round(min(rs) * cell_m, 2),
                          "x_max": _round((max(cs) + 1) * cell_m, 2), "y_max": _round((max(rs) + 1) * cell_m, 2)}
        region["centroid"] = {"x": _round((sum(cs) / len(cs) + 0.5) * cell_m, 2), "y": _round((sum(rs) / len(rs) + 0.5) * cell_m, 2)}
        regions.append(region)
    return regions


def _table_width(ap: dict, config: dict) -> int:
    return legacy_table_width(ap["band"], ap["width_mhz"], config) if "standard" in ap else ap["width_mhz"]


def analytics(grid_result: dict, aps: List[dict], config: dict = CONFIG, mlo_grids: Optional[dict] = None,
              external: Optional[List[dict]] = None, placed_clients: Optional[List[dict]] = None) -> dict:
    """Coverage analytics of one floor. `grid_result` is a coverage_grid result, `aps` the ap_grids list.

    ESTIMATES only. See docs/rf-planner.md for every formula. When any AP sets `standard` the result gains
    a "sinr" section (all other fields are unchanged). `mlo_grids` maps an AP id to {band: RSSI grid} of its
    extra MLO links, built by analyze_floor. `external` lists resolved non-WiFi and neighbour sources with their flat
    RSSI `grid` (resolve_interferers plus a grid per source, built by analyze_floor), folded into the "sinr" section.
    `placed_clients` lists the Smart Home client devices of the floor; when it is not empty the result gains a "clients"
    section (client_capacity_section), otherwise every field is as before.
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
    second_ap, margin, zone, blend = [-1] * total, [None] * total, [0] * total, [None] * total
    zone_ids = config["roaming"]["zone_ids"]
    pair_cells: Dict[Tuple[int, int], int] = {}
    roam_pairs: Dict[Tuple[int, int], int] = {}
    for n in range(total):
        order = sorted(range(len(aps)), key=lambda i: (-flats[i][n], i))
        best_ap.append(order[0] if order and best[n] >= a["dead_zone_dbm"] else -1)
        if best_ap[n] >= 0:
            blend[n] = 100.0
        if len(order) < 2:
            continue
        top = flats[order[0]][n]
        if best_ap[n] >= 0:
            second_ap[n], margin[n] = order[1], top - flats[order[1]][n]
        usable = [i for i in order if flats[i][n] >= a["overlap_min_dbm"] and flats[i][n] >= top - a["overlap_margin_db"]]
        if len(usable) >= 2:
            overlap_cells[n] = True
            zone[n] = zone_ids.index("overlap")
            for x in range(len(usable)):
                for y in range(x + 1, len(usable)):
                    key = tuple(sorted((usable[x], usable[y])))
                    pair_cells[key] = pair_cells.get(key, 0) + 1
        second = flats[order[1]][n]
        if top >= a["roam_min_dbm"] and second >= a["roam_min_dbm"] and top - second <= a["roam_margin_db"]:
            roam_cells[n] = True
            zone[n] = zone_ids.index("handoff")
            blend[n] = 50.0 + 50.0 * min(top - second, a["roam_margin_db"]) / a["roam_margin_db"]
            key = tuple(sorted((order[0], order[1])))
            roam_pairs[key] = roam_pairs.get(key, 0) + 1

    def pair_list(pairs: Dict[Tuple[int, int], int]) -> List[dict]:
        return [{"a": aps[i]["id"], "b": aps[j]["id"], "cells": k, "area_m2": _round(k * area, 2)}
                for (i, j), k in sorted(pairs.items())]

    rates = []
    for n in range(total):
        i = best_ap[n]
        rates.append(estimated_throughput_mbps(best[n], aps[i]["band"], _table_width(aps[i], config), config) if i >= 0 else 0.0)
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
    result = {
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
                    "zones": _regions(roam_cells, cols, rows, cell_m),
                    "map": {"label": config["roaming"]["label"], "zone_ids": zone_ids,
                            "second_ap": [second_ap[r * cols:(r + 1) * cols] for r in range(rows)],
                            "margin_db": [[None if v is None else _round(v, 1) for v in margin[r * cols:(r + 1) * cols]] for r in range(rows)],
                            "zone": [zone[r * cols:(r + 1) * cols] for r in range(rows)],
                            "blend_pct": [[None if v is None else _round(v, 1) for v in blend[r * cols:(r + 1) * cols]] for r in range(rows)]}},
        "throughput_mbps": [[_round(r, 1) for r in rates[k * cols:(k + 1) * cols]] for k in range(rows)],
        "mean_throughput_mbps": _round(sum(rates) / total, 1) if total else 0.0,
        "aps": per_ap, "total_client_capacity": sum(e["client_capacity"] for e in per_ap)}
    if any("standard" in ap for ap in aps):
        result["sinr"] = _sinr_section(aps, best_ap, flats, cols, rows, config, mlo_grids, external, cell_m)
    if placed_clients:
        result["clients"] = client_capacity_section(placed_clients, aps, best_ap, best, cols, rows, cell_m, config)
    return result



# ---------------------------------------------------------------- v2 data models (ESTIMATES)
CLIENT_LABEL = "CAPACITY MODEL: client demand against estimated link rates, OFDMA, MU-MIMO and beamforming are planning models, not measurements"
MATERIAL_BAND_FIELDS = {"2.4": "attenuation24GHz", "5": "attenuation5GHz", "6": "attenuation6GHz"}


def db_to_power_fraction(loss_db: float) -> float:
    """Linear power fraction left after `loss_db` of loss: 10^(-dB / 10)."""
    return 10.0 ** (-loss_db / 10.0)


def material_fields(material: dict, band: str = DEFAULT_BAND) -> dict:
    """Derived, read-only material fields, computed from the stored per-band dB values (nothing new is stored, so
    saved projects and custom materials are unaffected).

    attenuation24GHz, attenuation5GHz, attenuation6GHz: `attenuation_db` per band, in dB.
    penetrationRate: power fraction that passes the wall at `band`, 10^(-attenuation_db / 10).
    reflectionRate: power fraction that is reflected at `band`, 10^(-reflection_loss_db / 10).
    The rates are linear fractions (0 to 1) rounded to 4 decimals. MODEL ESTIMATE from typical dB values. Bands the
    material does not define give None for their attenuation field."""
    check_band(band)
    out = {name: material["attenuation_db"].get(b) for b, name in MATERIAL_BAND_FIELDS.items()}
    out["penetrationRate"] = _round(db_to_power_fraction(material["attenuation_db"][band]), 4)
    out["reflectionRate"] = _round(db_to_power_fraction(material["reflection_loss_db"][band]), 4)
    return out


def ap_profile(profile_id: str, config: dict = CONFIG) -> dict:
    profiles = config["ap_profiles"]["profiles"]
    if profile_id not in profiles:
        raise ValueError(f"profile must be one of {list(profiles)}")
    return profiles[profile_id]


def apply_ap_profile(ap: dict, profile_id: str, band: Optional[str] = None, config: dict = CONFIG) -> dict:
    """A copy of `ap` with the radio fields of a generic class profile: band, standard, spatial_streams, tx_dbm (for
    that band), antenna_gain_dbi, pattern, beamforming and `profile`. Position, id and name stay. Fields that depend on
    the radio and the previous band (channel, width_mhz, MLO links and sector settings) are dropped so the result is valid."""
    profile = ap_profile(profile_id, config)
    chosen = band or profile["band"]
    if chosen not in profile["bands"]:
        raise ValueError(f"profile {profile_id!r} supports the bands {profile['bands']}")
    keep = {k: v for k, v in ap.items() if k in ("id", "x", "y", "name")}
    keep.update({"tx_dbm": profile["tx_dbm"][chosen], "band": chosen, "standard": profile["standard"],
                 "spatial_streams": profile["spatial_streams"], "antenna_gain_dbi": profile["antenna_gain_dbi"],
                 "pattern": profile["pattern"], "beamforming": profile["beamforming"], "profile": profile_id})
    return keep


def ap_streams(ap: dict, config: dict = CONFIG) -> int:
    return ap.get("spatial_streams") or default_streams(ap["standard"], config)


def ofdma_capacity_gain(standard: Optional[str], n_clients: int, config: dict = CONFIG) -> float:
    """CAPACITY MODEL: airtime capacity multiplier from OFDMA. 1 + gain x min(1, (n - 1) / saturation_clients), so a
    single client gains nothing and the gain saturates. Standards without OFDMA give 1."""
    m = config["capacity_models"]["ofdma"]
    gain = m["gain_by_standard"].get(standard)
    if gain is None or n_clients < 2:
        return 1.0
    return 1.0 + gain * min(1.0, (n_clients - 1) / m["saturation_clients"])


def mu_mimo_users(standard: Optional[str], streams: int, n_clients: int, config: dict = CONFIG) -> int:
    """CAPACITY MODEL: clients served at the same time, min(clients, AP streams, standard maximum). 1 without MU-MIMO."""
    limit = config["capacity_models"]["mu_mimo"]["max_users_by_standard"].get(standard)
    if limit is None or n_clients < 1:
        return 1
    return max(1, min(n_clients, streams, limit))


def mu_mimo_capacity_gain(users: int, config: dict = CONFIG) -> float:
    """CAPACITY MODEL: spatial stream sharing, 1 + (users - 1) x spatial_efficiency."""
    return 1.0 + (users - 1) * config["capacity_models"]["mu_mimo"]["spatial_efficiency"]


def beamforming_gain_db(ap: dict, config: dict = CONFIG) -> float:
    """CAPACITY MODEL: steered pattern gain towards a client, in dB. Zero unless the AP sets `beamforming` and its
    standard supports it. min(max_gain_db, array_gain_db_per_doubling x log2(streams) x steering_efficiency)."""
    m = config["capacity_models"]["beamforming"]
    if not ap.get("beamforming") or ap.get("standard") not in m["standards"]:
        return 0.0
    return min(m["max_gain_db"], m["array_gain_db_per_doubling"] * math.log2(ap_streams(ap, config)) * m["steering_efficiency"])


def client_capacity_section(clients: List[dict], aps: List[dict], best_ap: List[int], best: List[float], cols: int,
                            rows: int, cell_m: float, config: dict = CONFIG) -> dict:
    """Smart Home client demand against the estimated link of each client (CAPACITY MODEL).

    Each client attaches to the strongest AP of its cell. It cannot attach when no AP covers the cell (`no_coverage`),
    when the AP band is not in the device bands (`band_unsupported`) or when the link rate is zero (`no_link`).
    The link rate is the legacy throughput estimate at the client RSSI plus the AP beamforming gain. Per AP the raw
    airtime load is the sum of demand / link rate, divided by the OFDMA and MU-MIMO capacity gains. A load above 1
    saturates the AP and every attached client then receives demand / load."""
    devices = config["client_devices"]["devices"]
    attached: Dict[int, List[dict]] = {}
    entries = []
    for c in clients:
        dev = devices[c["device"]]
        col = min(cols - 1, max(0, int(math.floor(c["x"] / cell_m))))
        row = min(rows - 1, max(0, int(math.floor(c["y"] / cell_m))))
        n = row * cols + col
        i = best_ap[n]
        entry = {"id": c["id"], "device": c["device"], "ap": aps[i]["id"] if i >= 0 else None, "status": "ok",
                 "rssi_dbm": _round(best[n], 1), "beamforming_gain_db": 0.0, "link_mbps": 0.0,
                 "demand_mbps": dev["demand_mbps"], "airtime_pct": 0.0, "delivered_mbps": 0.0, "satisfied": False}
        entries.append(entry)
        if i < 0:
            entry["status"] = "no_coverage"
            continue
        if aps[i]["band"] not in dev["bands"]:
            entry["status"] = "band_unsupported"
            continue
        gain = beamforming_gain_db(aps[i], config)
        link = estimated_throughput_mbps(best[n] + gain, aps[i]["band"], _table_width(aps[i], config), config)
        if link <= 0.0:
            entry["status"] = "no_link"
            continue
        entry["beamforming_gain_db"], entry["link_mbps"] = _round(gain, 2), _round(link, 1)
        entry["_airtime"] = dev["demand_mbps"] / link
        attached.setdefault(i, []).append(entry)
    per_ap = []
    for i, ap in enumerate(aps):
        members = attached.get(i, [])
        standard = ap.get("standard")
        users = mu_mimo_users(standard, ap_streams(ap, config) if standard else 1, len(members), config)
        ofdma, mu = ofdma_capacity_gain(standard, len(members), config), mu_mimo_capacity_gain(users, config)
        raw = sum(m["_airtime"] for m in members)
        load = raw / (ofdma * mu)
        for m in members:
            m["airtime_pct"] = _round(100.0 * m["_airtime"] / (ofdma * mu), 1)
            m["delivered_mbps"] = _round(m["demand_mbps"] / max(1.0, load), 2)
            m["satisfied"] = load <= 1.0
        per_ap.append({"id": ap["id"], "clients": len(members), "demand_mbps": _round(sum(m["demand_mbps"] for m in members), 2),
                       "raw_airtime_pct": _round(100.0 * raw, 1), "ofdma_gain": _round(ofdma, 3), "mu_mimo_users": users,
                       "mu_mimo_gain": _round(mu, 3), "airtime_pct": _round(100.0 * load, 1), "saturated": load > 1.0})
    for e in entries:
        e.pop("_airtime", None)
    demand = sum(e["demand_mbps"] for e in entries)
    return {"label": CLIENT_LABEL, "clients": entries, "aps": per_ap,
            "demand_mbps": _round(demand, 2), "delivered_mbps": _round(sum(e["delivered_mbps"] for e in entries), 2),
            "satisfied_pct": _round(100.0 * sum(1 for e in entries if e["satisfied"]) / len(entries), 1) if entries else 0.0}


def analyze_floor(twin: dict, floor_id: str, cell_m: float = DEFAULT_CELL_M, band: Optional[str] = None,
                  mode: str = "basic") -> dict:
    """coverage_grid, ap_grids and analytics for one floor in one call."""
    grids = ap_grids(twin, floor_id, cell_m, None, band, mode)
    mlo_grids = {}
    for f in twin["floors"]:
        for ap in f["aps"]:
            if ap.get("mlo_bands"):
                mlo_grids[ap["id"]] = {b: ap_grids(twin, floor_id, cell_m, [(ap, f)], b, mode)[0]["grid"]
                                       for b in ap["mlo_bands"]}
    external = []
    for src in resolve_interferers(twin):
        pseudo = {"id": src["id"], "x": src["x"], "y": src["y"], "tx_dbm": src["tx_dbm"], "band": src["band"]}
        grid = ap_grids(twin, floor_id, cell_m, [(pseudo, floor_by_id(twin, src["floor"]))], src["band"], mode)[0]["grid"]
        external.append(dict(src, grid=[v for row in grid for v in row]))
    return analytics(coverage_grid(twin, floor_id, cell_m, None, band, mode), grids, CONFIG, mlo_grids, external,
                     floor_by_id(twin, floor_id).get("clients"))


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


def _best_ap_at(twin: dict, floor: dict, x: float, y: float, band: Optional[str], mode: str,
                materials: Dict[str, dict]) -> Optional[tuple]:
    """(rssi, ap, ap_floor, band) of the strongest AP at a point, RSSI rounded to 0.1 dBm, or None without APs."""
    levels = {f["id"]: f["level"] for f in twin["floors"]}
    best = None
    for f in twin["floors"]:
        for ap in f["aps"]:
            used = check_band(band or ap.get("band", DEFAULT_BAND))
            rssi = round(rssi_from_ap(ap, f, floor, x, y, abs(levels[f["id"]] - levels[floor["id"]]), used, mode, materials), 1)
            if best is None or rssi > best[0]:
                best = (rssi, ap, f, used)
    return best


def probe_at(twin: dict, floor_id: str, x: float, y: float, band: Optional[str] = None, mode: str = "basic",
             explain: bool = False) -> dict:
    """Point probe for hover tooltips: RSSI, best AP, distance, obstruction count, throughput estimate.

    With `explain` the result gains an "explain" entry: every term of the level and plain-language text (explain_point).
    """
    floor = floor_by_id(twin, floor_id)
    materials = material_table(twin)
    levels = {f["id"]: f["level"] for f in twin["floors"]}
    best = _best_ap_at(twin, floor, x, y, band, mode, materials)
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
                "throughput_mbps": _round(estimated_throughput_mbps(
                    rssi, used, legacy_table_width(used, width) if "standard" in ap else width), 1)})
    if explain:
        out["explain"] = _explain(twin, floor, ap, ap_floor, x, y, used, mode, materials, rssi)
    return out


# ---------------------------------------------------------------------------------------------
# Explanation of one point: every term of the level, in numbers and in text. A MODEL, like the map.
# ---------------------------------------------------------------------------------------------
EXPLAIN_LABEL = "MODEL ESTIMATE: explanation of the modelled level at one point, each term is a typical planning value, not a measurement"


def _f1(value: float) -> str:
    """One decimal, rounded half up first so Python and JavaScript print the same digits."""
    return f"{_round(value, 1):.1f}"


def _wall_material_name(wall: dict) -> str:
    return wall.get("material") or KIND_DEFAULT_MATERIAL[wall["kind"]]


def _explain_sinr(twin: dict, floor: dict, ap: dict, ap_floor: dict, x: float, y: float, band: str, mode: str,
                  materials: Dict[str, dict], rssi: float) -> dict:
    """SINR terms at a point for an AP with a `standard`: noise, every co-channel/adjacent AP and every external source."""
    interf = INTERFERENCE
    levels = {f["id"]: f["level"] for f in twin["floors"]}
    channel, width = _ap_radio(ap, band)
    std = ap.get("standard") or interf["fallback_standard"][band]
    noise = noise_floor_dbm(width)
    terms, power_mw = [], 0.0
    for f in twin["floors"]:
        for other in f["aps"]:
            ob = other.get("band", DEFAULT_BAND)
            if other is ap or ob != band:
                continue
            o_channel, o_width = _ap_radio(other, ob)
            coupling = interference_coupling(band, channel, width, o_channel, o_width)
            if coupling <= 0.0:
                continue
            level = _round(rssi_from_ap(other, f, floor, x, y, abs(levels[f["id"]] - levels[floor["id"]]), ob, mode, materials), 1)
            mw = coupling * interf["activity_factor"] * 10.0 ** (level / 10.0)
            power_mw += mw
            terms.append({"id": other["id"], "kind": "ap", "level_dbm": level, "coupling": _round(coupling, 4),
                          "duty_cycle": interf["activity_factor"], "power_dbm": _round(10.0 * math.log10(mw), 1)})
    for src in resolve_interferers(twin):
        coupling = external_coupling(src, band, channel, width)
        if coupling <= 0.0:
            continue
        pseudo = {"id": src["id"], "x": src["x"], "y": src["y"], "tx_dbm": src["tx_dbm"], "band": src["band"]}
        src_floor = floor_by_id(twin, src["floor"])
        level = _round(rssi_from_ap(pseudo, src_floor, floor, x, y, abs(src_floor["level"] - floor["level"]), src["band"], mode, materials), 1)
        mw = coupling * src["duty_cycle"] * 10.0 ** (level / 10.0)
        power_mw += mw
        terms.append({"id": src["id"], "kind": src["kind"], "level_dbm": level, "coupling": _round(coupling, 4),
                      "duty_cycle": src["duty_cycle"], "power_dbm": _round(10.0 * math.log10(mw), 1)})
    sinr = rssi - 10.0 * math.log10(10.0 ** (noise / 10.0) + power_mw)
    mcs = highest_mcs(std, sinr)
    streams = ap.get("spatial_streams", default_streams(std))
    rate = sinr_phy_rate_mbps(std, sinr, width, streams) * ANALYTICS["mac_efficiency"]
    rel = link_reliability(std, sinr, rate, 0.0)
    return {"standard": std, "noise_floor_dbm": _round(noise, 1), "interference": terms, "sinr_db": _round(sinr, 1),
            "mcs": mcs, "throughput_mbps": _round(rate, 1), "per_pct": _round(rel["per_pct"], 2),
            "latency_ms": _round(rel["latency_ms"], 1), "loss_pct": _round(rel["loss_pct"], 3),
            "label": SINR_LABEL}


def _explain(twin: dict, floor: dict, ap: dict, ap_floor: dict, x: float, y: float, band: str, mode: str,
             materials: Dict[str, dict], rssi: float) -> dict:
    """Terms of the level of `ap` at (x, y) on `floor`. loss terms sum to total_loss_db and direct_dbm = eirp_dbm - total_loss_db."""
    apart = abs(ap_floor["level"] - floor["level"])
    d = math.hypot(x - ap["x"], y - ap["y"])
    gain = antenna_gain_toward(ap, x, y)
    path = path_loss_db(d, band)
    walls = []
    for wall, loss, opening in wall_crossings(floor, ap["x"], ap["y"], x, y, band, materials):
        name = _wall_material_name(wall)
        walls.append({"wall": wall["id"], "material": name, "material_label": materials[name]["label"],
                      "through": opening["kind"] if opening else "wall", "loss_db": _round(loss, 2)})
    walls_db = sum(w["loss_db"] for w in walls)
    floor_full = CONFIG["floor_loss_db"][band] * floors_crossed(ap_floor, floor, apart)
    floor_db = floor_penetration_db(ap, ap_floor, floor, x, y, apart, band)
    total = _round(path, 2) + walls_db + _round(floor_db, 2)
    direct = ap["tx_dbm"] + gain - total
    indirect = []
    if mode != "basic":
        for kind, ref, level in _indirect_paths(ap, floor, x, y, band, materials):
            level = level - floor_db
            if kind == "reflection":
                name = _wall_material_name(ref)
                indirect.append({"type": "reflection", "wall": ref["id"], "material": name,
                                 "material_label": materials[name]["label"],
                                 "reflection_loss_db": materials[name]["reflection_loss_db"][band],
                                 "level_dbm": _round(level, 1)})
            else:
                indirect.append({"type": "diffraction", "corner": [ref[0], ref[1]],
                                 "knife_edge_loss_db": _round(_knife_edge_for(ap, ref, x, y, band), 2),
                                 "level_dbm": _round(level, 1)})
    paths = [("direct", direct)] + [(e["type"] + (" via " + e["wall"] if e["type"] == "reflection" else ""), e["level_dbm"]) for e in indirect]
    dominant = max(paths, key=lambda p: p[1])[0]
    out = {"label": EXPLAIN_LABEL, "ap_id": ap["id"], "band": band, "mode": mode, "distance_m": _round(d, 2),
           "tx_dbm": ap["tx_dbm"], "antenna_gain_db": _round(gain, 2), "eirp_dbm": _round(ap["tx_dbm"] + gain, 2),
           "path_loss_db": _round(path, 2), "walls": walls, "walls_loss_db": _round(walls_db, 2),
           "floors_crossed": apart, "floor_loss_db": _round(floor_db, 2),
           "floor_loss_without_voids_db": _round(floor_full, 2), "total_loss_db": _round(total, 2),
           "direct_dbm": _round(direct, 2), "indirect": indirect, "dominant_path": dominant, "rssi_dbm": rssi}
    lines = [f"Strongest AP {ap['id']} on {band} GHz, {mode} mode, {_f1(d)} m away.",
             f"Transmit {_f1(ap['tx_dbm'])} dBm plus antenna gain {_f1(gain)} dB gives {_f1(ap['tx_dbm'] + gain)} dBm EIRP.",
             f"Path loss {_f1(path)} dB at {_f1(d)} m (log-distance, exponent {BANDS[band]['path_loss_exponent']:g})."]
    for w in walls:
        what = f"{w['through']} in wall {w['wall']}" if w["through"] != "wall" else f"wall {w['wall']}"
        lines.append(f"Crosses {what} ({w['material_label']}): {_f1(w['loss_db'])} dB.")
    if not walls:
        lines.append("Crosses no walls.")
    if apart:
        note = " (reduced by a stairwell or atrium opening)" if floor_db < floor_full else ""
        lines.append(f"Floor loss {_f1(floor_db)} dB for {apart} floor(s){note}.")
    lines.append(f"Total loss {_f1(total)} dB, so the direct path arrives at {_f1(direct)} dBm.")
    for e in indirect:
        if e["type"] == "reflection":
            lines.append(f"Reflection off wall {e['wall']} ({e['material_label']}, reflection loss {_f1(e['reflection_loss_db'])} dB) arrives at {_f1(e['level_dbm'])} dBm.")
        else:
            lines.append(f"Diffraction around the corner at ({_f1(e['corner'][0])}, {_f1(e['corner'][1])}) m "
                         f"(knife edge {_f1(e['knife_edge_loss_db'])} dB) arrives at {_f1(e['level_dbm'])} dBm.")
    if mode == "multipath":
        lines.append(f"Multipath adds the powers of all paths: {_f1(rssi)} dBm (strongest path: {dominant}).")
    elif mode == "enhanced":
        lines.append(f"Enhanced takes the strongest path ({dominant}): {_f1(rssi)} dBm.")
    else:
        lines.append(f"Basic mode uses the direct path only: {_f1(rssi)} dBm.")
    if ap.get("standard") or any(a.get("standard") for f in twin["floors"] for a in f["aps"]):
        sinr = _explain_sinr(twin, floor, ap, ap_floor, x, y, band, mode, materials, rssi)
        out["sinr"] = sinr
        lines.append(f"Noise floor {_f1(sinr['noise_floor_dbm'])} dBm.")
        for t in sinr["interference"]:
            lines.append(f"Interference from {t['id']} ({t['kind']}): {_f1(t['power_dbm'])} dBm after coupling {t['coupling']:g} and duty cycle {t['duty_cycle']:g}.")
        lines.append(f"SINR {_f1(sinr['sinr_db'])} dB"
                     + (f", MCS {sinr['mcs']}, about {_f1(sinr['throughput_mbps'])} Mbps, packet error {sinr['per_pct']:g} %, latency {_f1(sinr['latency_ms'])} ms (estimates)." if sinr["mcs"] is not None
                        else ", below the lowest MCS: no usable link."))
    out["text"] = lines
    return out



# ---------------------------------------------------------------------------------------------
# Spectrum analysis and signal decay. ESTIMATES from the project's own APs and sources.
# ---------------------------------------------------------------------------------------------
SPECTRUM_LABEL = SPECTRUM["label"]
DECAY_LABEL = DECAY["label"]


def congestion_level(congestion: float, config: dict = CONFIG) -> str:
    """Id of the first congestion level whose `max` the value does not exceed."""
    for level in config["spectrum"]["levels"]:
        if level["max"] is None or congestion <= level["max"]:
            return level["id"]
    raise ValueError("spectrum levels need a closing level with max null")


def spectrum_analysis(twin: dict, band: str, width_mhz: Optional[int] = None, exclude_ap: Optional[str] = None,
                      config: dict = CONFIG) -> dict:
    """Channel occupancy, overlap and congestion of one band, with the best channels to move to. An ESTIMATE.

    Every AP of the twin on `band` (except `exclude_ap`, the AP being re-planned) and every resolved external source on the
    band counts. For each channel of the band, taken as a `width_mhz` wide victim, each source contributes coupling
    x duty cycle (interference_coupling for WiFi, spectral overlap for non-WiFi). Congestion is the sum, the level a
    threshold on it. Distance is ignored.
    """
    check_band(band)
    spec = config["spectrum"]
    width = width_mhz if width_mhz is not None else spec["width_mhz"][band]
    if width not in config["bands"][band]["widths_mhz"]:
        raise ValueError(f"width_mhz must be one of {config['bands'][band]['widths_mhz']} on the {band} GHz band")
    sources = []
    for f in twin["floors"]:
        for ap in f["aps"]:
            if ap.get("band", DEFAULT_BAND) == band and ap["id"] != exclude_ap:
                channel, ap_width = _ap_radio(ap, band)
                sources.append({"id": ap["id"], "kind": "ap", "band": band, "channel": channel, "width_mhz": ap_width,
                                "duty_cycle": config["interference"]["activity_factor"]})
    sources += [src for src in resolve_interferers(twin, config) if src["band"] == band]
    channels = []
    for channel in config["bands"][band]["channels"]:
        centre = channel_centre_mhz(band, channel, config)
        entries, congestion = [], 0.0
        for src in sources:
            coupling = external_coupling(src, band, channel, width, config)
            if coupling <= 0.0:
                continue
            lo, hi = source_span_mhz(src, config)
            entries.append({"id": src["id"], "kind": src["kind"], "coupling": _round(coupling, 4),
                            "overlap_mhz": _round(max(0.0, min(centre + width / 2.0, hi) - max(centre - width / 2.0, lo)), 1)})
            congestion += coupling * src["duty_cycle"]
        channels.append({"channel": channel, "centre_mhz": centre, "sources": entries, "overlapping_sources": len(entries),
                         "congestion": _round(congestion, 3), "occupancy_pct": _round(100.0 * min(1.0, congestion), 1),
                         "level": congestion_level(congestion, config), "_raw": congestion})
    candidates = [c for c in channels if c["channel"] in spec.get("preferred_channels", {}).get(band, [c["channel"] for c in channels])]
    ranked = sorted(range(len(candidates)), key=lambda i: (candidates[i]["_raw"], i))
    suggestions = [{"channel": candidates[i]["channel"], "congestion": candidates[i]["congestion"], "level": candidates[i]["level"]}
                   for i in ranked[:spec["suggestions"]]]
    for c in channels:
        del c["_raw"]
    return {"label": SPECTRUM_LABEL, "band": band, "width_mhz": width, "channels": channels, "suggestions": suggestions}


def signal_decay(twin: dict, floor_id: str, ap_id: str, bearing_deg: float, band: Optional[str] = None, mode: str = "basic",
                 step_m: Optional[float] = None, max_distance_m: Optional[float] = None, config: dict = CONFIG) -> dict:
    """RSSI against distance along a ray from an AP on one floor (0 deg = +x east, clockwise on the plan), an ESTIMATE.

    Samples every `step_m` from the AP up to `max_distance_m` or the edge of the floor, from the same model as the
    coverage map. Each sample also gives the level from distance alone (no walls) and the walls crossed so far.
    """
    check_mode(mode)
    floor = floor_by_id(twin, floor_id)
    found = next(((a, f) for f in twin["floors"] for a in f["aps"] if a["id"] == ap_id), None)
    if found is None:
        raise ValueError(f"unknown AP id {ap_id!r}")
    ap, ap_floor = found
    used = check_band(band or ap.get("band", DEFAULT_BAND))
    step = step_m if step_m is not None else config["decay"]["step_m"]
    limit = max_distance_m if max_distance_m is not None else config["decay"]["max_distance_m"]
    if step <= 0.0 or limit <= 0.0 or limit / step > config["decay"]["max_samples"]:
        raise ValueError(f"step_m and max_distance_m must be positive and give at most {config['decay']['max_samples']} samples")
    materials = material_table(twin)
    apart = abs(ap_floor["level"] - floor["level"])
    dx, dy = math.cos(math.radians(bearing_deg)), math.sin(math.radians(bearing_deg))
    samples = []
    for k in range(int(limit / step) + 1):
        d = k * step
        x, y = ap["x"] + dx * d, ap["y"] + dy * d
        if not (0.0 <= x <= floor["width_m"] and 0.0 <= y <= floor["depth_m"]):
            break
        walls, doors = _obstructions(floor, ap["x"], ap["y"], x, y)
        samples.append({"distance_m": _round(d, 2), "rssi_dbm": _round(max(NO_SIGNAL_DBM, rssi_from_ap(
            ap, ap_floor, floor, x, y, apart, used, mode, materials)), 1),
            "distance_only_dbm": _round(ap["tx_dbm"] + antenna_gain_toward(ap, x, y) - path_loss_db(d, used), 1),
            "walls_crossed": walls, "openings_crossed": doors})
    return {"label": DECAY_LABEL, "ap_id": ap_id, "floor": floor_id, "band": used, "mode": mode, "bearing_deg": bearing_deg,
            "step_m": step, "samples": samples}
