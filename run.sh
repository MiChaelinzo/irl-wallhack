#!/usr/bin/env bash
# Start Wallhack. Extra arguments are passed through, e.g. ./run.sh --source simulator --port 8080
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  echo "Not installed yet. Run ./install.sh first."
  exit 1
fi
exec .venv/bin/python -m wallhack --open "$@"
