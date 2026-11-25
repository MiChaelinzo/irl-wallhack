#!/usr/bin/env node
"use strict";
// Node performance run of the RF engine and the worker core on a seeded 100 m x 60 m floor with 1000 walls.
// Usage: node tools/perf_rf.js [--json out.json] [--repeat N] [--points N [--aps K]]
// --points N runs only the large-floor scenario (100 m x 100 m, 1000 walls, at least N grid points): worker core compute plus the wall index strategies.
const fs = require("fs"), path = require("path"), os = require("os");
const STATIC = path.join(__dirname, "..", "wallhack", "static");
const RF = require(path.join(STATIC, "rf-engine.js")), State = require(path.join(STATIC, "planner-state.js")), W = require(path.join(STATIC, "rf-worker.js"));
const Perf = require("./perf_rf_lib.js");
const config = JSON.parse(fs.readFileSync(path.join(STATIC, "rf-config.json"), "utf8"));
const args = process.argv.slice(2), arg = (k) => (args.indexOf(k) >= 0 ? args[args.indexOf(k) + 1] : null);

const backend = { onmessage: null, send: null };
const core = W.createCore({ RF, State }, (m) => backend.onmessage && backend.onmessage(m));
backend.send = (msg) => { core.handle(msg); };
const deps = { RF, State, config, now: () => Number(process.hrtime.bigint()) / 1e6 };
const repeat = parseInt(arg("--repeat") || "5", 10), points = arg("--points") ? parseInt(arg("--points"), 10) : 0, apCount = parseInt(arg("--aps") || "4", 10);
let parityDb = null;
const job = points > 0
  ? Perf.scaleCompute(deps, backend, { repeat, points, apCount }).then((rows) => {
    const idx = Perf.indexComparison(deps, { repeat, points, apCount });
    parityDb = idx.parity_db;
    console.log("max |bench grids - engine grid|: " + idx.parity_db.toExponential(2) + " dB\n");
    return rows.concat(idx);
  })
  : Perf.measure(deps, backend, { repeat });
job.then((rows) => {
  const machine = { cpu: os.cpus()[0].model, cores: os.cpus().length, node: process.version, platform: process.platform + " " + os.release() };
  console.log("RF engine and worker core, node, " + machine.cpu + " x" + machine.cores + ", node " + machine.node + "\n");
  console.log(Perf.table(rows));
  if (arg("--json")) { fs.writeFileSync(arg("--json"), JSON.stringify({ machine, rows, parity_db: parityDb }, null, 1)); }
}).catch((e) => { console.error(e); process.exit(1); });
