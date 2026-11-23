# 12 DevOps strategy

## CI today (`.github/workflows/ci.yml`, VERIFIED by reading; not run here)

On every push and pull request, matrix Python 3.9 and 3.12 on ubuntu-latest: install `requirements-dev.txt`, add `opencv-python-headless` so QR decode tests run, `pytest -q`, `node --check` on every `wallhack/static/*.js`, `bash -n` on the shell scripts, `python tools/build_demo.py` and a non-empty check for `dist/index.html` and `dist/recording.json`. Permissions are read-only (`contents: read`).

Missing: Node setup step (relies on the runner's default node, which the JS-under-node tests need), linting, browser tests, dependency and secret scanning, benchmark tracking.

## Vercel static demo

`vercel.json`: `buildCommand` pins `numpy==2.4.6` and runs `tools/build_demo.py`; `outputDirectory` is `dist`; headers set a strict CSP, `nosniff` and `no-referrer`. Locally VERIFIED (deterministic build, tests). A real Vercel deployment has never been run from this repository (UNVERIFIED).

## Raspberry Pi

`scripts/pi_setup.sh` (install, start, restore, `--dry-run`, confirmations, state file for undo) and `docs/wallhack.service` (systemd, loopback only, ambient capabilities for tcpdump, `ProtectSystem=strict`). Tested only through `--dry-run` and fake model files (`tests/test_pi_setup.py`). UNVERIFIED on hardware.

## Release (DESIGN ONLY)

Today: manual, `CHANGELOG.md` "Unreleased" section. Proposal:

1. Version in `wallhack/__init__.py` (exists, `__version__` is used by `app.py`).
2. Tag `vX.Y.Z`, a workflow builds `dist/` and attaches a zip.
3. Changelog section is cut from "Unreleased" at tag time.
4. No package index publishing until there is a reason.

## Proposed CI additions in priority order

| Item | Cost | Value |
|---|---|---|
| `actions/setup-node` pinned to the version the tests expect | small | removes runner drift |
| Playwright smoke (`tools/planner_smoke.py`) | medium | catches UI regressions |
| Accessibility check (`tools/a11y_check.py`, fetches axe-core from npm at run time, fails on serious or critical) | medium | keeps the zero-violation state from FEAT-005 |
| Throttled perf run (`tools/perf_rf_browser.py --throttle`) as an artifact, not a gate | small | tracks main-thread cost at 4x and 6x CPU throttling (approximation) |
| ruff and a JS syntax lint | small | catches dead code |
| `pip-audit` and a secret scan | small | supply chain |
| Weekly benchmark artifact (`tools/perf_rf.js --points 100000`) | small | tracks the 4x engine gap |

## Operations in the app (FEAT-005, VERIFIED by `tests/test_api.py`)

- Request ids: every response carries `X-Request-ID`. A client may send its own id if it is 8 to 64 characters of letters, digits, `.`, `_` or `-`; anything else is replaced by a random 16 hex character id (no header injection).
- Logging: one line per `/api/` request with method, path, status and duration. Query strings, headers and bodies are never logged, so pairing tokens and keys do not reach logs. `log_json` in `config.json` or `WALLHACK_LOG_JSON=1` switches to one JSON object per line (`time`, `level`, `logger`, `message`, `request_id`, plus `method`, `path`, `status`, `duration_ms`). Default is the old text format. Code: `wallhack/logging_setup.py`.
- Errors: an unhandled exception in a route returns HTTP 500 with JSON `{"error": "internal_error", "request_id", "detail"}`. The detail explains what to do and does not include the exception text; the stack trace goes to the server log under the same request id. HTTP 5xx and unhandled exceptions are counted in a rolling one hour window.
- `GET /api/diagnostics`: version, Python version, OS name, uptime, source, LAN and history flags, LLM provider name (or `off`), JSON log flag, request size limits, and recent error counts. It answers only loopback clients without an `Origin` header (same rule as `/api/pair`) and contains no keys, tokens, file paths or addresses (test asserts a set environment key and the UDP token do not appear).
- Front end: `common.js` catches uncaught errors and unhandled promise rejections on every page that loads it and shows them in the page notice with `role="alert"` (planner `#plannerNotice`, dashboard `#note`, otherwise a new banner).
- Not done: log shipping, metrics export (Prometheus or similar), log rotation (uvicorn writes to stderr; use the service manager), and alerting. These are UNVERIFIED design items.
