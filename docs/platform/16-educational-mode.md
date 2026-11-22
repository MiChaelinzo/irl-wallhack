# 16 Educational mode

Status: **DESIGN ONLY.** Nothing in this document is built. The goal is to teach how Wi-Fi behaves by letting a learner change one thing and watch the model respond, using engine functions that already exist, with the MODEL ESTIMATE label kept.

## Lesson set

| Lesson | Concept | Learner action | Existing engine function to reuse | New work |
|---|---|---|---|---|
| Propagation | Signal falls with distance (log-distance) | Drag an AP, read the probe | `RFEngine.probeAt`, `coverageGrid`, heat map | none beyond a guided script |
| Frequency | 5 and 6 GHz fall faster than 2.4 | Switch band | `coverageGrid` with `band` option | side-by-side view using `compareScenarios` |
| Wall penetration | Material and thickness cost dB | Change a wall material | `probeAt` returns obstructions (`obstructions` in `rf-engine.js`), material table | lesson text, highlight crossed walls |
| Reflection | Signals bounce | Switch mode basic, enhanced, multipath | modes in `rf-engine.js` | show reflection paths (needs path output, NOT BUILT) |
| Channel interference | Co-channel and adjacent-channel overlap | Move two APs onto the same channel | SINR section of `analyzeFloor`, `planChannels` | a SINR heat map layer (today SINR is in analytics, not drawn) |
| Beamforming and antennas | Direction concentrates energy | Rotate a sector antenna | `antennaGainDb`, sector pattern in the engine | a polar pattern plot, note that real beamforming is not modelled |
| Mesh | Each hop halves throughput in the model | Add a mesh node | `meshReport` in `planner-modes.js`, `planner_modes.mesh` | lesson text |
| Wi-Fi 7 MLO | Aggregating bands | Enable `mlo_bands` | `mloCapacityMbps` | none beyond text |

## Structure

A lesson is data: title, goal, a starting project (JSON, same schema as a planner project), a list of steps each with an instruction, the control to highlight, and a check that reads engine output (for example "coverage at the probe point is below -75 dBm"). Checks call engine functions, so the answer is computed, not hard-coded text. Lessons live as JSON files next to `rf-config.json`, loaded by a small module in `wallhack/static/`.

## Constraints from the steering

- No randomness: lessons are deterministic.
- Core stays the source of truth: lessons call the engine, they do not re-implement formulas.
- Honesty: each lesson states what the model leaves out (see [15-wifi-physics.md](15-wifi-physics.md)), for example that reflections are first order only.
- Offline: no CDN, no build step.

## Test plan

A pytest drives node to load every lesson, validates the starting project with `validateProject`, and runs every check function on the lesson's solution state to confirm it passes and on the starting state to confirm it fails.

## Effort

Small for lessons 1, 2, 3, 7, 8 (guided scripts over existing functions). Medium for interference (needs a SINR layer) and reflection (needs path output).
