# irl-wallhack

A local WiFi sensing dashboard. It watches how your WiFi signal changes and shows **presence, motion, breathing rate and a coarse zone** for the people in a room.

## What it is not
It does not make images and cannot literally see through walls. Bodies disturb radio signals, and that disturbance can be measured. Expect "someone is moving in the room", not a picture. Plain RSSI is coarse; richer data (ESP32 or Nexmon CSI) works better.

## Quick start
Needs Python 3.9+. No WiFi hardware is required: without a usable source it runs a built-in simulator.

| OS | Install | Run |
|---|---|---|
| Linux, Raspberry Pi 4, macOS | `./install.sh` | `./run.sh` |
| Windows 11 | double-click `install.bat` | double-click `run.bat` |

The dashboard opens at <http://127.0.0.1:8000/>. Options: `python -m wallhack --source simulator|real|auto --port 8000 --open`. Hardware notes: [docs/hardware.md](docs/hardware.md).

## Privacy and consent
Use it only in your own space, and only on people who know about it. The dashboard listens on localhost only. Do not expose it to a network. The tool never uploads anything.

## Verification status
| Area | Status |
|---|---|
| Signal processing (presence, motion, breathing) | VERIFIED (automated tests) |
| Simulator determinism (same seed, same output) | VERIFIED |
| Platform output parsers (on fixture text) | VERIFIED |
| REST API and static files served | VERIFIED |
| Server smoke test | VERIFIED |
| `install.sh` / `run.sh` in the Linux sandbox | VERIFIED |
| Dashboard files and JS syntax | PARTIALLY VERIFIED (not rendered in a browser) |
| Dashboard rendering in a real browser | UNVERIFIED |
| Real collectors on Raspberry Pi 4 | UNVERIFIED |
| Windows 11 (collector, `install.ps1`, `install.bat`, `run.bat`) | UNVERIFIED |
| macOS | UNVERIFIED |
| Nexmon CSI | UNVERIFIED |
| ESP32 CSI over UDP (beyond packet parsing) | UNVERIFIED |

## Tests
`.venv/bin/python -m pytest -q`
