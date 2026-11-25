# 15 Wi-Fi physics and model inaccuracy report

Source of truth: `wallhack/rfmodel.py`. The JavaScript port `wallhack/static/rf-engine.js` mirrors it (parity tests). Every number is a MODEL ESTIMATE. Constants live in `wallhack/static/rf-config.json`. Citations name the standard or recommendation; clause numbers were not re-fetched for this document (general knowledge, UNVERIFIED against the documents themselves).

## Formulas implemented

| Quantity | Formula as coded | Reference |
|---|---|---|
| Path loss | `PL(d) = PL0(band) + 10 n(band) log10(max(d, 1 m))`, PL0 40.0, 47.2, 48.7 dB and n 3.0, 3.1, 3.2 for 2.4, 5, 6 GHz | log-distance model, indoor site-general form of ITU-R P.1238; PL0 is free space at 1 m |
| Free-space anchor | `PL0 = 40 + 20 log10(f / 2.4 GHz)` per the planner doc | Friis, ITU-R P.525 and P.526 family |
| Wall loss | sum over walls crossed of `attenuation_db[band]` for the wall material, openings replace the wall loss where crossed | ITU-R P.2040 for the material ranges |
| Floor loss | `floors_apart x floor_loss_db[band]` (13, 16, 18 dB), reduced by `voids.open_end_reduction` (0.5) for each path end inside a stairwell, atrium or shaft void, capped at all of it | fixed typical values, planning assumption for voids, see gaps |
| Reflection (first order) | image method, loss `PL(total path) + reflection_loss_db(material)` plus walls crossed on both legs | geometrical optics |
| Diffraction | knife edge, `v = sqrt(4 delta / lambda)`, `J(v) = 6.9 + 20 log10(sqrt((v - 0.1)^2 + 1) + v - 0.1)` | ITU-R P.526 knife-edge approximation |
| Multipath | incoherent power sum (mW) of direct, reflected and diffracted paths | simplification |
| Noise floor | `-174 dBm/Hz + 10 log10(BW) + NF` (NF 6 dB) | thermal noise at 290 K |
| SINR | `signal - 10 log10(noise + sum c_ij P_j)` | standard definition |
| PHY rate | `N_sd x N_bpscs x R x N_ss / (T_sym + T_GI)` | IEEE 802.11n-2009, 802.11ac-2013, 802.11ax-2021, 802.11be-2024 OFDM parameters |
| Adjacent channel coupling | in-band overlap fraction plus leakage through a rejection table (20, 28, 40 dB) | rounded from the 802.11 OFDM transmit spectrum mask |
| Sector antenna | `-min(12 (phi / beamwidth)^2, front_to_back)` | 3GPP TR 36.814 horizontal pattern |
| MLO capacity | sum of the fastest 3 link rates times MAC efficiency | capacity model, labelled as such |

Full derivations and check values: `docs/rf-planner.md`. Tests: `tests/test_rfmodel.py`, `tests/test_wifi_standards.py` (hand-computed cases, VERIFIED). Real-world accuracy: UNVERIFIED, no survey data.

## Propagation methodology (how a cell value is produced)

1. Anchor: `PL0(band)` at 1 m, then `10 n log10(d)` (log-distance slope per band).
2. Subtract wall and opening losses for every wall the AP to cell segment crosses (uniform grid index finds the candidates, losses are added in ascending wall order so Python and JS agree).
3. Subtract floor loss per floor apart, reduced at voids.
4. Mode: `basic` stops here; `enhanced` also computes one image-method reflection and one knife-edge diffraction and keeps the strongest path; `multipath` sums the paths in mW.
5. Add antenna gain for the AP pattern and azimuth. The strongest AP serves the cell.
6. SINR, PHY rate, throughput and the reliability estimates follow from the tables below.

**Ray-tracing extensibility.** New modes register through `register_mode` (Python) and `registerMode` (JS) with the same signature, so an image-method or ray-launching mode can be added without touching the editor or exports. What is not built: ray launching, second-order reflections, 3D paths, material thickness. The engine is 2D, so a real ray tracer needs 3D geometry first (see [20-roadmap.md](20-roadmap.md)). Both `rayWallHit` helpers in the code are segment intersection tests, not ray tracing.

**Validation status.** Formulas are checked against hand-computed values and Python/JS parity. Nothing is checked against a measured survey (VERIFIED for internal consistency, UNVERIFIED for accuracy).

## Inaccuracy report (from reading `rfmodel.py` and `rf-engine.js`)

| # | Simplification | Effect on results | Status |
|---|---|---|---|
| 1 | No Fresnel zone clearance: a path is blocked or not by wall crossings only | Optimistic or pessimistic near obstacles within the first Fresnel zone, matters for long open rooms | Not modelled |
| 2 | Single-slope exponent per band, no breakpoint | Over-estimates loss in large open areas, under-estimates in cluttered ones | Not modelled |
| 3 | Fixed per-floor loss per band, independent of slab material | Wrong between floors by several dB either way | Open (flooring and roofing materials exist but are not wired in). Stairwells and atria: optional `voids` reduce it locally (a 2D approximation, UNVERIFIED against real buildings) |
| 4 | 2D geometry: floors are stacked with a fixed loss, no ceiling height or vertical angle | No elevation patterns, no 3D reflection | Not modelled |
| 5 | No polarisation | Cross-polar loss ignored | Not modelled |
| 6 | No small-scale fading or shadowing statistics | Single value per cell, no margin | Not modelled |
| 7 | First-order reflection only | Misses second-order paths in corridors | Not modelled |
| 8 | Incoherent multipath sum | Cannot show nulls and peaks, tends to optimistic average | By design |
| 9 | Knife-edge diffraction uses wall endpoints only | No rounded corners, no roof diffraction | Not modelled |
| 10 | No refraction | Negligible indoors at 2.4 to 6 GHz | Deliberately not modelled, stated in docs |
| 11 | Furniture and people are not attenuators | Under-estimates loss in dense rooms | Not modelled |
| 12 | Wall loss is a typical single number per band per material | Real walls vary by tens of percent (ranges in [material-database.md](material-database.md)) | Ranges exist; the engine uses the typical value |
| 13 | Interference assumes all interferers transmit all the time (`activity_factor` 1) | Pessimistic SINR | By design, configurable |
| 14 | Serving AP is the strongest RSSI AP | Ignores client roaming stickiness | By design |
| 15 | MAC efficiency is one factor, no OFDMA scheduling, MU-MIMO, beamforming, client mix | Throughput is a planning figure | By design |
| 16 | Adjacent-channel table is rounded, receiver selectivity ignored | SINR near channel edges is approximate | UNVERIFIED against radios |

## What FEAT-003 and FEAT-004 fixed or added in this change set

| Previously | Now |
|---|---|
| No Wi-Fi standard in the model | Wi-Fi 4, 5, 6, 6E, 7 with per-width and stream PHY rates |
| No interference model beyond carrier-sense neighbours | SINR with co-channel and adjacent-channel coupling |
| No antenna model | Omni and sector with azimuth and front-to-back |
| No MLO | Wi-Fi 7 MLO capacity model |
| Six materials, one number | Ten materials with min, typical, max per band, confidence, sources |
| Knife-edge `v = sqrt(2 delta / lambda)` (earlier fix in this branch history) | `v = sqrt(4 delta / lambda)` per the Fresnel-Kirchhoff small-angle form |

Items 1 to 9, 11 and 16 are still open. The most valuable fix is calibration against a measured survey, which would bound the combined error of items 2, 3, 11 and 12 with one number (NOT BUILT).

## RF lab estimates (non-WiFi interference, reliability, voids, spectrum, roaming)

Every number in this section is a MODEL ESTIMATE. Constants live in `rf-config.json` (`external_sources`, `reliability`, `voids`, `spectrum`, `decay`, `roaming`) with their sources and assumptions next to them. Python (`wallhack/rfmodel.py`) is the reference, `rf-engine.js` mirrors it, and `tests/test_rf_lab.py` compares them. All of it is VERIFIED by automated tests against hand-computed cases and Python/JS parity, and UNVERIFIED against real radios or buildings.

| Quantity | Formula as coded | Basis |
|---|---|---|
| Source coupling (microwave, Bluetooth) | `overlap(victim band, source span) / source width`, no skirt. Microwave: 2450 MHz, 50 MHz wide, 10 dBm, duty 0.5. Bluetooth: 2441 MHz, 78 MHz hop set (2402 to 2480), 4 dBm, duty 0.3 | magnetron on half-wave rectified mains radiates about half of each mains cycle; Bluetooth BR/EDR 79 hop channels of 1 MHz, class 2 limit 2.5 mW. Width, level and the Bluetooth duty are planning assumptions |
| Neighbour WiFi | same coupling and rejection table as an AP, own `duty_cycle` (default 0.3), channel, width, power and position | planning assumption |
| Interference power | `coupling x duty_cycle x 10^(level/10)` added to the SINR denominator, the level coming from the same propagation grid as an AP at the source position | standard SINR |
| PER | logistic around the MCS minimum SNR, equal to 10 percent there: `1 / (1 + exp((sinr - min_snr) / 0.8 + ln 9))` | 10 percent PER at minimum sensitivity per IEEE 802.11; the slope is an assumption. **There is no standard SINR to PER formula.** |
| Loss after retries | `PER^(retry_limit + 1)`, `retry_limit` 7 | dot11ShortRetryLimit default |
| Latency | `2 ms + retries x 1.5 ms + busy / (1 - busy) x 2 ms`, retries are the mean transmissions minus one | all three terms are assumptions, an indication only |
| Airtime for one client | `demand / (PHY x MAC efficiency x (1 - PER) x (1 - busy))`, demand 5 Mbps, capped at 100 percent | estimate. `busy` is the summed duty cycle of external sources heard above the carrier sense level at the serving AP, capped at 0.95 |
| Voids | rectangle `x, y, w, d` or polygon `points` (even-odd rule) per floor, kinds stairwell, atrium, shaft | see `voids.source` |
| Spectrum congestion | per candidate channel, `sum(coupling x duty)` over every AP and source of the band, ignoring distance. Levels low, moderate, high, severe at 0.5, 1.5, 3.0. On 2.4 GHz only channels 1, 6 and 11 are suggested | estimate |
| Roaming map | per cell strongest AP, second AP, margin, zone (single, overlap, handoff) and blend (50 percent at zero margin to 100 percent at the roam margin) | uses `analytics.overlap_*` and `analytics.roam_*` thresholds. Client stickiness is not modelled |

Limits: sources are point emitters with no antenna pattern; the SINR section (and so interference, reliability) exists only when an AP sets a `standard`; the spectrum analysis ignores distance; the void model has no slab geometry.
