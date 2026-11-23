# 06 AI planner design

The word "AI" here needs care. Today the planner advice is **deterministic search over a propagation model** (`wallhack/static/rf-optimizer.js`). There is no learned model. The only language model in the repository is the optional `wallhack/llm.py`, which rewords sensing findings. This document separates what exists from what is design.

## What `rf-optimizer.js` does today (VERIFIED by `tests/test_rf_planner_js.py`)

| Function | Behaviour | Notes |
|---|---|---|
| `detectIssues` | Lists dead zones (below `analytics.dead_zone_dbm`), weak area, low client capacity, high channel utilisation, co-channel neighbours; sorted by severity | co-channel uses `analytics` neighbours (carrier sense), not SINR |
| `suggestPlacements` | Greedy: evaluate a candidate lattice (`candidate_spacing_m`, at most `max_candidates`), add the AP with the best coverage gain, repeat up to `max_suggestions` or the `target_coverage_pct` | each pick has an expected gain and a confidence |
| `recommendApCount` | Smallest AP count reaching a coverage target, adds to existing APs, says so when the target is not reachable | |
| `detectPowerIssues` | Tries `power_step_db` up and down per AP, flags over-powered and under-powered APs by coverage change | |
| `planChannels` | Builds an AP-to-AP conflict weight from the level each AP hears of the other (above `carrier_sense_dbm`), assigns channels from `channel_sets` greedily by load | RSSI based |
| `evaluatePlacement` | Coverage gain of one candidate AP plus robustness under perturbations | |

All thresholds are in `rf-config.json` `planner`. No randomness: same project and options give the same output.

### Expected improvement calculation

For a candidate AP, the optimiser computes the best-RSSI grid with and without it and reports `coverage_after_pct - coverage_pct` (cells at or above `analytics.coverage_dbm`, -70 dBm). Coverage is cell counts, so the number is exact for the model. It is not a prediction about the real building.

### Confidence (model sensitivity, not accuracy)

Each recommendation is re-evaluated under perturbations: the AP moved by `shift_m` (1 m) on four sides, and all wall and opening attenuation changed by plus or minus `wall_delta_db` (3 dB) and by plus or minus `wall_scale` (20 percent). `confidence = weight_stability x (share of perturbations keeping at least `stability_fraction_of_gain` of the nominal gain) + weight_magnitude x min(1, gain / full_gain_pct)`, with weights 0.7 and 0.3. The result is in [0, 1] and the text says so. It tells the user how fragile the advice is if the wall losses are wrong. It does not say how close the model is to reality.

### Scoring

`RFEngine.scoreAnalytics` (`rf-engine.js`) with weights from `rf-config.json` `scoring`: coverage 50, mean RSSI 15, dead zone -20, overlap -10, AP count -5, RSSI normalised between -90 and -40 dBm, AP count penalty saturating at 10 APs. The score is a weighted preference, not physics, and the label says so. `compareScenarios` returns both scores with a breakdown so a user can see why one layout wins.

## Design for the missing capabilities (DESIGN ONLY)

| Capability | Today | Design |
|---|---|---|
| Dead zone detection | Done (`detectIssues`) | keep |
| Overlap detection | Done in analytics (`overlap` in `scoreAnalytics`) | surface as an issue with position |
| Interference detection | Co-channel via carrier sense only | use the SINR section of `analyze` (co and adjacent channel) to flag cells where SINR limits rate, report per AP pair |
| Placement | Greedy on coverage | greedy on a combined objective: coverage and SINR-limited throughput, tie break on fewer APs; keep determinism by fixed lattice order |
| Antenna orientation | NOT BUILT | for each sector AP, search `azimuth_deg` in steps (for example 15 degrees, a new `planner` config key) and keep the best objective; engine already models sector gain |
| Channel and power together | Separate passes | iterate: channels with the SINR weights, then power steps, stop when the score stops improving, bounded iterations in config |
| Explanation | Fixed text in `reasonText` | see the LLM strategy below |

Workflow (design): detect issues, propose changes, apply each change to a copy of the project, recompute analytics, show before and after with `compareScenarios`, let the user accept (undoable through the store). This reuses existing pieces; the new work is the objective and the azimuth search.

## Wireless consultant persona (DESIGN ONLY)

A persona is a system prompt, not a new model. Proposed prompt contract:

- Role: a careful wireless site-survey consultant who explains planning results to a non-expert.
- Inputs: a JSON object produced by the engine (issues, recommendations, before and after numbers, confidence, the MODEL ESTIMATE label).
- Rules: use only numbers present in the JSON, never invent measurements, always say the numbers are model estimates, mention confidence in plain words, no medical or legal advice, under 200 words.

## LLM strategy (reuses `wallhack/llm.py`)

What exists (VERIFIED against mocked HTTP servers only, UNVERIFIED against real providers): providers `ollama`, `llamacpp`, `openai`, `azure`; off by default (`llm_provider = ""`); keys only from `OPENAI_API_KEY` or `AZURE_OPENAI_API_KEY`; cloud providers need `confirm_off_device=true` on every request; response size capped; errors never include keys. `POST /api/insights/explain` rewords the sensing findings from `insights.py`.

Built: `POST /api/planner/explain` (`wallhack/llm.py` `explain_planner`, `app.py`). The body is validated and size capped. With the LLM off the answer is a deterministic rule-based text (HTTP 200, `source: "rules"`). With a provider, a reply that contains a number not present in the input is rejected and replaced by the rule-based text; provider failures also fall back. A cloud provider without `confirm_off_device` gives 409 and sends nothing. VERIFIED with a mocked provider (`tests/test_explain.py`), UNVERIFIED against real providers. In the static demo the button is hidden. The original design:

1. New route, for example `POST /api/planner/explain`, same guards as `/api/insights/explain` (same-origin, JSON only, `confirm_off_device`).
2. Body is the engine result (issues, recommendations, numbers). The server validates shape and size, then builds the prompt from a template. The model is asked to narrate, not to calculate.
3. Deterministic numbers: every figure in the answer is checked against the input JSON (extract numbers from the reply, reject or flag the answer if one is not in the input). If the check fails, show the deterministic text instead.
4. Off-device disclosure stays visible, local providers are the default recommendation.
5. In the static Vercel demo the route does not exist, so the button is hidden.

Testing plan: mocked provider returning a reply with an invented number must be rejected; mocked provider with only given numbers must pass; cloud provider without confirmation must return 409, as the existing route does.
