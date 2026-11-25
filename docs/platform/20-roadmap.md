# 20 Roadmap

Phases are ordered by value over cost from [21-top-100-improvements.md](21-top-100-improvements.md). Dates are deliberately absent: there is no capacity plan to base them on. DESIGN ONLY items are marked.

## Done since the audit (see [24-rf-lab-status.md](24-rf-lab-status.md))

Engine profile (1675 to 684.6 ms on the 100k point floor), AP panel SINR and MLO results, SINR-aware channel planning, door, window, stairwell and interference editing, LLM explain endpoint (off by default), educational mode with six lessons, scenario presets, richer PDF, axe accessibility run with 0 violations, request ids and diagnostics, CONTRIBUTING.md.

## Now (small, measurable, unblock honesty)

1. Run `tools/planner_smoke.py` and `tools/a11y_check.py` in CI (needs Chromium in the workflow).
2. Add SINR and standard columns to CSV and PDF.
3. Real Vercel deployment and record the result.
4. Heat map data table alternative for screen readers, then a screen reader pass.
5. Widen JSDoc type checking.
6. A room creation tool in the planner (rooms are only walls plus a label today).

## Next (the product story)

1. Survey import (CSV of position and dBm) and a model fit with a reported error. This is the single most valuable item: every accuracy statement stays UNVERIFIED without it.
2. Azimuth search and joint power and channel optimisation.
3. Wireless consultant chat grounded in engine numbers.
4. Before and after comparison report.
5. Reflection, antenna and mesh lessons.
6. Spectrum scan import for the Spectrum tab.

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
