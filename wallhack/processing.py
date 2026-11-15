"""Pure signal processing: RSSI streams in, presence/motion/breathing estimates out.

Time comes from sample timestamps only, so results are deterministic for a given input.
"""
from collections import deque
from dataclasses import dataclass, field
from typing import Deque, Dict, List, Optional

import numpy as np

GRID_HZ = 10.0                 # uniform resampling rate for analysis
BREATH_WINDOW_S = 30.0         # history used for the breathing FFT
MOTION_WINDOW_S = 3.0          # history used for the motion metric
MIN_BREATH_SPAN_S = 15.0       # minimum history before estimating breathing
BREATH_BAND_HZ = (0.1, 0.5)    # 6-30 breaths per minute
BREATH_PEAK_RATIO = 10.0       # peak power / off-peak band power needed to accept a peak
BREATH_MIN_AMPLITUDE_DB = 0.25  # peak amplitude floor, rejects flat noise
MIN_BREATH_SAMPLE_HZ = 4.0     # raw samples per second needed; band edge 0.5 Hz is Nyquist at 1 Hz
QUANTISATION_STEP_DB = 0.5     # readings that are all multiples of this are too coarse for breathing
MOTION_ENTER = 1.4             # std of first difference (dB per grid step) to enter motion
MOTION_EXIT_FACTOR = 0.7
ENTER_HOLD = 3                 # consecutive evaluations before a state turns on
EXIT_HOLD = 15                 # consecutive evaluations before a state turns off
MAX_SPAN_S = BREATH_WINDOW_S + 5.0


class Hysteresis:
    """Boolean state with separate enter/exit conditions and hold counts."""

    def __init__(self, enter_hold: int = ENTER_HOLD, exit_hold: int = EXIT_HOLD):
        self.state = False
        self._enter_hold = enter_hold
        self._exit_hold = exit_hold
        self._count = 0

    def update(self, wants_on: bool, wants_off: bool) -> bool:
        """wants_on: strong evidence for on. wants_off: strong evidence for off."""
        if not self.state:
            self._count = self._count + 1 if wants_on else 0
            if self._count >= self._enter_hold:
                self.state, self._count = True, 0
        else:
            self._count = self._count + 1 if wants_off else 0
            if self._count >= self._exit_hold:
                self.state, self._count = False, 0
        return self.state


def resample(times: np.ndarray, values: np.ndarray, hz: float = GRID_HZ):
    """Linear interpolation onto a uniform grid ending at the last timestamp."""
    if len(times) < 2 or times[-1] - times[0] <= 0:
        return np.array([]), np.array([])
    n = int((times[-1] - times[0]) * hz) + 1
    grid = times[-1] - np.arange(n)[::-1] / hz
    return grid, np.interp(grid, times, values)


def motion_metric(values: np.ndarray) -> float:
    """Std of the first difference on the uniform grid. Insensitive to slow drift and breathing."""
    if len(values) < 5:
        return 0.0
    return float(np.std(np.diff(values)))


def breathing_supported(times: np.ndarray, values: np.ndarray) -> bool:
    """False when raw data cannot carry breathing: sampled too slowly or quantised to whole steps.

    Judged on the raw (not resampled) readings, because interpolation invents in-between samples.
    """
    if len(times) < 2 or times[-1] - times[0] <= 0:
        return True  # not enough data to judge yet; estimate_breathing needs its own minimum span
    rate = (len(times) - 1) / (times[-1] - times[0])
    if rate < MIN_BREATH_SAMPLE_HZ:
        return False
    steps = values / QUANTISATION_STEP_DB
    return not bool(np.all(np.abs(steps - np.round(steps)) < 1e-6))


def estimate_breathing(values: np.ndarray, hz: float = GRID_HZ):
    """Return (bpm or None, peak_ratio) from a uniformly sampled series via FFT."""
    n = len(values)
    if n < int(MIN_BREATH_SPAN_S * hz):
        return None, 0.0
    x = values - np.mean(values)
    x = x - np.polyval(np.polyfit(np.arange(n), x, 1), np.arange(n))  # remove linear drift
    window = np.hanning(n)
    spec = np.abs(np.fft.rfft(x * window)) ** 2
    freqs = np.fft.rfftfreq(n, 1.0 / hz)
    band = (freqs >= BREATH_BAND_HZ[0]) & (freqs <= BREATH_BAND_HZ[1])
    if band.sum() < 3:
        return None, 0.0
    band_power = spec[band]
    idx = int(np.argmax(band_power))
    # noise floor: band mean excluding the peak's main lobe (Hann leaks into +/-2 bins)
    mask = np.ones(len(band_power), dtype=bool)
    mask[max(0, idx - 2):idx + 3] = False
    if mask.sum() < 3:
        return None, 0.0
    mean_power = float(np.mean(band_power[mask]))
    if mean_power <= 0:
        return None, 0.0
    ratio = float(band_power[idx] / mean_power)
    # amplitude of a sinusoid from windowed spectrum: 2*|X| / sum(window)
    amplitude = 2.0 * np.sqrt(band_power[idx]) / float(np.sum(window))
    if ratio < BREATH_PEAK_RATIO or amplitude < BREATH_MIN_AMPLITUDE_DB:
        return None, ratio
    # parabolic interpolation around the peak for sub-bin accuracy
    k = int(np.flatnonzero(band)[idx])
    f = freqs[k]
    if 0 < k < len(spec) - 1:
        a, b, c = np.log(spec[k - 1] + 1e-12), np.log(spec[k] + 1e-12), np.log(spec[k + 1] + 1e-12)
        denom = a - 2 * b + c
        if denom != 0:
            f = freqs[k] + 0.5 * (a - c) / denom * (freqs[1] - freqs[0])
    return float(f * 60.0), ratio


@dataclass
class LinkState:
    link_id: str
    zone: str
    rssi: float = 0.0
    motion_value: float = 0.0
    motion: bool = False
    breathing_bpm: Optional[float] = None
    breathing_ratio: float = 0.0
    presence: bool = False
    breathing_supported: bool = True
    samples_seen: int = 0

    def as_dict(self) -> dict:
        return {
            "link": self.link_id, "zone": self.zone, "rssi": round(self.rssi, 2),
            "motion_value": round(self.motion_value, 3), "motion": self.motion,
            "breathing_bpm": None if self.breathing_bpm is None else round(self.breathing_bpm, 1),
            "presence": self.presence, "breathing_supported": self.breathing_supported, "samples": self.samples_seen,
        }


class LinkProcessor:
    """Tracks one link (transmitter/receiver pair)."""

    def __init__(self, link_id: str, zone: str, sensitivity: float = 1.0):
        self.state = LinkState(link_id, zone)
        self.sensitivity = sensitivity
        self._t: Deque[float] = deque()
        self._v: Deque[float] = deque()
        self._motion_h = Hysteresis()
        self._presence_h = Hysteresis()
        self._breath_h = Hysteresis(enter_hold=5, exit_hold=30)
        self._last_bpm: Optional[float] = None

    def update(self, t: float, rssi: float) -> LinkState:
        self._t.append(t)
        self._v.append(rssi)
        while self._t and t - self._t[0] > MAX_SPAN_S:
            self._t.popleft()
            self._v.popleft()
        s = self.state
        s.rssi = rssi
        s.samples_seen += 1
        times, vals = np.asarray(self._t), np.asarray(self._v)
        grid, series = resample(times, vals)
        if len(series) == 0:
            return s
        recent = series[-int(MOTION_WINDOW_S * GRID_HZ) - 1:]
        s.motion_value = motion_metric(recent)
        enter = MOTION_ENTER / self.sensitivity
        s.motion = self._motion_h.update(s.motion_value > enter,
                                         s.motion_value < enter * MOTION_EXIT_FACTOR)
        # Breathing analysis is only meaningful while the subject is not moving much.
        s.breathing_supported = breathing_supported(times, vals)
        if s.breathing_supported:
            bpm, ratio = estimate_breathing(series[-int(BREATH_WINDOW_S * GRID_HZ):])
        else:
            bpm, ratio = None, 0.0
        s.breathing_ratio = ratio
        has_breath = bpm is not None and not s.motion
        if has_breath:
            self._last_bpm = bpm
        breathing = self._breath_h.update(has_breath, bpm is None and not s.motion)
        s.breathing_bpm = self._last_bpm if breathing else None
        s.presence = self._presence_h.update(s.motion or breathing, not s.motion and not breathing)
        return s


@dataclass
class Event:
    t: float
    kind: str
    zone: str
    detail: str = ""

    def as_dict(self) -> dict:
        return {"t": round(self.t, 2), "kind": self.kind, "zone": self.zone, "detail": self.detail}


class SensingEngine:
    """Aggregates links into zones and an overall status; records an event timeline."""

    def __init__(self, sensitivity: float = 1.0, max_events: int = 500):
        self.sensitivity = sensitivity
        self.links: Dict[str, LinkProcessor] = {}
        self.events: Deque[Event] = deque(maxlen=max_events)
        self._prev_zone: Dict[str, dict] = {}
        self.last_t = 0.0

    def feed(self, t: float, link_id: str, zone: str, rssi: float) -> None:
        proc = self.links.get(link_id)
        if proc is None:
            proc = self.links[link_id] = LinkProcessor(link_id, zone, self.sensitivity)
        proc.update(t, rssi)
        self.last_t = max(self.last_t, t)
        self._record_events(t, zone)

    def zones(self) -> Dict[str, dict]:
        out: Dict[str, dict] = {}
        for proc in self.links.values():
            s = proc.state
            z = out.setdefault(s.zone, {"zone": s.zone, "presence": False, "motion": False,
                                        "breathing_bpm": None, "links": 0, "_bpms": []})
            z["links"] += 1
            z["presence"] |= s.presence
            z["motion"] |= s.motion
            if s.breathing_bpm is not None:
                z["_bpms"].append(s.breathing_bpm)
        for z in out.values():
            bpms = z.pop("_bpms")
            z["breathing_bpm"] = round(float(np.median(bpms)), 1) if bpms else None
        return out

    def summary(self) -> dict:
        zones = self.zones().values()
        bpms = [z["breathing_bpm"] for z in zones if z["breathing_bpm"] is not None]
        return {
            "presence": any(z["presence"] for z in zones),
            "motion": any(z["motion"] for z in zones),
            "breathing_bpm": round(float(np.median(bpms)), 1) if bpms else None,
            "breathing_supported": not self.links or any(p.state.breathing_supported for p in self.links.values()),
        }

    def link_states(self) -> List[dict]:
        return [p.state.as_dict() for p in self.links.values()]

    def _record_events(self, t: float, zone: str) -> None:
        cur = self.zones().get(zone)
        if cur is None:
            return
        prev = self._prev_zone.get(zone, {"presence": False, "motion": False, "breathing_bpm": None})
        if cur["presence"] != prev["presence"]:
            self.events.append(Event(t, "presence_start" if cur["presence"] else "presence_end", zone))
        if cur["motion"] != prev["motion"]:
            self.events.append(Event(t, "motion_start" if cur["motion"] else "motion_end", zone))
        if (cur["breathing_bpm"] is None) != (prev["breathing_bpm"] is None):
            if cur["breathing_bpm"] is not None:
                self.events.append(Event(t, "breathing_detected", zone, f"{cur['breathing_bpm']} bpm"))
            else:
                self.events.append(Event(t, "breathing_lost", zone))
        self._prev_zone[zone] = {k: cur[k] for k in ("presence", "motion", "breathing_bpm")}
