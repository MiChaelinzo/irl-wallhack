"""Windows 11: uses `netsh wlan`. Signal is reported as a 0-100% quality value."""
import re
import shutil
from typing import List

from .base import Collector, Reading, percent_to_dbm, run_command


def parse_netsh_interfaces(text: str) -> List[Reading]:
    """`netsh wlan show interfaces` -> reading for the connected BSSID."""
    bssid = re.search(r"^\s*BSSID\s*:\s*([0-9a-fA-F:]{17})", text, re.M)
    sig = re.search(r"^\s*Signal\s*:\s*(\d+)\s*%", text, re.M)
    if not bssid or not sig:
        return []
    return [Reading(bssid.group(1).lower(), percent_to_dbm(float(sig.group(1))))]


def parse_netsh_networks(text: str) -> List[Reading]:
    """`netsh wlan show networks mode=bssid` -> one reading per visible BSSID."""
    out: List[Reading] = []
    for block in re.split(r"(?m)^\s*BSSID\s+\d+\s*:\s*", text)[1:]:
        mac = re.match(r"([0-9a-fA-F:]{17})", block)
        sig = re.search(r"Signal\s*:\s*(\d+)\s*%", block)
        if mac and sig:
            out.append(Reading(mac.group(1).lower(), percent_to_dbm(float(sig.group(1)))))
    return out


class WindowsCollector(Collector):
    name = "windows-netsh"
    interval_s = 1.0  # netsh is slow; breathing detection is limited at this rate

    def available(self) -> bool:
        return shutil.which("netsh") is not None

    def poll(self) -> List[Reading]:
        text = run_command(["netsh", "wlan", "show", "interfaces"])
        return parse_netsh_interfaces(text) if text else []
