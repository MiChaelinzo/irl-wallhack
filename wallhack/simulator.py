"""Deterministic multi-link RSSI simulator with scripted scenarios.

Same seed + scenario + parameters => identical samples.
"""
import math
import random
from dataclasses import dataclass
from typing import Callable, Dict, List, Tuple

from .environment import EnvironmentReading

SAMPLE_HZ = 10.0
SCENARIOS = ("empty", "walking", "breathing", "two_zones", "demo")

# link id -> (zone, baseline rssi dBm)
LINKS: Dict[str, Tuple[str, float]] = {
    "router-a": ("living_room", -48.0),
    "router-b": ("living_room", -55.0),
    "repeater": ("bedroom", -61.0),
}
NOISE_SIGMA = 0.5
WALK_AMPLITUDE = 4.0
WALK_FREQS_HZ = (0.7, 1.1, 1.7)
BREATH_AMPLITUDE = 1.0
HEART_AMPLITUDE = 0.5          # dB; exaggerated vs real CSI so the demo shows a clear peak
DEFAULT_HEART_BPM = 68.0

# (duration seconds, {zone: activity}); activity in empty|walking|breathing
DEMO_SCRIPT: List[Tuple[float, Dict[str, str]]] = [
    (30.0, {"living_room": "empty", "bedroom": "empty"}),
    (25.0, {"living_room": "walking", "bedroom": "empty"}),
    (50.0, {"living_room": "breathing", "bedroom": "empty"}),
    (40.0, {"living_room": "empty", "bedroom": "breathing"}),
]


@dataclass
class SimSample:
    t: float
    link: str
    zone: str
    rssi: float


class Simulator:
    def __init__(self, seed: int = 42, scenario: str = "demo", breaths_per_min: float = 15.0,
                 heart_beats_per_min: float = DEFAULT_HEART_BPM):
        if scenario not in SCENARIOS:
            raise ValueError(f"unknown scenario {scenario!r}; choose from {SCENARIOS}")
        self.seed, self.scenario, self.bpm = seed, scenario, breaths_per_min
        self.heart_bpm = heart_beats_per_min
        self._rng = random.Random(seed)
        self._step = 0
        # fixed per-link phase offsets so the signal does not depend on call batching
        self._phase = {l: [self._rng.uniform(0, 2 * math.pi) for _ in WALK_FREQS_HZ + (0, 0)]
                       for l in LINKS}

    def activity(self, t: float) -> Dict[str, str]:
        zones = {z for z, _ in LINKS.values()}
        if self.scenario == "empty":
            return {z: "empty" for z in zones}
        if self.scenario == "walking":
            return {z: ("walking" if z == "living_room" else "empty") for z in zones}
        if self.scenario == "breathing":
            return {z: ("breathing" if z == "living_room" else "empty") for z in zones}
        if self.scenario == "two_zones":
            return {"living_room": "walking", "bedroom": "breathing"}
        total = sum(d for d, _ in DEMO_SCRIPT)
        t = t % total
        for dur, act in DEMO_SCRIPT:
            if t < dur:
                return act
            t -= dur
        return DEMO_SCRIPT[-1][1]

    def truth(self, t: float) -> dict:
        act = self.activity(t)
        return {"activity": act,
                "presence": any(a != "empty" for a in act.values()),
                "motion": any(a == "walking" for a in act.values()),
                "breathing_bpm": self.bpm if any(a == "breathing" for a in act.values()) else None,
                "heart_bpm": self.heart_bpm if any(a == "breathing" for a in act.values()) else None}

    def next_samples(self, n: int = 1) -> List[SimSample]:
        out: List[SimSample] = []
        for _ in range(n):
            t = self._step / SAMPLE_HZ
            self._step += 1
            act = self.activity(t)
            for link, (zone, base) in LINKS.items():
                v = base + self._rng.gauss(0.0, NOISE_SIGMA)
                a = act[zone]
                ph = self._phase[link]
                if a == "walking":
                    for i, f in enumerate(WALK_FREQS_HZ):
                        v += WALK_AMPLITUDE / 1.5 * math.sin(2 * math.pi * f * t + ph[i])
                elif a == "breathing":
                    v += BREATH_AMPLITUDE * math.sin(2 * math.pi * (self.bpm / 60.0) * t + ph[-2])
                    v += HEART_AMPLITUDE * math.sin(2 * math.pi * (self.heart_bpm / 60.0) * t + ph[-1])
                out.append(SimSample(round(t, 3), link, zone, round(v, 2)))
        return out


# ---- simulated environment ---------------------------------------------------
ENV_STEP_S = 1.0               # fixed integration step, so output depends only on t and the seed
ROOM_ZONE = "living_room"      # occupancy of this zone drives CO2, VOC and surface temperature
CO2_OUTDOOR_PPM, CO2_OCCUPIED_PPM, CO2_TAU_S = 450.0, 1400.0, 120.0
TVOC_EMPTY_PPB, TVOC_OCCUPIED_PPB = 60.0, 240.0
HCHO_PPB = 25.0
PM25_BASE, PM25_SPIKE = 6.0, 95.0          # ug/m3; the spike mimics cooking smoke
PM_TAU_S = 15.0
PM_SPIKE_WINDOW_S = (60.0, 80.0)           # seconds into each demo loop
PM1_PER_PM25, PM10_PER_PM25, PM10_OFFSET = 0.6, 1.4, 2.0
TEMP_BASE_C, TEMP_SWING_C, TEMP_PERIOD_S = 22.0, 1.0, 600.0
HUMIDITY_BASE, HUMIDITY_SWING, HUMIDITY_PERIOD_S = 45.0, 5.0, 420.0
SKIN_SURFACE_C = 33.0                      # infrared surface temperature of a person in view
SENSOR_NOISE = {"co2": 8.0, "pm25": 0.4, "tvoc": 6.0, "hcho": 1.0, "temp": 0.05, "humidity": 0.2}


class SimulatedEnvironment:
    """Deterministic fake environment sensors. Every reading is flagged simulated=True.

    State relaxes toward targets in fixed ENV_STEP_S steps, so the output for a given time depends
    only on the seed and the occupancy function, not on how often it is read.
    """

    def __init__(self, occupied: Callable[[float], bool], seed: int = 42):
        self._occupied = occupied
        self._rng = random.Random(seed + 1)
        self._phase = (self._rng.uniform(0, 2 * math.pi), self._rng.uniform(0, 2 * math.pi))
        self._step = 0
        self._co2, self._tvoc, self._pm25 = CO2_OUTDOOR_PPM, TVOC_EMPTY_PPB, PM25_BASE
        self._surface = TEMP_BASE_C
        self._noise = {k: 0.0 for k in SENSOR_NOISE}

    def _relax(self, value: float, target: float, tau: float) -> float:
        return value + (target - value) * (1.0 - math.exp(-ENV_STEP_S / tau))

    def _advance(self) -> None:
        t = self._step * ENV_STEP_S
        self._step += 1
        occupied = self._occupied(t)
        loop_t = t % sum(d for d, _ in DEMO_SCRIPT)
        spike = PM_SPIKE_WINDOW_S[0] <= loop_t < PM_SPIKE_WINDOW_S[1]
        self._co2 = self._relax(self._co2, CO2_OCCUPIED_PPM if occupied else CO2_OUTDOOR_PPM, CO2_TAU_S)
        self._tvoc = self._relax(self._tvoc, TVOC_OCCUPIED_PPB if occupied else TVOC_EMPTY_PPB, CO2_TAU_S)
        self._pm25 = self._relax(self._pm25, PM25_SPIKE if spike else PM25_BASE, PM_TAU_S)
        self._surface = self._relax(self._surface, SKIN_SURFACE_C if occupied
                                    else self._temperature(t), PM_TAU_S)
        self._noise = {k: self._rng.gauss(0.0, sigma) for k, sigma in SENSOR_NOISE.items()}

    def _temperature(self, t: float) -> float:
        return TEMP_BASE_C + TEMP_SWING_C * math.sin(2 * math.pi * t / TEMP_PERIOD_S + self._phase[0])

    def reading(self, t: float) -> EnvironmentReading:
        while self._step * ENV_STEP_S <= t:
            self._advance()
        n = self._noise
        pm25 = max(self._pm25 + n["pm25"], 0.0)
        humidity = HUMIDITY_BASE + HUMIDITY_SWING * math.sin(2 * math.pi * t / HUMIDITY_PERIOD_S + self._phase[1])
        return EnvironmentReading(
            pm1=round(pm25 * PM1_PER_PM25, 1), pm25=round(pm25, 1), pm10=round(pm25 * PM10_PER_PM25 + PM10_OFFSET, 1),
            co2=round(self._co2 + n["co2"]), temperature_c=round(self._temperature(t) + n["temp"], 2),
            humidity_pct=round(humidity + n["humidity"], 1), tvoc_ppb=round(max(self._tvoc + n["tvoc"], 0.0)),
            hcho_ppb=round(max(HCHO_PPB + n["hcho"], 0.0)), surface_temp_c=round(self._surface, 1),
            simulated=True, t=round(t, 2))
