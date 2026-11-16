# Hardware notes

Wallhack works without hardware: with no usable WiFi source it runs a seeded simulator.
Everything below is UNVERIFIED on real devices. Parsers are tested on fixture text and the UDP receiver over a local socket.

## What it can and cannot do
RSSI and CSI changes reveal presence, motion, activity, breathing rate (0.1-0.5 Hz, needs a still person, good signal and CSI-rate data: 4+ unrounded readings per second; disabled automatically for Windows, macOS and nmcli data) and a coarse zone. It cannot make images or show people through walls like a camera.

## Data sources
- **Linux / Raspberry Pi 4**: reads signal strength from `iw` / `nmcli` (`--interface wlan0`). Plain RSSI is coarse; presence and motion work best with a stable link.
- **Windows 11**: reads `netsh wlan show interfaces`. Updates about once per second. Parsing does not depend on the Windows display language (tested on hand-written German and Spanish fixtures, not real captures).
- **macOS**: reads `system_profiler` (about every second or slower). Newer macOS versions may hide details without extra permissions.
- **Any OS, fallback**: `--ping-target 192.168.x.1` measures latency to your own router (private IPs only).

## Environment and vital sensors
**Everything in this section is UNVERIFIED on hardware.** Parsers are tested on hand-built frames and drivers on fake transports. Sensors are optional; without `--sensors` the dashboard shows "no sensor" tiles.

### Parts
| Part | Measures | Bus | Notes |
|---|---|---|---|
| Sensirion SCD41 (or SCD40) | CO2 ppm, temperature, humidity | I2C 0x62 | Reading about every 5 s. Self-calibration needs fresh air now and then. |
| Plantower PMS5003 | PM1.0, PM2.5, PM10 (atmospheric values) | UART 9600 | Has a fan. Allow about 30 s of warm-up. |
| ScioSense ENS160 | TVOC ppb (also eCO2 and AQI on the chip) | I2C 0x52 or 0x53 | eCO2 is an estimate from VOCs, not a CO2 measurement. The datasheet asks for a long first-use burn-in. |
| Winsen ZE08-CH2O | Formaldehyde ppb | UART 9600 | Electrochemical; warm-up of several minutes and drift over its life. |
| Melexis MLX90614 | Infrared surface temperature | I2C 0x5A | Surface temperature of what it points at, not clinical body temperature. |

### Wiring (Raspberry Pi 4, 40-pin header)
I2C devices share bus 1 (`--i2c-bus 1`):

| Sensor pin | Pi pin |
|---|---|
| VCC | pin 1 (3V3) |
| GND | pin 6 (GND) |
| SDA | pin 3 (GPIO2) |
| SCL | pin 5 (GPIO3) |

Enable I2C with `sudo raspi-config` (Interface Options, I2C), then check with `sudo apt install i2c-tools && i2cdetect -y 1`. Expected addresses: SCD4x `0x62`, ENS160 `0x52` or `0x53`, MLX90614 `0x5A`. Use 3.3 V breakout boards (or ones with their own level shifting). A bare 5 V I2C sensor must not be wired straight to the Pi.

UART sensors are read only. Wallhack never writes to them, so connect just the sensor's TX to the Pi's RX and share ground. Both parts send 3.3 V logic. The PMS5003 and ZE08-CH2O fans/cells are powered from 5 V (Pi pin 2 or 4), but the data line stays 3.3 V. Check your module's datasheet before powering it; if a module has 5 V logic, use a level shifter.

| Sensor | Sensor pin | Pi pin / device |
|---|---|---|
| PMS5003 | VCC (5 V), GND, TXD | pin 2, pin 14, pin 10 (GPIO15 RXD0) -> `/dev/serial0` (default `--pms-port`) |
| ZE08-CH2O | Vin (5 V), GND, TXD | via a USB-TTL adapter -> `/dev/ttyUSB0` (default `--hcho-port`) |

The Pi 4 has one easy hardware UART on pins 8/10. To use it, run `sudo raspi-config`, Interface Options, Serial Port: answer **No** to a login shell over serial and **Yes** to the serial port hardware. The second UART sensor is simplest on a USB-TTL adapter. Alternatively enable another Pi 4 UART in `/boot/firmware/config.txt` (`/boot/config.txt` on older images):
```
dtoverlay=uart3      # RX on GPIO5 (pin 29), TX on GPIO4 (pin 7)
```
Reboot, then run `ls /dev/ttyAMA*` to see the new device (often `/dev/ttyAMA1`, but check) and pass it as `--hcho-port`. Other overlays on Pi 4: `uart4` (GPIO9 RX pin 21), `uart5` (GPIO13 RX pin 33). Avoid `uart2` (GPIO0/1 are the HAT ID pins).

### Install and run
```
./install.sh --sensors      # pyserial and smbus2 are optional extras
sudo usermod -aG dialout,i2c $USER     # then log out and in; needed for /dev/ttyUSB0 and /dev/i2c-1
.venv/bin/python -m wallhack --sensors pms5003,scd4x,ens160,ze08,mlx90614 --pms-port /dev/serial0 --hcho-port /dev/ttyUSB0 --i2c-bus 1
```
For `docs/wallhack.service` add `SupplementaryGroups=dialout i2c` to the `[Service]` section. Env vars: `WALLHACK_SENSORS`, `WALLHACK_SERIAL_PMS`, `WALLHACK_SERIAL_HCHO`, `WALLHACK_I2C_BUS`.

### What the numbers mean
- **AQI**: US EPA index from PM2.5 (2024 breakpoints) and PM10, whichever is worse. It needs PM data.
- **Ratings** (good / fair / poor / bad) are guidance bands, not medical advice: CO2 (1000 and 2000 ppm, Umweltbundesamt), TVOC (ScioSense UBA levels), HCHO (WHO 30 min guideline), humidity (comfort band 30-60 %). The overall rating is the worst of its parts and lists the drivers.
- **Heat index** is shown only when it applies (80 F and 40 % RH or more); **dew point** uses the Magnus formula.
- **Surface temperature** depends on distance, emissivity and ambient temperature. Do not use it as a fever check.
- Sensor self-heating can raise SCD4x readings if mounted near the Pi; keep a few centimetres away from the CPU.

### Heart rate over WiFi: limits
Heart rate needs CSI at 8 Hz or more (not quantised), a still person and good signal; the amplitude is tiny. Wallhack gates it on those conditions and a strong spectral peak (peak ratio 30). It is experimental, UNVERIFIED on real CSI, and not a medical measurement. The simulator's heartbeat is exaggerated and marked SIMULATED. The walking-cadence rule for the activity badge is also only tried on the simulator.

### Not built
- **Mood / emotion**: no established way to infer it from WiFi.
- **Perspiration**: no WiFi or listed-sensor method.
- **Through-wall sights / images**: not possible here. The 3D view is a schematic signal-activity visualisation with schematic positions.
- **Thermal array image** (MLX90640, AMG8833): would need an image driver and a camera-like view; possible future optional hardware, not implemented.

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
