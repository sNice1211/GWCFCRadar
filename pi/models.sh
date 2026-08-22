#!/usr/bin/env bash
# Which models actually rendered, and how to make the rest of them.
#
#     bash ~/GWCFCRadar/pi/models.sh          just look, change nothing
#     bash ~/GWCFCRadar/pi/models.sh --build  look, then build the missing ones
#     bash ~/GWCFCRadar/pi/models.sh --all    look, then rebuild every model
#
# "Is it rendering" has three different answers that look identical from the
# map, which is why this exists rather than a glance at the log:
#
#   never built    the model has no run on disk at all
#   stale          it built, hours ago, and has not managed one since
#   current        it built recently
#
# The first wants check_models.py, because the address is probably wrong. The
# second wants a rebuild. The third wants nothing, and knowing that is worth
# as much as the other two.
#
# Reads ~/wxdata/models/latest.json, which is the same file the website reads,
# so this reports what the site can actually see rather than what the Pi
# believes it has done.
set -uo pipefail

REPO="${REPO:-$HOME/GWCFCRadar}"
VENV="${VENV:-$HOME/wxenv}"
PY="$VENV/bin/python"
DATA="${DATA:-$HOME/wxdata}"
INDEX="$DATA/models/latest.json"

MODE="look"
case "${1:-}" in
  --build) MODE="build" ;;
  --all)   MODE="all" ;;
  "")      ;;
  *) echo "usage: bash $0 [--build|--all]"; exit 1 ;;
esac

step() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
note() { printf '        %s\n' "$*"; }

if [ ! -x "$PY" ]; then
  echo "no python at $PY. Run: bash $REPO/pi/install.sh"
  exit 1
fi

step "What the site can see right now"
if [ ! -f "$INDEX" ]; then
  printf '   \033[31mBAD\033[0m  there is no %s at all\n' "$INDEX"
  note "no model has ever finished a run on this Pi."
  note "Build them with:  bash $0 --all"
  exit 1
fi

# The comparison is against the list the pipeline itself would build, imported
# rather than copied, so a model added to gfs_pipeline.py shows up here as
# missing on the next run instead of being silently left out of the report.
"$PY" - "$INDEX" <<'PYEOF'
import json, os, sys, time
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.expanduser("~"), "GWCFCRadar", "pi"))
try:
    from gfs_pipeline import DEFAULT_MODELS, MODELS, regions_of
except Exception as e:                      # a broken checkout is its own news
    print(f"   could not read the model list from gfs_pipeline.py: {e}")
    DEFAULT_MODELS, MODELS, regions_of = [], {}, lambda m: []

GREEN, YELLOW, RED, DIM, OFF = (
    "\033[32m", "\033[33m", "\033[31m", "\033[2m", "\033[0m")

index = json.load(open(sys.argv[1]))
built = index.get("models", {}) or {}

def age_hours(run):
    """A run id is YYYYMMDDHH, so its age is readable without a manifest."""
    try:
        t = datetime.strptime(run[:10], "%Y%m%d%H").replace(tzinfo=timezone.utc)
    except Exception:
        return None
    return (datetime.now(timezone.utc) - t).total_seconds() / 3600.0

# How old is too old is a property of the model, not a single number: RTMA
# publishes every hour and GFS every six, so the same six hour gap is a fault
# in one and completely normal in the other.
STALE_AFTER = {"rtma": 3, "hrrr": 4, "rap": 4, "hrrrsub": 4, "namnest": 8,
               "nam": 10, "href": 12, "nbm": 8}
DEFAULT_STALE = 14

current, stale, missing = [], [], []
for name in (DEFAULT_MODELS or sorted(built)):
    entry = built.get(name)
    regions = (entry or {}).get("regions") or {}
    if not regions:
        missing.append(name)
        continue
    # The freshest region is the model's age: a nest that failed while CONUS
    # succeeded is a smaller problem than the model not running at all.
    best, best_age, nfields = None, None, 0
    for reg, r in regions.items():
        a = age_hours(r.get("run", ""))
        nfields = max(nfields, len(r.get("fields") or []))
        if a is not None and (best_age is None or a < best_age):
            best, best_age = (reg, r), a
    limit = STALE_AFTER.get(name, DEFAULT_STALE)
    row = (name, best[1].get("run", "?") if best else "?", best_age,
           len(regions), nfields)
    (stale if (best_age is None or best_age > limit) else current).append(row)

def show(rows, colour, word):
    for name, run, age, nreg, nfields in rows:
        aged = "age unknown" if age is None else f"{age:5.1f}h old"
        print(f"   {colour}{word:<8}{OFF} {name:<12} run {run}  {aged}"
              f"  {DIM}{nreg} region(s), {nfields} fields{OFF}")

show(current, GREEN, "current")
show(stale, YELLOW, "stale")
for name in missing:
    label = (MODELS.get(name) or {}).get("label", "")
    print(f"   {RED}{'never':<8}{OFF} {name:<12} "
          f"{DIM}no run on disk{(' - ' + label) if label else ''}{OFF}")

print()
print(f"   {len(current)} current, {len(stale)} stale, {len(missing)} never built"
      f"  (of {len(DEFAULT_MODELS or built)})")
if index.get("updated"):
    print(f"   {DIM}index last written {index['updated']}{OFF}")

# Written where the shell half can act on it without parsing this output.
with open("/tmp/gwcfc_models_todo", "w") as fh:
    fh.write(" ".join(missing + [r[0] for r in stale]))
PYEOF

step "The timer that is supposed to keep them current"
if systemctl --user is-active --quiet gwcfc-models.timer; then
  printf '   \033[32mOK\033[0m   gwcfc-models.timer is running\n'
  systemctl --user list-timers gwcfc-models.timer --no-pager 2>/dev/null \
    | sed -n '2p' | sed 's/^/        /'
else
  printf '   \033[31mBAD\033[0m  gwcfc-models.timer is NOT running\n'
  note "nothing will rebuild on its own. Start it with:"
  note "  systemctl --user enable --now gwcfc-models.timer"
fi
if systemctl --user is-active --quiet gwcfc-models.service; then
  printf '   \033[33m..\033[0m   a build is running RIGHT NOW\n'
  note "watch it with:  journalctl --user -u gwcfc-models -f"
  note "starting another would do nothing, so nothing is started below."
  exit 0
fi

TODO="$(cat /tmp/gwcfc_models_todo 2>/dev/null || true)"

if [ "$MODE" = "look" ]; then
  step "To fix them"
  if [ -z "$TODO" ]; then
    note "nothing to do: every model is current."
  else
    note "rebuild just the ones above that are stale or missing:"
    note "  bash $0 --build"
    note "or rebuild everything, which takes far longer:"
    note "  bash $0 --all"
    note ""
    note "a model that has NEVER built usually has a wrong address rather"
    note "than a build problem, and this says which of the four strings is"
    note "wrong in about a minute:"
    note "  $PY $REPO/pi/check_models.py ${TODO%% *}"
  fi
  exit 0
fi

# ── Building ───────────────────────────────────────────────────────────────
# Run through systemd rather than calling the pipeline directly, so it gets
# the same environment, the same limits and the same log as the timer does.
# A build started by hand in a terminal dies with the terminal; this one does
# not, which matters because a full rebuild outlasts most ssh sessions.
if [ "$MODE" = "all" ]; then
  step "Rebuilding every model"
  systemctl --user start --no-block gwcfc-models.service
else
  if [ -z "$TODO" ]; then
    step "Nothing to rebuild"
    note "every model is current, so no build was started."
    exit 0
  fi
  step "Rebuilding: $TODO"
  # The unit builds the standard list, so naming a subset means running the
  # pipeline with those names. Still detached, for the same reason.
  systemd-run --user --unit="gwcfc-models-fix-$$" --collect \
    --setenv=HOME="$HOME" \
    "$PY" "$REPO/pi/gfs_pipeline.py" $TODO >/dev/null 2>&1 \
    || { note "systemd-run refused, running in this terminal instead."
         note "do NOT close this window until it finishes."
         "$PY" "$REPO/pi/gfs_pipeline.py" $TODO; exit $?; }
fi

note "started. It runs in the background and survives this window closing."
note ""
note "watch it:      journalctl --user -u gwcfc-models -f"
note "check again:   bash $0"
