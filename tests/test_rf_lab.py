"""RF lab features of rfmodel.py and their rf-engine.js mirror: new materials, non-WiFi interferers, reliability
estimates, floor voids, explanations, spectrum analysis, signal decay and exact roaming data."""
import copy
import json
import math
import shutil
import subprocess

import pytest

from tests.test_rf_planner_js import assert_close, run_js
from tests.test_rf_parity import TOLERANCE_DB
from wallhack import rfmodel, twin
from wallhack.app import STATIC

needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
CFG = rfmodel.CONFIG


def floor(fid="g", level=0, width=20.0, depth=12.0, walls=(), aps=(), **extra):
    f = {"id": fid, "name": fid, "level": level, "height_m": 2.5, "width_m": width, "depth_m": depth, "rooms": [],
         "walls": [dict(w) for w in walls], "openings": [], "furniture": [], "sensors": [], "aps": [dict(a) for a in aps]}
    f.update(extra)
    return f


def wall(wid, x1, y1, x2, y2, material=None):
    w = {"id": wid, "x1": x1, "y1": y1, "x2": x2, "y2": y2, "kind": "interior"}
    if material:
        w["material"] = material
    return w


def lab_project():
    """Two floors, three APs with a standard, a stairwell, and one source of each kind."""
    ground = floor("g", 0, walls=[wall("w1", 6, 0, 6, 12, "plaster"), wall("w2", 12, 0, 12, 12, "industrial_wall")],
                   aps=[{"id": "a1", "x": 3.0, "y": 6.0, "tx_dbm": 20.0, "band": "2.4", "channel": 1, "standard": "wifi6"},
                        {"id": "a2", "x": 16.0, "y": 6.0, "tx_dbm": 18.0, "band": "2.4", "channel": 11, "standard": "wifi4"}],
                   voids=[{"id": "stairs", "kind": "stairwell", "x": 9.0, "y": 4.0, "w": 2.0, "d": 4.0}])
    upper = floor("u", 1, aps=[{"id": "a3", "x": 10.0, "y": 6.0, "tx_dbm": 20.0, "band": "5", "channel": 36, "standard": "wifi6"}],
                  voids=[{"id": "well", "kind": "atrium", "points": [[8.0, 3.0], [12.0, 3.0], [12.0, 9.0], [8.0, 9.0]]}])
    return {"name": "lab", "units": "m", "floors": [ground, upper], "interferers": [
        {"id": "oven", "kind": "microwave", "floor": "g", "x": 4.0, "y": 7.0},
        {"id": "headset", "kind": "bluetooth", "floor": "g", "x": 14.0, "y": 5.0},
        {"id": "next-door", "kind": "neighbour_wifi", "floor": "g", "x": 10.0, "y": 2.0, "channel": 6, "tx_dbm": 17.0, "duty_cycle": 0.4},
        {"id": "next-door-5", "kind": "neighbour_wifi", "floor": "u", "x": 2.0, "y": 2.0, "band": "5", "channel": 40, "width_mhz": 80}]}


# ---------------------------------------------------------------- (1) materials
@pytest.mark.parametrize("material,att", [("plaster", (3.0, 4.0, 4.5)), ("insulation", (2.0, 2.5, 3.0)),
                                          ("office_partition", (3.0, 3.5, 4.0)), ("industrial_wall", (15.0, 19.0, 21.0))])
def test_new_materials_attenuate_at_each_band(material, att):
    f = floor(walls=[wall("w", 5, 0, 5, 12, material)])
    for band, expected in zip(("2.4", "5", "6"), att):
        assert rfmodel.wall_loss_db(f, 2, 6, 8, 6, band) == expected
    assert CFG["materials"][material]["confidence"] in ("low", "medium")


# ---------------------------------------------------------------- (2) interference sources
def test_resolve_interferers_fills_documented_defaults():
    src = {s["id"]: s for s in rfmodel.resolve_interferers(lab_project())}
    assert src["oven"]["duty_cycle"] == 0.5 and src["oven"]["centre_mhz"] == 2450 and src["oven"]["band"] == "2.4"
    assert src["headset"]["centre_mhz"] == 2441 and src["headset"]["width_mhz"] == 78 and src["headset"]["tx_dbm"] == 4.0
    assert src["next-door"] == {"id": "next-door", "kind": "neighbour_wifi", "floor": "g", "x": 10.0, "y": 2.0, "tx_dbm": 17.0,
                                "duty_cycle": 0.4, "band": "2.4", "channel": 6, "width_mhz": 20}
    assert src["next-door-5"]["tx_dbm"] == 20.0 and src["next-door-5"]["width_mhz"] == 80


def test_external_coupling_follows_spectral_overlap():
    src = {s["id"]: s for s in rfmodel.resolve_interferers(lab_project())}
    # channel 6 (2427 to 2447 MHz): 20 of the oven's 50 MHz and 20 of Bluetooth's 78 MHz hop set
    assert rfmodel.external_coupling(src["oven"], "2.4", 6, 20) == pytest.approx(20 / 50)
    assert rfmodel.external_coupling(src["headset"], "2.4", 6, 20) == pytest.approx(20 / 78)
    assert rfmodel.external_coupling(src["headset"], "2.4", 1, 20) == pytest.approx(20 / 78)   # 2402 to 2422 MHz, inside the hop set
    assert rfmodel.external_coupling(src["oven"], "2.4", 1, 20) == 0.0                       # below 2425 MHz
    assert rfmodel.external_coupling(src["oven"], "5", 36, 20) == 0.0
    assert rfmodel.external_coupling(src["next-door"], "2.4", 6, 20) == 1.0
    assert rfmodel.external_coupling(src["next-door"], "2.4", 1, 20) == rfmodel.interference_coupling("2.4", 1, 20, 6, 20)


def _one_ap_project(interferers, channel=6):
    f = floor(aps=[{"id": "ap", "x": 3.0, "y": 6.0, "tx_dbm": 20.0, "band": "2.4", "channel": channel, "standard": "wifi6"}])
    return {"name": "one", "units": "m", "floors": [f], "interferers": interferers}


def test_microwave_lowers_sinr_on_its_own_band_and_only_there():
    quiet = rfmodel.analyze_floor(_one_ap_project([]), "g", 2.0)["sinr"]
    oven = rfmodel.analyze_floor(_one_ap_project([{"id": "o", "kind": "microwave", "floor": "g", "x": 4.0, "y": 6.0}]), "g", 2.0)["sinr"]
    assert oven["mean_sinr_db"] < quiet["mean_sinr_db"] - 5.0
    assert oven["aps"][0]["external_sources"] == ["o"] and quiet["aps"][0]["external_sources"] == []
    assert oven["external"][0]["id"] == "o" and "grid" not in oven["external"][0]
    assert "MODEL ESTIMATE" in oven["external_label"]
    off_band = rfmodel.analyze_floor(_one_ap_project([{"id": "o", "kind": "microwave", "floor": "g", "x": 4.0, "y": 6.0}], channel=1), "g", 2.0)["sinr"]
    assert off_band["aps"][0]["external_sources"] == []                       # channel 1 is below the oven's 2425 MHz edge


def test_duty_cycle_scales_interference_power():
    def mean_sinr(duty):
        src = {"id": "n", "kind": "neighbour_wifi", "floor": "g", "x": 6.0, "y": 6.0, "duty_cycle": duty}
        return rfmodel.analyze_floor(_one_ap_project([src]), "g", 2.0)["sinr"]["mean_sinr_db"]
    assert mean_sinr(0.0) > mean_sinr(0.2) > mean_sinr(1.0)


def test_legacy_projects_without_standard_have_no_sinr_section_and_ignore_sources():
    t = twin.sample_twin()
    assert "sinr" not in rfmodel.analyze_floor(t, "ground", 1.0)
    t["interferers"] = [{"id": "o", "kind": "microwave", "floor": "ground", "x": 2.0, "y": 2.0}]
    assert rfmodel.analyze_floor(t, "ground", 1.0) == rfmodel.analyze_floor(twin.sample_twin(), "ground", 1.0)


# ---------------------------------------------------------------- (3) PER, latency, airtime
def test_per_is_ten_percent_at_the_mcs_minimum_snr_and_falls_with_sinr():
    for mcs in (0, 5, 11):
        snr = CFG["wifi_standards"]["mcs"][mcs]["min_snr_db"]
        assert rfmodel.packet_error_rate(snr, mcs) == pytest.approx(CFG["reliability"]["per_at_min_snr"])
        assert rfmodel.packet_error_rate(snr + 3, mcs) < rfmodel.packet_error_rate(snr, mcs) < rfmodel.packet_error_rate(snr - 3, mcs)


def test_link_reliability_estimates():
    r = CFG["reliability"]
    clean = rfmodel.link_reliability("wifi6", 60.0, 600.0, 0.0)
    assert clean["per_pct"] < 0.01 and clean["loss_pct"] == pytest.approx(0.0, abs=1e-12)
    assert clean["latency_ms"] == pytest.approx(r["base_latency_ms"], abs=1e-3)
    assert clean["airtime_pct"] == pytest.approx(100 * CFG["analytics"]["per_client_demand_mbps"] / 600.0, rel=1e-3)
    dead = rfmodel.link_reliability("wifi6", -10.0, 0.0, 0.0)          # below MCS 0: nothing gets through
    assert dead["per_pct"] == 100.0 and dead["loss_pct"] == 100.0 and dead["airtime_pct"] == 100.0
    assert dead["latency_ms"] == pytest.approx(r["base_latency_ms"] + r["retry_limit"] * r["retry_penalty_ms"])
    busy = rfmodel.link_reliability("wifi6", 60.0, 600.0, 0.5)
    assert busy["latency_ms"] == pytest.approx(clean["latency_ms"] + r["medium_wait_ms"], abs=1e-3)
    assert busy["airtime_pct"] == pytest.approx(2 * clean["airtime_pct"], rel=1e-3)
    capped = rfmodel.link_reliability("wifi6", 60.0, 600.0, 5.0)
    assert capped["latency_ms"] == pytest.approx(r["base_latency_ms"] + r["max_busy_fraction"] / (1 - r["max_busy_fraction"]) * r["medium_wait_ms"], abs=1e-3)


def test_reliability_grids_and_external_busy_time_in_the_sinr_section():
    quiet = rfmodel.analyze_floor(_one_ap_project([]), "g", 2.0)["sinr"]
    noisy = rfmodel.analyze_floor(_one_ap_project([{"id": "n", "kind": "neighbour_wifi", "floor": "g", "x": 5.0, "y": 6.0, "duty_cycle": 0.4}]), "g", 2.0)["sinr"]
    assert "ESTIMATE" in quiet["reliability"]["label"] and len(quiet["reliability"]["latency_ms"]) == 6
    assert quiet["aps"][0]["reliability"]["channel_busy_pct"] == 0.0
    assert noisy["aps"][0]["reliability"]["channel_busy_pct"] == 40.0     # 5 m from the AP, far above the carrier sense level
    assert noisy["reliability"]["mean_latency_ms"] > quiet["reliability"]["mean_latency_ms"]
    assert noisy["reliability"]["mean_airtime_pct"] > quiet["reliability"]["mean_airtime_pct"]
    assert noisy["reliability"]["mean_per_pct"] >= quiet["reliability"]["mean_per_pct"]


# ---------------------------------------------------------------- (4) stairwell and atrium openings
def _two_floor(voids_g=None, voids_u=None):
    g = floor("g", 0, aps=[{"id": "a", "x": 5.0, "y": 5.0, "tx_dbm": 20.0}])
    u = floor("u", 1)
    if voids_g:
        g["voids"] = voids_g
    if voids_u:
        u["voids"] = voids_u
    return {"name": "x", "units": "m", "floors": [g, u]}


def test_floor_loss_is_reduced_per_open_end():
    stair = {"id": "s", "kind": "stairwell", "x": 4.0, "y": 4.0, "w": 2.0, "d": 2.0}
    full = CFG["floor_loss_db"]["2.4"]
    cut = CFG["voids"]["open_end_reduction"]
    ap, f0, f1 = None, None, None
    for voids_g, voids_u, ends in ((None, None, 0), ([stair], None, 1), (None, [stair], 1), ([stair], [stair], 2)):
        t = _two_floor(voids_g, voids_u)
        ap, f0, f1 = t["floors"][0]["aps"][0], t["floors"][0], t["floors"][1]
        lost = rfmodel.floor_penetration_db(ap, f0, f1, 5.0, 5.0, 1, "2.4")
        assert lost == pytest.approx(full * (1.0 - min(1.0, ends * cut)))
    # the receiver outside the opening on the upper floor: only the AP end is open
    t = _two_floor([stair], [stair])
    assert rfmodel.floor_penetration_db(t["floors"][0]["aps"][0], t["floors"][0], t["floors"][1], 9.0, 9.0, 1, "2.4") == pytest.approx(full * (1 - cut))
    assert rfmodel.floor_penetration_db(ap, f0, f1, 5.0, 5.0, 0, "2.4") == 0.0


def test_void_polygon_membership_and_rssi_gain():
    tri = {"id": "t", "kind": "shaft", "points": [[0.0, 0.0], [10.0, 0.0], [0.0, 10.0]]}
    f = floor(voids=[tri])
    assert rfmodel.in_void(f, 2.0, 2.0) and not rfmodel.in_void(f, 8.0, 8.0) and not rfmodel.in_void(floor(), 2.0, 2.0)
    closed, opened = _two_floor(), _two_floor(voids_u=[{"id": "s", "kind": "atrium", "x": 4.0, "y": 4.0, "w": 3.0, "d": 3.0}])
    inside = rfmodel.probe_at(opened, "u", 5.0, 5.0)["rssi_dbm"]
    outside = rfmodel.probe_at(opened, "u", 12.0, 5.0)["rssi_dbm"]
    assert inside == pytest.approx(rfmodel.probe_at(closed, "u", 5.0, 5.0)["rssi_dbm"] + 0.5 * CFG["floor_loss_db"]["2.4"], abs=0.1)
    assert outside == rfmodel.probe_at(closed, "u", 12.0, 5.0)["rssi_dbm"]


def test_floors_without_voids_are_unchanged():
    t = twin.sample_twin()
    assert rfmodel.coverage_grid(t, "upper", 1.0) == rfmodel.coverage_grid(copy.deepcopy(t) | {"interferers": []}, "upper", 1.0)


# ---------------------------------------------------------------- (5) explanation
def test_explain_lists_each_wall_and_sums_to_the_total_loss():
    f = floor(walls=[wall("brick-wall", 6, 0, 6, 12, "brick"), wall("glass-wall", 10, 0, 10, 12, "glass")],
              aps=[{"id": "ap", "x": 2.0, "y": 6.0, "tx_dbm": 20.0}])
    t = {"name": "two walls", "units": "m", "floors": [f]}
    e = rfmodel.probe_at(t, "g", 14.0, 6.0, explain=True)["explain"]
    assert [(w["wall"], w["material"], w["loss_db"]) for w in e["walls"]] == [("brick-wall", "brick", 9.0), ("glass-wall", "glass", 3.0)]
    assert e["walls_loss_db"] == 12.0 and e["floor_loss_db"] == 0.0
    assert e["path_loss_db"] == pytest.approx(rfmodel.path_loss_db(12.0), abs=0.005)
    assert e["total_loss_db"] == pytest.approx(e["path_loss_db"] + e["walls_loss_db"] + e["floor_loss_db"], abs=1e-9)
    assert e["eirp_dbm"] - e["total_loss_db"] == pytest.approx(e["direct_dbm"], abs=1e-9)
    assert e["rssi_dbm"] == pytest.approx(e["direct_dbm"], abs=0.1)
    assert e["indirect"] == [] and e["dominant_path"] == "direct"
    text = "\n".join(e["text"])
    assert "wall brick-wall (Brick): 9.0 dB" in text and "wall glass-wall (Glass): 3.0 dB" in text and "Total loss" in text


def test_explain_includes_floor_loss_door_and_indirect_paths():
    simple = floor(walls=[wall("w1", 6, 0, 6, 12, "plaster")], aps=[{"id": "ap", "x": 3.0, "y": 6.0, "tx_dbm": 20.0}])
    simple["openings"] = [{"id": "d", "kind": "door", "wall": "w1", "pos": 5.0, "width": 1.0}]
    e = rfmodel.probe_at({"name": "s", "units": "m", "floors": [simple]}, "g", 9.0, 5.5, mode="multipath", explain=True)["explain"]
    assert e["walls"][0]["through"] == "door" and e["walls"][0]["loss_db"] == CFG["openings"]["door"]["attenuation_db"]["2.4"]
    assert [p["type"] for p in e["indirect"]] == ["diffraction", "diffraction"]     # AP and receiver are on opposite sides: no reflection
    side = rfmodel.probe_at({"name": "s", "units": "m", "floors": [simple]}, "g", 4.0, 2.0, mode="enhanced", explain=True)["explain"]
    assert any(p["type"] == "reflection" and p["material_label"] for p in side["indirect"])
    assert "Multipath adds" in "\n".join(e["text"]) and "sinr" not in e
    t = lab_project()
    stair = {"id": "s", "kind": "stairwell", "x": 4.0, "y": 4.0, "w": 2.0, "d": 2.0}
    far = rfmodel.probe_at(_two_floor(), "u", 15.0, 11.0, explain=True)["explain"]
    assert far["floors_crossed"] == 1 and far["floor_loss_db"] == far["floor_loss_without_voids_db"] == CFG["floor_loss_db"]["2.4"]
    open_ends = rfmodel.probe_at(_two_floor([stair], [stair]), "u", 5.0, 5.0, explain=True)["explain"]
    assert open_ends["floor_loss_db"] == 0.0 and "reduced by a stairwell or atrium opening" in "\n".join(open_ends["text"])


def test_explain_sinr_names_every_interferer():
    t = lab_project()
    e = rfmodel.probe_at(t, "g", 4.0, 6.0, explain=True)["explain"]
    ids = {i["id"] for i in e["sinr"]["interference"]}
    assert {"headset", "next-door"} <= ids and "oven" not in ids               # the oven starts at 2425 MHz, above channel 1
    noise = e["sinr"]["noise_floor_dbm"]
    power = sum(10 ** (i["power_dbm"] / 10) for i in e["sinr"]["interference"])
    assert e["sinr"]["sinr_db"] == pytest.approx(e["rssi_dbm"] - 10 * math.log10(10 ** (noise / 10) + power), abs=0.15)
    assert "SINR" in e["text"][-1]
    assert "explain" not in rfmodel.probe_at(t, "g", 4.0, 6.0)


# ---------------------------------------------------------------- (6) spectrum analysis
def _spectrum_project():
    aps = [{"id": f"ap{i}", "x": 2.0 + i, "y": 2.0, "tx_dbm": 20.0, "band": "2.4", "channel": ch} for i, ch in enumerate((1, 6, 11))]
    return {"name": "s", "units": "m", "floors": [floor(aps=aps)], "interferers": []}


def test_spectrum_flags_overlap_and_suggests_the_emptiest_channel():
    t = _spectrum_project()
    t["floors"][0]["aps"].pop()                                    # channels 1 and 6 in use, 11 free
    r = rfmodel.spectrum_analysis(t, "2.4")
    by = {c["channel"]: c for c in r["channels"]}
    assert by[1]["congestion"] == pytest.approx(1.0, abs=0.05) and by[6]["congestion"] == pytest.approx(1.0, abs=0.05) and by[1]["level"] == "moderate"
    assert by[11]["congestion"] < by[1]["congestion"]
    assert [s["channel"] for s in r["suggestions"]] == [11, 1, 6] and "ESTIMATE" in r["label"]
    assert by[3]["overlapping_sources"] == 2 and by[3]["congestion"] > by[11]["congestion"]       # channel 3 overlaps both
    without = rfmodel.spectrum_analysis(t, "2.4", exclude_ap="ap1")["channels"][5]
    assert without["congestion"] == pytest.approx(rfmodel.interference_coupling("2.4", 6, 20, 1, 20), abs=0.001)


def test_spectrum_counts_non_wifi_sources_and_covers_every_band():
    t = _spectrum_project()
    t["interferers"] = [{"id": "oven", "kind": "microwave", "floor": "g", "x": 5.0, "y": 5.0}]
    base = {c["channel"]: c for c in rfmodel.spectrum_analysis(_spectrum_project(), "2.4")["channels"]}
    r = {c["channel"]: c for c in rfmodel.spectrum_analysis(t, "2.4")["channels"]}
    assert r[6]["congestion"] == pytest.approx(base[6]["congestion"] + 0.5 * 20 / 50, abs=0.002)
    assert r[6]["sources"][-1] == {"id": "oven", "kind": "microwave", "coupling": 0.4, "overlap_mhz": 20.0}
    assert r[1]["congestion"] == base[1]["congestion"]
    for band in ("5", "6"):
        res = rfmodel.spectrum_analysis(t, band)
        assert [c["channel"] for c in res["channels"]] == CFG["bands"][band]["channels"] and len(res["suggestions"]) == 3
        assert all(c["congestion"] == 0.0 for c in res["channels"])
    with pytest.raises(ValueError, match="width_mhz"):
        rfmodel.spectrum_analysis(t, "2.4", width_mhz=80)
    with pytest.raises(ValueError, match="band"):
        rfmodel.spectrum_analysis(t, "7")


# ---------------------------------------------------------------- (7) signal decay
def test_signal_decay_follows_the_model_and_steps_at_walls():
    f = floor(walls=[wall("w", 8.5, 0, 8.5, 12, "concrete")], aps=[{"id": "ap", "x": 2.0, "y": 6.0, "tx_dbm": 20.0}])
    t = {"name": "d", "units": "m", "floors": [f]}
    r = rfmodel.signal_decay(t, "g", "ap", 0.0, step_m=1.0)
    s = r["samples"]
    assert [x["distance_m"] for x in s[:3]] == [0.0, 1.0, 2.0] and s[-1]["distance_m"] == 18.0
    assert s[3]["rssi_dbm"] == s[3]["distance_only_dbm"] and s[3]["walls_crossed"] == 0
    assert s[7]["distance_only_dbm"] - s[7]["rssi_dbm"] == CFG["materials"]["concrete"]["attenuation_db"]["2.4"] and s[7]["walls_crossed"] == 1
    assert all(a["rssi_dbm"] >= b["rssi_dbm"] for a, b in zip(s[1:], s[2:]))
    assert s[1]["rssi_dbm"] == rfmodel.rssi_from_ap(f["aps"][0], f, f, 3.0, 6.0)
    down = rfmodel.signal_decay(t, "g", "ap", 90.0, step_m=1.0)["samples"]
    assert down[-1]["distance_m"] == 6.0                           # the plan ends 6 m south of the AP
    with pytest.raises(ValueError, match="unknown AP"):
        rfmodel.signal_decay(t, "g", "nope", 0.0)
    with pytest.raises(ValueError, match="samples"):
        rfmodel.signal_decay(t, "g", "ap", 0.0, step_m=0.01)


# ---------------------------------------------------------------- (8) roaming
def test_roaming_map_marks_handoff_and_overlap_cells_between_two_aps():
    f = floor(aps=[{"id": "left", "x": 2.0, "y": 6.0, "tx_dbm": 20.0}, {"id": "right", "x": 18.0, "y": 6.0, "tx_dbm": 20.0}])
    t = {"name": "r", "units": "m", "floors": [f]}
    a = rfmodel.analyze_floor(t, "g", 1.0)
    m = a["roaming"]["map"]
    row = 6
    assert m["zone"][row][10] == m["zone_ids"].index("handoff")           # the midpoint: equal levels
    assert m["margin_db"][row][10] <= CFG["analytics"]["roam_margin_db"] and 50.0 <= m["blend_pct"][row][10] < 100.0
    assert m["second_ap"][row][10] in (0, 1)
    assert m["zone"][row][0] == 0 and m["blend_pct"][row][0] == 100.0 and m["second_ap"][row][0] == 1
    handoff = sum(v == m["zone_ids"].index("handoff") for r in m["zone"] for v in r)
    assert handoff == a["roaming"]["cells"] and "bbox" not in a["roaming"]["zones"][0]
    assert a["best_ap"][row][2] == 0 and a["best_ap"][row][17] == 1


# ---------------------------------------------------------------- validators: twin.py
def test_twin_accepts_voids_and_interferers_and_keeps_legacy_shape():
    clean = twin.validate_twin(lab_project())
    assert clean["floors"][0]["voids"][0]["w"] == 2.0 and clean["floors"][1]["voids"][0]["points"][2] == [12.0, 9.0]
    assert [s["id"] for s in clean["interferers"]] == ["oven", "headset", "next-door", "next-door-5"]
    legacy = twin.validate_twin(twin.sample_twin())
    assert "interferers" not in legacy and all("voids" not in f for f in legacy["floors"])
    assert twin.validate_twin(clean) == clean


def _bad(mutate, message):
    t = lab_project()
    mutate(t)
    with pytest.raises(twin.TwinError, match=message):
        twin.validate_twin(t)
    return t


BAD_CASES = [
    (lambda t: t["floors"][0]["voids"][0].update(kind="pit"), "voids\\[0\\].kind"),
    (lambda t: t["floors"][0]["voids"][0].update(w=0.0), "voids\\[0\\].w"),
    (lambda t: t["floors"][0]["voids"][0].update(x=19.5), "extends outside"),
    (lambda t: t["floors"][1]["voids"][0].update(points=[[1.0, 1.0], [2.0, 2.0]]), "3 to 32 points"),
    (lambda t: t["floors"][1]["voids"][0].update(points=[[1.0, 1.0], [2.0, 2.0], [99.0, 3.0]]), "points\\[2\\]\\[0\\]"),
    (lambda t: t["floors"][1]["voids"][0].update(x=1.0), "either points or x, y, w, d"),
    (lambda t: t["floors"][0]["voids"].append(dict(t["floors"][0]["voids"][0])), "duplicate id"),
    (lambda t: t["interferers"][0].update(kind="radar"), "interferers\\[0\\].kind"),
    (lambda t: t["interferers"][0].update(floor="roof"), "unknown floor id"),
    (lambda t: t["interferers"][0].update(x=50.0), "interferers\\[0\\].x"),
    (lambda t: t["interferers"][0].update(tx_dbm=99.0), "tx_dbm"),
    (lambda t: t["interferers"][0].update(duty_cycle=1.5), "duty_cycle"),
    (lambda t: t["interferers"][0].update(channel=6), "only a neighbour_wifi"),
    (lambda t: t["interferers"][2].update(channel=99), "interferers\\[2\\].channel"),
    (lambda t: t["interferers"][3].update(width_mhz=40), "interferers\\[3\\].width_mhz"),
    (lambda t: t["interferers"][1].update(id="oven"), "duplicate id"),
    (lambda t: t.update(interferers="none"), "interferers: must be a list"),
    (lambda t: t.update(interferers=[{"id": str(i), "kind": "microwave", "floor": "g", "x": 1.0, "y": 1.0} for i in range(51)]), "at most 50"),
]


@pytest.mark.parametrize("mutate,message", BAD_CASES)
def test_twin_rejects_bad_voids_and_interferers(mutate, message):
    _bad(mutate, message)


@needs_node
def test_planner_state_accepts_the_same_good_input_and_rejects_the_same_bad_input():
    js = """
      const S = require(process.argv[1] + '/planner-state.js');
      const opts = {config, materialIds: Object.keys(config.materials), bands: Object.keys(config.bands)};
      const good = S.validateProject(P.good, opts);
      const bad = P.bad.map(d => { try { S.validateProject(d, opts); return null; } catch (e) { return String(e.message); } });
      out({voids: good.floors.map(f => f.voids), interferers: good.interferers, bad});
    """
    bad = []
    for mutate, _message in BAD_CASES:
        t = lab_project()
        mutate(t)
        bad.append(t)
    got = run_js(js, {"good": lab_project(), "bad": bad})
    clean = twin.validate_twin(lab_project())
    assert got["voids"] == [f["voids"] for f in clean["floors"]] and got["interferers"] == clean["interferers"]
    for (_mutate, message), js_message in zip(BAD_CASES, got["bad"]):
        assert js_message is not None, f"planner-state.js accepted: {message}"
        field = message.replace("\\", "").split(":")[0].split(".")[-1]      # the field the Python message names
        assert field.split("[")[0] in js_message, (message, js_message)


@needs_node
def test_planner_state_keeps_legacy_projects_free_of_new_keys():
    js = """
      const S = require(process.argv[1] + '/planner-state.js');
      const p = S.validateProject(P.project, {config, materialIds: Object.keys(config.materials), bands: Object.keys(config.bands)});
      out({interferers: 'interferers' in p, voids: p.floors.map(f => 'voids' in f)});
    """
    assert run_js(js, {"project": twin.sample_twin()}) == {"interferers": False, "voids": [False, False]}


# ---------------------------------------------------------------- JS parity
@needs_node
@pytest.mark.parametrize("mode", ["basic", "enhanced", "multipath"])
def test_js_analytics_with_sources_voids_and_roaming_match_python(mode):
    project = lab_project()
    for fid in ("g", "u"):
        py = rfmodel.analyze_floor(project, fid, 2.0, None, mode)
        js = run_js("out(E.analyzeFloor(P.project, P.fid, {env, cellM: 2.0, mode: P.mode}))", {"project": project, "fid": fid, "mode": mode})
        assert "sinr" in py and py["sinr"]["external"] and "map" in py["roaming"]
        assert_close(py, js, f"lab/{fid}/{mode}")


@needs_node
def test_js_grid_with_voids_matches_python():
    project = lab_project()
    got = run_js("out(['g', 'u'].map(f => E.coverageGrid(P.project, f, {env, cellM: 1.0, mode: 'enhanced'})))", {"project": project})
    for fid, js in zip(("g", "u"), got):
        py = rfmodel.coverage_grid(project, fid, 1.0, mode="enhanced")
        worst = max(abs(a - b) for pr, jr in zip(py["rssi"], js["rssi"]) for a, b in zip(pr, jr))
        assert worst <= TOLERANCE_DB, (fid, worst)


@needs_node
def test_js_explain_matches_python_in_every_mode():
    project = lab_project()
    points = [("g", 9.0, 5.5), ("g", 4.0, 6.0), ("u", 10.0, 6.0), ("u", 1.0, 11.0), ("g", 17.0, 2.0)]
    jobs = [(fid, x, y, mode) for fid, x, y in points for mode in ("basic", "enhanced", "multipath")]
    got = run_js("out(P.jobs.map(j => E.probeAt(P.project, j[0], j[1], j[2], {env, mode: j[3], explain: true})))", {"project": project, "jobs": jobs})
    for (fid, x, y, mode), js in zip(jobs, got):
        py = rfmodel.probe_at(project, fid, x, y, mode=mode, explain=True)
        assert py["explain"]["text"] == js["explain"]["text"], (fid, x, y, mode)
        assert_close(py, js, f"explain/{fid}/{x}/{y}/{mode}")


@needs_node
def test_js_spectrum_decay_and_formulas_match_python():
    project = lab_project()
    got = run_js("""
      out({spectrum: [['2.4', null, null], ['5', null, null], ['6', 20, null], ['2.4', 40, 'a1']].map(a => E.spectrumAnalysis(P.project, a[0], {env, widthMhz: a[1], excludeAp: a[2]})),
           decay: [['g', 'a1', 0], ['g', 'a2', 200], ['u', 'a3', 45]].map(a => E.signalDecay(P.project, a[1], a[2], {env, floorId: a[0], mode: 'enhanced', stepM: 0.5})),
           per: [[-5, 0], [10, 3], [30, 9], [40, 11]].map(a => E.packetErrorRate(config, ...a)),
           rel: [['wifi6', 40, 600, 0], ['wifi6', -10, 0, 0.3], ['wifi4', 14, 40, 0.5]].map(a => E.linkReliability(config, ...a))})
    """, {"project": project})
    for js, args in zip(got["spectrum"], (("2.4", None, None), ("5", None, None), ("6", 20, None), ("2.4", 40, "a1"))):
        assert_close(rfmodel.spectrum_analysis(project, args[0], args[1], args[2]), js, f"spectrum/{args}")
    for js, (fid, ap, bearing) in zip(got["decay"], (("g", "a1", 0), ("g", "a2", 200), ("u", "a3", 45))):
        assert_close(rfmodel.signal_decay(project, fid, ap, float(bearing), mode="enhanced", step_m=0.5), js, f"decay/{ap}")
    assert got["per"] == pytest.approx([rfmodel.packet_error_rate(*a) for a in ((-5, 0), (10, 3), (30, 9), (40, 11))], rel=1e-12)
    for js, args in zip(got["rel"], (("wifi6", 40, 600, 0), ("wifi6", -10, 0, 0.3), ("wifi4", 14, 40, 0.5))):
        assert js == pytest.approx(rfmodel.link_reliability(*args), rel=1e-12, abs=1e-12)
    assert subprocess.run(["node", "--check", str(STATIC / "rf-engine.js")]).returncode == 0
    assert json.dumps(rfmodel.CONFIG["spectrum"]["levels"][-1]["max"]) == "null"
