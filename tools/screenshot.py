#!/usr/bin/env python3
"""Load the dashboard (simulator mode) in headless Chromium and save the docs screenshots.

Writes docs/screenshot.png (desktop), docs/screenshot-3d.png (3D view close-up) and
docs/screenshot-mobile.png (phone width). Needs the optional `playwright` package and a browser:
pip install playwright && playwright install chromium
With --demo it serves the built static demo (run tools/build_demo.py first) and writes
docs/screenshot-demo.png instead; it also requires the replay banner.
Exits non-zero on a JS error, a missing SIMULATED label, or a blank 3D canvas.
"""
import argparse
import subprocess
import sys
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
            page.screenshot(path=str(ROOT / "docs" / "screenshot-demo.png"), full_page=True)
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
            page.screenshot(path=str(docs / "screenshot.png"), full_page=True)
            page.locator("#room3d").screenshot(path=str(docs / "screenshot-3d.png"))
            page.close()
            mobile = open_page(browser, MOBILE, errors)
            check(mobile, problems)
            mobile.screenshot(path=str(docs / "screenshot-mobile.png"), full_page=True)
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
