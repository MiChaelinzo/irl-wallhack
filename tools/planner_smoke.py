#!/usr/bin/env python3
"""Drive the RF planner page (/planner) in headless Chromium and check the main interactions.

Draws a wall with the mouse, undoes and redoes it, drags an access point, loads a generated PNG as a floor
plan and calibrates its scale, checks the tooltip, keyboard probe, context menu and heat-map label, and
saves docs/screenshot-planner.png. Fails on any console error, page error or HTTP error.
Needs the optional `playwright` package and a browser: pip install playwright && playwright install chromium
Usage: tools/planner_smoke.py [--demo] [--canvas2d] [--no-worker] [--no-screenshot]
"""
import argparse
import struct
import subprocess
import sys
import tempfile
import time
import zlib
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent.parent
PORT = 8765
VIEWPORT = {"width": 1400, "height": 900}
IDLE_TIMEOUT_MS = 30000


def make_png(path: Path, w: int = 120, h: int = 80) -> None:
    """A small grey PNG with a dark rectangle, written without third-party libraries."""
    rows = b""
    for y in range(h):
        rows += b"\x00" + b"".join(b"\x20\x20\x20" if (10 <= x < 110 and (y in (10, 69) or (y > 10 and y < 69 and x in (10, 109)))) else b"\xc8\xc8\xc8" for x in range(w))

    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def wait_idle(page):
    return page.evaluate("() => window.PlannerApp.whenIdle().then(r => ({ms: r.stats.ms, cov: r.coverage_pct, dirty: r.stats.tiles_dirty, computed: r.stats.tiles_computed, total: r.stats.tiles_total}))")


def screen_of(page, x, y):
    return page.evaluate("([x, y]) => { const v = window.PlannerApp.editor.view, r = document.getElementById('cEdit').getBoundingClientRect(); return [r.left + v.ox + x * v.scale, r.top + v.oy + y * v.scale]; }", [x, y])


def run(page, base, problems, args):
    page.goto(base + ("planner.html" if args.demo else "planner"))
    page.wait_for_function("window.PlannerApp && window.PlannerApp.ready", timeout=15000)
    first = wait_idle(page)
    info = page.evaluate("() => ({kind: window.PlannerApp.renderer.kind, info: window.PlannerApp.rendererInfo, backend: window.PlannerApp.backend.kind})")
    print("renderer:", info, "| first compute:", first)
    if args.canvas2d and info["kind"] != "canvas2d":
        problems.append("canvas 2D renderer was requested but %s is used" % info["kind"])
    if args.no_worker and info["backend"] != "main":
        problems.append("main-thread fallback was requested but %s is used" % info["backend"])
    if not page.locator("#estimateLabel:visible").inner_text().startswith("MODEL ESTIMATE, not a measurement"):
        problems.append("heat map is not labelled MODEL ESTIMATE")
    if args.no_worker and not page.locator("#plannerNotice:visible").count():
        problems.append("no visible notice about the main-thread fallback")
    drawn = page.evaluate("() => { const c = document.getElementById('cHeat'); return c.width * c.height > 0; }")
    if not drawn:
        problems.append("heat canvas has no size")
    walls = lambda: page.evaluate("() => window.PlannerApp.store.project.floors.find(f => f.id === window.PlannerApp.store.floorId).walls.length")  # noqa: E731
    n0 = walls()
    # draw a wall by dragging
    page.click("[data-tool=wall]")
    a, b = screen_of(page, 2.0, 2.0), screen_of(page, 5.0, 2.0)
    page.mouse.move(*a); page.mouse.down(); page.mouse.move((a[0] + b[0]) / 2, a[1], steps=4); page.mouse.move(*b, steps=4); page.mouse.up()
    wait_idle(page)
    if walls() != n0 + 1:
        problems.append("dragging with the wall tool did not add a wall (%d -> %d)" % (n0, walls()))
    page.keyboard.press("Control+z")
    if walls() != n0:
        problems.append("undo did not remove the wall")
    page.keyboard.press("Control+Shift+z")
    if walls() != n0 + 1:
        problems.append("redo did not restore the wall")
    # move an access point and watch the worker recompute only part of the work
    page.click("[data-tool=select]")
    ap = page.evaluate("() => { const f = window.PlannerApp.store.project.floors.find(x => x.id === window.PlannerApp.store.floorId); return [f.aps[0].id, f.aps[0].x, f.aps[0].y]; }")
    start, end = screen_of(page, ap[1], ap[2]), screen_of(page, ap[1] + 1.5, ap[2] + 1.0)
    page.mouse.move(*start); page.mouse.down(); page.mouse.move(*end, steps=8); page.mouse.up()
    moved = wait_idle(page)
    now = page.evaluate("(id) => { const f = window.PlannerApp.store.project.floors.find(x => x.id === window.PlannerApp.store.floorId); const a = f.aps.find(x => x.id === id); return [a.x, a.y]; }", ap[0])
    if abs(now[0] - ap[1]) < 0.5 and abs(now[1] - ap[2]) < 0.5:
        problems.append("access point did not move")
    print("after AP move:", moved)
    # tooltip and keyboard probe
    target = screen_of(page, 3.0, 3.0)
    page.mouse.move(*target); page.mouse.move(target[0] + 3, target[1] + 3)
    page.wait_for_selector("#tip:not([hidden])", timeout=5000)
    tip = page.inner_text("#tip")
    for word in ("Signal", "Throughput", "Distance", "Obstructions", "MODEL ESTIMATE"):
        if word not in tip:
            problems.append("tooltip lacks %r: %r" % (word, tip))
    page.keyboard.press("Escape")
    page.focus("#cEdit"); page.keyboard.press("ArrowRight")
    if "dBm" not in page.inner_text("#status"):
        problems.append("keyboard probe did not announce a reading")
    # context menu
    page.mouse.click(*screen_of(page, 6.5, 6.5), button="right")
    if page.locator(".ctxmenu button").count() < 2:
        problems.append("context menu did not open")
    page.keyboard.press("Escape")
    # floor plan image and calibration
    with tempfile.TemporaryDirectory() as tmp:
        png = Path(tmp) / "plan.png"
        make_png(png)
        page.set_input_files("#imageFile", str(png))
        page.wait_for_function("() => window.PlannerApp.store.project.floors[0].background", timeout=5000)
    before = page.evaluate("() => window.PlannerApp.store.project.floors[0].scale_m_per_px")
    p1, p2 = screen_of(page, 1.0, 1.0), screen_of(page, 6.0, 1.0)
    page.mouse.click(*p1); page.mouse.click(*p2)
    page.wait_for_selector(".planner-input", timeout=3000)
    page.fill(".planner-input", "3"); page.keyboard.press("Enter")
    page.wait_for_timeout(200)
    after = page.evaluate("() => window.PlannerApp.store.project.floors[0].scale_m_per_px")
    if not before or abs(after / before - 3 / 5) > 0.01:
        problems.append("calibration did not scale as expected (%s -> %s)" % (before, after))
    page.keyboard.press("Control+z")   # calibration is undoable
    if abs(page.evaluate("() => window.PlannerApp.store.project.floors[0].scale_m_per_px") - before) > 1e-9:
        problems.append("undo did not restore the calibration")
    # theme
    page.click("#themeBtn")
    if page.evaluate("() => document.documentElement.getAttribute('data-theme')") != "light":
        problems.append("theme button did not switch to light")
    page.click("#themeBtn")
    page.click("#tgBands"); page.click("#tgBands")
    wait_idle(page)
    if not args.no_screenshot:
        page.screenshot(path=str(ROOT / "docs" / ("screenshot-planner-demo.png" if args.demo else "screenshot-planner.png")), full_page=True)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--demo", action="store_true", help="serve the built demo in dist/ instead of the live app")
    ap.add_argument("--canvas2d", action="store_true", help="force the canvas 2D renderer (?renderer=canvas2d)")
    ap.add_argument("--no-worker", action="store_true", help="force the main-thread fallback (?worker=0)")
    ap.add_argument("--no-screenshot", action="store_true")
    args = ap.parse_args()
    from playwright.sync_api import sync_playwright

    if args.demo:
        if not (ROOT / "dist" / "planner.html").is_file():
            print("FAIL: dist/planner.html missing, run python3 tools/build_demo.py first", file=sys.stderr)
            return 1
        server = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1", "--directory", str(ROOT / "dist")],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        probe = "http://127.0.0.1:%d/twin.json" % PORT
    else:
        server = subprocess.Popen([sys.executable, "-m", "wallhack", "--source", "simulator", "--seed", "7", "--scenario", "two_zones",
                                   "--port", str(PORT), "--no-browser"], cwd=ROOT)
        probe = "http://127.0.0.1:%d/api/status" % PORT
    try:
        for _ in range(50):
            try:
                urlopen(probe).read()
                break
            except OSError:
                time.sleep(0.2)
        errors, problems = [], []
        query = ("?renderer=canvas2d" if args.canvas2d else "") + (("&" if args.canvas2d else "?") + "worker=0" if args.no_worker else "")
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(viewport=VIEWPORT)
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            page.on("response", lambda r: errors.append("HTTP %d %s" % (r.status, r.url)) if r.status >= 400 else None)
            try:
                run(page, "http://127.0.0.1:%d/" % PORT, problems, args) if not query else run_query(page, query, problems, args)
            finally:
                browser.close()
        for msg in errors + problems:
            print("FAIL:", msg, file=sys.stderr)
        if not errors and not problems:
            print("planner smoke test passed")
        return 1 if errors or problems else 0
    finally:
        server.terminate()


def run_query(page, query, problems, args):
    """Same checks with a query string on the page URL."""
    original = page.goto
    page.goto = lambda url, **kw: original(url + query, **kw)
    run(page, "http://127.0.0.1:%d/" % PORT, problems, args)


if __name__ == "__main__":
    sys.exit(main())
