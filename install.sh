#!/usr/bin/env bash
# One-step install for Linux, Raspberry Pi OS and macOS.
set -e
cd "$(dirname "$0")"

PI_CSI=0
SENSORS=0
for arg in "$@"; do
  case "$arg" in
    --pi-csi) PI_CSI=1 ;;
    --sensors) SENSORS=1 ;;
    -h|--help)
      echo "Usage: ./install.sh [--pi-csi] [--sensors]"
      echo "  --pi-csi   after installing, run the read-only Raspberry Pi CSI preflight"
      echo "             (scripts/pi_setup.sh check). It does not change the WiFi firmware."
      echo "  --sensors  also install pyserial and smbus2 for the optional air-quality sensors"
      exit 0 ;;
    *) echo "Unknown option: $arg (try --help)"; exit 1 ;;
  esac
done

PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
    PY="$c"; break
  fi
done
if [ -z "$PY" ]; then
  echo "Python 3.9 or newer is required."
  echo "  Debian/Raspberry Pi OS: sudo apt install python3 python3-venv python3-pip"
  echo "  macOS: brew install python  (or https://www.python.org/downloads/)"
  exit 1
fi

if ! "$PY" -m venv .venv; then
  echo "Could not create a virtual environment."
  echo "  Debian/Raspberry Pi OS: sudo apt install python3-venv   then run ./install.sh again"
  rm -rf .venv
  exit 1
fi

.venv/bin/python -m pip install --upgrade pip >/dev/null
.venv/bin/python -m pip install -r requirements.txt
if [ "$SENSORS" -eq 1 ]; then
  .venv/bin/python -m pip install "pyserial>=3.5" "smbus2>=0.4"
fi
echo
echo "Install complete. Start the dashboard with: ./run.sh"

if [ "$PI_CSI" -eq 1 ]; then
  echo
  status=0
  scripts/pi_setup.sh check || status=$?
  echo
  echo "Next, to build the real CSI firmware (replaces WiFi firmware, asks first): scripts/pi_setup.sh install"
  exit "$status"
fi
