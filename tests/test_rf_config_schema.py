"""rf-config.json against its JSON Schema, material database consistency and the generated material doc.

jsonschema is not a dependency, so a small stdlib validator covers the keywords the schema uses.
"""
import copy
import importlib.util
import json
import math
import re
import shutil
import subprocess

import pytest

from wallhack import twin
from wallhack.app import STATIC

CONFIG = json.loads((STATIC / "rf-config.json").read_text())
SCHEMA = json.loads((STATIC / "rf-config.schema.json").read_text())
TEN_FAMILIES = {"drywall", "wood", "glass", "brick", "concrete", "reinforced_concrete", "metal", "stone", "flooring", "roofing"}
TYPES = {"object": dict, "array": list, "string": str, "boolean": bool}


def _is_type(value, name):
    if name == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if name == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    return isinstance(value, TYPES[name])


def validate(value, schema, root, path="$"):
    """Return a list of error strings. Supports $ref, type, enum, required, properties, additionalProperties,
    minProperties, items, minItems, maxItems, minLength, minimum, maximum, exclusiveMinimum, pattern, uniqueItems."""
    if "$ref" in schema:
        node = root
        for part in schema["$ref"].lstrip("#/").split("/"):
            node = node[part]
        return validate(value, node, root, path)
    errors = []
    if "type" in schema and not _is_type(value, schema["type"]):
        return [f"{path}: expected {schema['type']}"]
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: {value!r} not in {schema['enum']}")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            errors.append(f"{path}: below minimum {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            errors.append(f"{path}: above maximum {schema['maximum']}")
        if "exclusiveMinimum" in schema and value <= schema["exclusiveMinimum"]:
            errors.append(f"{path}: not above {schema['exclusiveMinimum']}")
    if isinstance(value, str) and len(value) < schema.get("minLength", 0):
        errors.append(f"{path}: shorter than {schema['minLength']}")
    if isinstance(value, str) and "pattern" in schema and not re.search(schema["pattern"], value):
        errors.append(f"{path}: does not match {schema['pattern']}")
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0):
            errors.append(f"{path}: fewer than {schema['minItems']} items")
        if len(value) > schema.get("maxItems", len(value)):
            errors.append(f"{path}: more than {schema['maxItems']} items")
        if schema.get("uniqueItems") and len({json.dumps(v, sort_keys=True) for v in value}) != len(value):
            errors.append(f"{path}: items are not unique")
        for i, item in enumerate(value):
            if "items" in schema:
                errors += validate(item, schema["items"], root, f"{path}[{i}]")
    if isinstance(value, dict):
        if len(value) < schema.get("minProperties", 0):
            errors.append(f"{path}: fewer than {schema['minProperties']} properties")
        errors += [f"{path}: missing '{k}'" for k in schema.get("required", []) if k not in value]
        props = schema.get("properties", {})
        extra = schema.get("additionalProperties", True)
        for key, item in value.items():
            if key in props:
                errors += validate(item, props[key], root, f"{path}.{key}")
            elif extra is False:
                errors.append(f"{path}: unexpected '{key}'")
            elif isinstance(extra, dict):
                errors += validate(item, extra, root, f"{path}.{key}")
    return errors


def test_config_matches_schema():
    assert validate(CONFIG, SCHEMA, SCHEMA) == []


def test_schema_rejects_broken_copies():
    broken = copy.deepcopy(CONFIG)
    del broken["materials"]["glass"]["confidence"]
    assert any("confidence" in e for e in validate(broken, SCHEMA, SCHEMA))
    broken = copy.deepcopy(CONFIG)
    broken["materials"]["glass"]["confidence"] = "certain"
    assert any("confidence" in e for e in validate(broken, SCHEMA, SCHEMA))
    broken = copy.deepcopy(CONFIG)
    broken["materials"]["brick"]["attenuation_db"]["5"] = 500
    assert any("maximum" in e for e in validate(broken, SCHEMA, SCHEMA))
    broken = copy.deepcopy(CONFIG)
    del broken["wifi_standards"]["standards"]["wifi6"]["symbol_us"]
    assert any("symbol_us" in e for e in validate(broken, SCHEMA, SCHEMA))
    broken = copy.deepcopy(CONFIG)
    broken["bands"]["5"]["channels"] = []
    assert any("channels" in e for e in validate(broken, SCHEMA, SCHEMA))
    broken = copy.deepcopy(CONFIG)
    del broken["planner"]["min_mean_rssi_gain_db"]
    assert any("min_mean_rssi_gain_db" in e for e in validate(broken, SCHEMA, SCHEMA))
    broken = copy.deepcopy(CONFIG)
    broken["planner"]["min_mean_rssi_gain_db"] = 0
    assert any("min_mean_rssi_gain_db" in e for e in validate(broken, SCHEMA, SCHEMA))


def test_planner_mean_rssi_threshold_is_documented_and_positive():
    threshold = CONFIG["planner"]["min_mean_rssi_gain_db"]
    schema = SCHEMA["properties"]["planner"]["properties"]["min_mean_rssi_gain_db"]
    assert threshold > 0
    assert "RSSI-only" in schema["description"] and "take priority" in schema["description"] and "equality qualifies" in schema["description"]


def test_insight_block_is_documented_validated_and_consistent():
    ic = CONFIG["insight"]
    assert "ESTIMATE" in ic["label"] and "no standard formula" in ic["source"]
    assert sum(ic["gaming"]["weights"].values()) == pytest.approx(1.0)
    assert sum(ic["score_card"]["weights"].values()) == pytest.approx(1.0)
    for grades in (ic["gaming"]["grades"], ic["score_card"]["grades"], ic["rating_words"]):
        mins = [g["min_score"] for g in grades]
        assert mins == sorted(mins, reverse=True) and mins[-1] == 0, "thresholds must descend to 0 so every score has a grade"
    assert ic["gaming"]["range_low_percentile"] < ic["gaming"]["range_high_percentile"]
    assert ic["time_machine"]["max_items"] <= 4 and {p["profile_id"] for p in ic["time_machine"]["presets"]} <= set(CONFIG["ap_profiles"]["profiles"])
    broken = copy.deepcopy(CONFIG)
    del broken["insight"]["gaming"]["weights"]["ping"]
    assert any("ping" in e for e in validate(broken, SCHEMA, SCHEMA))
    broken = copy.deepcopy(CONFIG)
    broken["insight"]["mesh"]["max_nodes"] = 0
    assert any("max_nodes" in e for e in validate(broken, SCHEMA, SCHEMA))


def test_all_ten_material_families_present():
    assert TEN_FAMILIES <= set(CONFIG["materials"])


def test_legacy_materials_keep_their_values():
    legacy = {"glass": (3.0, 4.0, 4.5), "drywall": (4.0, 5.0, 5.5), "wood": (5.0, 6.5, 7.0), "brick": (9.0, 11.0, 12.0),
              "concrete": (13.0, 17.0, 19.0), "metal": (26.0, 30.0, 32.0)}
    for mid, att in legacy.items():
        assert tuple(CONFIG["materials"][mid]["attenuation_db"][b] for b in ("2.4", "5", "6")) == att


def test_typical_inside_ordered_range_and_matches_attenuation():
    for mid, m in CONFIG["materials"].items():
        assert set(m["range_db"]) == set(m["attenuation_db"]) == set(m["reflection_loss_db"]) == set(CONFIG["bands"]), mid
        for band, r in m["range_db"].items():
            assert r["min"] <= r["typical"] <= r["max"], (mid, band)
            assert r["typical"] == m["attenuation_db"][band], (mid, band)


def test_typical_loss_does_not_fall_with_frequency():
    for mid, m in CONFIG["materials"].items():
        values = [m["attenuation_db"][b] for b in sorted(CONFIG["bands"], key=lambda b: CONFIG["bands"][b]["ghz"])]
        assert values == sorted(values), mid


def test_frequency_exponent_is_derived_from_typical_values():
    lo, hi = CONFIG["bands"]["2.4"]["ghz"], CONFIG["bands"]["6"]["ghz"]
    for mid, m in CONFIG["materials"].items():
        a = m["attenuation_db"]
        assert m["frequency_exponent"] == pytest.approx(math.log(a["6"] / a["2.4"]) / math.log(hi / lo), abs=0.006), mid


def test_kind_defaults_and_band_references_exist():
    for kind, material in CONFIG["kind_defaults"].items():
        assert material in CONFIG["materials"], kind
    assert set(CONFIG["floor_loss_db"]) == set(CONFIG["bands"])
    for std in CONFIG["wifi_standards"]["standards"].values():
        assert set(std["widths_mhz_by_band"]) <= set(CONFIG["bands"])


def test_every_material_has_honest_metadata():
    for mid, m in CONFIG["materials"].items():
        assert any("ITU-R P.2040" in s for s in m["sources"]), mid
    for mid in ("reinforced_concrete", "stone", "flooring", "roofing"):
        assert CONFIG["materials"][mid]["confidence"] == "low", mid


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_planner_state_still_validates_custom_materials_next_to_new_ones():
    d = twin.sample_twin()
    d["materials"] = {"foam": {"label": "Foam", "attenuation_db": {"2.4": 1, "5": 2, "6": 3}, "reflection_loss_db": {"2.4": 4, "5": 5, "6": 6}}}
    d["floors"][0]["walls"][0]["material"] = "foam"
    d["floors"][0]["walls"][1]["material"] = "reinforced_concrete"
    js = """
      const S = require(process.argv[1] + '/planner-state.js');
      const cfg = JSON.parse(require('fs').readFileSync(process.argv[1] + '/rf-config.json', 'utf8'));
      const p = S.validateProject(JSON.parse(require('fs').readFileSync(0, 'utf8')), {config: cfg, materialIds: Object.keys(cfg.materials), bands: Object.keys(cfg.bands)});
      console.log(JSON.stringify([p.floors[0].walls[0].material, p.floors[0].walls[1].material]));
    """
    res = subprocess.run(["node", "-e", js, str(STATIC)], capture_output=True, text=True, input=json.dumps(d))
    assert res.returncode == 0, res.stderr
    assert json.loads(res.stdout) == ["foam", "reinforced_concrete"]
    assert twin.validate_twin(d)["floors"][0]["walls"][1]["material"] == "reinforced_concrete"


def test_material_doc_matches_config():
    spec = importlib.util.spec_from_file_location("material_doc", STATIC.parent.parent / "tools" / "material_doc.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod.DOC_PATH.read_text() == mod.render(CONFIG), "run: python3 tools/material_doc.py"


def test_v2_blocks_are_validated_and_mistakes_are_caught():
    for block in ("floor_elevation", "ap_profiles", "client_devices", "capacity_models"):
        assert block in SCHEMA["required"]
    for mutate in (lambda c: c["ap_profiles"]["profiles"]["consumer"].pop("tx_dbm"),
                   lambda c: c["ap_profiles"]["profiles"]["consumer"].update(beamforming="yes"),
                   lambda c: c["ap_profiles"]["profiles"]["consumer"]["tx_dbm"].update({"5": 90}),
                   lambda c: c["client_devices"]["devices"]["tv"].update(demand_mbps=0),
                   lambda c: c["client_devices"]["devices"]["tv"].update(bands=["5", "5"]),
                   lambda c: c["capacity_models"].update(label="Capacity gains"),
                   lambda c: c["capacity_models"]["mu_mimo"].update(spatial_efficiency=2),
                   lambda c: c["capacity_models"]["ofdma"]["gain_by_standard"].update(wifi6=-1),
                   lambda c: c["floor_elevation"].update(reference_height_m=0)):
        broken = copy.deepcopy(CONFIG)
        mutate(broken)
        assert validate(broken, SCHEMA, SCHEMA), mutate


def test_v2_config_cross_references():
    standards = CONFIG["wifi_standards"]["standards"]
    cm = CONFIG["capacity_models"]
    for section in (cm["ofdma"]["gain_by_standard"], cm["mu_mimo"]["max_users_by_standard"]):
        assert set(section) <= set(standards)
    assert set(cm["beamforming"]["standards"]) <= set(standards)
    for dev in CONFIG["client_devices"]["devices"].values():
        assert set(dev["bands"]) <= set(CONFIG["bands"])
    lo, hi = CONFIG["floor_elevation"]["elevation_m_range"]
    assert lo < 0 < hi
    assert set(CONFIG["ap_profiles"]["profiles"]) == {"consumer", "gaming", "mesh", "enterprise"}


def test_new_materials_in_database_doc():
    doc = (STATIC.parent.parent / "docs" / "platform" / "material-database.md").read_text()
    for mid in ("steel", "aluminium", "tiles", "insulated_wall", "metal_door", "fire_door"):
        assert f"(`{mid}`)" in doc
    assert "penetrationRate" in doc and "reflectionRate" in doc
