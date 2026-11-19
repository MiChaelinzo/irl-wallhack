"""Judge mode data: what Wallhack does, with an honest status per item.

Single source for the judge page. Each item names the README verification table row that backs its
verification label (`evidence`), and tests/test_judge.py fails when the two disagree, so the page
cannot claim more than the table does.

Status: Built (works, in the labelled scope), Experimental (works but unproven on real hardware or
accuracy not established), Future (not built), Unsupported (not possible with WiFi signals).
Verification label: VERIFIED, PARTIALLY VERIFIED, UNVERIFIED, or NOT BUILT.
"""
BUILT, EXPERIMENTAL, FUTURE, UNSUPPORTED = "Built", "Experimental", "Future", "Unsupported"
STATUSES = (BUILT, EXPERIMENTAL, FUTURE, UNSUPPORTED)
LABELS = ("VERIFIED", "PARTIALLY VERIFIED", "UNVERIFIED", "NOT BUILT")


def _item(id, title, status, verification, detail, evidence, link=None):
    return {"id": id, "title": title, "status": status, "verification": verification,
            "detail": detail, "evidence": evidence, "link": link}


ITEMS = (
    _item("sensing", "Presence, motion and breathing from signal changes", BUILT, "VERIFIED",
          "Tested on synthetic and simulated signals only.", "End-to-end synthetic CSI to breathing rate", "/"),
    _item("twin", "3D digital twin with floors, rooms, openings, sensors, APs and designer", BUILT, "PARTIALLY VERIFIED",
          "Geometry and persistence are unit tested. The UI was only loaded in headless Chromium.",
          "Twin geometry helpers, panels, designer and game UI", "/#room3d"),
    _item("models", "RF coverage model, timeline history, rule-based insights, RF scores, air status", BUILT, "VERIFIED",
          "Tests use simulated data. Coverage is a textbook model, not a measurement.",
          "Twin validation and persistence, RF model determinism", "/#timelineCard"),
    _item("game", "Router placement game", BUILT, "VERIFIED",
          "JavaScript scoring equals the Python scoring on all 257 selections.",
          "Game scoring in JS", "/#gameCard"),
    _item("mobile", "Mobile companion with QR pairing (LAN mode, off by default)", BUILT, "PARTIALLY VERIFIED",
          "Token checks and the QR encoder are tested. Never tried from a real phone.",
          "Mobile companion page and phone pairing from a real phone", "/mobile"),
    _item("premium", "Premium UI: glass cards, glow, particles, depth blur", BUILT, "PARTIALLY VERIFIED",
          "Respects the quality setting and reduced motion. Looked at in headless Chromium only, never on a Pi 4.",
          "Premium UI effects", "/"),
    _item("demo", "Static simulated demo for Vercel", BUILT, "VERIFIED",
          "Builds deterministically and plays in headless Chromium. A real Vercel deployment is not tried.",
          "Static demo build", None),
    _item("heart", "Heart rate", EXPERIMENTAL, "UNVERIFIED",
          "Needs fast CSI. Accuracy on real signals is unknown.",
          "Heart rate and walking-cadence accuracy on **real** CSI", "/#vitalsCard"),
    _item("llm", "LLM explanations of insights", EXPERIMENTAL, "UNVERIFIED",
          "Off by default. Only tested against mock servers, never a real model. Rule findings are the source of truth.",
          "LLM providers (ollama, llama.cpp, OpenAI, Azure)", "/#insightsCard"),
    _item("notify", "Phone notifications for occupancy changes", EXPERIMENTAL, "UNVERIFIED",
          "Uses the browser Notification API, which many browsers block on plain http LAN addresses. The page also shows alerts in-page.",
          "Phone occupancy notifications", "/mobile"),
    _item("pi", "Real WiFi CSI on Raspberry Pi 4 and ESP32", EXPERIMENTAL, "UNVERIFIED",
          "No Pi 4 or ESP32 hardware was available. Parsers are tested on synthetic frames.",
          "Real collectors on Raspberry Pi 4", None),
    _item("sensors", "Environment sensors (PM, CO2, TVOC, temperature)", EXPERIMENTAL, "UNVERIFIED",
          "Drivers are tested with fakes. Real devices were never connected.",
          "Sensor drivers on real hardware", "/#envSection"),
    _item("automation", "Smart Home Automation (controlling devices)", FUTURE, "NOT BUILT",
          "Wallhack shows air-quality status cards. It does not control any device.",
          "Smart Home Automation and enterprise analytics"),
    _item("enterprise", "Enterprise analytics", FUTURE, "NOT BUILT",
          "No multi-site or fleet features exist.",
          "Smart Home Automation and enterprise analytics"),
    _item("mood", "Mood detection", UNSUPPORTED, "NOT BUILT",
          "No established way to infer it from WiFi.", "Mood, perspiration, thoughts, through-wall imaging"),
    _item("sweat", "Perspiration detection", UNSUPPORTED, "NOT BUILT",
          "Not measurable from radio signal changes.", "Mood, perspiration, thoughts, through-wall imaging"),
    _item("thoughts", "Reading thoughts", UNSUPPORTED, "NOT BUILT",
          "Not possible.", "Mood, perspiration, thoughts, through-wall imaging"),
    _item("imaging", "Through-wall camera-quality imaging", UNSUPPORTED, "NOT BUILT",
          "Signals give coarse presence and motion, never a picture.", "Mood, perspiration, thoughts, through-wall imaging"),
)

MODES = (
    {"label": "Dashboard", "href": "/"},
    {"label": "3D digital twin", "href": "/#room3d"},
    {"label": "Timeline playback", "href": "/#timelineCard"},
    {"label": "Insights copilot", "href": "/#insightsCard"},
    {"label": "Health mode", "href": "/#healthCard"},
    {"label": "Router placement game", "href": "/#gameCard"},
    {"label": "Mobile companion", "href": "/mobile"},
)


def judge_report() -> dict:
    return {"items": [dict(i) for i in ITEMS], "modes": [dict(m) for m in MODES], "statuses": list(STATUSES),
            "note": "Statuses are checked against the README verification table by the test suite. "
                    "Everything shown by default is simulated unless you attach real hardware."}
