#!/usr/bin/env bash
# One command that runs every repair, for when typing is the hard part.
#
#     bash ~/GWCFCRadar/pi/fix.sh
#
# doctor.sh finds what is wrong and prints the commands to fix it. This runs
# them, in the order that matters: newest code first, because every other fix
# ships inside it, then the missing packages, then the restarts, then it says
# where things stand.
#
# Safe to run at any time, and safe to run twice. It installs and restarts.
# It deletes nothing, and it touches no weather data.
#
# On its first run it also leaves two shortcuts behind, so that after this
# the whole thing is four letters:
#
#     gwfix     run this again
#     gwdoc     just look, change nothing
set -uo pipefail

REPO="${REPO:-$HOME/GWCFCRadar}"
VENV="${VENV:-$HOME/wxenv}"
PY="$VENV/bin/python"
PIP="$VENV/bin/pip"

step() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
good() { printf '   \033[32mOK\033[0m   %s\n' "$*"; }
bad()  { printf '   \033[31mBAD\033[0m  %s\n' "$*"; }
note() { printf '        %s\n' "$*"; }

step "1 of 5   Newest code"
if ! cd "$REPO" 2>/dev/null; then
  bad "there is no checkout at $REPO, so there is nothing to fix"
  exit 1
fi
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
BEFORE=$(git rev-parse --short HEAD 2>/dev/null)
if [ -z "$BRANCH" ]; then
  bad "$REPO is not a git checkout"
else
  # The branch this checkout is already on, never a different one. Merging
  # main into a feature branch here would create a commit that exists only on
  # this machine, and the self-updater is right to refuse to fast-forward past
  # one of those. It would quietly end automatic updates forever.
  #
  # Retried, because a Pi on home wifi drops a large pack often enough that
  # one failure means nothing. That is exactly how this machine ended up
  # running week-old code while every shipped fix looked like it did nothing.
  PULLED=0
  DIVERGED=0
  DELAY=2
  for attempt in 1 2 3 4; do
    if OUT=$(git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60 \
                 -c http.postBuffer=524288000 \
                 pull --quiet --ff-only origin "$BRANCH" 2>&1); then
      PULLED=1
      break
    fi
    # A refusal to fast-forward is not a network problem and will refuse
    # identically four times in a row. selfupdate.sh is the thing that knows
    # how to recover from it safely, so say so rather than burning the waits.
    case "$OUT" in
      *"fast-forward"*|*"diverg"*|*"Not possible"*)
        DIVERGED=1
        break ;;
    esac
    [ "$attempt" = 4 ] && break
    note "attempt $attempt did not finish, trying again in ${DELAY}s"
    sleep "$DELAY"
    DELAY=$((DELAY * 2))
  done
  AFTER=$(git rev-parse --short HEAD 2>/dev/null)
  if [ "$PULLED" = 1 ] && [ "$BEFORE" = "$AFTER" ]; then
    good "already the newest code ($AFTER on $BRANCH)"
  elif [ "$PULLED" = 1 ]; then
    good "updated $BEFORE to $AFTER on $BRANCH"
  elif [ "$DIVERGED" = 1 ]; then
    # There is one shape of divergence that is provably lossless to undo, and
    # it is by far the commonest one here: a plain `git pull` on a branch that
    # had moved created a MERGE commit, authored on this machine and existing
    # nowhere else. It carries no work of its own, only a join.
    #
    # The test is exact rather than hopeful. If every extra commit reachable
    # from here is a merge, then this checkout contains no change that was
    # written here, and resetting onto origin can lose nothing, because there
    # is nothing here to lose. Anything else, including a single real commit,
    # falls through and is left alone.
    OWN=$(git log --oneline --no-merges "origin/$BRANCH..HEAD" 2>/dev/null)
    DIRTY=$(git status --porcelain 2>/dev/null)
    if [ -z "$OWN" ] && [ -z "$DIRTY" ]; then
      note "this checkout had drifted, but only by merge commits with no work"
      note "of their own, so putting it back on origin/$BRANCH loses nothing."
      if git reset --hard --quiet "origin/$BRANCH" 2>/dev/null; then
        AFTER=$(git rev-parse --short HEAD 2>/dev/null)
        PULLED=1
        good "recovered onto $AFTER, and it can update itself again"
      else
        bad "could not reset onto origin/$BRANCH"
      fi
    else
      bad "this checkout has work of its own, so it cannot fast-forward"
      note "nothing was changed, because throwing it away is not this"
      note "script's decision to make. What is only here:"
      [ -n "$OWN" ] && printf '%s\n' "$OWN" | head -5 | sed 's/^/          /'
      [ -n "$DIRTY" ] && note "  and uncommitted edits to $(printf '%s\n' "$DIRTY" | wc -l) file(s)"
    fi
  else
    bad "could not get the newest code"
    printf '%s\n' "$OUT" | tail -n 2 | sed 's/^/        /'
    note "a dropped connection looks exactly like this. Run this again."
    note "everything below is being fixed against OLD code until it works."
  fi
fi

step "2 of 5   Missing packages"
if [ ! -x "$PY" ]; then
  bad "no python at $PY. Run: bash $REPO/pi/install.sh"
else
  # Only what is actually missing, so a healthy Pi spends no time here and
  # no bandwidth on a link that may already be struggling.
  NEEDED=()
  for m in eccodes metpy netCDF4 matplotlib xarray siphon cfgrib bs4 \
           ecape_parcel cdsapi; do
    "$PY" -c "import $m" >/dev/null 2>&1 || NEEDED+=("$m")
  done
  if [ "${#NEEDED[@]}" -eq 0 ]; then
    good "every data package is present"
  else
    note "installing: ${NEEDED[*]}"
    if "$PIP" install --quiet "${NEEDED[@]}"; then
      good "installed ${#NEEDED[@]}"
    else
      bad "at least one would not install; run it again on a better connection"
    fi
  fi
  # These two are asked for with find_spec rather than a plain import,
  # because a plain import of SounderPy fails BY DESIGN here: it is installed
  # with --no-deps, so the two drawing libraries it loads are absent and
  # sounding_service stands in for them. Importing it to test would say
  # "missing" about a package that is installed and working perfectly.
  for m in sounderpy sharppy; do
    if ! "$PY" -c \
        "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('$m') else 1)" \
        >/dev/null 2>&1; then
      note "installing $m"
      "$PIP" install --quiet --no-deps "$m" || bad "$m would not install"
    fi
  done
  good "sounding libraries checked"
fi

step "3 of 5   Restarting what holds code in memory"
# The pipelines are one-shot jobs fired by timers, so they read the new files
# on their own next run and need nothing done to them. These are long running
# processes still holding the old code, so they have to be told.
for unit in gwcfc-serve gwcfc-publish; do
  if systemctl --user restart "$unit" 2>/dev/null; then
    good "$unit restarted"
  else
    bad "$unit would not restart. Run: bash $REPO/pi/install.sh"
  fi
done

# The tunnel is NOT in that list, and leaving it out is the fix rather than an
# oversight.
#
# A quick tunnel is handed a brand new random address every time it starts.
# Restarting it here therefore threw the working address away on every single
# run, and for the next minute the site was pointed at one that had just died.
# This script was called ten times today and the log shows ten starts on eight
# addresses: the repair tool was the single largest cause of the fault it was
# being run to repair.
#
# It carries no code of ours, so a new version never needs it restarted. The
# only reason to touch it is that it is not working, so that is now the only
# time it is touched.
if systemctl --user is-active --quiet gwcfc-tunnel \
   && [ -x "$PY" ] \
   && "$PY" - <<PYEOF >/dev/null 2>&1
import sys
sys.path.insert(0, "$REPO/pi")
import publish_url as p
f = p.candidates()
sys.exit(0 if (f and p.answers(f[0], timeout=8)) else 1)
PYEOF
then
  good "gwcfc-tunnel is carrying traffic, so its address is left alone"
else
  if systemctl --user restart gwcfc-tunnel 2>/dev/null; then
    good "gwcfc-tunnel restarted, since it was not carrying traffic"
    note "this rolls a new address; the publisher will catch up in a moment"
  else
    bad "gwcfc-tunnel would not restart. Run: bash $REPO/pi/install.sh"
  fi
fi

step "4 of 5   Timers"
for t in gwcfc-models gwcfc-radar gwcfc-sat gwcfc-snd gwcfc-cyclones gwcfc-update; do
  systemctl --user enable --now "$t.timer" >/dev/null 2>&1 \
    && good "$t.timer running" \
    || bad "$t.timer is not installed. Run: bash $REPO/pi/install.sh"
done

step "5 of 5   Where things stand"
# The tunnel needs a moment after a restart: cloudflared has to be handed an
# address, and then that name has to reach Cloudflare's edge before anything
# can be fetched through it. For those few seconds the address is real,
# correct, and does not work. --check waits on its own now, so this only
# gives cloudflared time to print the thing at all.
note "waiting for the tunnel to come up. This part takes about a minute."
sleep 10
if [ -x "$PY" ]; then
  # And if the address does not work, go straight on to WHY, rather than
  # ending on a failure and a second command to type. The three reasons a
  # tunnel carries no traffic have completely different fixes and cannot be
  # told apart from the address alone.
  # Publish before checking, not after failing.
  #
  # The watcher is meant to notice a new address within a minute, and every
  # run of this script has ended with "the site is pointed somewhere else"
  # anyway. Whatever is wrong with it, the person who ran this wants the site
  # working when it finishes, and one forced publish costs a second and needs
  # nothing to be diagnosed first. --force only skips the "unchanged, so
  # nothing to do" shortcut; it still refuses to publish an address that does
  # not answer, so it cannot make things worse.
  "$PY" "$REPO/pi/publish_url.py" --force >/dev/null 2>&1 || true
  "$PY" "$REPO/pi/publish_url.py" --check || {
    printf '\n'
    "$PY" "$REPO/pi/tunnel_doctor.py"
    # "Name or service not known" is not a wrong address. It is a question
    # nobody answered, and no amount of restarting the tunnel fixes a name
    # server that does not reply. That needs root, so it is offered rather
    # than done.
    if ! getent hosts cloudflare.com >/dev/null 2>&1; then
      printf '\n\033[1;33m   This Pi cannot look up names at all, which is'
      printf ' underneath every\n   failure above. Fix that first:\033[0m\n'
      printf '     sudo bash %s/pi/fixnet.sh\n' "$REPO"
    fi
  }
fi

# Left behind on the first run only, because the whole point of this file is
# that the next repair should not have to be typed out.
BRC="$HOME/.bashrc"
if [ -f "$BRC" ] && ! grep -q "alias gwfix=" "$BRC" 2>/dev/null; then
  {
    echo ""
    echo "# GWCFCRadar shortcuts, added by pi/fix.sh"
    echo "alias gwfix='bash \$HOME/GWCFCRadar/pi/fix.sh'"
    echo "alias gwdoc='bash \$HOME/GWCFCRadar/pi/doctor.sh'"
  } >> "$BRC"
  printf '\n\033[1;33m   From now on, this whole thing is:  gwfix\033[0m\n'
  printf '   And to only look without changing anything:  gwdoc\n'
  printf '   Close this window and open a new one first.\n'
fi

printf '\n   If anything above is still BAD, the full report is:\n'
printf '     bash %s/pi/doctor.sh\n\n' "$REPO"
