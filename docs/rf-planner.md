# RF planner

## Propagation model

MODEL ESTIMATE, not a measurement. Implemented in `wallhack/rfmodel.py` (reference) and
`wallhack/static/rf-engine.js` (port). Numbers are in `wallhack/static/rf-config.json`.

**Direct path (mode `basic`, default).**
`RSSI = tx - PL(d) - sum(wall losses on the straight path) - floors_apart * floor_loss(band)`,
`PL(d) = PL0(band) + 10 * n(band) * log10(max(d, 1 m))`. `PL0` follows free space,
`PL0(f) = 40 + 20 * log10(f / 2.4 GHz)`, using 2.4, 5.5 and 6.5 GHz for the three bands.

**Materials.** Each wall has an optional `material` (drywall, wood, brick, concrete, glass, metal, or a
project-defined one in the twin's `materials`). Without it the kind default applies (interior drywall,
exterior brick), which equals the original 4 dB and 9 dB at 2.4 GHz. A door or window opening replaces the
wall loss where the path crosses it.

**Mode `enhanced`.** Strongest single path of:
1. the direct path;
2. a first-order reflection per wall (image method): mirror the AP across the wall line, require the
   image-to-receiver segment to hit the wall, loss = `PL(total path) + reflection_loss(material) +` losses of
   other walls crossed on both legs, for walls within `max_reflector_range_m`;
3. diffraction around endpoints of walls that block the direct path (knife-edge): `delta = d1 + d2 - d`,
   `v = sqrt(4 * delta / lambda)` (the Fresnel-Kirchhoff `v = h * sqrt(2 (d1 + d2) / (lambda d1 d2))` with `delta ~ h^2 (d1 + d2) / (2 d1 d2)`), `J(v) = 6.9 + 20 log10(sqrt((v - 0.1)^2 + 1) + v - 0.1)`.

**Mode `multipath`.** Incoherent sum, in mW, of the direct, all reflected and all diffracted paths.
So `multipath >= enhanced >= basic` at every point.

**Where default values come from.** Frequency scaling is free-space physics. Material attenuation and
reflection values are rounded typical figures within the ranges reported by ITU-R P.2040 and published
indoor measurements. They are typical estimates. Real walls vary with thickness, moisture and
reinforcement, so calibrate with a site survey.

**Not modelled.** Fast or slow fading, antenna patterns, polarisation, furniture and people, second-order
reflections, 3D geometry (the plan is 2D; floors add a fixed loss), coherent phase effects.

## Analytics
Every number in this section is an ESTIMATE derived from modelled RSSI, not a measurement. Constants are
in `rf-config.json` (`analytics`, `mcs_tables`, `scoring`). `rfmodel.analytics` is the reference and
`RFEngine.analytics` the JS port; `tests/test_rf_planner_js.py` compares them. Cells are the grid cells
of `coverage_grid`, area per cell is `cell_m^2`.

- **Coverage %**: cells with best RSSI at or above `coverage_dbm` (-70 dBm). Percentages per quality band
  (excellent, good, fair, poor, none) use the `quality_bands` thresholds.
- **Average RSSI**: mean of the best-AP RSSI over all cells.
- **Weak area**: cells in the `poor` band (-85 to -75 dBm), in m2 and %.
- **Dead zones**: cells below `dead_zone_dbm` (-85 dBm), grouped into 4-connected regions by flood fill, each
  with area, bounding box and centroid in metres.
- **Best-AP map**: index of the strongest AP per cell (ties go to the first AP), -1 for dead cells.
- **AP overlap**: cells where at least two APs are at or above `overlap_min_dbm` and within
  `overlap_margin_db` of the strongest, with a cell count per AP pair.
- **Roaming zones**: cells where the strongest and second-strongest AP are both at or above `roam_min_dbm`
  and within `roam_margin_db` (8 dB) of each other, grouped into regions. These are handoff candidates.
- **Throughput**: RSSI to PHY rate with the highest `mcs_tables[band][width]` row the RSSI reaches (0 below
  the lowest), times `mac_efficiency`. The serving AP's band and width apply.
- **Client capacity per AP**: an airtime model. With equal demand `D` per client and per-cell rates `r_i` over
  the cells the AP serves, the AP carries `H / D` clients, where `H` is the harmonic mean of the `r_i`
  (slow cells use more airtime). Capacity is `floor(H / D)`, `D = per_client_demand_mbps`.
- **Channel utilisation per AP**: expected clients in its cells (`client_density_per_100m2` times served area)
  times `D`, divided by `H`. Co-channel neighbours (same band and channel) whose signal at this AP is at or
  above `carrier_sense_dbm` add their own load. Values at or above 100% are marked saturated. Adjacent channel
  interference is not modelled.
- **Probe** (`probeAt`, `rfmodel.probe_at`): RSSI, quality, best AP, plan distance, walls crossed, openings
  crossed (a crossing inside an opening counts as an opening), floors crossed and throughput estimate at one
  point, for hover tooltips.
- **Scenario comparison** (`RFEngine.compareScenarios`): per-cell dB delta (b minus a), coverage, dead-zone,
  mean RSSI, throughput and AP-count deltas, and an optimisation score per scenario. Score = sum of
  `sign * weight * value` over coverage (fraction), mean RSSI (normalised between `rssi_floor_dbm` and
  `rssi_ceiling_dbm`), dead-zone fraction, overlap fraction and AP count (fraction of `ap_count_full_penalty`).
  The weights are planning preferences in `scoring.weights`, and the breakdown is returned so the number can be explained.

## Smart planner
`static/rf-optimizer.js` (`window.RFOptimizer`, node, Worker) is JS only and deterministic (no randomness).
Settings live in `rf-config.json` under `planner`. It works on a coarser grid (`planner.cell_m`), so its
coverage figures can differ slightly from the 0.5 m analytics grid. Everything is a model estimate.

- `detectIssues`: dead zones, weak area, low-capacity APs, high channel utilisation, co-channel pairs.
- `suggestPlacements`: greedy maximum coverage over a lattice of at most `max_candidates` positions. Each round
  adds the position with the most newly covered cells (ties: larger clipped dB gain, then lattice order).
- `recommendApCount(project, floor, targetPct, maxAps)`: the smallest total count that reaches the target, adding
  to existing APs. It states when the target is not reachable and returns best effort. The same greedy
  sequence is used for every target, so the count never decreases as the target rises.
- `detectPowerIssues`: overpowered when lowering tx by `power_step_db` changes coverage by at most
  `overpowered_tolerance_pct`; underpowered when raising tx to `max_tx_dbm` gains at least
  `underpowered_min_gain_pct` while coverage is below target. If raising power does not close the deficit the
  finding says to add an AP. Clients transmit weaker than APs, so check the uplink before raising power.
- `planChannels`: greedy graph colouring per band over `channel_sets` (2.4 GHz: 1, 6, 11). Two APs conflict when
  either hears the other above `carrier_sense_dbm`.

**Confidence.** Each recommendation carries a score in [0, 1] and a reason text. It measures how much the
recommendation depends on the model being right, it is not real-world accuracy. The recommendation is
re-evaluated under 8 perturbations: the new AP moved by `shift_m` (1 m) to each of 4 sides, and all wall and
opening attenuation changed by +3 dB, -3 dB, +20 % and -20 %. For power findings only the 4 wall perturbations apply.

    stability  = perturbations keeping at least half the nominal gain / perturbations
    magnitude  = min(1, nominal gain in % / full_gain_pct)
    confidence = weight_stability * stability + weight_magnitude * magnitude   (0.7 and 0.3)

A recommendation with no gain scores 0. A small gain that disappears under perturbation scores low. A large gain that survives scores near 1.
The optional LLM explanation endpoint is not implemented. The deterministic texts work offline and in the static demo.

## Planner page

`/planner` (`planner.html` in the static demo) is the interactive front end of this engine. All heat maps on it are labelled MODEL ESTIMATE, not a measurement.

Files: `planner-state.js` (project JSON, undo/redo, persistence), `planner-editor.js` (canvas editor and geometry), `rf-worker.js` (tiled incremental computation), `planner-heat.js` (renderer, contours, legend, tooltip text, mini-map), `planner.js` (wiring).

Project JSON is the digital twin format plus `schema_version`, per-floor `labels`, and an optional background image (`background` data URL, `bg_px`, `bg_opacity`, `scale_m_per_px`). Import limits live once in `rf-config.json` under `limits` (floors, items per list, walls and openings per floor, custom materials, material dB range, background size, text length, furniture and sensor kinds). `twin.py` and `planner-state.js` both read them, so the planner and `/api/twin` accept the same projects: at most 5000 walls and 5000 openings per floor (each door or window sits on a wall) and at most 200 items in every other list (rooms, furniture, sensors, APs, labels, annotations, devices), names and ids up to 64 characters (`limits.max_text_chars`, the one text limit: the editor label box, note box and scenario name boxes stop typing at it, and the label and scenario helpers clip with `PlannerState.clipText`, so a saved project always reloads; on import, the name-like fields that the editor wrote, which are wall, AP and device names, labels, note text and scenario names, are truncated to it so older saved projects that used 80 characters still load, while ids and the other fields are rejected), AP channels from the band's channel list, custom materials with every band and 0 to 80 dB. Labels, annotations and devices are planner fields that `/api/twin` drops. Items beyond a limit are rejected on import; the editor does not stop you drawing past a limit, but such a project cannot be imported again. A 5000-wall, 5000-opening floor serialises to about 0.8 MB, close to the 1 MB (`MAX_BODY_BYTES`) cap on `PUT /api/twin`, so a large background image on the same twin can push the request over the cap (413); the 1000-wall case has ample room. Import errors name the field, for example `floors[0].walls[3].x1: must be between 0 and 10`.

Worker protocol (heat map): `init {config}`, `setProject {project, mode, band}`, `update {ops}` (the same operations the undo history stores: `wall.add|set|remove`, `ap.*`, `label.*`, `floor.set`, plus `{t:"mode"}` and `{t:"band"}`), `compute {id, floor, cell_m}`, `cancel {id}`. Replies: `progress` (stage `coarse` then `fine`, a transferred Float32Array), `result` (grid, coverage and dead-zone percent, tile statistics), `cancelled`, `error`.

Dirty tiles: a tile of an AP's grid is recomputed after a wall edit only if the bounding box of the AP and the tile meets the wall's old or new bounding box. In basic mode a ray cannot leave that box, so the rule is exact in the sense of never missing a change. Enhanced and multipath modes add reflected and diffracted paths, so any wall edit recomputes everything in those modes. Measured costs are in `perf-rf.md`.

Rendering: WebGL when available, otherwise canvas 2D (`?renderer=canvas2d` forces it). `?worker=0` forces the main-thread fallback. Opened from `file://` the page cannot load its config or start a Worker and says so.

## Analysis, scenarios, planner panel and exports

Below the plan, a tab strip holds Analytics, Scenarios, Smart planner, Modes and Export (`planner-panels.js`, `planner-modes.js`, `planner-export.js`). Everything is a MODEL ESTIMATE. Throughput, client capacity and channel utilisation are labelled ESTIMATE wherever they appear. Every chart has a table as its text equivalent.

Worker jobs (added to `rf-worker.js`; ids start at 1,000,000 so they never collide with heat map ids): `analyze {floor, cell_m}` replies `analysis`; `compare {floor, a, b}` replies `comparison` (flat `rssi_a`, `rssi_b`, `delta`, both analytics, both scores); `rank {items}` replies `ranking`; `stack` replies `stack`; `plan {floor, target_pct, max_aps}` replies `plan` (issues, placements, count, power, channels). Jobs run as steps with a pause between steps and send `progress {job, step, steps, text}`. A newer job of the same kind or `cancel {id}` takes effect at the next step boundary, so a single long step (for example the placement search on a very large floor) is not interrupted midway.

Analytics tab: coverage, average RSSI, weak area, dead zones with a Locate button, overlap table, roaming candidates (optional overlay of the zone bounding boxes), per-AP usable throughput, client capacity, expected clients and channel utilisation.

Scenarios: a scenario is a named snapshot of the floors and mode (floor-plan images stay with the project). Scenarios live in `project.scenarios` (at most 20), so they are saved in browser storage and in exported JSON. Save, rename, duplicate, delete, restore (restoring clears undo history), download and import a scenarios file. Compare A against B (either can be the current plan) as side by side heat maps with shared pan and zoom, a delta heat map (blue where B is weaker, orange where B is stronger, saturating at 15 dB), or a before/after slider. The metric table and the optimisation score breakdown come from `RFEngine.compareScenarios`; "Rank all by score" scores the current plan and every scenario. Scenario changes are not part of undo history. The two plans must have the same floor size.

Smart planner tab: runs the planner in the worker, then lists recommendations with confidence and reason. Preview draws a ghost AP, Apply and Apply all are single undoable steps. Confidence is model sensitivity, not accuracy, and channel changes have no confidence ("n/a"). Results are marked stale after any edit.

Exports register through `PlannerExport.register(id, {label, run(ctx)})`; the built-ins `png`, `csv`, `json`, `pdf`, `print` and `boq` use it. CSV cells that are text starting with `=`, `+`, `-`, `@`, tab or CR get an apostrophe prefix; real numbers (including negative ones) are written as they are. The PNG is a composite of the plan, heat map, legend and annotations. The PDF is written by hand (PDF 1.4, Helvetica, the heat map as a DCTDecode JPEG, an xref table); non-Latin-1 characters become `?`. `print` uses the print stylesheet. Annotations (text, arrow, pin) are stored in `floor.annotations` and are undoable; dropping a project `.json` file on the plan imports it.

Project JSON `schema_version` is 2 (version 1 files still load). New optional fields: `scenarios`, `capacity` (`"floorId/roomId": {users, profile}`), per floor `annotations` and `devices`, per AP `mesh_parent`. `rf-config.json` gains `planner_modes` (mesh, IoT classes, capacity profiles, enterprise defaults).

### Bonus modes
| Mode | Status | Notes |
| --- | --- | --- |
| Multi-floor and vertical penetration | complete | Floor selector, undoable Add floor (empty floor above), floor stack table (coverage with all APs against own APs only), flat configured loss per floor crossed and band. No slab geometry. |
| 3D building | complete (reuse) | Loads `view3d.js` on demand and shows the project (walls, APs, per-floor signal map) with `Room3D`. No editing in 3D. |
| Mesh simulation | complete (simple model) | `mesh_parent` per AP. Backhaul RSSI from the engine (walls and floors between the APs), end-to-end rate = slowest link x 0.5^hops, flagged weak links and long chains, client-side throughput capped by backhaul. Single radio assumption, no contention between branches. |
| Capacity planning | complete (simple model) | Users per room and demand profile, demand is assigned to the AP serving the room centre, over-capacity APs flagged against usable throughput. |
| IoT placement | complete (simple model) | Device tool or add at probe point, class sensitivities in `rf-config.json`, status ok, marginal or fail, fix text (raise power or add an AP). Uses the strongest AP; no uplink asymmetry. |
| Enterprise planner | complete (simple model) | Square lattice with channel colouring `(col + 2 row) mod n`, evaluate (coverage, capacity), undoable apply, bill of quantities CSV from planning rules of thumb. No cable routing or ceiling constraints. |

Not done: editing doors and windows in the UI, a "save to local twin" button (the twin API caps size, planner projects stay in the browser and in JSON files), a GPU measurement, touch and Raspberry Pi verification.

## Status
Against the original mission list. "complete" means the code exists and is covered by tests or the browser smoke; accuracy against real buildings is UNVERIFIED throughout.

| Mission item | Status | Detail and reason |
| --- | --- | --- |
| Advanced RF Simulation | complete | Frequency-aware model for 2.4, 5 and 6 GHz, per-band material attenuation, openings, floor loss, basic, enhanced (one reflection, knife-edge diffraction) and multipath (incoherent sum) modes, per-AP band and channel. Not ray tracing; no polarisation, no moving objects. |
| Interactive Floor Planning | partial | Draw, move, rotate, snap, delete walls, materials, APs, labels, floors, image import with scale calibration, undo/redo, pan and zoom. Deferred: add, edit and remove doors and windows in the UI (the engine honours twin openings, they are shown but not editable). |
| Visualization Enhancements | partial | WebGL heat map with canvas 2D fallback, quality bands, contours, dead-zone hatch, colour-blind palette, legend, hover and keyboard probe, mini-map, light and dark themes. Deferred: exact roaming-zone cell overlay (bounding boxes are drawn). |
| Analytics Dashboard | complete | Coverage, average RSSI, weak area, dead zones with Locate, overlap, roaming candidates, per-AP throughput, client capacity, channel utilisation, all with table equivalents. Throughput, capacity and utilisation are ESTIMATES from a rate table. |
| Performance Optimization | complete | Web Worker, 16x16 tiles, coarse then fine pass, per-AP cache, dirty-tile edits, spatial index, main-thread fallback. Measured in `perf-rf.md` (SwiftShader, Xeon). Deferred: cancelling inside one long planner step; real GPU and Pi 4 numbers UNVERIFIED. |
| Scenario Comparison | complete | Saved scenarios, side by side, delta and slider views, metric diff, explainable optimisation score, ranking. |
| Smart WiFi Planner | partial | Issue detection, greedy AP placement, AP count, power and channel advice, confidence (model sensitivity, not accuracy), undoable apply. Deferred: optional LLM explain endpoint (the deterministic texts work offline); adjacent-channel interference is simplified. |
| Modern UI/UX | partial | Glass dark and light themes, keyboard shortcuts, tooltips, responsive layout without horizontal overflow at 390 px, ARIA labels. Touch and pinch code exists but was never exercised by a test or a device. |
| Export Features | partial | PNG, CSV, project JSON, PDF, print and BoQ CSV through `PlannerExport.register`. Deferred: a "Save to local twin" button (the twin API caps the request at 1 MB, 5000 walls per floor and 600k background characters); PDF and PNG not opened in a real viewer. |
| Architecture Improvements | complete | Engine (`rfmodel.py`, `rf-engine.js`, `rf-optimizer.js`) separate from UI files, `rf-config.json` materials and tables, registries (modes, materials, exports), JSDoc types checked by `make typecheck`, ADR and docs. |
| Bonus Features | complete | Multi-floor, 3D building, mesh, capacity, IoT and enterprise modes, each a simple model (see the table above). |

## Typed interfaces
`tsconfig.json` (`allowJs`, `checkJs`, `noEmit`, not strict) covers `rf-engine.js`, `rf-optimizer.js` and `planner-state.js`. Run `make typecheck` (`npx -p typescript tsc -p tsconfig.json`). TypeScript is a dev tool only: `node_modules` is gitignored and nothing needs it at runtime. The check currently passes with no errors; JSDoc function types must use arrow syntax, for example `(ctx:Object,x:number)=>number`.

## Extending
`rfmodel.register_mode(id, fn)` and `RFEngine.registerMode(id, fn)` add a mode;
`RFEngine.registerMaterials(table)` adds materials. See the ADR in `docs/adr-rf-engine.md`.
