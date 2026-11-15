"""macOS: `system_profiler SPAirPortDataType`."""
import re
import shutil
from typing import List

from .base import Collector, Reading, run_command


def parse_system_profiler(text: str) -> List[Reading]:
    """Reads 'Signal / Noise: -55 dBm / -90 dBm' from the Current Network Information section."""
    m = re.search(r"Current Network Information:(.*?)(?:Other Local Wi-Fi Networks:|\Z)", text, re.S)
    section = m.group(1) if m else text
    sig = re.search(r"Signal / Noise:\s*(-?\d+)\s*dBm", section)
    if not sig:
        return []
    name = re.search(r"^\s*([^\n:]+):\s*$", section, re.M)
    return [Reading((name.group(1).strip() if name else "current-network"), float(sig.group(1)))]


class MacOSCollector(Collector):
    name = "macos-system_profiler"
    interval_s = 1.0

    def available(self) -> bool:
        return shutil.which("system_profiler") is not None

    def poll(self) -> List[Reading]:
        text = run_command(["system_profiler", "SPAirPortDataType"], timeout=15.0)
        return parse_system_profiler(text) if text else []
