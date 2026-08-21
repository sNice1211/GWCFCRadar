#!/usr/bin/env python3
"""
The GOES composite builder: recipes, scan picking, and the day/night gate.

    python3 tools/test-satellite-pipeline.py

The pipeline itself cannot be imported here, because importing it pulls in
gfs_pipeline, which pulls in eccodes and requests. So the pieces that are pure
arithmetic are pulled out of the source and compiled on their own, and the
catalogue is read as data. That covers everything that can be got wrong
without a network: whether a recipe names bands it never downloads, whether
two mesoscale boxes can be told apart in a listing that holds both, whether a
filename stamp turns back into the right instant, and whether the sun is where
it should be at noon and at midnight.

What this cannot test is whether NOAA's bucket really is laid out the way the
code assumes. That needs the machine on the Pi, and `--check` is the thing to
run there.
"""

import ast
import os
import sys
from datetime import datetime, timedelta, timezone

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "pi", "satellite_pipeline.py")

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


def const(name):
    for node in tree.body:
        if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "") == name:
            return ast.literal_eval(node.value)
    raise AssertionError(f"{name} not found")


def funcs(*names):
    """Compile the named top-level functions on their own, with numpy."""
    ns = {"np": np, "datetime": datetime, "timedelta": timedelta,
          "timezone": timezone, "re": __import__("re")}
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in names:
            exec(ast.get_source_segment(src, node), ns)
    for n in names:
        assert n in ns, f"{n} not found"
    return ns


RECIPES = const("RGB_RECIPES")
SECTORS = const("SECTORS")
SATS = const("SATS")

print("\n1. the recipes are well formed")
ok("there are enough composites to be worth the trouble", len(RECIPES) >= 7,
   str(len(RECIPES)))

bad = {}
for key, r in RECIPES.items():
    if len(r.get("rgb", [])) != 3:
        bad[key] = "not three channels"
        continue
    used = {b for spec in r["rgb"] for b, _ in spec["terms"]}
    declared = set(r["bands"])
    if used - declared:
        bad[key] = f"uses bands it never downloads: {sorted(used - declared)}"
    elif declared - used:
        bad[key] = f"downloads bands it never uses: {sorted(declared - used)}"
ok("every recipe downloads exactly the bands its arithmetic needs", not bad, str(bad))

bad_range = {k: [s["range"] for s in r["rgb"] if s["range"][0] >= s["range"][1]]
             for k, r in RECIPES.items()
             if any(s["range"][0] >= s["range"][1] for s in r["rgb"])}
ok("every stretch runs low to high", not bad_range, str(bad_range))

bad_band = {k: sorted(b for b in r["bands"] if not 1 <= b <= 16)
            for k, r in RECIPES.items()
            if any(not 1 <= b <= 16 for b in r["bands"])}
ok("every band number is a real ABI band", not bad_band, str(bad_band))

bad_sector = {k: sorted(set(r["sectors"]) - set(SECTORS))
              for k, r in RECIPES.items() if set(r["sectors"]) - set(SECTORS)}
ok("every recipe names sectors that exist", not bad_sector, str(bad_sector))

print("\n2. the expensive sector is not on a timer")
ok("Full Disk is on demand only", SECTORS["fulldisk"].get("on_demand") is True)
ok("CONUS and both mesoscale boxes are not",
   not any(SECTORS[s].get("on_demand") for s in ("conus", "meso1", "meso2")))
# Bands 1 to 6 are reflective: they see sunlight bouncing off things, so at
# night they read zero. A recipe that builds a whole output channel out of
# one of them has nothing to draw in the dark, and building it anyway stores
# a flat rectangle every ten minutes all night.
REFLECTIVE = {1, 2, 3, 4, 5, 6}


def dark_channels(r):
    """Output channels that go flat at night, for this recipe."""
    return [i for i, ch in enumerate(r["rgb"])
            if all(band in REFLECTIVE for band, _ in ch["terms"])]


day = {k for k, r in RECIPES.items() if r.get("daytime_only")}
ok("true colour is day only, since all three channels are sunlight",
   "truecolor" in day and len(dark_channels(RECIPES["truecolor"])) == 3,
   str(dark_channels(RECIPES["truecolor"])))
ok("and so is Day Cloud Phase, whose green and blue are sunlight too",
   "cloudphase" in day and len(dark_channels(RECIPES["cloudphase"])) == 2,
   str(dark_channels(RECIPES["cloudphase"])))
# Fire Temperature is the deliberate exception: its red is band 7 at 3.9
# microns, which sees hot ground in the dark, so a fire really does show at
# night. Marking it day only would throw away its best use.
ok("fire temperature is not day only, because band 7 sees heat in the dark",
   "firetemp" not in day and 0 not in dark_channels(RECIPES["firetemp"]),
   str(dark_channels(RECIPES["firetemp"])))
# The infrared recipes work all night and must not have been swept up.
ok("the infrared recipes are never day gated",
   not (day & {"airmass", "dust", "ash", "nightmicro"}), str(day))
ok("nothing is day gated that has no sunlight channel at all",
   all(dark_channels(RECIPES[k]) for k in day),
   str({k: dark_channels(RECIPES[k]) for k in day if not dark_channels(RECIPES[k])}))

print("\n3. one folder holds both mesoscale boxes, and they are told apart")
ns = funcs("_doy_prefixes", "latest_band_keys", "_s3_list")
ns["SECTORS"] = SECTORS
now = datetime(2026, 8, 20, 12, 30, tzinfo=timezone.utc)

pre = ns["_doy_prefixes"](SECTORS["meso1"]["abi"], now, 1)
ok("a mesoscale prefix is the plain RadM folder, not an invented one",
   pre[0] == "ABI-L1b-RadM/2026/232/12/", pre[0])
ok("it looks back through earlier hours too", len(pre) >= 3, str(len(pre)))


def fake_listing(keys):
    """Stand in for S3, so the picking logic can be exercised offline."""
    ns["_s3_list"] = lambda bucket, prefix, timeout=30: keys


# A listing where both boxes and two scans are present, as the real one is.
listing = []
for box in (1, 2):
    for stamp in ("20262321200000", "20262321201000"):
        for ch in (7, 13, 15):
            listing.append(f"ABI-L1b-RadM/2026/232/12/"
                           f"OR_ABI-L1b-RadM{box}-M6C{ch:02d}_G16_s{stamp}_e_c.nc")
fake_listing(listing)

got1 = ns["latest_band_keys"]("noaa-goes16", "meso1", (7, 13, 15), now)
ok("a mesoscale box finds a complete scan", got1 is not None)
ok("and takes only its own box's files",
   got1 and all("RadM1-" in k for k in got1[2].values()),
   str(got1 and list(got1[2].values())))
ok("and takes the newest scan, not the first one listed",
   got1 and got1[1] == "20262321201000", str(got1 and got1[1]))

got2 = ns["latest_band_keys"]("noaa-goes16", "meso2", (7, 13, 15), now)
ok("the other box finds its own files, from the same listing",
   got2 and all("RadM2-" in k for k in got2[2].values()),
   str(got2 and list(got2[2].values())))

print("\n4. a half published scan is skipped, not half drawn")
# The newest scan is missing band 15, which every recipe using it needs.
partial = [k for k in listing
           if not (k.endswith("_e_c.nc") and "C15" in k and "s20262321201000" in k)]
fake_listing(partial)
got = ns["latest_band_keys"]("noaa-goes16", "meso1", (7, 13, 15), now)
ok("it falls back to the older scan that is complete",
   got and got[1] == "20262321200000", str(got and got[1]))

fake_listing([])
ok("an empty listing is no scan, not a crash",
   ns["latest_band_keys"]("noaa-goes16", "conus", (13,), now) is None)

print("\n4b. a retired satellite's empty bucket is not the end of the search")
# GOES-19 took the East post from GOES-16, and the noaa-goes16 bucket did not
# break when that happened: it just stopped gaining files. A listing of the
# current hour there is empty, and empty used to mean "give up". It has to
# mean "ask the next one", or every handover looks like an outage.
asked = []


def two_buckets(live):
    def lister(bucket, prefix, timeout=30):
        asked.append(bucket)
        return listing if bucket == live else []
    ns["_s3_list"] = lister


two_buckets("noaa-goes19")
del asked[:]
got3 = ns["latest_band_keys"](["noaa-goes19", "noaa-goes16"], "meso1",
                              (7, 13, 15), now)
ok("the current satellite answers and is used", got3 and got3[0] == "noaa-goes19",
   str(got3 and got3[0]))
ok("and the retired one is never asked when it does not need to be",
   "noaa-goes16" not in asked, str(asked))

two_buckets("noaa-goes16")
del asked[:]
got4 = ns["latest_band_keys"](["noaa-goes19", "noaa-goes16"], "meso1",
                              (7, 13, 15), now)
ok("an empty current bucket falls through to the older one",
   got4 and got4[0] == "noaa-goes16", str(got4 and got4[0]))
ok("and the bands really come from the bucket that answered",
   got4 and all("RadM1-" in k for k in got4[2].values()))

# The bands are downloaded from wherever the listing came from, so the bucket
# has to travel with them. Reading band files out of the empty bucket would
# fail on every one of them.
ok("which is why the bucket is returned rather than assumed",
   len(got4) == 3, str(got4 and len(got4)))

two_buckets("nobody")
ok("and when neither has it, that is still no scan rather than a crash",
   ns["latest_band_keys"](["noaa-goes19", "noaa-goes16"], "meso1",
                          (7, 13, 15), now) is None)

ok("a bare bucket name still works, so old callers do not break",
   (two_buckets("noaa-goes16") or
    ns["latest_band_keys"]("noaa-goes16", "meso1", (7, 13, 15), now)) is not None)

SATS = const("SATS")
ok("GOES-East lists the current satellite first",
   SATS["east"]["buckets"][0] == "noaa-goes19", str(SATS["east"]["buckets"]))
ok("and still knows where the old archive is",
   "noaa-goes16" in SATS["east"]["buckets"], str(SATS["east"]["buckets"]))
ok("every post has at least one bucket and no duplicates",
   all(s["buckets"] and len(set(s["buckets"])) == len(s["buckets"])
       for s in SATS.values()),
   str({k: v["buckets"] for k, v in SATS.items()}))

print("\n4c. the page and the pipeline agree on where the files live")
# The pipeline writes to ~/wxdata/satellite/<sat>/<sector>/, serve.py serves
# ~/wxdata as its root, and the page fetches /satellite/<sat>/<sector>/
# manifest.json. Three files, one contract, and nothing type-checks it - so
# a rename in any one of them silently turns into "the Pi did not answer".
html = open(os.path.join(os.path.dirname(SRC), "..", "index.html"),
            encoding="utf-8").read()
ok("the pipeline writes under wxdata/satellite",
   'os.path.expanduser("~/wxdata/satellite")' in src)
ok("the manifest is named manifest.json, per sector",
   'os.path.join(sector_dir, "manifest.json")' in src)
serve = open(os.path.join(os.path.dirname(SRC), "serve.py"),
             encoding="utf-8").read()
ok("serve.py serves wxdata as its root, so /satellite resolves",
   'os.path.expanduser("~/wxdata")' in serve)
ok("and the page asks for exactly that path",
   "/satellite/${sat}/${sector}/manifest.json" in html)
ok("with the frames read from the products the manifest lists",
   "man.products" in html)

print("\n5. a filename stamp is the instant it says it is")
ns2 = funcs("_stamp_utc", "_sun_elevation", "_stretch")
ok("day 232 of 2026 at 12:01 is the twentieth of August",
   ns2["_stamp_utc"]("20262321201000")
   == datetime(2026, 8, 20, 12, 1, 0, tzinfo=timezone.utc),
   str(ns2["_stamp_utc"]("20262321201000")))
ok("the first day of the year is day 001, not day 000",
   ns2["_stamp_utc"]("20260010000000")
   == datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc),
   str(ns2["_stamp_utc"]("20260010000000")))
ok("nonsense is None rather than a wrong time",
   ns2["_stamp_utc"]("hello") is None)

print("\n6. the sun is where it should be")
sun = ns2["_sun_elevation"]
# Local noon at 75W in high summer: the sun is high.
noon = sun(datetime(2026, 6, 21, 17, 0, tzinfo=timezone.utc), 35.0, -75.0)
ok("local noon in June at 35N is high in the sky", noon > 60.0, f"{noon:.1f}")
midnight = sun(datetime(2026, 6, 21, 5, 0, tzinfo=timezone.utc), 35.0, -75.0)
# At 35N in midsummer the sun sits about 31 degrees under at local midnight,
# which is (90 - latitude - tilt). Anything shallower than that would mean the
# hour angle is wrong.
ok("twelve hours later it is well below the horizon",
   -35.0 < midnight < -25.0, f"{midnight:.1f}")
# GOES-West is 62 degrees further round, so its noon is about four hours later.
west_noon = sun(datetime(2026, 6, 21, 21, 0, tzinfo=timezone.utc), 35.0, -137.0)
ok("the west satellite's noon is four hours after the east one's",
   west_noon > 60.0, f"{west_noon:.1f}")
ok("the dark cutoff would actually stop a night build",
   sun(datetime(2026, 1, 15, 6, 0, tzinfo=timezone.utc), 35.0, -75.0) < -6.0)
ok("and would not stop a daytime one",
   sun(datetime(2026, 1, 15, 17, 0, tzinfo=timezone.utc), 35.0, -75.0) > -6.0)

print("\n7. the stretch turns physical units into picture brightness")
st = ns2["_stretch"]
v = st(np.array([200.0, 250.0, 300.0], np.float32), 200.0, 300.0)
ok("the low end is black and the high end is white",
   abs(v[0]) < 1e-6 and abs(v[2] - 1.0) < 1e-6, str(v))
ok("the middle is the middle", abs(v[1] - 0.5) < 1e-6, str(v))
below = st(np.array([100.0, 400.0], np.float32), 200.0, 300.0)
ok("anything outside the range is clamped, never wrapped",
   below[0] == 0.0 and below[1] == 1.0, str(below))
inv = st(np.array([200.0, 300.0], np.float32), 200.0, 300.0, invert=True)
ok("inverting makes cold cloud tops the bright ones",
   inv[0] == 1.0 and inv[1] == 0.0, str(inv))
nan = st(np.array([np.nan], np.float32), 0.0, 1.0)
ok("a missing value is black, not a crash", nan[0] == 0.0, str(nan))
g = st(np.array([0.25], np.float32), 0.0, 1.0, gamma=0.5)
ok("gamma below one lifts the dark end", g[0] > 0.25, str(g))

print("\n8. history is kept, so there is something to loop")
keep_line = [l for l in src.splitlines() if l.startswith("KEEP_HOURS")][0]
keep = float(keep_line.split('"')[-2])
ok("frames are kept for hours, not minutes", keep >= 6, keep_line)
ok("and the retention window can be changed without editing code",
   "GWCFC_SAT_KEEP_HOURS" in keep_line, keep_line)
ok("frames are written into folders named after their own time",
   'strftime("%Y%m%d_%H%M%S")' in src)
ok("and old ones are pruned rather than filling the card",
   "def prune(" in src and "shutil.rmtree" in src)
ok("each frame carries its own rectangle, because the mesoscale boxes move",
   '{recipe_key}.json' in src and '"bounds": bounds_from(glat, glon)' in src)
ok("the frame list is read back off the disk, not trusted from the manifest",
   "def _relist_frames(" in src and "os.path.exists" in src)
ok("a scan already on disk is not downloaded again",
   "already built" in src)

print()
if failed:
    print(f"{failed} FAILED, {passed} passed")
    sys.exit(1)
print(f"all {passed} passed")
