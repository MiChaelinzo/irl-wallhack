"""V2 data models: derived material fields, AP class profiles, floor elevation, client devices and the capacity models.

Python (wallhack.rfmodel) is the reference, wallhack/static/rf-engine.js must give the same output."""
import copy
import json
import math
import shutil
import subprocess

import pytest

from wallhack import rfmodel, twin
from wallhack.app import STATIC

CONFIG = rfmodel.CONFIG
NEW_MATERIALS = ("steel", "aluminium", "tiles", "insulated_wall", "metal_door", "fire_door")
needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")


def v2_project():
    """Sample twin with a profile AP, elevations on both floors and five clients on the ground floor."""
    d = twin.sample_twin()
    ground, upper = d["floors"]
    ground["elevation_m"], upper["elevation_m"] = 0.0, 5.4
    ground["aps"][0] = rfmodel.apply_ap_profile(ground["aps"][0], "enterprise")
    ground["clients"] = [{"id": "cam", "device": "camera", "x": 2.0, "y": 6.0},
                         {"id": "tv", "device": "tv", "x": 4.0, "y": 5.0},
                         {"id": "ph", "device": "phone", "x": 6.0, "y": 3.0},
                         {"id": "gc", "device": "console", "x": 8.0, "y": 2.0},
                         {"id": "io", "device": "iot", "x": 9.5, "y": 7.5}]
    return twin.validate_twin(d)


# ---------------------------------------------------------------- materials
def test_new_materials_exist_with_metadata():
    for mid in NEW_MATERIALS:
        m = CONFIG["materials"][mid]
        assert m["confidence"] == "low" and any("ITU-R P.2040" in s for s in m["sources"]), mid
        assert set(m["range_db"]) == set(m["attenuation_db"]) == set(CONFIG["bands"]), mid
    assert CONFIG["materials"]["metal_door"]["attenuation_db"]["2.4"] < CONFIG["materials"]["steel"]["attenuation_db"]["2.4"]
    assert CONFIG["materials"]["fire_door"]["attenuation_db"]["2.4"] > CONFIG["materials"]["wood"]["attenuation_db"]["2.4"]


def test_material_fields_derive_from_db_values():
    steel = CONFIG["materials"]["steel"]
    f = rfmodel.material_fields(steel)
    assert (f["attenuation24GHz"], f["attenuation5GHz"], f["attenuation6GHz"]) == (32.0, 36.0, 38.0)
    assert f["penetrationRate"] == pytest.approx(10 ** (-3.2), abs=5e-5)
    assert f["reflectionRate"] == pytest.approx(10 ** -0.05, abs=5e-5)
    assert rfmodel.material_fields(steel, "6")["penetrationRate"] < f["penetrationRate"]
    for mid, m in CONFIG["materials"].items():
        r = rfmodel.material_fields(m)
        assert 0.0 <= r["penetrationRate"] <= 1.0 and 0.0 <= r["reflectionRate"] <= 1.0, mid
    with pytest.raises(ValueError):
        rfmodel.material_fields(steel, "60")


def test_material_fields_do_not_change_stored_data_or_saved_projects():
    d = twin.sample_twin()
    d["materials"] = {"foam": {"label": "Foam", "attenuation_db": {"2.4": 1, "5": 2, "6": 3}, "reflection_loss_db": {"2.4": 4, "5": 5, "6": 6}}}
    before = copy.deepcopy(d)
    rfmodel.material_fields(rfmodel.material_table(d)["foam"])
    assert d == before
    assert "attenuation24GHz" not in json.dumps(twin.validate_twin(d))


# ---------------------------------------------------------------- AP class profiles
def test_profiles_are_generic_classes_within_eirp_limits():
    block = CONFIG["ap_profiles"]
    assert set(block["profiles"]) == {"consumer", "gaming", "mesh", "enterprise"}
    for pid, p in block["profiles"].items():
        assert p["band"] in p["bands"], pid
        assert set(p["tx_dbm"]) == set(p["bands"]), pid
        for band in p["bands"]:
            rfmodel.check_standard_radio(p["standard"], band)
            for regime, limits in block["eirp_limit_dbm"].items():
                assert p["tx_dbm"][band] + p["antenna_gain_dbi"] <= limits[band], (pid, band, regime)
        assert p["spatial_streams"] <= rfmodel.standard_spec(p["standard"])["max_streams"], pid
        assert p["pattern"] in CONFIG["antenna"]["patterns"], pid


def test_applying_a_profile_sets_valid_ap_fields_and_keeps_identity():
    ap = {"id": "a1", "x": 1.0, "y": 2.0, "tx_dbm": 20.0, "name": "Hall", "channel": 6, "width_mhz": 20}
    for pid, p in CONFIG["ap_profiles"]["profiles"].items():
        for band in p["bands"]:
            out = rfmodel.apply_ap_profile(ap, pid, band)
            assert (out["id"], out["x"], out["y"], out["name"]) == ("a1", 1.0, 2.0, "Hall")
            assert out["tx_dbm"] == p["tx_dbm"][band] and out["band"] == band and out["profile"] == pid
            assert "channel" not in out and "width_mhz" not in out
            d = twin.sample_twin()
            d["floors"][0]["aps"] = [out]
            assert twin.validate_twin(d)["floors"][0]["aps"][0]["profile"] == pid
    with pytest.raises(ValueError):
        rfmodel.apply_ap_profile(ap, "router_x")
    with pytest.raises(ValueError):
        rfmodel.apply_ap_profile(ap, "consumer", "6")
    assert ap["tx_dbm"] == 20.0


def test_twin_rejects_bad_profile_and_beamforming():
    for key, value in (("profile", "linksys"), ("beamforming", "yes")):
        d = twin.sample_twin()
        d["floors"][0]["aps"][0][key] = value
        with pytest.raises(twin.TwinError):
            twin.validate_twin(d)


# ---------------------------------------------------------------- floor elevation
def test_elevation_scales_floor_loss_and_legacy_is_unchanged():
    d = twin.sample_twin()
    ground, upper = d["floors"]
    ap = ground["aps"][0]
    legacy = rfmodel.rssi_from_ap(ap, ground, upper, 5.0, 4.0, 1, "5")
    assert rfmodel.floors_crossed(ground, upper, 1) == 1
    ground["elevation_m"], upper["elevation_m"] = 0.0, 6.0
    ref = CONFIG["floor_elevation"]["reference_height_m"]
    assert rfmodel.floors_crossed(ground, upper, 1) == pytest.approx(6.0 / ref)
    deep = rfmodel.rssi_from_ap(ap, ground, upper, 5.0, 4.0, 1, "5")
    assert deep == pytest.approx(legacy - CONFIG["floor_loss_db"]["5"] * (6.0 / ref - 1), abs=1e-9)
    upper["elevation_m"] = 1.0    # never less than one floor
    assert rfmodel.floors_crossed(ground, upper, 1) == 1.0
    assert rfmodel.floors_crossed(ground, ground, 0) == 0


def test_basement_has_negative_elevation_and_validation_bounds():
    d = twin.sample_twin()
    d["floors"][0]["elevation_m"] = -3.0
    assert twin.validate_twin(d)["floors"][0]["elevation_m"] == -3.0
    d["floors"][0]["elevation_m"] = -500.0
    with pytest.raises(twin.TwinError):
        twin.validate_twin(d)
    assert "elevation_m" not in twin.validate_twin(twin.sample_twin())["floors"][0]


# ---------------------------------------------------------------- capacity models
def test_ofdma_mu_mimo_and_beamforming_models():
    assert rfmodel.ofdma_capacity_gain("wifi6", 1) == 1.0
    assert rfmodel.ofdma_capacity_gain("wifi5", 6) == 1.0 and rfmodel.ofdma_capacity_gain(None, 6) == 1.0
    assert rfmodel.ofdma_capacity_gain("wifi6", 3) < rfmodel.ofdma_capacity_gain("wifi6", 9) == rfmodel.ofdma_capacity_gain("wifi6", 50)
    assert rfmodel.ofdma_capacity_gain("wifi7", 50) == pytest.approx(1.2)
    assert rfmodel.mu_mimo_users("wifi6", 4, 10) == 4 and rfmodel.mu_mimo_users("wifi6", 8, 2) == 2
    assert rfmodel.mu_mimo_users("wifi4", 4, 10) == 1 and rfmodel.mu_mimo_users(None, 1, 3) == 1
    assert rfmodel.mu_mimo_capacity_gain(1) == 1.0 and rfmodel.mu_mimo_capacity_gain(3) == pytest.approx(2.4)
    bf = {"standard": "wifi7", "spatial_streams": 4, "beamforming": True}
    assert rfmodel.beamforming_gain_db(bf) == pytest.approx(3.0)
    assert rfmodel.beamforming_gain_db(dict(bf, spatial_streams=16)) == 6.0     # capped
    assert rfmodel.beamforming_gain_db(dict(bf, beamforming=False)) == 0.0
    assert rfmodel.beamforming_gain_db({"beamforming": True}) == 0.0
    assert rfmodel.beamforming_gain_db(dict(bf, spatial_streams=1)) == 0.0


def test_capacity_models_are_labelled_models():
    assert CONFIG["capacity_models"]["label"].startswith("CAPACITY MODEL")
    assert "not a measurement" in CONFIG["capacity_models"]["label"]
    assert rfmodel.CLIENT_LABEL.startswith("CAPACITY MODEL")


def test_client_section_absent_without_clients_and_present_with():
    d = twin.sample_twin()
    assert "clients" not in rfmodel.analyze_floor(d, "ground")
    result = rfmodel.analyze_floor(v2_project(), "ground")["clients"]
    assert [c["id"] for c in result["clients"]] == ["cam", "tv", "ph", "gc", "io"]
    by_id = {c["id"]: c for c in result["clients"]}
    assert all(c["ap"] == "router" for c in result["clients"])
    assert by_id["cam"]["demand_mbps"] == CONFIG["client_devices"]["devices"]["camera"]["demand_mbps"]
    assert result["aps"][0]["clients"] == sum(1 for c in result["clients"] if c["status"] == "ok")
    assert result["aps"][0]["ofdma_gain"] > 1.0 and result["aps"][0]["mu_mimo_users"] > 1
    assert by_id["cam"]["beamforming_gain_db"] == 3.0


def test_band_capability_and_coverage_gate_clients():
    p = v2_project()
    p["floors"][0]["aps"][0]["band"] = "6"      # the IoT device is 2.4 GHz only
    p["floors"][0]["aps"][0]["tx_dbm"] = 18.0
    out = rfmodel.analyze_floor(p, "ground")["clients"]["clients"]
    assert {c["id"]: c["status"] for c in out}["io"] == "band_unsupported"
    assert [c for c in out if c["id"] == "io"][0]["satisfied"] is False


def test_models_raise_capacity_and_saturation_follows_load():
    p = v2_project()
    models_on = rfmodel.analyze_floor(p, "ground")["clients"]["aps"][0]
    old = p["floors"][0]["aps"][0]
    old.pop("standard"), old.pop("spatial_streams"), old.pop("beamforming")
    off = rfmodel.analyze_floor(p, "ground")["clients"]["aps"][0]
    assert (off["ofdma_gain"], off["mu_mimo_gain"]) == (1.0, 1.0)
    assert models_on["airtime_pct"] < off["airtime_pct"]
    p["floors"][0]["clients"] = [{"id": f"t{i}", "device": "tv", "x": 5.0, "y": 5.0} for i in range(40)]
    heavy = rfmodel.analyze_floor(p, "ground")["clients"]
    assert heavy["aps"][0]["saturated"] and heavy["satisfied_pct"] == 0.0
    assert heavy["delivered_mbps"] < heavy["demand_mbps"]


def test_twin_validates_clients():
    p = v2_project()
    assert len(p["floors"][0]["clients"]) == 5
    for bad in ({"id": "x", "device": "toaster", "x": 1.0, "y": 1.0}, {"id": "x", "device": "tv", "x": 99.0, "y": 1.0}):
        d = copy.deepcopy(p)
        d["floors"][0]["clients"] = [bad]
        with pytest.raises(twin.TwinError):
            twin.validate_twin(d)
    d = copy.deepcopy(p)
    d["floors"][0]["clients"].append(dict(d["floors"][0]["clients"][0]))
    with pytest.raises(twin.TwinError):
        twin.validate_twin(d)


# ---------------------------------------------------------------- Python and JS parity
SCRIPT = """
const E = require(process.argv[1] + '/rf-engine.js');
const S = require(process.argv[1] + '/planner-state.js');
const { config, project, materials, profiles, models } = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const env = E.makeEnv(config, project.materials);
const out = {
  analytics: E.analyzeFloor(project, 'ground', { env, cellM: 0.5 }),
  upperGrid: E.coverageGrid(project, 'upper', { env, cellM: 1, band: '5' }),
  materials: materials.map(m => [E.materialFields(config, config.materials[m[0]], m[1])]),
  profiles: profiles.map(p => E.applyApProfile(config, p.ap, p.id, p.band)),
  models: {
    ofdma: models.ofdma.map(a => E.ofdmaCapacityGain(config, a[0] === null ? undefined : a[0], a[1])),
    users: models.users.map(a => E.muMimoUsers(config, a[0] === null ? undefined : a[0], a[1], a[2])),
    mu: models.mu.map(u => E.muMimoCapacityGain(config, u)),
    bf: models.bf.map(ap => E.beamformingGainDb(config, ap)),
  },
  validated: S.validateProject(project, { config, materialIds: Object.keys(config.materials), bands: Object.keys(config.bands) }),
};
console.log(JSON.stringify(out));
"""


@needs_node
def test_python_and_js_agree_on_v2_models():
    project = v2_project()
    materials = [[m, b] for m in NEW_MATERIALS + ("glass", "concrete") for b in ("2.4", "5", "6")]
    profiles = [{"ap": {"id": "a", "x": 1.0, "y": 2.0, "tx_dbm": 20.0, "channel": 6}, "id": pid, "band": b}
                for pid, p in CONFIG["ap_profiles"]["profiles"].items() for b in (None, *p["bands"])]
    models = {"ofdma": [["wifi6", 1], ["wifi6", 4], ["wifi7", 50], ["wifi5", 5], [None, 3]],
              "users": [["wifi6", 4, 10], ["wifi6", 8, 2], ["wifi4", 4, 10], [None, 1, 3], ["wifi5", 8, 9]],
              "mu": [1, 2, 3, 8],
              "bf": [{"standard": "wifi7", "spatial_streams": 4, "beamforming": True}, {"standard": "wifi6", "beamforming": True},
                     {"standard": "wifi7", "spatial_streams": 16, "beamforming": True}, {"standard": "wifi4", "beamforming": True},
                     {"standard": "wifi7", "beamforming": False}, {"beamforming": True}]}
    res = subprocess.run(["node", "-e", SCRIPT, str(STATIC)], capture_output=True, text=True,
                         input=json.dumps({"config": CONFIG, "project": project, "materials": materials, "profiles": profiles, "models": models}))
    assert res.returncode == 0, res.stderr
    js = json.loads(res.stdout)
    py = rfmodel.analyze_floor(project, "ground", 0.5)
    assert js["analytics"]["clients"] == py["clients"]
    assert js["analytics"]["coverage_pct"] == py["coverage_pct"]
    assert js["materials"] == [[rfmodel.material_fields(CONFIG["materials"][m], b)] for m, b in materials]
    assert js["profiles"] == [rfmodel.apply_ap_profile(p["ap"], p["id"], p["band"]) for p in profiles]
    assert js["models"]["ofdma"] == [rfmodel.ofdma_capacity_gain(*a) for a in models["ofdma"]]
    assert js["models"]["users"] == [rfmodel.mu_mimo_users(*a) for a in models["users"]]
    assert js["models"]["mu"] == [rfmodel.mu_mimo_capacity_gain(u) for u in models["mu"]]
    assert js["models"]["bf"] == pytest.approx([rfmodel.beamforming_gain_db(a) for a in models["bf"]])
    py_upper = rfmodel.coverage_grid(project, "upper", 1.0, None, "5")
    worst = max(abs(a - b) for ra, rb in zip(js["upperGrid"]["rssi"], py_upper["rssi"]) for a, b in zip(ra, rb))
    assert worst <= 0.1 + 1e-9      # the upper floor is reached through the elevation model
    assert js["validated"]["floors"][0]["clients"] == project["floors"][0]["clients"]
    assert js["validated"]["floors"][0]["elevation_m"] == 0.0 and js["validated"]["floors"][1]["elevation_m"] == 5.4
    assert js["validated"]["floors"][0]["aps"][0]["profile"] == "enterprise"


@needs_node
def test_js_validation_rejects_what_python_rejects():
    js = """
      const S = require(process.argv[1] + '/planner-state.js');
      const cfg = JSON.parse(require('fs').readFileSync(process.argv[1] + '/rf-config.json', 'utf8'));
      const cases = JSON.parse(require('fs').readFileSync(0, 'utf8'));
      console.log(JSON.stringify(cases.map(c => { try { S.validateProject(c, {config: cfg, materialIds: Object.keys(cfg.materials), bands: Object.keys(cfg.bands)}); return true; } catch (e) { return false; } })));
    """
    cases = []
    for edit in (lambda d: d["floors"][0].update(elevation_m=-500.0),
                 lambda d: d["floors"][0]["aps"][0].update(profile="linksys"),
                 lambda d: d["floors"][0]["aps"][0].update(beamforming="yes"),
                 lambda d: d["floors"][0].update(clients=[{"id": "x", "device": "toaster", "x": 1, "y": 1}]),
                 lambda d: d["floors"][0].update(clients=[{"id": "x", "device": "tv", "x": 99, "y": 1}]),
                 lambda d: d["floors"][0].update(elevation_m=-3.0)):
        d = twin.sample_twin()
        edit(d)
        cases.append(d)
    res = subprocess.run(["node", "-e", js, str(STATIC)], capture_output=True, text=True, input=json.dumps(cases))
    assert res.returncode == 0, res.stderr
    accepted = []
    for d in cases:
        try:
            twin.validate_twin(d)
            accepted.append(True)
        except twin.TwinError:
            accepted.append(False)
    assert json.loads(res.stdout) == accepted == [False, False, False, False, False, True]


def test_material_derived_values_match_the_formula():
    for m in CONFIG["materials"].values():
        for band in CONFIG["bands"]:
            r = rfmodel.material_fields(m, band)
            assert r["penetrationRate"] == pytest.approx(10 ** (-m["attenuation_db"][band] / 10), abs=6e-5)
            assert math.isfinite(r["reflectionRate"])
