#!/usr/bin/env bash
# Sets the whole thing up on the Pi, once.
#
#     bash ~/GWCFCRadar/pi/install.sh
#
# Installs what is missing, builds the Python environment, and registers four
# services so this survives a reboot and a closed terminal:
#
#   gwcfc-models   builds the model images, hourly
#   gwcfc-serve    serves them with the header that makes them readable
#   gwcfc-tunnel   gives them a public HTTPS address
#   gwcfc-publish  tells the site that address, so nobody has to paste it
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
cat > "$UNITS/gwcfc-publish.service" <<EOF
[Unit]
Description=Tell the site where the Pi is
After=gwcfc-tunnel.service
Wants=gwcfc-tunnel.service

[Service]
# --watch because the tunnel takes a while to come up and can be restarted
# underneath us. Checking once and giving up is how the site ends up pointed
# at an address that no longer answers.
ExecStart=$VENV/bin/python $REPO/pi/publish_url.py --watch
Restart=always
RestartSec=15

[Install]
WantedBy=default.target
EOF
ok "units written to $UNITS"

# Without lingering, user services stop when the last session closes, which is
# exactly what happens when the terminal is shut.
sudo loginctl enable-linger "$USER" >/dev/null 2>&1 || warn "could not enable lingering; services may stop when you log out"

# Radar and cyclones are their own services on their own clocks. Radar is the
# fast one: a new volume lands every four to six minutes and an hourly check
# would show weather that has already moved. Cyclones run twice a day because
# that is how often DeepMind publish. Both have their own lock, so a slow one
# never holds up the models.
cat > "$UNITS/gwcfc-radar.service" <<EOF
[Unit]
Description=Decode NEXRAD Level 2 into map overlays

[Service]
Type=oneshot
ExecStart=$VENV/bin/python $REPO/pi/radar_pipeline.py
TimeoutStartSec=900
Nice=10
EOF

cat > "$UNITS/gwcfc-radar.timer" <<'EOF'
[Unit]
Description=Radar every five minutes

[Timer]
OnCalendar=*:0/5
Persistent=false

[Install]
WantedBy=timers.target
EOF

cat > "$UNITS/gwcfc-cyclones.service" <<EOF
[Unit]
Description=Fetch DeepMind cyclone tracks and genesis fields

[Service]
Type=oneshot
ExecStart=$VENV/bin/python $REPO/pi/cyclones_pipeline.py
TimeoutStartSec=1800
Nice=10
EOF

cat > "$UNITS/gwcfc-cyclones.timer" <<'EOF'
[Unit]
Description=Cyclones twice a day, a little after each run publishes

[Timer]
# They run at 00 and 12 and publish a few hours later. Checking every three
# hours picks a run up soon after it lands without asking pointlessly, and the
# pipeline exits at once when the newest run is already built.
OnCalendar=*-*-* 03,06,09,15,18,21:23
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
: > "$HOME/tunnel.log"
systemctl --user enable --now gwcfc-serve.service  >/dev/null 2>&1
systemctl --user restart    gwcfc-tunnel.service   >/dev/null 2>&1 || \
  systemctl --user enable --now gwcfc-tunnel.service >/dev/null 2>&1
systemctl --user enable --now gwcfc-models.timer   >/dev/null 2>&1
systemctl --user enable --now gwcfc-radar.timer    >/dev/null 2>&1
systemctl --user enable --now gwcfc-cyclones.timer >/dev/null 2>&1
systemctl --user restart    gwcfc-publish.service  >/dev/null 2>&1 || \
  systemctl --user enable --now gwcfc-publish.service >/dev/null 2>&1
ok "serve, tunnel, publish, models, radar and cyclones are running"

# ── 5. the address ──────────────────────────────────────────────────────────
say "Public address"
URL=""
for _ in $(seq 1 20); do
  # tail, not head: the log is appended to across restarts, so the last
  # address is the live one and every earlier one is dead.
  URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$HOME/tunnel.log" 2>/dev/null | tail -1 || true)
  [ -n "$URL" ] && break
  sleep 2
done

# ── 6. first build ──────────────────────────────────────────────────────────
# Started through systemd rather than run here. Run from the script it belongs
# to the terminal, so closing the window or a stray Ctrl+C kills a build that
# takes ten minutes. As a service it belongs to the machine and survives both,
# and the log below is only a view of it: stopping the view does not stop the
# build.
say "First build"
systemctl --user start --no-block gwcfc-models.service
echo "   started in the background. Following the log; Ctrl+C stops watching,"
echo "   not building."
echo
timeout 900 journalctl --user -u gwcfc-models -f --no-pager -n 0 &
FOLLOW=$!
# Wait for it to finish rather than for a fixed time, so a fast run is not
# padded and a slow one is not cut off.
for _ in $(seq 1 180); do
  sleep 5
  systemctl --user is-active --quiet gwcfc-models.service || break
done
kill "$FOLLOW" 2>/dev/null || true
wait "$FOLLOW" 2>/dev/null || true

echo
echo "=============================================================="
if [ -n "$URL" ]; then
  echo "  Your Pi is at:"
  echo "      $URL"
  echo
  echo
  echo "  The Pi publishes that address itself, so the site will find it."
  echo "  Just turn on HD Models in the overlay list."
else
  warn "no tunnel address yet. Try: grep trycloudflare ~/tunnel.log"
fi
echo
  echo "  Built so far:"
  "$VENV/bin/python" - <<'PYEOF' 2>/dev/null || echo "      nothing yet, the first build is still running"
import json, os, sys
# The total comes from the model table rather than a number typed here, which
# went stale the moment more models were added and reported 19 of 20 when
# there were 39.
sys.path.insert(0, os.path.expanduser("~/GWCFCRadar/pi"))
try:
    from gfs_pipeline import DEFAULT_MODELS, MODELS, regions_of
    total = sum(len(regions_of(MODELS[k])) for k in DEFAULT_MODELS)
except Exception:
    total = 0
p = os.path.expanduser("~/wxdata/models/latest.json")
try:
    d = json.load(open(p))
except Exception:
    raise SystemExit("      nothing yet, the first build is still running")
n = 0
for k, v in sorted((d.get("models") or {}).items()):
    regs = ", ".join(sorted(v.get("regions") or {"conus": {}}))
    n += len(v.get("regions") or {1: 1})
    print(f"      {k:10} {regs}")
print(f"      {n} of {total or n} model and region combinations")
PYEOF
echo
echo "  Useful later:"
echo "      systemctl --user status gwcfc-models.timer"
echo "      journalctl --user -u gwcfc-models -n 50"
echo "      grep trycloudflare ~/tunnel.log     # after a reboot the address changes"
echo "=============================================================="
