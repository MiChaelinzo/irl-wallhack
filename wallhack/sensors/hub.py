"""EnvironmentHub: polls the enabled drivers and merges their latest values into one reading."""
import logging
import threading
import time
from dataclasses import fields
from typing import Callable, Dict, List, Optional

from ..config import Config
from ..environment import EnvironmentReading
from .base import SensorDriver, SensorError
from .ens160 import Ens160
from .mlx90614 import Mlx90614
from .pms5003 import Pms5003
from .scd4x import Scd4x
from .transports import Smbus2Transport, SerialTransport
from .ze08_ch2o import Ze08Ch2o

log = logging.getLogger("wallhack")
STALE_INTERVALS = 3.0          # a sensor is stale after this many missed polling intervals
HUB_TICK_S = 0.25
WAITING, OK, STALE, ERROR, WARMING = "waiting", "ok", "stale", "error", "warming"
_FIELDS = {f.name for f in fields(EnvironmentReading)} - {"simulated", "t"}


class EnvironmentHub:
    def __init__(self, drivers: List[SensorDriver], clock: Callable[[], float] = time.monotonic,
                 failed: Optional[Dict[str, str]] = None):
        self._drivers = list(drivers)
        self._clock = clock
        self._lock = threading.Lock()
        self._values: Dict[str, dict] = {}
        self._last_ok: Dict[str, float] = {}
        self._last_poll: Dict[str, float] = {}
        self._errors: Dict[str, str] = dict(failed or {})
        self._names = [d.name for d in self._drivers] + list(self._errors)
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def poll_once(self) -> None:
        """Poll every driver whose interval has elapsed. Failures are logged and stored, never dropped."""
        now = self._clock()
        for driver in self._drivers:
            if now - self._last_poll.get(driver.name, -driver.interval_s) < driver.interval_s:
                continue
            self._last_poll[driver.name] = now
            try:
                values = driver.poll()
                unknown = set(values or ()) - _FIELDS
                if unknown:
                    raise SensorError(f"driver {driver.name} returned unknown fields {sorted(unknown)}")
            except Exception as exc:  # one sensor's failure, including a driver bug, must not stop the others
                message = f"{type(exc).__name__}: {exc}"
                with self._lock:
                    if self._errors.get(driver.name) != message:
                        log.warning("sensor %s: %s", driver.name, message)
                    self._errors[driver.name] = message
                    self._values.pop(driver.name, None)
                continue
            with self._lock:
                self._errors.pop(driver.name, None)
                if values is not None:
                    self._values[driver.name] = values
                    self._last_ok[driver.name] = now

    def status(self) -> Dict[str, dict]:
        now = self._clock()
        out: Dict[str, dict] = {}
        with self._lock:
            intervals = {d.name: d.interval_s for d in self._drivers}
            warming = {d.name for d in self._drivers if getattr(d, "warming_up", False)}
            for name in self._names:
                if name in self._errors:
                    out[name] = {"state": ERROR, "message": self._errors[name]}
                elif name in warming:
                    out[name] = {"state": WARMING, "message": "sensor is warming up, readings are not valid yet"}
                elif name not in self._last_ok:
                    out[name] = {"state": WAITING, "message": ""}
                elif now - self._last_ok[name] > STALE_INTERVALS * intervals[name]:
                    out[name] = {"state": STALE, "message": f"no new data for {now - self._last_ok[name]:.0f} s"}
                else:
                    out[name] = {"state": OK, "message": ""}
        return out

    def reading(self) -> EnvironmentReading:
        """Merge the values of every sensor whose state is ok. Later drivers win on shared fields."""
        status = self.status()
        merged: dict = {}
        with self._lock:
            for driver in self._drivers:
                if status[driver.name]["state"] == OK:
                    merged.update(self._values[driver.name])
        return EnvironmentReading(**merged, t=round(self._clock(), 2))

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._loop, name="wallhack-sensors", daemon=True)
            self._thread.start()

    def _loop(self) -> None:
        while not self._stop.wait(HUB_TICK_S):
            self.poll_once()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)


def build_hub(config: Config, serial_factory=SerialTransport, i2c_factory=Smbus2Transport) -> EnvironmentHub:
    """Create drivers for config.sensors. A sensor that cannot be opened is reported as an error
    in the hub status (with the reason) instead of stopping the app."""
    drivers: List[SensorDriver] = []
    failed: Dict[str, str] = {}
    bus = None
    for name in config.sensor_names():
        try:
            if name in ("scd4x", "ens160", "mlx90614"):
                bus = bus or i2c_factory(config.i2c_bus)
                drivers.append({"scd4x": Scd4x, "ens160": Ens160, "mlx90614": Mlx90614}[name](bus))
            elif name == "pms5003":
                drivers.append(Pms5003(serial_factory(config.serial_pms)))
            else:
                drivers.append(Ze08Ch2o(serial_factory(config.serial_hcho)))
        except (SensorError, OSError) as exc:
            failed[name] = f"{type(exc).__name__}: {exc}"
            log.warning("sensor %s unavailable: %s", name, failed[name])
    return EnvironmentHub(drivers, failed=failed)
