import copy
import json

import pytest

from wallhack import rfmodel
from wallhack.twin import TwinError, load_twin, sample_twin, save_twin, validate_twin


def test_sample_is_valid_and_has_two_floors():
    t = validate_twin(sample_twin())
    assert [f["id"] for f in t["floors"]] == ["ground", "upper"]
    assert t["floors"][0]["aps"] and t["floors"][0]["sensors"] and t["floors"][0]["furniture"]


@pytest.mark.parametrize("mutate,fragment", [
    (lambda t: t.update(floors=[]), "floors"),
    (lambda t: t["floors"][0]["rooms"][0].update(w=99), "outside the floor"),
    (lambda t: t["floors"][0]["walls"][0].update(kind="glass"), "walls[0].kind"),
    (lambda t: t["floors"][0]["openings"][0].update(wall="nope"), "unknown wall id"),
    (lambda t: t["floors"][0]["openings"][0].update(pos=50), "pos"),
    (lambda t: t["floors"][0]["aps"][0].update(tx_dbm=90), "tx_dbm"),
    (lambda t: t["floors"][0]["aps"][0].update(x="a"), "finite number"),
    (lambda t: t["floors"][0]["rooms"].append(dict(t["floors"][0]["rooms"][0])), "duplicate id"),
    (lambda t: t["floors"][1].update(level=0), "duplicate id"),
    (lambda t: t["floors"][0]["walls"][0].update(x2=0, y2=0), "zero length"),
])
def test_validation_errors_are_clear(mutate, fragment):
    t = sample_twin()
    mutate(t)
    with pytest.raises(TwinError) as exc:
        validate_twin(t)
    assert fragment in str(exc.value)


def test_validate_rejects_non_object():
    with pytest.raises(TwinError):
        validate_twin([])


def test_save_and_load_roundtrip(tmp_path):
    assert load_twin(str(tmp_path))["sample"] is True
    t = sample_twin()
    t["name"] = "Mine"
    saved = save_twin(str(tmp_path), t)
    assert saved["sample"] is False
    assert load_twin(str(tmp_path))["name"] == "Mine"
    assert not list(tmp_path.glob("*.tmp"))


def test_corrupt_saved_twin_is_reported(tmp_path):
    (tmp_path / "twin.json").write_text("{not json")
    with pytest.raises(TwinError):
        load_twin(str(tmp_path))


def test_save_rejects_invalid_and_keeps_old_file(tmp_path):
    save_twin(str(tmp_path), sample_twin())
    bad = sample_twin()
    bad["floors"] = []
    with pytest.raises(TwinError):
        save_twin(str(tmp_path), bad)
    assert json.loads((tmp_path / "twin.json").read_text())["floors"]


# ---- rf model ----------------------------------------------------------------
def test_grid_is_deterministic():
    t = sample_twin()
    assert rfmodel.coverage_grid(t, "ground") == rfmodel.coverage_grid(copy.deepcopy(t), "ground")


def test_signal_falls_with_distance_in_open_space():
    floor = {"openings": [], "walls": []}
    ap = {"x": 0.0, "y": 0.0, "tx_dbm": 20.0}
    vals = [rfmodel.rssi_from_ap(ap, floor, floor, d, 0.0) for d in (1, 2, 4, 8, 16)]
    assert vals == sorted(vals, reverse=True) and len(set(vals)) == 5
    assert vals[0] == pytest.approx(20.0 - rfmodel.PL0_DB)


def test_walls_attenuate_and_openings_attenuate_less():
    ap = {"x": 1.0, "y": 1.0, "tx_dbm": 20.0}
    base = {"x1": 3, "y1": 0, "x2": 3, "y2": 4, "kind": "interior", "id": "w"}
    def loss(openings, kind="interior"):
        floor = {"walls": [dict(base, kind=kind)], "openings": openings}
        return rfmodel.wall_loss_db(floor, 1, 1, 5, 1)
    assert loss([]) == 4.0
    assert loss([], "exterior") == 9.0
    assert loss([{"wall": "w", "kind": "door", "pos": 0.5, "width": 1.0}]) == 2.0
    assert loss([{"wall": "w", "kind": "door", "pos": 2.5, "width": 1.0}]) == 4.0
    assert loss([{"wall": "w", "kind": "window", "pos": 0.5, "width": 1.0}], "exterior") == 3.0
    assert rfmodel.wall_loss_db({"walls": [base], "openings": []}, 1, 1, 2, 1) == 0.0


def test_moving_ap_closer_never_lowers_rssi_in_corridor():
    t = sample_twin()
    floor = t["floors"][0]
    far = {"x": 0.5, "y": 7.5, "tx_dbm": 20.0}
    near = {"x": 5.0, "y": 7.5, "tx_dbm": 20.0}
    assert rfmodel.rssi_from_ap(near, floor, floor, 5.5, 7.0) > rfmodel.rssi_from_ap(far, floor, floor, 5.5, 7.0)


def test_other_floor_is_weaker_and_coverage_in_range():
    t = sample_twin()
    floor0, floor1 = t["floors"]
    ap = floor0["aps"][0]
    same = rfmodel.rssi_from_ap(ap, floor0, floor0, 3, 3, 0)
    assert rfmodel.rssi_from_ap(ap, floor0, floor1, 3, 3, 1) == pytest.approx(same - rfmodel.FLOOR_LOSS_DB - rfmodel.wall_loss_db(floor1, ap["x"], ap["y"], 3, 3) + rfmodel.wall_loss_db(floor0, ap["x"], ap["y"], 3, 3))
    cov = rfmodel.twin_coverage(t)
    assert set(cov) == {"ground", "upper"}
    assert all(0.0 <= g["coverage_pct"] <= 100.0 for g in cov.values())
    assert cov["ground"]["rows"] == 16 and cov["ground"]["cols"] == 20


def test_more_aps_never_reduce_coverage():
    t = sample_twin()
    one = rfmodel.coverage_grid(t, "ground")["coverage_pct"]
    t["floors"][0]["aps"].append({"id": "extra", "x": 8.0, "y": 6.0, "tx_dbm": 20.0})
    assert rfmodel.coverage_grid(t, "ground")["coverage_pct"] >= one


def test_bad_arguments():
    with pytest.raises(ValueError):
        rfmodel.coverage_grid(sample_twin(), "nope")
    with pytest.raises(ValueError):
        rfmodel.coverage_grid(sample_twin(), "ground", cell_m=0)
