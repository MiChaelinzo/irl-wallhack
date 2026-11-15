import json

from wallhack.simulator import SCENARIOS, Simulator


def dump(sim, n):
    return json.dumps([s.__dict__ for s in sim.next_samples(n)]).encode()


def test_same_seed_is_byte_identical():
    for sc in SCENARIOS:
        assert dump(Simulator(7, sc), 500) == dump(Simulator(7, sc), 500)


def test_different_seed_differs():
    assert dump(Simulator(1, "walking"), 100) != dump(Simulator(2, "walking"), 100)


def test_batching_does_not_change_output():
    a = Simulator(3, "demo")
    parts = a.next_samples(100) + a.next_samples(150)
    b = Simulator(3, "demo").next_samples(250)
    assert parts == b


def test_unknown_scenario():
    import pytest
    with pytest.raises(ValueError):
        Simulator(1, "nope")


def test_truth_follows_script():
    s = Simulator(1, "demo")
    assert s.truth(5)["presence"] is False
    assert s.truth(40)["motion"] is True
    assert s.truth(80)["breathing_bpm"] == 15.0
