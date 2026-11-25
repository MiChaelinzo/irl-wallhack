#!/usr/bin/env python3
"""Load the dashboard (simulator mode) in headless Chromium and save the docs screenshots.

Writes docs/screenshot.png (desktop), docs/screenshot-3d.png (3D view close-up) and
docs/screenshot-mobile.png (phone width). Needs the optional `playwright` package and a browser:
pip install playwright && playwright install chromium
With --demo it serves the built static demo (run tools/build_demo.py first) and writes
docs/screenshot-demo.png instead (the other demo pages are only checked, their shots go to a temp folder); it also requires the replay banner.
Also captures the timeline, insights and game cards and the mobile companion and judge pages
(docs/screenshot-<name>.png), loading each page and checking it renders.
Also captures the RF planner (docs/screenshot-planner*.png: heat map with bands and contours, compare, analytics,
light theme, phone width; the --demo run adds a -demo suffix) and fails if the planner heat canvas is blank.
Also captures the Wi-Fi architect views (docs/screenshot-planner-quick|rooms|scorecard|assistant|mesh|timemachine|aurora.png).
Exits non-zero on a JS error, a missing SIMULATED label, or a blank 3D canvas.
"""
import argparse
import base64
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent.parent
PORT = 8765
DESKTOP = {"width": 1280, "height": 1000}
MOBILE = {"width": 390, "height": 844}
SETTLE_MS = 30000  # vitals need a full analysis window
DEMO_SETTLE_MS = 75000  # the demo script reaches a breathing person at 55 s, vitals follow
# Counts pixels that differ from the first pixel of the canvas, so an empty transparent canvas scores 0.
NON_BLANK_JS = """() => {
  const c = document.getElementById('room3d');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) { if (d[i] > 0) { n++; } }
  return n;
}"""
MIN_DRAWN_PIXELS = 500
CARDS = (("timeline", "#timelineCard"), ("insights", "#insightsCard"), ("game", "#gameCard"), ("pairing", "#pairCard"))
CANVAS_DRAWN_JS = """(id) => {
  const c = document.getElementById(id);
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) { if (d[i] > 0) { n++; } }
  return n;
}"""
MIN_JUDGE_ITEMS = 15
PAGE_SETTLE_MS = 4000


def capture_extras(browser, base, errors, problems, docs, pages, demo=False):
    """Cards of the dashboard plus the mobile and judge pages. `pages` maps names to relative URLs."""
    page = browser.new_page(viewport=DESKTOP)
    watch(page, errors)
    page.goto(base)
    page.click("#dismissPrivacy")
    page.wait_for_timeout(PAGE_SETTLE_MS)
    prefix = "screenshot-demo-" if demo else "screenshot-"
    for name, selector in CARDS:
        if not demo:     # the demo run only adds its own mobile and judge pages
            page.locator(selector).screenshot(path=str(docs / ("screenshot-%s.png" % name)))
    if not page.evaluate(CANVAS_DRAWN_JS, "gameCanvas"):
        problems.append("game canvas is blank")
    page.close()
    mobile = browser.new_page(viewport=MOBILE)
    watch(mobile, errors)
    mobile.goto(base + pages["mobile"])
    mobile.wait_for_function("document.getElementById('mConn').textContent.startsWith(%r)" % ("demo" if demo else "live"), timeout=15000)
    mobile.wait_for_timeout(PAGE_SETTLE_MS)
    if mobile.inner_text("#mBadge") not in ("Present", "Motion", "No presence"):
        problems.append("mobile page shows no occupancy")
    if not mobile.locator("#mSim:visible").count():
        problems.append("mobile page lacks the SIMULATED label")
    mobile.screenshot(path=str(docs / (prefix + "mobile-companion.png")), full_page=True)
    mobile.close()
    judge = browser.new_page(viewport=DESKTOP)
    watch(judge, errors)
    judge.goto(base + pages["judge"])
    judge.wait_for_selector(".judge-item", timeout=15000)
    count = judge.locator(".judge-item").count()
    if count < MIN_JUDGE_ITEMS:
        problems.append("judge page lists only %d items" % count)
    judge.screenshot(path=str(docs / (prefix + "judge.png")))
    judge.close()


PLANNER_PLAN = {"name": "Screenshot plan", "floors": [{
    "id": "g", "name": "Ground", "level": 0, "width_m": 30, "depth_m": 20,
    "rooms": [{"id": "west", "name": "West", "x": 0, "y": 0, "w": 15, "d": 20}, {"id": "east", "name": "East", "x": 15, "y": 0, "w": 15, "d": 20}],
    "walls": [{"id": "w1", "x1": 15, "y1": 0, "x2": 15, "y2": 20, "kind": "exterior"},
              {"id": "w2", "x1": 15, "y1": 9, "x2": 30, "y2": 9, "kind": "interior"},
              {"id": "w3", "x1": 0, "y1": 12, "x2": 8, "y2": 12, "kind": "interior"}],
    "aps": [{"id": "ap1", "x": 3, "y": 3, "tx_dbm": 8}]}]}
# The heat canvas is WebGL (no preserved drawing buffer), so the stage is screenshotted and its distinct
# colours (5 bits per channel) are counted: walls and a grid alone give a handful, a heat map gives many.
STAGE_COLOURS_JS = """(b64) => new Promise((resolve) => {
  const img = new Image();
  img.onload = () => {
    const t = document.createElement('canvas'); t.width = img.width; t.height = img.height;
    const x = t.getContext('2d'); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, t.width, t.height).data, seen = new Set();
    for (let i = 0; i < d.length; i += 4) { seen.add(((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3)); }
    resolve(seen.size);
  };
  img.src = 'data:image/png;base64,' + b64;
})"""
PLANNER_IDLE_JS = "() => window.PlannerApp.whenIdle().then(() => true)"
MIN_HEAT_COLOURS = 40


def planner_wait(page):
    page.wait_for_function("window.PlannerApp && window.PlannerApp.ready", timeout=15000)
    page.evaluate(PLANNER_IDLE_JS)
    page.wait_for_timeout(500)


def planner_tab(page, name):
    page.click("#tab-" + name)
    page.wait_for_selector("#panel-%s:not([hidden])" % name)


def planner_check(page, label, problems):
    colours = page.evaluate(STAGE_COLOURS_JS, base64.b64encode(page.locator("#stage").screenshot()).decode())
    if colours < MIN_HEAT_COLOURS:
        problems.append("planner heat map looks blank in %s (%d distinct colours)" % (label, colours))
    if not page.locator("#estimateLabel:visible").count():
        problems.append("planner lacks the MODEL ESTIMATE label in %s" % label)


def capture_planner(browser, base, errors, problems, docs, demo=False):
    """Planner heat map (bands, contours), analytics, compare, light theme and phone width."""
    url = base + ("planner.html" if demo else "planner")
    suffix = "-demo" if demo else ""
    page = browser.new_page(viewport=DESKTOP)
    watch(page, errors)
    page.on("dialog", lambda d: d.accept())
    page.goto(url)
    planner_wait(page)
    page.evaluate("(p) => window.PlannerApp.loadProject(p)", PLANNER_PLAN)
    planner_wait(page)
    page.click("#tgBands")
    page.wait_for_function("document.getElementById('tgBands').checked")
    page.wait_for_timeout(500)
    planner_check(page, "main", problems)
    page.screenshot(path=str(docs / ("screenshot-planner%s.png" % suffix)))
    planner_tab(page, "analytics")
    page.wait_for_function("window.PlannerApp.panels.state.analysis && window.PlannerApp.panels.state.analysis.floor === 'g'", timeout=15000)
    page.locator("#panel-analytics").screenshot(path=str(docs / ("screenshot-planner-analytics%s.png" % suffix)))
    planner_tab(page, "scenarios")
    page.fill("#scenarioName", "Before")
    page.click("#scenarioSave")
    planner_tab(page, "smart")
    page.click("#planRun")
    page.wait_for_selector("#recList li", timeout=60000)
    page.click("#planApplyAll")
    page.evaluate(PLANNER_IDLE_JS)
    planner_tab(page, "scenarios")
    page.select_option("#cmpA", "s1")
    page.select_option("#cmpB", "current")
    page.click("#cmpRun")
    page.wait_for_selector("#cmpOut table", timeout=60000)
    page.wait_for_selector("#cmpCanvasA", timeout=15000)
    page.wait_for_timeout(1500)
    page.locator("#panel-scenarios").screenshot(path=str(docs / ("screenshot-planner-compare%s.png" % suffix)))
    page.click("#themeBtn")
    page.evaluate(PLANNER_IDLE_JS)
    page.wait_for_timeout(500)
    planner_check(page, "light theme", problems)
    page.screenshot(path=str(docs / ("screenshot-planner-light%s.png" % suffix)))
    page.close()
    mobile = browser.new_page(viewport=MOBILE)
    watch(mobile, errors)
    mobile.goto(url)
    planner_wait(mobile)
    mobile.evaluate("(p) => window.PlannerApp.loadProject(p)", PLANNER_PLAN)
    planner_wait(mobile)
    planner_check(mobile, "phone width", problems)
    mobile.screenshot(path=str(docs / ("screenshot-planner-mobile%s.png" % suffix)))
    mobile.close()


def capture_architect(browser, base, errors, problems, docs, demo=False):
    """Wi-Fi architect views: quick start result (viewport), Rooms and gaming, Score card, Assistant, Mesh, Time Machine and the aurora palette with signal waves."""
    url = base + ("planner.html" if demo else "planner")
    suffix = "-demo" if demo else ""
    page = browser.new_page(viewport=DESKTOP)
    watch(page, errors)
    page.on("dialog", lambda d: d.accept())
    page.goto(url)
    planner_wait(page)
    page.wait_for_function("() => window.PlannerApp.quick && window.PlannerApp.quick.templatesReady", timeout=15000)
    page.select_option("#quickTemplate", "two_bedroom_condo")
    page.click("#quickAnalyse")
    page.wait_for_selector("#quickResult[data-ready=true]", timeout=60000)
    page.evaluate(PLANNER_IDLE_JS)
    page.wait_for_timeout(500)
    if not page.locator("#quickResult .q-grade").count():
        problems.append("quick start result has no grade")
    page.evaluate("() => window.scrollTo(0, 0)")
    page.wait_for_timeout(300)
    page.screenshot(path=str(docs / ("screenshot-planner-quick%s.png" % suffix)))
    planner_tab(page, "rooms")
    if not page.locator("#panel-rooms .room-card").count():
        problems.append("Rooms and gaming tab shows no room cards")
    page.locator("#panel-rooms").screenshot(path=str(docs / ("screenshot-planner-rooms%s.png" % suffix)))
    planner_tab(page, "scorecard")
    page.locator("#panel-scorecard").screenshot(path=str(docs / ("screenshot-planner-scorecard%s.png" % suffix)))
    planner_tab(page, "assistant")
    page.fill("#asstInput", "Why is my bedroom 2 WiFi slow?")
    page.click("#asstForm button[type=submit]")
    page.wait_for_function("() => /WiFi in Bedroom 2/.test(document.getElementById('asstAnswer').innerText)", timeout=15000)
    page.locator("#panel-assistant").screenshot(path=str(docs / ("screenshot-planner-assistant%s.png" % suffix)))
    # the condo is fully covered, so a mesh node adds nothing there; the small office has a gap that a node closes
    page.select_option("#quickTemplate", "small_office")
    before = page.evaluate("() => document.getElementById('quickResult').dataset.ms")
    page.click("#quickAnalyse")
    page.wait_for_function("(b) => document.getElementById('quickResult').dataset.ready === 'true' && document.getElementById('quickResult').dataset.ms !== b", arg=before, timeout=60000)
    page.evaluate(PLANNER_IDLE_JS)
    planner_tab(page, "mesh")
    page.click("#meshRun")
    page.wait_for_selector("#panel-mesh table", timeout=60000)
    page.locator("#panel-mesh").screenshot(path=str(docs / ("screenshot-planner-mesh%s.png" % suffix)))
    planner_tab(page, "timemachine")
    page.click("#tmRun")
    page.wait_for_selector("#tmOut table", timeout=60000)
    page.wait_for_timeout(500)
    page.locator("#panel-timemachine").screenshot(path=str(docs / ("screenshot-planner-timemachine%s.png" % suffix)))
    page.select_option("#paletteSel", "aurora")
    page.check("#tgWaves")
    page.evaluate(PLANNER_IDLE_JS)
    page.wait_for_timeout(1200)
    planner_check(page, "aurora palette", problems)
    page.locator("#stage").screenshot(path=str(docs / ("screenshot-planner-aurora%s.png" % suffix)))
    page.close()


def watch(page, errors):
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("response", lambda r: errors.append("HTTP %d %s" % (r.status, r.url)) if r.status >= 400 else None)


def open_page(browser, viewport, errors):
    page = browser.new_page(viewport=viewport)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto("http://127.0.0.1:%d/" % PORT)
    page.click("#dismissPrivacy")
    page.wait_for_function("document.getElementById('conn').textContent === 'live'", timeout=15000)
    page.wait_for_timeout(SETTLE_MS)
    return page


def check(page, problems, demo=False):
    if demo and "Simulated replay" not in page.inner_text("#demoBanner"):
        problems.append("replay banner missing")
    if not page.locator(".ribbon:visible").count():
        problems.append("no visible SIMULATED ribbon")
    if "SIMULATED" not in page.inner_text("#mode"):
        problems.append("mode chip is not SIMULATED")
    drawn = page.evaluate(NON_BLANK_JS)
    if drawn < MIN_DRAWN_PIXELS:
        problems.append("3D canvas looks blank (%d drawn pixels)" % drawn)
    print("mode chip:", page.inner_text("#mode"), "| badge:", page.inner_text("#badge"), "| 3D pixels:", drawn)


def main_demo() -> int:
    """Screenshot the static demo served from dist/ by a plain file server. Any request other than
    a static file (for example /api or /ws) would 404 and be reported as a failure."""
    from playwright.sync_api import sync_playwright

    if not (ROOT / "dist" / "index.html").is_file():
        print("FAIL: dist/ is missing, run python3 tools/build_demo.py first", file=sys.stderr)
        return 1
    server = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1",
                               "--directory", str(ROOT / "dist")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                urlopen("http://127.0.0.1:%d/recording.json" % PORT).read()
                break
            except OSError:
                time.sleep(0.2)
        errors, problems = [], []
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(viewport=DESKTOP)
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            page.on("response", lambda r: errors.append("HTTP %d %s" % (r.status, r.url)) if r.status >= 400 else None)
            page.goto("http://127.0.0.1:%d/" % PORT)
            page.click("#dismissPrivacy")
            page.wait_for_function("document.getElementById('conn').textContent === 'demo replay'", timeout=15000)
            page.wait_for_timeout(DEMO_SETTLE_MS)
            check(page, problems, demo=True)
            page.screenshot(path=str(ROOT / "docs" / "screenshot-demo.png"))
            page.close()
            # Only the demo hero shot is committed; the other demo pages are checks, not docs.
            scratch = Path(tempfile.gettempdir()) / "wallhack-demo-shots"
            scratch.mkdir(exist_ok=True)
            capture_extras(browser, "http://127.0.0.1:%d/" % PORT, errors, problems, scratch,
                           {"mobile": "mobile.html", "judge": "judge.html"}, demo=True)
            capture_planner(browser, "http://127.0.0.1:%d/" % PORT, errors, problems, scratch, demo=True)
            capture_architect(browser, "http://127.0.0.1:%d/" % PORT, errors, problems, scratch, demo=True)
            browser.close()
        for msg in errors + problems:
            print("FAIL:", msg, file=sys.stderr)
        return 1 if errors or problems else 0
    finally:
        server.terminate()


def main() -> int:
    from playwright.sync_api import sync_playwright

    server = subprocess.Popen([sys.executable, "-m", "wallhack", "--source", "simulator", "--seed", "7", "--scenario", "two_zones",
                               "--port", str(PORT), "--no-browser"], cwd=ROOT)
    try:
        for _ in range(50):
            try:
                urlopen("http://127.0.0.1:%d/api/status" % PORT).read()
                break
            except OSError:
                time.sleep(0.2)
        errors, problems = [], []
        docs = ROOT / "docs"
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = open_page(browser, DESKTOP, errors)
            check(page, problems)
            page.screenshot(path=str(docs / "screenshot.png"))
            page.locator("#room3d").screenshot(path=str(docs / "screenshot-3d.png"))
            page.close()
            mobile = open_page(browser, MOBILE, errors)
            check(mobile, problems)
            mobile.screenshot(path=str(docs / "screenshot-mobile.png"))
            mobile.close()
            capture_extras(browser, "http://127.0.0.1:%d/" % PORT, errors, problems, docs, {"mobile": "mobile", "judge": "judge"})
            capture_planner(browser, "http://127.0.0.1:%d/" % PORT, errors, problems, docs)
            capture_architect(browser, "http://127.0.0.1:%d/" % PORT, errors, problems, docs)
            browser.close()
        for msg in errors + problems:
            print("FAIL:", msg, file=sys.stderr)
        return 1 if errors or problems else 0
    finally:
        server.terminate()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--demo", action="store_true", help="screenshot the static demo in dist/")
    sys.exit(main_demo() if ap.parse_args().demo else main())
