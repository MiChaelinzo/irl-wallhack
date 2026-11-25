#!/usr/bin/env node
"use strict";
// Node timings of the V2 features (signal timeline, what-if, recommendations, network design) on the seeded stress floor
// and on the large_home preset. Prints a markdown table of medians. Usage: node tools/perf_rf_v2.js [--repeat N]
// Node only, one thread, not a Raspberry Pi 4 figure. Same method as tools/perf_rf.js (median, min and max of N runs after one warm-up).
const fs = require("fs"), path = require("path"), os = require("os");
const STATIC = path.join(__dirname, "..", "wallhack", "static");
const RF = require(path.join(STATIC, "rf-engine.js")), Opt = require(path.join(STATIC, "rf-optimizer.js"));
const Perf = require("./perf_rf_lib.js");
const config = JSON.parse(fs.readFileSync(path.join(STATIC, "rf-config.json"), "utf8"));
const scen = JSON.parse(fs.readFileSync(path.join(STATIC, "scenarios.json"), "utf8")).scenarios.find((s) => s.id === "large_home").project;
const args = process.argv.slice(2), repeat = args.indexOf("--repeat") >= 0 ? parseInt(args[args.indexOf("--repeat") + 1], 10) : 5;
const now = () => Number(process.hrtime.bigint()) / 1e6;
const env = RF.makeEnv(config);

function time(fn) {
  fn();
  const t = [];
  for (let i = 0; i < repeat; i++) { const s = now(); fn(); t.push(now() - s); }
  t.sort((a, b) => a - b);
  return [t[Math.floor(t.length / 2)], t[0], t[t.length - 1]].map((v) => Math.round(v * 10) / 10);
}
function zigzag(floorId, w, d, legs) {
  const p = [];
  for (let i = 0; i <= legs; i++) { p.push({ floor: floorId, x: i % 2 ? w - 5 : 5, y: 5 + (d - 10) * i / legs }); }
  return p;
}
const rows = [];
function add(name, fn, note) { const [m, lo, hi] = time(fn); rows.push([name, m, lo, hi, note || ""]); }

[1, 4].forEach((n) => {
  const p = Perf.stressProject(7, n);
  const f = p.floors[0], path1 = zigzag(f.id, f.width_m, f.depth_m, 6);
  let last;
  add("timeline, stress floor, " + n + " AP, 1000 walls", () => { last = RF.signalTimeline(p, path1, { env }); }, last ? "" : "~1 sample per 0.5 m");
  rows[rows.length - 1][4] = last.samples.length + " samples";
});
const big = Perf.stressProject(7, 4);
add("what-if move one AP, stress floor, 4 AP, 1000 walls", () => { Opt.whatIf(big, "f1", { kind: "move_ap", ap_id: "ap1", x: 20, y: 20 }, { env, config }); }, "nominal run plus perturbation runs");
add("what-if move one AP, large_home preset", () => { Opt.whatIf(scen, scen.floors[0].id, { kind: "move_ap", ap_id: scen.floors[0].aps[0].id, x: 5, y: 5 }, { env, config }); });
add("recommend (ranked actions), large_home preset", () => { Opt.recommend(scen, scen.floors[0].id, { env, config }); });
add("designNetwork, large_home preset", () => { Opt.designNetwork(scen, scen.floors[0].id, { env, config }); });
console.log("V2 features, node " + process.version + ", " + os.cpus()[0].model + " x" + os.cpus().length + ", " + repeat + " runs after one warm-up\n");
console.log("| Measurement | Median ms | Min | Max | Notes |\n|---|---|---|---|---|");
rows.forEach((r) => console.log("| " + r.join(" | ") + " |"));
