# irl-wallhack

A local WiFi sensing dashboard. It watches how your WiFi signal changes and shows **presence, motion, activity (still, walking, active), breathing rate, an experimental heart rate and a coarse zone** for the people in a room. Optional cheap sensors add **PM1/2.5/10, CO2, TVOC, formaldehyde, temperature, humidity, dew point, heat index, surface temperature and an air-quality rating with a US EPA AQI**. A **3D room view** shows signal activity per zone.

![3D room view](docs/screenshot-3d.png)

## What it is not
It does not make images and cannot literally see through walls. Bodies disturb radio signals, and that disturbance can be measured. Expect "someone is moving in the room", not a picture. Plain RSSI is coarse; richer data (ESP32 or Nexmon CSI) works better. **Breathing needs CSI-rate data** (4+ readings per second, not rounded to whole steps) and **heart rate needs 8+ readings per second** and a still person; it is experimental and low confidence. With Windows, macOS or `nmcli` signal readings (about 1 per second, coarse steps) breathing is switched off and the dashboard says so; presence and motion remain.

![Dashboard in simulator mode](docs/screenshot.png)

## Features
- **Vitals from WiFi**: breathing (0.1-0.5 Hz) and heart rate (0.8-2.0 Hz, gated at 8 Hz or more raw sampling and a strong spectral peak, peak ratio 30). Activity badge: empty, still, walking, active. The walking cadence rule is a heuristic that has only been tried on the simulator.
- **Environment tiles** (optional sensors, see below): PM, CO2, TVOC, HCHO, temperature, humidity, dew point, heat index, surface temperature, AQI ring and a worst-of air-quality rating with its drivers. Ratings are general guidance bands, not medical advice.
- **3D room view**: plain canvas, own projection maths, drag to orbit, zoom, auto-rotate. It is a schematic signal-activity visualisation, not imaging.
- **Simulator**: every simulated value (vitals and environment) is marked SIMULATED. The simulated heartbeat is exaggerated so the demo shows it. With a real source and no sensors configured, environment tiles show "no sensor" and nothing is invented.

![Mobile layout](docs/screenshot-mobile.png)

## Not built, on purpose
- **Mood / emotion**: there is no established way to infer it from WiFi, so nothing is shown.
- **Perspiration**: no WiFi or listed-sensor method exists.
- **Through-wall "sights" / body images**: not possible with this hardware and software; the 3D view is schematic.
- **Thermal camera image** (MLX90640, AMG8833): would need an image driver; only mentioned as future hardware in [docs/hardware.md](docs/hardware.md).

## Quick start
Needs Python 3.9+. No WiFi hardware required: without a usable source it runs a labelled simulator.

```
make install      # Windows: install.bat
make run          # Windows: run.bat  (opens the dashboard at 127.0.0.1:8000)
```
Options: `python -m wallhack --source simulator|real|auto --no-browser`. Hardware notes: [docs/hardware.md](docs/hardware.md).

## Environment sensors (optional)
Supported parts: PMS5003 (PM, UART), SCD40/41 (CO2, temperature, humidity, I2C), ENS160 (TVOC, I2C), ZE08-CH2O (formaldehyde, UART), MLX90614 (surface temperature, I2C). Wiring and warm-up notes are in [docs/hardware.md](docs/hardware.md). All of it is UNVERIFIED on real devices.
```
./install.sh --sensors        # adds pyserial and smbus2 (never needed for the default install)
.venv/bin/python -m wallhack --sensors pms5003,scd4x,ens160,ze08,mlx90614 --pms-port /dev/serial0 --hcho-port /dev/ttyUSB0 --i2c-bus 1
```
Same settings as environment variables: `WALLHACK_SENSORS`, `WALLHACK_SERIAL_PMS`, `WALLHACK_SERIAL_HCHO`, `WALLHACK_I2C_BUS`. Pick any subset in `--sensors`. A sensor that fails to open shows as an error chip in the dashboard instead of being hidden.

## Raspberry Pi 4 real CSI
Real (not simulated) CSI on a Pi 4 Model B uses the nexmon_csi firmware patch. UNVERIFIED on hardware; see [docs/hardware.md](docs/hardware.md) for the full guide, buy list and what it can and cannot see.
```
./install.sh --pi-csi && scripts/pi_setup.sh install      # asks before replacing WiFi firmware
scripts/pi_setup.sh start                                  # pick your router's channel
.venv/bin/python -m wallhack --source real --csi-source nexmon --interface wlan0
```
Run the script as your normal user; it asks for sudo where needed. `install` runs `apt full-upgrade` as upstream does. Undo with `scripts/pi_setup.sh restore` (see docs/hardware.md for what it does not undo). Add `--dry-run` to any command to only print what it would do.

## Privacy and consent
Use it only in your own space, and only on people who know about it. The dashboard listens on localhost only and rejects requests whose Host or WebSocket Origin is not local, so other web pages in your browser cannot read it. Do not expose it to a network. If you open the UDP receiver to your LAN for an ESP32, set `--udp-token` so spoofed packets are ignored. The tool never uploads anything.

## Verification status
| Area | Status |
|---|---|
| Signal processing on **simulated** data (presence, motion, breathing) | VERIFIED (automated tests, simulator only) |
| Signal processing accuracy on **real** RSSI or CSI | UNVERIFIED (no recorded real traces; thresholds were tuned on the simulator) |
| Breathing gating for slow or quantised data | VERIFIED (unit tests) |
| Host/Origin checks, JSON-only settings, explicit `real` failure, stale-data note | VERIFIED (automated tests) |
| WebSocket `/ws` on a real uvicorn process | VERIFIED (smoke test) |
| Simulator determinism (same seed, same output) | VERIFIED |
| Platform output parsers (on fixture text) | VERIFIED |
| REST API and static files served | VERIFIED |
| Server smoke test (real process) | VERIFIED |
| `install.sh` in the Linux sandbox | VERIFIED |
| `run.sh` (syntax checked; same command as smoke test) | PARTIALLY VERIFIED |
| Dashboard files and JS syntax | VERIFIED (automated tests) |
| Dashboard in headless Chromium (simulator mode: loads, live WebSocket, no JS errors, `docs/screenshot.png`, via `tools/screenshot.py`) | VERIFIED (one run in this sandbox; not Firefox/Safari, not a phone) |
| `POST /api/calibrate` and cross-origin refusal | VERIFIED (automated tests) |
| Dashboard theme toggle, export, beep, offline banner | PARTIALLY VERIFIED (JS syntax check; headless Chromium load showed no JS errors and rendered the light theme; toggle, export, beep and offline banner were not clicked or exercised) |
| Heart rate, breathing and activity classifier on **synthetic** signals (gating for low rate, quantised data and motion) | VERIFIED (unit tests, synthetic only) |
| Heart rate and walking-cadence accuracy on **real** CSI (peak ratio 30 chosen against white noise and the simulator) | UNVERIFIED |
| US EPA AQI, dew point, heat index, rating bands (unit tests at breakpoints) | VERIFIED |
| Sensor frame parsers (PMS5003, SCD4x, ENS160, MLX90614) on hand-built frames from datasheet layouts | PARTIALLY VERIFIED (never fed by a real device) |
| ZE08-CH2O frame layout (`FF 17 04 dec CH CL RH RL SUM`) | PARTIALLY VERIFIED (matches two third-party transcriptions of the Winsen manual; the PDF itself could not be fetched, no module) |
| Sensor drivers and `EnvironmentHub` with fake transports (stale, error, merge) | VERIFIED (fakes only) |
| Sensor drivers on real hardware (UART, I2C, wiring, warm-up, calibration) | UNVERIFIED |
| `/api/environment`, `/api/vitals`, simulated flag, real source without sensors gives `null` | VERIFIED (automated tests) |
| 3D view projection helpers (`static/view3d.js`, run under node) | VERIFIED |
| 3D view and environment tiles in headless Chromium (simulator data: no JS errors, SIMULATED ribbons, non-blank canvas, three screenshots) | VERIFIED (one run in this sandbox, simulated data only; touch orbit on phones not tried) |
| Mood, perspiration, through-wall imaging | NOT BUILT (no valid method; see above) |
| Real collectors on Raspberry Pi 4 | UNVERIFIED |
| Windows 11 (collector, `install.ps1`, `install.bat`, `run.bat`) | UNVERIFIED |
| macOS collector | UNVERIFIED |
| `netsh` parsing on non-English Windows | PARTIALLY VERIFIED (hand-written German/Spanish fixtures, no real captures) |
| `tools/csi_forwarder.py` (Nexmon frames to UDP JSON; BCM43455c0 decoded as int16 per upstream) | PARTIALLY VERIFIED (synthetic frames only, never a real capture) |
| Nexmon frame/pcap decoding and `NexmonCollector` on fixtures built from upstream docs | VERIFIED (synthetic only) |
| End-to-end synthetic CSI to breathing rate | VERIFIED (synthetic only) |
| `scripts/pi_setup.sh` dry-run and check logic with a fake model file | PARTIALLY VERIFIED (not run on a Pi) |
| nexmon build and firmware install, monitor-mode config, tcpdump capture, real CSI decoding with real frames, real breathing accuracy, systemd unit | UNVERIFIED (no Pi 4 in the sandbox) |
| ESP32 CSI over UDP: packets, token (collector and `Runtime` wiring) and timestamps over a local socket | VERIFIED |
| ESP32 / Nexmon hardware end to end | UNVERIFIED |

## Tests
```
.venv/bin/python -m pip install -r requirements-dev.txt   # pytest and httpx, test-only
.venv/bin/python -m pytest -q
```
