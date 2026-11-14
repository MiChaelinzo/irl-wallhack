# irl-wallhack

A local WiFi sensing dashboard. It watches how your WiFi signal changes and shows **presence, motion, breathing rate and a coarse zone** for the people in a room.

## What it is not
It does not make images and cannot literally see through walls. Bodies disturb radio signals, and that disturbance can be measured. Expect "someone is moving in the room", not a picture. Plain RSSI is coarse; richer data (ESP32 or Nexmon CSI) works better. **Breathing needs CSI-rate data** (4+ readings per second, not rounded to whole steps). With Windows, macOS or `nmcli` signal readings (about 1 per second, coarse steps) breathing is switched off and the dashboard says so; presence and motion remain.

## Quick start
Needs Python 3.9+. No WiFi hardware is required: without a usable source it runs a built-in simulator.

| OS | Install | Run |
|---|---|---|
| Linux, Raspberry Pi 4, macOS | `./install.sh` | `./run.sh` |
| Windows 11 | double-click `install.bat` | double-click `run.bat` |

The dashboard opens at <http://127.0.0.1:8000/>. Options: `python -m wallhack --source simulator|real|auto --port 8000 --open`. Hardware notes: [docs/hardware.md](docs/hardware.md).

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
| Dashboard files and JS syntax | PARTIALLY VERIFIED (not rendered in a browser) |
| Dashboard rendering in a real browser | UNVERIFIED |
| Real collectors on Raspberry Pi 4 | UNVERIFIED |
| Windows 11 (collector, `install.ps1`, `install.bat`, `run.bat`) | UNVERIFIED |
| macOS (also: `netsh` labels on non-English Windows may not parse, then it falls back to the simulator with a note) | UNVERIFIED |
| ESP32 CSI over UDP: packets, token (collector and `Runtime` wiring) and timestamps over a local socket | VERIFIED |
| ESP32 / Nexmon hardware end to end | UNVERIFIED |

## Tests
```
.venv/bin/python -m pip install -r requirements-dev.txt   # pytest and httpx, test-only
.venv/bin/python -m pytest -q
```
