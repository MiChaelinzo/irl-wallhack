# 15 Wi-Fi physics and model inaccuracy report

Source of truth: `wallhack/rfmodel.py`. The JavaScript port `wallhack/static/rf-engine.js` mirrors it (parity tests). Every number is a MODEL ESTIMATE. Constants live in `wallhack/static/rf-config.json`. Citations name the standard or recommendation; clause numbers were not re-fetched for this document (general knowledge, UNVERIFIED against the documents themselves).

## Formulas implemented

| Quantity | Formula as coded | Reference |
|---|---|---|
| Path loss | `PL(d) = PL0(band) + 10 n(band) log10(max(d, 1 m))`, PL0 40.0, 47.2, 48.7 dB and n 3.0, 3.1, 3.2 for 2.4, 5, 6 GHz | log-distance model, indoor site-general form of ITU-R P.1238; PL0 is free space at 1 m |
| Free-space anchor | `PL0 = 40 + 20 log10(f / 2.4 GHz)` per the planner doc | Friis, ITU-R P.525 and P.526 family |
| Wall loss | sum over walls crossed of `attenuation_db[band]` for the wall material, openings replace the wall loss where crossed | ITU-R P.2040 for the material ranges |
| Floor loss | `floors_apart x floor_loss_db[band]` (13, 16, 18 dB) | fixed typical values, see gaps |
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

## Inaccuracy report (from reading `rfmodel.py` and `rf-engine.js`)

| # | Simplification | Effect on results | Status |
|---|---|---|---|
| 1 | No Fresnel zone clearance: a path is blocked or not by wall crossings only | Optimistic or pessimistic near obstacles within the first Fresnel zone, matters for long open rooms | Not modelled |
| 2 | Single-slope exponent per band, no breakpoint | Over-estimates loss in large open areas, under-estimates in cluttered ones | Not modelled |
| 3 | Fixed per-floor loss per band, independent of slab material, stairwells, atria | Wrong between floors by several dB either way | Open (flooring and roofing materials exist but are not wired in) |
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
