"""Runtime behaviour with fake collectors: timestamps, staleness, lock use."""
import threading
import time

from wallhack import runtime
from wallhack.collectors.base import Collector, Reading
from wallhack.collectors.udp_csi import UdpCsiCollector, parse_csi_packet
from wallhack.config import Config
from wallhack.processing import SensingEngine, breathing_supported


class FakeCollector(Collector):
    name = "fake"

    def __init__(self, batches):
        self.batches = list(batches)

    def poll(self):
        return self.batches.pop(0) if self.batches else []


def make_runtime(monkeypatch, collector):
    monkeypatch.setattr(runtime.Runtime, "_build_collectors", lambda self: [collector])
    return runtime.Runtime(Config(source="real", background=False))


def test_per_packet_times_are_kept(monkeypatch):
    now = time.monotonic()
    probe = [Reading("a", -50.0)]
    burst = [Reading("a", -50.0 - i, t=now + 0.01 * i) for i in range(5)]
    rt = make_runtime(monkeypatch, FakeCollector([probe, burst]))
    assert rt.source == "real"
    rt.poll_real()
    times = [s["t"] for s in rt.samples]
    assert len(times) == 5 and len(set(times)) == 5
    assert all(b - a > 0 for a, b in zip(times, times[1:]))


def test_stale_real_source_is_flagged(monkeypatch):
    rt = make_runtime(monkeypatch, FakeCollector([[Reading("a", -50.0)]]))
    assert "stale_s" in rt.status() and "No new WiFi" not in rt.status()["note"]
    rt._last_data -= runtime.STALE_AFTER_S + 5
    assert "No new WiFi readings" in rt.status()["note"]


def test_status_not_blocked_while_collector_polls(monkeypatch):
    release = threading.Event()

    class Slow(FakeCollector):
        def poll(self):
            if self.batches:
                return self.batches.pop(0)
            release.wait(5)
            return []

    rt = make_runtime(monkeypatch, Slow([[Reading("a", -50.0)]]))
    t = threading.Thread(target=rt.poll_real)
    t.start()
    time.sleep(0.2)
    start = time.monotonic()
    rt.status()
    assert time.monotonic() - start < 0.5
    release.set()
    t.join(5)


def test_breathing_disabled_for_slow_or_quantised_data():
    import numpy as np
    t = np.arange(0, 40, 1.0)  # 1 Hz, like netsh
    assert breathing_supported(t, np.random.default_rng(0).normal(-60, 1, len(t))) is False
    t = np.arange(0, 40, 0.1)  # 10 Hz but whole-dB steps
    assert breathing_supported(t, np.round(-60 + np.sin(t))) is False
    assert breathing_supported(t, -60 + np.sin(t)) is True


def test_engine_flags_unsupported_breathing():
    eng = SensingEngine()
    for i in range(60):
        eng.feed(float(i), "w", "room", -60.0 + 0.5 * (i % 3))
    assert eng.summary()["breathing_supported"] is False and eng.summary()["breathing_bpm"] is None


def test_udp_token_and_real_socket():
    import socket
    assert parse_csi_packet(b'{"link": "e", "rssi": -50}', token="s3") is None
    assert parse_csi_packet(b'{"link": "e", "rssi": -50, "token": "s3"}', token="s3").rssi == -50.0
    with socket.socket() as s:  # find a free UDP port
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    col = UdpCsiCollector("127.0.0.1", port, token="s3")
    assert col.available()
    try:
        tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        for i in range(3):
            tx.sendto(b'{"link": "e", "rssi": -50, "token": "s3"}', ("127.0.0.1", port))
        tx.sendto(b'{"link": "e", "rssi": -1}', ("127.0.0.1", port))  # spoofed, no token
        time.sleep(0.2)
        got = col.poll()
        assert len(got) == 3 and all(r.t is not None for r in got)
        assert got[0].t <= got[1].t <= got[2].t
    finally:
        col.close()


def test_runtime_passes_udp_token_to_collector():
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    rt = runtime.Runtime(Config(source="simulator", background=False, udp_port=port, udp_token="s3"))
    try:
        udp = [c for c in rt._build_collectors() if isinstance(c, UdpCsiCollector)]
        assert len(udp) == 1
        col = udp[0]
        try:
            tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            tx.sendto(b'{"link": "e", "rssi": -1}', ("127.0.0.1", port))  # untokened: dropped
            tx.sendto(b'{"link": "e", "rssi": -50, "token": "s3"}', ("127.0.0.1", port))
            time.sleep(0.2)
            got = col.poll()
            assert [r.rssi for r in got] == [-50.0]
        finally:
            col.close()
            tx.close()
    finally:
        rt.stop()


def test_nexmon_source_builds_collector_and_skips_platform_collector(monkeypatch):
    from wallhack.collectors import nexmon as nx
    called = []
    monkeypatch.setattr(runtime, "detect_collector", lambda: called.append(1))
    monkeypatch.setattr(nx.shutil, "which", lambda name: "/usr/sbin/tcpdump")
    monkeypatch.setattr(runtime.NexmonCollector, "poll", lambda self: [])
    rt = runtime.Runtime(Config(source="auto", csi_source="nexmon", background=False))
    cols = rt._build_collectors()
    assert [c.name for c in cols] == ["nexmon-csi"] and not called
    assert rt.status()["collectors"] == []  # simulator fallback: nothing real is active


def test_status_lists_active_collector_names(monkeypatch):
    rt = make_runtime(monkeypatch, FakeCollector([[Reading("a", -50.0)]]))
    assert rt.status()["collectors"] == ["fake"]


def test_status_note_reports_dead_capture_process(monkeypatch):
    class Dead(FakeCollector):
        name = "nexmon-csi"

        def failure(self):
            return "tcpdump: Operation not permitted"

    rt = make_runtime(monkeypatch, Dead([[Reading("a", -50.0)]]))
    note = rt.status()["note"]
    assert "Capture stopped" in note and "nexmon-csi" in note and "Operation not permitted" in note


def test_config_rejects_unknown_csi_source():
    import pytest
    with pytest.raises(ValueError):
        Config(csi_source="bogus").validate()


def test_real_source_without_sensors_has_no_environment(monkeypatch):
    rt = make_runtime(monkeypatch, FakeCollector([[Reading("a", -50.0)]] * 3))
    assert rt.source == "real"
    assert rt.environment() is None and rt.status()["environment"] is None
    assert rt.status()["vitals"]["simulated"] is False


def test_simulated_environment_responds_to_occupancy_and_is_deterministic():
    from wallhack.simulator import SimulatedEnvironment
    occupied = lambda t: t >= 60.0
    a, b = SimulatedEnvironment(occupied, 7), SimulatedEnvironment(occupied, 7)
    empty, later = a.reading(50.0), a.reading(400.0)
    assert later.co2 > empty.co2 + 500 and later.surface_temp_c > empty.surface_temp_c
    assert all(r.simulated for r in (empty, later))
    assert b.reading(400.0) == later                      # read pattern does not matter
    assert SimulatedEnvironment(occupied, 8).reading(400.0) != later


def test_simulated_environment_has_pm_spike_event():
    from wallhack.simulator import PM_SPIKE_WINDOW_S, SimulatedEnvironment
    env = SimulatedEnvironment(lambda t: False, 3)
    before = env.reading(PM_SPIKE_WINDOW_S[0] - 1.0).pm25
    during = env.reading(PM_SPIKE_WINDOW_S[1] - 1.0).pm25
    assert during > before * 5


def test_runtime_uses_hub_when_sensors_configured(monkeypatch):
    from wallhack.environment import EnvironmentReading

    class FakeHub:
        started = stopped = False

        def reading(self):
            return EnvironmentReading(co2=900.0)

        def status(self):
            return {"scd4x": {"state": "ok", "message": ""}}

        def start(self):
            FakeHub.started = True

        def stop(self):
            FakeHub.stopped = True

    monkeypatch.setattr(runtime, "build_hub", lambda config: FakeHub())
    rt = runtime.Runtime(Config(source="simulator", sensors="scd4x", background=False))
    env = rt.environment()
    assert env["simulated"] is False and env["reading"]["co2"] == 900.0
    assert env["sensors"]["scd4x"]["state"] == "ok"
    rt.start()
    rt.stop()
    assert FakeHub.started and FakeHub.stopped


def test_vitals_report_simulated_flag(monkeypatch):
    rt = runtime.Runtime(Config(source="simulator", scenario="breathing", background=False))
    rt.step_sim(1200)
    v = rt.vitals()
    assert v["simulated"] is True and v["activity"] == "still"
