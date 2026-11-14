"""Owns the sensing engine, the active data source (simulator or real collectors) and history."""
import logging
import threading
import time
from collections import deque
from typing import Deque, List, Optional

from .collectors import Collector, detect_collector
from .collectors.ping import PingCollector
from .collectors.udp_csi import UdpCsiCollector
from .config import Config
from .processing import SensingEngine
from .simulator import SAMPLE_HZ, SCENARIOS, Simulator

log = logging.getLogger("wallhack")
REAL_ZONE = "room"
HISTORY = 6000


class Runtime:
    def __init__(self, config: Config):
        self.config = config
        self.lock = threading.RLock()
        self.samples: Deque[dict] = deque(maxlen=HISTORY)
        self.seq = 0
        self.engine = SensingEngine(config.sensitivity)
        self.sim: Optional[Simulator] = None
        self.collectors: List[Collector] = []
        self.source = "simulator"
        self.note = ""
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._t0 = time.monotonic()
        self._sim_clock = time.monotonic()
        self.reconfigure()

    # ---- source selection -------------------------------------------------
    def _build_collectors(self) -> List[Collector]:
        cols: List[Collector] = []
        c = self.config
        if c.udp_port > 0:
            u = UdpCsiCollector(c.udp_host, c.udp_port)
            if u.available():
                cols.append(u)
            else:
                log.warning("UDP CSI port %s unavailable", c.udp_port)
        plat = detect_collector()
        if plat is not None:
            if hasattr(plat, "interface"):
                plat.interface = c.interface
            cols.append(plat)
        if c.ping_target:
            try:
                p = PingCollector(c.ping_target)
                if p.available():
                    cols.append(p)
            except ValueError as exc:
                log.warning("%s", exc)
        return cols

    def reconfigure(self) -> None:
        with self.lock:
            for col in self.collectors:
                col.close()
            self.collectors = []
            self.engine = SensingEngine(self.config.sensitivity)
            self.samples.clear()
            self.seq = 0
            self.sim = None
            self.note = ""
            if self.config.source in ("auto", "real"):
                cols = self._build_collectors()
                if cols and any(cols[i].poll() for i in range(len(cols))):
                    self.collectors, self.source = cols, "real"
                    self._t0 = time.monotonic()
                    log.info("Using real collectors: %s", ", ".join(c.name for c in cols))
                    return
                for col in cols:
                    col.close()
                self.note = ("No WiFi readings from this machine's tools; showing SIMULATED data. "
                             "Run with --source simulator to hide this message.")
                log.warning(self.note)
            self.source = "simulator"
            self.sim = Simulator(self.config.seed, self.config.scenario)
            self._sim_clock = time.monotonic()

    # ---- data flow --------------------------------------------------------
    def _ingest(self, t: float, link: str, zone: str, rssi: float) -> None:
        self.seq += 1
        self.samples.append({"seq": self.seq, "t": round(t, 3), "link": link, "zone": zone, "rssi": round(rssi, 2)})
        self.engine.feed(t, link, zone, rssi)

    def step_sim(self, n: int) -> None:
        """Advance the simulator by n time steps (used by the loop and by tests)."""
        with self.lock:
            if self.sim is None:
                return
            for s in self.sim.next_samples(n):
                self._ingest(s.t, s.link, s.zone, s.rssi)

    def poll_real(self) -> None:
        with self.lock:
            t = time.monotonic() - self._t0
            for col in self.collectors:
                for r in col.poll():
                    self._ingest(t, r.link, REAL_ZONE, r.rssi)

    def _loop(self) -> None:
        while not self._stop.wait(0.1 if self.source == "simulator" else self._real_interval()):
            try:
                if self.source == "simulator":
                    now = time.monotonic()
                    n = int((now - self._sim_clock) * SAMPLE_HZ)
                    if n > 0:
                        self._sim_clock += n / SAMPLE_HZ
                        self.step_sim(n)
                else:
                    self.poll_real()
            except Exception:  # keep the sensing loop alive, but never hide the cause
                log.exception("sensing loop error")

    def _real_interval(self) -> float:
        return min((c.interval_s for c in self.collectors), default=0.5)

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._loop, name="wallhack-sensing", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
        for col in self.collectors:
            col.close()

    # ---- settings & views ---------------------------------------------------
    def settings(self) -> dict:
        c = self.config
        return {"source": c.source, "scenario": c.scenario, "sensitivity": c.sensitivity,
                "scenarios": list(SCENARIOS), "sources": ["auto", "simulator", "real"]}

    def update_settings(self, source=None, scenario=None, sensitivity=None) -> None:
        with self.lock:
            new = Config(**{**self.config.__dict__})
            if source is not None:
                new.source = source
            if scenario is not None:
                if scenario not in SCENARIOS:
                    raise ValueError(f"scenario must be one of {SCENARIOS}")
                new.scenario = scenario
            if sensitivity is not None:
                new.sensitivity = sensitivity
            new.validate()
            self.config.source, self.config.scenario = new.source, new.scenario
            self.config.sensitivity = new.sensitivity
            self.reconfigure()

    def status(self) -> dict:
        with self.lock:
            out = {"source": self.source, "requested_source": self.config.source, "note": self.note,
                   **self.engine.summary(), "sensitivity": self.config.sensitivity,
                   "scenario": self.config.scenario if self.source == "simulator" else None,
                   "links": len(self.engine.links), "t": round(self.engine.last_t, 2),
                   "disclaimer": "Estimates from signal fluctuations. Not imaging; cannot see through walls."}
            if self.sim is not None:
                out["truth"] = self.sim.truth(self.engine.last_t)
            return out
