#!/usr/bin/env bash
# One-step install for Linux, Raspberry Pi OS and macOS.
set -e
cd "$(dirname "$0")"

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
echo
echo "Install complete. Start the dashboard with: ./run.sh"
