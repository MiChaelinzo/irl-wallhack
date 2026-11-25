# 25 V2 audit: what exists before the V2 upgrade

Written on branch `feat/rf-twin-v2` before any V2 feature work, by reading the code and running the tests (baseline: 747 tests passing per the task brief, 759 after the regression tests added here). The list of "20 mega features" and the "WOW list" were handed to the V2 task as a brief, and the brief itself is not stored in the repository. This table therefore reconstructs the 20 items from the V2 task scope (feature files FEAT-002 to FEAT-005) and groups the WOW items at the end. If the original wording differs, the mapping is the thing to check.

Status words:

- **Already existed**: built and tested before V2, no work planned.
- **Extended**: a base exists, V2 adds to it (the named feature does it).
- **New**: nothing exists, V2 builds it.
- **Partial**: a useful part exists, the missing part is named.
- **Deferred**: not planned for V2.

The "Planned in" column names the V2 feature that does the work. Rows marked Done were built by the named feature; the others are not built at the time of writing. Verification labels follow the README. All RF numbers are MODEL ESTIMATES.

## The 20 items

| # | Item | Status | Evidence in the repository | Gap | Planned in |
|---|---|---|---|---|---|
| 1 | Wall materials: steel, aluminium, tiles, insulated wall, metal door, fire door | Done (MODEL) | 14 materials with per-band attenuation, ranges, confidence and sources: `wallhack/static/rf-config.json` (`materials`), `docs/platform/material-database.md` (generated) | Closed in FEAT-002, simplifications in `15-wifi-physics.md` | FEAT-002 |
| 2 | Derived material fields (attenuation per band, reflection and penetration rate) | Done (MODEL) | `rf-config.json` has `attenuation_db` per band and `reflection_loss_db` | Closed in FEAT-002, simplifications in `15-wifi-physics.md` | FEAT-002 |
| 3 | Router and AP class profiles (consumer, gaming, mesh, enterprise) | Done (MODEL) | Per-AP tx power, standard, streams, band, channel, width in `wallhack/twin.py` and `wallhack/static/planner-state.js` | Closed in FEAT-002, simplifications in `15-wifi-physics.md` | FEAT-002 |
| 4 | Floor elevation and height model | Done (MODEL) | `floor_loss_db`, stairwell and atrium `voids` in `rfmodel.py` and `rf-engine.js`; floors stack by index | Closed in FEAT-002, simplifications in `15-wifi-physics.md` | FEAT-002 |
| 5 | Client device profiles for Smart Home capacity | Done (MODEL) | IoT device placement and capacity planning in `wallhack/static/planner-modes.js`; `analytics` throughput in `rfmodel.py` | Closed in FEAT-002, simplifications in `15-wifi-physics.md` | FEAT-002 |
| 6 | WiFi 7 capacity models (OFDMA, MU-MIMO, beamforming gain) | Done (MODEL) | Wi-Fi 4 to 7 PHY rates, MCS tables, MLO capacity model (`rf-config.json` `wifi_standards`, `mlo`; `tests/test_wifi_standards.py`) | Closed in FEAT-002, simplifications in `15-wifi-physics.md` | FEAT-002 |
| 7 | Signal timeline along a walking path | Done (MODEL) | `signal_timeline` in `wallhack/rfmodel.py`, `signalTimeline` in `rf-engine.js`, path tool and chart in `planner-modes.js`, `tests/test_rf_timeline.py` (Python and JS give identical samples and events) | Closed in FEAT-003. Floor changes are jumps, not stairs walked step by step | FEAT-003 |
| 8 | Handoff events with hysteresis | Done (MODEL) | Handoff events with hysteresis (`timeline.hysteresis_db` in `rf-config.json`) from `analytics.roam_min_dbm` and `roam_margin_db`, sticky client samples in the summary, `tests/test_rf_timeline.py` | Closed in FEAT-003. Real client roaming thresholds and scan times are not modelled | FEAT-003 |
| 9 | What-if comparison (move AP, upgrade, remove wall, add mesh node, change channel) | Done (MODEL) | `whatIf`, `applyChange`, `diffAnalytics` in `wallhack/static/rf-optimizer.js`, before and after panel in `planner-modes.js`, `tests/test_rf_recommend.py` | Closed in FEAT-003. Six change kinds: move AP, upgrade standard, switch AP profile, remove wall, add mesh node, change channel | FEAT-003 |
| 10 | Recommendation engine with ranked actions and a coverage score | Done (MODEL) | `recommend` and `metricsOf` in `rf-optimizer.js`, `recommendations` block in `rf-config.json`, `tests/test_rf_recommend.py` | Closed in FEAT-003. Every action carries a measured delta and a sensitivity confidence | FEAT-003 |
| 11 | "Design my network" plan generator | Done (MODEL, narration UNVERIFIED) | `designNetwork`, `narratePlan`, `planPayload` in `rf-optimizer.js`, narration through `POST /api/planner/explain`, `tests/test_rf_recommend.py` | Closed in FEAT-003. The LLM wording is mock tested only (UNVERIFIED with a real model), the rule-based text is the fallback | FEAT-003 |
| 12 | Scenario presets: hospital, apartment with neighbours, shared walls | Done (MODEL) | Ten presets in `wallhack/static/scenarios.json` from `tools/make_scenarios.py`: the seven earlier ones plus hospital ward, smart home and apartment with neighbours | Closed in FEAT-003. Layouts are illustrative, not real buildings | FEAT-003 |
| 13 | Explanation of results with grounded numbers | Already existed | `probeAt(..., {explain: true})`, `POST /api/planner/explain`, number check in `wallhack/llm.py`, `tests/test_explain.py` | LLM path is mock tested only (UNVERIFIED). The number check had two defects, fixed in this feature (see below) | none |
| 14 | 3D building view | Done (MODEL) | `wallhack/static/planner-3d.js` (stacked floors from the elevation model, basements, slicing plane, signal volume interpolated in dB between floors, WebGL with canvas fallback), `tests/test_planner_3d.py`, `docs/platform/adr-3d-view.md`, `docs/screenshot-planner-3d.png` | Closed in FEAT-004. The volume is interpolated from per-floor 2D results, not a 3D simulation. Frame time measured in SwiftShader only, Pi 4 UNVERIFIED | FEAT-004 |
| 15 | Beamforming visualisation | Done (ILLUSTRATION) | Tab "Beams and generations" in `planner-modes.js` (omni versus steered polar plot, lobe on the plan), `docs/screenshot-planner-beams.png` | Closed in FEAT-004. The polar plot is an illustration of the antenna model, labelled as such | FEAT-004 |
| 16 | Generation comparison (WiFi 4, 5, 6, 6E, 7) | Done (MODEL) | Comparison table and per-floor run in the beams tab (`planner-modes.js`), `wifi_standards` in `rf-config.json` | Closed in FEAT-004. Standards not allowed on a band are marked, not guessed | FEAT-004 |
| 17 | Mesh backhaul and load balance display | Done (MODEL) | Backhaul lines on the plan, load balance bars and coverage rings (`planner-modes.js`) | Closed in FEAT-004 | FEAT-004 |
| 18 | Educational lessons: reflection, beamforming, 6 GHz | Done | Lessons in `wallhack/static/learn-content.json` with engine-computed checks (`planner-learn.js`, `tests/test_planner_learn.py`) | Closed in FEAT-004. Not reviewed by a teacher | FEAT-004 |
| 19 | Benchmarks, reports and documentation for the new features | Done (measured, MODEL) | `tools/perf_rf_v2.js` (timeline, what-if, recommend, design), `tools/perf_3d.py`, `docs/perf-rf.md` (V2 section), PDF sections for network health, device recommendations and before and after, CSV SINR rows in `planner-export.js` (`tests/test_planner_panels.py`) | Closed in FEAT-005. PDFs are UNVERIFIED in a real viewer. No Pi 4 numbers | FEAT-005 |
| 20 | Accessibility check in CI and updated screenshots | Partial | `tools/a11y_check.py` now also opens the 3D, timeline and beams tabs (0 serious or critical after a fix to the table scroll regions), new `docs/screenshot-planner-{3d,timeline,beams,materials}[-demo].png` from `tools/planner_smoke.py` | Axe is not in CI: it needs a Playwright Chromium download and an `npm pack` on every run, which the current CI job does not install. Run it by hand before a release | FEAT-005 |

## WOW list

| WOW item | Status | Evidence | Planned in |
|---|---|---|---|
| Live heat map with progressive rendering | Already existed | `planner-heat.js`, `rf-worker.js`, `docs/perf-rf.md` | none |
| Click a point and see why the signal is weak | Already existed | `probeAt` explain mode, learn panel (`planner-learn.js`) | none |
| Walk the house and watch the signal and handoffs | Done (MODEL) | Items 7 and 8, tab "Timeline and what-if" | FEAT-003 |
| Move one AP and see the before and after at once | Done (MODEL) | What-if panel (item 9) | FEAT-003 |
| "Design my network" in one click | Done (MODEL) | Item 11 | FEAT-003 |
| Fly through a multi-floor building with a heat layer on each floor | Done (MODEL) | See item 14 | FEAT-004 |
| Watch a beam steer towards a client | Done (ILLUSTRATION) | See item 15 | FEAT-004 |
| WiFi 4 to 7 side by side | Done (MODEL) | See item 16 | FEAT-004 |
| Static demo that runs offline with a strict CSP | Already existed | `tools/build_demo.py`, `tests/test_static.py` | none |
| Project report as PDF with no library | Already existed | `planner-export.js` | extended by FEAT-005 (network health, device recommendations, before and after, CSV SINR) |
| Room creation tool (draw a rectangle, get four walls and a label) | Deferred (not built in V2) | Rooms are walls plus a text label today (`24-rf-lab-status.md`, row 9) | FEAT-005 (skipped, listed in `20-roadmap.md`) |

## Defects found and fixed in this feature

Each fix has a regression test written first.

| Defect | Fix | Test |
|---|---|---|
| (a) Roaming zone regions had lost their `bbox` (a test asserted its absence) | `bbox` restored in `_regions` (`wallhack/rfmodel.py`) and `regionsOf` (`wallhack/static/rf-engine.js`), so every region type has the same shape | `tests/test_rf_analytics.py::test_best_ap_overlap_and_roaming`, `tests/test_rf_lab.py::test_roaming_map_marks_handoff_and_overlap_cells_between_two_aps`, parity in `tests/test_rf_lab.py` |
| (b) A client request id ending in a newline was accepted because `$` matches before a trailing newline | `REQUEST_ID_PATTERN.fullmatch` in `wallhack/logging_setup.py` | `tests/test_api.py::test_request_id_rejects_trailing_newline` |
| (c) `validate_planner_payload` accepted NaN and Infinity | `math.isfinite` check on metric values and confidence in `wallhack/llm.py` | `tests/test_explain.py::test_planner_payload_rejects_non_finite_numbers` |
| (d) The grounding check rejected list numbering ("1.", "(2)") and band units ("5 GHz") | List markers at line start and the fixed units 2.4, 5, 6 GHz and 20 to 320 MHz are ignored. Every other number must still come from the payload | `tests/test_explain.py::test_grounding_allows_list_numbers_and_band_units`, `test_grounding_still_rejects_invented_numbers` |
| (e) `docs/screenshot-demo.png` was 1.49 MB | Re-encoded with a 64 colour palette, 338 KB, same size in pixels | file size check in this audit |

Limits of fix (d): a number written as a unit, such as "a 5 GHz band", is accepted even if 5 is not in the payload, because those are fixed WiFi band and channel width names, not measurements. A list marker above 99 or not at the start of a line is still checked.
