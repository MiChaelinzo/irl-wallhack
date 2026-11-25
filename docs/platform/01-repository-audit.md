# 01 Repository audit

Scope: `/projects/sandbox/irl-wallhack` on branch `feat/platform-audit` (108 commits in history). Measured on the code, not on the README. Status labels follow the steering: VERIFIED, PARTIALLY VERIFIED, UNVERIFIED.

## What the repository is

A FastAPI app (`wallhack/`) that serves two build-free vanilla JavaScript front ends from `wallhack/static/`: a WiFi sensing dashboard (simulated data by default, real RSSI and CSI collectors exist) and an RF planner (`/planner`) that estimates WiFi coverage for a floor plan. The planner math exists twice: Python (`wallhack/rfmodel.py`, reference) and JavaScript (`wallhack/static/rf-engine.js`, port). A static copy of the dashboard builds to `dist/` for Vercel (`tools/build_demo.py`).

Size: 26 files in `wallhack/static/`, 3 largest `rf-engine.js` 841 lines, `planner-editor.js` 825, `view3d.js` 724. Python package 782 lines at most per file (`rfmodel.py`). 600 pytest tests pass (full run on this branch).

## Architecture

- **Core reference**: `rfmodel.py` plus `rf-config.json`, the single source of every RF constant (limits, bands, materials, Wi-Fi standards, interference, antenna, scoring, planner settings). Served at `GET /api/rf/config`.
- **Port with parity tests**: `rf-engine.js` (UMD module, works in browser, worker and node). `tests/test_rf_parity.py` and `tests/test_wifi_standards.py` run the JS under node and compare with Python within 0.1 dB.
- **Compute off the UI thread**: `rf-worker.js` runs jobs (compute, analyze, compare, rank, plan, stack) with a coarse pass first, then tiles, with cancel and a per-AP tile cache.
- **Planner UI**: `planner.js` (wiring), `planner-editor.js` (canvas editing), `planner-state.js` (project model, validation, undo ops), `planner-panels.js`, `planner-modes.js` (mesh, IoT, enterprise, stack, 3D), `planner-heat.js` (WebGL heat map with canvas fallback), `planner-export.js`.
- **Advice**: `rf-optimizer.js` (deterministic placement, count, power, channels, issues, with model-sensitivity confidence).
- **Twin API**: `twin.py` validates, `app.py` serves `GET/PUT /api/twin` with its own body limit.
- **Optional LLM**: `llm.py` rewords rule findings only. Off by default.

See [03-architecture.md](03-architecture.md) for the diagram.

## State management

The planner keeps one project object in `planner-state.js`. Every edit is an operation list executed by `store.exec`, which makes undo and redo exact and lets the worker receive deltas (`update` message with ops, see `rf-worker.js` `applyDelta`). The planner saves to localStorage (`planner.js` `saveProject`, the UI shows a save state) and loads the shared twin with `GET /api/twin`; the twin designer (`twin.js`) writes it with `PUT /api/twin`. VERIFIED by `tests/test_planner_state.py` (454 lines). The dashboard (`app.js`, 558 lines) uses ad hoc DOM updates from a WebSocket stream, no store.

## Rendering

2D canvases (base, heat, overlay, edit) plus a WebGL heat map that uploads the RSSI grid as an 8-bit texture with a colour LUT (`planner-heat.js`), falling back to canvas when WebGL is unavailable. The 3D view `view3d.js` is a hand-written 2D-canvas projection, not WebGL and not Three.js (`grep getContext` shows only `"2d"` there, and `planner-heat.js` is the only WebGL user). Rendering numbers are in [09-rendering-optimization.md](09-rendering-optimization.md).

## Technical debt

See [02-technical-debt.md](02-technical-debt.md). Headline: two implementations of one model (controlled by parity tests), several files over 500 lines, no CI browser run, stale text in `docs/rf-planner.md` about antenna patterns.

## Scalability

Measured (FEAT-005, `docs/perf-rf.md`): 100,489 points, 1000 walls, 4 APs: worker final result 1.9 s in node and 2.1 s in headless Chromium, first usable frame about 145 ms. Single machine, single user, no database, in-memory runtime. Not measured on a Raspberry Pi 4. Not tested beyond 1000 walls per floor or 6 floors (limits in `rf-config.json`: 5000 walls per floor, 6 floors).

## Security

Detail in [13-security-review.md](13-security-review.md). Summary: loopback by default, opt-in LAN with pairing token, DNS-rebinding Host check, same-origin and JSON-only writes, body limits, strict CSP on the static demo, LLM keys from environment only. No authentication or user model beyond the pairing token (by design for a local tool).

## Missing features

Educational mode, AR and computer vision, floor-plan extraction, measured-survey calibration, an LLM explain route for planner advice, door and window editing in the UI, true 3D propagation, campus and smart-city planning, Docker image. None of these are built. See [21-top-100-improvements.md](21-top-100-improvements.md).

## Scores

Scores are out of 10, set by the evidence in each table. They are a judgement, not a measurement. A score above 8 would need the open gaps listed in the table closed.

### Architecture: 7 / 10

| Evidence | Source | Effect |
|---|---|---|
| One config file for all RF constants, shared by Python and JS | `wallhack/static/rf-config.json`, `rfmodel.CONFIG` | plus |
| Reference plus port with parity tests (0.1 dB) | `tests/test_rf_parity.py`, `tests/test_wifi_standards.py` | plus |
| Engine runs in browser, worker and node unchanged | UMD header of `rf-engine.js`, `tests/test_rf_planner_js.py` | plus |
| Deterministic optimiser, no randomness | `wallhack/static/rf-optimizer.js` header | plus |
| Operation-based undo shared with the worker | `planner-state.js`, `rf-worker.js` | plus |
| Duplicate model in two languages is permanent cost | `rfmodel.py` 782 lines, `rf-engine.js` 841 lines | minus |
| Planner UI wiring is spread over six files with an `app` object passed around | `planner.js`, `planner-*.js` | minus |
| No module boundary between dashboard and planner CSS (one 328-line `style.css`) | `wallhack/static/style.css` | minus |

### Maintainability: 6 / 10

| Evidence | Source | Effect |
|---|---|---|
| 600 passing tests, 34 test modules | `tests/`, last run in FEAT-005 | plus |
| Constants in config, magic numbers rare in new code | `rf-config.json` | plus |
| Generated docs kept in sync by tests | `tools/material_doc.py`, `tests/test_rf_config_schema.py` | plus |
| `planner-editor.js` 825 lines mixes tools, menus, dialogs, image import | `wc -l` | minus |
| JS has only JSDoc checks on three files (`tsconfig.json` include list), typecheck needs network for `npx` | `tsconfig.json`, `Makefile` | minus |
| No linter or formatter in CI | `.github/workflows/ci.yml` | minus |
| Planner UI interaction code has no automated browser test in CI (script exists) | `tools/planner_smoke.py` | minus |

### Scalability: 5 / 10

| Evidence | Source | Effect |
|---|---|---|
| 100k points in about 2 s in a worker, progressive first frame about 145 ms | `docs/perf-rf.md` | plus |
| Per-AP tile cache, wall edit recomputes only touched tiles (8 of 104 in the measured case) | `docs/perf-rf.md` | plus |
| Engine grid path is about 4x slower than the bench grid kernel (1675 vs 398 ms), cause not profiled | `docs/perf-rf.md` | minus |
| No GPU compute, no 3D propagation | [09-rendering-optimization.md](09-rendering-optimization.md) | minus |
| Single process, in-memory runtime, one twin file | `wallhack/runtime.py`, `wallhack/twin.py` | minus |
| No Raspberry Pi 4 measurement | README table (UNVERIFIED) | minus |

### Demo readiness: 7 / 10

| Evidence | Source | Effect |
|---|---|---|
| Static demo builds deterministically, tested | `tools/build_demo.py`, `tests/test_demo_build.py` | plus |
| Strict CSP, no CDN, works offline | `vercel.json` | plus |
| Judge page whose statuses are tested against the README | `wallhack/judge.py`, `tests/test_judge.py` | plus |
| Screenshots of planner live and demo | `docs/screenshot-planner*.png` | plus |
| Real Vercel deploy never done | README table (UNVERIFIED) | minus |
| AP panel controls for Wi-Fi standard not clicked in a browser | README table (PARTIALLY VERIFIED) | minus |
| Never tried on a real phone or Pi | README table | minus |

### Hackathon competitiveness: 7 / 10

| Evidence | Source | Effect |
|---|---|---|
| Visible, interactive planner with heat map, 3D, PDF report | `planner.html`, `planner-export.js` | plus |
| Rare combination: WiFi 4 to 7 with SINR and MLO model in the browser | `rfmodel.py`, `rf-engine.js` | plus |
| Honest labelling and a measured benchmark | `README.md`, `docs/perf-rf.md` | plus |
| Recommendations carry a model-sensitivity confidence | `rf-optimizer.js` | plus |
| No measured-data validation of the model | README table (UNVERIFIED) | minus |
| AI story is deterministic rules plus an optional LLM reword, not an AI planner end to end | `llm.py`, `insights.py` | minus |
| No AR, no educational mode, no consultant chat | [21-top-100-improvements.md](21-top-100-improvements.md) | minus |

## Quick wins

1. Fix stale "antenna patterns not modelled" line in `docs/rf-planner.md` (antenna is now modelled).
2. Profile the engine grid path to explain the 4x gap to the bench kernel (`tools/perf_rf_lib.js` already has the harness).
3. Run `tools/planner_smoke.py` in CI with Playwright.
4. Add the planner AP standard controls to the smoke script.
5. Add `planner-export.js`, `planner-panels.js` and `rf-worker.js` to `tsconfig.json` and fix what it reports.

## High-impact list

1. Survey import and model calibration (turns an uncalibrated model into a defensible one).
2. LLM explain endpoint for planner advice, numbers from the engine only (design in [06-ai-planner-design.md](06-ai-planner-design.md)).
3. SINR-aware placement and channel planning (the engine now has SINR, the optimiser still plans with RSSI and carrier-sense).
4. Door and window editing UI (engine already supports openings).
5. Educational mode on existing engine functions ([16-educational-mode.md](16-educational-mode.md)).
