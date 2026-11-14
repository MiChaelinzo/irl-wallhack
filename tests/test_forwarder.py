import importlib.util
import struct
from pathlib import Path

from wallhack.collectors.udp_csi import parse_csi_packet
import json

_spec = importlib.util.spec_from_file_location(
    "csi_forwarder", Path(__file__).resolve().parent.parent / "tools" / "csi_forwarder.py")
fwd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fwd)


def _frame(csi_words=0, rssi=-50, magic=0x1111):
    head = fwd.HEADER.pack(magic, rssi, 0, b"\x00" * 6, 1, 0, 0, 0)
    return head + struct.pack("<%dh" % (csi_words * 2), *([3, 4] * csi_words))


def test_converts_int16_csi_and_roundtrips_through_collector_parser():
    pkt = fwd.convert_frame(_frame(64), "pi", token="t")
    assert pkt["rssi"] == -50 and len(pkt["csi"]) == 128 and pkt["token"] == "t"
    reading = parse_csi_packet(json.dumps(pkt).encode(), token="t")
    assert reading.link == "pi" and abs(reading.rssi - 13.98) < 0.01  # |3+4j| = 5 -> 20*log10(5)


def test_unknown_payload_size_falls_back_to_rssi_only():
    pkt = fwd.convert_frame(_frame(10), "pi")
    assert pkt == {"link": "pi", "rssi": -50}


def test_rejects_bad_magic_and_short_frames():
    assert fwd.convert_frame(_frame(64, magic=0x2222), "pi") is None
    assert fwd.convert_frame(b"\x11\x11", "pi") is None
