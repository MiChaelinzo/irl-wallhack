"""Collector interface: poll() returns the newest readings for each link."""
import subprocess
from dataclasses import dataclass
from typing import List, Optional


@dataclass
class Reading:
    link: str
    rssi: float  # dBm, or a proxy value (see ping.py / udp_csi.py)
    t: Optional[float] = None  # time.monotonic() when received; None means "stamp at poll time"


class Collector:
    name = "base"
    interval_s = 0.25  # how often the runtime calls poll()

    def available(self) -> bool:
        """True if this collector can plausibly work on this machine."""
        return False

    def poll(self) -> List[Reading]:
        raise NotImplementedError

    def failure(self) -> str:
        """A human-readable reason this collector has stopped producing data, or "" if none."""
        return ""

    def close(self) -> None:
        pass


def run_command(args: List[str], timeout: float = 5.0) -> Optional[str]:
    """Run a local command (never through a shell). Returns stdout or None on failure."""
    try:
        res = subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return res.stdout if res.returncode == 0 else None


def percent_to_dbm(percent: float) -> float:
    """Windows reports signal quality 0-100%. Common approximation: dBm = pct/2 - 100."""
    return percent / 2.0 - 100.0
