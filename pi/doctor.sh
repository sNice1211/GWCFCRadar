#!/usr/bin/env bash
# One command that says what is wrong, and the command that fixes it.
#
#     bash ~/GWCFCRadar/pi/doctor.sh
#
# diagnose.sh answers "can the site reach the Pi at all". This answers the
# next question: given that it can, why is a particular feature empty. Every
# Pi-backed feature is a chain - packages installed, timer registered, timer
# firing, files written, files served - and a break anywhere in it presents
# to the browser as the same shrug. So the chain is walked in order and each
# link is reported with the exact command to repair it.
#
# Nothing here changes anything. It only looks.

REPO="${REPO:-$HOME/GWCFCRadar}"
VENV="${VENV:-$HOME/wxenv}"
DATA="${DATA:-$HOME/wxdata}"
PY="$VENV/bin/python"

FIXES=()

hdr()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
good() { printf '   \033[32mOK\033[0m   %s\n' "$*"; }
bad()  { printf '   \033[31mBAD\033[0m  %s\n' "$*"; }
warn() { printf '   \033[33m??\033[0m   %s\n' "$*"; }
note() { printf '        %s\n' "$*"; }
fix()  { FIXES+=("$1"); }

hdr "0. The basics"
if [ -x "$PY" ]; then
  good "python at $PY ($("$PY" -V 2>&1))"
else
  bad "no python at $PY"
  fix "bash $REPO/pi/install.sh"
  note "nothing else can work without it; stopping here"
  exit 1
fi
FREE=$(df -Pm / | awk 'NR==2 {print $4}')
if [ "${FREE:-0}" -lt 500 ]; then
  bad "only ${FREE} MB free on /, which is not enough to write into"
  fix "find ~/wxdata -maxdepth 3 -type d -name '20*_*' -mmin +1440 -exec rm -rf {} +"
elif [ "${FREE:-0}" -lt 2000 ]; then
  warn "${FREE} MB free; retention will shorten itself to fit"
else
  good "${FREE} MB free on /"
fi

hdr "1. Python packages, per feature"
# Which package each feature actually cannot run without. A missing one is
# the commonest cause of a feature being silently empty, because every
# pipeline catches its own errors and carries on.
check_mod() {   # name, feature, install-command
  if "$PY" -c "import $1" >/dev/null 2>&1; then
    good "$1 - $2"
  else
    bad "$1 is MISSING - $2 cannot work"
    fix "$3"
  fi
}
check_mod eccodes     "model charts (reads GRIB)"        "$VENV/bin/pip install eccodes"
check_mod metpy       "radar decode and soundings"       "$VENV/bin/pip install metpy"
check_mod netCDF4     "satellite RGB composites"         "$VENV/bin/pip install netCDF4"
check_mod matplotlib  "sounding images"                  "$VENV/bin/pip install matplotlib"
# SounderPy is asked for THE WAY THE APP ASKS, and only that way.
#
# A plain `import sounderpy` fails on this machine by design: it is installed
# with --no-deps, so cartopy and pyart are absent, and SounderPy imports both
# at module scope for its plotting. sounding_service stands in for them. So a
# plain check reports "missing" for a package that is installed and working,
# which is worse than no check at all - it sends somebody to reinstall
# something that is already there, which is exactly the loop this whole fix
# exists to end.
SPY_TRY="import sys; sys.path.insert(0,'$REPO/pi'); import sounding_service as s; s.import_sounderpy()"
if "$PY" -c "$SPY_TRY" >/dev/null 2>&1; then
  good "sounderpy - sounding profiles (imports the way the app imports it)"
else
  bad "sounderpy will not import - sounding profiles cannot work"
  note "$("$PY" -c "$SPY_TRY" 2>&1 | tail -1)"
  if "$PY" -c "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('sounderpy') else 1)" >/dev/null 2>&1; then
    note "it IS installed, so this is a missing module it reads data with"
    fix "$VENV/bin/pip install siphon netCDF4 bs4 ecape_parcel cdsapi"
  else
    fix "$VENV/bin/pip install --no-deps sounderpy"
  fi
fi
check_mod sharppy     "sounding parameters (optional)"   "$VENV/bin/pip install --no-deps sharppy"
# SounderPy touches every one of these at import. Missing any of them and
# it will not import at all, which presents as "SounderPy is not installed"
# however many times it is installed.
for m in xarray siphon cfgrib bs4 ecape_parcel cdsapi; do
  "$PY" -c "import $m" >/dev/null 2>&1 || {
    warn "$m missing; SounderPy may not reach every source"
    fix "$VENV/bin/pip install $m"
  }
done

hdr "2. Services and timers"
for unit in gwcfc-serve.service gwcfc-tunnel.service; do
  if systemctl --user is-active --quiet "$unit"; then
    good "$unit is running"
  else
    bad "$unit is NOT running"
    fix "systemctl --user restart $unit"
  fi
done
for t in gwcfc-models gwcfc-radar gwcfc-sat gwcfc-snd gwcfc-cyclones gwcfc-update; do
  if [ ! -f "$HOME/.config/systemd/user/$t.timer" ]; then
    bad "$t.timer is not installed at all"
    fix "bash $REPO/pi/install.sh"
  elif systemctl --user is-enabled --quiet "$t.timer" 2>/dev/null; then
    NEXT=$(systemctl --user show "$t.timer" -p NextElapseUSecRealtime --value 2>/dev/null)
    LAST=$(systemctl --user show "$t.service" -p ExecMainStartTimestamp --value 2>/dev/null)
    # A blank NEXT while the service is active is normal: a timer does not
    # schedule the next run until the current one finishes.
    if systemctl --user is-active --quiet "$t.service"; then
      good "$t.timer enabled; its service is running right now"
    elif [ -z "$NEXT" ] || [ "$NEXT" = "n/a" ]; then
      warn "$t.timer is enabled but has no next run scheduled"
      note "last started: ${LAST:-never}"
      fix "systemctl --user restart $t.timer"
    else
      good "$t.timer enabled, next $NEXT"
    fi
  else
    bad "$t.timer is installed but NOT enabled, so it never fires"
    fix "systemctl --user enable --now $t.timer"
  fi
done

hdr "3. What each feature has actually written"
# The status files the pipelines now leave behind. These are the difference
# between "empty" and "empty BECAUSE", and the page reads the same ones.
show_status() {   # dir, label
  local f="$DATA/$1/status.json"
  [ -f "$f" ] || { note "$2: no status file yet"; return; }
  "$PY" - "$f" "$2" <<'PYEOF'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    print(f"        {sys.argv[2]}: status unreadable ({e})"); raise SystemExit
mark = "OK  " if d.get("ok") else "BAD "
print(f"        {mark} {sys.argv[2]}: {d.get('reason') or 'fine'} (at {d.get('at','?')})")
if d.get("fix"):
    print(f"             fix: {d['fix']}")
PYEOF
}

count_dirs() { find "$1" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l; }

if [ -s "$DATA/models/latest.json" ]; then
  good "models: latest.json present ($(wc -c < "$DATA/models/latest.json") bytes)"
else
  bad "models: no latest.json"
  fix "systemctl --user start gwcfc-models.service"
fi

RN=$(count_dirs "$DATA/radar")
[ "$RN" -gt 0 ] && good "radar: $RN product folder(s)" || {
  bad "radar: nothing built"; fix "systemctl --user start gwcfc-radar.service"; }

SATMAN=$(find "$DATA/satellite" -name manifest.json 2>/dev/null | wc -l)
if [ "$SATMAN" -gt 0 ]; then
  good "satellite: $SATMAN sector manifest(s)"
  "$PY" - "$DATA/satellite" <<'PYEOF'
import json, os, sys
root = sys.argv[1]
for sat in sorted(os.listdir(root)):
    d = os.path.join(root, sat)
    if not os.path.isdir(d):
        continue
    for sec in sorted(os.listdir(d)):
        man = os.path.join(d, sec, "manifest.json")
        if not os.path.exists(man):
            continue
        try:
            prods = (json.load(open(man)) or {}).get("products") or {}
        except Exception:
            print(f"        {sat}/{sec}: manifest unreadable"); continue
        if prods:
            names = ", ".join(sorted(prods))
            print(f"        {sat}/{sec}: {len(prods)} composite(s): {names}")
        else:
            print(f"        {sat}/{sec}: manifest exists but has NO composites")
PYEOF
else
  bad "satellite: no manifest anywhere, so nothing has ever built"
  fix "$PY $REPO/pi/satellite_pipeline.py --sector conus"
fi
show_status satellite "satellite"

if [ -s "$DATA/soundings/manifest.json" ]; then
  "$PY" - "$DATA/soundings/manifest.json" <<'PYEOF'
import json, sys
try:
    sites = (json.load(open(sys.argv[1])) or {}).get("sites") or {}
except Exception as e:
    print(f"        soundings: manifest unreadable ({e})"); raise SystemExit
if sites:
    print(f"   \033[32mOK\033[0m   soundings: {len(sites)} site(s) built")
    for k in list(sorted(sites))[:3]:
        print(f"        {k}: {len(sites[k].get('frames') or [])} frame(s), "
              f"newest {sites[k].get('valid')}")
else:
    print("   \033[31mBAD\033[0m  soundings: manifest exists but lists no sites")
PYEOF
else
  bad "soundings: no manifest, so no site has ever built"
  fix "$PY $REPO/pi/sounding_pipeline.py --site OUN"
fi
show_status soundings "soundings"

hdr "4. Is the server actually serving them?"
# A file on disk the browser cannot fetch is the same as no file. Asked
# through the local port, so this isolates the server from the tunnel.
probe() {   # path, label
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 \
         "http://127.0.0.1:8080/$1" 2>/dev/null)
  case "$code" in
    200) good "$2 -> HTTP 200" ;;
    404) bad  "$2 -> 404, so the file is not where the page looks for it" ;;
    000) bad  "$2 -> no answer; serve.py may be down"
         fix "systemctl --user restart gwcfc-serve.service" ;;
    *)   warn "$2 -> HTTP $code" ;;
  esac
}
probe "models/latest.json"                  "models/latest.json"
probe "satellite/east/conus/manifest.json"  "satellite east/conus manifest"
probe "soundings/manifest.json"             "soundings manifest"

hdr "5. The address the site is told to use"
"$PY" "$REPO/pi/publish_url.py" --check 2>&1 | sed 's/^/        /' || \
  note "publish_url --check did not run"

hdr "Summary"
if [ ${#FIXES[@]} -eq 0 ]; then
  printf '   \033[32mNothing to fix.\033[0m Every link in the chain answered.\n'
  note "If a feature still looks empty in the browser, the problem is between"
  note "the tunnel and the browser rather than on this machine. Run:"
  note "  bash $REPO/pi/diagnose.sh"
else
  printf '   Run these, in this order:\n\n'
  # Same command suggested by several checks is still only worth running once.
  printf '%s\n' "${FIXES[@]}" | awk '!seen[$0]++ {print "     " $0}'
  printf '\n'
  note "then run this again to confirm."
fi
