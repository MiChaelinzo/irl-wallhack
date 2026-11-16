#!/usr/bin/env python3
"""Forward nexmon_csi UDP frames to Wallhack's JSON UDP format. Standard library only.

Usage (on the Pi that runs nexmon_csi, which sends frames to UDP port 5500):
    python3 tools/csi_forwarder.py --listen-port 5500 --target-port 5005 --link pi4 --token SECRET

UNVERIFIED on hardware: frame decoding lives in wallhack/nexmon.py (the single implementation) and
is tested on synthetic frames only. CSI is int16 I/Q for BCM43455c0, as in upstream csireader.m.
"""
import argparse
import json
import socket
import sys
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from wallhack.nexmon import HEADER, NEXMON_MAGIC, parse_nexmon_payload  # noqa: E402


def convert_frame(data: bytes, link: str, token: str = "") -> Optional[dict]:
    """Return a Wallhack packet dict for one nexmon_csi frame, or None if it is not valid.

    A frame with an unexpected CSI size is forwarded as RSSI only."""
    frame = parse_nexmon_payload(data)
    if frame is not None:
        packet = {"link": link, "rssi": frame.rssi, "csi": [v for pair in frame.csi for v in pair]}
    elif len(data) >= HEADER.size and HEADER.unpack_from(data)[0] == NEXMON_MAGIC:
        packet = {"link": link, "rssi": HEADER.unpack_from(data)[1]}
    else:
        return None
    if token:
        packet["token"] = token
    return packet


def main(argv=None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--listen-host", default="127.0.0.1")
    p.add_argument("--listen-port", type=int, default=5500)
    p.add_argument("--target-host", default="127.0.0.1")
    p.add_argument("--target-port", type=int, default=5005, help="Wallhack --udp-port")
    p.add_argument("--link", default="nexmon-1")
    p.add_argument("--token", default="", help="Wallhack --udp-token")
    a = p.parse_args(argv)
    rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    rx.bind((a.listen_host, a.listen_port))
    tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    print("Forwarding %s:%d -> %s:%d (Ctrl+C to stop)" % (a.listen_host, a.listen_port, a.target_host, a.target_port))
    dropped = 0
    try:
        while True:
            data, _ = rx.recvfrom(65535)
            packet = convert_frame(data, a.link, a.token)
            if packet is None:
                dropped += 1
                if dropped in (1, 100, 10000):
                    print("dropped %d frame(s) that are not nexmon_csi frames" % dropped, file=sys.stderr)
                continue
            try:
                tx.sendto(json.dumps(packet).encode("utf-8"), (a.target_host, a.target_port))
            except OSError as exc:
                print("could not forward packet: %s" % exc, file=sys.stderr)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
