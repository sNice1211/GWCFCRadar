#!/usr/bin/env python3
"""
The disk, which is the one resource here that does not fail gracefully.

    python3 tools/test-disk-guard.py

Everything else in these pipelines degrades. A model that will not download
leaves the last one on screen. A radar site that times out is skipped. An
MRMS product that 404s backs itself off. A full SD card does none of that: it
takes apt down, it takes git down, it takes the virtual environment down, and
the three errors it then produces look like three unrelated problems.

    fatal: unable to write loose object file: No space left on device
    W: Failed to fetch http://deb.debian.org/... Error writing to file
    ERROR: Could not install packages due to an OSError: [Errno 28]

One cause, and none of those messages says "disk" first.

Three days of frames is a promise the disk has to be able to keep, and it was
made without asking whether it could. This checks the asking: that retention
steps down as the card fills, that a build stops before the card is full
rather than after, and that install.sh refuses to half install into a disk
with no room in it.

Parsed and exercised rather than imported, so it runs without eccodes.
"""

import ast
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GFS = os.path.join(ROOT, "pi", "gfs_pipeline.py")
RADAR = os.path.join(ROOT, "pi", "radar_pipeline.py")
SAT = os.path.join(ROOT, "pi", "satellite_pipeline.py")
INSTALL = os.path.join(ROOT, "pi", "install.sh")

passed = failed = 0


def ok(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name}" + (f"  <{extra}>" if extra else ""))


gfs_src = open(GFS, encoding="utf-8").read()
radar_src = open(RADAR, encoding="utf-8").read()
sat_src = open(SAT, encoding="utf-8").read()
install_src = open(INSTALL, encoding="utf-8").read()

# The guard, compiled alone. It needs nothing but os.
ns = {"os": os}
WANT = {"DISK_FLOOR_MB", "free_mb", "hours_for_disk", "disk_ok"}
for node in ast.parse(gfs_src).body:
    name = getattr(node, "name", None) or (
        getattr(node.targets[0], "id", "") if isinstance(node, ast.Assign) else "")
    if name in WANT:
        exec(ast.get_source_segment(gfs_src, node), ns)
missing = WANT - set(ns)
if missing:
    print(f"the guard is not there: {sorted(missing)}")
    sys.exit(1)

FLOOR = ns["DISK_FLOOR_MB"]


print("\n1. free space is measured, not assumed")
real = ns["free_mb"](ROOT)
ok("it reads a real number off a real filesystem",
   0 < real < 1e9, f"{real:.0f} MB")
# A guard that cannot read the disk must not be the reason nothing gets
# built, so unknowable is treated as plenty rather than as nothing.
ok("a path that cannot be read is treated as plenty, not as full",
   ns["free_mb"]("/this/does/not/exist/anywhere") > 0,
   str(ns["free_mb"]("/this/does/not/exist/anywhere")))


print("\n2. retention is what fits, not what was asked for")
_real_free = ns["free_mb"]
fake = {"mb": 0.0}
ns["free_mb"] = lambda p: fake["mb"]
# hours_for_disk closes over the module namespace, so replacing the name is
# enough to drive it through every step.
exec(ast.get_source_segment(gfs_src, next(
    n for n in ast.parse(gfs_src).body
    if getattr(n, "name", "") == "hours_for_disk")), ns)


def hours(mb, want=72):
    fake["mb"] = mb
    return ns["hours_for_disk"]("/", want)


ok("plenty of room keeps the full three days", hours(FLOOR * 3) == 72,
   str(hours(FLOOR * 3)))
ok("comfortable room keeps it too", hours(FLOOR * 2) == 72, str(hours(FLOOR * 2)))
ok("getting tight drops to a day", hours(FLOOR * 1.5) == 24.0,
   str(hours(FLOOR * 1.5)))
ok("tight drops to six hours", hours(FLOOR * 0.75) == 6.0, str(hours(FLOOR * 0.75)))
ok("nearly full keeps only the last couple of hours",
   hours(10) == 2.0, str(hours(10)))
# Never MORE than was asked for: a nearly empty disk does not license
# keeping a week when the setting says six hours.
ok("and it never keeps more than was asked for",
   hours(FLOOR * 10, want=6) == 6, str(hours(FLOOR * 10, want=6)))
# Stepped, not smooth. A window that drifted a little every pass would delete
# frames one at a time forever and never settle anywhere.
steps = {hours(mb) for mb in (10, 200, 700, 1200, 1900, 2600, 4000, 9000)}
ok("the steps are a handful of decisions, not a sliding scale",
   len(steps) <= 4, str(sorted(steps)))
# Monotonic: more room can never mean less history.
seq = [hours(mb) for mb in (10, 500, 1000, 1600, 2200, 3100, 8000)]
ok("and more room never means less history",
   all(b >= a for a, b in zip(seq, seq[1:])), str(seq))


print("\n3. a build stops before the card is full, not after")
fake["mb"] = FLOOR
ok("there is room when there is room", ns["disk_ok"]("/"))
fake["mb"] = 10
ok("and none when there is none", not ns["disk_ok"]("/"))
# The stop has to bite while there is still room to write the thing already
# in flight, or the guard fires on the write that fails.
fake["mb"] = FLOOR / 4
ok("it bites with room still to spare, rather than at zero",
   not ns["disk_ok"]("/"), f"{FLOOR / 4:.0f} MB")
ns["free_mb"] = _real_free


print("\n4. every pruner asks the disk first")
for label, src in (("radar frames", radar_src), ("satellite frames", sat_src)):
    ok(f"the {label} pruner shortens its window to fit",
       "hours_for_disk(" in src, "not wired")
ok("and so does MRMS", radar_src.count("hours_for_disk(") >= 2,
   str(radar_src.count("hours_for_disk(")))
# The MRMS pass is the one that writes the most files, so it also has the
# hard stop rather than only the softer retention.
ok("the MRMS build stops mid pass when the disk runs low",
   "if not disk_ok(out):" in radar_src)
ok("and says how much is left rather than just stopping",
   "free_mb(out)" in radar_src)
ok("the floor can be changed without editing code",
   "GWCFC_DISK_FLOOR_MB" in gfs_src)


print("\n5. install.sh refuses to half install into a full disk")
ok("it checks before it downloads anything",
   install_src.index('say "Disk space"') < install_src.index('say "System packages"'))
ok("and stops rather than trying anyway", re.search(
    r'warn "stopping here rather than half installing[\s\S]{0,80}exit 1', install_src)
    is not None)
# Three unrelated-looking errors, one cause. The fix has to be printed, not
# described, because whoever is reading it is at a prompt with no room to
# install anything that would help.
for cmd in ("apt clean", "cache/pip", "journalctl --vacuum-size",
            "du -sh ~/wxdata"):
    ok(f"it prints the command for {cmd}", cmd in install_src)
ok("and says plainly that frames rebuild themselves, so deleting is safe",
   "rebuild themselves" in install_src)

# Driven for real, with df standing in, because a shell condition that reads
# right and compares strings is a shell condition that is always false.
snippet = "\n".join([
    'say() { printf "== %s\\n" "$*"; }',
    'ok(){ printf "   ok %s\\n" "$*"; }',
    'warn(){ printf "   !! %s\\n" "$*"; }',
    re.search(r'say "Disk space"[\s\S]*?\nfi\n', install_src).group(0),
])
tmp = tempfile.mkdtemp()
binp = os.path.join(tmp, "bin")
os.makedirs(binp)
script = os.path.join(tmp, "check.sh")
open(script, "w").write(snippet)


def run_with_free(mb):
    with open(os.path.join(binp, "df"), "w") as fh:
        fh.write('#!/bin/sh\necho "F 1M Used Avail Use% M"\n'
                 f'echo "/dev/root 30000 100 {mb} 5% /"\n')
    os.chmod(os.path.join(binp, "df"), 0o755)
    env = dict(os.environ, PATH=binp + os.pathsep + os.environ.get("PATH", ""))
    p = subprocess.run(["bash", script], capture_output=True, text=True, env=env)
    return p.returncode, p.stdout


code, out = run_with_free(300)
ok("a full disk really does stop the install", code == 1, f"exit {code}")
ok("and really does print the way out", "apt clean" in out, out[:120])
code, out = run_with_free(1500)
ok("a tight disk installs, with a warning about the shorter window",
   code == 0 and "three days" in out, f"exit {code}: {out[:120]}")
code, out = run_with_free(9000)
ok("and a healthy disk says so and carries on",
   code == 0 and "enough room" in out, f"exit {code}: {out[:120]}")

print()
if failed:
    print(f"{failed} FAILED, {passed} passed")
    sys.exit(1)
print(f"all {passed} passed")
