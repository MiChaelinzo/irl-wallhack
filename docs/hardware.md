# Hardware notes

Wallhack works without hardware: with no usable WiFi source it runs a seeded simulator.
Everything below is UNVERIFIED on real devices. Parsers are tested on fixture text and the UDP receiver over a local socket.

## What it can and cannot do
RSSI and CSI changes reveal presence, motion, breathing rate (0.1-0.5 Hz, needs a still person, good signal and CSI-rate data: 4+ unrounded readings per second; disabled automatically for Windows, macOS and nmcli data) and a coarse zone. It cannot make images or show people through walls like a camera.

## Data sources
- **Linux / Raspberry Pi 4**: reads signal strength from `iw` / `nmcli` (`--interface wlan0`). Plain RSSI is coarse; presence and motion work best with a stable link.
- **Windows 11**: reads `netsh wlan show interfaces`. Updates about once per second. Parsing does not depend on the Windows display language (tested on hand-written German and Spanish fixtures, not real captures).
- **macOS**: reads `system_profiler` (about every second or slower). Newer macOS versions may hide details without extra permissions.
- **Any OS, fallback**: `--ping-target 192.168.x.1` measures latency to your own router (private IPs only).

## Raspberry Pi 4 real CSI (nexmon_csi)
**UNVERIFIED on hardware.** The steps below follow the upstream [nexmon_csi](https://github.com/seemoo-lab/nexmon_csi) recipe ([discussion #395](https://github.com/seemoo-lab/nexmon_csi/discussions/395)). The script was tested only with `--dry-run` and a fake model file, and decoding only on synthetic frames. No Pi 4 was available to run it.

### What to buy
- Raspberry Pi 4 Model B, quality microSD card, official power supply.
- Ethernet cable and a free router port, or a USB WiFi adapter the stock kernel supports. CSI mode takes over the Pi's own WiFi (`wlan0`), so the Pi needs another way to be reachable.
- Optional: a second Pi, ESP32 or phone generating traffic, to raise the packet rate.
- Optional alternative route: an ESP32-S3 or C6 running Espressif's [esp-csi](https://github.com/espressif/esp-csi), see the ESP32 section below. [RuView](https://github.com/ruvnet/RuView) (MIT licence, by ruvnet) is a separate project that targets these boards; Wallhack does not include or depend on it.

### Steps
```
./install.sh --pi-csi                   # installs Wallhack, then a read-only preflight
scripts/pi_setup.sh install --dry-run   # optional: see every command first
scripts/pi_setup.sh install             # builds nexmon + nexmon_csi, replaces WiFi firmware (asks first)
scripts/pi_setup.sh start               # asks for your router's channel/width, enables CSI + monitor mode
.venv/bin/python -m wallhack --source real --csi-source nexmon --interface wlan0 --csi-check 10
.venv/bin/python -m wallhack --source real --csi-source nexmon --interface wlan0
scripts/pi_setup.sh restore             # back to normal WiFi
```
Everything is downloaded into `~/.local/share/wallhack/nexmon` (never into this repository); the commit hashes built are recorded in `INSTALLED_VERSIONS` there. `scripts/pi_setup.sh status` shows the active firmware and whether frames arrive. Options: `--dry-run`, `--yes`, `--force`, `--channel 36/20`, `--mac aa:bb:cc:dd:ee:ff`, `--iface`, `--build-dir`.

### What install changes, and what restore undoes
`install` follows upstream and runs `apt full-upgrade` (all packages, possibly the kernel; the nexmon patch is kernel-sensitive). It records its persistent changes in `<build-dir>/state`.

| Change | Undone by `restore`? |
|---|---|
| Patched firmware via `update-alternatives`, `unmanage` of `wlan0` | Yes. Runs upstream `make -f Makefile.rpi restore-wifi` (target exists on nexmon_csi master: firmware alternative back to auto, `brcmfmac_cyw` reload, NetworkManager manage and connect). The module name is upstream's; on an older kernel it may differ, then use the manual steps below. |
| `setcap cap_net_admin+ep /usr/bin/nexutil`, and tcpdump `setcap` if you used `--grant-tcpdump-caps` | Yes, `setcap -r` on every path recorded in the state file |
| Library symlinks `libisl.so.10`, `libmpfr.so.4` (aarch64), only if the script created them | Offered; removed if you agree |
| `dpkg --add-architecture armhf` and the armhf packages | No. `restore` prints the commands to remove them |
| `apt full-upgrade`, build packages, the build directory | No |

tcpdump is not given file capabilities unless you pass `--grant-tcpdump-caps` (`--yes` does not imply it). Prefer `docs/wallhack.service`, which grants capabilities to a dedicated user only.

If `python2.7` is missing from apt, upstream adds the archived Debian stretch repository, which is unauthenticated and end of life. `install` stops there unless you pass `--allow-archived-python27` or type the requested phrase; `--yes` never allows it. Installing python2.7 yourself avoids the question.

Manual restore without the checkout: `sudo update-alternatives --auto cyfmac43455-sdio.bin`, reload the driver (`sudo modprobe -r brcmfmac_cyw && sudo modprobe brcmfmac_cyw`), then `sudo nmcli dev set wlan0 managed yes && sudo nmcli radio wifi on && sudo nmcli dev connect wlan0`.

### Format and channel
The BCM43455c0 chip in the Pi 4 stores CSI as interleaved int16 real/imag pairs (as in upstream `csireader.m`); `wallhack/nexmon.py` decodes that. Frames arrive as UDP packets to port 5500 on `wlan0` and are read through `tcpdump`. The channel and bandwidth must match your router. By default CSI is taken from the router's beacons (about 10 per second), enough for the 4 Hz breathing gate. A second device sending traffic and `--mac` for its address raises the rate.

### Kernel caveat
The `Makefile.rpi` flow targets recent Raspberry Pi OS, but upstream reports problems on very new kernels such as 6.12 (see discussion #395). The script prints a WARN for kernels it has not been tested on, which is every kernel.

### Troubleshooting
| Symptom | Likely cause and fix |
|---|---|
| `--csi-check` sees no frames | Wrong channel (must match router), `start` not run, or tcpdump lacks permission. Run `scripts/pi_setup.sh status`. |
| Under 4 Hz | Beacons only give about 10 per second and some are missed. Use `--mac` of a device sending traffic. Breathing stays off below 4 Hz. |
| `wlan0` or SSH lost | Expected when WiFi was your link. Use Ethernet, then `scripts/pi_setup.sh restore`. |
| tcpdump permission denied | Use `docs/wallhack.service`, which grants capabilities, or run `start` with `--grant-tcpdump-caps` (any local user can then capture; `restore` removes it). |
| Build fails | Check the kernel caveat and the upstream discussion; run `restore` before trying again. |

## What this can and cannot see
CSI can reveal presence, motion, breathing (a still person with strong signal) and, with several links, a coarse zone. News stories and papers that show silhouettes through walls use special radio hardware, trained models and controlled rooms. This project does no imaging. RuView's own README reports low accuracy for camera-free pose on live hardware. Expect "someone is here and moving", not a picture.

## ESP32 CSI over UDP (optional)
Flash an ESP32 with CSI firmware (for example Espressif's esp-csi) and have it send one JSON datagram per packet to the machine running Wallhack:

```json
{"link": "esp32-1", "rssi": -52, "csi": [i0, q0, i1, q1]}
```

`csi` is interleaved I/Q integers. Start with `python -m wallhack --udp-port 5005 --udp-host 0.0.0.0 --udp-token YOUR_SECRET` and add `"token": "YOUR_SECRET"` to each packet. By default the receiver binds to 127.0.0.1 only. Opening it to the LAN means anyone on the LAN can send packets; the token is a shared secret (not encryption), so use it on your own trusted LAN only. Each packet is timestamped when received. The dashboard itself stays on localhost.

## Autostart on a Pi
See `wallhack.service` in this folder.
