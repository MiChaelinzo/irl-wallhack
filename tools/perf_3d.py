#!/usr/bin/env python3
"""Measure the planner 3D view in headless Chromium (software GL, SwiftShader here): script size, tab open time and frame time
of the WebGL renderer and of the canvas projection fallback. Prints a markdown table for docs/platform/adr-3d-view.md.
Needs playwright (pip install playwright && playwright install chromium). Usage: tools/perf_3d.py [--frames 60]
Frame times are CPU wall time including a one-pixel readback so the GPU work is counted; they are not a Raspberry Pi 4 figure."""
import argparse
import gzip
import json
import subprocess
import sys
import time
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent.parent
PORT = 8766

JS = """async (frames) => {
  const a = window.PlannerApp, lib = await (await fetch(a.assetUrl('scenarios.json'))).json();
  const p = JSON.parse(JSON.stringify(lib.scenarios.find(s => s.id === 'large_home').project));
  a.loadProject(p); await a.whenIdle();
  const t0 = performance.now(); document.getElementById('tab-view3d').click();
  while (!/^Ready/.test(document.getElementById('view3dMsg').textContent)) { await new Promise(r => setTimeout(r, 10)); }
  const open = performance.now() - t0, v = a.view3d.state, out = {open_ms: open, renderer: v.renderer.kind, quads: v.scene.quads.length, lines: v.scene.lines.length};
  const times = [];
  for (let i = 0; i < frames; i++) {
    v.cam.yaw += 0.05; const t = performance.now(); v.renderer.draw(v.scene, v.cam); if (v.renderer.finish) { v.renderer.finish(); } times.push(performance.now() - t);
  }
  times.sort((x, y) => x - y); out.median_ms = times[Math.floor(times.length / 2)]; out.p95_ms = times[Math.floor(times.length * 0.95)];
  return out; }"""

# Signal waves: requestAnimationFrame intervals with the waves on, per quality level (html[data-quality] from common.js), large_home preset.
# The page cannot run faster than the 60 Hz display clock, so the interval median is about 16.7 ms when the draw cost is small; the draw
# cost itself is the mean of the 20 draw times that planner-quick.js keeps for its own frame budget (read before they are cleared).
WAVES_JS = """async (args) => {
  const a = window.PlannerApp, lib = await (await fetch(a.assetUrl('scenarios.json'))).json();
  a.loadProject(JSON.parse(JSON.stringify(lib.scenarios.find(s => s.id === 'large_home').project))); await a.whenIdle();
  document.documentElement.dataset.quality = args.quality;
  a.quick.setWaves(false);
  await new Promise(r => setTimeout(r, 1500));   // the quality switch restarts CSS blur and the particle layer; let it settle
  const sample = async () => {
    const gaps = []; let last = performance.now();
    for (let i = 0; i < args.frames; i++) { await new Promise(r => requestAnimationFrame(r)); const t = performance.now(); gaps.push(t - last); last = t; }
    gaps.sort((x, y) => x - y); return gaps;
  };
  const off = await sample();
  a.quick.setWaves(true);
  const w = a.quick.waves, costs = [], gaps = []; let last = performance.now();
  for (let i = 0; i < args.frames; i++) {
    await new Promise(r => requestAnimationFrame(r));
    const t = performance.now(); gaps.push(t - last); last = t;
    if (w.cost.length) { costs.push(w.cost.reduce((x, y) => x + y, 0) / w.cost.length); }
  }
  a.quick.setWaves(false);
  gaps.sort((x, y) => x - y); costs.sort((x, y) => x - y);
  return {off_median_ms: off[Math.floor(off.length / 2)], frame_median_ms: gaps[Math.floor(gaps.length / 2)], frame_p95_ms: gaps[Math.floor(gaps.length * 0.95)],
          draw_median_ms: costs.length ? costs[Math.floor(costs.length / 2)] : null, draw_max_ms: costs.length ? costs[costs.length - 1] : null}; }"""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--frames", type=int, default=60)
    args = ap.parse_args()
    from playwright.sync_api import sync_playwright
    static = ROOT / "wallhack" / "static"
    raw = (static / "planner-3d.js").read_bytes()
    print("planner-3d.js: %d B, %d B gzip" % (len(raw), len(gzip.compress(raw, 9))))
    server = subprocess.Popen([sys.executable, "-m", "wallhack", "--source", "simulator", "--seed", "7", "--scenario", "two_zones", "--port", str(PORT), "--no-browser"],
                              cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                urlopen("http://127.0.0.1:%d/api/status" % PORT).read()
                break
            except OSError:
                time.sleep(0.2)
        rows = []
        with sync_playwright() as p:
            browser = p.chromium.launch()
            for label, query in (("WebGL", ""), ("canvas projection", "?renderer=canvas2d")):
                page = browser.new_page(viewport={"width": 1400, "height": 900})
                page.goto("http://127.0.0.1:%d/planner%s" % (PORT, query))
                page.wait_for_function("window.PlannerApp && window.PlannerApp.ready", timeout=15000)
                r = page.evaluate(JS, args.frames)
                rows.append((label, r)); page.close()
            wave_rows = []
            for quality in ("low", "medium", "high"):
                page = browser.new_page(viewport={"width": 1400, "height": 900})
                page.goto("http://127.0.0.1:%d/planner" % PORT)
                page.wait_for_function("window.PlannerApp && window.PlannerApp.ready", timeout=15000)
                wave_rows.append((quality, page.evaluate(WAVES_JS, {"quality": quality, "frames": args.frames * 2})))
                page.close()
            browser.close()
        print("| Renderer | Tab open (ms) | Median frame (ms) | p95 frame (ms) | Quads | Lines |\n|---|---|---|---|---|---|")
        for label, r in rows:
            print("| %s | %.0f | %.1f | %.1f | %d | %d |" % (label, r["open_ms"], r["median_ms"], r["p95_ms"], r["quads"], r["lines"]))
        print(json.dumps({l: r for l, r in rows}))
        print("\n| Signal waves, quality | rAF interval, waves off (ms) | rAF interval median, waves on (ms) | rAF interval p95 (ms) | Draw cost median (ms) | Draw cost max (ms) |\n|---|---|---|---|---|---|")
        for quality, r in wave_rows:
            draw = "%.2f" % r["draw_median_ms"] if r["draw_median_ms"] is not None else "n/a"
            top = "%.2f" % r["draw_max_ms"] if r["draw_max_ms"] is not None else "n/a"
            print("| %s | %.1f | %.1f | %.1f | %s | %s |" % (quality, r["off_median_ms"], r["frame_median_ms"], r["frame_p95_ms"], draw, top))
    finally:
        server.terminate()
    return 0


if __name__ == "__main__":
    sys.exit(main())
