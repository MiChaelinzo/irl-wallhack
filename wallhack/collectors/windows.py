"""Windows 11: uses `netsh wlan`. Signal is reported as a 0-100% quality value."""
import re
import shutil
from typing import List

from .base import Collector, Reading, percent_to_dbm, run_command


# netsh labels are localised ("Signal", "Senal", "Segnale"...), so parse by value shape instead:
# a MAC address, and the one "<label> : NN%" line (the signal quality).
_MAC = r"([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})"
_PERCENT_LINE = re.compile(r"^\s*[^:\n]+:\s*(\d{1,3})\s*%\s*$", re.M)


def parse_netsh_interfaces(text: str) -> List[Reading]:
    """`netsh wlan show interfaces` -> reading for the connected BSSID (any language)."""
    bssid = re.search(r"^\s*[^:\n]*BSSID[^:\n]*:\s*" + _MAC, text, re.M)
    sig = _PERCENT_LINE.search(text)
    if not bssid or not sig:
        return []
    return [Reading(bssid.group(1).lower(), percent_to_dbm(float(sig.group(1))))]


def parse_netsh_networks(text: str) -> List[Reading]:
    """`netsh wlan show networks mode=bssid` -> one reading per visible BSSID (any language)."""
    out: List[Reading] = []
    for block in re.split(r"(?m)^\s*BSSID\s+\d+\s*:\s*(?=" + _MAC + ")", text)[1:]:
        mac = re.match(_MAC, block)
        sig = _PERCENT_LINE.search(block)
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
