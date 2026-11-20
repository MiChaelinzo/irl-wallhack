#!/usr/bin/env python3
"""Build the static, simulated demo site (for Vercel or any static host).

The recording is produced by the real Python Runtime (Simulator, SensingEngine and the simulated
environment), one frame per WebSocket tick, so the hosted demo shows genuine pipeline output and
no processing logic is ported to JavaScript. The output is deterministic: the same arguments give
byte-identical files. Needs numpy (used by SensingEngine) but not fastapi or uvicorn.

    python3 tools/build_demo.py [--seed 7] [--scenario demo] [--seconds 145] [--out dist]
"""
import argparse
import json
import logging
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from wallhack.config import Config  # noqa: E402
from wallhack.runtime import Runtime  # noqa: E402
from wallhack.simulator import SAMPLE_HZ  # noqa: E402

STATIC = ROOT / "wallhack" / "static"
ASSETS = ("style.css", "view3d.js", "app.js", "demo.js")
TICK_S = 0.5                       # matches WS_INTERVAL_S in wallhack/app.py
REPLAY_NOTE = "Simulated replay recorded from the Wallhack simulator. Nothing here reads your WiFi."
EVENTS_PER_FRAME = 20              # matches the live /ws payload


def record(seed: int, scenario: str, seconds: float) -> dict:
    """Run the real runtime and capture the same payload the /ws endpoint sends each tick."""
    logging.getLogger("wallhack").setLevel(logging.ERROR)  # the runtime warns that data is simulated
    rt = Runtime(Config(source="simulator", scenario=scenario, seed=seed, background=False))
    per_tick = int(round(TICK_S * SAMPLE_HZ))
    frames = []
    last_seq = 0
    for _ in range(int(round(seconds / TICK_S))):
        rt.step_sim(per_tick)
        status = rt.status()
        status["note"] = REPLAY_NOTE
        new = [s for s in rt.samples if s["seq"] > last_seq]
        if new:
            last_seq = new[-1]["seq"]
        events = [e.as_dict() for e in list(rt.engine.events)[-EVENTS_PER_FRAME:]][::-1]
        frames.append({"status": status, "zones": list(rt.engine.zones().values()),
                       "links": rt.engine.link_states(), "samples": new, "events": events})
    return {"meta": {"seed": seed, "scenario": scenario, "seconds": seconds, "tick_s": TICK_S,
                     "simulated": True, "generator": "tools/build_demo.py"},
            "settings": rt.settings(), "frames": frames}


def static_index() -> str:
    """index.html with relative asset paths (a static host may serve it from a sub-path) and the
    demo script loaded first so it can mark the page as a replay."""
    html = (STATIC / "index.html").read_text(encoding="utf-8")
    html = html.replace('href="/static/', 'href="').replace('src="/static/', 'src="')
    marker = '<script src="view3d.js"></script>'
    if marker not in html:
        raise SystemExit("index.html no longer loads view3d.js; update tools/build_demo.py")
    return html.replace(marker, '<script src="demo.js"></script>\n' + marker)


def build(out: Path, seed: int, scenario: str, seconds: float) -> None:
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    (out / "index.html").write_text(static_index(), encoding="utf-8")
    for name in ASSETS:
        shutil.copyfile(STATIC / name, out / name)
    data = json.dumps(record(seed, scenario, seconds), sort_keys=True, separators=(",", ":"))
    (out / "recording.json").write_text(data + "\n", encoding="utf-8")
    leftovers = re.findall(r'(?:src|href)="/[^"]*"', (out / "index.html").read_text(encoding="utf-8"))
    if leftovers:
        raise SystemExit("absolute asset paths left in index.html: %s" % leftovers)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--scenario", default="demo")
    ap.add_argument("--seconds", type=float, default=145.0, help="one full loop of the demo script")
    ap.add_argument("--out", default="dist")
    args = ap.parse_args()
    out = Path(args.out)
    out = out if out.is_absolute() else ROOT / out
    build(out, args.seed, args.scenario, args.seconds)
    print("wrote %s (%d bytes recording)" % (out, (out / "recording.json").stat().st_size))
    return 0


if __name__ == "__main__":
    sys.exit(main())
