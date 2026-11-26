# RF planner

## Propagation model

MODEL ESTIMATE, not a measurement. Implemented in `wallhack/rfmodel.py` (reference) and
`wallhack/static/rf-engine.js` (port). Numbers are in `wallhack/static/rf-config.json`.

**Direct path (mode `basic`, default).**
`RSSI = tx - PL(d) - sum(wall losses on the straight path) - floors_apart * floor_loss(band)`,
`PL(d) = PL0(band) + 10 * n(band) * log10(max(d, 1 m))`. `PL0` follows free space,
`PL0(f) = 40 + 20 * log10(f / 2.4 GHz)`, using 2.4, 5.5 and 6.5 GHz for the three bands.

**Materials.** Each wall has an optional `material` (drywall, wood, glass, brick, concrete, reinforced concrete, metal, stone, flooring, roofing, or a
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

**Not modelled.** Fast or slow fading, polarisation, furniture and people, second-order
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

## WiFi standards, interference, antenna and MLO
Everything here is a MODEL ESTIMATE. All constants are in `rf-config.json` (`wifi_standards`, `interference`, `antenna`), `rfmodel.py` is the reference and `rf-engine.js` mirrors it (`tests/test_wifi_standards.py`). The new AP fields are optional. An AP without them, and a project without a `standard` on any AP, produces exactly the previous coverage grids and analytics (no `sinr` key).

AP fields: `standard` (`wifi4`, `wifi5`, `wifi6`, `wifi6e`, `wifi7`), `width_mhz`, `spatial_streams`, `mlo_bands`, `antenna_gain_dbi`, `azimuth_deg`, `pattern` (`omni` or `sector`), `beamwidth_deg`, `front_to_back_db`. Both validators (`twin.py`, `planner-state.js`) reject an unknown standard, a standard not allowed on the AP band (Wi-Fi 4 and 5 on 6 GHz, Wi-Fi 5 on 2.4 GHz), a width the standard does not allow on that band (320 MHz only for Wi-Fi 7 in 6 GHz), more streams than the standard allows, and `mlo_bands` on anything but Wi-Fi 7.

| Standard | IEEE amendment | Bands | Widths (MHz) | Max streams | Max MCS |
| --- | --- | --- | --- | --- | --- |
| Wi-Fi 4 | 802.11n | 2.4, 5 | 20, 40 | 4 | 7 (64-QAM) |
| Wi-Fi 5 | 802.11ac | 5 | 20 to 160 | 8 | 9 (256-QAM) |
| Wi-Fi 6 | 802.11ax | 2.4, 5 | 20 to 160 (2.4: 20, 40) | 8 | 11 (1024-QAM) |
| Wi-Fi 6E | 802.11ax | 2.4, 5, 6 | 20 to 160 | 8 | 11 |
| Wi-Fi 7 | 802.11be | 2.4, 5, 6 | up to 160, 320 in 6 GHz | 16 | 13 (4096-QAM) |

### PHY rate
`rate = N_sd x N_bpscs x R x N_ss / (T_sym + T_GI)` in Mbps (bits per microsecond), with `N_sd` data subcarriers (n/ac 52, 108, 234, 468 for 20, 40, 80, 160 MHz; ax/be 234, 468, 980, 1960 and 3920 for 320 MHz), `N_bpscs` bits per subcarrier (1 to 12), `R` the coding rate, `N_ss` streams, `T_sym` 3.2 us (n, ac) or 12.8 us (ax, be) and `T_GI` 0.8 us (the default, the long guard interval; `default_guard_interval_us`). Sources: IEEE 802.11n-2009 clause 20, 802.11ac-2013 clause 21, 802.11ax-2021 clause 27, 802.11be-2024 clause 36. Checks: 65 Mbps (n, MCS 7, 20 MHz, 1 stream), 390 Mbps (ac, MCS 9, 80 MHz), 143.4 Mbps (ax, MCS 11, 20 MHz). Assumptions: 802.11ac MCS 9 is not defined for every width and stream count, this model ignores that. Default streams are 2 (`default_streams`), a planning assumption.

### Noise and SINR
`noise_dbm = -174 + 10 log10(BW_Hz) + NF` (thermal noise density at 290 K, `NF` 6 dB, `interference.noise_figure_db`). `SINR = signal - 10 log10(noise_mW + sum_j c_ij x activity x P_j)`, where `P_j` is the RSSI of AP `j` at the cell in mW (the serving AP is the best-RSSI AP, as in the analytics) and `c_ij` the coupling factor below. `activity_factor` is 1 (every interferer transmits all the time, a worst case). The PHY rate is the highest MCS up to the standard maximum whose `min_snr_db` the SINR reaches (0 below MCS 0). The `min_snr_db` values are rounded typical planning figures. The standard normative receiver minimum sensitivity is a dBm value, not an SNR. Throughput is the PHY rate times `analytics.mac_efficiency`.

APs without a `standard` that appear next to ones with a standard use the band fallback (`interference.fallback_standard`: 2.4 Wi-Fi 4, 5 Wi-Fi 5, 6 Wi-Fi 6E) in the SINR section only.

### Co-channel and adjacent-channel interference
The channel number is taken as the centre of the occupied bandwidth (`centre MHz = base + 5 x channel`, bases 2407, 5000, 5950 from the IEEE 802.11 channel numbering). Interferer `B` spreads its power evenly over its width, so the part inside the victim band `A` is `overlap / width_B`. The rest leaks in through the transmit spectrum mask, rejected by `rejection_table` at the gap between the band edges (20 dB at 0 MHz, 28 dB from 10 MHz, 40 dB from 20 MHz, rounded from the 20 MHz OFDM mask of IEEE 802.11: about -20 dBr at 11 MHz, -28 dBr at 20 MHz, -40 dBr at 30 MHz from the centre). `c_ab = inband + (1 - inband) x 10^(-rejection/10)`, and 0 when there is no overlap and the gap exceeds `negligible_gap_mhz` (40) or the bands differ. The 40 dB floor is a conservative bound, not a measured value. Receiver filter selectivity, the primary and secondary channel layout of bonded channels and carrier-sense time sharing are not modelled.

### Antenna
The gain is added to `tx_dbm` per path, towards the first segment of the path (the receiver for the direct path, the reflection point or the corner for indirect paths). Omni with 0 dBi (the default) adds nothing. The sector pattern is the 3GPP TR 36.814 horizontal pattern `A(phi) = -min(12 (phi / phi_3dB)^2, A_m)`, defaults 70 degrees and 25 dB. Azimuth 0 points east (+x) and grows clockwise on the plan (90 is south). Horizontal plane only, no elevation, polarisation or mutual coupling.

### MLO (Wi-Fi 7)
`mlo_bands` lists up to two more bands the AP also transmits on, at the same position and power, on the default channel width of the band (`default_width_mhz`, capped by the standard). The capacity is `sum of the fastest max_links (3) link rates x mac_efficiency`, each extra link is noise limited (no interference). It is a CAPACITY MODEL, labelled as such in the output, not a measurement: real MLO gains depend on the client, the MLO mode (STR, eMLSR) and the traffic.

### RF lab additions

Optional twin fields (validated by `twin.py` and `planner-state.js`, absent in legacy projects, which give identical results):

- `interferers`: list of `{id, kind, floor, x, y, tx_dbm?, duty_cycle?}` with kind `microwave`, `bluetooth` or `neighbour_wifi` (which also takes `band`, `channel`, `width_mhz`). At most 50. Defaults and sources: `rf-config.json` `external_sources`. They enter the `sinr` analytics section (`sinr.external`, per-AP `external_sources`).
- floor `voids`: list of `{id, kind, x, y, w, d}` or `{id, kind, points: [[x, y], ...]}` (stairwell, atrium, shaft). Named `voids` because a floor's `openings` already means doors and windows. They reduce the floor loss locally.

New analytics output (all ESTIMATES): `sinr.reliability` (per-cell `per_pct`, `loss_pct`, `latency_ms`, `airtime_pct` and means, also per AP), and `roaming.map` (`second_ap`, `margin_db`, `zone`, `blend_pct` per cell, replacing the bounding boxes: `roaming.zones` keeps `cells`, `area_m2` and `centroid` only; the plan overlay draws the exact cells).

Python functions (mirrored in `rf-engine.js` as `probeAt(..., {explain: true})`, `spectrumAnalysis`, `signalDecay`):

- `probe_at(twin, floor, x, y, band, mode, explain=True)` adds `explain`: EIRP, path loss, every wall crossed with material and dB, floor loss, reflected and diffracted paths, the SINR terms and `text`, a list of plain sentences. `total_loss_db` is the sum of the path, wall and floor terms, and `direct_dbm = eirp_dbm - total_loss_db`.
- `spectrum_analysis(twin, band, width_mhz=None, exclude_ap=None)`: per channel overlapping sources, congestion, occupancy, level, plus up to three suggested channels.
- `signal_decay(twin, floor, ap_id, bearing_deg, band, mode, step_m, max_distance_m)`: RSSI, distance-only level and walls crossed along a ray (0 degrees is +x, clockwise).

The assumptions behind each number are in [platform/15-wifi-physics.md](platform/15-wifi-physics.md).

### Not modelled
Refraction is not modelled (negligible indoors at these frequencies, and the plan is 2D), and no real-world fading, beamforming, MU-MIMO, OFDMA scheduling or client mix is modelled. A `standard` AP uses the legacy `mcs_tables` entry of the nearest narrower width for the old `throughput_mbps` field (the tables have no 40 MHz entry at 5 GHz, for example), so that field stays defined.

## Wall thickness and objects
MODEL ESTIMATE. A wall may carry an optional `thickness_cm` (0.5 to 100). The material's `attenuation_db` is the loss at a reference thickness (`wall_thickness.reference_cm` in `rf-config.json`, with a documented `source`), and the wall loses `attenuation_db x min(thickness_cm / reference_cm, max_factor)`, linear in thickness and capped at `max_factor` (4). A wall without `thickness_cm` keeps the exact database loss, so saved projects and the legacy golden fixture give identical results. Doors and windows keep their own loss and ignore thickness. `rfmodel.thickness_factor` and `RFEngine.thicknessFactor` implement it, the explain output names the thickness (`Crosses wall w1 (Concrete, 30 cm): ...`), and `tests/test_rf_parity.py` checks Python against JS with and without thickness.

Thickness is set in the inspector next to Material (empty = material default; the tooltip shows the resulting dB at the current band).

Objects (tool B, the Object button, kinds in `objects.kinds` of `rf-config.json`: sofa and bookshelf and cabinet in wood, fridge in metal, mirror in glass) are a rectangle of four ordinary wall segments sharing an `object` id, so there is no second loss path. A straight path through an object crosses two edges and loses twice the edge loss, and a path that misses it loses nothing. Click places a default-size object, a drag draws a rectangle. Selecting, deleting, changing the material or the thickness of one edge applies to the whole object, and adding one is a single undo step. Objects only attenuate paths that cross them in the 2D model: they are not diffraction obstacles beyond what any wall is, and their height is ignored in the 3D view. The default `thickness_cm` of an object kind is a planning assumption for an edge, not the real depth of the furniture.

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
The deterministic texts work offline and in the static demo. `POST /api/planner/explain` can reword them with an LLM when one is configured (see below).

### Timeline, what-if, recommendations and network design
All figures are MODEL ESTIMATES and deterministic. Settings are in `rf-config.json` under `timeline` and `recommendations`.

- **Timeline.** `rfmodel.signal_timeline` (reference) and `RFEngine.signalTimeline` take a path `[{floor, x, y}]` and sample it every `timeline.step_m` (0.5 m) along each same-floor segment, plus every waypoint. A step between floors is a jump. The client stays on its serving AP until a stronger AP is at least `analytics.roam_min_dbm` and either the serving AP is below that level or the stronger AP wins by `timeline.hysteresis_db` (4 dB). A sample is in a handoff zone by the same rule as the roaming map (`roam_min_dbm`, `roam_margin_db`). The result has `samples`, `events` (`handoff`, `coverage_lost`, `coverage_regained`) and a `summary` that includes sticky client samples (a stronger AP exists but the client has not roamed). `tests/test_rf_timeline.py` checks that Python and JS return identical output. In the UI, tab "Timeline and what-if": Draw path, click waypoints, Run timeline, then scrub the chart.
- **What-if.** `RFOptimizer.whatIf(project, floor, change)` copies the project, applies one change (`move_ap`, `upgrade_standard`, `upgrade_profile`, `remove_wall`, `add_mesh_node`, `set_channels`) and runs the engine on both. `diffAnalytics` returns the coverage score, coverage, dead zone, average speed, client capacity and the optimiser score before, after and as a difference. Speed uses the SINR throughput, so channel changes show up.
- **Recommendations.** `RFOptimizer.recommend` gives a coverage score out of 100 (`recommendations.score_weights`: coverage 0.5, no dead zone 0.3, speed against `throughput_full_mbps` 0.2) and a ranked list such as "Move router 2.5 m toward the centre", "Upgrade ap1 to WiFi 6E", "Add mesh node upstairs" and "Reduce interference on channel 6". Each action is a what-if, so its delta is measured. Actions below `min_score_gain` are dropped. Confidence is the share of the four wall attenuation perturbations that keep at least half of the gain, the same rule as the other advice. It is model sensitivity, not accuracy.
- **Design my network.** `RFOptimizer.designNetwork` ignores the APs now on the floor and builds a plan: AP count and positions from the greedy coverage search, a sector orientation toward the floor centre for APs at the edge when that does not lower coverage, channels from the conflict graph plan, and a mesh node on every other floor without an AP. The plan is analysed and compared with the current network. `narratePlan` writes a deterministic text. The UI sends `planPayload` to `POST /api/planner/explain`, which keeps its number grounding check and the rule-based fallback. **UNVERIFIED:** a reply from a real LLM has never been run here, only a mocked reply is tested (`tests/test_rf_recommend.py`).

### Reports, CSV and screenshots of the V2 tabs
- **PDF.** After you run the recommendations in the Timeline and what-if tab, the PDF gains "Network health" (coverage score and number of ranked actions) and "Device recommendations" (the ranked actions with score before and after and confidence). After you run a what-if, it gains a "Before and after" table. Nothing is computed at export time, so a section is left out when its result does not exist yet. Built in `planner-export.js` (`labReportTables`), tested in `tests/test_planner_panels.py`. PDFs are UNVERIFIED in a real viewer.
- **CSV.** When access points carry a WiFi standard, the CSV adds a per-AP table with standard, mean SINR, mean throughput, served cells and interfering APs (all ESTIMATE).
- **Screenshots.** `tools/planner_smoke.py` writes `docs/screenshot-planner-3d.png`, `-timeline.png`, `-beams.png` and `-materials.png` (wall inspector with the material loss text), and the same with `-demo` for the static demo.
- **Performance.** `node tools/perf_rf_v2.js` times the timeline, what-if, recommend and design. Results and the profile of the slow main-thread AP move are in `docs/perf-rf.md`.

## Insight layer (rooms, Gamer Mode, Score Card, Assistant)
`static/rf-insight.js` (`window.RFInsight`, node) is JS only, deterministic and pure. It is intentionally JS only (no Python reference, so no parity test): grades, ping ranges and diagnoses are presentation of engine numbers, the engine itself keeps Python as source of truth, and a server side report would have to port these rules and add a parity test first. It is a scoring and presentation layer over `rf-engine.js` and `rf-optimizer.js`: it never changes an engine result. Every number comes from an engine grid or probe. All thresholds are in `rf-config.json` under `insight` with a `source` string (schema: `rf-config.schema.json`). Everything is a MODEL ESTIMATE.

- **Per-room analysis** (`roomStats`): the engine grids (RSSI, SINR, throughput, packet error, loss after retries, latency, airtime) averaged over the cells whose centre lies in each `floor.rooms` rectangle. Output: mean and min RSSI, % of cells at or above `analytics.coverage_dbm`, dead cells (below `analytics.dead_zone_dbm`), mean SINR, PER, loss, latency, airtime, throughput. A floor without rooms gives one whole-floor entry.
- **Gamer Mode** (`gamerMode`): there is no standard formula from RSSI to ping, so ping is always a range. `ping = isp_base_ms + 2 x Wi-Fi latency` (the Wi-Fi hop is crossed twice), taken at the 25th to 75th percentile of the room cells (at least `min_range_ms` wide). `isp_base_ms` (default 15) is adjustable (`ispBaseMs`). Jitter proxy = 2 x the latency spread + `airtime_jitter_ms` x airtime share. Packet loss risk is Low, Medium or High from the worse of loss after retries and first attempt PER. Gaming stability 0-100 = weighted mean of ping, jitter, loss and signal margin components (linear between a full and a zero value), times the share of served cells; grade A+ 95, A 90, B 80, C 70, D 60, F below.
- **Score Card** (`scoreCard`): grade A 90, B 80, C 70, D 60, F from coverage %, dead-zone count, mean SINR and the area weighted gaming, streaming (25 Mbps per 4K stream, judged at the 25th percentile throughput of the room) and video call scores (needs about 4 Mbps, low latency and loss; the weakest component sets the score). Rating words Excellent 85, Good 70, Fair 50, Poor.
- **Predictive WiFi Assistant** (`diagnose`, `parseQuestion`): a deterministic keyword parser, not a language model. Text is lower cased, apostrophes removed, split on non letters and digits, plural endings removed. Place rule 1: the full name of a room (or label text) appears as a word run, the longest wins. Rule 2: otherwise the name shares words (not stop words, not numbers) with the question, the most shared words win. Several equal places, or none, return `needs_room` with the list of places to choose from. Intents (`slow`, `drops`, `lag`, `buffering`, `dead`) are keyword prefixes from `insight.assistant.intents`; none found means `slow`. Dead and drops probe the worst cell of the room, others the room centre. Causes come from the engine probe explain output ranked in dB: each wall (material, dB), floors, distance beyond the 1 m reference, and interference as the usable signal-quality cost in dB (SNR minus SINR), explicitly separate from wall loss; busy channel share is listed separately because it is not dB. Fixes (move the serving router toward the room by 2 and 4 m, add a mesh node from `suggestMeshNodes`, or change channels when interference is present) are applied to a copy and measured by a second engine run (room coverage and ping before and after, floor coverage) plus the optimizer `whatIf` confidence. A channel change can reduce interference without eliminating the same source, so the post-fix diagnosis is recomputed rather than cleared. Optional rephrase: `assistantPayload` builds the body for `POST /api/planner/explain`, which keeps its number guard. The LLM path is tested with a mocked model only: real model output is UNVERIFIED.
- **Router placement** (`placementReport`): searches the optimizer candidate lattice (`candidatePositions`) moving the router with the other APs fixed. Rank: most covered cells, then fewest dead cells, then highest mean RSSI, then lattice order. Reports the position, the room containing it (else nearest label), coverage increase in percentage points, dead zones removed (dead-zone regions before minus after; a region is a 4-connected group of cells below `dead_zone_dbm`), current and best mean RSSI with their dB delta, latency change and the number of positions evaluated. When coverage and dead zones are unchanged but mean RSSI improves, Quick start describes the stronger average signal instead of a zero-point coverage gain. With no improved metric, Apply stays disabled.
- **Mesh topologies** (`meshTopologies`): single router (as drawn), dual mesh (plus the best node) and whole-home mesh (up to `min(max_nodes, ceil(rooms / rooms_per_node))` nodes, stopping at the target coverage). The engine does not model the backhaul, so cells served by a mesh node (`mesh_parent`) get throughput x `planner_modes.mesh.hop_throughput_factor` and + `insight.mesh.hop_latency_ms` per hop. These are assumptions for a shared band wireless backhaul.
- **Time Machine** (`timeMachine`, `scenarioItems`, `presetItems`): 2 to 4 items, metrics and deltas against the first (coverage points, latency %, dead zones, score, grade change), ranked by score. Built-in presets replace the routers by the generic AP class profiles (`consumer`, `enterprise`, plus a `mesh` class node).

### Measured speed of the insight layer
Figures from `node tools/perf_architect.js` (Xeon, node 22): re-simulation after an AP move 3 to 8 ms on presets; `roomStats`, `gamerMode`, `scoreCard` 1 to 13 ms; `diagnose`, `placementReport`, `meshTopologies` 4 to 44 ms on small presets and 0.34 to 0.39 s on the 13 room hotel preset, which misses the 100 ms goal. Table and path counts in [perf-rf.md](perf-rf.md). Not Pi 4 or GPU numbers.

### Quick start and architect tabs (`planner-quick.js`)

`planner-quick.js` only presents `rf-insight.js` results; it adds no model. Analyse runs `analyze`, `scoreCard`, `gamerMode`, `placementReport` and one `diagnose` for the weakest room in short time slices on the main thread (a progress bar shows the stage), typically 0.1 to 0.5 s on the presets. After a weakest-room fix, it diagnoses the original room again only when another room has become weakest, so the outcome can truthfully check the original cause. After the first run, edits refresh the result after 0.7 s; switching floors clears the result and action until that floor is analysed. Homeowner summaries use the gaming grade as the canonical gaming label; Streaming and Video calls keep their rating words. `nextActionModel` builds the `Fix my weakest room` card from `worstRoom` and the first already-measured diagnosis fix: current room grade, main cause, recommendation, expected room grade and coverage, and whole-floor coverage. `Apply and check again` uses the existing store change and automatic reanalysis. Its concise outcome compares the original room's actual modeled gaming grade and checks the original cause again; when the same interference source remains at a lower dB cost, the result says it was reduced but not eliminated. Detailed room and diagnosis output stays below the action.

Best spot Apply and every assistant fix Apply go through the store, so Ctrl+Z undoes them. After an Apply the next analysis shows a Before and after card (`beforeAfterModel`: both `scoreCard` grades and scores rounded to whole points, the difference, gaming grades, Streaming and Video calls rating words, coverage and dead zones); it clears on the next edit that was not an Apply and when a project loads. The grade connector is visible text and CSS lines rather than a symbol-font arrow, while the complete grade change remains in its accessible label. Channel change fixes (`set_channels`) have an Apply button too. Mesh and Time Machine run on demand. Time Machine takes 2 to 4 versions (current plan, saved scenarios, what-if upgrades); the Scenarios tab keeps the original two-scenario compare. Smart Home check rows per room use the capacity model (`analytics.clients`) and the room loss risk. Interference scanner: microwave, Bluetooth and neighbour WiFi sources exist in `external_sources`; camera and smart-device sources are PARTIAL (not added, no sourced duty cycle and power). Signal waves (`signal_waves` in `rf-config.json`) are an ILLUSTRATION: rings sampled along rays and dimmed by the engine wall loss.

## Planner page

`/planner` (`planner.html` in the static demo) is the interactive front end of this engine. All heat maps on it are labelled MODEL ESTIMATE, not a measurement.

Files: `planner-state.js` (project JSON, undo/redo, persistence), `planner-editor.js` (canvas editor and geometry), `rf-worker.js` (tiled incremental computation), `planner-heat.js` (renderer, contours, legend, tooltip text, mini-map), `planner.js` (wiring).

Project JSON is the digital twin format plus `schema_version`, per-floor `labels`, and an optional background image (`background` data URL, `bg_px`, `bg_opacity`, `scale_m_per_px`). Import limits live once in `rf-config.json` under `limits` (floors, items per list, walls and openings per floor, custom materials, material dB range, background size, text length, furniture and sensor kinds). `twin.py` and `planner-state.js` both read them, so the planner and `/api/twin` accept the same projects: at most 5000 walls and 5000 openings per floor (each door or window sits on a wall) and at most 200 items in every other list (rooms, furniture, sensors, APs, labels, annotations, devices), names and ids up to 64 characters (`limits.max_text_chars`, the one text limit: the editor label box, note box and scenario name boxes stop typing at it, and the label and scenario helpers clip with `PlannerState.clipText`, so a saved project always reloads; on import, the name-like fields that the editor wrote, which are wall, AP and device names, labels, note text and scenario names, are truncated to it so older saved projects that used 80 characters still load, while ids and the other fields are rejected), AP channels from the band's channel list, custom materials with every band and 0 to 80 dB. Labels, annotations and devices are planner fields that `/api/twin` drops. Items beyond a limit are rejected on import; the editor does not stop you drawing past a limit, but such a project cannot be imported again. `PUT /api/twin` has its own body limit, `MAX_TWIN_BODY_BYTES` in `app.py`, derived from these limits (`max_floors` x (`max_background_chars` + (walls + openings + 5 x items) x `twin_json_bytes_per_item`) + `twin_body_overhead_bytes`, about 23 MB), so a twin at every limit, background images included, is accepted. Bigger bodies get 413. At most `limits.max_concurrent_twin_puts` uploads run at once; another gets 429 with a `Retry-After: 1` header. All other routes keep the 1 MB `MAX_BODY_BYTES` cap. Import errors name the field, for example `floors[0].walls[3].x1: must be between 0 and 10`.

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

## Map layers, spectrum, dashboard and editing (RF lab UI)

All values are MODEL ESTIMATES. Constants are in `rf-config.json` under `planner_layers` (ranges, quality weights, dashboard thresholds, editor defaults).

- **Layers**: the Heat map card picks RSSI, SNR, SINR, quality score, bandwidth, latency, packet-loss likelihood, wall attenuation, interference (SNR minus SINR), channel utilisation, capacity or a combined map (the weakest of the ticked layers in every cell). RSSI is the live worker grid. Other layers come from the analysis job (`analyze` with `layers`), at the analysis cell size, and are drawn through the same colour scale as goodness 0 to 1, so the strong end is always good. Latency, loss, SINR and interference need an AP with a WiFi standard; otherwise the legend says so. Wall attenuation is the best RSSI without walls minus the best RSSI with them.
- **Palettes**: classic, aurora (emerald strong, cyan good, amber fair, crimson poor), colour-blind safe (inverted viridis), viridis, cividis. They apply to the WebGL and canvas paths and to the legend and charts.
- **Overlays**: overlap and handoff cells, strongest AP (Okabe-Ito colours), signal blend; all from `analytics.roaming.map` and `best_ap`.
- **Spectrum tab**: `RFEngine.spectrumAnalysis` per band and candidate width: congestion bars, the span of each AP and source, suggested channels.
- **Dashboard tab**: signal histogram, coverage, edge coverage (cells within `edge_margin_m` of the outer wall), weakest and strongest rooms (or tiles when a floor has no rooms), mean throughput and the efficiency score defined in `planner_layers.dashboard.efficiency_note`.
- **Editing**: tools Door (D), Window (O), Floor opening (S, drag a rectangle), Interference (X); Environment tab lists and edits sources, floor openings, doors and windows; sources can be dragged. Limits are those of `rf-config.json` (`addLimitError`).
- **View persistence**: layer, palette, compare, combine and overlays are kept in browser storage and the URL query. They are not part of the project JSON.

## Status
Against the original mission list. "complete" means the code exists and is covered by tests or the browser smoke; accuracy against real buildings is UNVERIFIED throughout.

| Mission item | Status | Detail and reason |
| --- | --- | --- |
| Advanced RF Simulation | complete | Frequency-aware model for 2.4, 5 and 6 GHz, per-band material attenuation, openings, floor loss, basic, enhanced (one reflection, knife-edge diffraction) and multipath (incoherent sum) modes, per-AP band and channel. Not ray tracing; no polarisation, no moving objects. |
| Interactive Floor Planning | partial | Draw, move, rotate, snap, delete walls, materials, APs, labels, floors, image import with scale calibration, undo/redo, pan and zoom. Doors, windows, floor openings and interference sources are editable (tools D, O, S, X). Deferred: a room creation tool (rooms are walls plus a label), DXF and IFC import, automatic wall extraction from an image. |
| Visualization Enhancements | partial | WebGL heat map with canvas 2D fallback, quality bands, contours, dead-zone hatch, colour-blind palette, legend, hover and keyboard probe, mini-map, light and dark themes. Eleven map layers plus a combined layer, side-by-side compare, and exact per-cell roaming, strongest-AP and blend overlays. Deferred: a 3D view of the signal (the engine is 2D). |
| Analytics Dashboard | complete | Coverage, average RSSI, weak area, dead zones with Locate, overlap, roaming candidates, per-AP throughput, client capacity, channel utilisation, all with table equivalents. Throughput, capacity and utilisation are ESTIMATES from a rate table. |
| Performance Optimization | complete | Web Worker, 16x16 tiles, coarse then fine pass, per-AP cache, dirty-tile edits, spatial index, main-thread fallback. Measured in `perf-rf.md` (SwiftShader, Xeon). Deferred: cancelling inside one long planner step; real GPU and Pi 4 numbers UNVERIFIED. |
| Scenario Comparison | complete | Saved scenarios, side by side, delta and slider views, metric diff, explainable optimisation score, ranking. |
| Smart WiFi Planner | partial | Issue detection, greedy AP placement, AP count, power and channel advice, confidence (model sensitivity, not accuracy), undoable apply. Channel advice now maximises mean SINR (adjacent-channel and non-WiFi sources included, `planChannelsSinr`), and mesh node and dead-zone fixes are recommended with confidence and rationale. `POST /api/planner/explain` explains a plan from engine numbers only, with a rule-based fallback when the LLM is off. |
| Modern UI/UX | partial | Glass dark and light themes, keyboard shortcuts, tooltips, responsive layout without horizontal overflow at 390 px, ARIA labels. Touch and pinch code exists but was never exercised by a test or a device. |
| Export Features | partial | PNG, CSV, project JSON, PDF, print and BoQ CSV through `PlannerExport.register`. Deferred: a "Save to local twin" button (the twin API caps the request at 1 MB, 5000 walls per floor and 600k background characters); PDF and PNG not opened in a real viewer. |
| Architecture Improvements | complete | Engine (`rfmodel.py`, `rf-engine.js`, `rf-optimizer.js`) separate from UI files, `rf-config.json` materials and tables, registries (modes, materials, exports), JSDoc types checked by `make typecheck`, ADR and docs. |
| Bonus Features | complete | Multi-floor, 3D building, mesh, capacity, IoT and enterprise modes, each a simple model (see the table above). |

## Scenario presets and educational mode
`wallhack/static/scenarios.json` (generated by `tools/make_scenarios.py`, checked by a test) holds fourteen illustrative layouts (the last four, studio apartment, two bedroom condo, three story house with stairwell voids on every floor, and small office with a metal-doored server closet, were added with the wall architect work; every floor of every preset has named rooms): small apartment, large home, office floor, school building, warehouse, hotel floor, coffee shop, hospital ward (steel lined imaging suite, three APs on one channel), smart home (two floors, clients on both, no AP upstairs) and apartment with neighbours (shared concrete walls, three neighbour networks). The Project card loads them, also in the static demo. `planner-state.js` `validateScenarioLibrary` validates every preset through `validateProject`. `learn-content.json` holds the topics and lessons used by the Learn tab. The presets are not real buildings and every coverage number is a MODEL ESTIMATE.

## Typed interfaces
`tsconfig.json` (`allowJs`, `checkJs`, `noEmit`, not strict) covers `rf-engine.js`, `rf-optimizer.js` and `planner-state.js`. Run `make typecheck` (`npx -p typescript tsc -p tsconfig.json`). TypeScript is a dev tool only: `node_modules` is gitignored and nothing needs it at runtime. The check currently passes with no errors; JSDoc function types must use arrow syntax, for example `(ctx:Object,x:number)=>number`.

## Extending
`rfmodel.register_mode(id, fn)` and `RFEngine.registerMode(id, fn)` add a mode;
`RFEngine.registerMaterials(table)` adds materials. See the ADR in `docs/adr-rf-engine.md`.

## Methodology and limits
The engine answers one question per cell: what power would a client receive from each AP, and how does that compare with noise and interference. Steps, in the order the code runs them (`wallhack/rfmodel.py`, mirrored in `rf-engine.js`):

1. Free-space anchor and log-distance slope per band.
2. Wall and opening losses along the straight segment from AP to cell, per material and band.
3. Floor loss for cells on other floors, reduced near stairwell, atrium or shaft openings.
4. Optional single reflection and knife-edge diffraction (enhanced), or an incoherent power sum of the paths (multipath).
5. Antenna gain from the AP pattern and azimuth, then the strongest AP serves the cell.
6. Noise floor from the channel width, interference from other APs and non-WiFi sources weighted by channel overlap and duty cycle, giving SINR.
7. PHY rate, throughput, estimated packet error, latency and airtime from tables in `rf-config.json`.

It is not ray tracing: there are no ray launching, second-order reflections, polarisation, fading or moving objects, and the geometry is 2D. It has not been calibrated against a measured survey, so use it to compare options (move this AP, change this wall) rather than to promise a dBm value. Details and the inaccuracy list are in `docs/platform/15-wifi-physics.md`; per-section status is in `docs/platform/24-rf-lab-status.md`.
