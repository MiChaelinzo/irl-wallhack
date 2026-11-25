# 14 Deployment plan

| Target | State | Status |
|---|---|---|
| Local laptop (loopback) | `./run.sh` or `python -m wallhack`, simulator by default | VERIFIED (install and smoke test in the sandbox, README table) |
| Raspberry Pi 4, RSSI only | same app, `--no-browser`, optional systemd unit | PARTIALLY VERIFIED (scripts tested with `--dry-run`) |
| Raspberry Pi 4, real CSI | `scripts/pi_setup.sh`, `docs/wallhack.service`, `docs/hardware.md` | UNVERIFIED on hardware |
| LAN for a phone companion | `--lan`, QR pairing | PARTIALLY VERIFIED (unit tests, headless Chromium) |
| Vercel static demo | `vercel.json`, `tools/build_demo.py` | build VERIFIED locally, deployment UNVERIFIED |
| Docker | none | DESIGN ONLY |

## Raspberry Pi

1. Raspberry Pi OS, Python 3.9 or newer, `./install.sh` (creates `.venv`).
2. Planner only: run `python -m wallhack --no-browser`; open `/planner` from the Pi or through an SSH tunnel (loopback default, nothing exposed).
3. Real CSI: follow `docs/hardware.md`; `scripts/pi_setup.sh install` builds nexmon_csi after confirmation; install `docs/wallhack.service`.
4. Expect the planner to be slower than the numbers in `docs/perf-rf.md` (measured on a Xeon, not on a Pi). Use larger `cell_m` first.

## LAN

Start with `--lan`. The host prints a QR code (`GET /api/pair`, loopback only). The phone scans it, the server swaps the token for an `HttpOnly` cookie. Plain HTTP on the LAN: the token can be sniffed on an untrusted network (see [13-security-review.md](13-security-review.md) S4). Use a trusted network.

## Vercel static demo

1. Connect the repository; `vercel.json` already sets build command, output directory and headers.
2. The build installs a pinned numpy only to generate the demo data; the deployed site is static files.
3. After the first deployment, record the result in the README table (today UNVERIFIED) and check the CSP in the browser console.
4. The demo cannot reach any API: `demo.js` maps `/api/*` to JSON files. The planner runs locally in the browser.

## Hosted demo checks and operations

- Before deploying, run `.venv/bin/python tools/build_demo.py` and `python3 -m http.server -d dist`, then `PLAYWRIGHT_NODEJS_PATH=$(which node) .venv/bin/python tools/planner_smoke.py --demo` and `tools/a11y_check.py` (it checks live and demo). These cover the planner, presets, learn mode, report and axe checks against the static build (VERIFIED locally, deployment itself UNVERIFIED).
- The static demo has no explain endpoint, no twin writes and no LLM. It uses the deterministic explanation text.
- Self-hosted server: request ids are in the `X-Request-ID` header and in the log line of each request. `WALLHACK_LOG_JSON=1` gives one JSON object per line for log shippers. `GET /api/diagnostics` answers only on the host machine (loopback, no Origin header) with version, uptime, limits and recent error counts, no keys.
- `PUT /api/twin` accepts up to about 23 MB and at most 2 concurrent uploads (429 with `Retry-After: 1` beyond that). Keep `--lan` on trusted networks only.
- Performance on small hardware: see the optimization guide in [09-rendering-optimization.md](09-rendering-optimization.md).

## Docker (DESIGN ONLY, nothing built)

Proposed image: `python:3.12-slim`, copy `wallhack/` and `requirements.txt`, `pip install`, run `python -m wallhack --no-browser --lan`. Considerations: `--lan` binds `0.0.0.0` and requires the pairing token (`config.py` and `app.py` tie them together), map a volume for `data/`, collectors that need `iw`, raw sockets or monitor mode do not work in a plain container, so the image targets simulator and planner use only. Add it only when someone needs it (steering: no speculative infrastructure).

## Release checklist (manual today)

0. Read [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full list.
1. `.venv/bin/python -m pytest -q`
2. `for f in wallhack/static/*.js; do node --check "$f"; done` and `bash -n scripts/pi_setup.sh install.sh run.sh`
3. `.venv/bin/python tools/build_demo.py` and check `dist/index.html`, `dist/recording.json`
4. Update README table and `CHANGELOG.md`
