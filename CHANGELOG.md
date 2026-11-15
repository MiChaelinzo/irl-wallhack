# Changelog

## Unreleased

### Dashboard upgrade
- feat: `POST /api/calibrate` resets learned baselines (same-origin check, also now applied to `POST /api/settings`); Calibrate button in the dashboard.
- feat: light/dark theme toggle (saved in localStorage, follows the OS by default), mobile-friendly header, offline banner and "Waiting for readings" empty states.
- feat: event log export to JSON or CSV (client-side, spreadsheet formula characters escaped); optional beep on presence/motion, off by default.
- fix: WebSocket stream resumes after a source change restarts sample numbering.

### Polish
- ci: GitHub Actions workflow runs pytest (Python 3.9 and 3.12) and `node --check` on push/PR with read-only permissions; not yet run on GitHub (UNVERIFIED).
- fix: forwarder logs and continues if forwarding a packet fails; CRLF netsh output covered by a test.
- feat: browser opens by default when run from a terminal (`--no-browser` to skip); `Makefile`, `pyproject.toml` with a `wallhack` command.
- feat: `wallhack/nexmon.py` and `NexmonCollector` read real nexmon_csi frames from a `tcpdump` pcap stream (`--csi-source nexmon`, `--csi-port`); `--csi-check [SECONDS]` diagnoses a capture. VERIFIED on synthetic frames only, UNVERIFIED on Pi hardware.
- fix: the forwarder reuses `wallhack/nexmon.py`; docs no longer claim the Pi 4 packs 32-bit CSI (it is int16 I/Q).
- feat: `tools/csi_forwarder.py` converts nexmon_csi frames to the UDP JSON format (UNVERIFIED on hardware); docs/hardware.md no longer references a missing script.
- feat: `netsh` parsing no longer depends on the Windows display language; fixture tests added.
- feat: dashboard has presence/motion/breathing pills and a SIMULATED/REAL chip.
- fix: found by running the page in headless Chromium: a late poll response overwrote the "live" chip with "polling".
- docs: simpler README quick start; screenshot via `tools/screenshot.py` (optional playwright).

### Review fixes (feat/wifi-sensing)
- fix: `uvicorn[standard]` so `/ws` works on a real server. Test: real-process WebSocket smoke test.
- fix: Host allow-list (localhost, 127.0.0.1) on loopback binds, WebSocket Origin must match Host, `POST /api/settings` requires `application/json`.
- fix: breathing is disabled when raw data is under 4 Hz or all multiples of 0.5 dB; the status note says so.
- fix: collector polling and probing no longer hold the API lock; stale readings from before a settings change are dropped.
- fix: UDP packets carry their own receive time. Optional `--udp-token` rejects spoofed packets; `--udp-host` added (docs previously implied the receiver was LAN-reachable by default).
- fix: `--source real` with no readings now errors (CLI exit, HTTP 422 on settings, previous settings kept). Real sources with no data for 10 s show a "no new readings" note.
- refactor: removed unused `parse_wdutil` and the wdutil claims. `pytest`/`httpx` moved to `requirements-dev.txt`.
- fix: `--udp-token` is now passed to the UDP collector by `Runtime` (it was parsed but ignored). Test: `test_runtime_passes_udp_token_to_collector`.
- fix: `::1` removed from loopback hosts; Starlette's Host check cannot parse `[::1]:port`, so `--host ::1` is treated as exposed and warns.
- docs: README table relabelled: processing is verified on simulated data only.

Review items not fully resolved (justification):
- Real-RSSI fixture (item 3): no real capture can be recorded in this sandbox. Real-signal accuracy is marked UNVERIFIED instead of adding a fabricated trace.
- `auto` mode still commits to the simulator when the first probe fails (item 7, possible): it is labelled by a visible note, and changing settings re-probes. Not changed to avoid a background retry loop.
- Non-English Windows `netsh` labels (details section): documented in README, not fixed without real samples.
- Install-script robustness (partial `.venv`, hidden pip upgrade output): not changed, out of the blocking scope.

- Backend: presence, motion and FFT breathing-rate processing, seeded deterministic simulator, platform collectors (iw/nmcli, netsh, system_profiler/wdutil, ping, ESP32 UDP CSI), FastAPI API and WebSocket.
- Status: VERIFIED by 36 automated tests on simulator data and fixture text. Real collectors are UNVERIFIED on hardware.
- Dashboard: offline vanilla JS page (status badge, RSSI and motion graphs, breathing gauge, zone heat map, event timeline, settings drawer, privacy/consent banner, WebSocket with polling fallback).
- Dashboard status: PARTIALLY VERIFIED. Files served and JS syntax checked by tests; visual rendering in a real browser was not executed.
- One-step install/run scripts: install.sh, run.sh (Linux, Pi, macOS), install.ps1, install.bat, run.bat (Windows, UNVERIFIED).
- Smoke test starts the simulator server and checks /api/status and /.
- README quick start with verification table; docs/hardware.md and docs/wallhack.service.
