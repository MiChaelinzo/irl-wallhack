# Platform documentation

Audit and design set for evolving irl-wallhack toward an AI-powered wireless digital twin platform. Written from the code on branch `feat/platform-audit`. Every statement about existing behaviour was checked against a file or a test. Anything not built is labelled DESIGN ONLY or NOT BUILT.

Labels used everywhere (from the repository steering):

- **VERIFIED**: validated by automated tests or a recorded run.
- **PARTIALLY VERIFIED**: validated by inspection or a scripted run that did not cover everything.
- **UNVERIFIED**: not executed or not tested.

Competitor statements in `19-competitive-analysis.md` come from general knowledge and were not freshly researched.

| # | Document | Content |
|---|---|---|
| 01 | [Repository audit](01-repository-audit.md) | Architecture, maintainability, scalability, demo readiness and hackathon scores with evidence |
| 02 | [Technical debt](02-technical-debt.md) | File sizes, duplicated Python/JS logic, unfinished items |
| 03 | [Architecture](03-architecture.md) | Mermaid diagrams, current and target |
| 04 | [Folder structure](04-folder-structure.md) | Current and proposed |
| 05 | [Component map](05-component-map.md) | Every module and what it owns |
| 06 | [AI planner design](06-ai-planner-design.md) | What `rf-optimizer.js` does, the design for the rest |
| 07 | [Material database](material-database.md) | Generated from `rf-config.json`, do not edit by hand |
| 08 | [Data schemas](08-data-schemas.md) | Twin, project, config and report shapes |
| 09 | [Rendering optimisation](09-rendering-optimization.md) | Measured numbers and decisions |
| 10 | [UI modernisation](10-ui-modernization.md) | Design tokens, WCAG 2.2 AA checklist |
| 11 | [Testing strategy](11-testing-strategy.md) | Pyramid, parity, determinism |
| 12 | [DevOps strategy](12-devops-strategy.md) | CI, Vercel demo, Pi service, release |
| 13 | [Security review](13-security-review.md) | Findings with severity and status |
| 14 | [Deployment plan](14-deployment-plan.md) | Pi, LAN, Vercel, Docker (design) |
| 15 | [Wi-Fi physics](15-wifi-physics.md) | Formulas, citations, inaccuracy report |
| 16 | [Educational mode](16-educational-mode.md) | BUILT (first version), PARTIALLY VERIFIED |
| 17 | [AR and computer vision](17-ar-computer-vision.md) | DESIGN ONLY |
| 18 | [Reporting engine](18-reporting-engine.md) | Audit of exports and gaps |
| 19 | [Competitive analysis](19-competitive-analysis.md) | General knowledge, not freshly researched |
| 20 | [Roadmap](20-roadmap.md) | Now, next, later |
| 21 | [Top 100 improvements](21-top-100-improvements.md) | Ranked, with status and evidence |
| 22 | [Top 10 hackathon features](22-top-10-hackathon-features.md) | With demo script |
| 23 | [Hackathon pitch](23-hackathon-pitch.md) | Judge-facing narrative and caveats |
| 24 | [RF lab status](24-rf-lab-status.md) | Complete, partial and deferred per mandate section |
| 25 | [V2 audit](25-v2-audit.md) | The 20 V2 items and the WOW list against the code, plus defects fixed |
| 26 | [WiFi architect round](26-wifi-architect-round.md) | The round objective and a status table for its 10 priority features and extras |
| ADR | [Frontend stack ADR](adr-frontend-stack.md) | React, TypeScript, Three.js evaluation and decision |
| ADR | [Planner 3D view ADR](adr-3d-view.md) | In-house WebGL and canvas projection against vendored three.js, with measurements |

`tests/test_platform_docs.py` checks that these files exist, that the top 100 table has at least 100 ranked rows, and that every file named in a Done row exists.
