# 11 Testing strategy

State on this branch: 600 pytest tests pass (`.venv/bin/python -m pytest -q`, about 2 minutes, full run on this branch). 34 test modules in `tests/`. Labels: VERIFIED, PARTIALLY VERIFIED, UNVERIFIED.

## Pyramid as it exists

| Layer | What | Examples | Status |
|---|---|---|---|
| Unit (Python) | pure functions, validators, parsers | `tests/test_rfmodel.py`, `tests/test_twin.py`, `tests/test_processing.py`, `tests/test_parsers.py` | VERIFIED |
| Unit (JS under node, driven from pytest) | engine, state, optimizer, panels, export helpers | `tests/test_rf_planner_js.py`, `tests/test_planner_state.py`, `tests/test_planner_panels.py`, `tests/test_planner_heat.py`, `tests/test_view3d.py` | VERIFIED (needs node) |
| Parity | Python reference against the JS port | `tests/test_rf_parity.py`, `tests/test_wifi_standards.py`, `tests/test_game_parity.py` | VERIFIED |
| Golden | legacy numbers must not change | `tests/fixtures/rf_legacy_golden.json` | VERIFIED |
| API | routes, limits, origin checks | `tests/test_api.py`, `tests/test_twin_api.py`, `tests/test_pairing.py` | VERIFIED |
| Process smoke | real uvicorn, WebSocket | `tests/test_smoke.py` | VERIFIED |
| Build | static demo is deterministic | `tests/test_demo_build.py` | VERIFIED |
| Doc sync | generated docs match config, schema holds | `tests/test_rf_config_schema.py`, `tests/test_platform_docs.py` | VERIFIED |
| Browser UI | scripted headless Chromium | `tools/planner_smoke.py`, `tools/screenshot.py` | PARTIALLY VERIFIED, `planner_smoke.py` is in the CI `browser` job (UNVERIFIED on GitHub) |
| Hardware | Pi 4 CSI, sensors, real phones | none | UNVERIFIED |

## Parity

Python is the source of truth. The parity tests run the same fixture through both and compare within 0.1 dB (RSSI) and tighter for exact quantities. Mixed standards, co-channel and adjacent-channel APs and a sector antenna are in the fixture (`tests/test_wifi_standards.py`). Validation parity has no shared fixture (see [02-technical-debt.md](02-technical-debt.md)).

## Determinism

The optimizer has no randomness. The simulator is seeded (`tests/test_simulator.py`), the benchmark floor is seeded (`tools/perf_rf_lib.js`, seed 7, determinism test in the test suite), the demo build is deterministic (`tests/test_demo_build.py`).

## What is not verified

- RF model accuracy against a real building (no survey data exists in the repository).
- Throughput and capacity numbers against real radios.
- Real CSI, real sensors, Pi 4 speed, real GPU, touch devices.
- Real Vercel deployment.
- Real LLM providers (mocked HTTP servers only).
- AP panel controls for the Wi-Fi standard in a browser.

## Gaps and plan

1. Run `tools/planner_smoke.py` in CI (needs Playwright and Chromium install step).
2. Add a survey fixture test once calibration exists (compare model to measured RSSI with a stated RMSE).
3. Shared validation fixtures for Python and JS.
4. A property test that every `rf-config.json` section is covered by the schema (today only some sections).
5. Mutation check by hand: for each FEAT fix, revert and confirm the test fails (FEAT-002 did this by test-first design, not re-run per revert).
