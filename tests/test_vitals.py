"""Heart rate and activity classification, driven by synthetic signals (no hardware)."""
import numpy as np
import pytest

from wallhack.processing import (GRID_HZ, MIN_HEART_SAMPLE_HZ, SensingEngine, classify_activity,
                                 estimate_heart_rate, heart_supported, step_cadence)
from wallhack.simulator import Simulator

SPAN_S = 30.0


def series(heart_hz=1.2, breath_hz=0.25, heart_amp=0.5, noise=0.3, seed=0, hz=GRID_HZ, span=SPAN_S):
    t = np.arange(int(span * hz)) / hz
    rng = np.random.default_rng(seed)
    return (heart_amp * np.sin(2 * np.pi * heart_hz * t) + 1.0 * np.sin(2 * np.pi * breath_hz * t)
            + rng.normal(0, noise, len(t)))


@pytest.mark.parametrize("bpm", [55.0, 72.0, 90.0, 110.0])
def test_heart_rate_recovered_within_3_bpm(bpm):
    est, ratio = estimate_heart_rate(series(heart_hz=bpm / 60.0))
    assert est is not None and abs(est - bpm) <= 3.0
    assert ratio > 0


def test_heart_rate_rejects_noise_only():
    est, _ = estimate_heart_rate(series(heart_amp=0.0))
    assert est is None


def test_heart_rate_needs_minimum_span():
    assert estimate_heart_rate(series(span=5.0)) == (None, 0.0)


def test_heart_support_requires_fast_raw_sampling():
    t_slow = np.arange(100) / (MIN_HEART_SAMPLE_HZ / 2)
    t_fast = np.arange(100) / (MIN_HEART_SAMPLE_HZ * 2)
    vals = np.random.default_rng(1).normal(-50, 1, 100)
    assert not heart_supported(t_slow, vals)
    assert heart_supported(t_fast, vals)


def test_heart_support_rejects_quantised_readings():
    t = np.arange(100) / 10.0
    assert not heart_supported(t, np.round(np.random.default_rng(1).normal(-50, 3, 100) * 2) / 2)


def feed_engine(values, hz, link="l", zone="room", moving_noise=0.0, seed=0):
    eng = SensingEngine()
    rng = np.random.default_rng(seed)
    for i, v in enumerate(values):
        eng.feed(i / hz, link, zone, float(v) - 50.0 + rng.normal(0, moving_noise))
    return eng


def test_engine_reports_heart_at_10hz():
    eng = feed_engine(np.round(series(span=60.0), 2), 10.0)
    assert eng.summary()["heart_bpm"] == pytest.approx(72.0, abs=3.0)
    assert eng.summary()["heart_supported"] is True
    assert any(e.kind == "heart_detected" for e in eng.events)


def test_engine_disables_heart_at_low_rate():
    eng = feed_engine(np.round(series(span=60.0, hz=4.0), 2), 4.0)
    assert eng.summary()["heart_bpm"] is None
    assert eng.summary()["heart_supported"] is False


def test_no_heart_during_motion():
    sim = Simulator(3, "walking")
    eng = SensingEngine()
    for s in sim.next_samples(1200):
        eng.feed(s.t, s.link, s.zone, s.rssi)
    assert eng.zones()["living_room"]["motion"] and eng.summary()["heart_bpm"] is None


def test_simulated_breathing_scenario_recovers_heart():
    sim = Simulator(3, "breathing", heart_beats_per_min=75.0)
    eng = SensingEngine()
    for s in sim.next_samples(1200):
        eng.feed(s.t, s.link, s.zone, s.rssi)
    assert eng.zones()["living_room"]["heart_bpm"] == pytest.approx(75.0, abs=3.0)
    assert sim.truth(0)["heart_bpm"] == 75.0


def test_heart_lost_event_when_signal_stops():
    sim = Simulator(3, "demo")
    eng = SensingEngine()
    for s in sim.next_samples(2200):  # through the breathing phase into the empty phase
        eng.feed(s.t, s.link, s.zone, s.rssi)
    kinds = [e.kind for e in eng.events]
    assert "heart_detected" in kinds and "heart_lost" in kinds


# ---- activity ---------------------------------------------------------------
@pytest.mark.parametrize("presence,motion,cadence,expected", [
    (False, False, None, "empty"),
    (True, False, None, "still"),
    (True, True, 1.1, "walking"),
    (True, True, None, "active"),
    (False, True, None, "active"),
])
def test_classify_activity(presence, motion, cadence, expected):
    assert classify_activity(presence, motion, cadence) == expected


def test_step_cadence_found_for_rhythmic_movement():
    t = np.arange(100) / GRID_HZ
    cadence = step_cadence(3.0 * np.sin(2 * np.pi * 1.8 * t))
    assert cadence == pytest.approx(1.8, abs=0.15)


def test_step_cadence_absent_for_broadband_noise():
    assert step_cadence(np.random.default_rng(7).normal(0, 3, 100)) is None


def test_simulated_walking_is_walking_and_random_burst_is_active():
    sim = Simulator(3, "walking")
    eng = SensingEngine()
    for s in sim.next_samples(600):
        eng.feed(s.t, s.link, s.zone, s.rssi)
    assert eng.summary()["activity"] == "walking"
    burst = SensingEngine()
    rng = np.random.default_rng(11)
    for i in range(600):
        burst.feed(i / 10.0, "l", "room", -50.0 + rng.normal(0, 4.0))
    assert burst.summary()["activity"] == "active"


def test_empty_and_breathing_activity_labels():
    for scenario, expected in (("empty", "empty"), ("breathing", "still")):
        eng = SensingEngine()
        for s in Simulator(3, scenario).next_samples(1200):
            eng.feed(s.t, s.link, s.zone, s.rssi)
        assert eng.summary()["activity"] == expected
