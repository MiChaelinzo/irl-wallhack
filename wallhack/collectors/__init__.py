"""Platform collectors and auto-detection."""
import platform
from typing import Optional

from .base import Collector, Reading
from .linux import LinuxCollector
from .macos import MacOSCollector
from .windows import WindowsCollector

__all__ = ["Collector", "Reading", "detect_collector"]


def detect_collector(system: Optional[str] = None) -> Optional[Collector]:
    """Return the collector for this OS if its tool exists, else None (caller falls back)."""
    system = system or platform.system()
    cls = {"Linux": LinuxCollector, "Windows": WindowsCollector, "Darwin": MacOSCollector}.get(system)
    if cls is None:
        return None
    c = cls()
    return c if c.available() else None
