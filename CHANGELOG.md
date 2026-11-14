# Changelog

## Unreleased

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
