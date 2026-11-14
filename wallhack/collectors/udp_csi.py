"""Optional ESP32 CSI receiver over UDP.

Packet format (one JSON object per UDP datagram, UTF-8):
    {"link": "esp32-1", "rssi": -52, "csi": [i0, q0, i1, q1, ...]}
"link" is required. If the receiver has a token configured (udp_token), packets must also carry
"token" with the same value; others are dropped. This is a shared secret, not encryption.
"link" is required. Provide "rssi" (dBm) and/or "csi" (interleaved int I/Q values).
If "csi" is present the reading is mean amplitude in dB (20*log10), which is more
sensitive than RSSI; otherwise "rssi" is used. Binds to 127.0.0.1 unless told otherwise.
"""
import json
import math
import socket
import time
from typing import List, Optional

from .base import Collector, Reading


def parse_csi_packet(data: bytes, token: str = "") -> Optional[Reading]:
    try:
        obj = json.loads(data.decode("utf-8"))
        link = str(obj["link"])
    except (ValueError, KeyError, TypeError, UnicodeDecodeError):
        return None
    if token and obj.get("token") != token:
        return None
    csi = obj.get("csi")
    if isinstance(csi, list) and len(csi) >= 2:
        try:
            pairs = zip(csi[0::2], csi[1::2])
            amps = [math.hypot(float(i), float(q)) for i, q in pairs]
        except (TypeError, ValueError):
            return None
        mean = sum(amps) / len(amps)
        if mean > 0:
            return Reading(link, 20.0 * math.log10(mean))
    rssi = obj.get("rssi")
    if isinstance(rssi, (int, float)):
        return Reading(link, float(rssi))
    return None


class UdpCsiCollector(Collector):
    name = "udp-csi"
    interval_s = 0.1

    def __init__(self, host: str = "127.0.0.1", port: int = 5500, token: str = ""):
        self.host, self.port, self.token = host, port, token
        self._sock: Optional[socket.socket] = None

    def available(self) -> bool:
        try:
            self._open()
            return True
        except OSError:
            return False

    def _open(self) -> socket.socket:
        if self._sock is None:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.bind((self.host, self.port))
            s.setblocking(False)
            self._sock = s
        return self._sock

    def poll(self) -> List[Reading]:
        sock = self._open()
        out: List[Reading] = []
        for _ in range(500):
            try:
                data, _addr = sock.recvfrom(65535)
            except BlockingIOError:
                break
            r = parse_csi_packet(data, self.token)
            if r:
                r.t = time.monotonic()
                out.append(r)
        return out

    def close(self) -> None:
        if self._sock:
            self._sock.close()
            self._sock = None
