"""Analytics, probe and estimate formulas of wallhack.rfmodel on hand-computed cases."""
import pytest

from wallhack import rfmodel

A = [[-50, -60, -72, -80], [-50, -90, -100, -120]]
B = [[-90, -66, -70, -76], [-120, -120, -100, -120]]


def ap(name, grid, x, y, channel=1):
    return {"id": name, "floor": "f", "x": x, "y": y, "tx_dbm": 20.0, "band": "2.4", "channel": channel,
            "width_mhz": 20, "grid": grid}


def tiny():
    best = [[max(a, b) for a, b in zip(ra, rb)] for ra, rb in zip(A, B)]
    result = {"rows": 2, "cols": 4, "cell_m": 1.0, "rssi": best}
    return rfmodel.analytics(result, [ap("A", A, 0.5, 0.5), ap("B", B, 3.5, 0.5)])


def test_coverage_quality_and_average():
    r = tiny()
    assert r["coverage_pct"] == 50.0
    assert r["quality_pct"] == {"excellent": 25.0, "good": 12.5, "fair": 12.5, "poor": 12.5, "none": 37.5}
    assert r["avg_rssi_dbm"] == -77.0


def test_weak_and_dead_zone_regions():
    r = tiny()
    assert r["weak_area_m2"] == 1.0
    assert r["dead_zone_area_m2"] == 3.0 and r["dead_zone_pct"] == 37.5
    assert r["dead_zones"] == [{"cells": 3, "area_m2": 3.0, "bbox": {"x_min": 1.0, "y_min": 1.0, "x_max": 4.0, "y_max": 2.0},
                                "centroid": {"x": 2.5, "y": 1.5}}]


def test_best_ap_overlap_and_roaming():
    r = tiny()
    assert r["best_ap"] == [[0, 0, 1, 1], [0, -1, -1, -1]]
    assert r["overlap"]["cells"] == 2 and r["overlap"]["pairs"] == [{"a": "A", "b": "B", "cells": 2, "area_m2": 2.0}]
    assert r["roaming"]["cells"] == 2
    assert r["roaming"]["zones"][0]["bbox"] == {"x_min": 1.0, "y_min": 0.0, "x_max": 3.0, "y_max": 1.0}


def test_throughput_capacity_and_utilisation():
    r = tiny()
    eff = rfmodel.ANALYTICS["mac_efficiency"]
    assert r["throughput_mbps"][0][0] == pytest.approx(65 * eff, abs=0.06)
    assert r["throughput_mbps"][0][3] == pytest.approx(19.5 * eff, abs=0.06)
    assert r["throughput_mbps"][1][1] == 0.0
    mean = (3 * 65 * eff + 39 * eff + 19.5 * eff) / 8
    assert r["mean_throughput_mbps"] == pytest.approx(mean, abs=0.06)
    a, b = r["aps"]
    assert a["served_cells"] == 3 and a["client_capacity"] == int(65 * eff // 5)
    harmonic_b = 2 / (1 / (39 * eff) + 1 / (19.5 * eff))
    assert b["usable_mbps"] == pytest.approx(harmonic_b, abs=0.06) and b["client_capacity"] == int(harmonic_b // 5)
    own_a = 4.0 * 3 / 100 * 5 / (65 * eff)
    own_b = 4.0 * 2 / 100 * 5 / harmonic_b
    assert a["cochannel_neighbours"] == [] and a["channel_utilisation_pct"] == pytest.approx(100 * own_a, abs=0.06)
    assert b["cochannel_neighbours"] == ["A"]  # B hears A (-80 dBm at B) but A does not hear B
    assert b["channel_utilisation_pct"] == pytest.approx(100 * (own_a + own_b), abs=0.06)
    assert r["total_client_capacity"] == a["client_capacity"] + b["client_capacity"]


def test_different_channels_do_not_share_utilisation():
    best = [[max(a, b) for a, b in zip(ra, rb)] for ra, rb in zip(A, B)]
    r = rfmodel.analytics({"rows": 2, "cols": 4, "cell_m": 1.0, "rssi": best},
                          [ap("A", A, 0.5, 0.5, 1), ap("B", B, 3.5, 0.5, 6)])
    assert r["aps"][1]["cochannel_neighbours"] == []
    assert r["aps"][1]["channel_utilisation_pct"] == r["aps"][1]["own_utilisation_pct"]


def test_rate_table_and_quality_edges():
    assert rfmodel.phy_rate_mbps(-90, "2.4", 20) == 0.0
    assert rfmodel.phy_rate_mbps(-82, "2.4", 20) == 6.5
    assert rfmodel.phy_rate_mbps(-30, "5", 80) == 390
    assert rfmodel.quality_band(-55) == "excellent" and rfmodel.quality_band(-85.1) == "none"
    with pytest.raises(ValueError):
        rfmodel.phy_rate_mbps(-50, "2.4", 80)


def probe_twin():
    return {"name": "p", "units": "m", "floors": [{
        "id": "f", "name": "f", "level": 0, "height_m": 2.5, "width_m": 10.0, "depth_m": 6.0, "rooms": [],
        "walls": [{"id": "w", "x1": 5.0, "y1": 0.0, "x2": 5.0, "y2": 6.0, "kind": "interior"}],
        "openings": [{"id": "d", "kind": "door", "wall": "w", "pos": 2.5, "width": 1.0}],
        "furniture": [], "sensors": [], "aps": [{"id": "ap", "x": 1.0, "y": 3.0, "tx_dbm": 20.0}]}]}


def test_probe_counts_openings_and_walls_separately():
    t = probe_twin()
    through_door = rfmodel.probe_at(t, "f", 8.0, 3.0)
    assert (through_door["walls_crossed"], through_door["openings_crossed"]) == (0, 1)
    assert through_door["rssi_dbm"] == pytest.approx(20 - 40 - 30 * 0.8450980400142568 - 2.0, abs=0.06)
    assert through_door["distance_m"] == 7.0 and through_door["ap_id"] == "ap"
    through_wall = rfmodel.probe_at(t, "f", 8.0, 5.5)
    assert (through_wall["walls_crossed"], through_wall["openings_crossed"]) == (1, 0)
    same_room = rfmodel.probe_at(t, "f", 3.0, 3.0)
    assert (same_room["walls_crossed"], same_room["openings_crossed"]) == (0, 0)
    assert same_room["rssi_dbm"] > through_wall["rssi_dbm"] and same_room["throughput_mbps"] >= through_wall["throughput_mbps"] >= 0


def test_probe_without_aps():
    t = probe_twin()
    t["floors"][0]["aps"] = []
    r = rfmodel.probe_at(t, "f", 1.0, 1.0)
    assert r["ap_id"] is None and r["rssi_dbm"] == rfmodel.NO_SIGNAL_DBM and r["throughput_mbps"] == 0.0


def test_analyze_floor_is_deterministic():
    from wallhack import twin
    s = twin.sample_twin()
    assert rfmodel.analyze_floor(s, "ground", 1.0) == rfmodel.analyze_floor(s, "ground", 1.0)
    assert "ESTIMATE" in rfmodel.analyze_floor(s, "ground", 1.0)["label"]
