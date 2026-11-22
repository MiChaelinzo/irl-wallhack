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
| ruff and a JS syntax lint | small | catches dead code |
| `pip-audit` and a secret scan | small | supply chain |
| Weekly benchmark artifact (`tools/perf_rf.js --points 100000`) | small | tracks the 4x engine gap |
