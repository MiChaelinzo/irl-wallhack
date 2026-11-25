# 23 Hackathon pitch

Audience variants below share one honest core. Do not claim anything this repository does not do. See the caveats section.

## Core narrative

Most Wi-Fi planning tools are either surveyed with expensive hardware or closed. irl-wallhack is an open, local-first planner that runs in a browser, models Wi-Fi 4 to 7 with interference, explains how fragile each recommendation is, and tells you what it has and has not verified.

Three proof points, each with a file:

1. A model that is transparent and tested: Python reference plus JavaScript port with parity tests (`tests/test_rf_parity.py`, `tests/test_wifi_standards.py`).
2. A measured benchmark: 100,489 points, 1000 walls, 4 APs in about 2 s with a first frame in about 145 ms (`docs/perf-rf.md`).
3. A project that labels its own limits: the Judge page and the VERIFIED / PARTIALLY VERIFIED / UNVERIFIED table (`wallhack/judge.py`, `README.md`).

## Variants

| Audience | Lead with | Show | Avoid |
|---|---|---|---|
| Codegeist (developer tooling) | Engineering quality: determinism, parity, no-build architecture, steering-driven workflow | tests, ADR ([adr-frontend-stack.md](adr-frontend-stack.md)), benchmark | claiming a framework migration |
| Devpost general | The user story: draw a floor plan, see coverage, get advice | live planner, PDF report | internal detail |
| Microsoft AI | Responsible AI: off by default, consent for cloud, engine numbers narrated not invented (design), Azure OpenAI supported in `llm.py` | `wallhack/llm.py`, the explain design in [06-ai-planner-design.md](06-ai-planner-design.md) | implying Azure was tested (mocked servers only, UNVERIFIED) and implying the planner explain endpoint exists |
| Cisco (networking) | Wi-Fi 6E and 7 modelling, SINR, channel planning, MLO capacity | [15-wifi-physics.md](15-wifi-physics.md), SINR demo | any claim of accuracy against Cisco gear or surveyed results |
| University showcases | Education: transparent formulas, lesson design, honest limitations | `docs/rf-planner.md`, [16-educational-mode.md](16-educational-mode.md) (design) | presenting the educational mode as built |

## Judge Q and A (prepared, honest)

| Question | Answer |
|---|---|
| Is the AI real? | The planner advice is deterministic search over a propagation model, with a sensitivity-based confidence. There is an optional LLM that rewords sensing findings. The planner narration is designed, not built. |
| How accurate is it? | Unknown against real buildings. It has not been compared with a survey. The constants are typical values with ranges and sources. |
| Does it work on a Pi? | The sensing path and scripts exist; hardware is UNVERIFIED. Benchmarks were not taken on a Pi. |
| Can it see through walls? | No. The sensing part measures signal disturbance, it makes no images (README). |
| What did you not build? | Educational mode, AR, floor-plan extraction, survey calibration, 3D propagation, campus planning. They are designed in this folder. |
| Why not React or Three.js? | Evaluated and rejected for now with reasons: [adr-frontend-stack.md](adr-frontend-stack.md). |
| Is the demo data real? | The default sensing data is simulated and labelled. |

## Caveats to say out loud

- Every heat map is a MODEL ESTIMATE, not a measurement.
- Competitor comparisons in [19-competitive-analysis.md](19-competitive-analysis.md) are from general knowledge and were not freshly researched.
- A real Vercel deployment, real CSI hardware, real LLM providers, a real GPU and a real survey are all UNVERIFIED today.
