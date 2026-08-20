#!/usr/bin/env python3
"""
The MRMS catalogue and its adaptive throttle.

    python3 tools/test-mrms.py

MRMS carried two products for a long time and now carries the whole 2D
catalogue, which only works because nothing fetches everything every pass.
Each product declares a wanted cadence and the throttle adds the adaptive
half on top: a failing product backs itself off instead of being retried into
the ground, a slow one is stretched so it cannot crowd the radar build it
shares a timer with, and both recover on their own.

This imports the real dict and the real decision function by parsing the
pipeline rather than importing it, because importing pulls in eccodes, metpy
and numpy - none of which need to be installed to check that the catalogue is
well formed and the throttle arithmetic is right.
"""

import ast
import json
import os
import sys
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "pi", "radar_pipeline.py")

passed = failed = 0


def ok(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name}" + (f"  <{extra}>" if extra else ""))


src = open(SRC, encoding="utf-8").read()
tree = ast.parse(src)

# ── Pull the catalogue out as real Python without importing the module ──
catalogue = None
for node in tree.body:
    if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "") == "MRMS_PRODUCTS":
        catalogue = ast.literal_eval(node.value)
if catalogue is None:
    print("could not find MRMS_PRODUCTS")
    sys.exit(1)

# ── And the throttle, compiled on its own with only what it needs ──
due_src = None
for node in tree.body:
    if isinstance(node, ast.FunctionDef) and node.name == "_mrms_due":
        due_src = ast.get_source_segment(src, node)
ns = {"datetime": datetime, "timezone": timezone}
exec(due_src, ns)
_mrms_due = ns["_mrms_due"]

print("\n1. the catalogue is well formed")
required = {"path", "label", "unit", "range", "ramp", "floor"}
missing = {k: sorted(required - set(v)) for k, v in catalogue.items()
           if required - set(v)}
ok("every product declares the fields the builder reads", not missing, str(missing))
ok("the catalogue is genuinely large now", len(catalogue) >= 30, str(len(catalogue)))

paths = [v["path"] for v in catalogue.values()]
ok("no two products fetch the same MRMS path",
   len(paths) == len(set(paths)),
   str([p for p in paths if paths.count(p) > 1]))

bad_range = {k: v["range"] for k, v in catalogue.items()
             if not (isinstance(v["range"], tuple) and len(v["range"]) == 2
                     and v["range"][0] < v["range"][1])}
ok("every colour range runs low to high", not bad_range, str(bad_range))

# The ramps must exist in the shared table, or LUTS[ramp] raises at build.
ramps_src = open(os.path.join(ROOT, "pi", "gfs_pipeline.py"), encoding="utf-8").read()
known_ramps = set()
for node in ast.parse(ramps_src).body:
    if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "") == "RAMPS":
        known_ramps = set(ast.literal_eval(node.value).keys())
unknown = sorted({v["ramp"] for v in catalogue.values()} - known_ramps)
ok("every product names a ramp that actually exists", not unknown, str(unknown))

print("\n2. cadence tiers are sane")
tiers = {}
for k, v in catalogue.items():
    tiers.setdefault(v.get("every", 5), []).append(k)
ok("the fast lane is not the whole catalogue",
   len(tiers.get(5, [])) < len(catalogue),
   f"{len(tiers.get(5, []))} of {len(catalogue)}")
ok("slow-moving totals are not on the fast lane",
   all(catalogue[k].get("every", 5) >= 15 for k in catalogue if k.startswith("qpe")),
   str({k: catalogue[k].get("every") for k in catalogue if k.startswith("qpe")}))
ok("rotation and hail stay on the fast lane",
   catalogue["rotation"].get("every") == 5 and catalogue["mesh"].get("every") == 5,
   str([catalogue["rotation"].get("every"), catalogue["mesh"].get("every")]))

print("\n3. products where negative values are real opt out of the missing-data rule")
signed = {k for k, v in catalogue.items() if v.get("signed")}
ok("the temperature products are marked signed",
   {"sfctemp", "wetbulb"} <= signed, str(sorted(signed)))
ok("reflectivity and rainfall are NOT marked signed",
   not ({"composite", "qpe01", "mesh"} & signed), str(sorted(signed)))

print("\n4. the throttle decides correctly")
now = datetime(2026, 8, 20, 12, 0, tzinfo=timezone.utc)
spec5 = {"every": 5}
spec60 = {"every": 60}

ok("a product never built before is due immediately",
   _mrms_due("x", spec5, {}, now) is True)

fresh = {"x": {"last": (now - timedelta(minutes=1)).isoformat(), "fails": 0, "secs": 2}}
ok("a 5-minute product built one minute ago is not due",
   _mrms_due("x", spec5, fresh, now) is False)

stale = {"x": {"last": (now - timedelta(minutes=6)).isoformat(), "fails": 0, "secs": 2}}
ok("a 5-minute product built six minutes ago is due",
   _mrms_due("x", spec5, stale, now) is True)

hourly = {"x": {"last": (now - timedelta(minutes=30)).isoformat(), "fails": 0, "secs": 2}}
ok("an hourly product is not due after thirty minutes",
   _mrms_due("x", spec60, hourly, now) is False)

print("\n5. failures back off, and recover")
# One failure pushes the retry to 10 minutes, so six minutes on is too soon.
f1 = {"x": {"last": (now - timedelta(minutes=6)).isoformat(), "fails": 1, "secs": 1}}
ok("after one failure it waits longer than its normal cadence",
   _mrms_due("x", spec5, f1, now) is False)
f1_later = {"x": {"last": (now - timedelta(minutes=11)).isoformat(), "fails": 1, "secs": 1}}
ok("but it does retry once that longer wait has passed",
   _mrms_due("x", spec5, f1_later, now) is True)

f_many = {"x": {"last": (now - timedelta(minutes=40)).isoformat(), "fails": 9, "secs": 1}}
ok("a long run of failures backs off further still",
   _mrms_due("x", spec5, f_many, now) is False)
f_cap = {"x": {"last": (now - timedelta(minutes=61)).isoformat(), "fails": 99, "secs": 1}}
ok("the backoff is capped, so a product is never abandoned forever",
   _mrms_due("x", spec5, f_cap, now) is True)

recovered = {"x": {"last": (now - timedelta(minutes=6)).isoformat(), "fails": 0, "secs": 1}}
ok("a product that starts working again returns to its normal cadence",
   _mrms_due("x", spec5, recovered, now) is True)

print("\n6. slow products are stretched so they cannot crowd the radar build")
slow = {"x": {"last": (now - timedelta(minutes=6)).isoformat(), "fails": 0, "secs": 25}}
ok("a product that took 25s is not run again after only six minutes",
   _mrms_due("x", spec5, slow, now) is False)
slow_ok = {"x": {"last": (now - timedelta(minutes=16)).isoformat(), "fails": 0, "secs": 25}}
ok("it does run once its stretched interval has passed",
   _mrms_due("x", spec5, slow_ok, now) is True)
very_slow = {"x": {"last": (now - timedelta(minutes=20)).isoformat(), "fails": 0, "secs": 50}}
ok("a much slower product is stretched further",
   _mrms_due("x", spec5, very_slow, now) is False)

print("\n7. bad state never wedges a product")
ok("an unparseable timestamp is treated as never built",
   _mrms_due("x", spec5, {"x": {"last": "not-a-date"}}, now) is True)
ok("a naive timestamp is still comparable",
   _mrms_due("x", spec5,
             {"x": {"last": (now - timedelta(minutes=9)).replace(tzinfo=None).isoformat()}},
             now) is True)

print()
if failed:
    print(f"{failed} FAILED, {passed} passed")
    sys.exit(1)
print(f"all {passed} passed")
