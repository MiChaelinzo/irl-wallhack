# 13 Security review

Read from `wallhack/app.py`, `wallhack/pairing.py`, `wallhack/llm.py`, `wallhack/config.py`, `vercel.json`, `wallhack/static/planner-panels.js` header. Review by reading plus the existing automated tests. No penetration test, no fuzzing. Severity is the reviewer's judgement for a local-first tool.

## Threat model

Default: server binds `127.0.0.1`, single user, data stays on the machine. Optional LAN mode (`--lan`) for a phone companion. Optional cloud LLM. Static public demo with no server.

## Controls found

| Control | Where | Test |
|---|---|---|
| Loopback bind by default, `TrustedHostMiddleware` for `localhost` and `127.0.0.1` (DNS rebinding) | `app.py` `create_app` | `tests/test_pairing.py`, `tests/test_api.py` |
| LAN mode: random 24-byte token in memory, cookie `HttpOnly` `SameSite=strict`, bearer accepted, constant-time compare | `pairing.py` | `tests/test_pairing.py` |
| Loopback client with a foreign Host header refused in LAN mode | `pairing.py` `PairingMiddleware` | `tests/test_pairing.py` |
| `/api/pair` only for loopback and without an Origin header | `app.py` `pair` | `tests/test_pairing.py` |
| Same-origin check and JSON-only content type on writes | `app.py` `require_same_origin`, `require_json` | `tests/test_api.py` |
| WebSocket origin check | `app.py` `ws` | `tests/test_api.py` |
| Body limit streamed before buffering: 1 MB, twin route about 23.5 MB | `app.py` `read_json`, `MAX_TWIN_BODY_BYTES` | `tests/test_twin_api.py` |
| Strict input validation of twin and project | `twin.py`, `planner-state.js` | `tests/test_twin.py`, `tests/test_planner_state.py` |
| LLM off by default, keys from environment only, cloud needs per-request confirmation, response size cap, errors without keys | `llm.py` | `tests/test_insights.py` (mocked servers) |
| CSV formula-injection guard | `planner-export.js` `csvCell` | `tests/test_planner_panels.py` |
| Text from data rendered with `textContent`: grep finds no `innerHTML`, `insertAdjacentHTML`, `document.write` or `eval(` call in `wallhack/static/*.js` (one `innerHTML` match is a comment in `planner-panels.js`) | `planner-panels.js` header | grep only |
| Strict CSP on the static demo: `default-src 'self'`, `script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'` | `vercel.json` | headers read, deployment UNVERIFIED |

## Findings

| # | Finding | Severity | Status |
|---|---|---|---|
| S1 | The live FastAPI server sets no CSP, `X-Content-Type-Options`, `Referrer-Policy` or `frame-ancestors` headers (grep of `wallhack/*.py` finds none). Only the Vercel demo gets them. | Low (local tool, no cross-site content) | Open. Fix: a small middleware reusing the `vercel.json` header values |
| S2 | CSP allows `style-src 'unsafe-inline'`. Inline `style=` attributes are used by the UI. | Low | Accepted, documented here |
| S3 | `PUT /api/twin` accepts up to about 23.5 MB, held in memory per request. On loopback that is a self-inflicted cost only. In LAN mode a paired phone could send it. | Low | Bounded by design (FEAT-002), documented |
| S4 | Pairing token travels over plain HTTP on the LAN. Anyone who can sniff the Wi-Fi segment can read it. | Medium in hostile networks | Open, documented as "treat like a password", opt-in only |
| S5 | No rate limiting on any route. | Low locally | Open |
| S6 | `/api/rf/coverage` with a small `cell_m` and a large twin is CPU heavy (the parameter is bounded 0.1 to 5.0, floors bounded by limits). | Low | Bounded, not load tested |
| S7 | LLM cloud providers send finding text off-device. | Medium if enabled carelessly | Mitigated: off by default, explicit confirmation per request, disclosure text |
| S8 | No authentication or user model beyond the pairing token. Multi-user deployments are out of scope. | Informational | By design |
| S9 | Dependencies: `fastapi>=0.100`, `uvicorn[standard]>=0.23`, `numpy>=1.21` are unpinned lower bounds. No dependency scan in CI. | Low | Open |
| S10 | The planner stores projects, including floor-plan images, in browser localStorage unencrypted. | Low | Disclosed on the planner page ("stay in this browser and are never uploaded") |
| S11 | The simulated data is labelled as simulated throughout, which avoids a trust issue (presenting synthetic output as real). | Informational | Positive |

No secrets were found in the files read. `llm.py` documents that keys come from `OPENAI_API_KEY` or `AZURE_OPENAI_API_KEY` only.

## Status of claims

- Controls with tests: VERIFIED (automated tests).
- CSP effectiveness in a browser on a real deployment: UNVERIFIED.
- LAN mode on a real network and phone: PARTIALLY VERIFIED (headless Chromium and unit tests only).
