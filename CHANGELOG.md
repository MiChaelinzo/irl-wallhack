# Changelog

## Unreleased

### Static Vercel demo
- feat: `tools/build_demo.py` records the real Python Runtime (Simulator, SensingEngine, simulated environment) into `dist/recording.json`, one frame per WebSocket tick, and assembles a static site with relative paths. Deterministic (byte-identical builds). Needs numpy, not fastapi. No processing is ported to JS.
- feat: `wallhack/static/demo.js` plays the recording in a loop, with a pause button, a persistent "Simulated replay" banner, and read-only settings and calibrate. `app.js` behaves as before when the demo marker is absent.
- feat: `vercel.json` (build, output dir, CSP and security headers); `tools/screenshot.py --demo` writes `docs/screenshot-demo.png`. VERIFIED locally with http.server and headless Chromium; an actual Vercel deployment is UNVERIFIED.

### 3D view upgrade
- feat: 3D room view on the same 2D canvas, no libraries: gradient floor with distance-fading grid, translucent glowing zone volumes drawn far to near, expanding WiFi rings from the access point, glowing link arcs with comet pulses, a stylised person per occupied zone (breathing swell, heart-rate ring), seeded ambient dust, vignette. Verified by node unit tests (seeded dust, quality helpers) and one headless Chromium screenshot run; visuals on a real Pi UNVERIFIED.
- feat: quality selector (low, medium, high; default medium) saved in localStorage `wallhack.quality`. Low caps devicePixelRatio and frame rate and skips glow and dust. A sustained average frame time above 40 ms drops to low automatically (not saved).
- feat: `prefers-reduced-motion` stops auto-rotate and freezes ring, dust and pulse animation; the view still redraws on new data and on interaction.

### Vitals and environment sensing
- feat: heart rate from CSI (0.8-2.0 Hz, needs 8 Hz or more raw, not quantised, still person, peak ratio 30) and an activity classifier (empty, still, walking, active). Verified on synthetic data only; UNVERIFIED on real CSI. The simulated heartbeat is exaggerated and flagged SIMULATED. New events `heart_detected` and `heart_lost`.
- feat: `wallhack/environment.py` with US EPA AQI (2024 PM2.5 breakpoints, PM10), dew point, heat index and worst-of air-quality ratings. VERIFIED by unit tests.
- feat: optional sensor drivers in `wallhack/sensors/` (PMS5003, SCD40/41, ENS160, ZE08-CH2O, MLX90614) with pure frame parsers and an `EnvironmentHub` that reports ok, stale or error per sensor. pyserial and smbus2 are lazy optional imports. Parsers PARTIALLY VERIFIED (hand-built frames); hardware UNVERIFIED.
- feat: config `sensors`, `serial_pms`, `serial_hcho`, `i2c_bus`, flags `--sensors --pms-port --hcho-port --i2c-bus`, env `WALLHACK_SENSORS` and friends, `./install.sh --sensors`.
- feat: `status.environment` and `status.vitals`, `GET /api/environment`, `GET /api/vitals`. With a real source and no sensors configured, environment is `null`; the simulator provides a SIMULATED environment.
- docs: ZE08-CH2O byte layout cross-checked against two third-party transcriptions of the Winsen manual (PARTIALLY VERIFIED, PDF not fetched); added a literal-frame test.
- docs: README feature overview and verification table, `docs/hardware.md` sensor parts, Pi 4 wiring, UART setup, limits, and the not-built list (mood, perspiration, through-wall imaging, thermal image).
- ci: shell syntax check now includes `run.sh`.
- fix: `EnvironmentHub.poll_once` no longer raises on a driver returning unknown fields (or any driver exception). That sensor is marked error with the reason logged, and the other sensors keep polling.
- fix: UART framing (PMS5003, ZE08-CH2O) validates the checksum while choosing a frame, so header bytes inside a payload no longer select a misaligned frame. After a corrupt frame the buffer resyncs.
- fix: ENS160 warm-up and initial start-up readings are held back and reported as a new `warming` sensor state instead of being rated as valid.

### Dashboard redesign
- feat: dark-first glass-card dashboard (teal/violet), responsive to phone width, reduced-motion aware, keyboard focus styles.
- feat: Vitals card (heart rate with pulsing indicator, breathing, activity badge, low-confidence note when CSI is under 8 Hz) and Environment section (AQI ring with EPA bands, PM, CO2, TVOC, HCHO, temperature, humidity, dew point, heat index, surface temperature, sparklines, per-sensor status chips). Simulated values carry a SIMULATED ribbon; missing sensors show a `--sensors` hint.
- feat: 3D room view (`static/view3d.js`, own projection maths, no libraries): orbit by drag, zoom, auto-rotate, reset. Signal-activity visualisation with schematic positions, not imaging. Projection helpers tested under node (`tests/test_view3d.py`), canvas drawing UNVERIFIED beyond headless screenshots.
- docs: "About these readings" lists what WiFi cannot sense (mood, perspiration, imaging). `tools/screenshot.py` now writes desktop, 3D and mobile screenshots and fails on JS errors or a blank 3D canvas.

- fix: empty environment tiles show the actual sensor status (error, stale, warming) instead of always suggesting `--sensors`.
- fix: the heart rate on the Vitals card carries a permanent "experimental" tag.

### Real Pi 4 CSI
- feat: `scripts/pi_setup.sh` (check, install, start, status, stop/restore, `--dry-run`, `--yes`) builds nexmon_csi on a Pi 4 per the upstream recipe. Only dry-run and check logic tested; UNVERIFIED on hardware.
- feat: `./install.sh --pi-csi` runs the read-only preflight after installing; no-argument behaviour unchanged.
- feat: `docs/wallhack.service` is a CSI-capable unit with a dedicated user and ambient capabilities (UNVERIFIED).
- docs: Pi 4 step-by-step guide, buy list, troubleshooting, and an honest "what this can and cannot see" section; the BCM43455c0 CSI format is int16, not 32-bit packed.
- feat: `pi_setup.sh install` discloses `apt full-upgrade`, armhf, symlinks and setcap before asking; the archived unauthenticated python2.7 repository now needs `--allow-archived-python27` or a typed phrase, and `--yes` never allows it.
- feat: `pi_setup.sh` records setcap grants, the armhf architecture and symlinks in `<build-dir>/state`; `restore` removes the setcap grants, offers to remove created symlinks and lists what remains. Upstream `restore-wifi` confirmed to exist in `Makefile.rpi`.
- change: `start` no longer sets file capabilities on tcpdump under `--yes`; use `--grant-tcpdump-caps` or the systemd unit.
- feat: the dashboard note shows why the capture process stopped (for example tcpdump permission denied).
- ci: `bash -n` on the shell scripts.

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
