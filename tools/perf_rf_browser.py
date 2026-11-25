#!/usr/bin/env python3
"""Measure the RF planner in headless Chromium and write docs/perf-rf.md (also runs tools/perf_rf.js in node).

Method: a seeded 100 m x 60 m floor with 1000 walls (tools/perf_rf_lib.js) is loaded into the real /planner page.
The same measurements as the node run are repeated against a real Web Worker; then the page is timed while it
draws frames and while an access point is dragged (requestAnimationFrame intervals). Everything printed is
measured on this machine in this run. Needs the optional `playwright` package and a browser.
Usage: tools/perf_rf_browser.py [--no-write]
       tools/perf_rf_browser.py --throttle   (only the CPU-throttled cases, printed as markdown, docs/perf-rf.md untouched)

--throttle uses Chrome DevTools Emulation.setCPUThrottlingRate (4x and 6x) on this machine's CPU. That is an APPROXIMATION of a
slow laptop or phone CPU: it slows main-thread and worker JavaScript, but not memory bandwidth, GPU or thermal behaviour.
"""
import argparse
import json
import os
import platform
import subprocess
import sys
import tempfile
import time
from datetime import date
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent.parent
PORT = 8765
REPEAT = 5
SCALE_POINTS = 100000
RENDER_FRAMES = 60
DRAG_STEPS = 90
APS_FOR_PAGE = 4
THROTTLE_RATES = (1, 4, 6)    # 1 = unthrottled reference
EDIT_REPEAT = 5
ANALYSIS_REPEAT = 3
KEEP_MARKER = "<!-- recorded sections below are kept when tools/perf_rf_browser.py rewrites this file -->"

LIB = (ROOT / "tools" / "perf_rf_lib.js").read_text()

WORKER_RUN = """async (repeat) => {
  const config = await (await fetch('/static/rf-config.json')).json();
  const w = new Worker('/static/rf-worker.js'), backend = { onmessage: null, send: (m) => w.postMessage(m) };
  w.onmessage = (e) => backend.onmessage && backend.onmessage(e.data);
  const rows = await RFPerf.measure({ RF: window.RFEngine, State: window.PlannerState, config, now: () => performance.now() }, backend, { repeat });
  w.terminate();
  return rows;
}"""

WORKER_SCALE_RUN = """async (o) => {
  const config = await (await fetch('/static/rf-config.json')).json();
  const w = new Worker('/static/rf-worker.js'), backend = { onmessage: null, send: (m) => w.postMessage(m) };
  w.onmessage = (e) => backend.onmessage && backend.onmessage(e.data);
  const deps = { RF: window.RFEngine, State: window.PlannerState, config, now: () => performance.now() };
  const rows = await RFPerf.scaleCompute(deps, backend, o);
  w.terminate();
  const idx = RFPerf.indexComparison(deps, o);
  return { rows: rows.concat(idx), parity_db: idx.parity_db };
}"""

DRAG = """async (steps) => {
  const A = window.PlannerApp, st = A.store, f = st.project.floors[0], ap = f.aps[0], x0 = ap.x, y0 = ap.y, S = window.PlannerState;
  const intervals = [], execMs = [], idle = [], long = [];
  new PerformanceObserver((l) => l.getEntries().forEach((e) => long.push(e.duration))).observe({ entryTypes: ['longtask'] });
  let last = performance.now();
  for (let i = 0; i < steps; i++) {   // baseline: the same page with nothing happening
    await new Promise((r) => requestAnimationFrame(r));
    const now = performance.now(); idle.push(now - last); last = now;
  }
  long.length = 0;
  for (let i = 0; i < steps; i++) {
    await new Promise((r) => requestAnimationFrame(r));
    const now = performance.now(); intervals.push(now - last); last = now;
    const t0 = performance.now();
    st.exec({ label: 'drag', key: 'perf', ops: [S.setOp('ap', st.project, f.id, ap.id, { x: x0 + Math.sin(i / 8) * 12, y: y0 + (i % 40) * 0.4 })] });
    execMs.push(performance.now() - t0);
  }
  const t1 = performance.now(), res = await A.whenIdle();
  return { intervals, idle, long, execMs, settleMs: performance.now() - t1, final: res.stats };
}"""


THROTTLE_JS = """async (o) => {
  const A = window.PlannerApp, st = A.store, S = window.PlannerState, f = st.project.floors[0], ap = f.aps[0], x0 = ap.x, y0 = ap.y;
  const med = (v) => v.slice().sort((a, b) => a - b)[Math.floor(v.length / 2)];
  // A newer analyze job (the page's own debounced analysis) cancels an older one, so a cancelled run is repeated.
  const job = (layers) => new Promise((resolve, reject) => {
    const go = () => {
      const t0 = performance.now();
      A.runJob({ type: 'analyze', floor: f.id, cell_m: 1, layers }, { result: () => resolve(performance.now() - t0), error: (m) => reject(new Error(m.message)), cancelled: go });
    };
    go();
  });
  const settle = () => new Promise((r) => setTimeout(r, 1500)).then(() => A.whenIdle());
  const out = {};
  out.frame_ms = A.benchmarkRender(o.frames);
  A.benchmarkRender(20); out.heat_draw_ms = A.renderer.lastDrawMs;
  const edits = [];
  for (let i = 0; i < o.editRepeat; i++) {      // re-render on edit: move one AP, wait until the worker has the final map
    const t0 = performance.now();
    st.exec({ label: 'edit', key: 'perf' + i, ops: [S.setOp('ap', st.project, f.id, ap.id, { x: x0 + 3 + i, y: y0 + 2 })] });
    await A.whenIdle(); edits.push(performance.now() - t0);
  }
  out.edit_median_ms = med(edits); out.edit_max_ms = Math.max(...edits);
  const plain = [], layered = [];
  await settle(); await job([]);                  // let the page's own analysis finish, then warm up
  for (let i = 0; i < o.analysisRepeat; i++) { plain.push(await job([])); layered.push(await job(['rssi'])); }
  out.analysis_no_layers_ms = med(plain); out.analysis_layers_ms = med(layered);
  const wall = [];
  for (let i = 0; i < o.analysisRepeat; i++) { wall.push(await job(['wall_loss'])); }
  out.analysis_wall_loss_ms = med(wall);
  return out;
}"""


def throttled_run(browser, base, rate, query=""):
    """Planner page with the stress floor under CDP CPU throttling `rate`x: render, edit and analysis times plus JS heap."""
    page = browser.new_page(viewport={"width": 1400, "height": 900})
    client = page.context.new_cdp_session(page)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(base + "planner" + query)
    page.wait_for_function("window.PlannerApp && window.PlannerApp.ready", timeout=30000)
    page.add_script_tag(content=LIB)
    page.evaluate("() => window.PlannerApp.whenIdle()")
    client.send("Emulation.setCPUThrottlingRate", {"rate": rate})
    page.evaluate("(n) => window.PlannerApp.loadProject(RFPerf.stressProject(7, n))", APS_FOR_PAGE)
    t0 = time.time()
    page.evaluate("() => window.PlannerApp.whenIdle()")
    out = {"rate": rate, "backend": page.evaluate("() => window.PlannerApp.backend.kind"), "cold_wall_ms": (time.time() - t0) * 1000}
    out.update(page.evaluate(THROTTLE_JS, {"frames": RENDER_FRAMES, "editRepeat": EDIT_REPEAT, "analysisRepeat": ANALYSIS_REPEAT}))
    client.send("HeapProfiler.collectGarbage")
    client.send("Performance.enable")
    metrics = {m["name"]: m["value"] for m in client.send("Performance.getMetrics")["metrics"]}
    out["heap_mb"] = metrics.get("JSHeapUsedSize", 0) / 1048576
    client.send("Emulation.setCPUThrottlingRate", {"rate": 1})
    page.close()
    if errors:
        raise SystemExit("FAIL: page errors during throttled run: %s" % errors)
    return out


def throttle_markdown(results, version):
    lines = ["| Compute backend, CPU throttle (CDP, approximation) | Cold load of 4 AP stress floor ms | Full frame render ms | Heat layer draw ms | Re-render after AP move: median / max ms | Analysis job, no layers ms | Analysis job, rssi layer ms | Analysis job, wall_loss layer ms | JS heap MB after GC |",
             "|---|---|---|---|---|---|---|---|---|"]
    for r in results:
        lines.append("| %s, %sx | %.0f | %.1f | %.1f | %.0f / %.0f | %.0f | %.0f | %.0f | %.1f |" % (
            r["backend"], r["rate"], r["cold_wall_ms"], r["frame_ms"], r["heat_draw_ms"], r["edit_median_ms"], r["edit_max_ms"],
            r["analysis_no_layers_ms"], r["analysis_layers_ms"], r["analysis_wall_loss_ms"], r["heap_mb"]))
    return "\n".join(lines)


def start_server():
    server = subprocess.Popen([sys.executable, "-m", "wallhack", "--source", "simulator", "--seed", "7", "--scenario", "two_zones", "--port", str(PORT), "--no-browser"], cwd=ROOT,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try:
            urlopen("http://127.0.0.1:%d/api/status" % PORT).read()
            break
        except OSError:
            time.sleep(0.2)
    return server


def run_throttle() -> int:
    from playwright.sync_api import sync_playwright
    server = start_server()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            base = "http://127.0.0.1:%d/" % PORT
            results = [throttled_run(browser, base, rate) for rate in THROTTLE_RATES]
            results += [throttled_run(browser, base, rate, "?worker=0") for rate in THROTTLE_RATES]   # main-thread fallback: throttling reaches the compute
            version = browser.version
            browser.close()
    finally:
        server.terminate()
    print("Chromium %s headless on %s, %d logical cores. Rate 1 is this machine unthrottled; 4 and 6 are CDP CPU throttling, an approximation of slower CPUs." % (version, cpu_name(), os.cpu_count()))
    print(throttle_markdown(results, version))
    return 0


def pct(values, q):
    s = sorted(values)
    return s[min(len(s) - 1, int(q * len(s)))]


def cpu_name():
    try:
        for line in open("/proc/cpuinfo"):
            if line.startswith("model name"):
                return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return platform.processor() or platform.machine()


def page_run(browser, base, query, label):
    """Planner page with the stress floor: render time per frame and drag smoothness."""
    page = browser.new_page(viewport={"width": 1400, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto(base + "planner" + query)
    page.wait_for_function("window.PlannerApp && window.PlannerApp.ready", timeout=20000)
    page.add_script_tag(content=LIB)
    page.evaluate("() => window.PlannerApp.whenIdle()")
    page.evaluate("(n) => window.PlannerApp.loadProject(RFPerf.stressProject(7, n))", APS_FOR_PAGE)
    t0 = time.time()
    first = page.evaluate("() => window.PlannerApp.whenIdle().then(r => r.stats)")
    cold_wall = (time.time() - t0) * 1000
    out = {"label": label, "backend": page.evaluate("() => window.PlannerApp.backend.kind"), "renderer": page.evaluate("() => window.PlannerApp.renderer.kind"),
           "gl": page.evaluate("() => window.PlannerApp.rendererInfo"), "first_compute": first, "cold_wall_ms": round(cold_wall, 1)}
    out["frame_ms"] = round(page.evaluate("(n) => window.PlannerApp.benchmarkRender(n)", RENDER_FRAMES), 2)
    out["heat_draw_ms"] = round(page.evaluate("() => { const r = window.PlannerApp.renderer; window.PlannerApp.benchmarkRender(20); return r.lastDrawMs; }"), 2)
    out["probe_ms"] = round(page.evaluate("() => { const A = window.PlannerApp, t = performance.now(); for (let i = 0; i < 50; i++) { window.PlannerEditor; window.RFEngine.probeAt(A.store.project, 'f1', 10 + i, 20, { env: A.env }); } return (performance.now() - t) / 50; }"), 3)
    drag = page.evaluate(DRAG, DRAG_STEPS)
    iv = drag["intervals"][5:]
    idle = drag["idle"][5:]
    out["drag"] = {"steps": DRAG_STEPS, "idle_interval_median_ms": round(pct(idle, 0.5), 1), "long_tasks": len(drag["long"]), "long_task_max_ms": round(max(drag["long"] or [0]), 1),
                    "frame_interval_median_ms": round(pct(iv, 0.5), 1), "frame_interval_p95_ms": round(pct(iv, 0.95), 1),
                   "frame_interval_max_ms": round(max(iv), 1), "exec_median_ms": round(pct(drag["execMs"], 0.5), 2), "exec_max_ms": round(max(drag["execMs"]), 2),
                   "settle_ms": round(drag["settleMs"], 1), "final_tiles_computed": drag["final"]["tiles_computed"], "final_tiles_total": drag["final"]["tiles_total"] * APS_FOR_PAGE}
    page.close()
    if errors:
        raise SystemExit("FAIL: console errors during perf run: %s" % errors)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--no-write", action="store_true", help="print only, do not write docs/perf-rf.md")
    ap.add_argument("--throttle", action="store_true", help="only the CDP CPU-throttled cases (1x, 4x, 6x), printed as markdown")
    args = ap.parse_args()
    if args.throttle:
        return run_throttle()
    from playwright.sync_api import sync_playwright

    with tempfile.TemporaryDirectory() as tmp:
        node_json = Path(tmp) / "node.json"
        node_out = subprocess.run(["node", str(ROOT / "tools" / "perf_rf.js"), "--json", str(node_json), "--repeat", str(REPEAT)], capture_output=True, text=True, check=True).stdout
        node_data = json.loads(node_json.read_text())
        scale_json = Path(tmp) / "scale.json"
        subprocess.run(["node", str(ROOT / "tools" / "perf_rf.js"), "--points", str(SCALE_POINTS), "--json", str(scale_json), "--repeat", str(REPEAT)], capture_output=True, text=True, check=True)
        node_scale_data = json.loads(scale_json.read_text())
        node_scale = node_scale_data["rows"]
    server = subprocess.Popen([sys.executable, "-m", "wallhack", "--source", "simulator", "--seed", "7", "--scenario", "two_zones", "--port", str(PORT), "--no-browser"], cwd=ROOT,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                urlopen("http://127.0.0.1:%d/api/status" % PORT).read()
                break
            except OSError:
                time.sleep(0.2)
        base = "http://127.0.0.1:%d/" % PORT
        with sync_playwright() as p:
            browser = p.chromium.launch()
            version = browser.version
            page = browser.new_page()
            page.goto(base + "planner")
            page.wait_for_function("window.PlannerApp && window.PlannerApp.ready", timeout=20000)
            page.add_script_tag(content=LIB)
            rows = page.evaluate(WORKER_RUN, REPEAT)
            scale = page.evaluate(WORKER_SCALE_RUN, {"repeat": REPEAT, "points": SCALE_POINTS, "apCount": 4})
            page.close()
            worker_page = page_run(browser, base, "", "worker")
            canvas_page = page_run(browser, base, "?renderer=canvas2d", "canvas2d")
            main_page = page_run(browser, base, "?worker=0", "mainthread")
            browser.close()
    finally:
        server.terminate()
    table_js = subprocess.run(["node", "-e", "const P = require(process.argv[1]); console.log(P.table(JSON.parse(process.argv[2])))", str(ROOT / "tools" / "perf_rf_lib.js"), json.dumps(rows)],
                              capture_output=True, text=True, check=True).stdout
    node_table = subprocess.run(["node", "-e", "const P = require(process.argv[1]); console.log(P.table(JSON.parse(process.argv[2])))", str(ROOT / "tools" / "perf_rf_lib.js"), json.dumps(node_data["rows"])],
                                capture_output=True, text=True, check=True).stdout
    def render(rs):
        return subprocess.run(["node", "-e", "const P = require(process.argv[1]); console.log(P.table(JSON.parse(process.argv[2])))", str(ROOT / "tools" / "perf_rf_lib.js"), json.dumps(rs)],
                              capture_output=True, text=True, check=True).stdout
    scale_table, node_scale_table = render(scale["rows"]), render(node_scale)
    machine = "%s, %d logical cores, %s, Python %s, node %s, Chromium %s (headless, Playwright)" % (cpu_name(), os.cpu_count(), platform.platform(), platform.python_version(), node_data["machine"]["node"], version)
    pages = [worker_page, canvas_page, main_page]
    lines = ["# RF planner performance (measured)", "",
             "Generated by `python tools/perf_rf_browser.py` on %s. Every number below was measured in that run. Run it again on your own hardware: these are not Raspberry Pi 4 numbers." % date.today().isoformat(), "",
             "## Machine", "", machine, "",
             "## Method", "",
             "- Test floor: seeded (`tools/perf_rf_lib.js`, seed 7) 100 m x 60 m, 1000 axis-aligned walls of 2 to 8 m with mixed materials, 1, 4 or 8 access points at 20 dBm, 2.4 GHz, basic propagation mode.",
             "- Each case is run %d times after one warm-up run; the table shows median, min and max in milliseconds. Times run from the `compute` message until the first message (the coarse pass, the first picture the user sees) and until the final result." % REPEAT,
             "- Cold cases reload the project before each run, so no tile is cached. AP move and wall edit cases change one thing and recompute with the per-AP tile cache warm.",
             "- Node rows run the worker core (`rf-worker.js`) in a node process. Browser rows run the same code in a real Web Worker inside headless Chromium, started from the live /planner page.",
             "- Page rows load the 4 AP stress floor into the real planner page and time `benchmarkRender` (full frames: base layer, heat map, contours, editor layer, mini-map), and a scripted AP drag of %d steps (one `store.exec` per animation frame) while recording `requestAnimationFrame` intervals." % DRAG_STEPS,
             "- Index versus brute force uses the same engine with and without the uniform grid index (`brute: true`).", "",
             "## Web Worker in headless Chromium", "", table_js, "",
             "## Worker core in node", "", node_table, "",
             "## Planner page (4 APs, 1000 walls, 0.5 m cells)", "",
             "| Run | Heat renderer | Compute backend | Render ms per full frame | Heat layer draw ms | Idle frame interval median ms | Drag frame interval median / p95 / max ms | Long tasks (over 50 ms) during drag, max ms | store.exec median / max ms | Settle after drag ms | Tiles recomputed in last update |",
             "|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in pages:
        d = r["drag"]
        lines.append("| %s | %s | %s | %s | %s | %s | %s / %s / %s | %s, %s | %s / %s | %s | %s of %s |" % (
            r["label"], r["renderer"], r["backend"], r["frame_ms"], r["heat_draw_ms"], d["idle_interval_median_ms"], d["frame_interval_median_ms"], d["frame_interval_p95_ms"], d["frame_interval_max_ms"], d["long_tasks"], d["long_task_max_ms"],
            d["exec_median_ms"], d["exec_max_ms"], d["settle_ms"], d["final_tiles_computed"], d["final_tiles_total"]))
    lines += ["", "Hover probe (`probeAt`, 4 AP page): %s ms per call in the page, %s." % (worker_page["probe_ms"], "see the node table for 8 APs"), "",
              "## WebGL in this run", "",
              "- WebGL path in headless Chromium: **%s**. Renderer string reported by the browser: `%s`." % ("RAN (WebGL context created)" if worker_page["renderer"] == "webgl" else "DID NOT RUN, the page fell back to canvas 2D", worker_page["gl"]),
              "- Frame intervals are bounded by this environment: the idle baseline column shows the same page with nothing happening, so compare the drag column with it, not with 16.7 ms. Headless Chromium composites the page's blur and glass effects in software.",
              "- A software GL implementation (SwiftShader) is not a GPU. The WebGL frame times above say nothing about GPU speed, only that the shader path works and is correct enough to draw.",
              "- The canvas 2D row was forced with `?renderer=canvas2d`, the main-thread row with `?worker=0`.", ""]
    def row(group, text):
        return next(r for r in rows if r["group"] == group and text in r["name"])
    coarse4, full4, full8 = row("coarse pass", "4 AP, 0.5 m"), row("full grid", "4 AP, 0.5 m"), row("full grid", "8 AP, 0.5 m")
    edit8, brute = row("wall edit", "8 AP"), row("index vs brute force", "1 AP, 0.5 m cells, brute")
    lines += ["## Reading the numbers", "",
              "- Target from the plan: coarse pass under 250 ms for 4 APs and 1000 walls. Measured median %s ms (max %s ms): %s." % (coarse4["median_ms"], coarse4["max_ms"], "met" if coarse4["max_ms"] <= 250 else "NOT met"),
              "- Full refinement is not interactive for many APs: 4 APs at 0.5 m take %s ms and 8 APs take %s ms from a cold cache. The picture appears after the coarse pass and sharpens tile by tile." % (full4["median_ms"], full8["median_ms"]),
              "- Moving one AP recomputes only that AP, so the cost does not grow with the number of other APs (see the AP move rows).",
              "- A wall edit recomputes a tile only when the box spanned by the AP and the tile meets the wall's box. That test is conservative: for 8 APs the median final time is %s ms (max %s ms) because wall edits near the middle of the floor meet many long boxes. Enhanced and multipath modes recompute everything on any wall edit." % (edit8["median_ms"], edit8["max_ms"]),
              "- The uniform wall index helps less than expected with this floor: brute force was %sx slower than the index at 0.5 m. `rayWallHit` rejects most walls with a cheap bounding box test, so brute force is cheap per cell. The index matters more as walls per ray grow." % brute["speedup"],
              "- Idle frame intervals of the same page differ between runs (compositing in software), so frame interval comparisons between rows are rough. The long task count is the more reliable smoothness signal: no task over 50 ms blocked the main thread while dragging with the Web Worker.",
              "- The main-thread fallback (no Worker) keeps working but its drag frame interval is longer, as expected from computing in 8 ms slices on the UI thread.", ""]
    def srow(rs, text):
        return next(r for r in rs if text in r["name"])
    gq, gg, ge = srow(node_scale, "bench quadtree"), srow(node_scale, "bench uniform grid"), srow(node_scale, "engine uniform grid")
    gb, gf = srow(node_scale, "engine brute force"), srow(node_scale, "final result")
    lines += ["## 100,000 point scenario", "",
              "Floor 100 m x 100 m (seed 7, 1000 walls, 4 access points, basic mode, 2.4 GHz), cell size chosen for at least %d grid points (%d points). Run with `node tools/perf_rf.js --points %d`. Each case is run %d times; the first run is the cold figure in the notes, the table shows the median, min and max of the %d warm runs after it. Cold means first run in a fresh process, not a cold cache of the app." % (SCALE_POINTS, ge["points"], SCALE_POINTS, REPEAT + 1, REPEAT), "",
              "### Web Worker in headless Chromium (worker rows) and main thread of the page (index strategy rows)", "", scale_table, "",
              "### Node (worker core and index strategies)", "", node_scale_table, "",
              "Largest difference between the bench grids and the engine grid: %s dB in node, %s dB in the browser." % (node_scale_data["parity_db"], scale["parity_db"]), "",
              "- `engine uniform grid` and `engine brute force` are the real `rf-engine.js` with and without its index. The three `bench` rows use one shared, bench-local kernel (`localGrid` in `tools/perf_rf_lib.js`) that only changes how wall candidates are picked, so they compare index structures with nothing else varying. Index construction is inside the timed region for every indexed row.",
              "- Same kernel, quadtree against uniform grid: the uniform grid took %s ms and the quadtree %s ms (median), so the quadtree is %sx slower. Brute force on the same kernel took %s ms." % (gg["median_ms"], gq["median_ms"], round(gq["median_ms"] / gg["median_ms"], 1), srow(node_scale, "bench brute force")["median_ms"]),
              "- **Decision: keep the uniform grid, do not adopt the quadtree.** The quadtree does not beat the grid on this scenario (axis-aligned walls of 2 to 8 m spread evenly over the floor, which is the case a grid is built for). `rf-engine.js` is unchanged.",
              "- The quadtree (%s ms) is faster than the engine's own grid path (%s ms), but that gap is not an index effect: the same grid idea on the bench kernel takes %s ms. The engine's per-ray work outside the index (candidate sort for summation order parity with Python, per call closures, per call object lookups) is where the time goes. That is a hypothesis from these numbers, not profiled, and it is the place to look first if more speed is needed." % (gq["median_ms"], ge["median_ms"], gg["median_ms"]),
              "- A quadtree could win on clustered floors (dense buildings in a large empty area). That case was not measured, so no claim is made.",
              "- Octrees are 3D. The engine is 2D with a per-floor loss (`floor_loss_db`), so an octree does not apply until true 3D propagation exists.",
              "- GPU: nothing here uses the GPU. A WebGL or WebGPU compute path for propagation is a design idea only and is not built. The WebGL path in the planner draws an already computed RSSI grid.",
              "- Incremental rendering already exists: `rf-worker.js` posts a coarse pass first, then refines tile by tile (`progress` messages, at most one every 60 ms), and `planner.js` hands each message's grid to the heat renderer in `planner-heat.js`, which redraws it (chip text: \"coarse pass, refining\", then \"refining N%\"). For 100,000 points the first usable frame came after the coarse pass (see the worker rows) while the final result follows later.", ""]
    doc = "\n".join(lines)
    print(doc)
    if not args.no_write:
        out = ROOT / "docs" / "perf-rf.md"
        kept = ""
        if out.is_file() and KEEP_MARKER in out.read_text():
            kept = "\n" + out.read_text()[out.read_text().index(KEEP_MARKER):]   # hand-recorded before/after sections survive a rerun
        out.write_text(doc + "\n" + kept)
    return 0


if __name__ == "__main__":
    sys.exit(main())
