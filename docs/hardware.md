# Hardware notes

Wallhack works without hardware: with no usable WiFi source it runs a seeded simulator.
Everything below is UNVERIFIED on real devices. Parsers are tested on fixture text and the UDP receiver over a local socket.

## What it can and cannot do
RSSI and CSI changes reveal presence, motion, breathing rate (0.1-0.5 Hz, needs a still person, good signal and CSI-rate data: 4+ unrounded readings per second; disabled automatically for Windows, macOS and nmcli data) and a coarse zone. It cannot make images or show people through walls like a camera.

## Data sources
- **Linux / Raspberry Pi 4**: reads signal strength from `iw` / `nmcli` (`--interface wlan0`). Plain RSSI is coarse; presence and motion work best with a stable link.
- **Windows 11**: reads `netsh wlan show interfaces`. Updates about once per second.
- **macOS**: reads `system_profiler` (about every second or slower). Newer macOS versions may hide details without extra permissions.
- **Any OS, fallback**: `--ping-target 192.168.x.1` measures latency to your own router (private IPs only).

## Nexmon CSI (Raspberry Pi 4, optional)
The Pi 4 Broadcom chip (BCM43455) can export CSI with the [nexmon_csi](https://github.com/seemoo-lab/nexmon_csi) firmware patch. Install it following its README, then forward each CSI frame as UDP JSON (format below) to the port given by `--udp-port`. Wallhack does not parse the raw Nexmon pcap format. A small forwarder script is needed and is not included.

## ESP32 CSI over UDP (optional)
Flash an ESP32 with CSI firmware (for example Espressif's esp-csi) and have it send one JSON datagram per packet to the machine running Wallhack:

```json
{"link": "esp32-1", "rssi": -52, "csi": [i0, q0, i1, q1]}
```

`csi` is interleaved I/Q integers. Start with `python -m wallhack --udp-port 5005 --udp-host 0.0.0.0 --udp-token YOUR_SECRET` and add `"token": "YOUR_SECRET"` to each packet. By default the receiver binds to 127.0.0.1 only. Opening it to the LAN means anyone on the LAN can send packets; the token is a shared secret (not encryption), so use it on your own trusted LAN only. Each packet is timestamped when received. The dashboard itself stays on localhost.

## Autostart on a Pi
See `wallhack.service` in this folder.
