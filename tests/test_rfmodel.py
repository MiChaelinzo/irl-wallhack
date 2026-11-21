"""rfmodel: legacy defaults stay bit-identical, and the band, material and mode physics behave."""
import copy
import json
from pathlib import Path

import pytest

from wallhack import rfmodel, twin

GOLDEN = json.loads((Path(__file__).parent / "fixtures" / "rf_legacy_golden.json").read_text())
BANDS = ("2.4", "5", "6")


def _floor(walls, openings=()):
    return {"id": "f", "name": "F", "level": 0, "width_m": 20.0, "depth_m": 20.0, "walls": walls,
            "openings": list(openings), "rooms": [], "furniture": [], "sensors": [], "aps": []}


def _wall(x1, y1, x2, y2, material=None, kind="interior", wid="w"):
    w = {"id": wid, "x1": x1, "y1": y1, "x2": x2, "y2": y2, "kind": kind}
    if material:
        w["material"] = material
    return w


AP = {"id": "a", "x": 2.0, "y": 10.0, "tx_dbm": 20.0}


def test_legacy_coverage_grids_are_bit_identical():
    t = twin.sample_twin()
    for key, expected in GOLDEN["coverage"].items():
        fid, cell = key.split("@")
        assert json.loads(json.dumps(rfmodel.coverage_grid(t, fid, float(cell)))) == expected, key


def test_legacy_wall_loss_and_best_rssi_are_bit_identical():
    t = twin.sample_twin()
    for case in GOLDEN["points"]:
        assert rfmodel.wall_loss_db(t["floors"][0], *case["p"]) == case["wall_loss"]
    for case in GOLDEN["rssi"]:
        assert rfmodel.best_rssi(t, t["floors"][case["apart"]], *case["xy"]) == case["v"]


def test_default_materials_reproduce_legacy_losses():
    assert rfmodel.WALL_LOSS_DB == {"interior": 4.0, "exterior": 9.0}
    assert rfmodel.OPENING_LOSS_DB == {"door": 2.0, "window": 3.0}
    assert rfmodel.FLOOR_LOSS_DB == 13.0 and rfmodel.PL0_DB == 40.0


def test_frequency_ordering_same_path():
    f = _floor([_wall(10, 0, 10, 20)])
    levels = [rfmodel.rssi_from_ap(AP, f, f, 18.0, 10.0, band=b) for b in BANDS]
    assert levels[0] > levels[1] > levels[2]


def test_ap_band_is_used_and_call_band_overrides():
    f = _floor([])
    ap5 = dict(AP, band="5")
    assert rfmodel.rssi_from_ap(ap5, f, f, 8.0, 10.0) == rfmodel.rssi_from_ap(AP, f, f, 8.0, 10.0, band="5")
    assert rfmodel.rssi_from_ap(ap5, f, f, 8.0, 10.0, band="2.4") == rfmodel.rssi_from_ap(AP, f, f, 8.0, 10.0)


def test_material_ordering_at_each_band():
    order = ["metal", "concrete", "brick", "wood", "drywall", "glass"]
    for b in BANDS:
        losses = [rfmodel.wall_loss_db(_floor([_wall(10, 0, 10, 20, m)]), 2, 10, 18, 10, b) for m in order]
        assert losses == sorted(losses, reverse=True) and len(set(losses)) == len(order), b


def test_floor_loss_grows_with_band_and_floors():
    f = _floor([])
    one = [rfmodel.rssi_from_ap(AP, f, f, 5, 10, 1, band=b) - rfmodel.rssi_from_ap(AP, f, f, 5, 10, 0, band=b) for b in BANDS]
    assert one == [-13.0, -16.0, -18.0]


def test_custom_material_in_twin_table():
    t = twin.sample_twin()
    t["materials"] = {"lead": {"label": "Lead", "attenuation_db": {"2.4": 40, "5": 45, "6": 50},
                               "reflection_loss_db": {"2.4": 1, "5": 1, "6": 1}}}
    table = rfmodel.material_table(t)
    f = _floor([_wall(10, 0, 10, 20, "lead")])
    assert rfmodel.wall_loss_db(f, 2, 10, 18, 10, "5", table) == 45
    with pytest.raises(ValueError):
        rfmodel.wall_loss_db(f, 2, 10, 18, 10, "5")


def test_diffraction_beats_basic_in_shadow():
    """A short metal wall blocks the direct path, but the wall end is close to the line of sight."""
    f = _floor([_wall(10, 8.5, 10, 11.5, "metal", wid="m")])
    blocked = rfmodel.rssi_from_ap(AP, f, f, 14.0, 10.0, mode="basic")
    assert rfmodel.rssi_from_ap(AP, f, f, 14.0, 10.0, mode="enhanced") > blocked + 3.0
    clear = rfmodel.rssi_from_ap(AP, f, f, 14.0, 16.0, mode="basic")
    assert rfmodel.rssi_from_ap(AP, f, f, 14.0, 16.0, mode="enhanced") >= clear


def test_reflection_beats_basic_behind_blocker():
    f = _floor([_wall(8, 6, 8, 14, "metal", wid="block"), _wall(0, 4, 20, 4, "concrete", wid="mirror")])
    # AP and receiver on the same side of the mirror wall, direct path blocked by the metal wall
    basic = rfmodel.rssi_from_ap(AP, f, f, 14.0, 10.0, mode="basic")
    assert rfmodel.rssi_from_ap(AP, f, f, 14.0, 10.0, mode="enhanced") > basic


def test_modes_never_weaker_and_multipath_at_least_enhanced():
    t = twin.sample_twin()
    f = t["floors"][0]
    for b in BANDS:
        for x, y in ((3, 3), (9, 7), (7.5, 2), (0.6, 0.6)):
            vals = [rfmodel.best_rssi(t, f, x, y, band=b, mode=m) for m in ("basic", "enhanced", "multipath")]
            assert vals[0] <= vals[1] + 1e-9 and vals[1] <= vals[2] + 1e-9, (b, x, y, vals)


def test_deterministic_and_default_result_has_no_extra_keys():
    t = twin.sample_twin()
    a = rfmodel.coverage_grid(t, "ground", 1.0, band="5", mode="multipath")
    assert a == rfmodel.coverage_grid(copy.deepcopy(t), "ground", 1.0, band="5", mode="multipath")
    assert a["mode"] == "multipath" and "MODEL ESTIMATE" in a["label"]
    assert "mode" not in rfmodel.coverage_grid(t, "ground", 1.0)


def test_validation_errors():
    t = twin.sample_twin()
    with pytest.raises(ValueError, match="band"):
        rfmodel.coverage_grid(t, "ground", 1.0, band="60")
    with pytest.raises(ValueError, match="mode"):
        rfmodel.coverage_grid(t, "ground", 1.0, mode="magic")
    with pytest.raises(ValueError, match="unknown material"):
        rfmodel.wall_loss_db(_floor([_wall(10, 0, 10, 20, "unobtainium")]), 2, 10, 18, 10)


def test_register_mode_adds_a_mode():
    rfmodel.register_mode("flat", lambda ap, floor, x, y, band, materials: -50.0)
    try:
        f = _floor([])
        assert rfmodel.rssi_from_ap(AP, f, f, 5, 5, mode="flat") == -50.0
    finally:
        del rfmodel.MODES["flat"]


def test_twin_validation_of_new_fields():
    t = twin.sample_twin()
    t["floors"][0]["walls"][0].update(material="concrete", thickness_m=0.3, name="North")
    t["floors"][0]["aps"][0].update(band="5", channel=36, name="Router")
    t["floors"][0]["rooms"][0]["label"] = "Lounge"
    t["floors"][0]["scale_m_per_px"] = 0.02
    t["mode"] = "enhanced"
    out = twin.validate_twin(t)
    assert out["floors"][0]["walls"][0]["material"] == "concrete" and out["mode"] == "enhanced"
    assert out["floors"][0]["aps"][0]["channel"] == 36
    assert twin.validate_twin(twin.sample_twin()) == twin.validate_twin(twin.validate_twin(twin.sample_twin()))


@pytest.mark.parametrize("mutate, message", [
    (lambda t: t["floors"][0]["walls"][0].update(material="nope"), "walls[0].material"),
    (lambda t: t["floors"][0]["aps"][0].update(band="7"), "aps[0].band"),
    (lambda t: t["floors"][0]["aps"][0].update(band="5", channel=6), "aps[0].channel"),
    (lambda t: t.update(mode="x"), "twin.mode"),
    (lambda t: t["floors"][0].update(background="http://evil/x.png"), "background"),
    (lambda t: t["floors"][0]["walls"][0].update(thickness_m=99), "thickness_m"),
    (lambda t: t.update(materials={"m": {"label": "M", "attenuation_db": {"2.4": 1}, "reflection_loss_db": {}}}), "materials.m"),
])
def test_twin_rejects_bad_new_fields(mutate, message):
    t = twin.sample_twin()
    mutate(t)
    with pytest.raises(twin.TwinError, match=message.replace("[", r"\[").replace("]", r"\]")):
        twin.validate_twin(t)
