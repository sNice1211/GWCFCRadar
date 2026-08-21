#!/usr/bin/env python3
"""
Three days of frames on disk, and the budget that keeps them there.

    python3 tools/test-retention.py

Playback can only reach as far back as the Pi still has frames for, so the
retention window is the feature. Asking for three days is easy; surviving
three days on an SD card is the part that needs thinking about, and both
halves are checked here.

The window on its own is not a budget. A radar site scanning every four
minutes produces about eleven hundred frames inside three days, a mesoscale
satellite sector rebuilding every ten minutes produces four hundred, and MRMS
has thirty-eight products doing it at once. So every pruner has a count
ceiling as well as an age cutoff, and the ceiling is what actually stops the
card filling on a busy severe-weather day.

The pruners are exercised against real directories on a temporary disk rather
than parsed, because "does it delete the right folders" is not a question you
can answer by reading the source. The rest is parsed, so this runs without
eccodes, metpy or numpy installed.
"""

import ast
import os
import shutil
import sys
import tempfile
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RADAR = os.path.join(ROOT, "pi", "radar_pipeline.py")
SAT = os.path.join(ROOT, "pi", "satellite_pipeline.py")

passed = failed = 0


def ok(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name}" + (f"  <{extra}>" if extra else ""))


radar_src = open(RADAR, encoding="utf-8").read()
sat_src = open(SAT, encoding="utf-8").read()
gfs_src = open(os.path.join(ROOT, "pi", "gfs_pipeline.py"), encoding="utf-8").read()

# The pruners ask the disk how long a window it can afford before they use
# one, so the real guard is compiled in beside them rather than stubbed. The
# temporary directories below sit on a disk with room, so it answers with the
# window that was asked for and these tests measure the pruning itself. What
# the guard does when the disk is FULL is tools/test-disk-guard.py's job.
DISK = {"os": os}
for _n in ast.parse(gfs_src).body:
    _name = getattr(_n, "name", None) or (
        getattr(_n.targets[0], "id", "") if isinstance(_n, ast.Assign) else "")
    if _name in ("DISK_FLOOR_MB", "free_mb", "hours_for_disk", "disk_ok"):
        exec(ast.get_source_segment(gfs_src, _n), DISK)


def compile_from(src, names, extra=None):
    """The named top-level functions, compiled alone with only what they need."""
    ns = {"os": os, "datetime": datetime, "timedelta": timedelta,
          "timezone": timezone, "shutil": shutil,
          "hours_for_disk": DISK["hours_for_disk"],
          "free_mb": DISK["free_mb"], "disk_ok": DISK["disk_ok"]}
    ns.update(extra or {})
    tree = ast.parse(src)
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in names:
            exec(ast.get_source_segment(src, node), ns)
    for n in names:
        assert n in ns, f"{n} not found"
    return ns


def const(src, name):
    """A module constant that is an os.environ.get with a default."""
    for node in ast.parse(src).body:
        if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "") == name:
            seg = ast.get_source_segment(src, node.value)
            # float(os.environ.get("X", "72")) -> 72
            for part in seg.split('"'):
                try:
                    return float(part)
                except ValueError:
                    continue
    raise AssertionError(f"{name} not found")


print("\n1. every window really is three days")
RK = const(radar_src, "KEEP_HOURS")
MK = const(radar_src, "MRMS_KEEP_HOURS")
SK = const(sat_src, "KEEP_HOURS")
ok("radar keeps 72 hours", RK >= 72, str(RK))
ok("MRMS keeps 72 hours", MK >= 72, str(MK))
ok("satellite keeps 72 hours", SK >= 72, str(SK))
ok("and every one can be changed without editing code",
   all(f'GWCFC_{v}' in s for v, s in
       [("RADAR_KEEP_HOURS", radar_src), ("MRMS_KEEP_HOURS", radar_src),
        ("SAT_KEEP_HOURS", sat_src)]))

print("\n2. and every one has a ceiling as well, because a window is not a budget")
RM = const(radar_src, "MAX_FRAMES")
MM = const(radar_src, "MRMS_MAX_FRAMES")
SM = const(sat_src, "MAX_FRAMES")
ok("radar caps its frame count", RM >= 500, str(RM))
ok("MRMS caps its frame count", MM >= 300, str(MM))
ok("satellite caps its frame count", SM >= 200, str(SM))
# Three days at the real cadences: radar about every 4 min, satellite every
# 10. A ceiling below that would silently shorten the window people were
# promised, which is worse than not offering it.
ok("the radar ceiling is not lower than three days of scans actually needs",
   RM >= 72 * 60 / 4 * 0.9, f"{RM} vs {int(72 * 60 / 4)} expected")
ok("nor is the satellite one",
   SM >= 72 * 60 / 10 * 0.9, f"{SM} vs {int(72 * 60 / 10)} expected")

print("\n3. the radar pruner deletes by age, and only by age")
ns = compile_from(radar_src, ["prune"],
                  {"MAX_FRAMES": 10000, "KEEP_HOURS": 72})
tmp = tempfile.mkdtemp()
try:
    now = datetime.now(timezone.utc)
    made = []
    for hours in (1, 10, 40, 71, 73, 100):
        d = (now - timedelta(hours=hours)).strftime("%Y%m%d_%H%M%S")
        os.makedirs(os.path.join(tmp, d))
        made.append((hours, d))
    # Two names that are not timestamps at all, which must be left alone.
    os.makedirs(os.path.join(tmp, "frames.json.d"))
    open(os.path.join(tmp, "frames.json"), "w").write("{}")
    ns["prune"](tmp, hours=72)
    left = set(os.listdir(tmp))
    ok("frames inside the window survive",
       all(d in left for h, d in made if h < 72),
       str(sorted(left)))
    ok("frames past it are gone",
       not any(d in left for h, d in made if h > 72),
       str(sorted(left)))
    ok("a name that is not a timestamp is not guessed about and deleted",
       "frames.json" in left and "frames.json.d" in left, str(sorted(left)))
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print("\n4. and by count, oldest first, when there are too many")
ns = compile_from(radar_src, ["prune"], {"MAX_FRAMES": 5, "KEEP_HOURS": 72})
tmp = tempfile.mkdtemp()
try:
    now = datetime.now(timezone.utc)
    names = []
    for mins in range(0, 100, 5):          # 20 frames, all well inside 72h
        d = (now - timedelta(minutes=mins)).strftime("%Y%m%d_%H%M%S")
        os.makedirs(os.path.join(tmp, d), exist_ok=True)
        names.append(d)
    names.sort()
    ns["prune"](tmp, hours=72, cap=5)
    left = sorted(os.listdir(tmp))
    ok("only the ceiling's worth is kept", len(left) == 5, str(len(left)))
    ok("and it is the NEWEST five, not the first five it happened to read",
       left == names[-5:], f"kept {left}, newest were {names[-5:]}")
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print("\n5. MRMS keeps frames at all, which it did not before")
ok("frames go into a folder named for their own time",
   'fdir = now.strftime("%Y%m%d_%H%M%S")' in radar_src)
ok("and the manifest points at that folder, not at a bare filename",
   '"file": f"{fdir}/{name}.png"' in radar_src)
ok("there is a pruner for them", "def _mrms_prune(" in radar_src)
ok("and a frame lister", "def _mrms_frames(" in radar_src)
ok("the frame list is read back off the disk rather than trusted",
   "def _mrms_frames" in radar_src and "os.path.exists" in radar_src)
ok("a product with no frames left stops being offered",
   'man["products"].pop(name, None)' in radar_src)

print("\n6. the MRMS pruner behaves the same way")
ns = compile_from(radar_src, ["_mrms_prune"],
                  {"MRMS_KEEP_HOURS": 72, "MRMS_MAX_FRAMES": 4})
tmp = tempfile.mkdtemp()
try:
    now = datetime.now(timezone.utc)
    old_d = (now - timedelta(hours=100)).strftime("%Y%m%d_%H%M%S")
    os.makedirs(os.path.join(tmp, old_d))
    recent = []
    for mins in range(0, 60, 5):
        d = (now - timedelta(minutes=mins)).strftime("%Y%m%d_%H%M%S")
        os.makedirs(os.path.join(tmp, d), exist_ok=True)
        recent.append(d)
    recent.sort()
    open(os.path.join(tmp, "mrms.json"), "w").write("{}")
    ns["_mrms_prune"](tmp)
    left = sorted(x for x in os.listdir(tmp) if x[:1].isdigit())
    ok("the frame past the window is gone", old_d not in left, str(left))
    ok("the ceiling is honoured", len(left) == 4, str(len(left)))
    ok("and the newest are what survive", left == recent[-4:], str(left))
    ok("the manifest beside them is untouched",
       os.path.exists(os.path.join(tmp, "mrms.json")))
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print("\n7. the MRMS frame lister returns what is really there")
ns = compile_from(radar_src, ["_mrms_frames"])
tmp = tempfile.mkdtemp()
try:
    stamps = ["20260820_120000", "20260820_121000", "20260820_122000"]
    for i, d in enumerate(stamps):
        os.makedirs(os.path.join(tmp, d))
        # The middle frame has rotation but no mesh, which is exactly what a
        # cadence tier produces: the slow product is not rebuilt every pass.
        open(os.path.join(tmp, d, "rotation.png"), "w").write("x")
        if i != 1:
            open(os.path.join(tmp, d, "mesh.png"), "w").write("x")
    rot = ns["_mrms_frames"](tmp, "rotation")
    mesh = ns["_mrms_frames"](tmp, "mesh")
    none = ns["_mrms_frames"](tmp, "nosuchproduct")
    ok("a product present in every frame lists all of them", len(rot) == 3, str(rot))
    ok("oldest first, so the timeline reads left to right",
       [f["t"] for f in rot] == stamps, str([f["t"] for f in rot]))
    ok("each frame carries the path to its own picture",
       rot[0]["file"] == "20260820_120000/rotation.png", rot[0]["file"])
    ok("a product missing from a frame is not claimed to be there",
       len(mesh) == 2 and all(f["t"] != "20260820_121000" for f in mesh), str(mesh))
    ok("and a product that does not exist lists nothing rather than throwing",
       none == [], str(none))
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print("\n8. the boot index stays small while one site still reaches three days")
IF = const(radar_src, "INDEX_FRAMES")
ok("the shared index carries a recent window, not everything",
   20 <= IF <= 200, str(IF))
ok("it says how many frames really exist", '"total": len(frames)' in radar_src)
ok("and where the full list lives", '"frames_path"' in radar_src)
ok("which is written per site, beside that site's own frames",
   'write_json(os.path.join(d, "frames.json")' in radar_src)
# Three days at twenty sites is a third of a megabyte of frame names, and it
# would ride along on every page load. This is the whole reason for the split.
est_full = 1080 * 20 * 18 / 1024
est_index = IF * 20 * 18 / 1024
ok("which is the difference between a boot fetch of tens of KB and hundreds",
   est_index < est_full / 5, f"{est_index:.0f} KB vs {est_full:.0f} KB")

print("\n9. the satellite pruner honours both limits too")
ns = compile_from(sat_src, ["prune"], {"MAX_FRAMES": 3, "KEEP_HOURS": 72})
tmp = tempfile.mkdtemp()
try:
    now = datetime.now(timezone.utc)
    stale = (now - timedelta(hours=100)).strftime("%Y%m%d_%H%M%S")
    os.makedirs(os.path.join(tmp, stale))
    fresh = []
    for mins in range(0, 60, 10):
        d = (now - timedelta(minutes=mins)).strftime("%Y%m%d_%H%M%S")
        os.makedirs(os.path.join(tmp, d), exist_ok=True)
        fresh.append(d)
    fresh.sort()
    ns["prune"](tmp, hours=72)
    left = sorted(x for x in os.listdir(tmp) if x[:1].isdigit())
    ok("the stale frame goes", stale not in left, str(left))
    ok("the ceiling is honoured", len(left) == 3, str(len(left)))
    ok("and the newest survive", left == fresh[-3:], str(left))
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print()
if failed:
    print(f"{failed} FAILED, {passed} passed")
    sys.exit(1)
print(f"all {passed} passed")
