# irl-wallhack

A local WiFi sensing dashboard. It watches how your WiFi signal changes and shows **presence, motion, breathing rate and a coarse zone** for the people in a room.

## What it is not
It does not make images and cannot literally see through walls. Bodies disturb radio signals, and that disturbance can be measured. Expect "someone is moving in the room", not a picture. Plain RSSI is coarse; richer data (ESP32 or Nexmon CSI) works better. **Breathing needs CSI-rate data** (4+ readings per second, not rounded to whole steps). With Windows, macOS or `nmcli` signal readings (about 1 per second, coarse steps) breathing is switched off and the dashboard says so; presence and motion remain.

![Dashboard in simulator mode](docs/screenshot.png)

## Quick start
Needs Python 3.9+. No WiFi hardware required: without a usable source it runs a labelled simulator.

```
make install      # Windows: install.bat
make run          # Windows: run.bat  (opens the dashboard at 127.0.0.1:8000)
```
Options: `python -m wallhack --source simulator|real|auto --no-browser`. Hardware notes: [docs/hardware.md](docs/hardware.md).

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
| Real collectors on Raspberry Pi 4 | UNVERIFIED |
| Windows 11 (collector, `install.ps1`, `install.bat`, `run.bat`) | UNVERIFIED |
| macOS collector | UNVERIFIED |
| `netsh` parsing on non-English Windows | PARTIALLY VERIFIED (hand-written German/Spanish fixtures, no real captures) |
| `tools/csi_forwarder.py` (Nexmon frames to UDP JSON) | PARTIALLY VERIFIED (synthetic frames only; BCM43455 packed CSI not decoded) |
| ESP32 CSI over UDP: packets, token (collector and `Runtime` wiring) and timestamps over a local socket | VERIFIED |
| ESP32 / Nexmon hardware end to end | UNVERIFIED |

## Tests
```
.venv/bin/python -m pip install -r requirements-dev.txt   # pytest and httpx, test-only
.venv/bin/python -m pytest -q
```
