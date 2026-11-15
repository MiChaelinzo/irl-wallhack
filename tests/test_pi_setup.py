"""Tests for scripts/pi_setup.sh and docs/wallhack.service.

Nothing here touches a Raspberry Pi: the model comes from a fake file and the
system-changing commands are only ever printed (--dry-run).
"""
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "pi_setup.sh"
BASH = shutil.which("bash")

pytestmark = pytest.mark.skipif(BASH is None, reason="bash is not installed")


def sh(*args, model=None, tmp_path=None, stdin=subprocess.DEVNULL):
    env = {"PATH": "/usr/bin:/bin:/usr/local/bin", "HOME": str(tmp_path or "/tmp")}
    if model is not None:
        model_file = tmp_path / "model"
        model_file.write_text(model + "\0")
        env["WALLHACK_PI_MODEL_FILE"] = str(model_file)
    return subprocess.run([BASH, str(SCRIPT), *args], capture_output=True, text=True,
                          env=env, stdin=stdin, timeout=60)


def test_shell_syntax():
    for path in (SCRIPT, ROOT / "install.sh"):
        assert subprocess.run([BASH, "-n", str(path)]).returncode == 0


def test_help_exits_zero():
    result = sh("help")
    assert result.returncode == 0
    assert "--dry-run" in result.stdout


def test_check_pi4_passes_model_line(tmp_path):
    out = sh("check", "--build-dir", str(tmp_path / "b"), model="Raspberry Pi 4 Model B Rev 1.4", tmp_path=tmp_path).stdout
    assert "PASS  Board: Raspberry Pi 4 Model B" in out


def test_check_pi5_warns(tmp_path):
    out = sh("check", "--build-dir", str(tmp_path / "b"), model="Raspberry Pi 5 Model B", tmp_path=tmp_path).stdout
    assert "WARN  Board" in out and "Pi 5" in out


def test_check_other_board_fails(tmp_path):
    result = sh("check", "--build-dir", str(tmp_path / "b"), model="Some Other Board", tmp_path=tmp_path)
    assert result.returncode == 1
    assert "FAIL  Board" in result.stdout


def test_install_dry_run_prints_steps_and_changes_nothing(tmp_path):
    build = tmp_path / "build"
    result = sh("install", "--dry-run", "--yes", "--iface", "lo", "--build-dir", str(build),
                model="Raspberry Pi 4 Model B Rev 1.4", tmp_path=tmp_path)
    assert result.returncode == 0, result.stderr
    for expected in (
        "git clone --depth=1 https://github.com/seemoo-lab/nexmon.git",
        "git clone --depth=1 https://github.com/seemoo-lab/nexmon_csi.git",
        "make -f Makefile.rpi install-firmware",
        "make -f Makefile.rpi reload-full",
        "USE_VENDOR_CMD=1",
        "INSTALLED_VERSIONS",
    ):
        assert expected in result.stdout
    assert not build.exists()


def test_restore_dry_run_prints_restore_wifi(tmp_path):
    result = sh("restore", "--dry-run", "--yes", "--build-dir", str(tmp_path / "b"), tmp_path=tmp_path)
    assert result.returncode == 0
    assert "restore-wifi" in result.stdout


def test_install_refuses_without_confirmation(tmp_path):
    build = tmp_path / "build"
    result = sh("install", "--force", "--iface", "lo", "--build-dir", str(build),
                model="Raspberry Pi 4 Model B", tmp_path=tmp_path)
    assert result.returncode == 1
    assert "Aborted" in result.stderr
    assert not build.exists()


def test_service_file_is_csi_capable():
    text = (ROOT / "docs" / "wallhack.service").read_text()
    assert "--csi-source nexmon" in text
    assert "AmbientCapabilities=CAP_NET_RAW" in text
    assert "User=pi" not in text


def test_install_sh_rejects_unknown_option():
    result = subprocess.run([BASH, str(ROOT / "install.sh"), "--nope"], capture_output=True, text=True)
    assert result.returncode == 1
