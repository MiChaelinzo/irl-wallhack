"""Cross-platform fallback: latency to your OWN router.

Latency is only a weak proxy for signal quality. The value reported is -latency_ms
so that "stronger" is higher, like RSSI. Expect poor sensitivity. Target must be a
local/private address you control; public addresses are rejected.
"""
import ipaddress
import platform
import re
import shutil
from typing import List, Optional

from .base import Collector, Reading, run_command

_TIME = re.compile(r"time[=<]\s*([\d.]+)\s*ms", re.I)


def parse_ping_ms(text: str) -> Optional[float]:
    m = _TIME.search(text)
    return float(m.group(1)) if m else None


def is_private_target(host: str) -> bool:
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_private or ip.is_loopback


class PingCollector(Collector):
    name = "ping-latency"
    interval_s = 0.5

    def __init__(self, target: str):
        if not is_private_target(target):
            raise ValueError("ping target must be a private/local IP address (your own router)")
        self.target = target

    def available(self) -> bool:
        return shutil.which("ping") is not None

    def poll(self) -> List[Reading]:
        flag = "-n" if platform.system() == "Windows" else "-c"
        text = run_command(["ping", flag, "1", self.target], timeout=3.0)
        ms = parse_ping_ms(text) if text else None
        return [] if ms is None else [Reading(f"ping-{self.target}", -ms)]
