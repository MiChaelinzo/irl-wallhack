"""WiFi 4-7 standards, SINR with co-channel and adjacent-channel interference, antenna pattern and MLO.

Python (rfmodel.py) is the reference, the JS engine and the planner validator must agree with it.
"""
import copy
import math
import shutil

import pytest

import json
import subprocess

from tests.test_planner_state import PRELUDE
from tests.test_rf_planner_js import assert_close, open_project, run_js
from wallhack import rfmodel, twin
from wallhack.app import STATIC

needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
NOISE_20_MHZ_DBM = -174.0 + 10.0 * math.log10(20e6) + 6.0


def ap(ident, x, y, **fields):
    return dict({"id": ident, "x": x, "y": y, "tx_dbm": 20.0}, **fields)


def mixed_project():
    """Mixed standards, co-channel (ap0, ap1), adjacent-channel (ap2), a sector antenna (ap3), MLO and a legacy AP."""
    project = open_project(30, 20, [], walls=[{"id": "w1", "x1": 15.0, "y1": 2.0, "x2": 15.0, "y2": 14.0, "kind": "interior"}])
    project["floors"][0]["aps"] = [
        ap("ap0", 4.0, 5.0, band="5", channel=36, width_mhz=80, standard="wifi6"),
        ap("ap1", 10.0, 15.0, band="5", channel=36, width_mhz=80, standard="wifi5", spatial_streams=3),
        ap("ap2", 22.0, 6.0, band="5", channel=44, width_mhz=80, standard="wifi7", spatial_streams=4,
           mlo_bands=["6", "2.4"]),
        ap("ap3", 26.0, 16.0, band="5", channel=149, width_mhz=40, standard="wifi6e", pattern="sector", azimuth_deg=180.0,
           beamwidth_deg=70.0, front_to_back_db=25.0, antenna_gain_dbi=5.0),
        ap("ap4", 8.0, 10.0, band="2.4", channel=6)]
    return project


# ------------------------------------------------------------------ formulas against hand-computed values
@pytest.mark.parametrize("standard, mcs, width, streams, expected", [
    ("wifi4", 7, 20, 1, 52 * 6 * 5 / 6 / 4.0),            # 65 Mbps, the classic 802.11n MCS 7 at 20 MHz
    ("wifi4", 7, 40, 2, 108 * 6 * 5 / 6 * 2 / 4.0),       # 270 Mbps
    ("wifi5", 9, 80, 1, 234 * 8 * 5 / 6 / 4.0),           # 390 Mbps
    ("wifi6", 11, 20, 1, 234 * 10 * 5 / 6 / 13.6),        # 143.4 Mbps
    ("wifi6e", 11, 160, 2, 1960 * 10 * 5 / 6 * 2 / 13.6),
    ("wifi7", 13, 320, 1, 3920 * 12 * 5 / 6 / 13.6),      # 2882 Mbps, 4096-QAM 5/6
])
def test_phy_rate_follows_the_80211_formula(standard, mcs, width, streams, expected):
    assert rfmodel.standard_phy_rate_mbps(standard, mcs, width, streams) == pytest.approx(expected, rel=1e-12)


def test_phy_rate_agrees_with_the_legacy_tables_for_one_stream():
    legacy = rfmodel.CONFIG["mcs_tables"]
    assert max(e["phy_mbps"] for e in legacy["5"]["80"]) == pytest.approx(rfmodel.standard_phy_rate_mbps("wifi5", 9, 80, 1), rel=1e-3)
    assert max(e["phy_mbps"] for e in legacy["6"]["20"]) == pytest.approx(rfmodel.standard_phy_rate_mbps("wifi6e", 11, 20, 1), rel=1e-3)


def test_noise_floor_and_sinr_rate_steps():
    assert rfmodel.noise_floor_dbm(20) == pytest.approx(NOISE_20_MHZ_DBM)
    assert rfmodel.noise_floor_dbm(40) - rfmodel.noise_floor_dbm(20) == pytest.approx(10.0 * math.log10(2.0))
    assert rfmodel.highest_mcs("wifi6", 4.9) is None and rfmodel.highest_mcs("wifi6", 5.0) == 0
    assert rfmodel.highest_mcs("wifi4", 60.0) == 7 and rfmodel.highest_mcs("wifi5", 60.0) == 9
    assert rfmodel.highest_mcs("wifi6", 60.0) == 11 and rfmodel.highest_mcs("wifi7", 60.0) == 13
    assert rfmodel.sinr_phy_rate_mbps("wifi7", 0.0, 80, 2) == 0.0


def test_interference_coupling_overlap_and_rejection():
    c = rfmodel.interference_coupling
    assert c("5", 36, 20, 36, 20) == 1.0                                         # co-channel
    assert c("5", 36, 20, 40, 20) == pytest.approx(0.01)                         # next channel, 20 dB rejection
    assert c("5", 36, 20, 48, 20) == pytest.approx(1e-4)                         # 20 MHz gap, 40 dB
    assert c("5", 36, 20, 149, 20) == 0.0                                        # far apart, negligible
    assert c("5", 36, 80, 40, 20) == pytest.approx(1.0)                          # narrow interferer inside the wide victim
    assert c("5", 44, 20, 36, 80) == pytest.approx(0.125 + 0.875 * 0.01)         # 10 of 80 MHz in band
    assert c("2.4", 1, 20, 6, 20) == pytest.approx(0.01)                         # channels 1 and 6, 5 MHz gap, 20 dB


def test_mlo_capacity_is_the_sum_of_the_fastest_links():
    assert rfmodel.mlo_capacity_mbps([100.0, 300.0, 200.0]) == 600.0
    assert rfmodel.mlo_capacity_mbps([100.0, 300.0, 200.0, 50.0]) == 600.0
    assert rfmodel.mlo_capacity_mbps([]) == 0.0


def test_sector_pattern_matches_3gpp_values():
    sector = {"pattern": "sector", "azimuth_deg": 90.0, "beamwidth_deg": 70.0, "front_to_back_db": 25.0, "antenna_gain_dbi": 5.0}
    assert rfmodel.antenna_gain_db(sector, 90.0) == 5.0
    assert rfmodel.antenna_gain_db(sector, 90.0 + 70.0) == pytest.approx(5.0 - 12.0)       # 12 (phi / bw)^2 at one beamwidth
    assert rfmodel.antenna_gain_db(sector, 90.0 - 35.0) == pytest.approx(5.0 - 3.0)        # half beamwidth is 3 dB
    assert rfmodel.antenna_gain_db(sector, 270.0) == 5.0 - 25.0                            # back lobe capped by front-to-back
    assert rfmodel.antenna_gain_db(sector, 90.0 + 360.0) == 5.0                            # wraps around
    assert rfmodel.antenna_gain_db({"antenna_gain_dbi": 3.0}, 123.0) == 3.0                # omni ignores the bearing


def test_antenna_gain_shifts_the_level_and_a_sector_points_where_told():
    project = open_project(20, 20, [(10.0, 10.0, 20.0)])
    plain = project["floors"][0]["aps"][0]
    base = rfmodel.rssi_from_ap(plain, project["floors"][0], project["floors"][0], 15.0, 10.0)
    gain = dict(plain, antenna_gain_dbi=6.0)
    assert rfmodel.rssi_from_ap(gain, project["floors"][0], project["floors"][0], 15.0, 10.0) == pytest.approx(base + 6.0)
    east = dict(plain, pattern="sector", azimuth_deg=0.0)
    west = dict(plain, pattern="sector", azimuth_deg=180.0)
    f = project["floors"][0]
    assert rfmodel.rssi_from_ap(east, f, f, 15.0, 10.0) == pytest.approx(base)
    assert rfmodel.rssi_from_ap(west, f, f, 15.0, 10.0) == pytest.approx(base - 25.0)


# ------------------------------------------------------------------ backwards compatibility
def test_legacy_project_output_has_no_new_fields_and_omni_defaults_change_nothing():
    project = open_project(20, 12, [(4.0, 4.0, 20.0), (15.0, 8.0, 18.0)])
    legacy = rfmodel.analyze_floor(project, "g", 1.0, None, "multipath")
    assert "sinr" not in legacy
    explicit = copy.deepcopy(project)
    for a in explicit["floors"][0]["aps"]:
        a.update({"pattern": "omni", "antenna_gain_dbi": 0.0})
    assert rfmodel.coverage_grid(explicit, "g", 1.0, mode="multipath") == rfmodel.coverage_grid(project, "g", 1.0, mode="multipath")
    grids = rfmodel.ap_grids(project, "g", 1.0)
    assert all(set(g) == {"id", "floor", "x", "y", "tx_dbm", "band", "channel", "width_mhz", "grid"} for g in grids)


def test_sinr_section_is_added_only_for_standard_aps_and_existing_fields_stay_equal():
    project = mixed_project()
    plain = copy.deepcopy(project)
    for a in plain["floors"][0]["aps"]:
        for key in ("standard", "spatial_streams", "mlo_bands"):
            a.pop(key, None)
        if a["id"] == "ap3":
            a["width_mhz"] = 20      # legacy tables have no 40 MHz entry for 5 GHz, the standard AP falls back to 20
    with_std, without = rfmodel.analyze_floor(project, "g", 2.0), rfmodel.analyze_floor(plain, "g", 2.0)
    assert "sinr" not in without
    assert {k: v for k, v in with_std.items() if k != "sinr"}.keys() == without.keys()
    assert with_std["coverage_pct"] == without["coverage_pct"] and with_std["throughput_mbps"] == without["throughput_mbps"]


def test_sinr_section_content():
    section = rfmodel.analyze_floor(mixed_project(), "g", 2.0)["sinr"]
    by_id = {e["id"]: e for e in section["aps"]}
    assert by_id["ap0"]["interferers"] == ["ap1", "ap2"]            # co-channel ap1, partial overlap with ap2
    assert by_id["ap3"]["interferers"] == []                        # 149 is far from 36 and 44
    assert by_id["ap4"]["standard"] == "wifi4"                      # fallback for the 2.4 GHz AP without a standard
    assert by_id["ap0"]["max_phy_mbps"] == pytest.approx(rfmodel.standard_phy_rate_mbps("wifi6", 11, 80, 2), abs=0.05)
    assert "mlo" in by_id["ap2"] and by_id["ap2"]["mlo"]["links"] == ["5", "6", "2.4"] and "mlo" not in by_id["ap0"]
    assert by_id["ap2"]["mlo"]["mean_capacity_mbps"] >= by_id["ap2"]["mean_throughput_mbps"]
    assert "CAPACITY MODEL" in by_id["ap2"]["mlo"]["label"]


def test_more_interference_never_raises_the_sinr():
    quiet = mixed_project()
    quiet["floors"][0]["aps"] = [a for a in quiet["floors"][0]["aps"] if a["id"] in ("ap0", "ap3")]
    noisy = mixed_project()
    q = rfmodel.analyze_floor(quiet, "g", 2.0)["sinr"]["aps"][0]
    n = rfmodel.analyze_floor(noisy, "g", 2.0)["sinr"]["aps"][0]
    assert n["mean_sinr_db"] <= q["mean_sinr_db"]


# ------------------------------------------------------------------ validation
def one_ap_twin(**fields):
    t = twin.sample_twin()
    t["floors"][0]["aps"][0].update(fields)
    return t


def test_twin_accepts_valid_standard_fields():
    t = twin.validate_twin(one_ap_twin(band="6", standard="wifi7", width_mhz=320, spatial_streams=4, mlo_bands=["5", "2.4"],
                                       pattern="sector", azimuth_deg=90.0, antenna_gain_dbi=4.0))
    a = t["floors"][0]["aps"][0]
    assert a["width_mhz"] == 320 and a["mlo_bands"] == ["5", "2.4"] and a["pattern"] == "sector"


@pytest.mark.parametrize("fields, message", [
    ({"standard": "wifi99"}, "standard"),
    ({"band": "6", "standard": "wifi4"}, "not allowed on the 6 GHz"),
    ({"band": "6", "standard": "wifi5"}, "not allowed on the 6 GHz"),
    ({"band": "2.4", "standard": "wifi5"}, "not allowed on the 2.4 GHz"),
    ({"band": "5", "standard": "wifi7", "width_mhz": 320}, "width_mhz"),
    ({"band": "2.4", "standard": "wifi6", "width_mhz": 80}, "width_mhz"),
    ({"band": "5", "standard": "wifi4", "width_mhz": 80}, "width_mhz"),
    ({"spatial_streams": 2}, "needs a standard"),
    ({"standard": "wifi4", "spatial_streams": 5}, "spatial_streams"),
    ({"standard": "wifi6", "mlo_bands": ["5"]}, "mlo_bands"),
    ({"band": "5", "standard": "wifi7", "mlo_bands": ["5"]}, "mlo_bands"),
    ({"band": "5", "standard": "wifi7", "mlo_bands": ["6", "6"]}, "mlo_bands"),
    ({"pattern": "dish"}, "pattern"),
    ({"azimuth_deg": 400.0}, "azimuth_deg"),
    ({"pattern": "sector", "beamwidth_deg": 1.0}, "beamwidth_deg"),
    ({"antenna_gain_dbi": 99.0}, "antenna_gain_dbi"),
])
def test_twin_rejects_invalid_standard_fields(fields, message):
    with pytest.raises(twin.TwinError, match=message):
        twin.validate_twin(one_ap_twin(**fields))


def test_wifi7_320_mhz_only_in_6_ghz_and_wifi4_never_in_6_ghz():
    assert 320 in rfmodel.standard_widths("wifi7", "6")
    assert all(320 not in rfmodel.standard_widths("wifi7", b) for b in ("2.4", "5"))
    assert all(320 not in spec["widths_mhz_by_band"].get(b, []) for s, spec in rfmodel.WIFI["standards"].items()
               if s != "wifi7" for b in ("2.4", "5", "6"))
    with pytest.raises(ValueError):
        rfmodel.standard_widths("wifi4", "6")


# ------------------------------------------------------------------ Python and JS agree
@needs_node
def test_js_analytics_matches_python_on_a_mixed_standard_fixture():
    project = mixed_project()
    for mode in ("basic", "multipath"):
        py = rfmodel.analyze_floor(project, "g", 2.0, None, mode)
        js = run_js("out(E.analyzeFloor(P.project, 'g', {env, cellM: 2.0, mode: P.mode}))", {"project": project, "mode": mode})
        assert_close(py, js, f"mixed/{mode}")


@needs_node
def test_js_formulas_match_python():
    got = run_js("""
      out({rate: [['wifi4', 7, 40, 2], ['wifi6', 11, 20, 1], ['wifi7', 13, 320, 4]].map(a => E.standardPhyRateMbps(config, ...a)),
           noise: [20, 80, 320].map(w => E.noiseFloorDbm(config, w)),
           sinr: [[ 'wifi6', 24.9, 80, 2], ['wifi7', 41.99, 160, 2], ['wifi5', 3, 20, 1]].map(a => E.sinrPhyRateMbps(config, ...a)),
           coupling: [['5', 36, 20, 40, 20], ['5', 44, 20, 36, 80], ['5', 36, 20, 149, 20], ['2.4', 1, 20, 6, 20]].map(a => E.interferenceCoupling(config, ...a)),
           mlo: E.mloCapacityMbps(config, [100, 300, 200, 50]),
           gain: [0, 40, 90, 135, 180, 269, 359].map(b => E.antennaGainDb(config, {pattern: 'sector', azimuth_deg: 90, antenna_gain_dbi: 3}, b))})
    """)
    c, sector = rfmodel.CONFIG, {"pattern": "sector", "azimuth_deg": 90.0, "antenna_gain_dbi": 3.0}
    assert got["rate"] == pytest.approx([rfmodel.standard_phy_rate_mbps(*a) for a in (("wifi4", 7, 40, 2), ("wifi6", 11, 20, 1), ("wifi7", 13, 320, 4))], rel=1e-12)
    assert got["noise"] == pytest.approx([rfmodel.noise_floor_dbm(w) for w in (20, 80, 320)], abs=1e-9)
    assert got["sinr"] == pytest.approx([rfmodel.sinr_phy_rate_mbps(*a) for a in (("wifi6", 24.9, 80, 2), ("wifi7", 41.99, 160, 2), ("wifi5", 3, 20, 1))], rel=1e-12)
    assert got["coupling"] == pytest.approx([rfmodel.interference_coupling(*a) for a in (("5", 36, 20, 40, 20), ("5", 44, 20, 36, 80), ("5", 36, 20, 149, 20), ("2.4", 1, 20, 6, 20))], abs=1e-12)
    assert got["mlo"] == rfmodel.mlo_capacity_mbps([100, 300, 200, 50])
    assert got["gain"] == pytest.approx([rfmodel.antenna_gain_db(sector, b) for b in (0, 40, 90, 135, 180, 269, 359)], abs=1e-9)
    assert c["wifi_standards"]["mlo"]["max_links"] == 3


@needs_node
def test_js_coverage_with_sector_and_gain_matches_python():
    project = mixed_project()
    for mode in ("basic", "enhanced", "multipath"):
        py = rfmodel.coverage_grid(project, "g", 1.0, mode=mode)
        js = run_js("out(E.coverageGrid(P.project, 'g', {env, cellM: 1.0, mode: P.mode}))", {"project": project, "mode": mode})
        worst = max(abs(a - b) for pr, jr in zip(py["rssi"], js["rssi"]) for a, b in zip(pr, jr))
        assert worst <= 0.1 + 1e-9, f"{mode}: {worst}"


@needs_node
@pytest.mark.parametrize("fields, ok", [
    ({"standard": "wifi7", "band": "6", "width_mhz": 320}, True),
    ({"standard": "wifi7", "band": "5", "width_mhz": 320}, False),
    ({"standard": "wifi4", "band": "6"}, False),
    ({"standard": "nope"}, False),
    ({"standard": "wifi6", "mlo_bands": ["5"]}, False),
    ({"standard": "wifi7", "band": "5", "mlo_bands": ["6", "2.4"], "spatial_streams": 4}, True),
    ({"pattern": "sector", "azimuth_deg": 45.0, "beamwidth_deg": 90.0}, True),
    ({"pattern": "dish"}, False),
    ({"width_mhz": 80, "band": "2.4"}, False),
])
def test_js_validator_agrees_with_python_validator(fields, ok):
    t = one_ap_twin(**fields)
    try:
        twin.validate_twin(t)
        py_ok = True
    except twin.TwinError:
        py_ok = False
    res = subprocess.run(["node", "-e", PRELUDE + "let ok = true; try { S.validateProject(input.twin); } catch (e) { ok = false; } out(ok);", str(STATIC)],
                         capture_output=True, text=True, input=json.dumps({"twin": t}))
    assert res.returncode == 0, res.stderr
    assert py_ok == ok == json.loads(res.stdout)
