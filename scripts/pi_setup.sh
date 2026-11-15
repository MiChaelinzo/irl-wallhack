#!/usr/bin/env bash
# Raspberry Pi 4 Model B: build and use nexmon_csi so Wallhack can read real CSI.
#
# UNVERIFIED on hardware. Written from the upstream nexmon_csi recipe
# (https://github.com/seemoo-lab/nexmon_csi/discussions/395) and tested only
# through --dry-run and a fake model file. Nothing from nexmon is stored in
# this repository; `install` downloads it into --build-dir on the Pi.
#
# Only `install`, `start` and `restore` change the system, and each one asks
# for confirmation unless --yes is given. Every state-changing command goes
# through run() or capture(), which print the command and execute nothing
# under --dry-run.
#
# Persistent grants and changes this script makes are recorded in
# <build-dir>/state (installed, setcap <path>, arch armhf, symlink <path>) so
# that `restore` can undo them or tell you what remains. Upstream's
# `make -f Makefile.rpi restore-wifi` target (checked against upstream master)
# only restores the firmware alternative, the driver and NetworkManager.
set -euo pipefail

NEXMON_URL="https://github.com/seemoo-lab/nexmon.git"
NEXMON_CSI_URL="https://github.com/seemoo-lab/nexmon_csi.git"
CSI_PATCH_SUBDIR="patches/bcm43455c0/7_45_189"
NEXUTIL_PATH="/usr/bin/nexutil"
FIRMWARE_ALTERNATIVE="cyfmac43455-sdio.bin"
CSI_UDP_PORT=5500
BEACON_FIRST_BYTE="0x80"
CSI_PACKET_COUNT=500
CSI_HEADER_LEN=34
MIN_FREE_GB=3
WARN_KERNEL_FROM="6.12"
STATUS_CAPTURE_SECONDS=3
DEFAULT_BUILD_DIR="$HOME/.local/share/wallhack/nexmon"
STRETCH_LIST="/etc/apt/sources.list.d/wallhack-stretch-python27.list"
STRETCH_LINE="deb http://archive.debian.org/debian stretch main"

DRY_RUN=0
YES=0
FORCE=0
IFACE="wlan0"
CHANNEL=""
MAC_FILTER=""
CORE_MASK=1
STREAM_MASK=1
BUILD_DIR="$DEFAULT_BUILD_DIR"
FAILS=0
ALLOW_ARCHIVED_PY27=0
GRANT_TCPDUMP_CAPS=0

SUDO="sudo"
if [ "$(id -u)" -eq 0 ]; then SUDO=""; fi

usage() {
  cat <<EOF
Usage: scripts/pi_setup.sh <command> [options]

Commands:
  check     Read-only preflight (model, kernel, interface, route, tools, disk).
  install   Build nexmon + nexmon_csi and install the patched WiFi firmware.
            WiFi on the interface stops working normally until 'restore'.
  start     Configure CSI capture and monitor mode (needs 'install' first).
  status    Show state, active firmware and whether CSI frames arrive.
  stop      Same as restore.
  restore   Put the stock WiFi firmware and network management back.
  help      This text.

Options:
  --dry-run          Print every state-changing command with a '+' prefix, run none.
  --yes              Do not ask for confirmation.
  --force            Continue past preflight FAILs (you accept losing SSH/WiFi).
  --allow-archived-python27
                     For install: permit the unauthenticated archived Debian stretch
                     repo as a fallback source for python2.7. --yes never allows this.
  --grant-tcpdump-caps
                     For start: setcap cap_net_raw,cap_net_admin on the system tcpdump
                     (any local user could then capture). --yes does not imply it.
  --iface NAME       WiFi interface (default wlan0).
  --channel CH/BW    For start, e.g. 36/20. Must match your router's channel.
  --mac MAC          For start: only frames from this MAC (alias --bssid).
                     Default: beacons (first byte $BEACON_FIRST_BYTE), about 10 per second.
  --core-mask N      Antenna core mask (default 1).
  --stream-mask N    Spatial stream mask (default 1).
  --build-dir DIR    Where nexmon is built (default ~/.local/share/wallhack/nexmon).
EOF
}

# ---------- helpers ----------

# Print arguments shell-quoted only when needed, so output stays readable.
fmt_cmd() {
  local out="" a
  for a in "$@"; do
    if [[ "$a" =~ ^[A-Za-z0-9_@%+=:,./-]+$ ]]; then
      out+="$a "
    else
      out+="'${a//\'/\'\\\'\'}' "
    fi
  done
  printf '%s' "${out% }"
}

# The only way a state-changing command is executed.
run() {
  printf '+ %s\n' "$(fmt_cmd "$@")"
  if [ "$DRY_RUN" -eq 1 ]; then return 0; fi
  "$@"
}

# Like run() but returns the command's stdout. Dry-run returns a placeholder.
capture() {
  printf '+ %s\n' "$(fmt_cmd "$@")" >&2
  if [ "$DRY_RUN" -eq 1 ]; then printf '<output of %s>' "$1"; return 0; fi
  "$@"
}

# Run a command inside the nexmon build environment (setup_env.sh needs cwd = nexmon root).
run_nexmon_env() {
  local dir="$1"; shift
  run bash -c 'cd "$1" && source ./setup_env.sh >/dev/null && cd "$2" && shift 2 && "$@"' _ "$NEXMON_DIR" "$dir" "$@"
}

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s ==\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

confirm() { # y or yes
  if [ "$YES" -eq 1 ]; then return 0; fi
  local ans=""
  printf '%s [y/N] ' "$1" >&2
  read -r ans || ans=""
  [ "$ans" = "y" ] || [ "$ans" = "yes" ]
}

# Always asks, even under --yes. Used for the one step that lowers package authentication.
confirm_typed() { # $1 prompt, $2 exact word the user must type
  local ans=""
  printf '%s Type "%s" to continue: ' "$1" "$2" >&2
  read -r ans || ans=""
  [ "$ans" = "$2" ]
}

record_state() { # idempotent: append a line to the state file once
  run bash -c 'grep -qxF "$1" "$2" 2>/dev/null || printf "%s\n" "$1" >> "$2"' _ "$1" "$STATE_FILE"
}

confirm_strict() { # must type yes
  if [ "$YES" -eq 1 ]; then return 0; fi
  local ans=""
  printf '%s Type yes to continue: ' "$1" >&2
  read -r ans || ans=""
  [ "$ans" = "yes" ]
}

pass() { printf 'PASS  %s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*"; }
fail() {
  if [ "$FORCE" -eq 1 ]; then
    printf 'WARN  (forced) %s\n' "$*"
  else
    printf 'FAIL  %s\n' "$*"
    FAILS=$((FAILS + 1))
  fi
}

# ---------- preflight (read-only) ----------

preflight() {
  FAILS=0
  local model_file="${WALLHACK_PI_MODEL_FILE:-/proc/device-tree/model}"
  local model=""
  if [ -r "$model_file" ]; then model="$(tr -d '\0' < "$model_file")"; fi
  case "$model" in
    *"Raspberry Pi 4"*|*"Raspberry Pi 3 Model B Plus"*|*"Raspberry Pi 3 Model B+"*)
      pass "Board: $model" ;;
    *"Raspberry Pi 5"*)
      warn "Board: $model. This script has not been tested on a Pi 5 (BCM43455 support there is unverified)." ;;
    "")
      fail "Board: cannot read $model_file, so this is probably not a Raspberry Pi." ;;
    *)
      fail "Board: '$model' is not a Raspberry Pi 4 or 3 Model B+." ;;
  esac

  local arch kernel
  arch="$(uname -m)"
  kernel="$(uname -r)"
  pass "Architecture: $arch"
  local kmajor_minor="${kernel%%.*}.$(printf '%s' "${kernel#*.}" | cut -d. -f1)"
  if [ "$(printf '%s\n%s\n' "$WARN_KERNEL_FROM" "$kmajor_minor" | sort -V | head -n1)" = "$WARN_KERNEL_FROM" ]; then
    warn "Kernel $kernel: upstream reports problems on kernels like 6.12 (see nexmon_csi discussion #395)."
  else
    warn "Kernel $kernel: this script has not been verified on any kernel; expect to adjust."
  fi

  if [ -e "/sys/class/net/$IFACE" ]; then
    pass "Interface $IFACE exists"
  else
    fail "Interface $IFACE not found (use --iface)."
  fi

  local default_dev
  default_dev="$(ip route show default 2>/dev/null | awk '/^default/ {for (i=1;i<NF;i++) if ($i=="dev") {print $(i+1); exit}}' || true)"
  if [ "$default_dev" = "$IFACE" ]; then
    fail "$IFACE carries your default route. CSI mode takes over $IFACE, so SSH and internet over WiFi will drop. Connect Ethernet (or a second USB WiFi adapter) and make it the default route first."
  elif [ -n "$default_dev" ]; then
    pass "Default route uses $default_dev, not $IFACE"
  else
    warn "No default route found. install needs internet (Ethernet recommended)."
  fi

  local tool
  for tool in tcpdump git make python3; do
    if command -v "$tool" >/dev/null 2>&1; then pass "$tool present"; else warn "$tool missing (install will apt-install it)"; fi
  done

  local probe="$BUILD_DIR"
  while [ ! -d "$probe" ] && [ "$probe" != "/" ]; do probe="$(dirname "$probe")"; done
  local free_kb
  free_kb="$(df -Pk "$probe" | awk 'NR==2 {print $4}')"
  if [ "$free_kb" -ge $((MIN_FREE_GB * 1024 * 1024)) ]; then
    pass "Free disk at $probe: $((free_kb / 1024 / 1024)) GB"
  else
    fail "Free disk at $probe is under $MIN_FREE_GB GB."
  fi

  if [ "$(id -u)" -eq 0 ]; then
    fail "Running as root. Run as your normal user; the script uses sudo where needed."
  else
    pass "Running as non-root user"
  fi
  return 0
}

report_preflight() {
  preflight
  if [ "$FAILS" -gt 0 ]; then
    say "Preflight: $FAILS FAIL. Fix them, or pass --force if you accept the consequences."
    return 1
  fi
  say "Preflight: no FAIL."
}

# Returns normally when safe to continue; dry-run reports FAILs but continues.
require_preflight() {
  if report_preflight; then return 0; fi
  if [ "$DRY_RUN" -eq 1 ]; then
    say "(dry-run: continuing so the planned steps are shown; a real run would stop here)"
    return 0
  fi
  exit 1
}

# ---------- install ----------

paths() {
  NEXMON_DIR="$BUILD_DIR/nexmon"
  CSI_DIR="$NEXMON_DIR/$CSI_PATCH_SUBDIR/nexmon_csi"
  STATE_FILE="$BUILD_DIR/state"
  VERSIONS_FILE="$BUILD_DIR/INSTALLED_VERSIONS"
}

apt_has_candidate() {
  local c
  c="$(apt-cache policy "$1" 2>/dev/null | awk '/Candidate:/ {print $2}')"
  [ -n "$c" ] && [ "$c" != "(none)" ]
}

install_python27() {
  if apt_has_candidate python2.7; then
    run $SUDO apt install -y python2.7
    return
  fi
  say "python2.7 is not in your apt sources. The upstream workaround adds the archived Debian stretch"
  say "repository temporarily (unauthenticated, end-of-life packages) just to fetch python2.7."
  if [ "$ALLOW_ARCHIVED_PY27" -eq 1 ]; then
    say "--allow-archived-python27 given: using the archived repository."
  elif [ "$DRY_RUN" -eq 1 ]; then
    say "(dry-run: a real run needs --allow-archived-python27 or the typed confirmation; --yes is not enough)"
  elif ! confirm_typed "Add it temporarily to $STRETCH_LIST and remove it afterwards?" "install-unauthenticated"; then
    die "python2.7 is required by the nexmon b43 tool. Install it yourself, or pass --allow-archived-python27, then run install again."
  fi
  trap 'if [ "$DRY_RUN" -eq 0 ]; then $SUDO rm -f "$STRETCH_LIST"; fi' EXIT
  run bash -c 'printf "%s\n" "$1" | '"$SUDO"' tee "$2" >/dev/null' _ "$STRETCH_LINE" "$STRETCH_LIST"
  run $SUDO apt -o Acquire::Check-Valid-Until=false -o Acquire::AllowInsecureRepositories=true update
  run $SUDO apt install -y --allow-unauthenticated python2.7
  run $SUDO rm -f "$STRETCH_LIST"
  run $SUDO apt update
  trap - EXIT
}

do_install() {
  paths
  step "What will happen"
  cat <<EOF
This will:
  - download nexmon and nexmon_csi from github.com/seemoo-lab (needs internet, Ethernet recommended)
  - run 'apt full-upgrade' (as upstream does). This upgrades ALL packages, possibly the kernel, and
    cannot be undone by this script. The nexmon firmware patch is sensitive to kernel versions.
  - install build packages with apt and build the nexmon toolchain (about 3 GB, many minutes)
  - on aarch64: add the armhf dpkg architecture and two library symlinks (kept after restore)
  - grant cap_net_admin to $NEXUTIL_PATH with setcap (removed by restore)
  - replace the WiFi firmware for $IFACE using update-alternatives
After this, WiFi on $IFACE does not work normally until you run: scripts/pi_setup.sh restore
Changes are recorded in $BUILD_DIR/state. If python2.7 is not in your apt sources, install stops
and asks for a separate, typed confirmation (or --allow-archived-python27) before it touches an
unauthenticated archive.
Build directory: $BUILD_DIR
EOF
  require_preflight
  if [ "$DRY_RUN" -eq 0 ] && ! confirm_strict "Proceed?"; then
    die "Aborted. Nothing was changed."
  fi

  run mkdir -p "$BUILD_DIR"
  run touch "$STATE_FILE"

  step "1. apt update, upgrade and build dependencies"
  run $SUDO apt update
  run $SUDO apt full-upgrade -y
  run $SUDO apt install -y git libgmp3-dev gawk qpdf bison flex make autoconf libtool texinfo xxd libnl-3-dev libnl-genl-3-dev bc libssl-dev tcpdump libcap2-bin

  step "2. 32-bit libraries for the nexmon toolchain (aarch64 only)"
  if [ "$(uname -m)" = "aarch64" ]; then
    run $SUDO bash -c 'if dpkg --print-foreign-architectures | grep -qx armhf; then :; else dpkg --add-architecture armhf && echo "arch armhf" >> "$1"; fi' _ "$STATE_FILE"
    run $SUDO apt update
    run $SUDO apt install -y libc6:armhf libisl23:armhf libmpfr6:armhf libmpc3:armhf libstdc++6:armhf
    run $SUDO bash -c 'if [ ! -e "$2" ] && [ ! -L "$2" ] && [ -e "$1" ]; then ln -s "$1" "$2" && echo "symlink $2" >> "$3"; fi' _ /usr/lib/arm-linux-gnueabihf/libisl.so.23 /usr/lib/arm-linux-gnueabihf/libisl.so.10 "$STATE_FILE"
    run $SUDO bash -c 'if [ ! -e "$2" ] && [ ! -L "$2" ] && [ -e "$1" ]; then ln -s "$1" "$2" && echo "symlink $2" >> "$3"; fi' _ /usr/lib/arm-linux-gnueabihf/libmpfr.so.6 /usr/lib/arm-linux-gnueabihf/libmpfr.so.4 "$STATE_FILE"
  else
    say "Not aarch64 ($(uname -m)); skipping armhf libraries."
  fi

  step "3. python2.7 (needed by the b43 tool)"
  install_python27

  step "4. Fetch nexmon"
  if [ -d "$NEXMON_DIR/.git" ]; then
    say "nexmon already present in $NEXMON_DIR; keeping the checked-out version."
    if [ "$YES" -eq 0 ] && [ "$DRY_RUN" -eq 0 ] && confirm "Run git pull to update it?"; then
      run git -C "$NEXMON_DIR" pull --ff-only
    fi
  else
    run git clone --depth=1 "$NEXMON_URL" "$NEXMON_DIR"
  fi

  step "5. Build nexmon"
  run bash -c 'f="$1/buildtools/b43-v3/debug/b43-beautifier"; head -n1 "$f" | grep -q "2.7$" || sed -i "1 s/\$/2.7/" "$f"' _ "$NEXMON_DIR"
  run bash -c 'cd "$1" && source ./setup_env.sh >/dev/null && make' _ "$NEXMON_DIR"

  step "6. Build and install nexutil"
  run bash -c 'cd "$1" && source ./setup_env.sh >/dev/null && cd utilities/nexutil && '"${SUDO:+$SUDO -E }"'make install USE_VENDOR_CMD=1' _ "$NEXMON_DIR"
  run $SUDO setcap cap_net_admin+ep "$NEXUTIL_PATH"
  record_state "setcap $NEXUTIL_PATH"

  step "7. Fetch nexmon_csi"
  if [ -d "$CSI_DIR/.git" ]; then
    say "nexmon_csi already present in $CSI_DIR; keeping the checked-out version."
  else
    run git clone --depth=1 "$NEXMON_CSI_URL" "$CSI_DIR"
  fi

  step "8. Install patched firmware (WiFi on $IFACE changes here)"
  run_nexmon_env "$CSI_DIR" make -f Makefile.rpi install-firmware
  run_nexmon_env "$CSI_DIR" make -f Makefile.rpi unmanage
  run_nexmon_env "$CSI_DIR" make -f Makefile.rpi reload-full

  step "9. Build makecsiparams"
  run_nexmon_env "$CSI_DIR/utils/makecsiparams" make

  step "10. Record installed versions and state"
  run bash -c 'printf "nexmon %s\nnexmon_csi %s\n" "$(git -C "$1" rev-parse HEAD)" "$(git -C "$2" rev-parse HEAD)" > "$3"' _ "$NEXMON_DIR" "$CSI_DIR" "$VERSIONS_FILE"
  record_state "installed"
  run bash -c 'printf "installed_at %s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$1"' _ "$STATE_FILE"
  say
  say "Done. Next: scripts/pi_setup.sh start"
  say "Undo any time: scripts/pi_setup.sh restore"
}

# ---------- start ----------

prompt_channel() {
  if [ -n "$CHANNEL" ]; then return; fi
  say "Pick the channel and bandwidth of YOUR router (20 MHz recommended). To see channels:"
  say "  iw dev $IFACE scan | grep -E 'freq|SSID'   (freq 2412 = ch 1, 5180 = ch 36)"
  printf 'Channel/bandwidth, e.g. 36/20: ' >&2
  read -r CHANNEL || CHANNEL=""
  [ -n "$CHANNEL" ] || die "No channel given. Pass --channel CH/BW."
}

do_start() {
  paths
  if ! grep -qx installed "$STATE_FILE" 2>/dev/null; then
    if [ "$DRY_RUN" -eq 1 ]; then
      warn "No install state at $STATE_FILE (a real start would refuse)."
    else
      die "No install state at $STATE_FILE. Run: scripts/pi_setup.sh install"
    fi
  fi
  require_preflight
  prompt_channel
  [[ "$CHANNEL" =~ ^[0-9]+/(20|40|80)$ ]] || die "Channel must look like 36/20 (channel/bandwidth 20, 40 or 80)."

  local filter=(-b "$BEACON_FIRST_BYTE")
  if [ -n "$MAC_FILTER" ]; then
    [[ "$MAC_FILTER" =~ ^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$ ]] || die "--mac must look like aa:bb:cc:dd:ee:ff."
    filter=(-m "$MAC_FILTER")
  fi

  say "This stops wpa_supplicant (WiFi client) and puts $IFACE in monitor mode."
  if ! confirm "Continue?"; then die "Aborted. Nothing was changed."; fi

  run $SUDO pkill wpa_supplicant || true
  run $SUDO ifconfig "$IFACE" up
  local params
  params="$(capture "$CSI_DIR/utils/makecsiparams/makecsiparams" -c "$CHANNEL" -C "$CORE_MASK" -N "$STREAM_MASK" "${filter[@]}")"
  run nexutil "-I$IFACE" "-s$CSI_PACKET_COUNT" -b "-l$CSI_HEADER_LEN" "-v$params"
  run nexutil "-I$IFACE" -m1

  local tcpdump_bin
  tcpdump_bin="$(readlink -f "$(command -v tcpdump 2>/dev/null || echo /usr/bin/tcpdump)")"
  say
  say "tcpdump needs CAP_NET_RAW to read $IFACE as a normal user. Preferred: run Wallhack through the"
  say "systemd unit in docs/wallhack.service, which grants it to a dedicated user only."
  local grant=0
  if [ "$GRANT_TCPDUMP_CAPS" -eq 1 ]; then
    grant=1
  elif [ "$YES" -eq 0 ] && confirm "Instead grant it with setcap on $tcpdump_bin? Any local user could then capture traffic. 'restore' removes it."; then
    grant=1
  fi
  if [ "$grant" -eq 1 ]; then
    run $SUDO setcap cap_net_raw,cap_net_admin=eip "$tcpdump_bin"
    record_state "setcap $tcpdump_bin"
  else
    say "Skipped setcap on tcpdump (use --grant-tcpdump-caps to do it non-interactively)."
  fi
  say
  say "Run the dashboard with real CSI:"
  say "  .venv/bin/python -m wallhack --source real --csi-source nexmon --interface $IFACE"
  say "Check that frames arrive first:"
  say "  .venv/bin/python -m wallhack --source real --csi-source nexmon --interface $IFACE --csi-check 10"
}

# ---------- restore / status ----------

# Undo what this script recorded in the state file and say what it cannot undo.
revert_recorded_changes() {
  local line path
  if [ ! -f "$STATE_FILE" ]; then
    say "No state file at $STATE_FILE: no setcap grants or symlinks recorded by this script."
    return
  fi
  while IFS= read -r line; do
    case "$line" in
      "setcap "*)
        path="${line#setcap }"
        if [ -e "$path" ]; then run $SUDO setcap -r "$path"; else say "Skipping $path (no longer exists)."; fi
        ;;
    esac
  done < "$STATE_FILE"
  run bash -c 'grep -v "^setcap " "$1" > "$1.tmp"; mv "$1.tmp" "$1"' _ "$STATE_FILE"

  local symlinks=()
  while IFS= read -r line; do
    case "$line" in "symlink "*) symlinks+=("${line#symlink }") ;; esac
  done < "$STATE_FILE"
  if [ "${#symlinks[@]}" -gt 0 ]; then
    say "This script created these symlinks: ${symlinks[*]}"
    if confirm "Remove them?"; then
      for path in "${symlinks[@]}"; do
        run $SUDO rm -f "$path"
      done
      run bash -c 'grep -v "^symlink " "$1" > "$1.tmp"; mv "$1.tmp" "$1"' _ "$STATE_FILE"
    fi
  fi
}

print_remaining_changes() {
  say
  say "Not undone by restore:"
  say "  - apt full-upgrade (packages and kernel stay upgraded)"
  say "  - installed build packages (git, make, libnl, tcpdump, ...)"
  if grep -qx "arch armhf" "$STATE_FILE" 2>/dev/null; then
    say "  - dpkg foreign architecture armhf, added by install. Remove with:"
    say "      sudo apt purge ':armhf' && sudo dpkg --remove-architecture armhf"
  fi
  if grep -q "^symlink " "$STATE_FILE" 2>/dev/null; then
    say "  - symlinks you chose to keep: $(grep '^symlink ' "$STATE_FILE" | cut -d' ' -f2- | tr '\n' ' ')"
  fi
  say "  - the build directory $BUILD_DIR (delete it to free about 3 GB)"
}

do_restore() {
  paths
  say "This restores the stock WiFi firmware (upstream 'make -f Makefile.rpi restore-wifi': firmware"
  say "alternative, brcmfmac_cyw driver reload, NetworkManager manage and connect for wlan0), then removes"
  say "the setcap grants this script recorded in $STATE_FILE."
  if ! confirm "Continue?"; then die "Aborted. Nothing was changed."; fi
  if [ -d "$CSI_DIR" ] || [ "$DRY_RUN" -eq 1 ]; then
    run_nexmon_env "$CSI_DIR" make -f Makefile.rpi restore-wifi
  else
    warn "No nexmon_csi checkout at $CSI_DIR, so make restore-wifi cannot run. See docs/hardware.md for the manual steps."
  fi
  local unit
  for unit in wpa_supplicant NetworkManager; do
    if [ "$DRY_RUN" -eq 1 ] || systemctl list-unit-files "$unit.service" 2>/dev/null | grep -q "^$unit.service"; then
      run $SUDO systemctl restart "$unit"
    fi
  done
  revert_recorded_changes
  print_remaining_changes
  say "Confirm with: iw dev $IFACE link"
}

do_status() {
  paths
  if [ -f "$STATE_FILE" ]; then say "State: $(cat "$STATE_FILE")"; else say "State: not installed by this script"; fi
  if [ -f "$VERSIONS_FILE" ]; then cat "$VERSIONS_FILE"; fi
  say "Firmware alternative:"
  update-alternatives --query "$FIRMWARE_ALTERNATIVE" 2>/dev/null | grep -E '^(Value|Status):' || say "  (not available)"
  say "Monitor state:"
  nexutil "-I$IFACE" -m 2>/dev/null || say "  (nexutil not available)"
  say "Listening ${STATUS_CAPTURE_SECONDS}s for CSI frames on UDP $CSI_UDP_PORT..."
  if timeout "$STATUS_CAPTURE_SECONDS" tcpdump -nn -c 1 -i "$IFACE" udp dst port "$CSI_UDP_PORT" >/dev/null 2>&1; then
    say "CSI frames seen."
  else
    say "No CSI frames seen (or tcpdump lacks permission)."
  fi
}

# ---------- main ----------

COMMAND="${1:-help}"
if [ $# -gt 0 ]; then shift; fi
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --yes) YES=1 ;;
    --force) FORCE=1 ;;
    --allow-archived-python27) ALLOW_ARCHIVED_PY27=1 ;;
    --grant-tcpdump-caps) GRANT_TCPDUMP_CAPS=1 ;;
    --iface) IFACE="${2:?--iface needs a value}"; shift ;;
    --channel) CHANNEL="${2:?--channel needs a value}"; shift ;;
    --mac|--bssid) MAC_FILTER="${2:?$1 needs a value}"; shift ;;
    --core-mask) CORE_MASK="${2:?--core-mask needs a value}"; shift ;;
    --stream-mask) STREAM_MASK="${2:?--stream-mask needs a value}"; shift ;;
    --build-dir) BUILD_DIR="${2:?--build-dir needs a value}"; shift ;;
    -h|--help) COMMAND=help ;;
    *) usage >&2; die "Unknown option: $1" ;;
  esac
  shift
done

case "$COMMAND" in
  help) usage ;;
  check) report_preflight ;;
  install) do_install ;;
  start) do_start ;;
  status) do_status ;;
  stop|restore) do_restore ;;
  *) usage >&2; die "Unknown command: $COMMAND" ;;
esac
