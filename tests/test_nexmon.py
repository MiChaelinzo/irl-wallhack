"""nexmon_csi decoding. All frames are SYNTHETIC, built from the documented layout (no hardware)."""
import io
import math
import os
import struct
import sys
import threading
import time

import pytest

from wallhack import nexmon
from wallhack.collectors import nexmon as nexmon_collector
from wallhack.collectors.nexmon import NexmonCollector
from wallhack.nexmon import (NULL_SUBCARRIERS, FrameStats, frame_amplitude_db, iter_pcap_udp_payloads,
                             parse_nexmon_payload, summarize)
from wallhack.processing import SensingEngine

MAC = bytes.fromhex("aabbccddeeff")


def make_payload(n=64, rssi=-50, csiconf=0x0019, mac=MAC, seq=1, values=None, magic=nexmon.NEXMON_MAGIC):
    head = nexmon.HEADER.pack(magic, rssi, 0x88, mac, seq, csiconf, 0xE0A1, 0x4345)
    values = values if values is not None else [(3, 4)] * n
    return head + struct.pack("<%dh" % (2 * len(values)), *[v for pair in values for v in pair])


def eth_ip_udp(payload, port=5500, ihl_words=5, ethertype=0x0800, proto=17):
    ip_len = ihl_words * 4
    ip = bytearray(ip_len)
    ip[0] = 0x40 | ihl_words
    struct.pack_into(">H", ip, 2, ip_len + 8 + len(payload))
    ip[8], ip[9] = 64, proto
    ip[12:16], ip[16:20] = bytes([10, 10, 10, 10]), bytes([255] * 4)
    udp = struct.pack(">HHHH", 5500, port, 8 + len(payload), 0)
    return b"\xff" * 6 + b"\x00" * 6 + struct.pack(">H", ethertype) + bytes(ip) + udp + payload


def make_pcap(packets, endian="<", nano=False, linktype=1, times=None):
    magic = 0xA1B23C4D if nano else 0xA1B2C3D4
    out = struct.pack(endian + "IHHiIII", magic, 2, 4, 0, 0, 65535, linktype)
    for k, pkt in enumerate(packets):
        sec = int(times[k]) if times else k
        out += struct.pack(endian + "IIII", sec, 0, len(pkt), len(pkt)) + pkt
    return out


# ---- frame decoding -------------------------------------------------------------------------
@pytest.mark.parametrize("n", [64, 128, 256])
def test_parses_20_40_80_mhz_frames(n):
    f = parse_nexmon_payload(make_payload(n))
    assert f.subcarriers == n and f.rssi == -50 and f.src_mac == "aa:bb:cc:dd:ee:ff"
    assert f.csi[0] == (3, 4) and f.chanspec == 0xE0A1 and f.chip == 0x4345 and f.seq == 1


def test_core_and_stream_come_from_csiconf_bits():
    f = parse_nexmon_payload(make_payload(csiconf=0x0019))
    assert (f.core, f.stream) == (1, 3)
    assert f.link_id == "nx-ddeeff-c1s3"


@pytest.mark.parametrize("data", [
    make_payload(magic=0x2222), b"\x11\x11", make_payload()[:-2], make_payload(10), b""])
def test_rejects_bad_magic_short_and_odd_sizes(data):
    assert parse_nexmon_payload(data) is None


def test_amplitude_ignores_null_and_guard_subcarriers():
    for n, skip in NULL_SUBCARRIERS.items():
        values = [(1000, 0) if k in skip else (3, 4) for k in range(n)]
        f = parse_nexmon_payload(make_payload(values=values))
        assert frame_amplitude_db(f) == pytest.approx(20 * math.log10(5))


def amplitude_with_only_these_loud(n, loud_indices):
    values = [(1000, 0) if k in loud_indices else (3, 4) for k in range(n)]
    return frame_amplitude_db(parse_nexmon_payload(make_payload(values=values)))


QUIET_DB = 20 * math.log10(5)


def test_20mhz_mask_matches_upstream_faq_indices():
    # nexmon_csi FAQ, fftshifted order: nulls -32..-29, 0, +29..+31 -> 0..3, 32, 61..63.
    for k in (0, 1, 2, 3, 32, 61, 62, 63):
        assert amplitude_with_only_these_loud(64, {k}) == pytest.approx(QUIET_DB), k
    for k in (4, 31, 33, 60):  # data carriers k in 4..60 except 32 must be kept
        assert amplitude_with_only_these_loud(64, {k}) > QUIET_DB + 1, k


def test_40mhz_mask_matches_upstream_faq_indices():
    # -64..-59, -1..+1, +59..+63 with index = subcarrier + 64 -> 0..5, 63..65, 123..127.
    for k in (0, 5, 63, 64, 65, 123, 127):
        assert amplitude_with_only_these_loud(128, {k}) == pytest.approx(QUIET_DB), k
    for k in (6, 62, 66, 122):
        assert amplitude_with_only_these_loud(128, {k}) > QUIET_DB + 1, k


def test_80mhz_mask_matches_upstream_faq_indices():
    # -128..-123, -1..+1, +123..+127 with index = subcarrier + 128 -> 0..5, 127..129, 251..255.
    for k in (0, 5, 127, 128, 129, 251, 255):
        assert amplitude_with_only_these_loud(256, {k}) == pytest.approx(QUIET_DB), k
    for k in (6, 126, 130, 250):
        assert amplitude_with_only_these_loud(256, {k}) > QUIET_DB + 1, k


def test_zero_amplitude_gives_none():
    assert frame_amplitude_db(parse_nexmon_payload(make_payload(values=[(0, 0)] * 64))) is None


# ---- pcap reader ----------------------------------------------------------------------------
def test_pcap_reader_filters_packets_and_honours_ihl():
    good, other = make_payload(seq=1), make_payload(seq=2)
    pcap = make_pcap([
        eth_ip_udp(good), eth_ip_udp(b"x" * 30, proto=6), eth_ip_udp(b"x" * 30, port=9999),
        eth_ip_udp(b"x" * 30, ethertype=0x86DD), eth_ip_udp(other, ihl_words=7)])
    assert list(iter_pcap_udp_payloads(io.BytesIO(pcap))) == [good, other]


@pytest.mark.parametrize("endian,nano", [("<", False), (">", False), ("<", True), (">", True)])
def test_pcap_reader_accepts_endianness_and_nanosecond_variants(endian, nano):
    payload = make_payload()
    assert list(iter_pcap_udp_payloads(io.BytesIO(make_pcap([eth_ip_udp(payload)], endian, nano)))) == [payload]


def test_pcap_reader_tolerates_truncated_tail_and_empty_stream():
    payload = make_payload()
    pcap = make_pcap([eth_ip_udp(payload), eth_ip_udp(payload)])
    assert list(iter_pcap_udp_payloads(io.BytesIO(pcap[:-10]))) == [payload]
    assert list(iter_pcap_udp_payloads(io.BytesIO(pcap[:30]))) == []
    assert list(iter_pcap_udp_payloads(io.BytesIO(b""))) == []


def test_pcap_reader_rejects_wrong_magic_and_linktype():
    with pytest.raises(ValueError, match="not a libpcap"):
        list(iter_pcap_udp_payloads(io.BytesIO(b"\x00" * 40)))
    with pytest.raises(ValueError, match="link type 127"):
        list(iter_pcap_udp_payloads(io.BytesIO(make_pcap([], linktype=127))))


def test_pcap_reader_works_on_a_pipe_fed_in_small_chunks():
    payload = make_payload()
    pcap = make_pcap([eth_ip_udp(payload)] * 3)
    r, w = os.pipe()

    def writer():
        with os.fdopen(w, "wb", buffering=0) as fh:
            for i in range(0, len(pcap), 7):
                fh.write(pcap[i:i + 7])
                time.sleep(0.0005)

    t = threading.Thread(target=writer)
    t.start()
    with os.fdopen(r, "rb", buffering=0) as fh:  # raw reads return short chunks
        assert list(iter_pcap_udp_payloads(fh)) == [payload] * 3
    t.join()


# ---- collector ------------------------------------------------------------------------------
def emit_script(pcap: bytes, tmp_path, exit_code=0, stderr="") -> list:
    """Command that writes `pcap` to stdout the way tcpdump would, then exits."""
    path = tmp_path / "capture.pcap"
    path.write_bytes(pcap)
    code = ("import sys; sys.stderr.write(%r); sys.stderr.flush(); "
            "sys.stdout.buffer.write(open(%r, 'rb').read()); sys.stdout.flush(); sys.exit(%d)"
            % (stderr, str(path), exit_code))
    return [sys.executable, "-c", code]


def drain(col, expected, timeout=5.0):
    out, end = [], time.monotonic() + timeout
    while len(out) < expected and time.monotonic() < end:
        out += col.poll()
        time.sleep(0.01)
    return out


def test_collector_yields_one_reading_per_link_with_timestamps(tmp_path):
    a, b = make_payload(mac=MAC), make_payload(mac=bytes.fromhex("112233445566"), csiconf=0x0000)
    pcap = make_pcap([eth_ip_udp(a), eth_ip_udp(b), eth_ip_udp(a)])
    col = NexmonCollector(command=emit_script(pcap, tmp_path))
    before = time.monotonic()
    readings = drain(col, 3)
    col.close()
    assert [r.link for r in readings] == ["nx-ddeeff-c1s3", "nx-445566-c0s0", "nx-ddeeff-c1s3"]
    assert all(r.rssi == pytest.approx(20 * math.log10(5)) for r in readings)
    assert all(before <= r.t <= time.monotonic() for r in readings)
    assert col.stats.frames == 3 and col.last_error == ""
    col.close()  # idempotent


def test_collector_records_stderr_when_capture_fails(tmp_path):
    col = NexmonCollector(command=emit_script(b"", tmp_path, exit_code=1, stderr="tcpdump: Operation not permitted"))
    col.poll()
    end = time.monotonic() + 5
    while not col.last_error and time.monotonic() < end:
        time.sleep(0.01)
    col.close()
    assert "Operation not permitted" in col.last_error


def test_failure_is_reported_only_after_capture_ends(tmp_path):
    col = NexmonCollector(command=emit_script(b"", tmp_path, exit_code=1, stderr="tcpdump: no such device"))
    assert col.failure() == ""
    col.poll()
    end = time.monotonic() + 5
    while not col.failure() and time.monotonic() < end:
        time.sleep(0.01)
    col.close()
    assert "no such device" in col.failure()


def test_close_right_after_start_does_not_raise_in_threads(tmp_path):
    errors = []
    previous = threading.excepthook
    threading.excepthook = lambda args: errors.append(args.exc_value)
    try:
        for _ in range(20):
            col = NexmonCollector(command=emit_script(b"", tmp_path))
            col._start()
            col.close()
    finally:
        threading.excepthook = previous
    assert errors == []


def test_collector_unavailable_without_tcpdump(monkeypatch):
    monkeypatch.setattr(nexmon_collector.shutil, "which", lambda name: None)
    assert NexmonCollector().available() is False


def test_default_command_is_an_argument_list():
    cmd = nexmon_collector.default_command("wlan0", 5500)
    assert cmd[:3] == ["tcpdump", "-i", "wlan0"] and cmd[-1] == "5500"


def test_collector_counts_dropped_readings(monkeypatch, tmp_path):
    monkeypatch.setattr(nexmon_collector, "MAX_QUEUED_READINGS", 3)
    pcap = make_pcap([eth_ip_udp(make_payload())] * 8)
    col = NexmonCollector(command=emit_script(pcap, tmp_path))
    first = len(col.poll())  # may already hold some of the frames
    end = time.monotonic() + 5
    while col.stats.frames < 8 and time.monotonic() < end:
        time.sleep(0.01)
    rest = col.poll()
    col.close()
    assert len(rest) <= 3 and first + len(rest) + col.dropped == 8


def test_synthetic_breathing_through_collector_and_engine(tmp_path):
    """VERIFIED on synthetic data only: 10 Hz frames, 0.25 Hz (15 bpm) amplitude modulation."""
    frames, times = [], []
    for k in range(300):
        scale = 100 * (1 + 0.05 * math.sin(2 * math.pi * 0.25 * k / 10))
        values = [(int(round(scale * 0.6)), int(round(scale * 0.8)))] * 64
        frames.append(eth_ip_udp(make_payload(values=values, seq=k)))
    col = NexmonCollector(command=emit_script(make_pcap(frames), tmp_path))
    readings = drain(col, 300)
    col.close()
    assert len(readings) == 300
    engine = SensingEngine()
    for k, r in enumerate(readings):
        engine.feed(k / 10.0, r.link, "room", r.rssi)  # replay at the injected 10 Hz clock
    s = engine.summary()
    assert s["presence"] is True and abs(s["breathing_bpm"] - 15) <= 1.5


# ---- diagnostics ----------------------------------------------------------------------------
def stats_with(n_frames, seconds_of_link=1):
    st = FrameStats()
    for _ in range(n_frames):
        st.record(parse_nexmon_payload(make_payload()))
    return st


def test_summarize_no_frames_gives_hints_and_failure():
    s = summarize(FrameStats(), 10.0, last_error="Operation not permitted")
    text = s.render()
    assert not s.ok and "NO FRAMES" in text and "pi_setup.sh status" in text and "Operation not permitted" in text


def test_summarize_slow_and_fast_rates():
    slow = summarize(stats_with(20), 10.0)  # 2 frames/s
    assert slow.ok and "breathing will be disabled" in slow.render()
    fast = summarize(stats_with(100), 10.0)  # 10 frames/s
    assert fast.ok and fast.rate_per_link == {"nx-ddeeff-c1s3": 10.0} and fast.subcarriers == [64]
    assert "OK" in fast.render() and fast.median_rssi == -50


def test_run_csi_check_exit_codes(capsys, tmp_path):
    from wallhack.__main__ import run_csi_check
    pcap = make_pcap([eth_ip_udp(make_payload())] * 5)
    assert run_csi_check(NexmonCollector(command=emit_script(pcap, tmp_path)), 0.5) == 0
    assert "frames seen: 5" in capsys.readouterr().out
    assert run_csi_check(NexmonCollector(command=emit_script(b"", tmp_path)), 0.3) == 1
