#!/usr/bin/env python3
"""Forward nexmon_csi UDP frames to Wallhack's JSON UDP format. Standard library only.

Usage (on the Pi that runs nexmon_csi, which sends frames to UDP port 5500):
    python3 tools/csi_forwarder.py --listen-port 5500 --target-port 5005 --link pi4 --token SECRET

UNVERIFIED: written from the public nexmon_csi frame layout, never run against real hardware.
Frame layout assumed (little endian): magic 0x1111 (2 bytes), rssi int8, frame control (1),
source MAC (6), sequence (2), core/stream (2), chanspec (2), chip (2), then CSI.
Only CSI stored as int16 I/Q pairs is understood (e.g. BCM4366c0). The Pi 4 chip (BCM43455c0)
packs CSI into 32-bit words that need nexmon's unpack step; frames of that size are not
decoded here and are forwarded as RSSI only.
"""
import argparse
import json
import socket
import struct
import sys
from typing import Optional

HEADER = struct.Struct("<HbB6sHHHH")  # 18 bytes
MAGIC = 0x1111
SUBCARRIERS = (64, 128, 256)  # 20, 40, 80 MHz


def convert_frame(data: bytes, link: str, token: str = "") -> Optional[dict]:
    """Return a Wallhack packet dict for one nexmon_csi frame, or None if it is not valid."""
    if len(data) < HEADER.size:
        return None
    magic, rssi, _fctl, _mac, _seq, _css, _chanspec, _chip = HEADER.unpack_from(data)
    if magic != MAGIC:
        return None
    packet = {"link": link, "rssi": rssi}
    payload = data[HEADER.size:]
    for n in SUBCARRIERS:
        if len(payload) == n * 4:  # n subcarriers x (int16 I, int16 Q)
            packet["csi"] = list(struct.unpack("<%dh" % (n * 2), payload))
            break
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
            tx.sendto(json.dumps(packet).encode("utf-8"), (a.target_host, a.target_port))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
