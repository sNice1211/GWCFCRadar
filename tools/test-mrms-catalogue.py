#!/usr/bin/env python3
"""
The MRMS catalogue, and what stops it burying the Pi.

    python3 tools/test-mrms-catalogue.py

MRMS is a national mosaic of every radar in the country, blended and quality
controlled, and NOAA publishes it as about a hundred separate grids. This
catalogue is now seventy one of them, which is the useful part of that
hundred: everything a forecaster reads plus the derived fields nobody should
be working out by hand.

Seventy one grids is also a way to break a Raspberry Pi. About half of them
want rebuilding every five minutes, which is the same five minutes the radar
frames are built in, and they share one timer. So the budget is checked here
as carefully as the catalogue: a stale mosaic is still a picture, but a radar
frame that never got built is a hole in the loop that never fills.

Parsed rather than imported, so this runs without eccodes or metpy.
"""

import ast
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RADAR = os.path.join(ROOT, "pi", "radar_pipeline.py")
HTML = os.path.join(ROOT, "index.html")

passed = failed = 0


def ok(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name}" + (f"  <{extra}>" if extra else ""))


src = open(RADAR, encoding="utf-8").read()
html = open(HTML, encoding="utf-8").read()

PRODUCTS = None
# The namespace the catalogue is read in, collected from the module itself.
#
# This used to be a hand-written {"MRMS_BASE": ..., "FLASH_BASE": ...}, which
# meant adding a third NOAA tree to the pipeline turned this whole file into a
# NameError at import. Both MRMS suites had been dead since REFL3D_BASE was
# added, and a dead test is worse than no test: it is a green check that was
# never run. Reading the constants out of the source keeps them in step by
# construction.
def _base_names(source):
    ns = {}
    for n in ast.parse(source).body:
        if not isinstance(n, ast.Assign):
            continue
        target = getattr(n.targets[0], "id", "")
        if target.endswith("_BASE") and isinstance(n.value, ast.Constant):
            ns[target] = n.value.value
    return ns


for node in ast.parse(src).body:
    if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "") == "MRMS_PRODUCTS":
        # eval rather than literal_eval: a product can name a constant for
        # the NOAA tree it lives in (FLASH is published separately from the
        # 2D mosaics), and literal_eval refuses anything that is not a
        # literal. The namespace is the two base URLs and nothing else, so
        # this stays a reader rather than an importer.
        PRODUCTS = eval(ast.get_source_segment(src, node.value),
                        {"__builtins__": {}},
                        _base_names(src))
assert PRODUCTS, "MRMS_PRODUCTS not found"


print("\n1. the catalogue is a real set, not a token one")
ok("there are seventy or more products", len(PRODUCTS) >= 70, str(len(PRODUCTS)))
paths = [v["path"] for v in PRODUCTS.values()]
dupes = sorted({p for p in paths if paths.count(p) > 1})
# Two keys pointing at one NOAA grid would be one download shown twice and
# two entries competing for the same slot in the menu.
ok("no two products fetch the same grid", not dupes, str(dupes))
# "floor" is optional; see the note in test-mrms.py.
need = {"path", "label", "unit", "range", "ramp", "every"}
missing = {k: sorted(need - set(v)) for k, v in PRODUCTS.items() if need - set(v)}
ok("every product declares everything the builder reads",
   not missing, str(missing)[:200])
ok("every label is written for a person, not copied from the path",
   all(v["label"] != v["path"] and " " in v["label"] for v in PRODUCTS.values()),
   str([k for k, v in PRODUCTS.items() if v["label"] == v["path"]]))
bad_range = [k for k, v in PRODUCTS.items() if not (v["range"][1] > v["range"][0])]
ok("and a range that runs the right way", not bad_range, str(bad_range))
# A grid whose NOAA name ends in Height is a height, so reporting it in dBZ
# means one of the two is wrong and the reading on the map is a lie. This
# caught three products pointing at Height paths while labelled reflectivity.
lying = [k for k, v in PRODUCTS.items()
         if v["path"].endswith("Height") and v["unit"] == "dBZ"]
ok("no product reports a height grid in decibels", not lying, str(lying))


print("\n2. the additions are the ones that were actually missing")
# Rotation tracks are a maximum held over a window, which is what makes them
# a track. The instantaneous shear is the different question you ask while a
# storm is happening, and it was not here at all.
for key, why in [
    ("azshear02", "live low level rotation, not a track"),
    ("azshear36", "live mid level rotation"),
    ("vildensity", "the hail signal VIL alone cannot give"),
    ("h50abovem20", "how far a strong echo reaches above the cold line"),
    ("refl0c", "reflectivity at an isotherm rather than at a height"),
    ("lowcomposite", "a composite over a slab, not the whole column"),
    ("qpemulti01", "rain corrected by gauges that actually caught it"),
    ("qpeari24", "how unusual the rain is, not just how much"),
    ("ltgjump", "a leading signal rather than a trailing one"),
    ("brightbandbot", "the bottom of the melting layer, not just the top"),
]:
    ok(f"{key}: {why}", key in PRODUCTS, "missing")

# The heights are three different questions and must not be confused: 0C is
# where the freezing level is, 50 above -20C is a hail signature.
ok("the freezing level height and the hail heights are separate products",
   "h0c" in PRODUCTS and "h50abovem20" in PRODUCTS
   and PRODUCTS["h0c"]["path"] != PRODUCTS["h50abovem20"]["path"])


print("\n3. every product lands in a group the menu actually has")
# The page groups by the product key. A key that matches nothing falls into
# "Other", which is where products go to be forgotten.
m = re.search(r"const MRMS_GROUPS = \[(.*?)\n\];", html, re.S)
ok("the page's group table can be read", bool(m))
rules = re.findall(r"id: '(\w+)',\s*label: '[^']+',\s*\n\s*match: k => /(.+?)/\.test\(k\)",
                   m.group(1)) if m else []
# Counting them was the wrong test: adding a group broke it, and the thing
# that actually matters is that no product falls through into "Other".
ok("the group table has real rules in it", len(rules) >= 6, str([r[0] for r in rules]))
homeless = [k for k in PRODUCTS
            if not any(re.search(pat.replace("\\", "\\"), k) for _, pat in rules)]
ok("and every product matches one of them", not homeless, str(homeless[:12]))


def group_of(key):
    for gid, pattern in rules:
        if re.match(pattern, key):
            return gid
    return "other"


orphans = [k for k in PRODUCTS if group_of(k) == "other"]
ok("no product falls into Other", not orphans, str(orphans))
# Order matters in that table: h0c is the freezing level and belongs in
# winter, h50 and h60 are hail signals and belong in severe. A pattern that
# caught h0c with the hail ones would file the freezing level under severe.
ok("the freezing level is filed under winter", group_of("h0c") == "winter",
   group_of("h0c"))
ok("and the hail heights under severe",
   group_of("h50abovem20") == "severe" and group_of("h60above0") == "severe",
   f"{group_of('h50abovem20')}, {group_of('h60above0')}")
ok("live shear is severe, with the rotation tracks",
   group_of("azshear02") == "severe", group_of("azshear02"))
ok("reflectivity at an isotherm is reflectivity",
   group_of("refl0c") == "refl", group_of("refl0c"))
ok("gauge corrected rain is precip",
   group_of("qpemulti01") == "precip", group_of("qpemulti01"))
# POH and POSH are the same question asked at two severities, so a pattern
# that caught only the longer name would leave the shorter one in Other.
ok("probability of hail sits with probability of severe hail",
   group_of("poh") == "severe" and group_of("posh") == "severe",
   f"{group_of('poh')}, {group_of('posh')}")
ok("quality controlled base reflectivity is reflectivity",
   group_of("baseqc") == "refl", group_of("baseqc"))
# Streamflow is what the ground did with the rain, which is a different
# question from how much fell, so it must not land in precip.
ok("the hydrology products are their own group",
   all(group_of(k) == "flood" for k in PRODUCTS if k.startswith(("crest", "sac", "hp"))),
   str({k: group_of(k) for k in PRODUCTS
        if k.startswith(("crest", "sac", "hp")) and group_of(k) != "flood"}))
counts = {gid: sum(1 for k in PRODUCTS if group_of(k) == gid) for gid, _ in rules}
# No group so large it is a wall of names again, which is the problem the
# nesting was built to solve in the first place.
ok("and no single group is more than half the catalogue",
   max(counts.values()) < len(PRODUCTS) / 2, str(counts))
ok("while every group has something in it",
   all(v > 0 for v in counts.values()), str(counts))


print("\n4. one pass cannot eat the window the radar frames need")
tree = ast.parse(src)
consts = {}
for node in tree.body:
    if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "").startswith("MRMS_PASS"):
        seg = ast.get_source_segment(src, node.value)
        nums = re.findall(r'"(\d+)"', seg)
        consts[node.targets[0].id] = float(nums[0]) if nums else None
ok("there is a wall clock ceiling on a pass", consts.get("MRMS_PASS_SECS", 0) > 0,
   str(consts))
ok("and a count ceiling as well", consts.get("MRMS_PASS_MAX", 0) > 0, str(consts))
# The timer fires every five minutes and the radar build shares it, so MRMS
# taking more than half the window would starve the thing that matters more.
ok("and the ceiling leaves the radar most of its five minutes",
   consts.get("MRMS_PASS_SECS", 999) <= 150,
   str(consts.get("MRMS_PASS_SECS")))
ok("both can be changed without editing code",
   "GWCFC_MRMS_PASS_SECS" in src and "GWCFC_MRMS_PASS_MAX" in src)

# Without a rotating start, a budget that runs out half way means the second
# half of the catalogue is never built at all. Not slow: absent.
ok("the pass starts where the last one stopped", '__cursor__' in src)
ok("and wraps rather than running off the end",
   re.search(r"(\w+)\[start:\] \+ \1\[:start\]", src) is not None)
# The cursor has to name the product the pass stopped on. It used to be
# computed from the walk position, which stops matching the moment the walk
# order is changed - and it is, twice, by the rotation and by moving
# never-built products to the front.
ok("and the cursor is taken from the catalogue's own order, not the walk",
   "order.index(name)" in src)
ok("a pass that finishes the catalogue starts again from the top",
   re.search(r"else:\s*\n\s*#.*\n\s*#.*\n\s*stopped_at = 0", src) is not None
   or "stopped_at = 0" in src)

# The cursor is stored beside the per-product state, so it must not be
# mistakable for a product.
ok("the cursor cannot collide with a product name",
   "__cursor__" not in PRODUCTS)


print("\n5. the cadences add up to something a Pi can actually do")
per_hour = sum(60.0 / v["every"] for v in PRODUCTS.values())
wanted_per_pass = sum(1 for v in PRODUCTS.values() if v["every"] <= 5)
ok("the catalogue would like a lot more than it can have",
   wanted_per_pass > consts.get("MRMS_PASS_MAX", 14),
   f"{wanted_per_pass} want every pass, ceiling is {consts.get('MRMS_PASS_MAX')}")
# Which is fine, and is exactly why the cursor exists: everything comes
# round, nothing is starved, and the ceiling decides the real rate.
passes_to_cover = len(PRODUCTS) / max(1.0, consts.get("MRMS_PASS_MAX", 14))
ok("so the whole catalogue comes round in well under an hour",
   passes_to_cover * 5 <= 45, f"{passes_to_cover * 5:.0f} minutes")
ok("and the fast products still ask for the fast lane",
   any(v["every"] <= 5 for v in PRODUCTS.values()))
ok("while the slow ones do not pretend to be fast",
   all(v["every"] >= 30 for k, v in PRODUCTS.items() if "1440" in k or "72" in k),
   str({k: v["every"] for k, v in PRODUCTS.items()
        if ("1440" in k or "72" in k) and v["every"] < 30}))
print(f"       (catalogue would like {per_hour:.0f} builds an hour; the "
      f"ceiling allows {consts.get('MRMS_PASS_MAX', 0) * 12:.0f})")


print("\n6. nothing about the new products breaks the old ones")
for key in ("rotation", "mesh", "composite", "preciprate", "ltgdensity", "h0c"):
    ok(f"{key} is still here", key in PRODUCTS)
ok("the signed products are still marked signed",
   all(PRODUCTS[k].get("signed") for k in ("sfctemp", "wetbulb")),
   str({k: PRODUCTS[k].get("signed") for k in ("sfctemp", "wetbulb")}))
# A temperature grid where negative readings are real must not be cut at
# zero the way a reflectivity grid is.
# Differential reflectivity runs negative in real weather, so the ZDR levels
# belong on this list beside the two temperature grids.
ok("and nothing new was marked signed by accident",
   sorted(k for k, v in PRODUCTS.items() if v.get("signed"))
   == ["sfctemp", "wetbulb", "zdr3d05", "zdr3d2", "zdr3d4"],
   str(sorted(k for k, v in PRODUCTS.items() if v.get("signed"))))

print()
if failed:
    print(f"{failed} FAILED, {passed} passed")
    sys.exit(1)
print(f"all {passed} passed")
