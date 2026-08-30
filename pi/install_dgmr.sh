#!/usr/bin/env bash
# Sets up Storm Spotlight (pi/dgmr_pipeline.py) on a GPU box, opt-in and
# separate from pi/install.sh on purpose: this needs a CUDA-capable NVIDIA
# GPU and about 8 GB of disk for a venv plus model weights, neither of which
# the Pi or a plain server has, and the feature is still experimental (see
# pi/dgmr_pipeline.py's own docstring). Nothing here touches the main
# install; this is its own machine, its own venv, its own service.
#
#     bash pi/install_dgmr.sh              install (or repair) the stack
#     bash pi/install_dgmr.sh --uninstall  tear it back down
#
# Written for the exact box this was built and tested on: a privileged LXC
# container, Debian 12, Python 3.11.2, root, with the NVIDIA driver and GPU
# passthrough already configured at the host/container level (this script
# does not touch either - if `nvidia-smi` does not already work here, fix
# that first, this script cannot). Safe to run again; every step checks
# before it acts.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="/opt/dgmr"
UNITS="/etc/systemd/system"
LD_CONF="/etc/ld.so.conf.d/dgmr-cuda.conf"
CUDNN_PIN="9.10.2.21"

say() { printf '\n\033[1;36m==\033[0m %s\n' "$*"; }
ok()  { printf '   \033[32mok\033[0m %s\n' "$*"; }
warn(){ printf '   \033[33m!!\033[0m %s\n' "$*"; }
die() { printf '   \033[31mFAIL\033[0m %s\n' "$*"; exit 1; }

if [ "$(id -u)" -ne 0 ]; then
  die "run as root (this installs system packages and a system service)"
fi

# ── --uninstall ──────────────────────────────────────────────────────────────
# Symmetric with the install below on purpose: this is what freed 7.7 GB the
# last time this stack came out, done by hand. Doing it here means the next
# time is a command instead of a transcript to reconstruct.
if [ "${1:-}" = "--uninstall" ]; then
  say "Removing Storm Spotlight"
  systemctl disable --now gwcfc-dgmr.timer   >/dev/null 2>&1 || true
  systemctl disable       gwcfc-dgmr.service >/dev/null 2>&1 || true
  rm -f "$UNITS/gwcfc-dgmr.service" "$UNITS/gwcfc-dgmr.timer"
  systemctl daemon-reload
  rm -rf "$VENV"
  rm -rf "$HOME/.pysteps"
  rm -f "$LD_CONF"
  ldconfig
  ok "removed $VENV, \$HOME/.pysteps, and $LD_CONF"
  echo "   The GPU driver and container passthrough were left alone - only"
  echo "   the Python side came out, same as before. Re-run this script"
  echo "   without --uninstall to bring it back."
  exit 0
fi

# ── 0. the one thing this script cannot fix ──────────────────────────────────
say "GPU"
if ! command -v nvidia-smi >/dev/null 2>&1; then
  die "nvidia-smi not found. Driver/passthrough setup is out of scope for \
this script - see the gpu_nowcast_deployment project memory for how that \
was done the first time."
fi
if ! nvidia-smi >/dev/null 2>&1; then
  die "nvidia-smi found but failed. Driver/passthrough is broken - fix that \
before running this again; nothing below can work without it."
fi
ok "$(nvidia-smi --query-gpu=name,driver_version --format=csv,noheader)"

# ── 1. disk ───────────────────────────────────────────────────────────────
say "Disk space"
FREE_MB=$(df -Pm "$(dirname "$VENV")" | awk 'NR==2 {print $4}')
echo "   $FREE_MB MB free"
# The venv runs ~6.7 GB, the DGMR weights another ~1.0 GB - see the
# gpu_nowcast_deployment project memory, measured the first time this was
# built. 9000 MB leaves real headroom rather than landing exactly on empty.
if [ "${FREE_MB:-0}" -lt 9000 ]; then
  die "need roughly 9000 MB free for the venv (~6.7 GB) plus model weights \
(~1.0 GB); only $FREE_MB MB free. Free some space first."
fi

# ── 2. apt packages ───────────────────────────────────────────────────────
say "System packages"
NEED=""
for pkg in build-essential python3-dev git libeccodes0 libeccodes-data python3-venv; do
  dpkg -s "$pkg" >/dev/null 2>&1 || NEED="$NEED $pkg"
done
if [ -n "$NEED" ]; then
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends $NEED
  ok "installed:$NEED"
else
  ok "already present"
fi

# ── 3. the venv ───────────────────────────────────────────────────────────
# A dedicated venv rather than --system-site-packages like the Pi's wxenv:
# TensorFlow and the exact cuDNN pin below have no business anywhere near
# the rest of this box's Python, and this stack gets torn down and rebuilt
# far more often than the main pipeline does.
say "Python environment"
if [ ! -x "$VENV/bin/python" ]; then
  python3 -m venv "$VENV"
  ok "created $VENV"
else
  ok "$VENV already there"
fi
PIP="$VENV/bin/pip"
"$PIP" install --quiet -U pip wheel "setuptools<81"
# tensorflow_hub still imports pkg_resources, which setuptools 81 dropped.
# Pinned before anything else installs, so nothing pulls a newer one in.

say "Installing packages (this downloads a few hundred MB)"
"$PIP" install --quiet numpy scipy pillow requests opencv-python-headless
"$PIP" install --quiet "tensorflow[and-cuda]"
# MUST come after tensorflow: installing tensorflow[and-cuda] pulls its own,
# newer cuDNN as a dependency, and THAT is the one that breaks Pascal. This
# downgrades it back over the top.
"$PIP" install --quiet "nvidia-cudnn-cu12==$CUDNN_PIN"
"$PIP" install --quiet pysteps eccodes tensorflow_hub huggingface_hub
"$PIP" install --quiet "git+https://github.com/pySTEPS/pysteps-dgmr-nowcasts"
ok "packages installed, cuDNN pinned to $CUDNN_PIN"

# ── 4. the library path fix ───────────────────────────────────────────────
# Not LD_LIBRARY_PATH: that does not reach a process started by systemd or
# cron, only an interactive shell that happened to export it first. Without
# this, TensorFlow silently fails to dlopen libcusolver.so.11 and reports an
# empty GPU list with only a generic warning - the missing library only
# names itself at TF_CPP_MAX_VLOG_LEVEL=1.
say "CUDA library path"
find "$VENV/lib/python3.11/site-packages/nvidia" -name lib -type d 2>/dev/null \
  | sort > "$LD_CONF"
if [ ! -s "$LD_CONF" ]; then
  die "no nvidia/*/lib directories found under the venv - did the pip \
installs above actually succeed?"
fi
ldconfig
ok "wrote $LD_CONF ($(wc -l < "$LD_CONF") paths)"

# ── 5. prove it, not just install it ─────────────────────────────────────
# The whole point: a venv that imports cleanly but never touches the GPU is
# indistinguishable from success right up until the first real forecast,
# which is a much more expensive place to discover a cuDNN mismatch.
say "Smoke test"
SMOKE_OUT=$("$VENV/bin/python" - <<'PYEOF' 2>&1
import time
import tensorflow as tf
gpus = tf.config.list_physical_devices("GPU")
if not gpus:
    raise SystemExit("NO GPU DETECTED")
from dgmr_module_plugin.dgmr import forecast  # downloads weights on first run
x = tf.zeros((4, 256, 256, 1), dtype=tf.float32)
t0 = time.time()
out = forecast(x, num_samples=1)
print(f"OK shape={tuple(out.shape)} took={time.time() - t0:.1f}s")
PYEOF
) || { echo "$SMOKE_OUT"; die "smoke test failed - see output above"; }
echo "$SMOKE_OUT" | grep -q "^OK" || { echo "$SMOKE_OUT"; die "smoke test did not report OK"; }
ok "$SMOKE_OUT"

# ── 6. the service, off by default ────────────────────────────────────────
# A five-minute timer offset from :0 (the pattern every other pipeline's
# timer in pi/install.sh follows), so it does not compete with anything
# else's timer for the same tick.
say "systemd service"
cat > "$UNITS/gwcfc-dgmr.service" <<EOF
[Unit]
Description=Storm Spotlight: DGMR nowcast for the strongest US storm right now

[Service]
Type=oneshot
ExecStart=-$VENV/bin/python $REPO/pi/dgmr_pipeline.py
TimeoutStartSec=300
Nice=10
EOF

cat > "$UNITS/gwcfc-dgmr.timer" <<'EOF'
[Unit]
Description=Storm Spotlight every five minutes

[Timer]
OnCalendar=*:2/5
Persistent=false

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now gwcfc-dgmr.timer >/dev/null 2>&1
ok "gwcfc-dgmr.timer enabled and started"

echo
echo "=============================================================="
echo "  Storm Spotlight is running: pi/dgmr_pipeline.py every 5 minutes."
echo "  It needs 4 fetches (~15-20 min) before the first forecast builds."
echo
echo "  Publishing to the page still needs ~/.gwcfc_dgmr_publish.json -"
echo "  see pi/dgmr_pipeline.py's _publish() docstring. Without it, output"
echo "  just sits under ~/wxdata/radar/dgmr/ on this machine."
echo
echo "  Useful later:"
echo "      systemctl status gwcfc-dgmr.timer"
echo "      journalctl -u gwcfc-dgmr -n 50"
echo "      bash pi/install_dgmr.sh --uninstall     # tear it back down"
echo "=============================================================="
