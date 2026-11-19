"""Owns the sensing engine, the active data source (simulator or real collectors) and history."""
import logging
import sqlite3
import threading
import time
from collections import deque
from pathlib import Path
from typing import Deque, List, Optional

from .collectors import Collector, NexmonCollector, detect_collector
from .collectors.ping import PingCollector
from .collectors.udp_csi import UdpCsiCollector
from .config import Config
from .environment import EnvironmentReading, environment_report, us_epa_aqi
from . import health, insights as insights_mod, llm, rfmodel, scores as scores_mod
from .history import History
from .processing import SensingEngine
from .twin import load_twin, save_twin
from .sensors.hub import EnvironmentHub, build_hub
from .simulator import ROOM_ZONE, SAMPLE_HZ, SCENARIOS, SimulatedEnvironment, Simulator

log = logging.getLogger("wallhack")
REAL_ZONE = "room"
HISTORY = 6000
STALE_AFTER_S = 10.0
SCORE_TREND_WINDOW_S = 60.0     # a score's trend compares against the value about this long ago
SCORE_COVERAGE_CELL_M = 1.0


class SourceUnavailableError(ValueError):
    """The explicitly requested data source produced no readings."""


class Runtime:
    def __init__(self, config: Config, history: Optional[History] = None):
        self.config = config
        self.lock = threading.RLock()          # guards engine, samples and status; held briefly
        self._source_lock = threading.Lock()   # serialises collector polling and reconfiguration
        self._generation = 0
        self._last_data = time.monotonic()
        self.samples: Deque[dict] = deque(maxlen=HISTORY)
        self.seq = 0
        self.engine = SensingEngine(config.sensitivity)
        self.sim: Optional[Simulator] = None
        self.sim_environment: Optional[SimulatedEnvironment] = None
        # Real sensors are opened once: reconfigure() runs on every settings change and must not
        # reopen serial ports. With no sensors configured and a real source, environment stays None.
        self.hub: Optional[EnvironmentHub] = build_hub(config) if config.sensor_names() else None
        self.twin = load_twin(config.data_dir)
        if history is None and config.history_enabled:
            history = History(str(Path(config.data_dir) / "history.db"), config.history_max_rows)
        self.history: Optional[History] = history
        self._history_t = float("-inf")
        self._score_marks: Deque[tuple] = deque(maxlen=64)   # (engine t, {score id: value})
        self._coverage_cache: Optional[tuple] = None          # (twin object, mean coverage %)
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
        nexmon_active = False
        if c.csi_source == "nexmon":
            nx = NexmonCollector(c.interface, c.csi_port)
            if nx.available():
                cols.append(nx)
                nexmon_active = True
            else:
                log.warning("csi_source is 'nexmon' but tcpdump was not found on PATH")
        if c.udp_port > 0:
            u = UdpCsiCollector(c.udp_host, c.udp_port, token=c.udp_token)
            if u.available():
                cols.append(u)
            else:
                log.warning("UDP CSI port %s unavailable", c.udp_port)
        # CSI mode owns wlan0 (monitor-like); the platform RSSI tools would get no data from it.
        plat = None if nexmon_active else detect_collector()
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
        """Rebuild the data source. Probing collectors can be slow, so it happens outside
        `self.lock` (which API readers use); only the final swap takes it."""
        with self._source_lock:
            for col in self.collectors:
                col.close()
            self.collectors = []
            error: Optional[str] = None
            cols: List[Collector] = []
            real = False
            if self.config.source in ("auto", "real"):
                cols = self._build_collectors()
                real = bool(cols) and any([c.poll() for c in cols])
                if not real:
                    for col in cols:
                        col.close()
                    cols = []
            with self.lock:
                self._generation += 1
                self.engine = SensingEngine(self.config.sensitivity)
                self.samples.clear()
                self.seq = 0
                self._history_t = float("-inf")
                if self.history is not None:
                    self.history.new_session()
                self.sim = None
                self.sim_environment = None
                self.note = ""
                self._last_data = time.monotonic()
                if real:
                    self.collectors, self.source = cols, "real"
                    self._t0 = time.monotonic()
                    log.info("Using real collectors: %s", ", ".join(c.name for c in cols))
                    return
                if self.config.source == "real":
                    error = ("source 'real' was requested but no WiFi readings are available from this "
                             "machine's tools. Check docs/hardware.md, or use --source auto/simulator.")
                    self.note = "Requested real data, but none is available. Showing SIMULATED data."
                else:
                    self.note = ("No WiFi readings from this machine's tools; showing SIMULATED data. "
                                 "Run with --source simulator to hide this message.")
                log.warning(self.note)
                self.source = "simulator"
                self.sim = Simulator(self.config.seed, self.config.scenario)
                sim = self.sim
                self.sim_environment = SimulatedEnvironment(
                    lambda t: sim.activity(t)[ROOM_ZONE] != "empty", self.config.seed)
                self._sim_clock = time.monotonic()
            if error:
                raise SourceUnavailableError(error)

    # ---- data flow --------------------------------------------------------
    def _ingest(self, t: float, link: str, zone: str, rssi: float) -> None:
        self.seq += 1
        self.samples.append({"seq": self.seq, "t": round(t, 3), "link": link, "zone": zone, "rssi": round(rssi, 2)})
        self.engine.feed(t, link, zone, rssi)
        if self.history is not None and t - self._history_t >= self.config.history_step_s:
            self._history_t = t
            self._record_history(t)

    def _environment_reading(self, t: float) -> Optional[EnvironmentReading]:
        if self.hub is not None:
            return self.hub.reading()
        if self.sim_environment is not None:
            return self.sim_environment.reading(t)
        return None

    def _record_history(self, t: float) -> None:
        summary = self.engine.summary()
        links = list(self.engine.links.values())
        env = self._environment_reading(t)
        aqi = us_epa_aqi(env.pm25, env.pm10) if env else None
        try:
            self.history.record(
                t, occupancy=summary["presence"], motion=summary["motion"],
                breathing_bpm=summary["breathing_bpm"], heart_bpm=summary["heart_bpm"],
                signal_dbm=sum(p.state.rssi for p in links) / len(links) if links else None,
                csi_trend=sum(p.state.motion_value for p in links) / len(links) if links else None,
                pm25=env.pm25 if env else None, co2=env.co2 if env else None,
                tvoc_ppb=env.tvoc_ppb if env else None, temperature_c=env.temperature_c if env else None,
                humidity_pct=env.humidity_pct if env else None, aqi=aqi["aqi"] if aqi else None)
        except sqlite3.Error:
            log.exception("could not write history row")

    def step_sim(self, n: int) -> None:
        """Advance the simulator by n time steps (used by the loop and by tests)."""
        with self.lock:
            if self.sim is None:
                return
            for s in self.sim.next_samples(n):
                self._ingest(s.t, s.link, s.zone, s.rssi)

    def poll_real(self) -> None:
        """Poll collectors without holding `self.lock`, then ingest the readings under it."""
        with self._source_lock:
            gen = self._generation
            batch = []
            for col in self.collectors:
                now = time.monotonic()
                batch.extend((r.t if r.t is not None else now, r) for r in col.poll())
        if not batch:
            return
        with self.lock:
            if gen != self._generation:
                return  # settings changed while polling; drop stale readings
            for mono, r in batch:
                self._ingest(max(mono - self._t0, 0.0), r.link, REAL_ZONE, r.rssi)
            self._last_data = time.monotonic()

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
        if self.hub is not None:
            self.hub.start()
        if self._thread is None:
            self._thread = threading.Thread(target=self._loop, name="wallhack-sensing", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self.hub is not None:
            self.hub.stop()
        if self._thread:
            self._thread.join(timeout=2)
        for col in self.collectors:
            col.close()
        if self.history is not None:
            self.history.close()

    # ---- settings & views ---------------------------------------------------
    def settings(self) -> dict:
        c = self.config
        return {"source": c.source, "scenario": c.scenario, "sensitivity": c.sensitivity,
                "scenarios": list(SCENARIOS), "sources": ["auto", "simulator", "real"]}

    def update_settings(self, source=None, scenario=None, sensitivity=None) -> None:
        with self.lock:
            old = Config(**{**self.config.__dict__})
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
        try:
            self.reconfigure()
        except SourceUnavailableError:
            with self.lock:
                self.config.source, self.config.scenario = old.source, old.scenario
                self.config.sensitivity = old.sensitivity
            try:
                self.reconfigure()
            except SourceUnavailableError:
                pass  # previous setting was also unavailable; runtime stays on the labelled simulator
            raise

    def get_twin(self) -> dict:
        with self.lock:
            return self.twin

    def set_twin(self, data) -> dict:
        """Validate, persist and activate a new building model. Raises TwinError when invalid."""
        saved = save_twin(self.config.data_dir, data)
        with self.lock:
            self.twin = saved
        return saved

    def health(self) -> dict:
        with self.lock:
            return health.health_report(self.vitals(), (self.environment() or {}).get("status"), self.source)

    def llm_info(self) -> dict:
        return llm.disclosure(self.config.llm_provider)

    def insights(self) -> dict:
        """Rule-based findings from this session's history, the air status and the twin."""
        with self.lock:
            rows = self.history.query(0.0, None, self.config.history_step_s) if self.history else []
            env = self.environment()
            twin = self.twin
        findings = insights_mod.build_insights(rows, (env or {}).get("status"), twin)
        return {"engine": "rules", "label": insights_mod.LABEL, "history_rows": len(rows),
                "insights": findings, "llm": self.llm_info()}

    def explain_insights(self, confirm_off_device: bool = False) -> dict:
        """LLM rewording of the current findings. Raises llm.LlmError when disabled or failing."""
        findings = self.insights()["insights"]
        c = self.config
        return llm.explain(findings, c.llm_provider, c.llm_model, c.llm_endpoint,
                           timeout_s=c.llm_timeout_s, confirm_off_device=confirm_off_device)

    def _twin_coverage_pct(self) -> Optional[float]:
        twin = self.twin
        if self._coverage_cache is None or self._coverage_cache[0] is not twin:
            pcts = [g["coverage_pct"] for g in rfmodel.twin_coverage(twin, SCORE_COVERAGE_CELL_M).values()]
            self._coverage_cache = (twin, round(sum(pcts) / len(pcts), 1) if pcts else None)
        return self._coverage_cache[1]

    def scores(self) -> List[dict]:
        """The five RF intelligence scores with trend against the value about a minute ago."""
        with self.lock:
            status = {"source": self.source, "collectors": [c.name for c in self.collectors],
                      "environment": self.environment()}
            if self.source == "real":
                status["stale_s"] = time.monotonic() - self._last_data
            now = self.engine.last_t
            while self._score_marks and self._score_marks[0][0] < now - SCORE_TREND_WINDOW_S:
                self._score_marks.popleft()
            previous = self._score_marks[0][1] if self._score_marks and self._score_marks[0][0] < now else None
            out = scores_mod.compute_scores(status, self._twin_coverage_pct(), self.engine.link_states(), previous)
            if not self._score_marks or now - self._score_marks[-1][0] >= scores_mod.TREND_MARK_S:
                self._score_marks.append((now, {s["id"]: s["value"] for s in out}))
            return out

    def calibrate(self) -> None:
        """Forget learned baselines and events so the next readings define "quiet".
        Sample history and sequence numbers are kept, so connected clients stay in sync."""
        with self.lock:
            self.engine = SensingEngine(self.config.sensitivity)

    def environment(self) -> Optional[dict]:
        """Environment report from real sensors, else the labelled simulation, else None."""
        with self.lock:
            if self.hub is not None:
                return {**environment_report(self.hub.reading()), "sensors": self.hub.status()}
            if self.sim_environment is not None:
                return {**environment_report(self.sim_environment.reading(self.engine.last_t)), "sensors": {}}
            return None

    def vitals(self) -> dict:
        with self.lock:
            summary = self.engine.summary()
            return {"heart_bpm": summary["heart_bpm"], "breathing_bpm": summary["breathing_bpm"],
                    "activity": summary["activity"], "heart_supported": summary["heart_supported"],
                    "simulated": self.source == "simulator"}

    def status(self) -> dict:
        with self.lock:
            out = {"source": self.source, "requested_source": self.config.source, "note": self.note,
                   **self.engine.summary(), "sensitivity": self.config.sensitivity,
                   "scenario": self.config.scenario if self.source == "simulator" else None,
                   "collectors": [c.name for c in self.collectors],
                   "links": len(self.engine.links), "t": round(self.engine.last_t, 2),
                   "vitals": self.vitals(), "environment": self.environment(),
                   "disclaimer": "Estimates from signal fluctuations. Not imaging; cannot see through walls."}
            if self.source == "real":
                idle = time.monotonic() - self._last_data
                out["stale_s"] = round(idle, 1)
                if idle > STALE_AFTER_S:
                    out["note"] = f"No new WiFi readings for {int(idle)} s. Values shown are the last known state."
                elif not out["breathing_supported"]:
                    out["note"] = ("Breathing is disabled: these readings are too slow or too coarse "
                                   "(needs 4+ readings per second, e.g. ESP32/Nexmon CSI).")
            if self.source == "real":
                failures = [f"{c.name}: {c.failure()}" for c in self.collectors if c.failure()]
                if failures:
                    out["note"] = "Capture stopped. " + "; ".join(failures)
            if self.sim is not None:
                out["truth"] = self.sim.truth(self.engine.last_t)
            return out
