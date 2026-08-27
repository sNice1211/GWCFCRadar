#!/usr/bin/env python3
"""
Every model asks the byte index and the file for the SAME file.

    python3 tools/test-model-paths.py

Each model in gfs_pipeline.py carries two addresses:

    "file": the GRIB to pull fields out of, via the NOMADS filter service
    "raw":  the .idx byte index, read first to find WHERE those fields are

They are two paths to one file, and they only work together. The pipeline
reads the index, finds that (say) 500 mb height starts at byte 4,182,016,
and asks the filter for that message. Point the two at different files and
every byte offset is meaningless: the request either fails or, worse,
succeeds and returns whatever happened to be at that offset.

That is not hypothetical. NOMADS renamed the GFS 0.5 degree product to
pgrb2full, and BOTH names still return HTTP 200 for the .idx: 40139 bytes
under the old name, 59865 under the new. Fixing only "file" would have left
gfs0p50 building its field list from the wrong inventory, with nothing
obviously broken to look at.

So this checks the one thing that is true of every correct pair and false of
every half-finished rename: raw is file plus ".idx". Region overrides are
checked as they actually resolve, since a region that overrides one and not
the other is exactly the mistake.

Read with ast rather than imported, so it runs without eccodes or the rest of
the Pi's stack.
"""

import ast
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "pi", "gfs_pipeline.py")

passed = failed = 0


def ok(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print("  ok   " + name)
    else:
        failed += 1
        print("  FAIL " + name + (("  <" + str(extra) + ">") if extra else ""))


src = open(SRC, encoding="utf-8").read()

def literal_dict(node):
    """The literal parts of a dict node, and only those.

    literal_eval refuses the whole of MODELS because entries reference names
    like FINE_FIELDS, and importing the module would need eccodes and the rest
    of the Pi's stack. Nothing here cares what FINE_FIELDS is: the addresses
    are all plain strings, so the strings are taken and everything else is
    dropped rather than being a reason to give up on the file.
    """
    out = {}
    if not isinstance(node, ast.Dict):
        return out
    for k, v in zip(node.keys, node.values):
        if not isinstance(k, ast.Constant) or not isinstance(k.value, str):
            continue
        if isinstance(v, ast.Constant):
            out[k.value] = v.value
        elif isinstance(v, ast.Dict):
            out[k.value] = literal_dict(v)
        elif isinstance(v, ast.JoinedStr):
            continue                  # an f-string; none of the paths are
    return out


MODELS = None
for node in ast.parse(src).body:
    if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "") == "MODELS":
        MODELS = literal_dict(node.value)
assert MODELS, "MODELS not found in gfs_pipeline.py"

print("\n1. there are models to check")
ok("MODELS parsed", len(MODELS) > 10, len(MODELS))

print("\n2. every model's index and file are the same file")
bad = []
for name, m in MODELS.items():
    f, r = m.get("file"), m.get("raw")
    if not f or not r:
        continue                      # not every source is a NOMADS GRIB
    if not r.endswith(f + ".idx"):
        bad.append(f"{name}: file={f} raw={r}")
ok("no model points its index at a different file than its data",
   not bad, " | ".join(bad))

print("\n3. and so does every regional override, as it actually resolves")
# A region can replace the address entirely (RAP Alaska is a different grid in
# a different file). Overriding one of the pair and not the other is the whole
# bug class this exists for, so the pair is resolved the way the pipeline
# resolves it and then checked.
badr = []
regions = 0
for name, m in MODELS.items():
    for rname, spec in (m.get("regions") or {}).items():
        if not isinstance(spec, dict):
            continue
        f = spec.get("file", m.get("file"))
        r = spec.get("raw", m.get("raw"))
        if not f or not r:
            continue
        regions += 1
        if not r.endswith(f + ".idx"):
            badr.append(f"{name}/{rname}: file={f} raw={r}")
ok("every region checked", regions > 5, regions)
ok("no region overrides one half of the pair and leaves the other",
   not badr, " | ".join(badr))

print("\n4. the rename that started this is in")
g = MODELS.get("gfs0p50", {})
ok("gfs0p50 exists", bool(g))
ok("its data file is the pgrb2full name NOMADS actually serves",
   "pgrb2full.0p50" in (g.get("file") or ""), g.get("file"))
ok("and its index is too, which is the half that is easy to miss",
   "pgrb2full.0p50" in (g.get("raw") or ""), g.get("raw"))
ok("the old name is gone from both",
   "pgrb2.0p50" not in (g.get("file") or "")
   and "pgrb2.0p50" not in (g.get("raw") or ""),
   f"{g.get('file')} {g.get('raw')}")

print("\n5. the 0.25 and 1.00 degree products were NOT renamed with it")
# Worth pinning: the rename applies to 0.5 degree only, and "fixing" the
# others to match would break three working models to make one consistent.
ok("gfs 0.25 keeps pgrb2.0p25",
   "pgrb2.0p25" in (MODELS.get("gfs", {}).get("file") or ""),
   MODELS.get("gfs", {}).get("file"))
ok("gfs 1.00 keeps pgrb2.1p00",
   "pgrb2.1p00" in (MODELS.get("gfs1p00", {}).get("file") or ""),
   MODELS.get("gfs1p00", {}).get("file"))

print("\n6. an index path is an index path")
noidx = [n for n, m in MODELS.items()
         if m.get("raw") and not m["raw"].endswith(".idx")]
ok("every raw address ends in .idx", not noidx, " | ".join(noidx))

print()
if failed:
    print("%d FAILED, %d passed" % (failed, passed))
    sys.exit(1)
print("all %d passed" % passed)
