#!/usr/bin/env bash
# Sets the whole thing up on the Pi, once.
#
#     bash ~/GWCFCRadar/pi/install.sh
#
# Installs what is missing, builds the Python environment, and registers four
# services so this survives a reboot and a closed terminal:
#
#   gwcfc-models    builds the model images, hourly
#   gwcfc-radar     decodes Level 2 and Level 3 radar, every five minutes
#   gwcfc-sat       builds the GOES RGB composites, every ten minutes
#   gwcfc-cyclones  fetches the DeepMind cyclone runs
#   gwcfc-serve     serves them with the header that makes them readable
#   gwcfc-tunnel    gives them a public HTTPS address
#   gwcfc-publish   tells the site that address, so nobody has to paste it
#   gwcfc-update    pulls new code, so the Pi does not run last week's
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

# ── 0. the disk, checked before anything is downloaded ──────────────────────
# A full SD card is the one failure here that does not look like itself. apt
# reports a write error against a Debian mirror, pip reports an OSError about
# a package directory, and git reports "unable to write loose object file".
# Three unrelated-looking messages, one cause, and none of them says the word
# "disk" first. So it is asked about up front, in plain numbers, and the
# commands that free the usual culprits are printed rather than described.
say "Disk space"
FREE_MB=$(df -Pm / | awk 'NR==2 {print $4}')
echo "   $FREE_MB MB free on /"
if [ "${FREE_MB:-0}" -lt 800 ]; then
  warn "that is not enough to install into, and probably not enough to run"
  echo
  echo "   The usual culprits, largest first:"
  echo "     sudo apt clean                    # downloaded .debs"
  echo "     rm -rf ~/.cache/pip               # pip's wheel cache"
  echo "     sudo journalctl --vacuum-size=50M # systemd logs"
  echo "     du -sh ~/wxdata/* | sort -h       # what the weather data costs"
  echo
  echo "   Weather frames rebuild themselves, so deleting old ones is safe:"
  echo "     find ~/wxdata -maxdepth 3 -type d -name '20*_*' -mmin +1440 \\"
  echo "       -exec rm -rf {} +               # frames older than a day"
  echo
  warn "stopping here rather than half installing into a full disk"
  exit 1
elif [ "${FREE_MB:-0}" -lt 2500 ]; then
  warn "tight. The pipelines will shorten their own retention to fit, so this"
  warn "will work, but playback will not reach back as far as three days."
else
  ok "enough room for the full three day window"
fi

# ── 1. system packages ──────────────────────────────────────────────────────
say "System packages"
NEED=()
for p in python3-venv python3-numpy python3-pillow python3-requests libeccodes-tools; do
  dpkg -s "$p" >/dev/null 2>&1 || NEED+=("$p")
done
if [ ${#NEED[@]} -gt 0 ]; then
  echo "   installing: ${NEED[*]}"
  # This script is also run by the self-updater, with no terminal attached.
  # Plain sudo would sit waiting for a password nobody is there to type, and
  # the whole install would hang forever. -n makes it fail instead, and a
  # failed apt is a warning: everything below still runs, and the missing
  # packages are named so they can be installed next time someone is here.
  SUDO="sudo"
  [ -t 0 ] || SUDO="sudo -n"
  if ! $SUDO apt-get update -qq || ! $SUDO apt-get install -y "${NEED[@]}"; then
    warn "could not install ${NEED[*]} (no terminal for sudo?), continuing"
  fi
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
# MetPy reads the raw radar files. Without it the radar service starts, fails
# on the first import and systemd reports the unit as failed, which is exactly
# what was happening: nothing was wrong with the radar code, the reader for it
# had simply never been installed.
if ! "$VENV/bin/python" -c "import metpy" >/dev/null 2>&1; then
  "$VENV/bin/pip" install --quiet metpy || \
    warn "MetPy would not install; radar will not build until it does"
fi
# netCDF4 reads the raw GOES band files. Only the satellite composites need it,
# so a failure here is a warning and not the end of the install: everything
# else on this Pi carries on building without it.
if ! "$VENV/bin/python" -c "import netCDF4" >/dev/null 2>&1; then
  "$VENV/bin/pip" install --quiet netCDF4 || \
    warn "netCDF4 would not install; satellite composites will not build"
fi
# matplotlib draws the sounding images. piwheels ships an ARM wheel, so this
# is a download rather than the hour-long native build it looks like.
if ! "$VENV/bin/python" -c "import matplotlib" >/dev/null 2>&1; then
  "$VENV/bin/pip" install --quiet matplotlib || \
    warn "matplotlib would not install; sounding images will not build"
fi
# ── SounderPy and SHARPpy, installed WITHOUT their dependency lists ─────
#
# Both were tried the ordinary way first and both failed, and neither failure
# was about the package itself:
#
#   SHARPpy   pins a NumPy old enough to need distutils.msvccompiler, which
#             Python removed. pip therefore tries to BUILD that NumPy from
#             source and dies before SHARPpy is even unpacked. The failure is
#             in a dependency SHARPpy does not need: its own code runs
#             against the NumPy already on this Pi.
#   SounderPy lists arm-pyart and cartopy, which are for DRAWING soundings.
#             Nothing on this Pi draws anything: the page draws the chart and
#             this only ever fetches numbers. They are long C and C++ builds
#             on ARM, and several hundred megabytes of build cache on a
#             machine whose disk has already run out once, for code that will
#             never be called.
#
# --no-deps installs the package and nothing else. What they actually use at
# runtime is installed by name below, from wheels that exist for ARM.
#
# If either still refuses, nothing is lost: pi/sounding_service.py falls back
# to NOAA's plain text soundings, which need no packages at all.
say "Sounding libraries"

# What SounderPy really uses to FETCH, as opposed to what it lists.
#
# This list was not guessed. SounderPy was imported with each missing module
# stubbed in turn and the names written down: siphon, netCDF4, bs4,
# ecape_parcel and cdsapi all get touched at import, and every one of them
# either fetches data or calculates with it. cartopy and pyart are on that
# same list and are NOT here, because they only draw, and drawing is what
# this machine does with matplotlib instead. sounding_service stands in for
# those two so the import still completes.
for m in xarray siphon cfgrib netCDF4 bs4 ecape_parcel cdsapi; do
  "$VENV/bin/python" -c "import $m" >/dev/null 2>&1 || \
    "$VENV/bin/pip" install --quiet "$m" || \
      warn "$m would not install; SounderPy may not fetch every source"
done

if ! "$VENV/bin/python" -c "import sounderpy" >/dev/null 2>&1; then
  "$VENV/bin/pip" install --quiet --no-deps sounderpy || \
    warn "SounderPy would not install; the text soundings answer instead"
fi
if ! "$VENV/bin/python" -c "import sharppy" >/dev/null 2>&1; then
  "$VENV/bin/pip" install --quiet --no-deps sharppy || \
    warn "SHARPpy would not install; the browser works the parameters out"
fi

# Installed and IMPORTABLE are different questions when --no-deps is used: a
# package can unpack cleanly and then fail the moment anything touches it,
# which is a failure that otherwise only shows up when somebody clicks. So
# the import is tried here rather than trusted.
{ "$VENV/bin/python" - <<'SNDCHECK'
for m in ("sounderpy", "sharppy"):
    try:
        __import__(m)
        print(f"   {m:10} ok")
    except Exception as e:
        print(f"   {m:10} MISSING ({e.__class__.__name__}: {e})"[:110])
SNDCHECK
} || true

# Braced and forgiven, because set -e would otherwise abandon the whole install
# over one optional module.
{ "$VENV/bin/python" - <<'PY'
import sys
mods = {}
for m in ("eccodes", "numpy", "PIL", "requests", "metpy", "netCDF4"):
    try:
        __import__(m); mods[m] = "ok"
    except Exception as e:
        mods[m] = f"MISSING ({e.__class__.__name__})"
for k, v in mods.items():
    print(f"   {k:10} {v}")
sys.exit(0 if all(v == "ok" for v in mods.values()) else 1)
PY
} || warn "something above is missing; the parts that need it will not build"

# ── 3. cloudflared ──────────────────────────────────────────────────────────
# Always refreshed to the latest release, not just installed once. Cloudflare
# retires old client versions on the quick-tunnel edge: a stale binary still
# registers a tunnel and prints a URL, but the edge answers 404 for it, which
# looks exactly like a broken server and cost hours to trace. The binary is
# outside apt's care, so this script is the only thing that will ever update it.
say "Tunnel client"
ARCH=$(dpkg --print-architecture)
case "$ARCH" in
  arm64) CF=cloudflared-linux-arm64 ;;
  armhf) CF=cloudflared-linux-arm ;;
  *)     CF=cloudflared-linux-amd64 ;;
esac
if curl -fsSL -o /tmp/cloudflared \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/$CF"; then
  chmod +x /tmp/cloudflared
  sudo mv /tmp/cloudflared /usr/local/bin/cloudflared
  ok "latest release installed for $ARCH ($(/usr/local/bin/cloudflared --version 2>/dev/null | head -1))"
elif command -v cloudflared >/dev/null 2>&1; then
  warn "could not fetch the latest cloudflared; keeping the one already installed"
else
  warn "could not fetch cloudflared and none is installed; the tunnel will not start"
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

# A named tunnel, if one has been set up, is left alone. Rewriting this unit
# would put the quick tunnel back, and since the updater now tells you to run
# this script whenever install.sh changes, a permanent address would quietly
# revert to a random one every time you took its advice.
if [ -f "$HOME/.cloudflared/config.yml" ] && \
   grep -q '^tunnel:' "$HOME/.cloudflared/config.yml" 2>/dev/null; then
  ok "named tunnel found, leaving gwcfc-tunnel.service alone"
  NAMED_TUNNEL=1
else
  NAMED_TUNNEL=0
cat > "$UNITS/gwcfc-tunnel.service" <<EOF
[Unit]
Description=Public HTTPS address for the GWCFC model images
After=gwcfc-serve.service
Wants=gwcfc-serve.service

[Service]
# --protocol http2 on purpose. The default (quic, over UDP) kept dying on this
# network with "failed to run the datagram handler" every minute or two, and
# every death rolled a new random URL. http2 runs over plain TCP and holds.
ExecStart=/usr/local/bin/cloudflared tunnel --protocol http2 --url http://localhost:$PORT
Restart=always
RestartSec=10
StandardOutput=append:$HOME/tunnel.log
StandardError=append:$HOME/tunnel.log

[Install]
WantedBy=default.target
EOF
fi
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
# Both levels, every run. Level 2 is the detailed one and Level 3 is the small
# quality controlled one, and the page falls back from the first to the second,
# so building only Level 2 left the fallback with nothing to fall back to.
# A leading dash means "carry on if this one fails", so a bad Level 2 volume no
# longer takes Level 3 down with it, and the unit stops reporting as failed for
# something it recovered from.
ExecStart=-$VENV/bin/python $REPO/pi/radar_pipeline.py
ExecStart=-$VENV/bin/python $REPO/pi/radar_pipeline.py --l3
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

# The satellite composites. Ten minutes rather than five because CONUS only
# scans every five and the mesoscale boxes, which scan every minute, are not
# worth a download that often on a home connection. A leading dash so one
# satellite being unreachable does not report the whole unit as failed.
cat > "$UNITS/gwcfc-sat.service" <<EOF
[Unit]
Description=Build GOES RGB composites from raw ABI bands

[Service]
Type=oneshot
# Full Disk is deliberately absent: it is ten times the size of CONUS and is
# built by hand with --sector fulldisk when it is actually wanted.
ExecStart=-$VENV/bin/python $REPO/pi/satellite_pipeline.py
TimeoutStartSec=1800
Nice=15
EOF

cat > "$UNITS/gwcfc-sat.timer" <<'EOF'
[Unit]
Description=Satellite composites every ten minutes

[Timer]
# Offset from the radar timer so the two big downloads do not collide on a
# single home connection.
OnCalendar=*:2/10
Persistent=false

[Install]
WantedBy=timers.target
EOF

# The sounding images: SounderPy fetches the full RAP profile for each
# upper-air site, SHARPpy computes the parameter suite, matplotlib draws the
# skew-T, and the page just shows the PNG. A leading dash because a pass in
# which every fetch fails is a bad hour upstream, not a broken unit.
cat > "$UNITS/gwcfc-snd.service" <<EOF
[Unit]
Description=Build SounderPy/SHARPpy sounding images

[Service]
Type=oneshot
ExecStart=-$VENV/bin/python $REPO/pi/sounding_pipeline.py
TimeoutStartSec=900
Nice=15
EOF

cat > "$UNITS/gwcfc-snd.timer" <<'EOF'
[Unit]
Description=Sounding images every fifteen minutes

[Timer]
# Offset from the radar (:0/5) and satellite (:2/10) timers, so the three
# big fetchers do not all land on one home connection at once. The pass
# budget inside the pipeline covers the whole network in about an hour,
# which is the RAP's own cadence, so running more often would build nothing.
OnCalendar=*:4/15
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

# Keeping itself current. Without this the Pi runs whatever was cloned until
# somebody remembers to pull, which is how it ends up an hour of debugging away
# from a bug that was fixed days ago.
cat > "$UNITS/gwcfc-update.service" <<EOF
[Unit]
Description=Pull the newest GWCFCRadar code
After=network-online.target

[Service]
Type=oneshot
Environment=REPO=$REPO
Environment=VENV=$VENV
ExecStart=/usr/bin/env bash $REPO/pi/selfupdate.sh
TimeoutStartSec=300
Nice=15
EOF

cat > "$UNITS/gwcfc-update.timer" <<'EOF'
[Unit]
Description=Check for new code every minute

[Timer]
# Every minute, which is the practical floor. A fetch takes seconds on a Pi
# and GitHub rate-limits anything that polls harder, so one a minute lands a
# merged fix in about thirty seconds on average without getting the Pi
# banned. Interval timers rather than calendar ones, so a slow fetch just
# delays the next tick instead of stacking.
OnBootSec=60
OnUnitActiveSec=60
# Catches up after the Pi has been off, which is exactly when it is furthest
# behind and most wants the newest code before the first build runs.
Persistent=true

[Install]
WantedBy=timers.target
EOF

chmod +x "$REPO/pi/selfupdate.sh" 2>/dev/null || true

systemctl --user daemon-reload
# Only the quick tunnel writes this log, and only it is confused by old lines
# in it. A named tunnel does not use it at all.
[ "$NAMED_TUNNEL" = "1" ] || : > "$HOME/tunnel.log"
# enable THEN restart, for the same reason the tunnel does below: this used
# to be "enable --now", which on a service that is ALREADY RUNNING does
# nothing at all. So serve.py kept running whatever file it was started with,
# for as long as the Pi stayed up. Pulling new code and running the installer
# looked like a successful update and changed nothing: the /sounding door was
# in the file on disk and not in the process answering requests.
systemctl --user enable  gwcfc-serve.service       >/dev/null 2>&1
systemctl --user restart gwcfc-serve.service       >/dev/null 2>&1
# enable THEN restart, as two separate steps. These used to be
# "restart || enable --now", and restart succeeds on a unit that exists but
# was never enabled, so the enable half never ran: the tunnel worked all day
# and then a reboot left it dead, because nothing had registered it to start.
systemctl --user enable  gwcfc-tunnel.service      >/dev/null 2>&1
systemctl --user restart gwcfc-tunnel.service      >/dev/null 2>&1
systemctl --user enable --now gwcfc-models.timer   >/dev/null 2>&1
systemctl --user enable --now gwcfc-radar.timer    >/dev/null 2>&1
systemctl --user enable --now gwcfc-sat.timer      >/dev/null 2>&1
systemctl --user enable --now gwcfc-snd.timer      >/dev/null 2>&1
systemctl --user enable --now gwcfc-cyclones.timer >/dev/null 2>&1
systemctl --user enable --now gwcfc-update.timer   >/dev/null 2>&1
systemctl --user enable  gwcfc-publish.service     >/dev/null 2>&1
systemctl --user restart gwcfc-publish.service     >/dev/null 2>&1
# The obs (METAR) service was removed from the app; clean it off any Pi that
# still has it, so a dead timer does not keep firing a script that is gone.
systemctl --user disable --now gwcfc-obs.timer gwcfc-obs.service >/dev/null 2>&1 || true
rm -f "$UNITS/gwcfc-obs.service" "$UNITS/gwcfc-obs.timer"
ok "serve, tunnel, publish, models, radar, cyclones and self-update are running"

# ── 5. the address ──────────────────────────────────────────────────────────
say "Public address"
URL=""
# A pinned address is the answer already and there is nothing to wait for.
if [ -s "$HOME/.gwcfc-pinned-url" ]; then
  URL=$(tr -d '[:space:]' < "$HOME/.gwcfc-pinned-url")
  ok "permanent address, so nothing to look up"
else
  for _ in $(seq 1 20); do
    # tail, not head: the log is appended to across restarts, so the last
    # address is the live one and every earlier one is dead.
    URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$HOME/tunnel.log" 2>/dev/null | tail -1 || true)
    [ -n "$URL" ] && break
    sleep 2
  done
fi

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
