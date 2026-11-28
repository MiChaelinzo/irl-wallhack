#!/usr/bin/env python3
"""Drive the RF planner page (/planner) in headless Chromium and check the main interactions.

Draws a wall with the mouse, undoes and redoes it, drags an access point, loads a generated PNG as a floor
plan and calibrates its scale, checks the tooltip, keyboard probe, context menu and heat-map label, and
saves the per-tab docs/screenshot-planner-<tab>.png shots (live run only; --demo and --canvas2d write to a temp folder). Fails on any console error, page error or HTTP error.
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


def docs_dir(args):
    """Only the live default run writes the committed docs/ screenshots. The demo and canvas2d
    runs are checks and write to a temp folder, so docs/ does not hold near-duplicate images."""
    if not (args.demo or args.canvas2d):
        return ROOT / "docs"
    path = Path(tempfile.gettempdir()) / "wallhack-smoke-shots"
    path.mkdir(exist_ok=True)
    return path
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
    page.evaluate("() => document.getElementById('cEdit').scrollIntoView({block: 'center', behavior: 'instant'})")   # the Quick start card sits above the stage
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
    run_features(page, problems)
    run_lab_features(page, problems, args)
    run_twin_lab_features(page, problems, args)
    run_view3d_features(page, problems, args)
    run_learn_features(page, problems, args)
    run_quick_features(page, problems, args)
    if not args.no_screenshot:
        page.screenshot(path=str(Path(tempfile.gettempdir()) / "wallhack-smoke-planner.png"))   # docs/screenshot-planner.png is owned by screenshot.py


SPARSE = {"name": "Smoke plan", "floors": [{
    "id": "g", "name": "Ground", "level": 0, "width_m": 30, "depth_m": 20,
    "rooms": [{"id": "west", "name": "West", "x": 0, "y": 0, "w": 15, "d": 20}, {"id": "east", "name": "East", "x": 15, "y": 0, "w": 15, "d": 20}],
    "walls": [{"id": "w1", "x1": 15, "y1": 0, "x2": 15, "y2": 20, "kind": "exterior"}],
    "aps": [{"id": "ap1", "x": 3, "y": 3, "tx_dbm": 8}]}]}


def tab(page, name):
    page.click("#tab-" + name)
    page.wait_for_selector("#panel-%s:not([hidden])" % name)


def app_eval(page, expr):
    return page.evaluate("() => { const a = window.PlannerApp; " + expr + " }")


def run_features(page, problems):
    """Analytics, smart planner, scenarios, compare, exports, annotations and the bonus modes."""
    page.on("dialog", lambda d: d.accept())
    page.evaluate("(p) => window.PlannerApp.loadProject(p)", SPARSE)
    wait_idle(page)
    page.wait_for_function("() => window.PlannerApp.panels.state.analysis && window.PlannerApp.panels.state.analysis.floor === 'g'", timeout=15000)
    text = page.inner_text("#panel-analytics").lower()
    for word in ("Coverage", "Average RSSI", "Weak area", "Dead zones", "Client capacity", "ESTIMATE", "AP overlap", "Roaming", "Channel utilisation", "MODEL ESTIMATE"):
        if word.lower() not in text:
            problems.append("analytics panel lacks %r" % word)
    if page.locator("#panel-analytics button:has-text('Locate')").count() == 0:
        problems.append("no dead zone with a Locate button on the sparse plan")
    else:
        page.click("#panel-analytics button:has-text('Locate')")
    # scenario "Before", then the smart planner
    tab(page, "scenarios")
    page.fill("#scenarioName", "Before"); page.click("#scenarioSave")
    if app_eval(page, "return a.store.project.scenarios.length") != 1:
        problems.append("scenario was not saved")
    tab(page, "smart")
    page.click("#planRun")
    page.wait_for_selector("#recList li", timeout=60000)
    n_aps = lambda: app_eval(page, "return a.store.project.floors[0].aps.length")  # noqa: E731
    before = n_aps()
    btn = page.locator("#recList [data-rec]")
    if btn.count() == 0:
        problems.append("smart planner gave no applicable recommendation: " + page.inner_text("#panel-smart")[:300])
    else:
        if "Confidence" not in page.inner_text("#recList"):
            problems.append("recommendations show no confidence")
        hist = app_eval(page, "return a.store.historyLength()")
        btn.first.click()
        if app_eval(page, "return a.store.historyLength()") != hist + 1:
            problems.append("applying a recommendation is not one undo step")
        changed = app_eval(page, "return JSON.stringify(a.store.project.floors[0].aps)")
        app_eval(page, "a.store.undo(); return 0")
        if app_eval(page, "return JSON.stringify(a.store.project.floors[0].aps)") == changed or n_aps() != before:
            problems.append("undo of an applied recommendation did not restore the access points")
        page.click("#planApplyAll")
        if app_eval(page, "return a.store.historyLength()") != hist + 1:
            problems.append("Apply all is not one undo step")
    wait_idle(page)
    # compare Before (A) with the current plan (B)
    tab(page, "scenarios")
    page.select_option("#cmpA", "s1"); page.select_option("#cmpB", "current")
    page.click("#cmpRun")
    page.wait_for_selector("#cmpOut table", timeout=60000)
    out = page.inner_text("#cmpOut")
    for word in ("Coverage", "Optimisation score", "Total", "Change (B minus A)"):
        if word not in out:
            problems.append("comparison lacks %r" % word)
    for mode in ("delta", "wipe", "side"):
        page.select_option("#cmpMode", mode)
        page.wait_for_selector("#cmpCanvasA")
    if page.locator("#cmpMode").input_value() != "side" or page.locator("#cmpCanvasB").count() != 1:
        problems.append("side by side view has no second canvas")
    page.select_option("#cmpMode", "delta")
    if "dB" not in page.inner_text("#cmpOut .delta-legend"):
        problems.append("delta view lacks a dB legend")
    page.click("#cmpRank")
    page.wait_for_selector("#rankOut table", timeout=60000)
    if "Rank" not in page.inner_text("#rankOut"):
        problems.append("ranking table missing")
    # exports
    tab(page, "export")
    def download(kind):
        with page.expect_download(timeout=20000) as d:
            page.click("[data-export=%s]" % kind)
        path = d.value.path()
        return d.value.suggested_filename, Path(path).read_bytes()
    name, csv = download("csv")
    if not csv.startswith(b"Wallhack RF analytics") or b"MODEL ESTIMATE" not in csv or b"Coverage" not in csv:
        problems.append("CSV export content is wrong: %r" % csv[:120])
    name, js = download("json")
    import json as _json
    data = _json.loads(js)
    if data.get("schema_version") != 2 or len(data.get("scenarios", [])) != 1:
        problems.append("JSON export lacks schema_version 2 or the scenario")
    name, png = download("png")
    if not png.startswith(b"\x89PNG\r\n\x1a\n") or len(png) < 2000:
        problems.append("PNG export is not a PNG")
    name, pdf = download("pdf")
    if not pdf.startswith(b"%PDF-1.4") or not pdf.rstrip().endswith(b"%%EOF") or b"/DCTDecode" not in pdf or b"MODEL ESTIMATE" not in pdf:
        problems.append("PDF export is not a complete PDF")
    with tempfile.TemporaryDirectory() as tmp:
        f = Path(tmp) / "plan.json"; f.write_bytes(js)
        page.set_input_files("#exportImport", str(f))
        page.wait_for_function("() => window.PlannerApp.store.project.scenarios.length === 1", timeout=5000)
    # annotation
    n_notes = lambda: app_eval(page, "return a.store.project.floors[0].annotations.length")  # noqa: E731
    page.fill("#noteText", "Check here"); page.click("[data-tool=note-text]")
    page.evaluate("window.scrollTo(0, 0)")
    page.mouse.click(*screen_of(page, 10.0, 10.0))
    page.click("[data-tool=note-arrow]")
    page.evaluate("window.scrollTo(0, 0)")
    a, b = screen_of(page, 5.0, 12.0), screen_of(page, 9.0, 14.0)
    page.mouse.move(*a); page.mouse.down(); page.mouse.move(*b, steps=4); page.mouse.up()
    if n_notes() != 2:
        problems.append("annotation tools added %d notes instead of 2" % n_notes())
    page.click("[data-tool=select]")
    # bonus modes
    tab(page, "modes")
    page.click("#addFloor")
    if app_eval(page, "return a.store.project.floors.length") != 2:
        problems.append("Add floor did not add a floor")
    app_eval(page, "a.store.undo(); return 0")
    if app_eval(page, "return a.store.project.floors.length") != 1:
        problems.append("undo did not remove the added floor")
    page.click("#runStack"); page.wait_for_selector("#panel-modes :text('Floor stack')", timeout=30000)
    page.click("#iotAdd")
    page.wait_for_selector("#panel-modes :text('Suggested fix')", timeout=5000)
    page.click("#entEval"); page.wait_for_selector("#panel-modes :text('Estimated coverage')", timeout=30000)
    aps0 = n_aps()
    page.click("#entApply")
    if n_aps() <= 1:
        problems.append("enterprise layout did not apply (%d to %d APs)" % (aps0, n_aps()))
    app_eval(page, "a.store.undo(); return 0")
    if n_aps() != aps0:
        problems.append("undo of the enterprise layout did not restore the APs")
    with page.expect_download(timeout=20000) as d:
        page.click("#entBoq")
    if b"Access point" not in Path(d.value.path()).read_bytes():
        problems.append("bill of quantities CSV lacks the access point row")
    page.click("#toggle3d")
    page.wait_for_function("() => !document.getElementById('room3d').hidden || /failed|Could not/.test(document.getElementById('panel-modes').innerText)", timeout=10000)
    if "3D view failed" in page.inner_text("#panel-modes") or "Could not load view3d" in page.inner_text("#panel-modes"):
        problems.append("3D mode failed: " + page.inner_text("#panel-modes")[:200])
    page.set_viewport_size({"width": 390, "height": 800})
    if page.evaluate("() => document.documentElement.scrollWidth > window.innerWidth + 4"):
        problems.append("page scrolls horizontally at 390 px width")
    page.set_viewport_size(VIEWPORT)
    print("feature checks done")


LAB = {"name": "Lab plan", "floors": [
    {"id": "g", "name": "Ground", "level": 0, "width_m": 30, "depth_m": 20,
     "rooms": [{"id": "west", "name": "West", "x": 0, "y": 0, "w": 15, "d": 20}, {"id": "east", "name": "East", "x": 15, "y": 0, "w": 15, "d": 20}],
     "walls": [{"id": "w1", "x1": 15, "y1": 0, "x2": 15, "y2": 20, "kind": "exterior", "material": "brick"},
               {"id": "w2", "x1": 0, "y1": 10, "x2": 15, "y2": 10, "kind": "interior", "material": "drywall"}],
     "aps": [{"id": "ap1", "x": 5, "y": 5, "tx_dbm": 17, "band": "5", "channel": 36}, {"id": "ap2", "x": 25, "y": 15, "tx_dbm": 17, "band": "5", "channel": 36}]},
    {"id": "u", "name": "Upper", "level": 1, "width_m": 30, "depth_m": 20, "walls": [], "aps": [{"id": "ap3", "x": 10, "y": 10, "tx_dbm": 17}]}]}

HEAT_LAYERS = ["rssi", "snr", "sinr", "quality", "bandwidth", "latency", "loss", "wall_loss", "interference", "utilisation", "capacity", "combined"]
PALETTES = ["classic", "aurora", "cvd", "viridis", "cividis"]


def ap_select(page, ap_id, label):
    return page.locator("#apList li[data-id=%s] label:has-text('%s') select" % (ap_id, label)).first


def lab_idle(page):
    """Wait for the analysis of the current floor, with all layers the view needs."""
    page.wait_for_function("""() => { const a = window.PlannerApp, s = a.panels.state.analysis;
        return s && s.floor === a.store.floorId && s.layers && a.neededLayers().every(id => s.layers[id]); }""", timeout=60000)


def click_world(page, x, y, **kw):
    page.focus("#cEdit")   # focusing scrolls the plan into view, so do it before measuring where to click
    page.wait_for_timeout(100)
    page.mouse.move(*screen_of(page, x, y)); page.wait_for_timeout(150)   # the layout can shift when the pointer first enters the plan
    page.mouse.click(*screen_of(page, x, y), **kw)


def run_lab_features(page, problems, args):
    """Heat map layers, AP WiFi controls, spectrum, dashboard, interferers, doors, floor openings, floors, view persistence."""
    page.evaluate("(p) => window.PlannerApp.loadProject(p)", LAB)
    wait_idle(page)
    lab_idle(page)
    # AP panel WiFi controls, exercised through the page like a user
    ap_select(page, "ap1", "Standard").select_option("wifi6")
    ap_select(page, "ap1", "Width").select_option("80")
    ap_select(page, "ap1", "Streams").select_option("2")
    got = app_eval(page, "const x = a.store.project.floors[0].aps[0]; return [x.standard, x.width_mhz, x.spatial_streams]")
    if got != ["wifi6", 80, 2]:
        problems.append("AP panel controls did not set standard, width and streams: %r" % got)
    ap_select(page, "ap2", "Standard").select_option("wifi7")
    ap_select(page, "ap2", "Width").select_option("80")
    if page.locator("#apList li[data-id=ap2] .mlo-box input").count() != 2:
        problems.append("a Wi-Fi 7 access point on 5 GHz should offer two MLO links")
    else:
        page.locator("#apList li[data-id=ap2] .mlo-box input").first.check()
    mlo = app_eval(page, "return a.store.project.floors[0].aps[1].mlo_bands")
    if not mlo or len(mlo) != 1:
        problems.append("MLO checkbox did not set mlo_bands: %r" % mlo)
    lab_idle(page)
    page.wait_for_function("() => /Mean SINR/.test(document.querySelector('[data-ap-result=ap1]').textContent)", timeout=30000)
    if "MLO over" not in page.inner_text("[data-ap-result=ap2]"):
        problems.append("AP panel shows no MLO result: " + page.inner_text("[data-ap-result=ap2]"))
    app_eval(page, "a.store.undo(); a.store.undo(); return 0")
    if app_eval(page, "return a.store.project.floors[0].aps[1].mlo_bands") is not None and app_eval(page, "return a.store.project.floors[0].aps[1].mlo_bands !== undefined"):
        problems.append("undo of the MLO change did not remove mlo_bands")
    app_eval(page, "a.store.redo(); a.store.redo(); return 0")
    lab_idle(page)
    # every heat mode, on every palette
    for layer in HEAT_LAYERS:
        page.select_option("#layerSel", layer)
        page.wait_for_function("""(id) => { const a = window.PlannerApp; return a.view.layer === id && (id === 'rssi' || (a.layerInfo && a.layerInfo.id === id)); }""", arg=layer, timeout=60000)
        info = app_eval(page, "return a.layerInfo ? {stats: !!a.layerInfo.stats, reason: a.layerInfo.reason, mode: a.renderer.layerMode} : {mode: false}")
        legend = page.inner_text("#legend")
        if layer != "rssi" and (not info["stats"] or not info["mode"]):
            problems.append("layer %s drew nothing: %r" % (layer, info))
        if layer != "rssi" and "Floor: min" not in legend:
            problems.append("legend of layer %s lacks its statistics: %r" % (layer, legend))
        if layer == "rssi" and "Excellent" not in legend:
            problems.append("RSSI legend lost the quality bands")
        page.wait_for_timeout(60)
    for pal in PALETTES:
        page.select_option("#paletteSel", pal)
        if app_eval(page, "return a.view.palette") != pal or app_eval(page, "return a.renderer.opts.palette") != pal:
            problems.append("palette %s was not applied to the renderer" % pal)
    page.select_option("#layerSel", "snr")
    page.select_option("#paletteSel", "viridis")
    page.wait_for_function("() => window.PlannerApp.layerInfo && window.PlannerApp.layerInfo.id === 'snr'", timeout=30000)
    if "linear-gradient" not in page.evaluate("() => document.querySelector('#legend .ramp').style.background"):
        problems.append("layer legend has no gradient bar")
    # view survives a reload through the URL
    url = page.url
    if "layer=snr" not in url or "palette=viridis" not in url:
        problems.append("view is not mirrored in the URL: " + url)
    page.reload()
    page.wait_for_function("window.PlannerApp && window.PlannerApp.ready", timeout=15000)
    if app_eval(page, "return [a.view.layer, a.view.palette]") != ["snr", "viridis"]:
        problems.append("view did not survive a reload")
    page.evaluate("(p) => window.PlannerApp.loadProject(p)", LAB)
    wait_idle(page)
    ap_select(page, "ap1", "Standard").select_option("wifi6")
    # layers tab: combined map, overlays, side by side
    tab(page, "layers")
    page.select_option("#cmpLayerB", "wall_loss")
    lab_idle(page)
    page.wait_for_selector("#sideA, #sideBySide canvas", timeout=15000)
    if page.locator("#sideBySide canvas").count() != 2:
        problems.append("side by side compare did not draw two maps")
    page.locator("#combineList input[data-layer=sinr]").check()
    page.click("#showCombined")
    page.wait_for_function("() => window.PlannerApp.layerInfo && window.PlannerApp.layerInfo.id === 'combined' && window.PlannerApp.layerInfo.stats", timeout=30000)
    for ov in ("roaming", "strongest", "blend"):
        page.locator("#ov-" + ov).check()
        lab_idle(page)
        app_eval(page, "a.editor.drawNow(); return 0")
    if "Handoff area" not in page.inner_text("#panel-layers"):
        problems.append("layers panel lacks the roaming figures")
    if page.locator("#apColourLegend li").count() < 3:
        problems.append("strongest AP colour legend is missing")
    for ov in ("roaming", "strongest", "blend"):
        page.locator("#ov-" + ov).uncheck()
    page.select_option("#layerSel", "rssi")
    # dashboard
    tab(page, "dashboard")
    lab_idle(page)
    page.wait_for_selector("#dashHist", timeout=10000)
    text = page.inner_text("#panel-dashboard").lower()
    page.wait_for_timeout(300)
    for word in ("Average coverage", "Edge coverage", "Efficiency score", "Weakest zones", "Strongest zones", "Signal distribution"):
        if word.lower() not in text:
            problems.append("dashboard lacks %r" % word)
    if not page.evaluate("() => { const c = document.getElementById('dashHist'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 4) { if (d[i]) { return true; } } return false; }"):
        problems.append("dashboard histogram is blank")
    # spectrum
    tab(page, "spectrum")
    page.select_option("#specBand", "2.4")
    page.wait_for_timeout(200)
    page.wait_for_selector("#specCanvas")
    if "Least congested" not in page.inner_text("#specSuggest"):
        problems.append("spectrum view gives no channel suggestion: " + page.inner_text("#specSuggest"))
    if not page.evaluate("() => { const c = document.getElementById('specCanvas'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) { if (d[i]) { n++; } } return n > 500; }"):
        problems.append("spectrum canvas is blank")
    # interference source: place with the tool, it appears in the spectrum and the environment panel
    page.click("[data-tool=interferer]")
    click_world(page, 20.0, 5.0)
    if app_eval(page, "return (a.store.project.interferers || []).length") != 1:
        problems.append("interference tool did not add a source")
    page.wait_for_function("() => /src1/.test(document.getElementById('panel-spectrum').innerText)", timeout=5000)
    tab(page, "environment")
    if page.locator("#panel-environment select[aria-label='Kind of src1']").count() != 1:
        problems.append("environment panel does not list the new source")
    page.select_option("#sourceKind", "bluetooth")
    page.click("#envAddSource")
    if app_eval(page, "return a.store.project.interferers.map(s => s.kind).join()") != "microwave,bluetooth":
        problems.append("source kind select or Add source button failed")
    page.locator("#panel-environment input[aria-label='Duty cycle of src1 (percent)']").fill("20")
    page.locator("#panel-environment input[aria-label='Duty cycle of src1 (percent)']").dispatch_event("change")
    if abs(app_eval(page, "return a.store.project.interferers[0].duty_cycle") - 0.2) > 1e-9:
        problems.append("duty cycle edit did not reach the project")
    lab_idle(page)
    app_eval(page, "a.store.undo(); a.store.undo(); a.store.undo(); return 0")
    if app_eval(page, "return a.store.project.interferers.length") != 0:
        problems.append("undo did not remove the sources")
    # door and window on a wall
    page.click("[data-tool=door]")
    click_world(page, 7.5, 10.0)
    ops = lambda: app_eval(page, "return a.store.project.floors[0].openings.map(o => o.kind + ':' + o.wall).join()")  # noqa: E731
    if ops() != "door:w2":
        problems.append("door tool did not add a door to w2: %r" % ops())
    page.click("[data-tool=window]")
    click_world(page, 3.0, 10.0)
    if ops() != "door:w2,window:w2":
        problems.append("window tool did not add a window: %r" % ops())
    page.click("[data-tool=door]")
    click_world(page, 20.0, 3.0)   # nowhere near a wall
    if len(ops().split(",")) != 2:
        problems.append("door tool added a door away from any wall")
    wait_idle(page)
    page.click("[data-tool=select]")
    wait_idle(page); lab_idle(page)
    click_world(page, 11.0, 10.0, button="right")
    page.locator(".ctxmenu button:has-text('Add door here')").click()
    if len(ops().split(",")) != 3:
        problems.append("context menu did not add a door")
    app_eval(page, "a.store.undo(); return 0")
    # floor opening (stairwell) by dragging a rectangle
    page.click("[data-tool=void]")
    a, b = screen_of(page, 22.0, 2.0), screen_of(page, 26.0, 6.0)
    page.mouse.move(*a); page.mouse.down(); page.mouse.move(*b, steps=5); page.mouse.up()
    voids = lambda: app_eval(page, "return (a.store.project.floors[0].voids || []).map(v => v.kind + ':' + v.w + 'x' + v.d).join()")  # noqa: E731
    if voids() != "stairwell:4x4":
        problems.append("floor opening tool did not add a 4 x 4 m stairwell: %r" % voids())
    page.click("[data-tool=select]")
    # object tool: a fridge is four wall segments that undo, delete and change thickness as one group
    n_walls = lambda: app_eval(page, "return a.store.project.floors[0].walls.length")  # noqa: E731
    w0 = n_walls()
    page.select_option("#objectKind", "fridge")
    click_world(page, 22.0, 14.0)
    wait_idle(page)
    if n_walls() != w0 + 4 or app_eval(page, "return a.store.project.floors[0].walls.filter(w => w.object).length") != 4:
        problems.append("object tool did not add four tagged wall segments: %r" % n_walls())
    page.keyboard.press("Control+z")
    if n_walls() != w0:
        problems.append("one undo did not remove the whole object")
    page.keyboard.press("Control+Shift+z")
    page.click("[data-tool=select]")
    click_world(page, 21.65, 14.0)   # the left edge of the fridge selects the whole object
    if app_eval(page, "return a.store.selection.walls.length") != 4:
        problems.append("clicking one edge did not select the whole object: %r" % app_eval(page, "return a.store.selection.walls.length"))
    page.locator("#wallThickness").fill("2"); page.locator("#wallThickness").dispatch_event("change")
    if app_eval(page, "return a.store.project.floors[0].walls.filter(w => w.object && w.thickness_cm === 2).length") != 4:
        problems.append("thickness input did not apply to the whole object")
    page.focus("#cEdit"); page.keyboard.press("Delete")
    if n_walls() != w0:
        problems.append("deleting one edge did not delete the whole object")
    page.select_option("#paletteSel", "aurora"); wait_idle(page)
    if app_eval(page, "return a.paletteId") != "aurora":
        problems.append("aurora palette was not applied")
    page.select_option("#paletteSel", "classic")
    tab(page, "environment")
    page.click("#envAddVoid")
    if len((app_eval(page, "return a.store.project.floors[0].voids") or [])) != 2:
        problems.append("Add stairwell button did not add a second opening")
    # the engine accepts what the editor wrote, and the worker recomputes after each edit
    wait_idle(page)
    lab_idle(page)
    saved = app_eval(page, "return window.PlannerState.exportProjectJson(a.store.project)")
    app_eval(page, "return window.PlannerState.parseProjectJson(" + repr(saved) + ", a.validateOpts()) && 0")
    # V2: class profile, beamforming and a Smart Home client with CAPACITY MODEL results
    ap_select(page, "ap1", "Class").select_option("enterprise")
    got_profile = app_eval(page, "const x = a.store.project.floors[0].aps[0]; return [x.profile, x.standard, x.spatial_streams, x.beamforming, x.band, x.tx_dbm]")
    if got_profile != ["enterprise", "wifi7", 4, True, "5", 19.0]:
        problems.append("class profile did not set the AP fields: %r" % (got_profile,))
    page.select_option("#clientKind", "phone"); page.click("#clientAdd"); wait_idle(page); lab_idle(page)
    page.wait_for_function("() => document.querySelector('#clientList li p') && /CAPACITY MODEL/.test(document.querySelector('#clientList li p').textContent)", timeout=30000)
    if app_eval(page, "return (a.store.project.floors[0].clients || []).length") != 1:
        problems.append("Add client did not add one client")
    # floors: up and down buttons, Page Up, floor stack
    if app_eval(page, "return a.store.floorId") != "g" or not page.locator("#floorDown").is_disabled():
        problems.append("floor down should be disabled on the lowest floor")
    page.click("#floorUp")
    if app_eval(page, "return a.store.floorId") != "u":
        problems.append("Floor up did not switch to the upper floor")
    page.focus("#cEdit"); page.keyboard.press("PageDown")
    if app_eval(page, "return a.store.floorId") != "g":
        problems.append("Page Down did not switch back")
    page.click("#floorUp"); wait_idle(page)
    page.select_option("#layerSel", "snr")
    lab_idle(page)
    page.click("#floorDown"); wait_idle(page); lab_idle(page)
    page.select_option("#layerSel", "rssi")
    print("lab feature checks done")
    if not args.no_screenshot:
        suffix = "-demo" if args.demo else ""
        docs = docs_dir(args)
        page.set_viewport_size({"width": 1400, "height": 1100})
        page.select_option("#layerSel", "sinr"); page.select_option("#paletteSel", "viridis")
        lab_idle(page); page.wait_for_timeout(300)
        tab(page, "layers")
        page.evaluate("window.scrollTo(0, 0)")
        page.screenshot(path=str(docs / ("screenshot-planner-layers%s.png" % suffix)))
        page.select_option("#layerSel", "rssi"); page.select_option("#paletteSel", "classic")
        for name in ("dashboard", "spectrum"):
            tab(page, name)
            page.locator("#panel-" + name).scroll_into_view_if_needed()
            page.locator("#panel-" + name).screenshot(path=str(docs / ("screenshot-planner-%s%s.png" % (name, suffix))))
        page.set_viewport_size(VIEWPORT)


def run_twin_lab_features(page, problems, args):
    """Timeline with handoffs, what-if, ranked recommendations and the generated network plan (dialogs are accepted by run_features)."""
    page.evaluate("(p) => window.PlannerApp.loadProject(p)", LAB)
    wait_idle(page)
    tab(page, "twinlab")
    page.click("#tlRun")
    if "Draw a path first" not in page.inner_text("#panel-twinlab"):
        problems.append("timeline ran without a path")
    page.click("#tlDraw")
    click_world(page, 3, 3); click_world(page, 15, 10); click_world(page, 27, 17)
    if app_eval(page, "return a.twinLab.state.path.length") != 3:
        problems.append("path tool did not add 3 waypoints")
    page.click("#tlRun")
    page.wait_for_selector("#tlEvents, #panel-twinlab :text('No handoffs')", timeout=10000)
    if "Handoff from ap1" not in page.inner_text("#panel-twinlab"):
        # #tlEvents is absent when there are no handoffs, so report the panel text and the waypoints instead
        problems.append("timeline shows no handoff from ap1 to ap2: %s, path %s" % (
            page.inner_text("#panel-twinlab")[:300].replace("\n", " | "), app_eval(page, "return a.twinLab.state.path")))
    page.fill("#tlScrub", "5")
    if "dBm" not in page.inner_text("#tlReadout"):
        problems.append("scrubber readout empty")
    page.select_option("#wiKind", "move_ap"); page.fill("#wiX", "10"); page.fill("#wiY", "10"); page.click("#wiRun")
    page.wait_for_selector("#wiOut table", timeout=30000)
    if "Coverage score" not in page.inner_text("#wiOut"):
        problems.append("what-if panel lacks the coverage score row")
    if not args.no_screenshot:
        suffix = "-demo" if args.demo else ""
        page.locator("#panel-twinlab").scroll_into_view_if_needed()
        page.locator("#panel-twinlab").screenshot(path=str(docs_dir(args) / ("screenshot-planner-timeline%s.png" % suffix)))
    page.click("#recRun")
    page.wait_for_selector("#recScore", timeout=60000)
    if "out of 100" not in page.inner_text("#recScore"):
        problems.append("recommendation score missing")
    page.click("#designRun")
    page.wait_for_selector("#planOut table", timeout=60000)
    page.wait_for_selector("#planNarration p", timeout=15000)
    if "MODEL ESTIMATE" not in page.inner_text("#planNarration"):
        problems.append("plan narration lacks the estimate label: " + page.inner_text("#planNarration")[:200])
    before = n_aps_now(page)
    page.click("#planApply")
    page.wait_for_function("() => window.PlannerApp.store.project.floors[0].aps.every(a => a.id.indexOf('plan-ap') === 0)", timeout=5000)
    app_eval(page, "a.store.undo(); return 0")
    if n_aps_now(page) != before:
        problems.append("undo of the network plan did not restore the APs")
    print("twin lab checks done")


def n_aps_now(page):
    return page.evaluate("() => window.PlannerApp.store.project.floors.reduce((n, f) => n + f.aps.length, 0)")


def run_view3d_features(page, problems, args):
    """3D building view (two floors, one basement), slicing plane, keyboard and drag orbit, fallback renderer, beams and generation tabs."""
    page.evaluate("""async () => { const a = window.PlannerApp, lib = await (await fetch(a.assetUrl('scenarios.json'))).json();
      const p = JSON.parse(JSON.stringify(lib.scenarios.find(s => s.id === 'large_home').project));
      p.floors[0].elevation_m = -3; p.floors[0].level = -1; p.floors[1].level = 0; p.floors[1].elevation_m = 0;
      a.loadProject(p); }""")
    wait_idle(page)
    tab(page, "view3d")
    page.wait_for_function("() => document.getElementById('view3dMsg').textContent.indexOf('Ready') === 0", timeout=30000)
    chip = page.inner_text("#view3dRenderer")
    print("3D renderer:", chip)
    if args.canvas2d and "canvas projection" not in chip:
        problems.append("3D view ignored the canvas 2D request: " + chip)
    if "renderer:" not in chip:
        problems.append("3D renderer chip missing: " + chip)
    text = page.inner_text("#view3dText")
    if "below ground" not in text or "Slicing plane" not in text or "not a 3D propagation simulation" not in text:
        problems.append("3D text alternative incomplete: " + text[:300])
    if not page.evaluate("() => { const c = document.getElementById('view3dCanvas'); return c.width > 0 && c.getAttribute('aria-describedby') === 'view3dText'; }"):
        problems.append("3D canvas not sized or not described")
    yaw0 = app_eval(page, "return a.view3d.state.cam.yaw")
    page.focus("#view3dCanvas"); page.keyboard.press("ArrowLeft")
    if app_eval(page, "return a.view3d.state.cam.yaw") == yaw0:
        problems.append("arrow key did not orbit the 3D camera")
    box = page.locator("#view3dCanvas").bounding_box()
    page.mouse.move(box["x"] + 100, box["y"] + 100); page.mouse.down(); page.mouse.move(box["x"] + 200, box["y"] + 140, steps=4); page.mouse.up()
    if app_eval(page, "return a.view3d.state.cam.yaw") == yaw0:
        problems.append("dragging did not orbit the 3D camera")
    page.fill("#view3dSlice", "-1.5")
    if "interpolated" not in page.inner_text("#view3dText"):
        problems.append("slicing plane between floors is not described as interpolated: " + page.inner_text("#view3dText")[-200:])
    page.fill("#view3dSlice", "0")
    page.uncheck("#view3dVolume")
    n = app_eval(page, "return a.view3d.state.scene.quads.filter(q => q.kind === 'volume').length")
    if n != 0:
        problems.append("volume toggle left %d slices" % n)
    page.check("#view3dVolume")
    page.click("#view3dTour")
    page.click("#view3dReset")
    if not args.no_screenshot:
        page.locator("#view3dCanvas").screenshot(path=str(docs_dir(args) / ("screenshot-planner-3d%s.png" % ("-demo" if args.demo else ""))))
    tab(page, "beams")
    page.wait_for_selector("#genOut table")
    if "Wi-Fi 7" not in page.inner_text("#genOut") or "ILLUSTRATION" not in page.inner_text("#panel-beams"):
        problems.append("beams and generations panel incomplete")
    page.select_option("#genBand", "6")
    if "not on this band" not in page.inner_text("#genOut"):
        problems.append("6 GHz table does not mark Wi-Fi 4 to 6 as unsupported")
    page.click("#genRun")
    page.wait_for_selector("#genFloor table", timeout=60000)
    page.locator("#beamSteer").evaluate("e => { e.value = '90'; e.dispatchEvent(new Event('input', {bubbles: true})); }")
    if "Steered toward 90" not in page.inner_text("#beamText"):
        problems.append("beam text did not follow the steering slider: " + page.inner_text("#beamText"))
    if not args.no_screenshot:
        suffix = "-demo" if args.demo else ""
        page.locator("#panel-beams").screenshot(path=str(docs_dir(args) / ("screenshot-planner-beams%s.png" % suffix)))
        wall_id = app_eval(page, "return a.store.project.floors[0].walls[0].id")
        app_eval(page, "a.store.select({ walls: [%r] }); a.editor.invalidate(); return 0" % wall_id)
        page.wait_for_selector("#inspector:not([hidden])", timeout=5000)
        page.locator("#inspector").screenshot(path=str(docs_dir(args) / ("screenshot-planner-materials%s.png" % suffix)))
    print("3D view checks done")


def run_learn_features(page, problems, args):
    """Scenario presets, educational mode, lessons, probe explanation, plan explanation and the report sections."""
    suffix = "-demo" if args.demo else ""
    docs = docs_dir(args)
    page.set_viewport_size({"width": 1400, "height": 1100})
    ids = page.evaluate("() => Array.from(document.querySelectorAll('#presetSel option')).map(o => o.value).filter(Boolean)")
    if len(ids) != 14:
        problems.append("preset picker lists %d scenarios instead of 14" % len(ids))
    for pid in ids:
        page.select_option("#presetSel", pid); page.click("#presetLoad")
        page.wait_for_function("(n) => window.PlannerApp.store.project.name === n", arg=page.evaluate("(id) => window.PlannerApp.learn.presets.find(p => p.id === id).project.name", pid), timeout=5000)
        wait_idle(page)
    page.select_option("#presetSel", "office_floor"); page.click("#presetLoad"); wait_idle(page)
    if not args.no_screenshot:
        page.evaluate("window.scrollTo(0, 0)")
        page.locator(".p-tools").screenshot(path=str(docs / ("screenshot-planner-presets%s.png" % suffix)))
    # educational mode
    page.click("#learnBtn")
    if page.get_attribute("#learnBtn", "aria-pressed") != "true":
        problems.append("Learn toggle did not switch on")
    page.focus("#bandSel")
    if "frequencies" not in page.inner_text("#learnContext").lower():
        problems.append("contextual panel did not show the frequencies topic for the band control")
    tab(page, "learn")
    page.select_option("#lessonSel", "walls"); wait_idle(page)
    if "Not yet" not in page.inner_text("#lessonBox"):
        problems.append("lesson should start unsolved")
    page.click("#whyBtn")
    if "Where the signal went" not in page.inner_text("#whyOut"):
        problems.append("probe explanation did not render")
    page.click("#lessonShow"); wait_idle(page)
    page.wait_for_function("() => /Lesson complete/.test(document.getElementById('lessonBox').innerText)", timeout=15000)
    page.select_option("#lessonSel", "channels"); wait_idle(page)
    page.click("#lessonShow"); wait_idle(page)
    page.wait_for_function("() => /Lesson complete/.test(document.getElementById('lessonBox').innerText)", timeout=15000)
    if not args.no_screenshot:
        page.evaluate("window.scrollTo(0, 0)")
        page.screenshot(path=str(docs / ("screenshot-planner-learn%s.png" % suffix)))
    page.click("#learnBtn")
    # plan, recommendations and explanation
    page.select_option("#presetSel", "hotel_floor"); page.click("#presetLoad"); wait_idle(page)
    tab(page, "smart")
    page.click("#planRun")
    page.wait_for_selector("#recList li", timeout=120000)
    kinds = page.evaluate("() => Array.from(document.querySelectorAll('#recList .rec-main strong')).map(e => e.textContent)")
    if "dead zone fix" not in kinds or "add ap" not in kinds:
        problems.append("recommendation panel lacks dead-zone or placement entries: %s" % kinds)
    if "Confidence:" not in page.inner_text("#recList"):
        problems.append("recommendations show no confidence")
    if args.demo:
        if page.locator("#explainBtn").count():
            problems.append("the explain button must be hidden in the static demo")
    else:
        page.click("#explainBtn")
        page.wait_for_function("() => /MODEL ESTIMATE/.test(document.getElementById('explainOut').innerText)", timeout=15000)
        if "Rule-based text" not in page.inner_text("#explainOut"):
            problems.append("explanation should be rule-based when no LLM is configured")
    if not args.no_screenshot:
        page.locator("#panel-smart").screenshot(path=str(docs / ("screenshot-planner-advice%s.png" % suffix)))
    # report
    tab(page, "export")
    with page.expect_download(timeout=30000) as d:
        page.click("[data-export=pdf]")
    pdf = Path(d.value.path()).read_bytes()
    for text in (b"Floor overview", b"Coverage maps per propagation mode", b"Access point locations", b"Spectrum summary", b"Performance of this analysis", b"Text summary", b"MODEL ESTIMATE"):
        if text not in pdf:
            problems.append("PDF report lacks the section %r" % text.decode())
    if not args.no_screenshot:
        page.locator("#panel-export").screenshot(path=str(docs / ("screenshot-planner-report%s.png" % suffix)))
    page.set_viewport_size(VIEWPORT)
    print("learn feature checks done")


QUICK_TIME_LIMIT_S = 20.0   # template to result; measured times are well below (see the printed figure), this only catches a hang


def run_quick_features(page, problems, args):
    """Quick start: template -> Analyse -> grade, weakest-room action, rooms, diagnosis and best spot; ask a question;
    apply the model-tested fix and best spot; open every Wi-Fi architect tab; signal waves toggle; mobile width has no horizontal scroll."""
    page.on("dialog", lambda d: d.accept())
    page.wait_for_function("() => window.PlannerApp.quick && window.PlannerApp.quick.templatesReady", timeout=15000)
    page.select_option("#quickTemplate", "two_bedroom_condo")
    start = time.time()
    page.click("#quickAnalyse")
    page.wait_for_selector("#quickResult[data-ready=true]", timeout=int(QUICK_TIME_LIMIT_S * 1000))
    elapsed = time.time() - start
    in_page = page.evaluate("() => Number(document.getElementById('quickResult').dataset.ms)")
    print("quick start: template to result %.2f s (in page %d ms)" % (elapsed, in_page))
    if elapsed > QUICK_TIME_LIMIT_S:
        problems.append("quick start took %.1f s" % elapsed)
    text = page.inner_text("#quickResult")
    for word in ("Overall", "Coverage", "Dead zones", "Gaming grade", "Streaming", "Video calls", "Fix my weakest room", "Your rooms, for gaming", "Best router spot", "Bedroom", "Packet loss risk"):
        if word.lower() not in text.lower() and word.lower() not in page.inner_html("#quickResult").lower():
            problems.append("quick result lacks %r" % word)
    if not page.locator("#quickResult .q-grade[aria-label^='Overall grade']").count():
        problems.append("quick result has no grade with a text equivalent")
    line = page.inner_text("#quickBestLine")
    if "points coverage" not in line and "stronger average signal" not in line and "already at the best spot" not in line:
        problems.append("best spot line unexpected: %r" % line)
    # apply the top model-tested weakest-room fix, check the visible outcome and persistent announcement, then undo it
    if page.inner_text("#quickOutcomeStatus"):
        problems.append("post-fix announcement is not empty before Apply")
    if not page.locator("#quickFixWeakest:not([disabled])").count():
        problems.append("Quick start has no enabled weakest-room action")
    else:
        before_fix = page.evaluate("() => JSON.stringify(window.PlannerApp.store.project.floors[0].aps)")
        page.click("#quickFixWeakest")
        page.wait_for_selector("#quickWeakestOutcome", timeout=30000)
        page.wait_for_selector("#quickResult[data-ready=true]", timeout=30000)
        outcome = page.inner_text("#quickWeakestOutcome")
        page.wait_for_function("() => document.getElementById('quickOutcomeStatus').textContent.length > 0", timeout=5000)
        announced = page.inner_text("#quickOutcomeStatus")
        if page.get_attribute("#quickWeakestOutcome", "role"):
            problems.append("visible weakest-room outcome should not be a live region")
        if announced not in outcome:
            problems.append("post-fix announcement is not the concise visible outcome: %r" % announced)
        if "gaming grade" not in outcome.lower():
            problems.append("weakest-room outcome has no before/after gaming grade: %r" % outcome)
        if "was reduced from about" not in outcome or "but it was not eliminated" not in outcome:
            problems.append("channel-fix outcome does not explain residual interference: %r" % outcome)
        connector = page.locator("#quickCompare .q-connector")
        if not connector.count() or not connector.is_visible() or connector.bounding_box()["width"] <= 0:
            problems.append("before/after grade connector is missing or has no visible width")
        page.evaluate("() => window.PlannerApp.store.undo()")
        page.wait_for_selector("#quickResult[data-ready=true]", timeout=30000)
        page.wait_for_function("(b) => JSON.stringify(window.PlannerApp.store.project.floors[0].aps) === b", arg=before_fix, timeout=30000)
    # ask
    page.fill("#quickAsk", "Why is my Bedroom 2 WiFi slow?")
    page.click("#quickAskForm button[type=submit]")
    page.wait_for_function("() => /WiFi in Bedroom 2/.test(document.getElementById('quickAnswer').innerText)", timeout=15000)
    if "Main cause" not in page.inner_text("#quickAnswer"):
        problems.append("the answer names no main cause")
    if not page.locator("#quickChips .q-chip").count():
        problems.append("no suggested question chips")
    # show and apply the best spot (undoable)
    page.click("#quickShow")
    if page.evaluate("() => !window.PlannerApp.panels.state.ghost"):
        problems.append("Show did not draw the ghost marker")
    if page.locator("#quickApply:not([disabled])").count():
        before = page.evaluate("() => JSON.stringify(window.PlannerApp.store.project.floors[0].aps.map(a => [a.id, a.x, a.y]))")
        page.click("#quickApply")
        after = page.evaluate("() => JSON.stringify(window.PlannerApp.store.project.floors[0].aps.map(a => [a.id, a.x, a.y]))")
        if before == after:
            problems.append("Apply did not move the router")
        try:
            page.wait_for_selector("#quickCompare #quickCompareLine", timeout=20000)
            if "Grade" not in (page.get_attribute("#quickCompare .q-compare-grades", "aria-label") or ""):
                problems.append("before/after card has no grade text")
        except Exception:
            problems.append("applying the best spot showed no before/after grade")
        page.evaluate("() => window.PlannerApp.store.undo()")
        if page.evaluate("() => JSON.stringify(window.PlannerApp.store.project.floors[0].aps.map(a => [a.id, a.x, a.y]))") != before:
            problems.append("undo did not restore the router")
    wait_idle(page)
    # find best spot with the AP tool button
    page.click("#findSpotBtn")
    page.wait_for_selector("#findSpotLine", timeout=30000)
    # tabs
    tab(page, "rooms")
    if "Smart Home check" not in page.inner_text("#panel-rooms") or not page.locator("#panel-rooms .room-card").count():
        problems.append("Rooms and gaming tab is incomplete")
    tab(page, "scorecard")
    if "How the grade is built" not in page.inner_text("#panel-scorecard") + page.inner_html("#panel-scorecard"):
        problems.append("Score card tab is incomplete")
    tab(page, "assistant")
    page.fill("#asstInput", "Why is my Bedroom 2 WiFi slow?"); page.click("#asstForm button[type=submit]")
    page.wait_for_function("() => /WiFi in Bedroom 2/.test(document.getElementById('asstAnswer').innerText)", timeout=15000)
    has_explain = page.locator("#asstExplain").count() > 0
    if args.demo == has_explain:
        problems.append("the explain button must be hidden in the demo and shown live")
    tab(page, "mesh")
    page.click("#meshRun"); page.wait_for_selector("#panel-mesh table", timeout=60000)
    if "Whole-home mesh" not in page.inner_text("#panel-mesh"):
        problems.append("mesh tab lacks the whole-home topology")
    tab(page, "timemachine")
    page.click("#tmRun"); page.wait_for_selector("#tmOut table", timeout=60000)
    if page.locator("#tmOut .tm-canvas").count() < 3 or "Change against A" not in page.inner_text("#tmOut"):
        problems.append("Time Machine did not compare three versions")
    page.select_option("#tmSlot3", "preset:high_end_router"); page.click("#tmRun")
    page.wait_for_function("() => document.querySelectorAll('#tmOut .tm-canvas').length === 4", timeout=60000)
    tab(page, "scorecard")
    with page.expect_download(timeout=30000) as dl:
        page.click("#panel-scorecard [data-quick=pdf]")
    if dl.value.suggested_filename != "wifi_assessment.pdf":
        problems.append("assessment download is named %r" % dl.value.suggested_filename)
    pdf = Path(dl.value.path()).read_bytes()
    pages = pdf.count(b"/Type /Page ")
    if not pdf.startswith(b"%PDF-1.4") or not pdf.rstrip().endswith(b"%%EOF") or pages < 4 or pdf.count(b"MODEL ESTIMATE, not a measurement. Values come") != pages:
        problems.append("wifi_assessment.pdf is incomplete or a page lacks the estimate footer (%d pages)" % pages)
    if b"Time Machine" not in pdf or b"Mesh topologies" not in pdf:
        problems.append("wifi_assessment.pdf lacks the mesh or Time Machine page")
    tab(page, "scenarios")   # the old two-scenario compare is still there
    if not page.locator("#cmpRun, #cmpOut, #panel-scenarios button").count():
        problems.append("scenarios tab lost its compare controls")
    # signal waves
    page.emulate_media(reduced_motion="no-preference")
    page.check("#tgWaves"); page.wait_for_timeout(300)
    if not page.evaluate("() => window.PlannerApp.quick.waves.on && window.PlannerApp.quick.waves.raf !== 0"):
        problems.append("signal waves did not start animating")
    page.uncheck("#tgWaves"); page.wait_for_timeout(100)
    if page.evaluate("() => window.PlannerApp.quick.waves.raf !== 0"):
        problems.append("signal waves kept animating after being switched off")
    page.emulate_media(reduced_motion="reduce")
    page.check("#tgWaves"); page.wait_for_timeout(200)
    if page.evaluate("() => window.PlannerApp.quick.waves.raf !== 0"):
        problems.append("signal waves animate although reduced motion is on")
    page.uncheck("#tgWaves"); page.emulate_media(reduced_motion="no-preference")
    # switching floors clears the previous floor's result and action rather than applying it to another floor
    page.select_option("#quickTemplate", "large_home")
    page.click("#quickAnalyse")
    page.wait_for_selector("#quickResult[data-ready=true]", timeout=30000)
    if not page.locator("#quickFixWeakest:not([disabled])").count():
        problems.append("large home has no weakest-room action before the floor switch")
    page.select_option("#floorSel", "upper")
    page.wait_for_function("() => !document.getElementById('quickResult').innerText && /check this floor/i.test(document.getElementById('quickStatus').innerText)", timeout=5000)
    if page.locator("#quickFixWeakest").count():
        problems.append("switching floors left the old weakest-room action active")
    # mobile width: no horizontal scroll, quick start usable
    page.set_viewport_size({"width": 390, "height": 800})
    page.wait_for_timeout(300)
    if page.evaluate("() => document.documentElement.scrollWidth > window.innerWidth + 1"):
        problems.append("horizontal scroll at 390 px width")
    if not page.locator("#quickAnalyse").is_visible():
        problems.append("Analyse button not visible at 390 px")
    page.set_viewport_size(VIEWPORT)
    print("quick start checks done")


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
            except Exception:
                for msg in errors:   # a failed step is easier to read next to the page errors that preceded it
                    print("PAGE ERROR BEFORE FAILURE:", msg, file=sys.stderr)
                raise
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
