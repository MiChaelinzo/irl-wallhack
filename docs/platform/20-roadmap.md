# 20 Roadmap

Phases are ordered by value over cost from [21-top-100-improvements.md](21-top-100-improvements.md). Dates are deliberately absent: there is no capacity plan to base them on. DESIGN ONLY items are marked.

## Now (small, measurable, unblock honesty)

1. Profile the engine grid path and close the 4x gap to the bench kernel (`docs/perf-rf.md`).
2. Click-test the AP panel standard controls in a browser and update the README row from PARTIALLY VERIFIED.
3. Run `tools/planner_smoke.py` in CI.
4. Add SINR and standard columns to CSV and PDF.
5. Real Vercel deployment and record the result.
6. Widen JSDoc type checking.

## Next (the product story)

1. Survey import (CSV of position and dBm) and a model fit with a reported error.
2. LLM explain endpoint for planner advice, off by default, engine numbers only, number-checking of the reply.
3. SINR-aware placement and channel planning, then antenna azimuth search.
4. Door and window editing in the planner UI.
5. Educational mode, first five lessons.
6. Before and after comparison report.
7. Accessibility audit with axe and keyboard alternatives to dragging.

## Later (needs new foundations)

1. Floor plan extraction with review ([17-ar-computer-vision.md](17-ar-computer-vision.md), DESIGN ONLY).
2. True 3D propagation (slabs, stairwells). Only then reconsider octrees, Three.js and GPU compute ([09-rendering-optimization.md](09-rendering-optimization.md), [adr-frontend-stack.md](adr-frontend-stack.md)).
3. AR overlay, needs a TLS story first (DESIGN ONLY).
4. Docker image if a deployment needs it (DESIGN ONLY).

## Campuses and smart cities (DESIGN ONLY)

Nothing exists. Required architecture before any work:

| Need | Why | Current limit |
|---|---|---|
| Site hierarchy (campus, building, floor) | the twin is one building, up to 6 floors (`rf-config.json` limits) | one twin file |
| Outdoor propagation models (terrain, buildings, vegetation) | indoor log-distance is wrong outdoors | none |
| Geographic coordinates and map tiles | placing buildings | plan units are metres in a local frame |
| Scale of compute (millions of cells) | 100k points take about 2 s today | in-browser worker only |
| Tiling and server-side compute, possibly GPU | beyond one worker | not designed |
| Data ownership and multi-user storage | many sites | local single user |
| Regulatory data (EIRP, DFS, channels by country) | outdoor 5 GHz and 6 GHz rules | channel sets are fixed lists |

Recommendation: do not start. Validate the single-building model against real surveys first. A campus planner built on an uncalibrated model multiplies the error.
