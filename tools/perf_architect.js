#!/usr/bin/env node
"use strict";
// Node timings of the Wi-Fi architect features (rf-insight.js) and the path counts of one planner update.
// Usage: node tools/perf_architect.js [--repeat N]. One thread, not a Raspberry Pi 4 figure. Median, min and max of N runs after one warm-up.
// "Ray" in this file means one source-to-cell path evaluation: one call of the direct (basic), image-method reflected or diffracted
// path function for one access point and one grid cell. The counts come from an instrumented copy of rf-engine.js (counters inserted
// by text replacement at load time, the file on disk is untouched), so they are exact for the mode and grid used.
const fs = require("fs"), path = require("path"), os = require("os"), vm = require("vm");
const STATIC = path.join(__dirname, "..", "wallhack", "static");
const RF = require(path.join(STATIC, "rf-engine.js")), Opt = require(path.join(STATIC, "rf-optimizer.js")), Ins = require(path.join(STATIC, "rf-insight.js"));
const Perf = require("./perf_rf_lib.js");
const config = JSON.parse(fs.readFileSync(path.join(STATIC, "rf-config.json"), "utf8"));
const scenarios = JSON.parse(fs.readFileSync(path.join(STATIC, "scenarios.json"), "utf8")).scenarios;
const args = process.argv.slice(2), repeat = args.indexOf("--repeat") >= 0 ? parseInt(args[args.indexOf("--repeat") + 1], 10) : 5;
const now = () => Number(process.hrtime.bigint()) / 1e6;
const env = RF.makeEnv(config);
const preset = (id) => JSON.parse(JSON.stringify(scenarios.find((s) => s.id === id).project));

function time(fn) {
  fn();
  const t = [];
  for (let i = 0; i < repeat; i++) { const s = now(); fn(); t.push(now() - s); }
  t.sort((a, b) => a - b);
  return [t[Math.floor(t.length / 2)], t[0], t[t.length - 1]].map((v) => Math.round(v * 10) / 10);
}
const rows = [];
function add(name, fn, note) { const [m, lo, hi] = time(fn); rows.push([name, m, lo, hi, note || ""]); }

// ---- timings on presets
const SIM = [["small_apartment", 0.5], ["large_home", 0.5], ["hotel_floor", 0.5]];
SIM.forEach(([id, cell]) => {
  const p = preset(id), fl = p.floors[0], ap = fl.aps[0], o = { env, config, cellM: cell };
  const cells = Math.ceil(fl.width_m / cell) * Math.ceil(fl.depth_m / cell);
  add("simulate after an AP move (analyze), " + id + ", " + cell + " m cells", () => {
    const q = JSON.parse(JSON.stringify(p)); q.floors[0].aps[0].x += 1; Ins.analyze(q, fl.id, o);
  }, cells + " cells, " + fl.aps.length + " AP");
  add("roomStats, " + id, () => { Ins.roomStats(p, fl.id, null, o); });
  add("gamerMode, " + id, () => { Ins.gamerMode(p, fl.id, o); });
  add("scoreCard, " + id, () => { Ins.scoreCard(p, fl.id, o); });
  add("diagnose, " + id, () => { Ins.diagnose(p, fl.id, "Why is my " + fl.rooms[0].name.toLowerCase() + " WiFi slow?", o); }, "includes a second engine run per tested fix");
  add("placementReport, " + id, () => { Ins.placementReport(p, fl.id, Object.assign({ apId: ap.id }, o)); }, "searches the optimizer candidate lattice");
  add("meshTopologies, " + id, () => { Ins.meshTopologies(p, fl.id, o); }, "single, dual and whole-home");
  add("timeMachine, " + id + ", 3 versions", () => { Ins.timeMachine(Ins.presetItems(p, fl.id, o).slice(0, 3).concat([]), Object.assign({ floorId: fl.id }, o)); }, "preset items built inside the timed call");
});
const stress = Perf.stressProject(7, 4);
add("simulate after an AP move (analyze), stress floor 4 AP 1000 walls, 0.5 m", () => {
  const q = JSON.parse(JSON.stringify(stress)); q.floors[0].aps[0].x += 1; Ins.analyze(q, "f1", { env, config, cellM: 0.5 });
}, "24,000 cells");
add("what-if move one AP (optimizer), stress floor 4 AP", () => { Opt.whatIf(stress, "f1", { kind: "move_ap", ap_id: "ap1", x: 20, y: 20 }, { env, config }); }, "known miss against 100 ms");

// ---- path counts from an instrumented copy of the engine
function instrumented() {
  let src = fs.readFileSync(path.join(STATIC, "rf-engine.js"), "utf8");
  const counters = { direct: 0, reflected: 0, reflected_hit: 0, diffracted: 0 };
  const patch = (name) => {
    const sig = "function " + name + "(";
    if (src.indexOf(sig) < 0) { throw new Error("rf-engine.js has no " + name + ", update tools/perf_architect.js"); }
    src = src.replace(sig, "function __orig_" + name + "(");
  };
  // Rename the originals and add counting wrappers in the same closure by editing before the registerMode lines.
  ["basicDbm", "reflectedDbm", "diffractedDbm"].forEach((n) => patch(n));
  const wrappers = "function basicDbm(c, x, y) { __C.direct++; return __orig_basicDbm(c, x, y); }\n" +
    "function reflectedDbm(c, w, x, y) { __C.reflected++; var v = __orig_reflectedDbm(c, w, x, y); if (v !== null) { __C.reflected_hit++; } return v; }\n" +
    "function diffractedDbm(c, k, x, y) { __C.diffracted++; return __orig_diffractedDbm(c, k, x, y); }\n";
  src = src.replace('registerMode("basic", basicDbm);', wrappers + 'registerMode("basic", basicDbm);');
  const sandbox = { module: { exports: {} }, exports: {}, __C: counters, console, Math, Float32Array, Float64Array, Object, Array, Error, JSON };
  sandbox.window = undefined; sandbox.self = undefined;
  vm.runInNewContext(src, sandbox, { filename: "rf-engine-instrumented.js" });
  return { E: sandbox.module.exports, counters };
}
const counts = [];
function countCase(label, project, floorId, cell, mode) {
  const inst = instrumented(), e = inst.E.makeEnv(config);
  const t = now();
  inst.E.analyzeFloorWithGrid(JSON.parse(JSON.stringify(project)), floorId, { env: e, cellM: cell, mode: mode });
  const ms = now() - t, c = inst.counters, evals = c.direct + c.reflected + c.diffracted;
  counts.push([label, mode, c.direct, c.reflected, c.reflected_hit, c.diffracted, evals, Math.round(ms * 10) / 10]);
}
SIM.forEach(([id, cell]) => { const p = preset(id); countCase(id + ", " + cell + " m", p, p.floors[0].id, cell, "basic"); });
SIM.forEach(([id, cell]) => { const p = preset(id); countCase(id + ", " + cell + " m", p, p.floors[0].id, cell, "multipath"); });
countCase("stress floor 4 AP, 0.5 m", stress, "f1", 0.5, "basic");
// multipath at 0.5 m on this floor is 69.4 million evaluations and about 5 minutes, so it runs on a 2 m grid here.
countCase("stress floor 4 AP, 2 m", stress, "f1", 2, "multipath");

console.log("Wi-Fi architect, node " + process.version + ", " + os.cpus()[0].model + " x" + os.cpus().length + ", " + repeat + " runs after one warm-up\n");
console.log("| Measurement | Median ms | Min | Max | Notes |\n|---|---|---|---|---|");
rows.forEach((r) => console.log("| " + r.join(" | ") + " |"));
console.log("\nPath evaluations of one engine run (one 'ray' = one direct, reflected or diffracted path function call for one AP and one cell)\n");
console.log("| Case | Mode | Direct | Reflected tried | Reflected valid | Diffracted | Total path evaluations | Run ms (instrumented) |\n|---|---|---|---|---|---|---|---|");
counts.forEach((r) => console.log("| " + r.join(" | ") + " |"));
