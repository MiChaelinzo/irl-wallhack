# Changelog

## Unreleased

### Performance, CI and PDF check
- perf: the optimizer keeps a grid cache per planner context, builds the wall-perturbed environments once, and shares candidate AP grids between calls on an unchanged floor (`rf-optimizer.js`); `placementReport` no longer spreads typed arrays (`rf-insight.js`). Outputs are identical (parity, golden fixture and full suite pass; `tests/test_planner_quick.py` covers cache identity and invalidation by walls, materials, cell size and mode; timings are for one floor). Hotel floor, repeated call: `diagnose` 202 to 44 ms, `meshTopologies` 374 to 64 ms, `timeMachine` 200 to 40 ms, `placementReport` 349 to 184 ms. First call after a geometry change is barely faster (mesh 374 to 200 ms, others about the same). MISSED against 100 ms: stress floor `analyze` 512 ms and `whatIf` 1.3 s, hotel `placementReport`, all first calls. Details and profile in `docs/perf-rf.md`.
- ci: a `browser` job installs Playwright (pinned to 1.65.2) Chromium and runs `tools/planner_smoke.py` and `tools/a11y_check.py` with read-only permissions. UNVERIFIED on GitHub; both tools passed locally.
- fix: in `wifi_assessment.pdf` the footer wrapped off the page edge and the mesh table cut "Whole-home mesh (up to 2 nodes)"; the footer now wraps and the column is wider. Rendered with PyMuPDF and viewed; other viewers UNVERIFIED.

### Quick start: before and after
- feat: applying a fix (move router, add router or mesh node, change channel) on Quick start re-analyses the plan and shows a Before and after card: both letter grades with scores, the point change in plain words, gaming, streaming and video call ratings, coverage and dead zones. Channel change fixes now have an Apply button. `beforeAfterModel` in `planner-quick.js` is tested in `tests/test_planner_quick.py`; `tools/planner_smoke.py` checks the card after Apply and `tools/screenshot.py` writes `docs/screenshot-planner-quick-fix.png`. Model estimate. PARTIALLY VERIFIED (scripted headless run, screenshot viewed, a11y 0 serious or critical).

### WiFi architect polish
- fix: `diagnose` now tests a "Change WiFi channel" fix (the SINR channel plan, `set_channels`) when interference is the main cause, so the two bedroom condo with `unit-4b` on channel 6 gets a measured channel change; Quick start can apply it. Interference cause text says it is signal quality lost to noise, separate from wall loss.
- fix: when fixes help the room but lower whole-floor coverage, the result says so (`rejected_for_floor`) instead of claiming nothing helps. Tests now hit the no-position branch and the floor filter for certain (model estimate, UNVERIFIED in a browser).

### WiFi architect: review fixes
- fix: assistant fixes that lower whole-floor coverage are no longer recommended; `placementReport` returns a "No position found" result (position null) instead of throwing when the floor has no AP and no candidate position; `thicknessFactor` (Python and JS) clamps thickness to `wall_thickness.min_cm`.
- fix: the Gamer Mode `source` text says "served" cells like the code; the hop cap moved to `insight.mesh.max_hops`; the object `source` notes that a path starting or ending inside an object crosses one edge (loss overstated); grade chips in the room table have `role="img"` (screen reader behaviour UNVERIFIED).
- docs: `docs/rf-planner.md` states the insight layer is intentionally JS only.

### WiFi architect: measurements, screenshots and docs
- perf: `tools/perf_architect.js` times the insight functions on presets and the stress floor and counts path evaluations (one "ray" = one direct, reflected or diffracted path call for one AP and one cell) from an instrumented copy of the engine; `tools/perf_3d.py` also measures the Signal waves frame time per quality level. Results and misses in `docs/perf-rf.md`: re-simulation after an AP move is 3 to 8 ms on presets and 518 ms on the stress floor (what-if 1.4 s, a miss); `diagnose`, `placementReport` and `meshTopologies` take 0.34 to 0.39 s on the 13 room hotel preset (a miss); 10,000+ path evaluations per run only in multipath mode or on large floors.
- docs: `tools/screenshot.py` captures the Quick start result, Rooms and gaming, Score card, Assistant, Mesh, Time Machine and the aurora palette with waves (`docs/screenshot-planner-*.png`, demo shots stay in a temp folder); the README leads with the Quick start image, gains a five step walkthrough and honesty rows; `docs/platform/26-wifi-architect-round.md` lists the ten priority features and extras as already existed, extended, new, partial or deferred; tables 21, 24 and 25 updated.
- style: the sticky header is more opaque (0.82 dark, 0.92 light) so page content no longer shows through it in the light theme screenshot.
- Verification: VERIFIED for the measurements on the benchmark machine (Xeon, node 22, headless Chromium with SwiftShader). UNVERIFIED on integrated graphics, a Raspberry Pi 4 and phones.

### WiFi architect: Quick start, new tabs, signal waves
- feat: `planner-quick.js` adds a Quick start card at the top of `/planner` (pick one of 14 templates or keep your plan, press Analyse my WiFi): big grade, coverage, dead zones, Gaming, Streaming and Video call ratings, per-room Gamer Mode table, top diagnosis, a computed "Best router spot" line with Show (ghost marker) and Apply (undoable), a link to the signal against interference layers, and an Ask box with a suggested question chip per room.
- feat: tabs Rooms and gaming (table, room cards, Smart Home check per room), Score card, Assistant (optional "Explain in plain words" through `POST /api/planner/explain`, live server only), Mesh (three topologies side by side) and Time Machine (up to four versions A to D, delta table, thumbnails and a wipe viewer). The Scenarios tab compare is unchanged.
- feat: `wifi_assessment.pdf` (grade and ratings with heat map, per-room ping and loss table, diagnosis with before and after, mesh and Time Machine page when run) from the Score card tab and the Quick start result, plus a per-room CSV in the Export tab. Every page carries the model-estimate footer. Browser download VERIFIED by `tools/planner_smoke.py`; PDF structure checked by pytest, not opened in a third-party viewer (PARTIALLY VERIFIED).
- feat: button "Find best spot for this router" in the Tools card (selected access point, else the first) with Show and Apply.
- feat: Smart Home client kinds doorbell, speaker, thermostat and robot vacuum with documented demand in `client_devices`.
- feat: Signal waves toggle (`signal_waves` block in `rf-config.json`, schema updated): rings from each access point, dimmed after every wall with the engine `wallLoss`, ray count from the page quality level and halved when drawing exceeds the frame budget, paused when the tab is hidden, still (no animation) under reduced motion and off by default there and on the Low quality level. Drawn through the editor overlay hook on the plan, not on the heat canvas, so the renderer redraw cannot erase it. It is an ILLUSTRATION.
- style: glass planner cards with solid fallbacks (no `backdrop-filter`, high contrast, `prefers-reduced-transparency`, Low quality) and letter grades that do not rely on colour alone.
- fix: the plan refits the stage whenever the stage changes size until the user zooms or pans (the plan only filled part of the stage after layout shifts).
- fix: `tools/a11y_check.py` no longer aborts when a page never reaches its ready condition (the `/mobile` websocket); it notes it after 8 s and checks the page as loaded. It also checks Quick start and the five new tabs.
- test: `tests/test_planner_quick.py` (node) for the view-model builders, config schema and wave geometry; `tools/planner_smoke.py` runs Quick start end to end (template to result about 0.3 s, limit 20 s), Ask, Show and Apply with undo, every new tab, the waves toggle with reduced motion, and 390 px width without horizontal scroll.
- Verification: VERIFIED by pytest, `tools/planner_smoke.py` (live, `--demo`, `--canvas2d`) and `tools/a11y_check.py` (0 serious or critical in default, light, and contrast runs). PARTIALLY VERIFIED: layout read from screenshots only. UNVERIFIED: the LLM rephrase (no LLM in the sandbox), real devices and screen readers. Camera and smart-device interference sources were not added (no sourced duty cycle and power); microwave, Bluetooth and neighbour WiFi remain.

### WiFi architect: insight library
- feat: `wallhack/static/rf-insight.js` (pure, deterministic, node tested): per-room analysis, Gamer Mode (ping ranges, loss risk, stability grade), Coverage Score Card, Predictive WiFi Assistant (keyword parser, dB ranked causes, measured fixes), router placement report, mesh topologies with a backhaul assumption and the WiFi Time Machine. Rules and thresholds are documented in `docs/rf-planner.md` and live in the new `insight` block of `rf-config.json` (schema updated, `source` string included). `rf-optimizer.js` exports `candidatePositions`.
- Verification: VERIFIED by `tests/test_rf_insight.py` (node driven) and `tests/test_rf_config_schema.py`. UI wiring is a later feature. UNVERIFIED: real model output for the assistant rephrase (mocked only); ping, grade and mesh backhaul numbers are planning assumptions, not measurements.

### WiFi architect: thickness, objects, templates, aurora palette
- feat: optional wall `thickness_cm` with a per-material reference thickness (`wall_thickness` in `rf-config.json`, schema updated). Loss is `attenuation_db x min(thickness / reference, max_factor)`; walls without thickness are unchanged and the legacy golden fixture passes untouched. Mirrored in `rf-engine.js`, validated in `twin.py` and `planner-state.js`, shown in explain text, parity tested (`tests/test_rf_parity.py`, `tests/test_rfmodel.py`).
- feat: Object tool (B): furniture and metal obstacles drawn as four wall segments with one `object` id (sofa, fridge, cabinet, mirror, bookshelf), undoable as one step, deleted as a group. They reuse the wall loss path (`docs/rf-planner.md`).
- feat: inspector thickness input with a tooltip of the resulting dB at the current band.
- feat: four new presets (studio apartment, two bedroom condo, three story house with stairwell voids, small office), 14 in total; every floor of every preset has named rooms.
- feat: `aurora` heat map palette (emerald, cyan, amber, crimson) next to classic, used by the WebGL and canvas paths.
- docs: `material-database.md` gains the thickness rule and a comparison with quick figures (drywall 3, wood 4, glass 5, brick 9, concrete 18, metal 30 dB); database values are unchanged.
- Verification: VERIFIED by pytest (828 passed, 3 skipped), `make typecheck`, `node --check`, `tools/planner_smoke.py` (live, `--demo`, `--canvas2d`: object tool, group select, thickness input, delete and aurora palette driven in headless Chromium) and `tools/a11y_check.py` (0 serious or critical). UNVERIFIED: real devices and touch for the Object tool; the reference thicknesses are planning assumptions.
- test: `tools/planner_smoke.py` prints the page errors seen before a failed step.

### Polish pass 2: hierarchy, honesty checks, lighter screenshots
- fix: timeline samples are capped inside the segment loop and waypoints are validated (`ValueError` in `rfmodel.signal_timeline`, matching JS); judge page status marks are CSS shapes (check, half circle, ring, cross) instead of symbol-font glyphs that rendered blank without the font; `make typecheck` fixes (commit dc5e378).
- fix: the sticky planner map was constrained by the whole planner grid, so with the page scrolled to the analysis card it stayed pinned behind that card and clicks meant for the plan landed on the card. The tools, map and side columns now sit in their own `.planner-work` grid, so the map stops at the analysis card. This was the cause of the intermittent "no handoff" failure in `tools/planner_smoke.py`.
- style: header hierarchy on every page: page links and toggles share one compact pill size, the renderer and compute chips are plain muted status text; on phones the wrapped header scrolls away instead of covering about a fifth of the screen.
- style: planner analysis tabs read as navigation (muted labels, underline on the open tab, small gaps between the analyse, plan, export, simulate and view groups); high contrast and forced colours keep a visible marker. The material palette is a collapsible group placed after the project actions, so Project is reachable without scrolling past 22 materials.
- style: the signal quality bars in Analytics are now an accessible list (band and share are read out), replacing the duplicate text table under them.
- fix: huge integer waypoints (above float range) raise `ValueError` instead of `OverflowError`; a JS test asserts the in-loop sample cap and the waypoint messages match Python. `tools/a11y_check.py` now waits for the mobile page to leave "connecting" before scanning. Newer CSS (`:has()`, `color-mix()`, `text-wrap`) has no fallback: layout degrades on older browsers and is UNVERIFIED outside current Chromium. Screen reader reading of the signal list is UNVERIFIED (axe only).
- style: judge page puts the status and verification chips together on the right of each item; PARTIALLY VERIFIED and UNVERIFIED chips are dashed and muted so they read as weaker evidence; the side card no longer stretches.
- refactor: removed the unused `levelOfFloor` helper in `rf-worker.js` (the only unreferenced top-level function found in `wallhack/static/*.js`).
- test: `tools/a11y_check.py` also checks `/judge` and `/mobile`; the smoke timeline failure now reports the panel text and waypoints instead of timing out on a missing element.
- docs: screenshots regenerated. `docs/*.png` went from 44 files, 15.2 MB (15,216,410 B) to 26 files, 5.1 MB (5,080,324 B). Removed the 18 `-demo` duplicates (the demo runs still check those pages but write to a temp folder), shots are viewport-sized instead of full-page (the dashboard shot was 1280x6264), and `tools/optimize_pngs.py` re-encodes losslessly with Pillow (about 4 percent; no lossy palette reduction). `tools/planner_smoke.py` no longer overwrites `docs/screenshot-planner.png`, which `tools/screenshot.py` owns.
- docs: README opens with what the project is, the planner hero shot, a one-minute start and a table of pages with the honesty label each shows; the screenshot gallery is a compact grid. CONTRIBUTING notes the screenshot workflow.
- Verification: VERIFIED by pytest, `make typecheck`, `node --check`, `bash -n scripts/*`, `tools/build_demo.py`, `tools/planner_smoke.py` (live, `--demo`, `--canvas2d`) and `tools/a11y_check.py` (0 serious or critical in dark, light, high contrast and light high contrast, live and demo pages). Light, dark, high contrast, low quality and phone width were looked at in headless Chromium screenshots only. UNVERIFIED: Firefox, Safari, real phones, screen readers and Windows forced colours.

### Design polish
- style: form controls share one `:where()` rule, the focus ring is one token (`--ring`) instead of four duplicate rules, spacing and radius tokens added to `:root`, `accent-color`, thin scrollbars and text balancing (`style.css`).
- style: planner map column stays in view while the long tool and control columns scroll (sticky, viewport-height stage); tool rows fill their width and the kind selects no longer overflow the column; the probe list is a grid instead of floats, so its empty state no longer wraps around the mini-map heading.
- style: card headings get a divider; the RF intelligence card on the dashboard and the judge side card keep their own height instead of stretching into empty panels; score tiles fit five across.
- docs: all screenshots in `docs/` regenerated. Verified: pytest (806), `tools/a11y_check.py` (0 serious or critical, live and demo), demo build. Looked at in headless Chromium only; the judge page status glyphs (check, half circle) rendered blank in this sandbox for lack of a symbol font, unchecked on real browsers.

### V2 reports, measurements, screenshots and accessibility
- feat: PDF report gains network health, device recommendations and before and after what-if tables from the Timeline and what-if tab; CSV gains per-AP SINR rows (`planner-export.js`, `tests/test_planner_panels.py`).
- fix: table scroll regions in the planner now have `tabindex`, `role=region` and a label (axe `scrollable-region-focusable`, found in the beams tab).
- feat: `tools/a11y_check.py` opens the 3D, timeline and beams tabs; `tools/planner_smoke.py` writes screenshots of the 3D view, timeline and what-if, beams and wall material inspector (live and demo); `tools/perf_rf_v2.js` times the V2 features.
- docs: V2 measurements and the profile of the throttled main-thread AP move (a `MessageChannel` yield was tried and reverted, no difference beyond noise) in `docs/perf-rf.md`; audit, lab status, roadmap (future work: DXF and IFC, exact ray tracing, survey calibration, room tool, AR), user guide and contributing updated. Room creation tool not built.

### Planner 3D view, beam and generation views, new lessons
- docs: `docs/platform/adr-3d-view.md` records the decision with measurements: in-house WebGL plus canvas projection (42,755 B) instead of vendored three.js (670,681 B). `adr-frontend-stack.md` status line points to it. Pi 4 frame rate UNVERIFIED.
- feat: `planner-3d.js` and the "3D view" tab: stacked floors from the elevation model (basements, slabs), orbit and fly-through camera (mouse, touch, keyboard), heat map per floor, access point and mesh markers, slicing plane and a signal volume of translucent slices. The volume is interpolated from per-floor 2D results (linear in dB), not a 3D simulation, and says so. WebGL with a canvas projection fallback (`?renderer=canvas2d`), text alternative, reduced motion respected. New `planner_3d` block in `rf-config.json`.
- feat: tab "Beams and generations" in `planner-modes.js`: omnidirectional versus steered polar plot (animated, ILLUSTRATION), lobe on the plan, Wi-Fi 4 to 7 comparison table (speed, range, behind-wall rate, OFDMA, MU-MIMO, beamforming) with a per-floor run, mesh backhaul lines on the plan, load balance bars, animated coverage rings; minimap hover and focus polish in `style.css`.
- feat: lessons on reflections, beamforming and 6 GHz in `learn-content.json`; checks `ap_standard` and `beamforming_gain_db`; `rssi_at` returns no value when the band is not allowed for the access point instead of throwing.
- test: `tests/test_planner_3d.py`; `tools/planner_smoke.py` covers the 3D view and the new tab (live, demo, canvas 2D); `tools/perf_3d.py` measures the view.

### V2 timeline, what-if, recommendations and network design
- feat: `rfmodel.signal_timeline` and `RFEngine.signalTimeline`: signal along a walking path with handoff events (hysteresis from `timeline.hysteresis_db`, thresholds from `analytics.roam_min_dbm` and `roam_margin_db`), sticky client samples and a summary. Python and JS output are identical (`tests/test_rf_timeline.py`).
- feat: `rf-optimizer.js` gains `whatIf`, `applyChange`, `diffAnalytics`, `recommend` (coverage score out of 100 and ranked actions with measured deltas and confidence), `designNetwork`, `narratePlan` and `planPayload`; new config blocks `timeline` and `recommendations`.
- feat: planner tab "Timeline and what-if": path tool and chart with scrubber, what-if before and after panel, ranked actions with Apply, Design my network with undoable apply and narration through `POST /api/planner/explain` (rule-based fallback, LLM wording UNVERIFIED, mock tested only). Worker jobs `recommend` and `design`.
- feat: scenario presets hospital ward, smart home and apartment with neighbours (ten in total).
- test: `tests/test_rf_timeline.py`, `tests/test_rf_recommend.py`; `tools/planner_smoke.py` covers the new tab, live and demo.

### RF lab documentation and status
- docs: `docs/platform/24-rf-lab-status.md` lists every mandate section as complete, partial or deferred with files and open gaps (room creation tool, true 3D, exact ray tracing, survey calibration and real-hardware validation are not complete).
- docs: `CONTRIBUTING.md` (setup, checks, parity workflow, adding a material, adding a heat layer, commit style); architecture diagram updated in `03-architecture.md`; propagation methodology in `15-wifi-physics.md` and `rf-planner.md`; optimization guide in `09-rendering-optimization.md`; deployment operations notes in `14-deployment-plan.md`; roadmap and top 100 statuses updated (rows 5, 6, 18, 35 and 49 are Done, rows 30, 53, 66, 68 and 82 are Partial); stale README rows corrected.
- docs: screenshots regenerated with `tools/screenshot.py` and `tools/planner_smoke.py`, live and demo.

### Accessibility, production readiness and throttled performance
- feat: `tools/a11y_check.py` (dev only) runs axe-core, fetched from npm into a temp dir at run time, on the planner and dashboard (live and demo) plus keyboard, focus ring and error boundary checks. Fixed: floor button labels, `#envChips` role, light theme ribbon contrast, banner landmarks. Now 0 violations in dark, light and high contrast.
- feat: planner Contrast button and `prefers-contrast: more` high contrast mode, 3 px focus rings, `forced-colors` outlines, rem base font size.
- feat: front-end error boundary in `common.js`: uncaught errors and promise rejections appear in the page notice with `role="alert"`.
- feat: `X-Request-ID` on every response, one log line per API request, optional JSON logs (`log_json`, `WALLHACK_LOG_JSON=1`, `wallhack/logging_setup.py`), JSON 500 handler with request id, local-only `GET /api/diagnostics`.
- perf: the analysis worker job reuses the coverage grid it already computed for map layers (`analyzeFloorWithGrid` in `rf-engine.js`); a layered analysis went from 148 to 100 ms (worker) and from 970 to 597 ms (main thread, 6x CDP throttle). `tools/perf_rf_browser.py --throttle` measures 1x, 4x and 6x; numbers in `docs/perf-rf.md`, labelled as an approximation.
- test: request id, diagnostics secrets and locality, error handler, JSON formatter, error window and grid reuse equality tests.

### Scenarios, educational mode, explain and reports
- feat: scenario presets (`scenarios.json`, generator `tools/make_scenarios.py`) loadable from the planner and the offline demo; `validateScenarioLibrary` in `planner-state.js`.
- feat: educational mode (`planner-learn.js`, `learn-content.json`): Learn toggle with contextual panels, six lessons with engine-computed checks and an undoable "Show me", and a "why is the signal weak here" panel from the engine explain output.
- feat: `POST /api/planner/explain`, grounded on engine numbers with a deterministic fallback when the LLM is off, number-grounding check on replies, consent kept for cloud providers.
- feat: `rf-optimizer.js` gains `planChannelsSinr`, `suggestMeshNodes` and `suggestDeadZoneFixes`; the Smart planner lists them with confidence and rationale. New `planner` config keys `sinr_default_standard`, `sinr_default_standard_6ghz`, `channel_sinr_passes`, `max_dead_zone_fixes` and `confidence.full_gain_db`.
- feat: PDF report adds floor overview, per-mode coverage maps, AP locations, spectrum summary, performance and a text summary.
- test: `tests/test_scenarios.py`, `tests/test_planner_learn.py`, `tests/test_explain.py`; `tools/planner_smoke.py` covers presets, lessons, advice and the report; new screenshots in `docs/`.

### Platform documentation
- docs: `docs/platform/` audit and design set (README index, 01 to 06, 08 to 23, generated material database as 07, `adr-frontend-stack.md`) written from the code with evidence tables, honest VERIFIED / PARTIALLY VERIFIED / UNVERIFIED labels, a ranked top 100 list whose Done rows cite existing files, and DESIGN ONLY labels for educational mode, AR, computer vision, campus and smart-city planning.
- test: `tests/test_platform_docs.py` checks the files exist, the top 100 has at least 100 ranked rows in composite order, the composite matches its formula and every Done row cites files that exist.
- docs: `docs/rf-planner.md` no longer lists antenna patterns as not modelled (they are, since the WiFi standards work).

### RF planner UI
- feat: map layers in the planner (RSSI, SNR, SINR, quality score, bandwidth, latency, packet-loss likelihood, wall attenuation, interference, channel utilisation, capacity, and a combined weakest-layer map) drawn through the WebGL and canvas heat renderer, with a gradient legend that states real units, side-by-side compare, palettes viridis and cividis, and roaming, strongest-AP and signal-blend overlays from the exact per-cell data. Constants live in `rf-config.json` `planner_layers`.
- feat: AP panel controls for streams and MLO links plus per-AP SINR, reliability and MLO results; Spectrum tab (canvas of channel congestion, source spans and suggested channels); Dashboard tab (histogram, coverage, edge coverage, weakest and strongest zones, throughput, efficiency); Environment tab and editor tools (D, O, S, X) for doors, windows, stairwells and interference sources, all undoable; floor up and down buttons and Page Up and Page Down.
- feat: view settings (layer, palette, compare, combine, overlays) persist in browser storage and the page URL (`?layer=sinr&palette=viridis`).
- change: the analysis worker job returns the requested layers as transferable arrays; `rf-engine.js` also exports `apRadio`, `sourceSpanMhz` and `channelCentreMhz`.
- test: layer, palette, dashboard, spectrum, editor geometry, op and view-persistence tests; `tools/planner_smoke.py` clicks the AP controls, every layer and palette, spectrum, dashboard, interferer, door, stairwell and floor controls.

### RF planner engine
- feat: RF lab engine upgrade, Python reference with JS mirror and parity tests (`tests/test_rf_lab.py`): materials plaster, insulation, office partition and industrial wall (with sources and ranges, material doc regenerated); configurable `interferers` (microwave oven, Bluetooth hopping, neighbour WiFi) folded into SINR; estimated PER, loss, latency and airtime per cell (`sinr.reliability`, config-driven, documented as estimates); optional floor `voids` (stairwell, atrium, shaft) that reduce floor loss locally; `probe_at(..., explain=True)` and `probeAt(..., {explain: true})` with each wall, floor loss, indirect path and SINR term as numbers and text; `spectrum_analysis`; `signal_decay`; exact per-cell roaming data `roaming.map`. `twin.py` and `planner-state.js` validate the new fields. Legacy projects give identical output.
- change: `analytics.roaming.zones` no longer has a `bbox`; the planner roaming overlay draws exact cells from `roaming.map`. `PUT /api/twin` size limit now counts the void and interferer lists.
- perf: the engine grid path on the 100,489 point floor went from 1675.1 ms to 684.6 ms (node, median, 4 APs, 1000 walls). Profile and numbers in `docs/perf-rf.md`. Results are identical (parity tests unchanged).
- fix: `planner-state.js` accepted inherited object keys such as `constructor` in `mlo_bands`; it now checks own keys only. Both validators have tests for malformed `mlo_bands`.
- feat: `PUT /api/twin` allows at most `limits.max_concurrent_twin_puts` (2) uploads at once and answers 429 with `Retry-After: 1` beyond that.
- test: the explicit-width test read a key that does not exist, so it never checked the width; it now reads `sinr.aps[0].width_mhz`.
- fix: a Wi-Fi 4 AP on 5 GHz without `width_mhz` made `analyze_floor` raise (the band default of 80 MHz is not a Wi-Fi 4 width). `_ap_radio` and `apRadio` now use `default_width_mhz(standard, band)` when the AP has a `standard`, so the reported `width_mhz` for such APs is 40. Tests cover every standard and band in Python and against JS.
- fix: `mlo_bands` with a non-string entry (for example `[[1]]`) caused an uncaught TypeError (HTTP 500) in `twin.py`; both validators now reject it with a normal validation error, with parity tests.
- docs: top-100 rows 5, 6 and 35 are Partial: the engine and API compute PHY rate, SINR and MLO, but no planner UI shows them. The band validation test was reworded from "unknown band" to a path prefix check.
- feat: 100,000 point benchmark (`node tools/perf_rf.js --points 100000 [--aps K]`, also in `tools/perf_rf_browser.py` with a real Web Worker) with a bench-local quadtree compared with the engine's uniform grid and brute force. Measured result in `docs/perf-rf.md`: the quadtree is slower than a uniform grid on the same kernel, so `rf-engine.js` keeps the grid. Octree not applicable (2D engine), no GPU compute path exists.
- feat: material intelligence database. `rf-config.json` `materials` now has ten families (new: reinforced concrete, stone, flooring, roofing) with per-band `range_db` (min, typical, max), a derived `frequency_exponent`, `confidence`, `simulation_cost`, `sources` and `notes`. Existing materials keep their attenuation and reflection values, so saved projects and parity tests are unchanged. New `rf-config.schema.json` (JSON Schema 2020-12) is checked by `tests/test_rf_config_schema.py` with a stdlib validator, `docs/platform/material-database.md` is generated by `tools/material_doc.py` and a test fails if it drifts. The planner palette and wall material select list the new materials. Flooring and roofing are reference values, the 2D engine applies floors as a fixed `floor_loss_db`.
- feat: WiFi 4, 5, 6, 6E and 7 (`rf-config.json` `wifi_standards`), per-width and stream PHY rates from the IEEE 802.11 OFDM formula, noise floor from the width, SINR with co-channel and adjacent-channel interference (`interference`), SINR throughput as the new optional `sinr` analytics section, and an MLO capacity model for Wi-Fi 7. New optional AP fields `standard`, `width_mhz`, `spatial_streams`, `mlo_bands`, `antenna_gain_dbi`, `azimuth_deg`, `pattern`, `beamwidth_deg`, `front_to_back_db`, validated in `twin.py` and `planner-state.js`; AP panel gets standard, width, antenna and azimuth controls. Legacy projects give identical results. Refraction is documented as not modelled. Formulas and sources in `docs/rf-planner.md`.
- fix: the sticky header covered the top of the planner panels (compare, analytics) when they were scrolled into view. `--header-h` in `style.css` now drives `scroll-padding-top` and `scroll-margin-top`; the four planner compare and analytics screenshots are regenerated.
- fix: an AP with an unknown band and no channel was accepted when no band list was passed; `validateProject` now checks the band against `rf-config.json` bands.
- fix: projects with an empty or whitespace-only name failed to load in `twin.validate_twin` (and a whitespace name was kept by the planner); both now use `Untitled`.
- fix: `PUT /api/twin` had the 1 MB cap, so a twin with floor-plan images (up to 600000 characters each) returned 413. It now has its own limit, `app.MAX_TWIN_BODY_BYTES`, derived from the `limits` in `rf-config.json` (`max_floors` x (`max_background_chars` + items x `twin_json_bytes_per_item`) + `twin_body_overhead_bytes`, about 23 MB). Every other route keeps the 1 MB cap (`MAX_BODY_BYTES`).
- fix: the editor, note box and scenario names allowed 80 characters while the validator allowed 64, so a 65 to 80 character label made the saved project fail to reload. All of them now read `limits.max_text_chars` from `rf-config.json` (input `maxlength`, `PlannerState.clipText`, a visible "shortened" message). On import, wall, AP and device names, labels, note text and scenario names longer than the limit are truncated instead of rejected, so projects saved by earlier builds load; ids and other fields stay strict.
- fix: an AP with an unknown band and no band list in the options raised a TypeError; it is now a `ProjectError`. The module-level mutable text limit is gone: the limit is passed explicitly, and `makeScenario`, `renameScenario`, `duplicateScenario` and `validateCapacity` take it as an argument.
- fix: knife-edge diffraction used `v = sqrt(2 delta / lambda)`; the Fresnel-Kirchhoff parameter is `sqrt(4 delta / lambda)` (`engine.knife_edge.v_scale` is now 4.0). Enhanced and multipath modes lose about 3 dB more behind wall corners; basic mode and legacy numbers are unchanged. New test with a hand-computed J(v) case.
- fix: planner project import validates custom materials, rooms, furniture and sensors, checks AP channels against the band, uses prototype-free lookups so ids such as `constructor` work, and shares its limits with `twin.py` through `rf-config.json` `limits` (other lists are capped at 200 items).
- fix: the 200-item cap also applied to walls, so a planner project with 1000+ walls could be neither imported nor saved to `/api/twin`. `rf-config.json` `limits` now has `max_walls_per_floor` and `max_openings_per_floor` (both 5000, read by `twin.py` and `planner-state.js`); a 5000-wall, 5000-opening twin is about 0.8 MB and fits the 1 MB request cap. Tests import 1000 and 5000 walls in JS and Python and check the over-limit error.
- fix: a stale worker error no longer shows a notice; unsaved scenario or capacity edits are tracked with a revision instead of poisoning the saved position.
- feat: `wallhack/static/rf-config.json` holds every RF number (bands 2.4/5/6 GHz, six wall materials with per-band attenuation and reflection loss, openings, floor loss, quality bands, rate tables). Values are typical planning estimates.
- feat: `rfmodel` is frequency-aware, takes an optional wall `material`, per-AP `band`/`channel`, and modes `basic` (default), `enhanced` (single reflection, knife-edge diffraction) and `multipath` (incoherent power sum). Defaults are bit-identical to before (golden fixture `tests/fixtures/rf_legacy_golden.json`).
- feat: `static/rf-engine.js` ports the model with a uniform-grid spatial index; `tests/test_rf_parity.py` checks it against Python within 0.1 dB and the index against brute force on 1000 walls.
- feat: `GET /api/rf/coverage?band=&mode=`, `GET /api/rf/config`, `/planner` route. `validate_twin` accepts the new optional fields.
- docs: `docs/adr-rf-engine.md`, `docs/rf-planner.md` (propagation model).
- feat: analytics (coverage, quality bands, weak area, dead-zone regions, best-AP map, AP overlap, roaming zones, throughput, client capacity, channel utilisation) in `rfmodel.analytics` and `RFEngine.analytics`, plus a point probe for tooltips. Throughput, capacity and utilisation are labelled ESTIMATES.
- feat: `RFEngine.compareScenarios` (per-cell dB delta, deltas, explainable optimisation score).
- feat: `static/rf-optimizer.js` Smart WiFi Planner: issue detection, greedy AP placement, AP count, overpowered/underpowered APs, channel plan, and a model-sensitivity confidence score in [0, 1].

### RF planner page (`/planner`)
- feat: floor-plan editor (`planner-editor.js`): draw walls by dragging or by dropping a material from the palette, move, rotate (15 degree steps, Shift for free), endpoint and midpoint handles, grid snapping (0.1, 0.25, 0.5, 1 m) and endpoint snapping, room labels, access points, multi-select box, right-click menu, keyboard shortcuts (`?` lists them), pan, wheel zoom and pinch, floors selector.
- feat: project state (`planner-state.js`): versioned JSON (`schema_version` 1) validated on import with field-level errors, command based undo/redo (200 steps, drags coalesce into one step), autosave to localStorage with quota handling.
- feat: floor-plan image import (downscaled to 2048 px, kept as a data URL, never uploaded) and two-click scale calibration.
- feat: `rf-worker.js` computes the heat map in a Web Worker in 16x16 cell tiles: coarse pass first, then refinement; per-AP cache so an AP move recomputes only that AP and a wall edit only the tiles it can affect; stale requests are dropped. Falls back to time slices on the main thread with a visible notice. `RFEngine.computeApRegion` computes one tile.
- feat: `planner-heat.js`: WebGL renderer (RSSI texture, colour LUT, bilinear smoothing, banded mode, dead-zone hatch) with canvas 2D fallback, band contour lines (marching squares), colour-blind safe palette, legend with dBm ranges, hover and keyboard tooltip (RSSI, throughput estimate, distance, obstruction count, best AP), mini-map. Heat maps are always labelled MODEL ESTIMATE, not a measurement.
- feat: `/planner` is linked from the dashboard, mobile and judge pages and is part of the static demo (`vercel.json` CSP gains `worker-src 'self'`).
- test: `tests/test_planner_state.py`, `tests/test_rf_worker.py`, `tests/test_planner_heat.py`, `tools/planner_smoke.py` (Playwright).
- docs: `docs/perf-rf.md` with measured numbers (`tools/perf_rf.js`, `tools/perf_rf_browser.py`).

### RF planner integration
- chore: `tsconfig.json` and `make typecheck` (tsc `checkJs`, dev only); JSDoc fixes in `rf-engine.js` and `rf-optimizer.js`.
- test: `tools/screenshot.py` captures the planner (main, analytics, compare, light, phone width, plus `-demo` variants) and fails on a blank heat map.
- docs: requirement Status table, typed interfaces section, README verification rows and screenshots.

### RF planner analysis, scenarios and exports
- feat: analytics dashboard (coverage, average RSSI, weak area, dead zones with Locate, overlap, roaming zones, per-AP throughput, client capacity and channel utilisation, all labelled ESTIMATE, tables as text equivalents).
- feat: scenarios saved with the project, side by side, delta and slider comparison, metric diff, optimisation score breakdown and ranking.
- feat: Smart planner panel in the worker with progress and cancel, confidence per recommendation, ghost preview, undoable Apply and Apply all.
- feat: `PlannerExport.register` with PNG, CSV (formula-injection safe), project JSON (schema_version 2, drag and drop), hand-built PDF report, print stylesheet and annotations (text, arrow, pin).
- feat: bonus modes: multi-floor stack with Add floor, 3D building view (reuses `Room3D`), mesh backhaul, capacity planning, IoT placement, enterprise lattice with bill of quantities CSV. See `docs/rf-planner.md` for what each does and does not model.
- fix: undo of a property removal (for example resetting an AP channel) did not restore the old value because absent values were dropped by the history copy; they are now recorded as `null`.
- feat: `rf-optimizer.js` and the new planner scripts are part of the static demo build.
- test: `tests/test_planner_panels.py`, worker job tests, planner smoke extended (analytics, plan, apply, scenario, compare, exports, annotations, modes).

### Review fixes
- fix: LAN mode keeps a Host allow-list for loopback clients (localhost, 127.0.0.1, ::1, the LAN IP, the configured host), closing DNS rebinding against `/api/pair`. `/api/pair` also refuses requests with an `Origin` header.
- fix: JSON bodies on `PUT /api/twin`, `POST /api/settings` and `POST /api/insights/explain` are capped at 1 MB (413).
- fix: judge item `mobile` is PARTIALLY VERIFIED and tracks the real-phone README row. A test asserts `config.LLM_PROVIDERS == llm.PROVIDERS`.
- docs: `confirm_off_device` is a client-side consent flag, not a server-enforced policy (documented, not changed).

### Docs and polish
- docs: README run instructions per mode, LLM provider table, status of the ten platform items, expanded privacy notice.
- ci: install opencv-python-headless so the QR decode tests run in CI.
- fix: judge page no longer shows a demo Pause button that did nothing; judge status glyphs are decorative (aria-hidden, symbol font fallback) and the status text chips carry the meaning.

### Mobile companion, premium UI and judge mode
- feat: `wallhack/qr.py` pure-Python QR encoder (byte mode, level M, versions 1-6, written from the spec, no third-party code). `GET /api/pair` now also returns `qr` module rows; the dashboard pairing card draws them on a canvas with LAN instructions and a security note. Tests decode the codes with OpenCV when installed.
- feat: `mobile.html` / `mobile.js` (`/mobile`): occupancy, vitals, sensor status, in-page alerts and opt-in Notification API alerts by polling `/api/status`. In the static demo it replays the recording. Notifications UNVERIFIED (blocked on plain http by many browsers).
- feat: `judge.html` / `judge.js` (`/judge`) fed by `wallhack/judge.py` (`GET /api/judge`, `judge.json` in the demo): Built, Experimental, Future, Unsupported per item. Smart Home Automation and Enterprise analytics are Future, LLM is Experimental and UNVERIFIED. `tests/test_judge.py` compares every item with its README verification row.
- feat: premium UI. `common.js` (shared JSON loading, quality attribute, seeded ambient particles), glass cards with `@supports` fallback, animated ambient background, depth blur on high quality. `view3d.js` adds WiFi flow particles, CSI activity particles, neon wall edges, additive bloom and depth-of-field on high. Low quality turns all of it off, reduced motion freezes it.
- test: `tools/screenshot.py` also captures the timeline, insights, game and pairing cards and the mobile and judge pages (live and demo) and fails on JS errors or blank canvases.

### Digital twin platform (dashboard)
- feat: 3D twin view (`view3d.js`): stacked or single floor, rooms, walls, doors, windows, furniture, sensors, access points, live room occupancy from zones, optional signal heat overlay from `/api/rf/coverage` (MODEL ESTIMATE; low quality samples every other cell). Fixes overlapping link labels (router-a/router-b) in the signal view.
- feat: `twin.js` designer (add, edit, delete rooms, furniture, doors, windows, sensors, APs; save with `PUT /api/twin`; read-only in the demo). `panels.js`: RF intelligence strip with trend arrows, smart home Healthy/Warning/Danger cards, Health Mode (Experimental banner, "Not medical data. For research purposes only.", mood, perspiration, thoughts and through-wall imaging shown as Not supported), insights copilot with provider selector and cloud disclosure, timeline playback with PLAYBACK badge.
- feat: `game.js` placement game. JS only takes the per-cell maximum, threshold and cost from server grids; `tests/test_game_parity.py` checks it against `game.score_selection` on all 257 selections.
- feat: demo serves the new data files through `demo.js`; `tools/build_demo.py` adds `coverage.json`.

### Digital twin platform (backend)
- feat: `wallhack/twin.py` building model with validation and atomic save to `data/twin.json`; `GET/PUT /api/twin` (same-origin, JSON only).
- feat: `wallhack/rfmodel.py` log-distance path loss with per-wall, door and window attenuation and `GET /api/rf/coverage`. A model ESTIMATE.
- feat: `wallhack/history.py` SQLite history with retention (`history_max_rows`), sessions and `GET /api/history`; Healthy/Warning/Danger `status` in `/api/environment`.
- feat: `wallhack/insights.py` deterministic rules and `wallhack/llm.py` opt-in rewording (ollama, llama.cpp, OpenAI, Azure; keys from env vars only; cloud needs per-request confirmation). Tested against mocked local servers only; real providers UNVERIFIED.
- feat: `wallhack/scores.py` RF intelligence scores, `wallhack/game.py` apartment placement scenario, `GET /api/health` with explicit unsupported metrics.
- feat: opt-in `--lan` / `WALLHACK_LAN=1` with a random pairing token (cookie or bearer) for HTTP and WebSocket; default bind stays 127.0.0.1.
- feat: `tools/build_demo.py` also exports history, twin, insights, scores, health and scenario JSON, takes tick constants from `wallhack.runtime` instead of copying them, and `vercel.json` pins numpy (PR #4 review notes). A test now asserts the built index has no inline script.

### Static Vercel demo
- feat: `tools/build_demo.py` records the real Python Runtime (Simulator, SensingEngine, simulated environment) into `dist/recording.json`, one frame per WebSocket tick, and assembles a static site with relative paths. Deterministic (byte-identical builds). Needs numpy, not fastapi. No processing is ported to JS.
- feat: `wallhack/static/demo.js` plays the recording in a loop, with a pause button, a persistent "Simulated replay" banner, and read-only settings and calibrate. `app.js` behaves as before when the demo marker is absent.
- feat: `vercel.json` (build, output dir, CSP and security headers); `tools/screenshot.py --demo` writes `docs/screenshot-demo.png`. VERIFIED locally with http.server and headless Chromium; an actual Vercel deployment is UNVERIFIED.

### 3D view upgrade
- feat: 3D room view on the same 2D canvas, no libraries: gradient floor with distance-fading grid, translucent glowing zone volumes drawn far to near, expanding WiFi rings from the access point, glowing link arcs with comet pulses, a stylised person per occupied zone (breathing swell, heart-rate ring), seeded ambient dust, vignette. Verified by node unit tests (seeded dust, quality helpers) and one headless Chromium screenshot run; visuals on a real Pi UNVERIFIED.
- feat: quality selector (low, medium, high; default medium) saved in localStorage `wallhack.quality`. Low caps devicePixelRatio and frame rate and skips glow and dust. A sustained average frame time above 40 ms drops to low automatically (not saved).
- feat: `prefers-reduced-motion` stops auto-rotate and freezes ring, dust and pulse animation; the view still redraws on new data and on interaction.

### Vitals and environment sensing
- feat: heart rate from CSI (0.8-2.0 Hz, needs 8 Hz or more raw, not quantised, still person, peak ratio 30) and an activity classifier (empty, still, walking, active). Verified on synthetic data only; UNVERIFIED on real CSI. The simulated heartbeat is exaggerated and flagged SIMULATED. New events `heart_detected` and `heart_lost`.
- feat: `wallhack/environment.py` with US EPA AQI (2024 PM2.5 breakpoints, PM10), dew point, heat index and worst-of air-quality ratings. VERIFIED by unit tests.
- feat: optional sensor drivers in `wallhack/sensors/` (PMS5003, SCD40/41, ENS160, ZE08-CH2O, MLX90614) with pure frame parsers and an `EnvironmentHub` that reports ok, stale or error per sensor. pyserial and smbus2 are lazy optional imports. Parsers PARTIALLY VERIFIED (hand-built frames); hardware UNVERIFIED.
- feat: config `sensors`, `serial_pms`, `serial_hcho`, `i2c_bus`, flags `--sensors --pms-port --hcho-port --i2c-bus`, env `WALLHACK_SENSORS` and friends, `./install.sh --sensors`.
- feat: `status.environment` and `status.vitals`, `GET /api/environment`, `GET /api/vitals`. With a real source and no sensors configured, environment is `null`; the simulator provides a SIMULATED environment.
- docs: ZE08-CH2O byte layout cross-checked against two third-party transcriptions of the Winsen manual (PARTIALLY VERIFIED, PDF not fetched); added a literal-frame test.
- docs: README feature overview and verification table, `docs/hardware.md` sensor parts, Pi 4 wiring, UART setup, limits, and the not-built list (mood, perspiration, through-wall imaging, thermal image).
- ci: shell syntax check now includes `run.sh`.
- fix: `EnvironmentHub.poll_once` no longer raises on a driver returning unknown fields (or any driver exception). That sensor is marked error with the reason logged, and the other sensors keep polling.
- fix: UART framing (PMS5003, ZE08-CH2O) validates the checksum while choosing a frame, so header bytes inside a payload no longer select a misaligned frame. After a corrupt frame the buffer resyncs.
- fix: ENS160 warm-up and initial start-up readings are held back and reported as a new `warming` sensor state instead of being rated as valid.

### Dashboard redesign
- feat: dark-first glass-card dashboard (teal/violet), responsive to phone width, reduced-motion aware, keyboard focus styles.
- feat: Vitals card (heart rate with pulsing indicator, breathing, activity badge, low-confidence note when CSI is under 8 Hz) and Environment section (AQI ring with EPA bands, PM, CO2, TVOC, HCHO, temperature, humidity, dew point, heat index, surface temperature, sparklines, per-sensor status chips). Simulated values carry a SIMULATED ribbon; missing sensors show a `--sensors` hint.
- feat: 3D room view (`static/view3d.js`, own projection maths, no libraries): orbit by drag, zoom, auto-rotate, reset. Signal-activity visualisation with schematic positions, not imaging. Projection helpers tested under node (`tests/test_view3d.py`), canvas drawing UNVERIFIED beyond headless screenshots.
- docs: "About these readings" lists what WiFi cannot sense (mood, perspiration, imaging). `tools/screenshot.py` now writes desktop, 3D and mobile screenshots and fails on JS errors or a blank 3D canvas.

- fix: empty environment tiles show the actual sensor status (error, stale, warming) instead of always suggesting `--sensors`.
- fix: the heart rate on the Vitals card carries a permanent "experimental" tag.

### Real Pi 4 CSI
- feat: `scripts/pi_setup.sh` (check, install, start, status, stop/restore, `--dry-run`, `--yes`) builds nexmon_csi on a Pi 4 per the upstream recipe. Only dry-run and check logic tested; UNVERIFIED on hardware.
- feat: `./install.sh --pi-csi` runs the read-only preflight after installing; no-argument behaviour unchanged.
- feat: `docs/wallhack.service` is a CSI-capable unit with a dedicated user and ambient capabilities (UNVERIFIED).
- docs: Pi 4 step-by-step guide, buy list, troubleshooting, and an honest "what this can and cannot see" section; the BCM43455c0 CSI format is int16, not 32-bit packed.
- feat: `pi_setup.sh install` discloses `apt full-upgrade`, armhf, symlinks and setcap before asking; the archived unauthenticated python2.7 repository now needs `--allow-archived-python27` or a typed phrase, and `--yes` never allows it.
- feat: `pi_setup.sh` records setcap grants, the armhf architecture and symlinks in `<build-dir>/state`; `restore` removes the setcap grants, offers to remove created symlinks and lists what remains. Upstream `restore-wifi` confirmed to exist in `Makefile.rpi`.
- change: `start` no longer sets file capabilities on tcpdump under `--yes`; use `--grant-tcpdump-caps` or the systemd unit.
- feat: the dashboard note shows why the capture process stopped (for example tcpdump permission denied).
- ci: `bash -n` on the shell scripts.

### Dashboard upgrade
- feat: `POST /api/calibrate` resets learned baselines (same-origin check, also now applied to `POST /api/settings`); Calibrate button in the dashboard.
- feat: light/dark theme toggle (saved in localStorage, follows the OS by default), mobile-friendly header, offline banner and "Waiting for readings" empty states.
- feat: event log export to JSON or CSV (client-side, spreadsheet formula characters escaped); optional beep on presence/motion, off by default.
- fix: WebSocket stream resumes after a source change restarts sample numbering.

### Polish
- ci: GitHub Actions workflow runs pytest (Python 3.9 and 3.12) and `node --check` on push/PR with read-only permissions; not yet run on GitHub (UNVERIFIED).
- fix: forwarder logs and continues if forwarding a packet fails; CRLF netsh output covered by a test.
- feat: browser opens by default when run from a terminal (`--no-browser` to skip); `Makefile`, `pyproject.toml` with a `wallhack` command.
- feat: `wallhack/nexmon.py` and `NexmonCollector` read real nexmon_csi frames from a `tcpdump` pcap stream (`--csi-source nexmon`, `--csi-port`); `--csi-check [SECONDS]` diagnoses a capture. VERIFIED on synthetic frames only, UNVERIFIED on Pi hardware.
- fix: the forwarder reuses `wallhack/nexmon.py`; docs no longer claim the Pi 4 packs 32-bit CSI (it is int16 I/Q).
- feat: `tools/csi_forwarder.py` converts nexmon_csi frames to the UDP JSON format (UNVERIFIED on hardware); docs/hardware.md no longer references a missing script.
- feat: `netsh` parsing no longer depends on the Windows display language; fixture tests added.
- feat: dashboard has presence/motion/breathing pills and a SIMULATED/REAL chip.
- fix: found by running the page in headless Chromium: a late poll response overwrote the "live" chip with "polling".
- docs: simpler README quick start; screenshot via `tools/screenshot.py` (optional playwright).

### Review fixes (feat/wifi-sensing)
- fix: `uvicorn[standard]` so `/ws` works on a real server. Test: real-process WebSocket smoke test.
- fix: Host allow-list (localhost, 127.0.0.1) on loopback binds, WebSocket Origin must match Host, `POST /api/settings` requires `application/json`.
- fix: breathing is disabled when raw data is under 4 Hz or all multiples of 0.5 dB; the status note says so.
- fix: collector polling and probing no longer hold the API lock; stale readings from before a settings change are dropped.
- fix: UDP packets carry their own receive time. Optional `--udp-token` rejects spoofed packets; `--udp-host` added (docs previously implied the receiver was LAN-reachable by default).
- fix: `--source real` with no readings now errors (CLI exit, HTTP 422 on settings, previous settings kept). Real sources with no data for 10 s show a "no new readings" note.
- refactor: removed unused `parse_wdutil` and the wdutil claims. `pytest`/`httpx` moved to `requirements-dev.txt`.
- fix: `--udp-token` is now passed to the UDP collector by `Runtime` (it was parsed but ignored). Test: `test_runtime_passes_udp_token_to_collector`.
- fix: `::1` removed from loopback hosts; Starlette's Host check cannot parse `[::1]:port`, so `--host ::1` is treated as exposed and warns.
- docs: README table relabelled: processing is verified on simulated data only.

Review items not fully resolved (justification):
- Real-RSSI fixture (item 3): no real capture can be recorded in this sandbox. Real-signal accuracy is marked UNVERIFIED instead of adding a fabricated trace.
- `auto` mode still commits to the simulator when the first probe fails (item 7, possible): it is labelled by a visible note, and changing settings re-probes. Not changed to avoid a background retry loop.
- Non-English Windows `netsh` labels (details section): documented in README, not fixed without real samples.
- Install-script robustness (partial `.venv`, hidden pip upgrade output): not changed, out of the blocking scope.

- Backend: presence, motion and FFT breathing-rate processing, seeded deterministic simulator, platform collectors (iw/nmcli, netsh, system_profiler/wdutil, ping, ESP32 UDP CSI), FastAPI API and WebSocket.
- Status: VERIFIED by 36 automated tests on simulator data and fixture text. Real collectors are UNVERIFIED on hardware.
- Dashboard: offline vanilla JS page (status badge, RSSI and motion graphs, breathing gauge, zone heat map, event timeline, settings drawer, privacy/consent banner, WebSocket with polling fallback).
- Dashboard status: PARTIALLY VERIFIED. Files served and JS syntax checked by tests; visual rendering in a real browser was not executed.
- One-step install/run scripts: install.sh, run.sh (Linux, Pi, macOS), install.ps1, install.bat, run.bat (Windows, UNVERIFIED).
- Smoke test starts the simulator server and checks /api/status and /.
- README quick start with verification table; docs/hardware.md and docs/wallhack.service.
