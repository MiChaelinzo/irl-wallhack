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
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from wallhack import game, judge, rfmodel  # noqa: E402
from wallhack.config import Config  # noqa: E402
from wallhack.history import History  # noqa: E402
from wallhack.runtime import WS_EVENTS_PER_FRAME as EVENTS_PER_FRAME, WS_TICK_S as TICK_S, Runtime  # noqa: E402
from wallhack.simulator import SAMPLE_HZ  # noqa: E402

STATIC = ROOT / "wallhack" / "static"
ASSETS = ("style.css", "common.js", "view3d.js", "app.js", "demo.js", "twin.js", "panels.js", "game.js", "mobile.js", "judge.js",
          "rf-engine.js", "rf-optimizer.js", "rf-insight.js", "rf-worker.js", "planner-panels.js", "planner-export.js", "planner-modes.js", "planner-learn.js", "planner-3d.js", "rf-config.json", "scenarios.json", "learn-content.json", "planner-state.js", "planner-editor.js", "planner-heat.js", "planner.js")
PAGES = {"index.html": '<script src="view3d.js"></script>', "mobile.html": '<script src="common.js"></script>',
         "judge.html": '<script src="common.js"></script>', "planner.html": '<script src="common.js"></script>'}   # page -> script tag demo.js is loaded before
REPLAY_NOTE = "Simulated replay recorded from the Wallhack simulator. Nothing here reads your WiFi."
SCORE_EVERY_TICKS = 20             # refresh trend reference values every 10 s of recording
DATA_FILES = ("recording.json", "history.json", "twin.json", "insights.json", "scores.json",
              "scenario.json", "health.json", "coverage.json", "judge.json")


def record(seed: int, scenario: str, seconds: float) -> dict:
    """Run the real runtime and capture what the live API serves: the /ws payload each tick, plus the
    whole-session history, the twin, the insights, the scores, the health data and the game scenario.
    Returns {file name: JSON-serialisable data}."""
    logging.getLogger("wallhack").setLevel(logging.ERROR)  # the runtime warns that data is simulated
    with tempfile.TemporaryDirectory() as data_dir:   # empty: never reads a developer's saved twin
        cfg = Config(source="simulator", scenario=scenario, seed=seed, background=False, data_dir=data_dir)
        rt = Runtime(cfg, history=History(":memory:", cfg.history_max_rows))
        per_tick = int(round(TICK_S * SAMPLE_HZ))
        frames = []
        last_seq = 0
        for tick in range(int(round(seconds / TICK_S))):
            rt.step_sim(per_tick)
            status = rt.status()
            status["note"] = REPLAY_NOTE
            new = [s for s in rt.samples if s["seq"] > last_seq]
            if new:
                last_seq = new[-1]["seq"]
            events = [e.as_dict() for e in list(rt.engine.events)[-EVENTS_PER_FRAME:]][::-1]
            frames.append({"status": status, "zones": list(rt.engine.zones().values()),
                           "links": rt.engine.link_states(), "samples": new, "events": events})
            if tick % SCORE_EVERY_TICKS == 0:
                rt.scores()
        meta = {"seed": seed, "scenario": scenario, "seconds": seconds, "tick_s": TICK_S,
                "simulated": True, "generator": "tools/build_demo.py"}
        return {
            "recording.json": {"meta": meta, "settings": rt.settings(), "frames": frames},
            "history.json": {"meta": meta, "step": cfg.history_step_s,
                             "rows": rt.history.query(0.0, None, cfg.history_step_s)},
            "twin.json": rt.get_twin(),
            "insights.json": {**rt.insights(), "meta": meta},
            "scores.json": {"scores": rt.scores(), "meta": meta},
            "health.json": {**rt.health(), "meta": meta},
            "scenario.json": game.build_scenario(),
            "coverage.json": rfmodel.twin_coverage(rt.get_twin()),
            "judge.json": judge.judge_report(),
        }


def static_page(name: str) -> str:
    """A page with relative asset paths (a static host may serve it from a sub-path) and the demo
    script loaded first so it can mark the page as a replay."""
    html = (STATIC / name).read_text(encoding="utf-8")
    html = html.replace('href="/static/', 'href="').replace('src="/static/', 'src="')
    marker = PAGES[name]
    if marker not in html:
        raise SystemExit("%s no longer loads %s; update tools/build_demo.py" % (name, marker))
    return html.replace(marker, '<script src="demo.js"></script>\n' + marker)


def build(out: Path, seed: int, scenario: str, seconds: float) -> None:
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    for page in PAGES:
        (out / page).write_text(static_page(page), encoding="utf-8")
    for name in ASSETS:
        shutil.copyfile(STATIC / name, out / name)
    for name, payload in record(seed, scenario, seconds).items():
        data = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        (out / name).write_text(data + "\n", encoding="utf-8")
    for page in PAGES:
        # links to other pages carry data-page and are rewritten by common.js; only assets must be relative
        leftovers = [m for m in re.findall(r'<(?:script|link)[^>]*(?:src|href)="/[^"]*"', (out / page).read_text(encoding="utf-8"))]
        if leftovers:
            raise SystemExit("absolute asset paths left in %s: %s" % (page, leftovers))


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
    print("wrote %s (%s)" % (out, ", ".join("%s %d B" % (n, (out / n).stat().st_size) for n in DATA_FILES)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
