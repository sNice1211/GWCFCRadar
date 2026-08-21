#!/usr/bin/env python3
"""
The Pi's self update, and the one failure it must never have.

    python3 tools/test-selfupdate.py

The Pi pulls its own code once a minute and restarts what needs restarting.
Nobody logs into it from one month to the next, so the thing that matters is
not how fast it updates: it is that it can never get into a state it cannot
get out of on its own.

There is one way that happens. Someone pulls a feature branch onto the
checkout by hand to try something, that branch is later squash merged, and now
the Pi holds commits that upstream does not have by identity even though it
has every line of them by content. There is no fast forward path, the script
refuses to guess, and the Pi quietly stops updating for good.

So this builds that exact situation with real git repositories and checks the
script climbs out of it. Then it checks the two cases where climbing out would
mean destroying something, because a recovery that eats a Pi-only commit is a
worse bug than the one it fixes.

Real repositories rather than mocks, because what is being tested is git's
behaviour as much as the script's.
"""

import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "pi", "selfupdate.sh")

passed = failed = 0


def ok(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name}" + (f"  <{extra}>" if extra else ""))


def git(cwd, *args):
    return subprocess.run(("git",) + args, cwd=cwd, capture_output=True,
                          text=True)


def run_update(pibox):
    """The self update script, with no venv, exactly as the timer runs it."""
    env = dict(os.environ, REPO=pibox, VENV="/nonexistent")
    r = subprocess.run(["bash", os.path.join(pibox, "pi", "selfupdate.sh")],
                       cwd=pibox, capture_output=True, text=True, env=env)
    return r.stdout + r.stderr


def build():
    """A remote, a working clone, and a "Pi" that pulled a feature branch.

    Returns (workdir, remote, work, pibox) with the Pi already diverged the
    way a squash merge leaves it: same content upstream, different commits.
    """
    w = tempfile.mkdtemp()
    remote = os.path.join(w, "remote.git")
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", remote],
                   check=True)

    work = os.path.join(w, "work")
    os.makedirs(work)
    git(work, "init", "-q", "-b", "main")
    git(work, "config", "user.email", "t@example.com")
    git(work, "config", "user.name", "t")
    os.makedirs(os.path.join(work, "pi"))
    shutil.copy(SCRIPT, os.path.join(work, "pi", "selfupdate.sh"))
    open(os.path.join(work, "f.txt"), "w").write("one\n")
    git(work, "add", "-A")
    git(work, "commit", "-qm", "one")
    git(work, "remote", "add", "origin", remote)
    git(work, "push", "-qu", "origin", "main")

    # A feature branch with two commits on it.
    git(work, "checkout", "-qb", "feat")
    for text in ("two", "three"):
        open(os.path.join(work, "f.txt"), "w").write(text + "\n")
        git(work, "commit", "-qam", text)
    git(work, "push", "-q", "origin", "feat")

    # The Pi: cloned on main, then someone pulled the feature branch by hand.
    pibox = os.path.join(w, "pibox")
    subprocess.run(["git", "clone", "-q", remote, pibox], check=True)
    git(pibox, "config", "user.email", "t@example.com")
    git(pibox, "config", "user.name", "t")
    git(pibox, "pull", "-q", "origin", "feat")

    # Upstream squash merges the branch and moves on, which is what leaves
    # no fast forward path back.
    git(work, "checkout", "-q", "main")
    git(work, "merge", "-q", "--squash", "feat")
    git(work, "commit", "-qm", "squashed")
    open(os.path.join(work, "f.txt"), "w").write("four\n")
    git(work, "commit", "-qam", "four")
    git(work, "push", "-q", "origin", "main")
    return w, remote, work, pibox


print("\n1. a squash merge does not strand the Pi forever")
w, remote, work, pibox = build()
try:
    # The premise: without the recovery there is genuinely no way forward.
    # Fetch first, exactly as the script does. Without it the comparison is
    # against a stale origin/main that is still an ancestor, and the merge
    # cheerfully reports "already up to date" while being three commits
    # behind, which is a trap worth not falling into twice.
    git(pibox, "fetch", "-q", "origin", "main")
    ff = git(pibox, "merge", "--ff-only", "origin/main")
    ok("there really is no fast forward path from here", ff.returncode != 0,
       ff.stdout + ff.stderr)
    ok("and the Pi is holding the old content",
       open(os.path.join(pibox, "f.txt")).read().strip() == "three")

    out = run_update(pibox)
    ok("the script says what it is doing rather than doing it silently",
       "diverged" in out and "resetting" in out, out.strip()[:160])
    ok("and the Pi ends up on the newest upstream content",
       open(os.path.join(pibox, "f.txt")).read().strip() == "four",
       open(os.path.join(pibox, "f.txt")).read().strip())
    # Being on origin/main exactly, not merely containing its content, is
    # what makes the NEXT update a plain fast forward again.
    head = git(pibox, "rev-parse", "HEAD").stdout.strip()
    up = git(pibox, "rev-parse", "origin/main").stdout.strip()
    ok("sitting exactly on it, so the next update is an ordinary one",
       head == up, f"{head[:8]} vs {up[:8]}")

    print("\n2. and it keeps updating normally afterwards")
    open(os.path.join(work, "f.txt"), "w").write("five\n")
    git(work, "commit", "-qam", "five")
    git(work, "push", "-q", "origin", "main")
    out = run_update(pibox)
    ok("an ordinary update still just works",
       open(os.path.join(pibox, "f.txt")).read().strip() == "five")
    ok("without claiming to have recovered from anything",
       "diverged" not in out, out.strip()[:160])

    print("\n3. recovery never destroys something that exists only here")
    # A commit authored on the Pi exists on no remote branch. Resetting past
    # it would be data loss, and no amount of being stuck justifies that.
    open(os.path.join(pibox, "g.txt"), "w").write("local work\n")
    git(pibox, "add", "-A")
    git(pibox, "commit", "-qm", "authored on the pi")
    open(os.path.join(work, "f.txt"), "w").write("six\n")
    git(work, "commit", "-qam", "six")
    git(work, "push", "-q", "origin", "main")
    out = run_update(pibox)
    log = git(pibox, "log", "--oneline", "-1").stdout
    ok("a Pi-only commit is kept", "authored on the pi" in log, log.strip())
    ok("the file it added is still there",
       os.path.exists(os.path.join(pibox, "g.txt")))
    ok("and the script explains itself instead of failing mutely",
       "cannot fast-forward" in out and "exist nowhere else" in out,
       out.strip()[:200])

    print("\n4. nor an edit that was never committed at all")
    git(pibox, "reset", "-q", "--hard", "origin/main")
    open(os.path.join(pibox, "f.txt"), "w").write("half finished edit\n")
    open(os.path.join(work, "f.txt"), "w").write("seven\n")
    git(work, "commit", "-qam", "seven")
    git(work, "push", "-q", "origin", "main")
    out = run_update(pibox)
    ok("an uncommitted edit survives",
       open(os.path.join(pibox, "f.txt")).read().strip() == "half finished edit",
       open(os.path.join(pibox, "f.txt")).read().strip())

    print("\n5. the ordinary paths are untouched")
    ok("a fetch that fails is not treated as a reason to reset",
       "fetch failed, will try again next time" in open(SCRIPT).read())
    src = open(SCRIPT).read()
    ok("recovery is guarded on a clean tree",
       "git status --porcelain" in src)
    ok("and on every extra commit existing on some remote branch",
       "branch -r --contains" in src)
    # serve.py holds code in memory, so it is the one thing a pull alone does
    # not update. This is the check that it is still wired up.
    ok("the long running server is still restarted when its code changes",
       "gwcfc-serve.service" in src and "sounding_service" in src)
finally:
    shutil.rmtree(w, ignore_errors=True)

print()
if failed:
    print(f"{failed} FAILED, {passed} passed")
    sys.exit(1)
print(f"all {passed} passed")
