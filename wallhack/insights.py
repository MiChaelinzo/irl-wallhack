"""Deterministic insight rules over history, environment status and the digital twin.

This engine is the source of truth for every finding. An optional LLM (llm.py) may only rephrase
these findings; it never produces or changes them. Same inputs always give the same findings.
"""
import math
from typing import Dict, List, Optional

from . import rfmodel

LABEL = "Deterministic rules. No AI involved unless you explicitly ask for an LLM explanation."
SEVERITIES = ("info", "warning", "danger")
MIN_ROWS = 6                       # history rows needed before trend rules run
BASELINE_FRACTION = 0.2            # first 20 % of the session is the signal baseline
RECENT_FRACTION = 0.1              # last 10 % is "now"
SIGNAL_DROP_WARN_PCT, SIGNAL_DROP_DANGER_PCT = 10.0, 20.0
OCCUPANCY_TREND_DELTA = 0.25       # change in occupied fraction between halves that counts as a trend
AP_WALL_LOSS_WARN_DB = 8.0         # wall attenuation between an AP and an RSSI sensor
COVERAGE_TARGET_PCT = 90.0
RELOCATION_STEP_M = 1.0
RELOCATION_CELL_M = 1.0
MIN_RELOCATION_GAIN_PCT = 3.0


def _finding(fid: str, severity: str, title: str, detail: str, recommendation: str = "", **evidence) -> dict:
    return {"id": fid, "severity": severity, "title": title, "detail": detail,
            "recommendation": recommendation, "evidence": evidence}


def _mean(values: List[float]) -> Optional[float]:
    return sum(values) / len(values) if values else None


def _column(rows: List[dict], key: str) -> List[float]:
    return [r[key] for r in rows if r.get(key) is not None]


def signal_drop(rows: List[dict]) -> Optional[dict]:
    sig = _column(rows, "signal_dbm")
    if len(sig) < MIN_ROWS:
        return None
    n_base = max(3, int(len(sig) * BASELINE_FRACTION))
    n_now = max(3, int(len(sig) * RECENT_FRACTION))
    base, now = _mean(sig[:n_base]), _mean(sig[-n_now:])
    drop_pct = 100.0 * (base - now) / abs(base) if base else 0.0
    if drop_pct < SIGNAL_DROP_WARN_PCT:
        return None
    severity = "danger" if drop_pct >= SIGNAL_DROP_DANGER_PCT else "warning"
    return _finding("signal_drop", severity, "Signal strength dropped",
                    f"Average signal fell {drop_pct:.0f} % from {base:.1f} dBm to {now:.1f} dBm this session.",
                    "Check for new obstacles, a moved router or interference, then recalibrate.",
                    baseline_dbm=round(base, 1), recent_dbm=round(now, 1), drop_pct=round(drop_pct, 1))


def occupancy_trend(rows: List[dict]) -> Optional[dict]:
    occ = _column(rows, "occupancy")
    if len(occ) < MIN_ROWS:
        return None
    half = len(occ) // 2
    first, second = _mean(occ[:half]), _mean(occ[half:])
    delta = second - first
    if abs(delta) < OCCUPANCY_TREND_DELTA:
        return None
    direction = "rising" if delta > 0 else "falling"
    return _finding("occupancy_trend", "info", f"Occupancy is {direction}",
                    f"The space was occupied {first * 100:.0f} % of the time in the first half of the session "
                    f"and {second * 100:.0f} % in the second half.",
                    "", first_half_pct=round(first * 100, 1), second_half_pct=round(second * 100, 1))


def air_findings(env_status: Optional[dict]) -> List[dict]:
    """Threshold findings for CO2, PM2.5 and humidity from the latest Healthy/Warning/Danger statuses."""
    if not env_status:
        return []
    advice = {
        "co2": ("High CO2", "Open a window or ventilate the room."),
        "pm25": ("High PM2.5 particles", "Ventilate or run an air purifier, and check for smoke or cooking."),
        "humidity": ("Humidity out of comfort range", "Use a humidifier or dehumidifier, or ventilate."),
    }
    out = []
    for metric, (title, rec) in advice.items():
        m = env_status.get(metric)
        if m and m["status"] != "Healthy":
            out.append(_finding(f"air_{metric}", "danger" if m["status"] == "Danger" else "warning", title,
                                f"{metric.upper() if metric != 'humidity' else 'Humidity'} is {m['value']} {m['unit']} "
                                f"({m['status']}).", rec, value=m["value"], status=m["status"]))
    return out


def ap_attenuation(twin: dict) -> List[dict]:
    """Walls between each AP and each RSSI sensor on the same floor, from the RF model."""
    out = []
    for floor in twin["floors"]:
        for ap in floor["aps"]:
            for s in floor["sensors"]:
                if s["kind"] != "rssi":
                    continue
                loss = rfmodel.wall_loss_db(floor, ap["x"], ap["y"], s["x"], s["y"])
                if loss >= AP_WALL_LOSS_WARN_DB:
                    out.append(_finding(
                        f"ap_attenuation_{ap['id']}_{s['id']}", "warning", "Walls weaken the access point",
                        f"Walls between access point {ap['id']} and sensor {s['id']} on {floor['name']} are "
                        f"estimated to cost {loss:.0f} dB (model estimate).",
                        "Move the access point closer to the sensor or into the same room.",
                        ap=ap["id"], sensor=s["id"], floor=floor["id"], wall_loss_db=round(loss, 1)))
    return out


def best_relocation(twin: dict, floor: dict, ap: dict) -> Optional[dict]:
    """Grid search for the AP position on its floor with the best estimated coverage (deterministic)."""
    others = [(a, floor) for a in floor["aps"] if a["id"] != ap["id"]]
    best = None
    steps_x = int(floor["width_m"] // RELOCATION_STEP_M)
    steps_y = int(floor["depth_m"] // RELOCATION_STEP_M)
    for ix in range(steps_x + 1):
        for iy in range(steps_y + 1):
            cand = dict(ap, x=min(ix * RELOCATION_STEP_M + 0.5, floor["width_m"]),
                        y=min(iy * RELOCATION_STEP_M + 0.5, floor["depth_m"]))
            grid = rfmodel.coverage_grid(twin, floor["id"], RELOCATION_CELL_M, others + [(cand, floor)])
            key = (grid["coverage_pct"], -cand["x"], -cand["y"])
            if best is None or key > best[0]:
                best = (key, cand, grid["coverage_pct"])
    return {"x": best[1]["x"], "y": best[1]["y"], "coverage_pct": best[2]} if best else None


def coverage_findings(twin: dict) -> List[dict]:
    out = []
    for floor in twin["floors"]:
        if not floor["aps"]:
            continue
        current = rfmodel.coverage_grid(twin, floor["id"], RELOCATION_CELL_M)["coverage_pct"]
        if current >= COVERAGE_TARGET_PCT:
            continue
        # Only APs on this floor are candidates for moving.
        ap = floor["aps"][0]
        move = best_relocation(twin, floor, ap)
        rec = "Add an access point or repeater."
        if move and move["coverage_pct"] - current >= MIN_RELOCATION_GAIN_PCT:
            rec = (f"Move access point {ap['id']} to about x={move['x']:.1f} m, y={move['y']:.1f} m "
                   f"(estimated coverage {current:.0f} % to {move['coverage_pct']:.0f} %).")
        out.append(_finding(f"coverage_{floor['id']}", "warning", f"Weak WiFi coverage on {floor['name']}",
                            f"Estimated coverage is {current:.0f} % (target {COVERAGE_TARGET_PCT:.0f} %). "
                            "This is a model estimate, not a measurement.", rec,
                            floor=floor["id"], coverage_pct=current))
    return out


def build_insights(rows: List[dict], env_status: Optional[dict], twin: dict) -> List[dict]:
    """All findings, ordered by severity (danger first) then id, so the output is stable."""
    found = [f for f in (signal_drop(rows), occupancy_trend(rows)) if f]
    found += air_findings(env_status) + ap_attenuation(twin) + coverage_findings(twin)
    return sorted(found, key=lambda f: (-SEVERITIES.index(f["severity"]), f["id"]))
