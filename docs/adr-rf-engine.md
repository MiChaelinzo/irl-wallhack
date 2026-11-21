# ADR: RF engine in Python and JavaScript with one shared config

Status: accepted. All signal values are MODEL ESTIMATES, not measurements.

## Context
The coverage model feeds the game, scores, insights, the static demo build and `/api/rf/coverage`, all in
Python. The new planner needs interactive recomputation in the browser (dragging an AP, editing walls),
including with no server (the static Vercel demo) and on large floor plans.

## Decision
- `wallhack/rfmodel.py` stays the reference implementation and source of truth.
- `wallhack/static/rf-engine.js` (UMD: browser, Web Worker via `importScripts`, node) is a port of the same
  algorithms. It takes the config object as an argument and has no config of its own.
- Both read one file, `wallhack/static/rf-config.json` (bands, materials, thresholds, rate tables, engine
  constants). No physical constant is hard-coded in either implementation.
- Parity is enforced by `tests/test_rf_parity.py`, which runs the JS engine from pytest over seeded
  layouts, all bands and modes, and checks agreement within 0.1 dB. The JS spatial index is checked against
  brute force on a 1000-wall layout.
- Propagation modes and extra materials go through small registries (`register_mode`, `registerMode`,
  `registerMaterials`). The built-in modes register through them. Nothing else is pluggable.
- Defaults (2.4 GHz, no material, `basic` mode) reproduce the previous numbers exactly. A golden fixture
  created from the unmodified code guards this.

## Alternatives rejected
- Python calls node: the Pi would need node at runtime and server tests would depend on it.
- JS only: breaks the game, insights and demo build, and drops Python as source of truth.
- WebAssembly or a compiled core: needs a build step; the project is deliberately no-build.
- Python-only with server calls per edit: no offline demo, a round trip for every drag.

## Trade-offs and risks
- Two implementations can drift. Mitigation: parity tests and the rule that Python wins on conflict.
- A spatial index is JS only. Python is brute force, which is fine for the small twins the server handles.
- Tie cases (a ray through a wall end point exactly) rely on both languages doing the same floating
  point operations. The tests cover axis-aligned sample layouts and jittered random ones.
