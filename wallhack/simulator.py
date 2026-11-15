"""Deterministic multi-link RSSI simulator with scripted scenarios.

Same seed + scenario + parameters => identical samples.
"""
import math
import random
from dataclasses import dataclass
from typing import Dict, List, Tuple

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
    def __init__(self, seed: int = 42, scenario: str = "demo", breaths_per_min: float = 15.0):
        if scenario not in SCENARIOS:
            raise ValueError(f"unknown scenario {scenario!r}; choose from {SCENARIOS}")
        self.seed, self.scenario, self.bpm = seed, scenario, breaths_per_min
        self._rng = random.Random(seed)
        self._step = 0
        # fixed per-link phase offsets so the signal does not depend on call batching
        self._phase = {l: [self._rng.uniform(0, 2 * math.pi) for _ in WALK_FREQS_HZ + (0,)]
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
                "breathing_bpm": self.bpm if any(a == "breathing" for a in act.values()) else None}

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
                    v += BREATH_AMPLITUDE * math.sin(2 * math.pi * (self.bpm / 60.0) * t + ph[-1])
                out.append(SimSample(round(t, 3), link, zone, round(v, 2)))
        return out
