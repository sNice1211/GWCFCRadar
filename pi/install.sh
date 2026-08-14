#!/usr/bin/env bash
# Sets the whole thing up on the Pi, once.
#
#     bash ~/GWCFCRadar/pi/install.sh
#
# Installs what is missing, builds the Python environment, and registers three
# services so this survives a reboot and a closed terminal:
#
#   gwcfc-models   builds the model images, hourly
#   gwcfc-serve    serves them with the header that makes them readable
#   gwcfc-tunnel   gives them a public HTTPS address
#
# Safe to run again. Everything it does is idempotent, so if a step failed the
# first time, fix the cause and run it again rather than unpicking anything.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$HOME/wxenv"
DATA="$HOME/wxdata"
PORT=8080
UNITS="$HOME/.config/systemd/user"

say() { printf '\n\033[1;36m==\033[0m %s\n' "$*"; }
ok()  { printf '   \033[32mok\033[0m %s\n' "$*"; }
warn(){ printf '   \033[33m!!\033[0m %s\n' "$*"; }

# ── 1. system packages ──────────────────────────────────────────────────────
say "System packages"
NEED=()
for p in python3-venv python3-numpy python3-pillow python3-requests libeccodes-tools; do
  dpkg -s "$p" >/dev/null 2>&1 || NEED+=("$p")
done
if [ ${#NEED[@]} -gt 0 ]; then
  echo "   installing: ${NEED[*]}"
  sudo apt-get update -qq
  sudo apt-get install -y "${NEED[@]}"
else
  ok "already present"
fi

# ── 2. python environment ───────────────────────────────────────────────────
# A virtual environment because current Raspberry Pi OS refuses pip into the
# system Python. --system-site-packages so numpy and Pillow come from apt,
# which is far faster than pip building them on an ARM board.
say "Python environment"
if [ ! -x "$VENV/bin/python" ]; then
  python3 -m venv --system-site-packages "$VENV"
  ok "created $VENV"
else
  ok "$VENV already there"
fi
"$VENV/bin/pip" install --quiet --upgrade pip >/dev/null 2>&1 || true
if ! "$VENV/bin/python" -c "import eccodes" >/dev/null 2>&1; then
  "$VENV/bin/pip" install --quiet eccodes
fi
"$VENV/bin/python" - <<'PY'
import sys
mods = {}
for m in ("eccodes", "numpy", "PIL", "requests"):
    try:
        __import__(m); mods[m] = "ok"
    except Exception as e:
        mods[m] = f"MISSING ({e.__class__.__name__})"
for k, v in mods.items():
    print(f"   {k:10} {v}")
sys.exit(0 if all(v == "ok" for v in mods.values()) else 1)
PY

# ── 3. cloudflared ──────────────────────────────────────────────────────────
say "Tunnel client"
if ! command -v cloudflared >/dev/null 2>&1; then
  ARCH=$(dpkg --print-architecture)
  case "$ARCH" in
    arm64) CF=cloudflared-linux-arm64 ;;
    armhf) CF=cloudflared-linux-arm ;;
    *)     CF=cloudflared-linux-amd64 ;;
  esac
  curl -fsSL -o /tmp/cloudflared \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/$CF"
  chmod +x /tmp/cloudflared
  sudo mv /tmp/cloudflared /usr/local/bin/cloudflared
  ok "installed for $ARCH"
else
  ok "already installed"
fi

mkdir -p "$DATA/models" "$UNITS"

# ── 4. services ─────────────────────────────────────────────────────────────
# User services rather than system ones: nothing here needs root, and this way
# the whole thing lives in the home directory and can be removed by deleting it.
say "Services"

cat > "$UNITS/gwcfc-models.service" <<EOF
[Unit]
Description=Build GWCFC model images
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$VENV/bin/python $REPO/pi/gfs_pipeline.py
# A run is minutes, not hours. If it is still going after one, something is
# wrong and a stuck run must not block every run after it.
TimeoutStartSec=3600
Nice=10
EOF

cat > "$UNITS/gwcfc-models.timer" <<'EOF'
[Unit]
Description=Build GWCFC model images hourly

[Timer]
# Hourly rather than four times a day on purpose: the pipeline works out
# whether there is anything new and exits in under a second when there is not,
# so a run is picked up as soon as it publishes rather than at a fixed guess.
# The offset keeps it off the hour, where everyone else's cron lands.
OnCalendar=*:17
Persistent=true

[Install]
WantedBy=timers.target
EOF

cat > "$UNITS/gwcfc-serve.service" <<EOF
[Unit]
Description=Serve GWCFC model images
After=network.target

[Service]
ExecStart=$VENV/bin/python $REPO/pi/serve.py $PORT $DATA
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

cat > "$UNITS/gwcfc-tunnel.service" <<EOF
[Unit]
Description=Public HTTPS address for the GWCFC model images
After=gwcfc-serve.service
Wants=gwcfc-serve.service

[Service]
ExecStart=/usr/local/bin/cloudflared tunnel --url http://localhost:$PORT
Restart=always
RestartSec=10
StandardOutput=append:$HOME/tunnel.log
StandardError=append:$HOME/tunnel.log

[Install]
WantedBy=default.target
EOF
ok "units written to $UNITS"

# Without lingering, user services stop when the last session closes, which is
# exactly what happens when the terminal is shut.
sudo loginctl enable-linger "$USER" >/dev/null 2>&1 || warn "could not enable lingering; services may stop when you log out"

systemctl --user daemon-reload
: > "$HOME/tunnel.log"
systemctl --user enable --now gwcfc-serve.service  >/dev/null 2>&1
systemctl --user restart    gwcfc-tunnel.service   >/dev/null 2>&1 || \
  systemctl --user enable --now gwcfc-tunnel.service >/dev/null 2>&1
systemctl --user enable --now gwcfc-models.timer   >/dev/null 2>&1
ok "serve, tunnel and hourly build are running"

# ── 5. the address ──────────────────────────────────────────────────────────
say "Public address"
URL=""
for _ in $(seq 1 20); do
  URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$HOME/tunnel.log" 2>/dev/null | head -1 || true)
  [ -n "$URL" ] && break
  sleep 2
done

# ── 6. first build ──────────────────────────────────────────────────────────
say "First build (a few minutes; later runs are quicker and automatic)"
"$VENV/bin/python" "$REPO/pi/gfs_pipeline.py" || warn "the build reported a problem; see above"

echo
echo "=============================================================="
if [ -n "$URL" ]; then
  echo "  Your Pi is at:"
  echo "      $URL"
  echo
  echo "  On the site, open the browser console and run:"
  echo "      hdSetPi('$URL')"
  echo
  echo "  Then turn on HD Models in the overlay list."
else
  warn "no tunnel address yet. Try: grep trycloudflare ~/tunnel.log"
fi
echo
echo "  Built so far: $(du -sh "$DATA/models" 2>/dev/null | cut -f1 || echo 0)"
echo
echo "  Useful later:"
echo "      systemctl --user status gwcfc-models.timer"
echo "      journalctl --user -u gwcfc-models -n 50"
echo "      grep trycloudflare ~/tunnel.log     # after a reboot the address changes"
echo "=============================================================="
