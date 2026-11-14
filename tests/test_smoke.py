import json
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

import pytest
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


@pytest.fixture
def live_server():
    """A real `python -m wallhack` process (real uvicorn). Yields (port, base_url)."""
    port = _free_port()
    proc = subprocess.Popen(
        [sys.executable, "-m", "wallhack", "--source", "simulator", "--port", str(port)],
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    base = f"http://127.0.0.1:{port}"
    try:
        deadline = time.time() + 20
        while time.time() < deadline:
            if proc.poll() is not None:
                raise AssertionError("server exited early")
            try:
                urllib.request.urlopen(base + "/api/status", timeout=2).close()
                break
            except OSError:
                time.sleep(0.3)
        else:
            raise AssertionError("server did not start")
        yield port, base
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


def test_real_uvicorn_websocket(live_server):
    """Regression: uvicorn without a websocket library refuses /ws on a real server."""
    from websockets.sync.client import connect
    port, _ = live_server
    with connect(f"ws://127.0.0.1:{port}/ws", open_timeout=10) as ws:
        msg = json.loads(ws.recv(timeout=10))
    assert msg["status"]["source"] == "simulator" and "zones" in msg


def test_real_uvicorn_rejects_cross_origin_websocket_and_foreign_host(live_server):
    from websockets.exceptions import InvalidStatus
    from websockets.sync.client import connect
    port, base = live_server
    with pytest.raises((InvalidStatus, ConnectionError, OSError)):
        with connect(f"ws://127.0.0.1:{port}/ws", origin="http://evil.example", open_timeout=10) as ws:
            ws.recv(timeout=5)
    req = urllib.request.Request(base + "/api/status", headers={"Host": "evil.example"})
    with pytest.raises(urllib.error.HTTPError) as exc:
        urllib.request.urlopen(req, timeout=5)
    assert exc.value.code == 400


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


def test_requirements_split():
    runtime = (ROOT / "requirements.txt").read_text()
    dev = (ROOT / "requirements-dev.txt").read_text()
    assert "uvicorn[standard]" in runtime
    assert "pytest" not in runtime and "httpx" not in runtime
    assert "-r requirements.txt" in dev and "pytest" in dev and "httpx" in dev
