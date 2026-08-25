#!/usr/bin/env bash
# Pull the newest code, and restart only what needs restarting.
#
# The model and radar pipelines are oneshot units fired by timers, so they read
# the files fresh every time they run and need nothing done to them. serve.py
# is different: it is a long running process holding the old code in memory, so
# it has to be told.
#
# Run by gwcfc-update.timer. Safe to run by hand.
set -uo pipefail

REPO="${REPO:-$HOME/GWCFCRadar}"
VENV="${VENV:-$HOME/wxenv}"
cd "$REPO" || exit 1

BEFORE=$(git rev-parse HEAD 2>/dev/null)
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)

# Fetch and fast-forward only. A merge that is not a fast-forward means the Pi
# has commits of its own, and quietly throwing those away is not this script's
# decision to make: it says so and leaves them alone.
#
# The fetch is retried, because on home wifi a single failure means nothing.
# A Pi pulling a large pack drops it often enough ("RPC failed... curl 56
# Recv failure", "fatal: unpack-objects failed") that giving up on the first
# try left the machine silently running old code for hours, and a failed
# update is invisible from the outside: every fix shipped upstream just
# looks like it did not work. The low-speed settings stop git abandoning a
# slow stretch instead of a genuinely dead link.
fetch_once() {
  git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60 \
      -c http.postBuffer=524288000 \
      fetch --quiet origin "$BRANCH" 2>&1
}
FETCHED=0
DELAY=2
for attempt in 1 2 3 4; do
  if OUT=$(fetch_once); then FETCHED=1; break; fi
  [ "$attempt" = 4 ] && break
  echo "fetch attempt $attempt failed, retrying in ${DELAY}s"
  sleep "$DELAY"
  DELAY=$((DELAY * 2))
done
if [ "$FETCHED" != 1 ]; then
  echo "fetch failed four times, will try again next time"
  printf '%s\n' "$OUT" | tail -n 3
  exit 0
fi
if ! git merge --ff-only --quiet "origin/$BRANCH" 2>/dev/null; then
  # Diverged. Usually that means someone pulled a feature branch onto this
  # checkout by hand and it later got squash merged: the work is upstream,
  # but as one new commit rather than the ones sitting here, so there is no
  # fast-forward path and the Pi would stop updating for good. On a machine
  # nobody can log into, "stops updating for good" is the worst outcome
  # there is, so it is worth recovering from automatically.
  #
  # It is only safe to recover when nothing here would be lost, which means
  # both of these, checked rather than assumed:
  #
  #   - the working tree is clean, so no uncommitted edits are thrown away
  #   - every commit this branch has that upstream does not is also sitting
  #     on some other remote branch, which means it was fetched rather than
  #     written here. A commit authored on the Pi exists nowhere else, and
  #     that is exactly the case this must refuse.
  RECOVER=1
  if ! git diff --quiet HEAD 2>/dev/null || [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    RECOVER=0
  fi
  if [ "$RECOVER" = 1 ]; then
    for sha in $(git rev-list "origin/$BRANCH..HEAD" 2>/dev/null); do
      if [ -z "$(git branch -r --contains "$sha" 2>/dev/null)" ]; then
        RECOVER=0
        break
      fi
    done
  fi
  # One more shape that is provably lossless, and the commonest one here: a
  # plain `git pull` on a branch that had moved writes a MERGE commit,
  # authored on this machine and existing nowhere else, so the check above
  # refuses it forever. A merge carries no work of its own, only a join. If
  # every extra commit is a merge, this checkout contains nothing that was
  # written here, and resetting can lose nothing because there is nothing
  # here to lose. A single real commit and this does not apply.
  if [ "$RECOVER" = 0 ] && [ -z "$(git status --porcelain 2>/dev/null)" ] \
     && [ -z "$(git log --oneline --no-merges "origin/$BRANCH..HEAD" 2>/dev/null)" ] \
     && [ -n "$(git rev-list "origin/$BRANCH..HEAD" 2>/dev/null)" ]; then
    echo "drifted only by merge commits with no work of their own"
    RECOVER=1
  fi
  if [ "$RECOVER" = 1 ]; then
    echo "diverged from origin/$BRANCH, but nothing here is unique to this"
    echo "machine, so resetting onto it."
    git reset --hard --quiet "origin/$BRANCH" || exit 0
  else
    echo "cannot fast-forward $BRANCH: the Pi has local commits or edits"
    echo "that exist nowhere else. Nothing was changed, because throwing"
    echo "them away is not this script's decision to make."
    echo "Run 'git status' and 'git log origin/$BRANCH..HEAD' here to see."
    exit 0
  fi
fi

AFTER=$(git rev-parse HEAD)
CHANGED=1
[ "$BEFORE" = "$AFTER" ] && CHANGED=0
[ "$CHANGED" = 1 ] && \
  echo "updated $(git rev-parse --short "$BEFORE") -> $(git rev-parse --short "$AFTER")"

# Only the long running one. Restarting the timers here would fire them all at
# once on every update, which is a stampede rather than a refresh.
# serve.py, and anything serve.py imports. sounding_service.py is the second
# kind: serve.py imports it to answer /sounding, so a change to it is a change
# to the running server even though serve.py itself did not move.
if [ "$CHANGED" = 1 ] && git diff --name-only "$BEFORE" "$AFTER" \
   | grep -qE '^pi/(serve|sounding_service)\.py$'; then
  systemctl --user restart gwcfc-serve.service && echo "restarted serve"
fi

# If the unit files themselves changed, the installer is what writes them.
# It used to only SAY so, which assumed a person would read the log and run
# it - and nobody may be able to log into this machine at all. So it runs,
# detached, because the installer can take minutes and this unit has a five
# minute timeout.
#
# The wanting and the running are separate on purpose, through a marker file
# outside the repository. If this run is killed before the launch happens,
# CHANGED=1 never comes again for this commit - but the marker is already on
# disk, so the next minute's run still launches the installer. The marker is
# only removed once a launch actually succeeded.
WANT_INSTALL="$HOME/.gwcfc-install-wanted"
if [ "$CHANGED" = 1 ] && git diff --name-only "$BEFORE" "$AFTER" \
   | grep -q '^pi/install\.sh$'; then
  touch "$WANT_INSTALL"
fi
# The state check, not just the edge. The commit that adds a new unit is
# applied by the PREVIOUS self-updater - the one running when it lands - and
# that one may only have announced the change. So do not rely on having seen
# the commit go by: if the installer defines a unit this machine does not
# have, an install is wanted, whenever and however that came to be.
#
# Every unit the installer writes, not one named one. This used to name
# gwcfc-snd.timer alone, which caught that unit and nothing added after it:
# each new service needed this line edited too, and forgetting was silent,
# because a machine that never installs a timer never reports a failure from
# it. Reading the names out of the installer means the list cannot go stale.
#
# Matched on the line that WRITES a unit, not on any mention of one. The
# installer also names units it deletes: gwcfc-obs was removed with the
# feature, and a looser pattern picks it up, finds it correctly absent, and
# asks for a reinstall on every single run, forever.
for u in $(grep -o 'cat > "\$UNITS/gwcfc-[a-z-]*\.\(service\|timer\)"' \
             "$REPO/pi/install.sh" 2>/dev/null \
           | sed 's|.*/||; s|"$||' | sort -u); do
  if [ ! -f "$HOME/.config/systemd/user/$u" ]; then
    echo "  $u is defined but not installed on this box"
    touch "$WANT_INSTALL"
  fi
done
if [ -f "$WANT_INSTALL" ]; then
  echo "install.sh changed: running it to register anything new"
  if command -v systemd-run >/dev/null 2>&1 && \
     systemd-run --user --collect --unit "gwcfc-reinstall-$(date +%s)" \
       /usr/bin/env bash "$REPO/pi/install.sh" >/dev/null 2>&1; then
    echo "  running detached; journalctl --user -u 'gwcfc-reinstall-*' shows it"
    rm -f "$WANT_INSTALL"
  elif ( nohup bash "$REPO/pi/install.sh" </dev/null \
           >>"$HOME/.gwcfc-install.log" 2>&1 & ); then
    echo "  running in the background; log: ~/.gwcfc-install.log"
    rm -f "$WANT_INSTALL"
  fi
fi

# Whether to look at the Python packages at all on this run.
#
# This used to happen only when a commit had just landed, which is fine for
# "a new commit needs a new package" and useless for the case that actually
# bites: pip losing its connection to PyPI halfway through an install. That
# leaves the venv missing something, no commit is coming to trigger a retry,
# and nothing notices until somebody clicks a point on the map and gets an
# error. Nobody may be able to log in to fix it.
#
# So it also runs on a timer of its own. Not every minute: importing xarray
# and metpy takes real seconds on a Pi and this shares a machine with the
# radar builds. Every half hour is often enough that a dropped install heals
# itself well before anyone notices, and rare enough to cost nothing.
# Deliberately outside the repository. A stamp file inside it would show up
# as an untracked file in git status, which is exactly what the recovery
# above refuses to reset over, so the Pi would be stranded by the very file
# meant to keep it healthy.
STAMP="$HOME/.gwcfc-deps-checked"
DEPS=0
[ "$CHANGED" = 1 ] && DEPS=1
if [ "$DEPS" = 0 ]; then
  if [ ! -f "$STAMP" ] || [ -n "$(find "$STAMP" -mmin +30 2>/dev/null)" ]; then
    DEPS=1
  fi
fi
if [ "$DEPS" = 0 ]; then
  exit 0                      # current, checked recently, nothing worth saying
fi
touch "$STAMP" 2>/dev/null || true

# New Python dependency, occasionally. Cheap to check and it is the failure
# that looks like a broken pipeline rather than a missing package: the radar
# service failing on a MetPy import is exactly how this bit the last time.
for mod in eccodes metpy netCDF4 xarray siphon cfgrib matplotlib \
           bs4 ecape_parcel cdsapi; do
  "$VENV/bin/python" -c "import $mod" >/dev/null 2>&1 || {
    echo "installing missing $mod"
    "$VENV/bin/pip" install --quiet "$mod" || echo "  could not install $mod"
  }
done

# The sounding libraries, which need --no-deps and therefore cannot go in the
# loop above. They are here rather than only in install.sh because pip talking
# to PyPI is not reliable on a home connection: a dropped connection halfway
# through leaves the venv without them and nothing notices until somebody
# clicks a point on the map and gets an error. install.sh is a thing a person
# runs; this runs every minute, so a failed install simply gets retried until
# it works, with nobody having to log in.
#
# --no-deps because both packages list dependencies they do not actually need
# here. SHARPpy pins a NumPy that cannot build on current Python, and SounderPy
# lists two plotting libraries for a machine that never plots anything. What
# they really use at runtime is installed by name in the loop above.
for mod in sounderpy sharppy; do
  "$VENV/bin/python" -c "import $mod" >/dev/null 2>&1 || {
    echo "installing missing $mod"
    "$VENV/bin/pip" install --quiet --no-deps "$mod" \
      || echo "  could not install $mod, will try again next time"
  }
done

