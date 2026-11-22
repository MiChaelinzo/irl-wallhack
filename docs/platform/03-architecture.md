# 03 Architecture

## Current architecture (VERIFIED against the code)

```mermaid
flowchart LR
  subgraph Core["Python core (reference)"]
    CFG[rf-config.json]
    RFM[rfmodel.py]
    TWN[twin.py]
  end
  subgraph Server["FastAPI app.py"]
    API["/api/twin, /api/rf/*, /api/insights"]
    LLM["llm.py (optional, off by default)"]
    PAIR[pairing.py]
  end
  subgraph Browser["Browser, no build step"]
    ENG[rf-engine.js]
    WRK[rf-worker.js]
    OPT[rf-optimizer.js]
    UI["planner*.js UI"]
    HEAT[planner-heat.js WebGL or canvas]
    EXP[planner-export.js]
  end
  CFG --> RFM
  CFG --> ENG
  RFM --> API
  TWN --> API
  LLM --> API
  PAIR --> API
  API <-->|twin JSON| UI
  UI -->|jobs| WRK
  WRK --> ENG
  OPT --> ENG
  UI --> OPT
  WRK -->|grids| UI
  UI --> HEAT
  UI --> EXP
  RFM -. parity tests .- ENG
```

Notes:

- The dotted line is the only coupling between the Python reference and the JS port: tests (`tests/test_rf_parity.py`, `tests/test_wifi_standards.py`).
- `rf-optimizer.js` runs in the worker for `plan` jobs and on the main thread for direct calls. It is deterministic.
- The LLM only receives rule findings from `insights.py` today. It never touches planner numbers (the explain route for planner advice is NOT BUILT).
- The static Vercel demo has no server: `demo.js` maps `/api/*` calls to JSON files built by `tools/build_demo.py`. The planner runs fully in the browser.

## Sensing path (separate from the planner)

`collectors/*` and `simulator.py` feed `runtime.py`, which runs `processing.py`, `insights.py`, `scores.py`, `history.py` and serves `/ws` plus REST routes to `app.js`, `panels.js`, `view3d.js`, `mobile.js`, `judge.js`.

## Target architecture (DESIGN ONLY)

```mermaid
flowchart LR
  CFG[rf-config.json + schema]
  CORE["Core: rfmodel.py and rf-engine.js (parity)"]
  SURVEY["Survey calibration (NOT BUILT)"]
  OPT["Optimiser: RSSI + SINR objective (NOT BUILT)"]
  EXPL["/api/planner/explain (NOT BUILT)"]
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
