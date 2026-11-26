#!/usr/bin/env python3
"""Run axe-core in headless Chromium against the planner, the dashboard and the built demo.

DEV-ONLY. axe-core is fetched from npm into a temporary directory on every run (`npm pack axe-core`) and injected
with Playwright's add_script_tag, so it is never vendored or committed and the pages keep their strict CSP
(the page CSP of the live app is not set, but the Vercel demo's is, and the injection happens outside the page source).
Pages checked: /planner, /, /judge and /mobile of the live app, then dist/index.html and dist/planner.html (run tools/build_demo.py first).
Also checks on the live planner: W selects the wall tool from the keyboard, the Tab focus ring is visible, and an
uncaught error appears in the alert live region (front-end error boundary in common.js).
Exit code 1 when any serious or critical violation is found. Moderate and minor ones are listed but do not fail the run.
This is an automated check only. It cannot judge screen reader output, focus order quality or real devices.
Needs: `playwright` + Chromium, node and npm. Usage: tools/a11y_check.py [--json out.json] [--dark | --light] [--contrast]
"""
import argparse
import json
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent.parent
PORT = 8766
DEMO_PORT = 8767
BLOCKING = ("serious", "critical")
VIEWPORT = {"width": 1400, "height": 900}
READY_TIMEOUT_MS = 8000   # the /mobile page waits for a websocket that may never connect; do not hang on it


def fetch_axe(tmp: Path) -> Path:
    """npm pack axe-core into tmp and return the path to axe.min.js."""
    subprocess.run(["npm", "pack", "axe-core", "--silent"], cwd=tmp, check=True, capture_output=True, text=True)
    tarball = next(tmp.glob("axe-core-*.tgz"))
    with tarfile.open(tarball) as tar:
        member = tar.getmember("package/axe.min.js")
        member.name = "axe.min.js"
        tar.extract(member, tmp)
    return tmp / "axe.min.js"


def wait_for(url: str) -> None:
    for _ in range(60):
        try:
            urlopen(url).read()
            return
        except OSError:
            time.sleep(0.2)
    raise SystemExit("FAIL: server did not start: " + url)


def check_page(browser, url: str, axe_js: Path, ready: str, theme: str, contrast: bool, tab: str = ""):
    from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

    page = browser.new_page(viewport=VIEWPORT)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(url)
    try:
        page.wait_for_function(ready, timeout=READY_TIMEOUT_MS)
    except PlaywrightTimeoutError:   # e.g. /mobile never gets a websocket: check the page as it is instead of hanging or aborting
        print("  note: ready condition not met in %d s for %s, running axe on the page as loaded" % (READY_TIMEOUT_MS // 1000, url))
    if tab in ("quick", "rooms", "scorecard", "assistant"):   # these need an analysis first so axe sees real content
        page.click("#quickAnalyse")
        page.wait_for_selector("#quickResult[data-ready=true]", timeout=30000)
    if tab and tab != "quick":   # open a planner tab first so axe sees its panel
        page.click("#tab-" + tab)
        page.wait_for_selector("#panel-%s:not([hidden])" % tab)
        if tab == "mesh":
            page.click("#meshRun"); page.wait_for_selector("#panel-mesh table", timeout=60000)
        if tab == "timemachine":
            page.click("#tmRun"); page.wait_for_selector("#tmOut table", timeout=60000)
        if tab == "view3d":
            page.wait_for_function("() => /^Ready/.test(document.getElementById('view3dMsg').textContent)", timeout=30000)
    if theme:
        page.evaluate("(t) => document.documentElement.setAttribute('data-theme', t)", theme)
    if contrast:
        page.evaluate("() => document.documentElement.setAttribute('data-contrast', 'more')")
    page.wait_for_timeout(800)
    page.add_script_tag(path=str(axe_js))
    result = page.evaluate("() => axe.run(document, { resultTypes: ['violations'] })")
    version = page.evaluate("() => axe.version")
    page.close()
    return result["violations"], version, errors


def behaviour_checks(browser, url: str) -> list:
    """Planner checks axe cannot do: keyboard tool shortcut, visible focus ring, error boundary live region."""
    page = browser.new_page(viewport=VIEWPORT)
    problems = []
    page.goto(url)
    page.wait_for_function("window.PlannerApp && window.PlannerApp.ready", timeout=20000)
    page.focus("#cEdit")
    page.keyboard.press("w")
    if page.get_attribute("[data-tool=wall]", "aria-pressed") != "true":
        problems.append("pressing W on the focused plan did not select the wall tool")
    page.keyboard.press("Escape")
    page.focus("#fitBtn")
    page.keyboard.press("Tab")
    outline = page.evaluate("() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2; }")
    if not outline:
        problems.append("the element focused with Tab has no visible outline of 2 px or more")
    page.evaluate("() => { setTimeout(() => { throw new Error('a11y check: deliberate error'); }, 0); }")
    page.wait_for_timeout(200)
    alert = page.evaluate("() => { const e = document.getElementById('plannerNotice'); return !e.hidden && e.getAttribute('role') === 'alert' && e.textContent.indexOf('deliberate error') >= 0; }")
    if not alert:
        problems.append("an uncaught error was not shown in the #plannerNotice alert region")
    page.close()
    return problems


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--json", help="write the raw violations to this file")
    group = ap.add_mutually_exclusive_group()
    group.add_argument("--dark", action="store_true", help="force data-theme=dark (default theme otherwise)")
    group.add_argument("--light", action="store_true", help="force data-theme=light")
    ap.add_argument("--contrast", action="store_true", help="also force the high contrast mode (data-contrast=more)")
    args = ap.parse_args()
    from playwright.sync_api import sync_playwright

    theme = "dark" if args.dark else "light" if args.light else ""
    servers = [subprocess.Popen([sys.executable, "-m", "wallhack", "--source", "simulator", "--seed", "7", "--scenario", "two_zones", "--port", str(PORT), "--no-browser"],
                                cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)]
    targets = [("planner (live)", "http://127.0.0.1:%d/planner" % PORT, "window.PlannerApp && window.PlannerApp.ready"),
               ("dashboard (live)", "http://127.0.0.1:%d/" % PORT, "document.readyState === 'complete'")]
    planner_ready = "window.PlannerApp && window.PlannerApp.ready"
    targets += [("planner 3D view tab (live)", targets[0][1], planner_ready, "view3d"),
                ("planner timeline tab (live)", targets[0][1], planner_ready, "twinlab"),
                ("planner beams tab (live)", targets[0][1], planner_ready, "beams"),
                ("planner Quick start result (live)", targets[0][1], planner_ready, "quick"),
                ("planner Rooms and gaming tab (live)", targets[0][1], planner_ready, "rooms"),
                ("planner Score card tab (live)", targets[0][1], planner_ready, "scorecard"),
                ("planner Assistant tab (live)", targets[0][1], planner_ready, "assistant"),
                ("planner Mesh tab (live)", targets[0][1], planner_ready, "mesh"),
                ("planner Time Machine tab (live)", targets[0][1], planner_ready, "timemachine"),
                ("judge (live)", "http://127.0.0.1:%d/judge" % PORT, "document.querySelectorAll('.judge-item').length > 0"),
                ("mobile companion (live)", "http://127.0.0.1:%d/mobile" % PORT, "document.getElementById('mConn').textContent !== 'connecting'")]
    if (ROOT / "dist" / "planner.html").is_file():
        servers.append(subprocess.Popen([sys.executable, "-m", "http.server", str(DEMO_PORT), "--bind", "127.0.0.1", "--directory", str(ROOT / "dist")],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        targets += [("planner (demo)", "http://127.0.0.1:%d/planner.html" % DEMO_PORT, "window.PlannerApp && window.PlannerApp.ready"),
                    ("dashboard (demo)", "http://127.0.0.1:%d/index.html" % DEMO_PORT, "document.readyState === 'complete'")]
    else:
        print("note: dist/ is missing, the demo pages are skipped (run tools/build_demo.py)")
    failed, report = False, {}
    try:
        wait_for("http://127.0.0.1:%d/api/status" % PORT)
        with tempfile.TemporaryDirectory() as tmp, sync_playwright() as p:
            axe_js = fetch_axe(Path(tmp))
            browser = p.chromium.launch()
            for name, url, ready, *tab in targets:
                violations, version, errors = check_page(browser, url, axe_js, ready, theme, args.contrast, tab[0] if tab else "")
                report[name] = violations
                blocking = [v for v in violations if v["impact"] in BLOCKING]
                print("%s (axe-core %s%s): %d violation(s), %d serious or critical" % (name, version, ", theme " + theme if theme else "", len(violations), len(blocking)))
                for v in violations:
                    print("  [%s] %s: %s (%d node(s))" % (v["impact"], v["id"], v["help"], len(v["nodes"])))
                    for n in v["nodes"][:3]:
                        print("      %s" % " ".join(n["target"][0:1]) if n["target"] else "")
                for e in errors:
                    print("  page error:", e)
                failed = failed or bool(blocking) or bool(errors)
            for problem in behaviour_checks(browser, targets[0][1]):
                print("  behaviour check failed:", problem)
                failed = True
            print("planner behaviour checks (keyboard shortcut, focus ring, error boundary) done")
            browser.close()
    finally:
        for s in servers:
            s.terminate()
    if args.json:
        Path(args.json).write_text(json.dumps(report, indent=1))
    print("FAIL: serious or critical violations remain" if failed else "no serious or critical violations")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
