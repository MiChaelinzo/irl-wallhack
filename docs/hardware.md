# Hardware notes

Wallhack works without hardware: with no usable WiFi source it runs a seeded simulator.
Everything below is UNVERIFIED on real devices. Only the output parsers are tested, on fixture text.

## What it can and cannot do
RSSI and CSI changes reveal presence, motion, breathing rate (0.1-0.5 Hz, needs a still person and good signal) and a coarse zone. It cannot make images or show people through walls like a camera.

## Data sources
- **Linux / Raspberry Pi 4**: reads signal strength from `iw` / `nmcli` (`--interface wlan0`). Plain RSSI is coarse; presence and motion work best with a stable link.
- **Windows 11**: reads `netsh wlan show interfaces`. Updates about once per second.
- **macOS**: reads `system_profiler` / `wdutil`. Newer macOS versions may hide details without extra permissions.
- **Any OS, fallback**: `--ping-target 192.168.x.1` measures latency to your own router (private IPs only).

## Nexmon CSI (Raspberry Pi 4, optional)
The Pi 4 Broadcom chip (BCM43455) can export CSI with the [nexmon_csi](https://github.com/seemoo-lab/nexmon_csi) firmware patch. Install it following its README, then forward each CSI frame as UDP JSON (format below) to the port given by `--udp-port`. Wallhack does not parse the raw Nexmon pcap format. A small forwarder script is needed and is not included.

## ESP32 CSI over UDP (optional)
Flash an ESP32 with CSI firmware (for example Espressif's esp-csi) and have it send one JSON datagram per packet to the machine running Wallhack:

```json
{"link": "esp32-1", "rssi": -52, "csi": [i0, q0, i1, q1]}
```

`csi` is interleaved I/Q integers. Start with `python -m wallhack --udp-port 5005`. The receiver accepts UDP from the network, so use only on your own trusted LAN. The dashboard itself stays on localhost.

## Autostart on a Pi
See `wallhack.service` in this folder.
