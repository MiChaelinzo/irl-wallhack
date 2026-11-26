# 21 Top 100 improvements

Ranked list of improvements, including what is already done. Status is **Done**, **Partial** or **Not started**. Every Done row names the file that implements it, and `tests/test_platform_docs.py` checks that each named file exists. Partial rows say what exists and what is missing.

## Scoring

Each criterion is scored 1 to 5 by the author (a judgement, not a measurement). Effort is 5 for the hardest. Composite score:

```
composite = 100 x (3 x Impact + 2 x UserBenefit + 2 x TechnicalValue + 2 x JudgeAppeal + 1 x Innovation + 2 x (6 - Effort)) / 60
```

Maximum 100 (all benefits 5, effort 1). Rows are ranked by composite, ties by list order. Columns: Impact, Effort, Technical value, Judge appeal, User benefit, Innovation.

Reading the list: Done rows with high composite are the strengths to demo. Not started rows with high composite are the roadmap ([20-roadmap.md](20-roadmap.md)). Rows with low judge appeal and low impact were included for completeness. A few Not started rows record decisions to wait (quadtree, React, Three.js): their low scores are the point.

| Rank | Item | Impact | Effort | Technical value | Judge appeal | User benefit | Innovation | Composite | Status | Evidence |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| 1 | Measured survey import (CSV of RSSI points) and model calibration | 5 | 4 | 5 | 5 | 5 | 4 | 88.3 | Not started | none |
| 2 | Python reference RF model (log-distance, walls, floors, modes) | 5 | 3 | 5 | 4 | 5 | 3 | 86.7 | Done | `wallhack/rfmodel.py`, `tests/test_rfmodel.py` |
| 3 | Web Worker with coarse-then-tile progressive results | 5 | 4 | 5 | 5 | 5 | 3 | 86.7 | Done | `wallhack/static/rf-worker.js`, `tests/test_rf_worker.py` |
| 4 | Floor plan extraction from an uploaded image | 5 | 5 | 5 | 5 | 5 | 5 | 86.7 | Not started | none |
| 5 | Wi-Fi 4 to 7 PHY rate from the 802.11 OFDM formula | 5 | 4 | 5 | 5 | 4 | 4 | 85.0 | Done | `wallhack/rfmodel.py`, `tests/test_wifi_standards.py`, `wallhack/static/planner-panels.js` |
| 6 | SINR with co-channel and adjacent-channel interference | 5 | 4 | 5 | 5 | 4 | 4 | 85.0 | Done | `wallhack/rfmodel.py`, `wallhack/static/rf-engine.js`, `wallhack/static/planner-heat.js` |
| 7 | Smart planner: greedy AP placement with confidence | 5 | 5 | 5 | 5 | 5 | 4 | 85.0 | Done | `wallhack/static/rf-optimizer.js`, `tests/test_rf_planner_js.py` |
| 8 | Analytics: coverage, quality bands, dead zones, capacity | 5 | 4 | 4 | 5 | 5 | 3 | 83.3 | Done | `tests/test_rf_analytics.py`, `wallhack/static/rf-engine.js` |
| 9 | Digital twin validation and persistence API | 5 | 3 | 5 | 4 | 4 | 3 | 83.3 | Done | `wallhack/twin.py`, `tests/test_twin_api.py` |
| 10 | Fit path-loss exponent and wall losses to survey data | 5 | 5 | 5 | 5 | 4 | 5 | 83.3 | Not started | none |
| 11 | Validation of the RF model against a real building survey | 5 | 4 | 5 | 5 | 4 | 3 | 83.3 | Not started | none |
| 12 | JavaScript engine port with Python parity tests | 5 | 4 | 5 | 4 | 4 | 4 | 81.7 | Done | `wallhack/static/rf-engine.js`, `tests/test_rf_parity.py` |
| 13 | Draw, drag, snap editor with undo and redo | 5 | 4 | 4 | 5 | 5 | 2 | 81.7 | Done | `wallhack/static/planner-editor.js`, `wallhack/static/planner-state.js` |
| 14 | Model-sensitivity confidence for recommendations | 4 | 3 | 5 | 5 | 3 | 5 | 81.7 | Done | `wallhack/static/rf-optimizer.js`, `docs/rf-planner.md` |
| 15 | Optional LLM, off by default, keys from env only | 4 | 3 | 4 | 5 | 4 | 4 | 80.0 | Done | `wallhack/llm.py`, `tests/test_insights.py` |
| 16 | Static demo build for Vercel with strict CSP | 5 | 3 | 3 | 5 | 4 | 3 | 80.0 | Done | `tools/build_demo.py`, `vercel.json`, `tests/test_demo_build.py` |
| 17 | Educational mode with guided lessons | 4 | 3 | 3 | 5 | 5 | 4 | 80.0 | Done | `wallhack/static/planner-learn.js`, `tests/test_planner_learn.py` |
| 18 | LLM explain endpoint for planner recommendations | 4 | 3 | 4 | 5 | 4 | 4 | 80.0 | Done | `wallhack/app.py`, `wallhack/llm.py`, `tests/test_explain.py` |
| 19 | Antenna orientation optimiser (azimuth search) | 4 | 3 | 4 | 5 | 4 | 4 | 80.0 | Not started | none |
| 20 | Phone coverage test feeding measured points back | 4 | 4 | 4 | 5 | 5 | 4 | 80.0 | Not started | none |
| 21 | WebGL heat map with canvas fallback | 4 | 4 | 4 | 5 | 5 | 3 | 78.3 | Done | `wallhack/static/planner-heat.js`, `tests/test_planner_heat.py` |
| 22 | Scenario compare with explainable optimisation score | 4 | 3 | 4 | 5 | 4 | 3 | 78.3 | Done | `wallhack/static/rf-engine.js`, `wallhack/static/rf-config.json` |
| 23 | AP count recommendation for a coverage target | 4 | 3 | 4 | 4 | 5 | 3 | 78.3 | Done | `wallhack/static/rf-optimizer.js` |
| 24 | PDF coverage report written without a library | 4 | 4 | 4 | 5 | 5 | 3 | 78.3 | Done | `wallhack/static/planner-export.js` |
| 25 | Opt-in LAN mode with pairing token | 4 | 3 | 5 | 4 | 4 | 3 | 78.3 | Done | `wallhack/pairing.py`, `tests/test_pairing.py` |
| 26 | True 3D propagation (slabs, stairwells, ceiling heights) | 5 | 5 | 5 | 4 | 4 | 4 | 78.3 | Not started | none |
| 27 | Wireless consultant chat grounded in engine numbers | 4 | 4 | 4 | 5 | 4 | 5 | 78.3 | Partial | `wallhack/static/rf-insight.js` (`diagnose` and `parseQuestion`: a rule-based Assistant for one room question with ranked causes and tested fixes; the optional LLM rephrase is UNVERIFIED and there is no free-form chat) |
| 28 | Floor plan image import with scale calibration | 4 | 3 | 3 | 5 | 5 | 2 | 76.7 | Done | `wallhack/static/planner-editor.js`, `wallhack/static/planner.html` |
| 29 | Explicit consent before cloud LLM calls | 3 | 2 | 4 | 5 | 4 | 3 | 76.7 | Done | `wallhack/llm.py`, `wallhack/app.py` |
| 30 | Joint channel and power optimisation with SINR objective | 4 | 4 | 5 | 4 | 4 | 4 | 76.7 | Partial | `wallhack/static/rf-optimizer.js` (`planChannelsSinr` maximises mean SINR over channels; power is advised separately, no joint search) |
| 31 | Interference-aware placement (SINR in the greedy score) | 4 | 4 | 5 | 4 | 4 | 4 | 76.7 | Not started | none |
| 32 | Single shared rf-config.json for every RF constant | 4 | 2 | 5 | 3 | 3 | 3 | 75.0 | Done | `wallhack/static/rf-config.json` |
| 33 | Ten-family material database with ranges and sources | 4 | 3 | 4 | 4 | 4 | 3 | 75.0 | Done | `wallhack/static/rf-config.json`, `docs/platform/material-database.md` |
| 34 | Antenna gain, azimuth and sector pattern | 4 | 3 | 4 | 4 | 4 | 3 | 75.0 | Done | `wallhack/rfmodel.py`, `tests/test_wifi_standards.py` |
| 35 | Wi-Fi 7 MLO capacity model | 3 | 2 | 4 | 5 | 3 | 4 | 75.0 | Done | `wallhack/rfmodel.py`, `tests/test_wifi_standards.py`, `wallhack/static/planner-panels.js` |
| 36 | Channel planning to reduce co-channel conflicts | 4 | 3 | 4 | 4 | 4 | 3 | 75.0 | Done | `wallhack/static/rf-optimizer.js` |
| 37 | 3D building view with signal map | 4 | 4 | 4 | 5 | 4 | 3 | 75.0 | Done | `wallhack/static/view3d.js`, `wallhack/static/planner-3d.js`, `tests/test_view3d.py`, `tests/test_planner_3d.py` |
| 38 | Measured 100,000 point benchmark | 4 | 3 | 5 | 5 | 2 | 3 | 75.0 | Done | `docs/perf-rf.md`, `tools/perf_rf.js` |
| 39 | Deterministic rule-based insights | 4 | 3 | 4 | 4 | 4 | 3 | 75.0 | Done | `wallhack/insights.py`, `tests/test_insights.py` |
| 40 | AP placement game with Python/JS score parity | 3 | 3 | 4 | 5 | 4 | 4 | 75.0 | Done | `wallhack/game.py`, `tests/test_game_parity.py` |
| 41 | Camera room scan and AR router placement | 4 | 5 | 4 | 5 | 4 | 5 | 75.0 | Not started | none |
| 42 | Hardware validation of CSI sensing on a real Pi 4 | 4 | 4 | 5 | 5 | 3 | 3 | 75.0 | Not started | none |
| 43 | Uniform-grid wall index (1000+ walls) | 4 | 3 | 5 | 3 | 4 | 2 | 73.3 | Done | `wallhack/static/rf-engine.js`, `docs/perf-rf.md` |
| 44 | Project JSON export and validated import | 4 | 3 | 4 | 3 | 5 | 2 | 73.3 | Done | `wallhack/static/planner-state.js`, `tests/test_planner_state.py` |
| 45 | Enhanced mode: single reflection and knife-edge diffraction | 4 | 4 | 5 | 4 | 3 | 3 | 71.7 | Done | `wallhack/rfmodel.py`, `tests/test_rfmodel.py` |
| 46 | Multi-floor stack analysis | 4 | 4 | 4 | 4 | 4 | 3 | 71.7 | Done | `wallhack/static/rf-worker.js`, `wallhack/static/planner-modes.js` |
| 47 | Presence, motion and breathing signal processing | 4 | 4 | 4 | 5 | 3 | 3 | 71.7 | Done | `wallhack/processing.py`, `tests/test_processing.py` |
| 48 | Honest VERIFIED / UNVERIFIED table | 3 | 1 | 3 | 5 | 3 | 2 | 71.7 | Done | `README.md`, `tests/test_judge.py` |
| 49 | Door and window editing in the planner UI | 4 | 3 | 3 | 4 | 5 | 1 | 71.7 | Done | `wallhack/static/planner-editor.js`, `tools/planner_smoke.py` |
| 50 | DNS-rebinding defence (Host allow list) | 3 | 2 | 5 | 3 | 3 | 3 | 70.0 | Done | `wallhack/app.py`, `tests/test_pairing.py` |
| 51 | QR code encoder for phone pairing (no dependency) | 3 | 3 | 4 | 4 | 4 | 3 | 70.0 | Done | `wallhack/qr.py`, `tests/test_qr.py` |
| 52 | Consent and privacy notice in the README | 3 | 1 | 3 | 4 | 4 | 1 | 70.0 | Done | `README.md` |
| 53 | Profile and close the 4x gap between engine grid path and bench grid kernel | 4 | 3 | 5 | 3 | 3 | 2 | 70.0 | Partial | `docs/perf-rf.md` (engine grid path improved from 1675 to 684.6 ms in node; a gap to the bench kernel remains) |
| 54 | Ray-launching or image-method ray tracing | 4 | 5 | 5 | 4 | 3 | 4 | 70.0 | Not started | none |
| 55 | CSV export with spreadsheet formula-injection guard | 3 | 2 | 4 | 3 | 4 | 2 | 68.3 | Done | `wallhack/static/planner-export.js` |
| 56 | PNG export with legend and annotations | 3 | 2 | 3 | 4 | 4 | 2 | 68.3 | Done | `wallhack/static/planner-export.js` |
| 57 | Bill of quantities CSV | 3 | 2 | 3 | 4 | 4 | 2 | 68.3 | Done | `wallhack/static/planner-modes.js` |
| 58 | Screen-reader text alternative for the heat map (summary table) | 3 | 2 | 3 | 3 | 5 | 2 | 68.3 | Partial | `wallhack/static/planner.html` (canvas aria-label only, no data table) |
| 59 | Multipath mode (incoherent sum) | 3 | 3 | 4 | 4 | 3 | 3 | 66.7 | Done | `wallhack/rfmodel.py`, `tests/test_rf_parity.py` |
| 60 | Transmit power advice (over and under powered) | 3 | 3 | 4 | 3 | 4 | 3 | 66.7 | Done | `wallhack/static/rf-optimizer.js` |
| 61 | Mesh planning with hop throughput | 3 | 3 | 4 | 4 | 3 | 3 | 66.7 | Done | `wallhack/static/planner-modes.js`, `wallhack/static/rf-insight.js` (meshTopologies: single, dual and whole-home side by side) |
| 62 | IoT device coverage check | 3 | 3 | 3 | 4 | 4 | 3 | 66.7 | Done | `wallhack/static/planner-modes.js` |
| 63 | Mobile companion page | 3 | 3 | 3 | 4 | 4 | 3 | 66.7 | Done | `wallhack/static/mobile.html`, `wallhack/static/mobile.js` |
| 64 | Judge mode page whose statuses are tested against the README | 3 | 2 | 3 | 5 | 2 | 3 | 66.7 | Done | `wallhack/judge.py`, `tests/test_judge.py` |
| 65 | Seeded simulator for sensing demos | 4 | 3 | 3 | 4 | 3 | 2 | 66.7 | Done | `wallhack/simulator.py`, `tests/test_simulator.py` |
| 66 | Spectrum and neighbour-network overlay from a scan | 3 | 3 | 3 | 4 | 4 | 3 | 66.7 | Partial | `wallhack/static/planner-panels.js` (Spectrum tab models the plan's own APs and sources; scan import is not built) |
| 67 | Real Vercel deployment check | 3 | 1 | 2 | 5 | 3 | 1 | 66.7 | Not started | none |
| 68 | Full WCAG 2.2 AA audit with assistive tech | 4 | 4 | 3 | 3 | 5 | 1 | 65.0 | Partial | `tools/a11y_check.py` (axe-core, 0 violations, keyboard and contrast checks; no screen reader or full WCAG 2.2 audit) |
| 69 | Roaming simulation along a walked path | 3 | 4 | 4 | 4 | 3 | 4 | 65.0 | Not started | none |
| 70 | Dark and light theme | 3 | 2 | 2 | 4 | 4 | 1 | 63.3 | Done | `wallhack/static/style.css` |
| 71 | Visible keyboard focus and ARIA roles on the planner | 3 | 2 | 3 | 3 | 4 | 1 | 63.3 | Done | `wallhack/static/planner.html`, `wallhack/static/style.css` |
| 72 | JSON Schema for rf-config with drift-proof tests | 3 | 2 | 4 | 3 | 2 | 2 | 61.7 | Done | `wallhack/static/rf-config.schema.json`, `tests/test_rf_config_schema.py` |
| 73 | Generated material doc kept in sync by a test | 3 | 1 | 3 | 3 | 2 | 2 | 61.7 | Done | `tools/material_doc.py`, `tests/test_rf_config_schema.py` |
| 74 | Same-origin and JSON-only checks on writes | 3 | 2 | 4 | 2 | 3 | 2 | 61.7 | Done | `wallhack/app.py`, `tests/test_api.py` |
| 75 | Session history and timeline | 3 | 3 | 3 | 4 | 3 | 2 | 61.7 | Done | `wallhack/history.py`, `tests/test_history.py` |
| 76 | Multi-user collaborative editing | 3 | 5 | 4 | 4 | 3 | 4 | 61.7 | Not started | none |
| 77 | Own bounded body limit for PUT /api/twin | 3 | 2 | 4 | 2 | 3 | 1 | 60.0 | Done | `wallhack/app.py`, `tests/test_twin_api.py` |
| 78 | CI on Python 3.9 and 3.12 with demo build | 3 | 2 | 4 | 3 | 2 | 1 | 60.0 | Done | `.github/workflows/ci.yml` |
| 79 | Keyboard shortcuts and help dialog | 3 | 2 | 2 | 3 | 4 | 1 | 60.0 | Done | `wallhack/static/planner.html`, `wallhack/static/planner-editor.js` |
| 80 | Raspberry Pi setup script | 3 | 3 | 3 | 3 | 4 | 1 | 60.0 | Done | `scripts/pi_setup.sh`, `tests/test_pi_setup.py` |
| 81 | Nexmon CSI parsing | 3 | 4 | 4 | 4 | 2 | 3 | 60.0 | Done | `wallhack/nexmon.py`, `tests/test_nexmon.py` |
| 82 | Automated axe or Lighthouse accessibility run in CI | 3 | 3 | 3 | 3 | 4 | 1 | 60.0 | Partial | `tools/a11y_check.py` (runs in the `browser` job of `.github/workflows/ci.yml`; the job is UNVERIFIED on GitHub, the script passed locally) |
| 83 | Cost estimator beyond bill of quantities | 3 | 2 | 2 | 3 | 4 | 1 | 60.0 | Not started | none |
| 84 | Campus-scale planning (many buildings) | 3 | 5 | 4 | 4 | 3 | 3 | 60.0 | Not started | none |
| 85 | GPU compute path (WebGPU) for coverage | 3 | 5 | 4 | 4 | 2 | 4 | 58.3 | Not started | none |
| 86 | IFC or DXF import | 3 | 4 | 3 | 3 | 4 | 2 | 58.3 | Not started | none |
| 87 | Headless planner CLI (project in, report out) | 3 | 3 | 3 | 3 | 3 | 2 | 58.3 | Not started | none |
| 88 | Public REST planning API with OpenAPI examples | 3 | 3 | 3 | 3 | 3 | 2 | 58.3 | Partial | `wallhack/app.py` (GET /api/rf/coverage and /api/rf/config exist; no analytics or optimiser route) |
| 89 | Per-band SSID and client device profiles | 3 | 3 | 2 | 3 | 4 | 2 | 58.3 | Not started | none |
| 90 | Per-floor loss from slab material instead of one number | 3 | 2 | 3 | 2 | 3 | 1 | 56.7 | Partial | `wallhack/static/rf-config.json` (floor_loss_db fixed per band; flooring and roofing materials exist but are not wired in) |
| 91 | Vendor AP catalogue with real specs | 3 | 3 | 2 | 3 | 4 | 1 | 56.7 | Not started | none |
| 92 | Offline PWA install | 3 | 3 | 2 | 3 | 4 | 1 | 56.7 | Not started | none |
| 93 | Plan annotations (text, pin, arrow) | 2 | 2 | 2 | 3 | 4 | 1 | 55.0 | Done | `wallhack/static/planner-export.js` |
| 94 | Unit-level tests for planner-editor.js interactions (headless browser in CI) | 4 | 4 | 4 | 2 | 2 | 1 | 55.0 | Partial | `tools/planner_smoke.py` (scripted; in the `browser` job of `.github/workflows/ci.yml`, UNVERIFIED on GitHub) |
| 95 | QR calibration of scale (reusing qr.py) | 2 | 3 | 3 | 3 | 3 | 3 | 55.0 | Not started | none |
| 96 | Authentication and users for shared deployments | 4 | 5 | 4 | 2 | 3 | 1 | 55.0 | Not started | none |
| 97 | JSDoc type check config for engine, optimizer and state | 3 | 2 | 4 | 2 | 1 | 1 | 53.3 | Done | `tsconfig.json`, `Makefile` |
| 98 | Environment sensor drivers | 2 | 3 | 3 | 3 | 3 | 2 | 53.3 | Done | `wallhack/sensors/hub.py`, `tests/test_sensors.py` |
| 99 | Docker image and compose file | 3 | 2 | 2 | 2 | 3 | 1 | 53.3 | Not started | none |
| 100 | Smart-city outdoor planning | 2 | 5 | 4 | 4 | 2 | 4 | 53.3 | Not started | none |
| 101 | Reduced-motion support | 2 | 1 | 2 | 2 | 3 | 1 | 51.7 | Done | `wallhack/static/style.css` |
| 102 | systemd unit for the Pi | 2 | 1 | 2 | 2 | 3 | 1 | 51.7 | Done | `docs/wallhack.service` |
| 103 | Platform documentation set with a test | 2 | 2 | 2 | 4 | 2 | 1 | 51.7 | Done | `tests/test_platform_docs.py`, `docs/platform/README.md` |
| 104 | Fresnel zone clearance for long open paths | 2 | 3 | 4 | 2 | 2 | 2 | 50.0 | Not started | none |
| 105 | Dependency and secret scanning in CI | 3 | 2 | 3 | 2 | 1 | 1 | 50.0 | Not started | none |
| 106 | Split planner-editor.js (825 lines) into modules | 3 | 3 | 4 | 1 | 1 | 1 | 46.7 | Not started | none |
| 107 | Small-scale fading and shadowing statistics | 2 | 3 | 3 | 2 | 2 | 2 | 46.7 | Not started | none |
| 108 | PoE and cabling planner | 2 | 3 | 2 | 2 | 3 | 2 | 46.7 | Not started | none |
| 109 | Linter and formatter in CI (ruff, eslint) | 3 | 2 | 3 | 1 | 1 | 1 | 46.7 | Not started | none |
| 110 | Polarisation and MIMO channel model | 2 | 5 | 4 | 2 | 1 | 3 | 41.7 | Not started | none |
| 111 | Cloud sync of projects | 2 | 5 | 3 | 2 | 3 | 1 | 41.7 | Not started | none |
| 112 | Three.js 3D renderer (decision in the ADR: not adopted now) | 2 | 5 | 3 | 3 | 2 | 1 | 41.7 | Not started | none |
| 113 | Adaptive spatial index only if profiling justifies it (quadtree rejected by measurement) | 1 | 2 | 3 | 2 | 1 | 1 | 40.0 | Not started | none |
| 114 | Release automation (tags, changelog, artifacts) | 2 | 2 | 2 | 1 | 1 | 1 | 38.3 | Not started | none |
| 115 | Internationalisation | 2 | 4 | 2 | 1 | 3 | 1 | 38.3 | Not started | none |
| 116 | Heat map export as georeferenced image | 1 | 3 | 2 | 1 | 2 | 2 | 35.0 | Not started | none |
| 117 | React and TypeScript migration (decision in the ADR: not adopted now) | 1 | 5 | 2 | 1 | 1 | 1 | 23.3 | Not started | none |
