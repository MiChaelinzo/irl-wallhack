# Changelog

## Unreleased

- Backend: presence, motion and FFT breathing-rate processing, seeded deterministic simulator, platform collectors (iw/nmcli, netsh, system_profiler/wdutil, ping, ESP32 UDP CSI), FastAPI API and WebSocket.
- Status: VERIFIED by 36 automated tests on simulator data and fixture text. Real collectors are UNVERIFIED on hardware.
- Dashboard: offline vanilla JS page (status badge, RSSI and motion graphs, breathing gauge, zone heat map, event timeline, settings drawer, privacy/consent banner, WebSocket with polling fallback).
- Dashboard status: PARTIALLY VERIFIED. Files served and JS syntax checked by tests; visual rendering in a real browser was not executed.
- README follows in a later change.
