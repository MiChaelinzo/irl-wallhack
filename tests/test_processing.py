import pytest

from wallhack.processing import Hysteresis, SensingEngine, estimate_breathing
from wallhack.simulator import Simulator


def run(scenario, seed=1, n=1200, sensitivity=1.0, bpm=15.0):
    eng = SensingEngine(sensitivity)
    sim = Simulator(seed, scenario, breaths_per_min=bpm)
    for s in sim.next_samples(n):
        eng.feed(s.t, s.link, s.zone, s.rssi)
    return eng


@pytest.mark.parametrize("seed", range(1, 6))
def test_empty_room_stays_quiet(seed):
    eng = run("empty", seed, n=3000)
    assert eng.summary() == {"presence": False, "motion": False, "breathing_bpm": None}
    assert len(eng.events) == 0


def test_walking_detected_as_motion_and_presence():
    z = run("walking").zones()
    assert z["living_room"]["motion"] and z["living_room"]["presence"]
    assert not z["bedroom"]["presence"]


@pytest.mark.parametrize("bpm", [10.0, 15.0, 22.0])
def test_breathing_rate_within_1_bpm(bpm):
    z = run("breathing", bpm=bpm)
    zone = z.zones()["living_room"]
    assert zone["presence"] and not zone["motion"]
    assert abs(zone["breathing_bpm"] - bpm) <= 1.0


def test_two_zones_independent():
    z = run("two_zones").zones()
    assert z["living_room"]["motion"]
    assert z["bedroom"]["breathing_bpm"] is not None and not z["bedroom"]["motion"]


def test_demo_events_timeline():
    eng = run("demo", n=1450)
    kinds = [e.kind for e in eng.events]
    assert kinds[:2] == ["motion_start", "presence_start"]
    assert "motion_end" in kinds and "presence_end" in kinds


def test_sensitivity_changes_threshold():
    assert run("walking", sensitivity=0.25).summary()["motion"] is False
    assert run("walking", sensitivity=1.0).summary()["motion"] is True


def test_hysteresis_needs_hold():
    h = Hysteresis(enter_hold=3, exit_hold=4)
    assert [h.update(True, False) for _ in range(3)] == [False, False, True]
    assert h.update(False, True) and h.update(False, False)  # a single "off" blip is ignored
    assert [h.update(False, True) for _ in range(4)] == [True, True, True, False]


def test_breathing_needs_enough_history():
    assert estimate_breathing([0.0] * 20)[0] is None
