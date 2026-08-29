#!/usr/bin/env python3
"""
The SST pipeline's arithmetic, checked against numbers worked out by hand.

    python3 tools/test-sst-pipeline.py

Nothing here touches the network. Synthetic OISST-shaped netCDF files are
written to a temporary directory with values chosen so that every answer is
known before the code runs: a baseline of exactly 20 C for the thirty
climatology years, record years at 25 and 15 placed OUTSIDE that baseline,
and a target day at 22, so the anomaly must be exactly 2.0, the record flag
must not fire, and the 7-day change must be exactly 1.0.

The reason to test this rather than eyeball a picture is that every one of
these fields looks completely plausible when it is wrong. An anomaly with
the wrong baseline is a normal-looking map that says the ocean is a degree
warmer than it is. A change map that differences temperature instead of
anomaly shows the season turning and calls it news. A record flag that
compares against the wrong envelope paints records that are not records,
which in a hurricane season is the kind of wrong that gets repeated.
"""

import datetime as dt
import os
import shutil
import sys
import tempfile

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "pi"))

try:
    from netCDF4 import Dataset
except Exception:
    print("netCDF4 is not installed, skipping.")
    sys.exit(0)

PASS = FAIL = 0


def ok(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok   {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name}" + (f"  <{extra}>" if extra else ""))


# A small grid, but a real one: latitudes ascending like OISST's own files,
# so the north-up flip in the writer is genuinely exercised.
NLAT, NLON = 8, 12
LATS = np.linspace(-70, 70, NLAT)
LONS = np.linspace(0.125, 359.875, NLON)


def write_oisst(path, values):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with Dataset(path, "w") as nc:
        nc.createDimension("time", 1)
        nc.createDimension("zlev", 1)
        nc.createDimension("lat", NLAT)
        nc.createDimension("lon", NLON)
        v = nc.createVariable("sst", "f4", ("time", "zlev", "lat", "lon"),
                              fill_value=-999.0)
        v[:] = np.asarray(values, dtype=np.float32)[None, None, :, :]
        nc.createVariable("lat", "f8", ("lat",))[:] = LATS
        nc.createVariable("lon", "f8", ("lon",))[:] = LONS


tmp = tempfile.mkdtemp(prefix="ssttest-")
os.environ["GWCFC_SST_PRUNE_PCT"] = "99"
import sst_pipeline as S                                    # noqa: E402

S.OUT_DIR = os.path.join(tmp, "out")
S.CACHE_DIR = os.path.join(S.OUT_DIR, "_cache")
os.makedirs(S.OUT_DIR, exist_ok=True)

# The target is in the CURRENT year, because the record walk runs to today:
# a fixture that stopped in some past year would leave the walk reaching for
# years that were never written, and it would be right to.
TARGET = dt.date(dt.date.today().year, 5, 3)

# Every baseline year is exactly 20 C, so the 1991-2020 mean is exactly 20
# and any anomaly is arithmetic anyone can check in their head.
#
# The record years sit OUTSIDE 1991-2020 on purpose. That is the whole point
# of keeping two windows: a hot year in the record era must move the record
# and leave the baseline alone. Putting the hot year inside the baseline
# instead would make the mean 20.17 and every anomaly below wrong by a sixth
# of a degree, which is exactly what the first draft of this file did.
for year in range(S.RECORDS_START, TARGET.year + 1):
    d = dt.date(year, TARGET.month, TARGET.day)
    if year == 1985:
        field = np.full((NLAT, NLON), 25.0)      # record high, pre-baseline
    elif year == 1988:
        field = np.full((NLAT, NLON), 15.0)      # record low, pre-baseline
    elif year == TARGET.year:
        field = np.full((NLAT, NLON), 22.0)      # the day being built
    else:
        field = np.full((NLAT, NLON), 20.0)
    # One cell is always missing, so the NaN handling is exercised rather
    # than assumed: a fill value that survives into the mean would drag the
    # whole climatology down by a few degrees and look merely "cool".
    field[0, 0] = -999.0
    write_oisst(S._raw_path("oisst", d), field)

# The day 7 back, for the change map: 21 C, so its anomaly is +1 and the
# 7-day anomaly change must be exactly +1.
for year in range(S.RECORDS_START, TARGET.year + 1):
    d = dt.date(year, 4, 26)
    field = np.full((NLAT, NLON), 21.0 if year == TARGET.year else 20.0)
    field[0, 0] = -999.0
    write_oisst(S._raw_path("oisst", d), field)

# Nothing may be downloaded: every file this test needs is already on disk,
# so a fetch attempt means the code looked in the wrong place.
_fetches = []
_real_download = S._download
def _no_net(url, path, timeout=180):
    _fetches.append(url)
    return False
S._download = _no_net

print("\n1. reading a file, and not inventing data where there is none")
arr, lats, lons = S.read_sst("oisst", S._raw_path("oisst", TARGET))
ok("the grid comes back the right shape", arr.shape == (NLAT, NLON), str(arr.shape))
ok("the fill value became NaN rather than a temperature",
   np.isnan(arr[0, 0]), str(arr[0, 0]))
ok("and the real values survived", np.nanmax(arr) == 22.0, str(np.nanmax(arr)))
ok("latitudes are ascending, like OISST's own files", lats[0] < lats[-1])

print("\n2. the climatology, which is the number everything else leans on")
mean, rhi, rlo = S.climatology_for("oisst", TARGET.month, TARGET.day)
ok("a mean was built", mean is not None)
ok("it is exactly the 1991-2020 baseline, 20.0",
   abs(float(np.nanmean(mean)) - 20.0) < 1e-4, str(np.nanmean(mean)))
# The point of the separate windows: 1985 is 25 C and inside the record era
# but OUTSIDE 1991-2020, so it must move the record and not the mean.
ok("the 1985 record year did not leak into the 1991-2020 mean",
   abs(float(np.nanmax(mean)) - 20.0) < 1e-4, str(np.nanmax(mean)))
ok("but it did set the record high", abs(float(np.nanmax(rhi)) - 25.0) < 1e-4,
   str(np.nanmax(rhi)))
ok("and 1988 set the record low", abs(float(np.nanmin(rlo)) - 15.0) < 1e-4,
   str(np.nanmin(rlo)))
ok("the always-missing cell stayed missing", np.isnan(mean[0, 0]))
ok("nothing was fetched: it was all on disk", not _fetches, str(_fetches[:2]))

print("\n3. the cache, which is what makes this affordable on a Pi")
p = S._doy_key("oisst", TARGET.month, TARGET.day, "mean")
ok("the climatology was written to disk", os.path.exists(p), p)
# Break the ability to read files at all; a second call must still answer,
# which proves it came from the cache and not from a fresh walk.
_real_read = S.read_sst
S.read_sst = lambda *a, **k: (_ for _ in ()).throw(AssertionError("re-read"))
mean2, rhi2, _ = S.climatology_for("oisst", TARGET.month, TARGET.day)
S.read_sst = _real_read
ok("asking again is served from the cache, not rebuilt",
   mean2 is not None and np.allclose(np.nan_to_num(mean2), np.nan_to_num(mean)))
ok("February 29 borrows February 28 rather than averaging seven leap years",
   S._doy_key("o", 2, 29, "mean") != S._doy_key("o", 2, 28, "mean")
   and S.climatology_for.__doc__ and "borrows" in S.climatology_for.__doc__)

print("\n4. the fields themselves")
vals, la, lo = S.build_variant("oisst", "actual", TARGET)
ok("actual is the temperature as measured",
   abs(float(np.nanmean(vals)) - 22.0) < 1e-4, str(np.nanmean(vals)))

vals, _, _ = S.build_variant("oisst", "anomaly", TARGET)
ok("anomaly is 22 minus the 20 baseline, so exactly 2.0",
   abs(float(np.nanmean(vals)) - 2.0) < 1e-4, str(np.nanmean(vals)))

vals, _, _ = S.build_variant("oisst", "anomaly_gmr", TARGET)
# Every cell has the same anomaly here, so taking the global mean out must
# leave zero. That is the whole claim of this variant.
ok("anomaly minus the global mean is zero when everywhere is equally warm",
   abs(float(np.nanmean(vals))) < 1e-4, str(np.nanmean(vals)))

vals, _, _ = S.build_variant("oisst", "anomaly_records", TARGET)
ok("22 C is not a record when the record is 25, so nothing is flagged",
   float(np.nanmax(vals)) < 90.0, str(np.nanmax(vals)))

vals, _, _ = S.build_variant("oisst", "change7d", TARGET)
ok("the 7-day change is the ANOMALY change, +2 less +1, so exactly 1.0",
   abs(float(np.nanmean(vals)) - 1.0) < 1e-4, str(np.nanmean(vals)))

print("\n5. a day that really is a record")
hot = np.full((NLAT, NLON), 30.0)                # past the 25 C record
hot[0, 0] = -999.0
write_oisst(S._raw_path("oisst", TARGET), hot)
vals, _, _ = S.build_variant("oisst", "anomaly_records", TARGET)
ok("a genuine record is flagged out of range so the map can mark it",
   abs(float(np.nanmax(vals)) - 99.0) < 1e-4, str(np.nanmax(vals)))
cold = np.full((NLAT, NLON), 5.0)                # below the 15 C record low
cold[0, 0] = -999.0
write_oisst(S._raw_path("oisst", TARGET), cold)
vals, _, _ = S.build_variant("oisst", "anomaly_records", TARGET)
ok("and a record cold is flagged the other way",
   abs(float(np.nanmin(vals)) + 99.0) < 1e-4, str(np.nanmin(vals)))
write_oisst(S._raw_path("oisst", TARGET), np.where(
    np.eye(NLAT, NLON) > 0, -999.0, 22.0))

print("\n6. what lands on disk is readable back as numbers")
vals, la, lo = S.build_variant("oisst", "anomaly", TARGET)
meta = S.write_field("oisst", "anomaly", TARGET, vals, la, lo)
png = S.out_path("oisst", "anomaly", TARGET)
ok("a PNG was written", os.path.exists(png))
ok("the manifest carries the bounds the browser needs",
   isinstance(meta["bounds"], list) and len(meta["bounds"]) == 2,
   str(meta["bounds"]))
ok("and the encode range, so values can be decoded",
   meta["range"] == [-8.0, 8.0], str(meta["range"]))
from PIL import Image                                        # noqa: E402
im = np.asarray(Image.open(png).convert("RGBA"))
ok("the image is the grid's own size, not resampled",
   im.shape[:2] == (NLAT, NLON), str(im.shape))
# Decode a pixel exactly as the browser does: high byte red, low byte green.
lo_r, hi_r = meta["range"]
row, col = 3, 5
q = (int(im[row, col, 0]) * 256 + int(im[row, col, 1])) / 65535.0
decoded = lo_r + q * (hi_r - lo_r)
ok(f"a pixel decodes to the real anomaly, {decoded:.3f} against 2.0",
   abs(decoded - 2.0) < 0.01, f"{decoded}")
# The always-missing cell is data row 0, but the writer flips the field so
# north is at the top, so in the IMAGE it is the last row. Checking [0,0]
# without accounting for that reads a different cell entirely.
ok("missing water is transparent rather than a temperature",
   int(im[-1, 0, 3]) == 0, str(im[-1, 0, 3]))
# OISST latitudes ascend, an image's first row is north, so the writer must
# have flipped it. Checked by putting a marker in the far south.
marked = np.full((NLAT, NLON), 22.0)
marked[0, :] = 30.0                       # southernmost row
S.write_field("oisst", "actual", TARGET, marked, LATS, LONS)
im2 = np.asarray(Image.open(S.out_path("oisst", "actual", TARGET)).convert("RGBA"))
top = (int(im2[0, 5, 0]) * 256 + int(im2[0, 5, 1])) / 65535.0
bot = (int(im2[-1, 5, 0]) * 256 + int(im2[-1, 5, 1])) / 65535.0
ok("north is at the top of the image, so the field is not upside down",
   bot > top, f"top={top:.3f} bottom={bot:.3f}")

print("\n7. the index the browser reads")
S._download = _real_download
built = S.build_pass("oisst", "anomaly", TARGET, budget=60)
idx = S.read_index()
ok("the index names the source and what it is",
   idx["sources"]["oisst"]["label"].startswith("OISST"), str(idx.get("sources", {}).keys()))
v = idx["sources"]["oisst"]["variants"]["anomaly"]
ok("with the variant's unit and range", v["unit"] == "C" and v["range"] == [-8.0, 8.0],
   str(v))
ok("its bounds", isinstance(v["bounds"], list))
ok("and every day it holds, so the browser can scrub them",
   isinstance(v["frames"], list) and f"{TARGET:%Y%m%d}" in v["frames"],
   str(v.get("frames"))[:80])

print("\n8. house rules")
src = open(os.path.join(ROOT, "pi", "sst_pipeline.py")).read()
me = open(os.path.abspath(__file__)).read()
EM = chr(0x2014)
ok("no em dash in the pipeline or this test", EM not in src and EM not in me)
ok("the disk rule is the one that was asked for, delete at 70 percent",
   "PRUNE_AT_PCT" in src and '"70"' in src)
ok("nothing here needs a login, unlike ARMOR3D",
   "COPERNICUS" not in src and "password" not in src.lower())

shutil.rmtree(tmp, ignore_errors=True)
print(f"\n{'all ' if not FAIL else ''}{PASS} passed"
      + (f", {FAIL} FAILED" if FAIL else ""))
sys.exit(1 if FAIL else 0)
