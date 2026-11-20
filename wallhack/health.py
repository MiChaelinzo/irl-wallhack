"""Health Mode data: what Wallhack can and cannot estimate. Not a medical device."""
from typing import Optional

DISCLAIMER = ("Wellness estimates from WiFi signal fluctuations. Not a medical device. "
              "Do not use it for diagnosis or emergencies.")
SUPPORTED = (
    {"id": "presence", "label": "Presence", "note": "Someone is in the monitored space."},
    {"id": "movement", "label": "Movement", "note": "Walking or large motion."},
    {"id": "breathing", "label": "Breathing rate", "note": "Experimental. Needs fast readings (CSI) and a still person."},
    {"id": "heart_rate", "label": "Heart rate", "note": "Experimental and often unreliable with WiFi."},
    {"id": "air_quality", "label": "Air quality", "note": "Needs environment sensors (or the simulator)."},
)
UNSUPPORTED = (
    {"id": "mood", "label": "Mood", "reason": "WiFi signals carry no emotional information."},
    {"id": "perspiration", "label": "Perspiration", "reason": "Not measurable from radio signal changes."},
    {"id": "thoughts", "label": "Thoughts", "reason": "Not possible. Nothing reads minds."},
    {"id": "through_wall_imaging", "label": "Through-wall camera-quality imaging",
     "reason": "Wallhack infers presence and motion from signal changes. It cannot form pictures."},
)


def health_report(vitals: dict, env_status: Optional[dict], source: str) -> dict:
    """Current wellness readings plus the explicit supported and unsupported lists."""
    return {"disclaimer": DISCLAIMER, "simulated": source == "simulator",
            "vitals": {"breathing_bpm": vitals["breathing_bpm"], "heart_bpm": vitals["heart_bpm"],
                       "heart_supported": vitals["heart_supported"], "activity": vitals["activity"]},
            "air": {k: v for k, v in (env_status or {}).items() if v},
            "supported": list(SUPPORTED), "unsupported": [dict(u, supported=False) for u in UNSUPPORTED]}
