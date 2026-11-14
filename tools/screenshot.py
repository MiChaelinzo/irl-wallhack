#!/usr/bin/env python3
"""Load the dashboard (simulator mode) in headless Chromium and save docs/screenshot.png.

Needs the optional `playwright` package and a browser: pip install playwright && playwright install chromium
Exits non-zero if the page throws a JS error or the status badge never leaves its initial state.
"""
import subprocess
import sys
import time
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent.parent
PORT = 8765


def main() -> int:
    from playwright.sync_api import sync_playwright

    server = subprocess.Popen([sys.executable, "-m", "wallhack", "--source", "simulator", "--seed", "7",
                               "--port", str(PORT), "--no-browser"], cwd=ROOT)
    try:
        for _ in range(50):
            try:
                urlopen("http://127.0.0.1:%d/api/status" % PORT).read()
                break
            except OSError:
                time.sleep(0.2)
        errors = []
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(viewport={"width": 1280, "height": 1000})
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto("http://127.0.0.1:%d/" % PORT)
            page.click("#dismissPrivacy")
            page.wait_for_function("document.getElementById('conn').textContent === 'live'", timeout=15000)
            page.wait_for_timeout(8000)
            print("mode chip:", page.inner_text("#mode"), "| badge:", page.inner_text("#badge"))
            page.screenshot(path=str(ROOT / "docs" / "screenshot.png"), full_page=True)
            browser.close()
        if errors:
            print("JS errors:", errors, file=sys.stderr)
            return 1
        return 0
    finally:
        server.terminate()


if __name__ == "__main__":
    sys.exit(main())
