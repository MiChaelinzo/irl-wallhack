#!/usr/bin/env python3
"""Run axe-core in headless Chromium against the planner, the dashboard and the built demo.

DEV-ONLY. axe-core is fetched from npm into a temporary directory on every run (`npm pack axe-core`) and injected
with Playwright's add_script_tag, so it is never vendored or committed and the pages keep their strict CSP
(the page CSP of the live app is not set, but the Vercel demo's is, and the injection happens outside the page source).
Pages checked: /planner and / of the live app, then dist/index.html and dist/planner.html (run tools/build_demo.py first).
Exit code 1 when any serious or critical violation is found. Moderate and minor ones are listed but do not fail the run.
This is an automated check only. It cannot judge screen reader output, focus order quality or real devices.
Needs: `playwright` + Chromium, node and npm. Usage: tools/a11y_check.py [--json out.json] [--dark | --light]
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


def check_page(browser, url: str, axe_js: Path, ready: str, theme: str):
    page = browser.new_page(viewport=VIEWPORT)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(url)
    page.wait_for_function(ready, timeout=20000)
    if theme:
        page.evaluate("(t) => document.documentElement.setAttribute('data-theme', t)", theme)
    page.wait_for_timeout(800)
    page.add_script_tag(path=str(axe_js))
    result = page.evaluate("() => axe.run(document, { resultTypes: ['violations'] })")
    version = page.evaluate("() => axe.version")
    page.close()
    return result["violations"], version, errors


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--json", help="write the raw violations to this file")
    group = ap.add_mutually_exclusive_group()
    group.add_argument("--dark", action="store_true", help="force data-theme=dark (default theme otherwise)")
    group.add_argument("--light", action="store_true", help="force data-theme=light")
    args = ap.parse_args()
    from playwright.sync_api import sync_playwright

    theme = "dark" if args.dark else "light" if args.light else ""
    servers = [subprocess.Popen([sys.executable, "-m", "wallhack", "--source", "simulator", "--seed", "7", "--scenario", "two_zones", "--port", str(PORT), "--no-browser"],
                                cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)]
    targets = [("planner (live)", "http://127.0.0.1:%d/planner" % PORT, "window.PlannerApp && window.PlannerApp.ready"),
               ("dashboard (live)", "http://127.0.0.1:%d/" % PORT, "document.readyState === 'complete'")]
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
            for name, url, ready in targets:
                violations, version, errors = check_page(browser, url, axe_js, ready, theme)
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
