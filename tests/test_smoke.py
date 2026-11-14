import json
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_install_scripts_exist():
    for name in ("install.sh", "run.sh", "install.ps1", "install.bat", "run.bat"):
        assert (ROOT / name).is_file(), name


def test_shell_scripts_have_valid_syntax():
    for name in ("install.sh", "run.sh"):
        r = subprocess.run(["bash", "-n", str(ROOT / name)], capture_output=True, text=True)
        assert r.returncode == 0, r.stderr


def test_server_starts_and_serves_dashboard():
    port = _free_port()
    proc = subprocess.Popen(
        [sys.executable, "-m", "wallhack", "--source", "simulator", "--port", str(port)],
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    base = f"http://127.0.0.1:{port}"
    try:
        status = None
        deadline = time.time() + 20
        while time.time() < deadline:
            if proc.poll() is not None:
                raise AssertionError("server exited early")
            try:
                with urllib.request.urlopen(base + "/api/status", timeout=2) as r:
                    status = json.loads(r.read())
                break
            except OSError:
                time.sleep(0.3)
        assert isinstance(status, dict), "no status response"
        with urllib.request.urlopen(base + "/", timeout=5) as r:
            assert b"<html" in r.read().lower()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
