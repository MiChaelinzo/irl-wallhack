# 03 Architecture

## Current architecture (VERIFIED against the code)

```mermaid
flowchart LR
  subgraph Core["Python core (reference)"]
    CFG[rf-config.json + schema]
    RFM["rfmodel.py (modes, SINR, lab estimates)"]
    TWN[twin.py validation]
  end
  subgraph Server["FastAPI app.py"]
    API["/api/twin, /api/rf/*, /api/insights, /api/diagnostics"]
    EXPL["/api/planner/explain"]
    LLM["llm.py (optional, off by default)"]
    PAIR[pairing.py]
  end
  subgraph Browser["Browser, no build step"]
    ENG["rf-engine.js (UMD mirror)"]
    WRK[rf-worker.js]
    OPT["rf-optimizer.js (placement, channels, mesh, fixes)"]
    STATE["planner-state.js (project, undo, validation)"]
    UI["planner.js, planner-editor.js, planner-panels.js, planner-modes.js"]
    LEARN["planner-learn.js + learn-content.json"]
    SCN[scenarios.json]
    HEAT["planner-heat.js (WebGL or canvas, layers)"]
    EXP["planner-export.js (PDF, PNG, CSV, JSON)"]
  end
  CFG --> RFM
  CFG --> ENG
  RFM --> API
  TWN --> API
  API --> EXPL
  EXPL --> LLM
  PAIR --> API
  API <-->|twin JSON| UI
  UI --> STATE
  SCN --> UI
  UI -->|jobs| WRK
  WRK --> ENG
  OPT --> ENG
  UI --> OPT
  UI --> LEARN
  LEARN --> ENG
  WRK -->|grids, layers| UI
  UI --> HEAT
  UI --> EXP
  RFM -. parity tests .- ENG
  TWN -. same limits .- STATE
```

Data flow for one analysis: the editor changes the project in `planner-state.js`, the UI posts a job to `rf-worker.js`, the worker calls `rf-engine.js` (coarse pass first, then tiles), and the result arrays go to `planner-heat.js` and the panels. Exports read the same results, so a PDF never recomputes a number.

Notes:

- The dotted lines are the only couplings between duplicated implementations: Python and JS propagation maths (`tests/test_rf_parity.py`, `test_wifi_standards.py`, `test_rf_lab.py`) and project limits shared through `rf-config.json` (`tests/test_planner_state.py`, `tests/test_twin.py`).
- `rf-optimizer.js` runs in the worker for `plan` jobs and on the main thread for direct calls. It is deterministic.
- The LLM never computes a number. `POST /api/planner/explain` builds its text from engine numbers, falls back to deterministic text when the LLM is off, and checks that a reply only uses numbers it was given. Cloud providers need per-request consent.
- The static Vercel demo has no server: `demo.js` maps `/api/*` calls to JSON files built by `tools/build_demo.py`. The planner runs fully in the browser.
- Extension points: a new propagation mode is registered with `register_mode` in `rfmodel.py` and mirrored in `rf-engine.js`; a new heat layer is a `planner_layers` entry plus a builder in `planner-heat.js`; a new material is a `materials` entry. See [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Sensing path (separate from the planner)

`collectors/*` and `simulator.py` feed `runtime.py`, which runs `processing.py`, `insights.py`, `scores.py`, `history.py` and serves `/ws` plus REST routes to `app.js`, `panels.js`, `view3d.js`, `mobile.js`, `judge.js`.

## Target architecture (DESIGN ONLY)

```mermaid
flowchart LR
  CFG[rf-config.json + schema]
  CORE["Core: rfmodel.py and rf-engine.js (parity)"]
  SURVEY["Survey calibration (NOT BUILT)"]
  OPT["Optimiser: joint power, channel and azimuth search (NOT BUILT)"]
  EXPL["/api/planner/explain (built)"]
  LLM["llm.py, off by default, env-var keys"]
  UI[Planner UI]
  CFG --> CORE
  SURVEY --> CFG
  CORE --> OPT
  OPT --> UI
  OPT -->|numbers only| EXPL
  EXPL --> LLM
  LLM -->|narration| UI
  CORE --> UI
```

Principles that stay: the engine computes every number, the LLM narrates numbers it is given, defaults stay local-only, no build step unless the ADR is revisited ([adr-frontend-stack.md](adr-frontend-stack.md)).
