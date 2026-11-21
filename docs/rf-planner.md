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
   `v = sqrt(2 * delta / lambda)`, `J(v) = 6.9 + 20 log10(sqrt((v - 0.1)^2 + 1) + v - 0.1)`.

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

## Extending
`rfmodel.register_mode(id, fn)` and `RFEngine.registerMode(id, fn)` add a mode;
`RFEngine.registerMaterials(table)` adds materials. See the ADR in `docs/adr-rf-engine.md`.
