# 05 Component map

Owner column says which layer is the source of truth.

## Python (`wallhack/`)

| Module | Responsibility | Tests |
|---|---|---|
| `app.py` | FastAPI routes, origin and JSON checks, body limits, static files | `tests/test_api.py`, `tests/test_twin_api.py`, `tests/test_smoke.py` |
| `rfmodel.py` | Reference RF model, standards, SINR, antenna, MLO, analytics | `tests/test_rfmodel.py`, `tests/test_wifi_standards.py`, `tests/test_rf_analytics.py` |
| `twin.py` | Twin schema validation, sample twin, persistence | `tests/test_twin.py` |
| `llm.py` | Optional LLM client (ollama, llamacpp, openai, azure) | `tests/test_insights.py` |
| `insights.py` | Deterministic rule findings | `tests/test_insights.py` |
| `pairing.py`, `qr.py` | LAN token, middleware, QR encoder | `tests/test_pairing.py`, `tests/test_qr.py` |
| `runtime.py`, `processing.py`, `simulator.py`, `history.py`, `scores.py`, `health.py`, `environment.py` | Sensing pipeline | matching `tests/test_*.py` |
| `collectors/`, `nexmon.py`, `sensors/` | Data sources | `tests/test_parsers.py`, `tests/test_nexmon.py`, `tests/test_sensors.py` |
| `game.py`, `judge.py` | Placement game, judge report | `tests/test_game.py`, `tests/test_judge.py` |

## Browser (`wallhack/static/`)

| File | Responsibility | Source of truth |
|---|---|---|
| `rf-config.json` | all RF constants | itself |
| `rf-engine.js` | propagation, analytics, standards, SINR, compare, score | port of `rfmodel.py` |
| `rf-worker.js` | job runner, tile cache, progressive results | engine |
| `rf-optimizer.js` | issues, placement, count, power, channels | JS only (no Python twin) |
| `planner-state.js` | project model, validation, undo ops, local save | validators mirror `twin.py` |
| `planner-editor.js` | canvas tools, menus, dialogs, image import | JS |
| `planner-heat.js` | heat map renderer, contours, legend, minimap | JS |
| `planner-panels.js`, `planner-modes.js` | analysis tabs, mesh, IoT, enterprise, stack, 3D | JS over the engine |
| `planner-export.js` | PNG, CSV, JSON, PDF, print, annotations | JS |
| `planner.js`, `planner.html` | wiring and page | JS |
| `view3d.js` | 2D-canvas 3D projection | JS |
| `app.js`, `panels.js`, `twin.js`, `mobile.js`, `judge.js`, `game.js`, `demo.js`, `common.js` | dashboard and companions | JS |

Note: `rf-optimizer.js` has no Python counterpart. It is deterministic and tested through node (`tests/test_rf_planner_js.py`), but it is not parity-checked because nothing else implements it.

## Tools and CI

`tools/build_demo.py` (static demo), `tools/material_doc.py` (generated doc), `tools/perf_rf.js`, `tools/perf_rf_lib.js`, `tools/perf_rf_browser.py` (benchmarks), `tools/planner_smoke.py`, `tools/screenshot.py` (headless Chromium), `.github/workflows/ci.yml`.
