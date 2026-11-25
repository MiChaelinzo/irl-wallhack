# 04 Folder structure

## Current

```
irl-wallhack/
  wallhack/            Python package: app, runtime, rfmodel, twin, llm, pairing, qr, processing, insights, ...
    collectors/        platform collectors (linux, macos, windows, ping, udp_csi, nexmon)
    sensors/           environment sensor drivers
    static/            all browser code, CSS, HTML, rf-config.json and schema (26 files, flat)
  tests/               34 test modules, fixtures/
  tools/               build_demo, material_doc, perf_rf*, planner_smoke, screenshot, csi_forwarder
  docs/                adr-rf-engine, rf-planner, perf-rf, hardware, screenshots, platform/
  scripts/             pi_setup.sh
  data/                runtime data (twin file)
  .github/workflows/   ci.yml
  vercel.json, tsconfig.json, Makefile, install.* and run.* scripts
```

The flat `wallhack/static/` is the main smell: dashboard files (`app.js`, `panels.js`, `twin.js`, `mobile.js`, `judge.js`, `game.js`) sit next to engine, planner and 3D files.

## Proposed (DESIGN ONLY, not applied)

```
wallhack/static/
  engine/    rf-engine.js, rf-worker.js, rf-optimizer.js, rf-config.json, rf-config.schema.json
  planner/   planner*.js, planner.html
  dashboard/ app.js, panels.js, twin.js, mobile.js, judge.js, game.js, view3d.js, index.html ...
  shared/    common.js, style.css
```

Why not now: the tests and the demo builder reference paths under `wallhack/static/` directly (`tests/test_rf_parity.py`, `tests/test_static.py`, `tools/build_demo.py`, `tools/perf_rf_lib.js`, `wallhack/rfmodel.py` `CONFIG_PATH`). Moving files is a mechanical but wide change with a real regression risk and no user-visible gain. Do it with the next planned editor split, in its own commit, with `git mv` and the test suite as the safety net.

Also proposed: `docs/platform/` stays the single home for design docs; `docs/adr-*.md` stays for decisions already made (the new frontend ADR lives in `docs/platform/adr-frontend-stack.md` to keep this audit set together).
