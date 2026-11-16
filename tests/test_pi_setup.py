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


def sh(*args, model=None, tmp_path=None, stdin=subprocess.DEVNULL, path_prefix=""):
    env = {"PATH": path_prefix + "/usr/bin:/bin:/usr/local/bin", "HOME": str(tmp_path or "/tmp")}
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
    assert "make -f Makefile.rpi restore-wifi" in result.stdout


def test_upstream_restore_wifi_target_is_documented_as_checked():
    # Makefile.rpi on seemoo-lab/nexmon_csi master defines `restore-wifi:` (checked when this was written).
    assert "restore-wifi" in SCRIPT.read_text()


def shim_dir(tmp_path, names):
    """Fake executables that log their name and fail, to prove they are never called."""
    bin_dir = tmp_path / "shims"
    bin_dir.mkdir()
    log = tmp_path / "shim.log"
    for name in names:
        path = bin_dir / name
        path.write_text('#!/bin/sh\necho "%s $*" >> "%s"\nexit 1\n' % (name, log))
        path.chmod(0o755)
    return str(bin_dir) + ":", log


SYSTEM_COMMANDS = ("sudo", "apt", "dpkg", "make", "git", "setcap", "nexutil", "pkill", "ifconfig", "systemctl", "tee")
PI4 = "Raspberry Pi 4 Model B Rev 1.4"


@pytest.mark.parametrize("command,extra", [
    ("install", []), ("start", ["--channel", "36/20"]), ("restore", [])])
def test_dry_run_executes_no_system_command(tmp_path, command, extra):
    prefix, log = shim_dir(tmp_path, SYSTEM_COMMANDS)
    result = sh(command, "--dry-run", "--yes", "--iface", "lo", "--build-dir", str(tmp_path / "b"), *extra,
                model=PI4, tmp_path=tmp_path, path_prefix=prefix)
    assert result.returncode == 0, result.stderr
    assert not log.exists(), log.read_text()


def test_start_dry_run_prints_capture_setup_with_beacon_filter(tmp_path):
    result = sh("start", "--dry-run", "--yes", "--iface", "lo", "--channel", "36/20",
                "--build-dir", str(tmp_path / "b"), model=PI4, tmp_path=tmp_path)
    assert result.returncode == 0, result.stderr
    out = result.stdout
    assert "makecsiparams -c 36/20 -C 1 -N 1 -b 0x80" in result.stderr + out
    assert "nexutil -Ilo -m1" in out
    assert "-l34" in out
    assert "setcap cap_net_raw" not in out  # --yes alone never grants tcpdump capabilities


def test_start_dry_run_mac_filter_and_tcpdump_flag(tmp_path):
    result = sh("start", "--dry-run", "--yes", "--iface", "lo", "--channel", "36/20", "--mac", "aa:bb:cc:dd:ee:ff",
                "--grant-tcpdump-caps", "--build-dir", str(tmp_path / "b"), model=PI4, tmp_path=tmp_path)
    assert result.returncode == 0, result.stderr
    assert "-m aa:bb:cc:dd:ee:ff" in result.stderr + result.stdout
    assert "setcap cap_net_raw,cap_net_admin=eip" in result.stdout


@pytest.mark.parametrize("args", [["--channel", "36"], ["--channel", "36/20", "--mac", "nonsense"]])
def test_start_rejects_bad_channel_or_mac(tmp_path, args):
    result = sh("start", "--dry-run", "--yes", "--iface", "lo", *args, "--build-dir", str(tmp_path / "b"),
                model=PI4, tmp_path=tmp_path)
    assert result.returncode == 1


def test_status_reports_state_without_changing_anything(tmp_path):
    build = tmp_path / "b"
    build.mkdir()
    (build / "state").write_text("installed\nsetcap /usr/bin/nexutil\n")
    prefix, log = shim_dir(tmp_path, ("sudo", "apt", "make", "git", "setcap", "nexutil", "tcpdump"))
    result = sh("status", "--build-dir", str(build), "--iface", "lo", model=PI4, tmp_path=tmp_path, path_prefix=prefix)
    assert result.returncode == 0, result.stderr
    assert "installed" in result.stdout and "setcap /usr/bin/nexutil" in result.stdout
    assert "No CSI frames seen" in result.stdout
    called = log.read_text().split() if log.exists() else []
    assert "sudo" not in called and "apt" not in called and "setcap" not in called


def test_status_without_install_says_so(tmp_path):
    result = sh("status", "--build-dir", str(tmp_path / "b"), tmp_path=tmp_path)
    assert "not installed by this script" in result.stdout


def test_yes_never_allows_archived_python27(tmp_path):
    # Fake apt-cache: python2.7 has no candidate, so the unauthenticated fallback is reached.
    prefix, log = shim_dir(tmp_path, ())
    fake = tmp_path / "shims" / "apt-cache"
    fake.write_text("#!/bin/sh\necho '  Candidate: (none)'\n")
    fake.chmod(0o755)
    stub_dir = tmp_path / "shims"
    for name in ("sudo",):
        (stub_dir / name).write_text('#!/bin/sh\nexec "$@"\n')
        (stub_dir / name).chmod(0o755)
    for name in ("apt", "dpkg", "make", "git", "setcap"):
        (stub_dir / name).write_text("#!/bin/sh\nexit 0\n")
        (stub_dir / name).chmod(0o755)
    result = sh("install", "--yes", "--force", "--iface", "lo", "--build-dir", str(tmp_path / "b"),
                model=PI4, tmp_path=tmp_path, path_prefix=prefix)
    assert result.returncode == 1
    assert "allow-archived-python27" in result.stderr
    assert not (tmp_path / "b" / "nexmon").exists()


def test_install_consent_text_discloses_upgrade_and_persistent_changes(tmp_path):
    out = sh("install", "--dry-run", "--yes", "--iface", "lo", "--build-dir", str(tmp_path / "b"),
             model=PI4, tmp_path=tmp_path).stdout
    for expected in ("apt full-upgrade", "armhf", "symlinks", "setcap", "--allow-archived-python27"):
        assert expected in out


def test_restore_dry_run_removes_recorded_setcap_and_lists_remaining(tmp_path):
    build = tmp_path / "b"
    build.mkdir()
    (build / "state").write_text(
        "installed\nsetcap /usr/bin/nexutil\narch armhf\nsymlink /usr/lib/arm-linux-gnueabihf/libisl.so.10\n")
    result = sh("restore", "--dry-run", "--yes", "--build-dir", str(build), tmp_path=tmp_path)
    assert result.returncode == 0, result.stderr
    out = result.stdout
    assert "setcap -r /usr/bin/nexutil" in out or "Skipping /usr/bin/nexutil" in out
    assert "rm -f /usr/lib/arm-linux-gnueabihf/libisl.so.10" in out
    assert "dpkg --remove-architecture armhf" in out
    assert "apt full-upgrade" in out


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
