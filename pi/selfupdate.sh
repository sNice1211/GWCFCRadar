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
git fetch --quiet origin "$BRANCH" || { echo "fetch failed, will try again next time"; exit 0; }
if ! git merge --ff-only --quiet "origin/$BRANCH" 2>/dev/null; then
  echo "cannot fast-forward $BRANCH: the Pi has local commits or edits."
  echo "Nothing was changed. Run 'git status' here to see what."
  exit 0
fi

AFTER=$(git rev-parse HEAD)
if [ "$BEFORE" = "$AFTER" ]; then
  exit 0                      # already current, and nothing is worth saying
fi
echo "updated $(git rev-parse --short "$BEFORE") -> $(git rev-parse --short "$AFTER")"

# New Python dependency, occasionally. Cheap to check and it is the failure
# that looks like a broken pipeline rather than a missing package: the radar
# service failing on a MetPy import is exactly how this bit the last time.
for mod in eccodes metpy; do
  "$VENV/bin/python" -c "import $mod" >/dev/null 2>&1 || {
    echo "installing missing $mod"
    "$VENV/bin/pip" install --quiet "$mod" || echo "  could not install $mod"
  }
done

# Only the long running one. Restarting the timers here would fire them all at
# once on every update, which is a stampede rather than a refresh.
if git diff --name-only "$BEFORE" "$AFTER" | grep -q '^pi/serve\.py$'; then
  systemctl --user restart gwcfc-serve.service && echo "restarted serve"
fi

# If the unit files themselves changed, the installer is what writes them, so
# say so rather than pretending an update was complete when it was not.
if git diff --name-only "$BEFORE" "$AFTER" | grep -q '^pi/install\.sh$'; then
  echo "install.sh changed: run 'bash pi/install.sh' to pick up new units"
fi
