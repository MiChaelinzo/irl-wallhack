"""Linux (Raspberry Pi OS): uses `iw`, with `nmcli` as fallback."""
import re
import shutil
from typing import List

from .base import Collector, Reading, run_command

_SIGNAL = re.compile(r"signal:\s*(-?\d+(?:\.\d+)?)\s*dBm")


def parse_iw_link(text: str) -> List[Reading]:
    """`iw dev wlan0 link` output -> reading for the connected access point."""
    m = re.search(r"Connected to\s+([0-9a-fA-F:]{17})", text)
    s = _SIGNAL.search(text)
    if not m or not s:
        return []
    return [Reading(m.group(1).lower(), float(s.group(1)))]


def parse_iw_scan(text: str) -> List[Reading]:
    """`iw dev wlan0 scan` output -> one reading per visible BSSID."""
    out: List[Reading] = []
    for block in re.split(r"(?m)^BSS\s+", text)[1:]:
        mac = re.match(r"([0-9a-fA-F:]{17})", block)
        sig = _SIGNAL.search(block)
        if mac and sig:
            out.append(Reading(mac.group(1).lower(), float(sig.group(1))))
    return out


def parse_nmcli(text: str) -> List[Reading]:
    """`nmcli -t -f BSSID,SIGNAL dev wifi list` (terse; colons in BSSID are escaped as \\:)."""
    out: List[Reading] = []
    for line in text.splitlines():
        m = re.match(r"((?:[0-9A-Fa-f]{2}\\:){5}[0-9A-Fa-f]{2}):(\d+)\s*$", line)
        if m:
            pct = float(m.group(2))
            out.append(Reading(m.group(1).replace("\\:", ":").lower(), pct / 2.0 - 100.0))
    return out


class LinuxCollector(Collector):
    name = "linux-iw"

    def __init__(self, interface: str = "wlan0"):
        self.interface = interface

    def available(self) -> bool:
        return shutil.which("iw") is not None or shutil.which("nmcli") is not None

    def poll(self) -> List[Reading]:
        if shutil.which("iw"):
            text = run_command(["iw", "dev", self.interface, "link"])
            if text:
                readings = parse_iw_link(text)
                if readings:
                    return readings
        if shutil.which("nmcli"):
            text = run_command(["nmcli", "-t", "-f", "BSSID,SIGNAL", "dev", "wifi", "list"])
            if text:
                return parse_nmcli(text)
        return []
