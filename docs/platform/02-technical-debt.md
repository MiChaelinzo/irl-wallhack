# 02 Technical debt

Measured with `wc -l` on this branch. Status labels: VERIFIED means counted or tested here.

## File sizes

| File | Lines | Note |
|---|---:|---|
| `wallhack/static/rf-config.json` | 1079 | data, not code |
| `wallhack/static/rf-engine.js` | 841 | engine port, one module |
| `wallhack/static/planner-editor.js` | 825 | tools, menus, dialogs, image import, keyboard |
| `wallhack/rfmodel.py` | 782 | reference model, standards, SINR, analytics |
| `wallhack/static/view3d.js` | 724 | 2D-canvas 3D projection |
| `wallhack/static/planner-state.js` | 631 | project model and validation |
| `wallhack/static/planner-panels.js` | 568 | analysis panels |
| `wallhack/static/app.js` | 558 | dashboard |
| `wallhack/static/planner.js` | 507 | planner wiring |
| `wallhack/static/planner-heat.js` | 425 | WebGL and canvas heat map |
| `wallhack/runtime.py` | 380 | sensing runtime |
| `wallhack/static/rf-optimizer.js` | 379 | planner advice |
| `wallhack/static/rf-worker.js` | 365 | worker jobs |
| `wallhack/twin.py` | 350 | twin validation and persistence |

Nine JavaScript files exceed 400 lines. No Python file exceeds 800. Rule of thumb used here: above 600 lines a file should justify itself. Candidates: `planner-editor.js` (825) and `rf-engine.js` (841).

## Duplicated Python and JavaScript logic

The RF model exists twice on purpose, because the planner must run in a browser with no server (static Vercel demo) and the Python side serves the API and the reference numbers.

| Duplicated area | Python | JavaScript | Control |
|---|---|---|---|
| Propagation, walls, reflection, diffraction | `rfmodel.py` | `rf-engine.js` | `tests/test_rf_parity.py` (0.1 dB), golden fixture `tests/fixtures/rf_legacy_golden.json` |
| Wi-Fi standards, SINR, antenna, MLO | `rfmodel.py` | `rf-engine.js` | `tests/test_wifi_standards.py` |
| Analytics (coverage, regions, capacity) | `rfmodel.analytics` | `rf-engine.js` `analytics` | `tests/test_rf_analytics.py` |
| Project validation | `twin.validate_twin` | `planner-state.js` `validateProject` | `tests/test_planner_state.py`, `tests/test_twin.py` (separate tests, no shared fixture) |
| Placement game scoring | `game.py` | `game.js` | `tests/test_game_parity.py` (all 257 selections) |
| Constants | `rf-config.json` | same file | one file, no duplication |

Gap: validation parity has no shared fixture, so Python and JS validators can drift. The FEAT-002 fix (blank name, 64 character limit) had to be made in both places by hand.

## Unfinished or inconsistent items

| Item | Evidence | Status |
|---|---|---|
| `docs/rf-planner.md` "Not modelled" line still lists antenna patterns | the "Not modelled" paragraph of the propagation section versus the antenna section lower in the same file | stale, fixed in this change set |
| Engine grid path about 4x slower than the bench grid kernel, cause unknown | `docs/perf-rf.md` (1675 ms vs 398 ms node) | open, unprofiled |
| Flooring and roofing materials exist but floors use a fixed `floor_loss_db` | `rf-config.json`, README table | open |
| Doors and windows are in the engine and twin, not editable in the planner UI | `planner.html` now has Door (D) and Window (O) tools in `planner-editor.js` | fixed |
| `tsconfig.json` checks only three files | `tsconfig.json` include | open |
| `make typecheck` needs network for `npx` | `Makefile` | open |
| AP panel standard controls not exercised in a browser | README table | PARTIALLY VERIFIED |
| `tools/screenshot.py` and `tools/planner_smoke.py` overlap in purpose | both in `tools/` | open |
| Real hardware (Pi 4 CSI, sensors) | README table | UNVERIFIED |
| Real Vercel deployment | README table | UNVERIFIED |

## Not debt, deliberate

- No build step and no framework (see [adr-frontend-stack.md](adr-frontend-stack.md)).
- Quadtree and octree not adopted (measured and not applicable, [09-rendering-optimization.md](09-rendering-optimization.md)).
- No refraction model (negligible indoors, [15-wifi-physics.md](15-wifi-physics.md)).

## Recommended order

1. Profile the engine grid path (small, measurable).
2. Share validation fixtures between Python and JS tests.
3. Split `planner-editor.js` by tool when the next editor feature lands, not before.
4. Widen `tsconfig.json`.
