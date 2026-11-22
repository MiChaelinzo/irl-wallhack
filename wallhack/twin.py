"""Digital twin: a validated building model (floors, rooms, walls, openings, furniture, sensors, APs).

The model is plain JSON-compatible dicts so the API, the saved file and the static demo share one
shape. All lengths are metres on a floor-local x/y plane (x east, y south, origin at the top-left).
The sample building is an illustration; users replace it with their own layout through PUT /api/twin.
"""
import copy
import json
import math
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import rfmodel

WALL_KINDS = ("interior", "exterior")
OPENING_KINDS = ("door", "window")
FURNITURE_KINDS = tuple(rfmodel.LIMITS["furniture_kinds"])
SENSOR_KINDS = tuple(rfmodel.LIMITS["sensor_kinds"])
TWIN_FILE = "twin.json"
# Limits shared with the browser planner live in rf-config.json ("limits").
MAX_FLOORS = rfmodel.LIMITS["max_floors"]
MAX_ITEMS_PER_LIST = rfmodel.LIMITS["max_items_per_list"]
MAX_WALLS_PER_FLOOR = rfmodel.LIMITS["max_walls_per_floor"]
MAX_OPENINGS_PER_FLOOR = rfmodel.LIMITS["max_openings_per_floor"]
# Walls and openings have their own, larger limits (large plans); every other list uses MAX_ITEMS_PER_LIST.
ITEM_LIMITS = {"walls": MAX_WALLS_PER_FLOOR, "openings": MAX_OPENINGS_PER_FLOOR}
MAX_TEXT_CHARS = rfmodel.LIMITS["max_text_chars"]
DEFAULT_NAME = "Untitled"
TX_DBM_RANGE = (0.0, 30.0)
MAX_CUSTOM_MATERIALS = rfmodel.LIMITS["max_custom_materials"]
MATERIAL_DB_RANGE = tuple(rfmodel.LIMITS["material_db_range"])
THICKNESS_M_RANGE = (0.01, 2.0)
SCALE_M_PER_PX_RANGE = (0.0001, 100.0)
MAX_BACKGROUND_CHARS = rfmodel.LIMITS["max_background_chars"]     # a data URL; PUT /api/twin has its own body limit derived from the limits (app.MAX_TWIN_BODY_BYTES)
BACKGROUND_PATTERN = re.compile(r"^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$")


class TwinError(ValueError):
    """The submitted building model is invalid. The message names the offending path."""


def sample_twin() -> dict:
    """Default two-floor house, 10 m x 8 m per floor. Illustrative only."""
    def ring(prefix: str) -> List[dict]:
        w, d = 10.0, 8.0
        return [{"id": f"{prefix}-n", "x1": 0, "y1": 0, "x2": w, "y2": 0, "kind": "exterior"},
                {"id": f"{prefix}-e", "x1": w, "y1": 0, "x2": w, "y2": d, "kind": "exterior"},
                {"id": f"{prefix}-s", "x1": w, "y1": d, "x2": 0, "y2": d, "kind": "exterior"},
                {"id": f"{prefix}-w", "x1": 0, "y1": d, "x2": 0, "y2": 0, "kind": "exterior"}]
    ground = {
        "id": "ground", "name": "Ground floor", "level": 0, "height_m": 2.6, "width_m": 10.0, "depth_m": 8.0,
        "rooms": [{"id": "living_room", "name": "Living room", "x": 0, "y": 0, "w": 6, "d": 8},
                  {"id": "kitchen", "name": "Kitchen", "x": 6, "y": 0, "w": 4, "d": 4},
                  {"id": "hall", "name": "Hall", "x": 6, "y": 4, "w": 4, "d": 4}],
        "walls": ring("g") + [
            {"id": "g-i1", "x1": 6, "y1": 0, "x2": 6, "y2": 8, "kind": "interior"},
            {"id": "g-i2", "x1": 6, "y1": 4, "x2": 10, "y2": 4, "kind": "interior"}],
        "openings": [{"id": "g-door-front", "kind": "door", "wall": "g-s", "pos": 2.0, "width": 0.9},
                     {"id": "g-door-lr", "kind": "door", "wall": "g-i1", "pos": 5.5, "width": 0.9},
                     {"id": "g-door-k", "kind": "door", "wall": "g-i2", "pos": 1.5, "width": 0.9},
                     {"id": "g-win-lr", "kind": "window", "wall": "g-w", "pos": 3.0, "width": 1.6},
                     {"id": "g-win-k", "kind": "window", "wall": "g-n", "pos": 8.0, "width": 1.2}],
        "furniture": [{"id": "sofa", "kind": "sofa", "x": 1.0, "y": 5.0, "w": 2.2, "d": 0.9},
                      {"id": "table", "kind": "table", "x": 2.0, "y": 2.0, "w": 1.4, "d": 0.9},
                      {"id": "counter", "kind": "counter", "x": 6.3, "y": 0.2, "w": 3.4, "d": 0.6}],
        "sensors": [{"id": "air-1", "kind": "air", "x": 3.0, "y": 4.0},
                    {"id": "rssi-1", "kind": "rssi", "x": 5.5, "y": 7.0}],
        "aps": [{"id": "router", "x": 1.0, "y": 7.0, "tx_dbm": 20.0}],
    }
    upper = {
        "id": "upper", "name": "Upper floor", "level": 1, "height_m": 2.5, "width_m": 10.0, "depth_m": 8.0,
        "rooms": [{"id": "bedroom", "name": "Bedroom", "x": 0, "y": 0, "w": 6, "d": 8},
                  {"id": "bathroom", "name": "Bathroom", "x": 6, "y": 0, "w": 4, "d": 8}],
        "walls": ring("u") + [{"id": "u-i1", "x1": 6, "y1": 0, "x2": 6, "y2": 8, "kind": "interior"}],
        "openings": [{"id": "u-door-br", "kind": "door", "wall": "u-i1", "pos": 3.5, "width": 0.9},
                     {"id": "u-win-br", "kind": "window", "wall": "u-w", "pos": 3.0, "width": 1.6}],
        "furniture": [{"id": "bed", "kind": "bed", "x": 1.0, "y": 1.0, "w": 2.0, "d": 1.6},
                      {"id": "wardrobe", "kind": "wardrobe", "x": 4.6, "y": 0.2, "w": 1.2, "d": 0.6}],
        "sensors": [{"id": "presence-1", "kind": "presence", "x": 3.0, "y": 4.0}],
        "aps": [{"id": "repeater", "x": 2.0, "y": 1.0, "tx_dbm": 17.0}],
    }
    return {"name": "Sample house", "units": "m", "sample": True, "floors": [ground, upper]}


def _num(value: Any, path: str, lo: Optional[float] = None, hi: Optional[float] = None) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise TwinError(f"{path}: must be a finite number")
    if lo is not None and value < lo:
        raise TwinError(f"{path}: must be at least {lo}")
    if hi is not None and value > hi:
        raise TwinError(f"{path}: must be at most {hi}")
    return float(value)


def _text(item: dict, key: str, path: str) -> str:
    v = item.get(key)
    if not isinstance(v, str) or not v.strip() or len(v) > MAX_TEXT_CHARS:
        raise TwinError(f"{path}.{key}: must be a non-empty string up to {MAX_TEXT_CHARS} characters")
    return v


def _choice(item: dict, key: str, allowed: tuple, path: str) -> str:
    v = item.get(key)
    if v not in allowed:
        raise TwinError(f"{path}.{key}: must be one of {list(allowed)}")
    return v


def _optional_text(item: dict, key: str, path: str, out: dict) -> None:
    """Copy an optional short text field into `out` when present."""
    if key in item:
        out[key] = _text(item, key, path)


def _custom_materials(data: Any) -> Dict[str, dict]:
    """Project-defined materials: {id: {label, attenuation_db{band}, reflection_loss_db{band}}}."""
    if not isinstance(data, dict) or len(data) > MAX_CUSTOM_MATERIALS:
        raise TwinError(f"materials: must be an object with at most {MAX_CUSTOM_MATERIALS} entries")
    out: Dict[str, dict] = {}
    for mid, m in data.items():
        p = f"materials.{mid}"
        if not isinstance(mid, str) or not mid.strip() or len(mid) > MAX_TEXT_CHARS or not isinstance(m, dict):
            raise TwinError(f"{p}: must be an object with an id of up to {MAX_TEXT_CHARS} characters")
        entry = {"label": _text(m, "label", p)}
        for key in ("attenuation_db", "reflection_loss_db"):
            table = m.get(key)
            if not isinstance(table, dict) or set(table) != set(rfmodel.BANDS):
                raise TwinError(f"{p}.{key}: must give a value for each band {list(rfmodel.BANDS)}")
            entry[key] = {b: _num(v, f"{p}.{key}.{b}", *MATERIAL_DB_RANGE) for b, v in table.items()}
        out[mid] = entry
    return out


def _items(floor: dict, key: str, path: str) -> List[dict]:
    items = floor.get(key, [])
    limit = ITEM_LIMITS.get(key, MAX_ITEMS_PER_LIST)
    if not isinstance(items, list) or len(items) > limit:
        raise TwinError(f"{path}.{key}: must be a list of at most {limit} items")
    for i, it in enumerate(items):
        if not isinstance(it, dict):
            raise TwinError(f"{path}.{key}[{i}]: must be an object")
    return items


def _unique(ids: List[str], path: str) -> None:
    seen = set()
    for i in ids:
        if i in seen:
            raise TwinError(f"{path}: duplicate id {i!r}")
        seen.add(i)


def validate_twin(data: Any) -> dict:
    """Return a normalised deep copy of `data` or raise TwinError with a clear message."""
    if not isinstance(data, dict):
        raise TwinError("twin: must be an object")
    floors_in = data.get("floors")
    if not isinstance(floors_in, list) or not 1 <= len(floors_in) <= MAX_FLOORS:
        raise TwinError(f"floors: must be a list of 1 to {MAX_FLOORS} floors")
    name = data.get("name")
    # Older projects may have a blank name; they load under a default instead of failing.
    name = name[:MAX_TEXT_CHARS] if isinstance(name, str) and name.strip() else DEFAULT_NAME
    out: Dict[str, Any] = {"name": name, "units": "m",
                           "sample": bool(data.get("sample", False)), "floors": []}
    if "materials" in data:
        out["materials"] = _custom_materials(data["materials"])
    if "mode" in data:
        out["mode"] = _choice(data, "mode", tuple(rfmodel.MODES), "twin")
    materials = rfmodel.material_table(out)
    for fi, f in enumerate(floors_in):
        p = f"floors[{fi}]"
        if not isinstance(f, dict):
            raise TwinError(f"{p}: must be an object")
        width, depth = _num(f.get("width_m"), f"{p}.width_m", 1, 200), _num(f.get("depth_m"), f"{p}.depth_m", 1, 200)

        def inside(x: Any, y: Any, path: str):
            return (_num(x, f"{path}.x", 0, width), _num(y, f"{path}.y", 0, depth))

        floor = {"id": _text(f, "id", p), "name": _text(f, "name", p),
                 "level": int(_num(f.get("level"), f"{p}.level", -5, 50)),
                 "height_m": _num(f.get("height_m", 2.5), f"{p}.height_m", 2, 6),
                 "width_m": width, "depth_m": depth,
                 "rooms": [], "walls": [], "openings": [], "furniture": [], "sensors": [], "aps": []}
        if "scale_m_per_px" in f:
            floor["scale_m_per_px"] = _num(f["scale_m_per_px"], f"{p}.scale_m_per_px", *SCALE_M_PER_PX_RANGE)
        if "background" in f:
            bg = f["background"]
            if not isinstance(bg, str) or len(bg) > MAX_BACKGROUND_CHARS or not BACKGROUND_PATTERN.match(bg):
                raise TwinError(f"{p}.background: must be a png, jpeg or webp base64 data URL of at most "
                                f"{MAX_BACKGROUND_CHARS} characters")
            floor["background"] = bg
        for i, r in enumerate(_items(f, "rooms", p)):
            q = f"{p}.rooms[{i}]"
            x, y = inside(r.get("x"), r.get("y"), q)
            w, d = _num(r.get("w"), f"{q}.w", 0.1), _num(r.get("d"), f"{q}.d", 0.1)
            if x + w > width + 1e-9 or y + d > depth + 1e-9:
                raise TwinError(f"{q}: room extends outside the floor")
            room = {"id": _text(r, "id", q), "name": _text(r, "name", q), "x": x, "y": y, "w": w, "d": d}
            _optional_text(r, "label", q, room)
            floor["rooms"].append(room)
        walls = {}
        for i, w in enumerate(_items(f, "walls", p)):
            q = f"{p}.walls[{i}]"
            x1, y1 = _num(w.get("x1"), f"{q}.x1", 0, width), _num(w.get("y1"), f"{q}.y1", 0, depth)
            x2, y2 = _num(w.get("x2"), f"{q}.x2", 0, width), _num(w.get("y2"), f"{q}.y2", 0, depth)
            if (x1, y1) == (x2, y2):
                raise TwinError(f"{q}: wall has zero length")
            wall = {"id": _text(w, "id", q), "x1": x1, "y1": y1, "x2": x2, "y2": y2,
                    "kind": _choice(w, "kind", WALL_KINDS, q)}
            if "material" in w:
                wall["material"] = _text(w, "material", q)
                if wall["material"] not in materials:
                    raise TwinError(f"{q}.material: must be one of {sorted(materials)}")
            _optional_text(w, "name", q, wall)
            if "thickness_m" in w:
                wall["thickness_m"] = _num(w["thickness_m"], f"{q}.thickness_m", *THICKNESS_M_RANGE)
            walls[wall["id"]] = wall
            floor["walls"].append(wall)
        for i, o in enumerate(_items(f, "openings", p)):
            q = f"{p}.openings[{i}]"
            wall = walls.get(o.get("wall"))
            if wall is None:
                raise TwinError(f"{q}.wall: unknown wall id {o.get('wall')!r}")
            length = math.hypot(wall["x2"] - wall["x1"], wall["y2"] - wall["y1"])
            pos, width_o = _num(o.get("pos"), f"{q}.pos", 0, length), _num(o.get("width"), f"{q}.width", 0.1)
            if pos + width_o > length + 1e-9:
                raise TwinError(f"{q}: opening extends past the end of wall {wall['id']!r}")
            floor["openings"].append({"id": _text(o, "id", q), "kind": _choice(o, "kind", OPENING_KINDS, q),
                                      "wall": wall["id"], "pos": pos, "width": width_o})
        for i, it in enumerate(_items(f, "furniture", p)):
            q = f"{p}.furniture[{i}]"
            x, y = inside(it.get("x"), it.get("y"), q)
            floor["furniture"].append({"id": _text(it, "id", q), "kind": _choice(it, "kind", FURNITURE_KINDS, q),
                                       "x": x, "y": y, "w": _num(it.get("w"), f"{q}.w", 0.05),
                                       "d": _num(it.get("d"), f"{q}.d", 0.05)})
        for i, s in enumerate(_items(f, "sensors", p)):
            q = f"{p}.sensors[{i}]"
            x, y = inside(s.get("x"), s.get("y"), q)
            floor["sensors"].append({"id": _text(s, "id", q), "kind": _choice(s, "kind", SENSOR_KINDS, q), "x": x, "y": y})
        for i, a in enumerate(_items(f, "aps", p)):
            q = f"{p}.aps[{i}]"
            x, y = inside(a.get("x"), a.get("y"), q)
            ap = {"id": _text(a, "id", q), "x": x, "y": y,
                  "tx_dbm": _num(a.get("tx_dbm", 20.0), f"{q}.tx_dbm", *TX_DBM_RANGE)}
            _optional_text(a, "name", q, ap)
            if "band" in a:
                ap["band"] = _choice(a, "band", tuple(rfmodel.BANDS), q)
            if "channel" in a:
                channels = rfmodel.BANDS[ap.get("band", rfmodel.DEFAULT_BAND)]["channels"]
                if isinstance(a["channel"], bool) or a["channel"] not in channels:
                    raise TwinError(f"{q}.channel: must be one of {channels} for this band")
                ap["channel"] = a["channel"]
            floor["aps"].append(ap)
        for key in ("rooms", "walls", "openings", "furniture", "sensors", "aps"):
            _unique([i["id"] for i in floor[key]], f"{p}.{key}")
        out["floors"].append(floor)
    _unique([f["id"] for f in out["floors"]], "floors")
    _unique([str(f["level"]) for f in out["floors"]], "floors.level")
    return out


def twin_path(data_dir: str) -> Path:
    return Path(data_dir) / TWIN_FILE


def load_twin(data_dir: str) -> dict:
    """The saved twin if one exists and is valid, else the sample. A corrupt file is an error."""
    path = twin_path(data_dir)
    if not path.is_file():
        return sample_twin()
    try:
        return validate_twin(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError) as exc:
        raise TwinError(f"cannot read saved twin {path}: {exc}")


def save_twin(data_dir: str, twin: dict) -> dict:
    """Validate and atomically write the twin under `data_dir`. Returns the normalised twin."""
    clean = validate_twin(twin)
    clean["sample"] = False
    path = twin_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(clean, fh, indent=2, sort_keys=True)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return copy.deepcopy(clean)


def floor_by_id(twin: dict, floor_id: str) -> dict:
    for f in twin["floors"]:
        if f["id"] == floor_id:
            return f
    raise TwinError(f"unknown floor id {floor_id!r}")
