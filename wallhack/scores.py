"""RF intelligence scores: five 0-100 gauges with a colour band and a trend.

Pure functions. Coverage comes from the RF model (an ESTIMATE); the others come from live readings.
Bands: green >= 75, yellow >= 50, red below. A score is None (grey band) when its data is missing.
"""
from typing import Dict, List, Optional

GREEN_MIN, YELLOW_MIN = 75.0, 50.0
TREND_MARK_S = 10.0              # minimum spacing between stored trend reference values
TREND_DEADBAND = 3.0              # points of change that still count as "flat"
RSSI_WORST_DBM, RSSI_BEST_DBM = -90.0, -40.0
STATUS_POINTS = {"Healthy": 100.0, "Warning": 60.0, "Danger": 20.0}
STALE_AFTER_S = 10.0
SIMULATED_HARDWARE_SCORE = 50.0   # no real hardware: clearly not green
SCORE_IDS = ("coverage", "signal_health", "environment", "occupancy_confidence", "hardware_status")
LABELS = {"coverage": "Coverage", "signal_health": "Signal Health", "environment": "Environment",
          "occupancy_confidence": "Occupancy Confidence", "hardware_status": "Hardware Status"}


def band(value: Optional[float]) -> str:
    if value is None:
        return "grey"
    return "green" if value >= GREEN_MIN else "yellow" if value >= YELLOW_MIN else "red"


def trend(value: Optional[float], previous: Optional[float]) -> Optional[str]:
    if value is None or previous is None:
        return None
    delta = value - previous
    return "up" if delta > TREND_DEADBAND else "down" if delta < -TREND_DEADBAND else "flat"


def _clamp(v: float) -> float:
    return max(0.0, min(100.0, v))


def signal_health(links: List[dict]) -> Optional[float]:
    if not links:
        return None
    span = RSSI_BEST_DBM - RSSI_WORST_DBM
    return round(sum(_clamp((l["rssi"] - RSSI_WORST_DBM) / span * 100.0) for l in links) / len(links), 1)


def environment_score(env_status: Optional[dict]) -> Optional[float]:
    points = [STATUS_POINTS[m["status"]] for m in (env_status or {}).values() if m]
    if not points:
        return None
    return round(0.5 * sum(points) / len(points) + 0.5 * min(points), 1)


def occupancy_confidence(links: List[dict]) -> Optional[float]:
    """Share of links that agree with the majority on present/absent."""
    if not links:
        return None
    present = sum(1 for l in links if l["presence"])
    return round(100.0 * max(present, len(links) - present) / len(links), 1)


def hardware_status(source: str, collectors: List[str], stale_s: float, sensors: Dict[str, dict]) -> dict:
    """(value, detail) for the capture hardware."""
    if source != "real":
        return {"value": SIMULATED_HARDWARE_SCORE, "detail": "Simulated data. No capture hardware in use."}
    if not collectors:
        return {"value": 0.0, "detail": "No collector is running."}
    value, detail = 100.0, f"{len(collectors)} collector(s) running."
    if stale_s > STALE_AFTER_S:
        value, detail = 30.0, f"No new readings for {int(stale_s)} s."
    bad = [n for n, s in sensors.items() if s.get("state") not in ("ok", None)]
    if bad:
        value = max(0.0, value - 20.0 * len(bad))
        detail += " Sensor issues: " + ", ".join(sorted(bad)) + "."
    return {"value": value, "detail": detail}


def compute_scores(status: dict, coverage_pct: Optional[float], links: List[dict],
                   previous: Optional[Dict[str, Optional[float]]] = None) -> List[dict]:
    """The five scores. `previous` maps score id to an earlier value for the trend arrow."""
    env = status.get("environment") or {}
    hw = hardware_status(status["source"], status["collectors"], status.get("stale_s", 0.0), env.get("sensors") or {})
    details = {
        "coverage": "Model estimate from the digital twin, not a measurement.",
        "signal_health": "Average link strength from -90 dBm (0) to -40 dBm (100).",
        "environment": "Worst and average Healthy/Warning/Danger air status.",
        "occupancy_confidence": "How many links agree on present or absent.",
        "hardware_status": hw["detail"],
    }
    values = {"coverage": coverage_pct, "signal_health": signal_health(links),
              "environment": environment_score(env.get("status")),
              "occupancy_confidence": occupancy_confidence(links), "hardware_status": hw["value"]}
    previous = previous or {}
    return [{"id": i, "label": LABELS[i], "value": values[i], "band": band(values[i]),
             "trend": trend(values[i], previous.get(i)), "detail": details[i]} for i in SCORE_IDS]
