# 22 Top 10 hackathon features

Chosen from [21-top-100-improvements.md](21-top-100-improvements.md) for demo impact. Status is honest: Built means present and tested to the level in the label, Not built means a proposal.

| # | Feature | Status | Evidence | Demo moment |
|---|---|---|---|---|
| 1 | Draw a floor plan or import an image, see the heat map update live | Built, PARTIALLY VERIFIED (scripted headless Chromium) | `planner-editor.js`, `planner-heat.js`, `rf-worker.js` | drag an AP, the map follows in about 10 ms for the first frame (coarse pass) |
| 2 | 100,000 point coverage in about 2 s with a first picture in about 145 ms | Built, VERIFIED on the benchmark machine, UNVERIFIED on a Pi | `docs/perf-rf.md` | show the benchmark numbers, not a claim |
| 3 | Wi-Fi 4 to 7, SINR, antenna and MLO in the browser | Built, VERIFIED against hand-computed values and Python parity, UNVERIFIED against real radios | `tests/test_wifi_standards.py` | switch an AP from Wi-Fi 5 to Wi-Fi 7 on 6 GHz, 320 MHz, watch capacity change; add a co-channel AP and watch SINR throughput fall |
| 4 | Smart planner with confidence | Built, VERIFIED (deterministic, tested) | `rf-optimizer.js` | press suggest, preview the ghost AP, apply, undo |
| 5 | Before and after comparison with an explainable score | Built | `compareScenarios` in `rf-engine.js` | save a scenario, apply the advice, compare |
| 6 | Material intelligence with ranges, confidence and sources | Built, VERIFIED for structure, values UNVERIFIED against buildings | `docs/platform/material-database.md` | swap a wall from drywall to reinforced concrete |
| 7 | PDF coverage report | Built, UNVERIFIED in a real viewer | `planner-export.js` | export and open |
| 8 | 3D building view and mobile companion with QR pairing | Built, PARTIALLY VERIFIED | `view3d.js`, `qr.py`, `mobile.html` | scan the QR with a phone |
| 9 | Judge page whose statuses are tested against the README | Built, VERIFIED | `wallhack/judge.py`, `tests/test_judge.py` | open `/judge` |
| 10 | LLM wireless consultant that narrates engine numbers | **Not built** (design in [06-ai-planner-design.md](06-ai-planner-design.md)) | none | do not demo as working |

Items 1 to 9 can be shown today. Item 10 is the proposal that would complete the "AI" story; until it exists, describe the planner as deterministic and model-based, with an optional LLM that rewords sensing findings only.

## Demo script (5 minutes)

1. (30 s) Open the static demo. Say the first sentence out loud: "These are model estimates, not measurements."
2. (60 s) Planner: load the sample twin, show dead zones in the analytics tab, drag the router, watch the heat map.
3. (60 s) Smart planner: get a suggestion with its confidence, explain "confidence is model sensitivity, not accuracy", apply it, show the before and after compare.
4. (45 s) Switch an AP to Wi-Fi 7 6 GHz 320 MHz, enable MLO, then add a second AP on the same channel and show SINR throughput drop.
5. (30 s) Wall materials: change one wall to reinforced concrete, open the material doc to show ranges and confidence.
6. (30 s) Show `docs/perf-rf.md`: 100,489 points, 1000 walls, about 2 s, quadtree measured and rejected.
7. (30 s) Export the PDF.
8. (15 s) Close on the Judge page: what is verified and what is not.

Fallbacks: if WebGL fails the canvas renderer is chosen automatically (the renderer chip shows which). If the live server is down, the Vercel demo works without a backend (once deployed, which is UNVERIFIED today).
