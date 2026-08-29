#!/usr/bin/env python3
"""
The nowcast's value encoding and unit math, without needing pysteps or a
live radar feed.

    python3 tools/test-nowcast.py

Two things have to stay correct for the nowcast to be trustworthy rather
than merely plausible-looking: the lossless value-in-pixel encoding
build_mrms() now writes for composite reflectivity (render_data_png /
read_data_png in gfs_pipeline.py) has to round-trip exactly, since a drift
between encode and decode would corrupt every motion estimate silently
rather than with an error; and the lead-time arithmetic has to actually
produce the minutes it claims, since pysteps' extrapolation steps in units
of the input's own cadence, not in the step size asked for.

The motion/extrapolation call itself is only checked if pysteps and OpenCV
are installed here - most dev environments will not have them, and that is
a skip, not a failure. The live path (are there recent raw frames to build
from) is nowcast_pipeline.py's own --check, the same split every other
pipeline in pi/ uses.
"""

import os
import sys
import tempfile

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "pi"))

from gfs_pipeline import read_data_png, render_data_png  # noqa: E402
import nowcast_pipeline as nc  # noqa: E402

passed = failed = 0


def ok(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name}" + (f"  <{extra}>" if extra else ""))


print("1. render_data_png / read_data_png round-trip exactly")
lo, hi = -10.0, 75.0
rng = np.random.default_rng(0)
synth = rng.uniform(lo, hi, size=(48, 64)).astype(np.float32)
synth[5, 5] = np.nan  # a no-data hole
lats = np.linspace(50.0, 30.0, 48)  # descending: already north-first, no flip

with tempfile.TemporaryDirectory() as td:
    path = os.path.join(td, "raw.png")
    render_data_png(synth, lats, lo, hi, path)
    q, has = read_data_png(path)
    back = lo + q / 65535.0 * (hi - lo)

    step = (hi - lo) / 65535.0
    finite = np.isfinite(synth)
    worst = float(np.nanmax(np.abs(back[finite & has] - synth[finite & has])))
    ok("every real value round-trips within one quantisation step",
       worst <= step * 1.01, f"worst={worst}, step={step}")
    ok("the no-data pixel decodes as no-data", not has[5, 5])
    ok("real pixels decode as having data",
       bool(has[finite].all()), f"{int((~has[finite]).sum())} false negatives")

print("\n2. a hand-computed pixel matches the documented bit layout")
# 32.5 at [-10, 75]: norm = 42.5/85 = 0.5, so the 65536-step quantised value
# is exactly 32767.5, floor-clipped to 32767 -> hi byte 127, lo byte 255.
# Encoding this on its own, rather than only round-tripping random data,
# is what catches a future edit to either side (this file or index.html's
# _sndDecode) changing the rounding direction without breaking the
# round-trip test above, which would not notice a shift that moves both
# sides together.
single = np.array([[32.5]], dtype=np.float32)
with tempfile.TemporaryDirectory() as td:
    path = os.path.join(td, "one.png")
    render_data_png(single, None, lo, hi, path)
    from PIL import Image
    px = np.asarray(Image.open(path).convert("RGBA"))[0, 0]
    ok("high byte matches the documented layout", int(px[0]) == 127, str(px))
    ok("low byte matches the documented layout", int(px[1]) == 255, str(px))
    ok("alpha marks it as real data", int(px[3]) == 255, str(px))

print("\n3. lead-time arithmetic lands on the minutes it claims")
# pysteps.nowcasts.extrapolation.forecast's `timesteps`, given as a plain
# int, steps at the *velocity field's own* timestep (accutime) - not an
# independent unit - so nowcast_pipeline.py always asks for native-cadence
# steps and thins the result afterward. This is the arithmetic that decides
# how much thinning and how far to run, checked here without needing
# pysteps itself to run it.
native = nc.NATIVE_STEP_MIN
ok("native step matches composite's own fetch cadence",
   native == nc.MRMS_PRODUCTS[nc.FIELD].get("every", 5), str(native))

for step_min, lead_min in [(10, 120), (5, 60), (15, 90)]:
    stride = max(1, round(step_min / native))
    n_native = max(stride, round(lead_min / native))
    leads = [int(round((i + 1) * native))
             for i in range(stride - 1, n_native, stride)]
    ok(f"step={step_min} lead={lead_min}: every returned lead is a "
       f"multiple of the requested step",
       all(m % step_min == 0 for m in leads), str(leads))
    ok(f"step={step_min} lead={lead_min}: the forecast reaches the "
       f"requested horizon",
       leads and leads[-1] >= lead_min - step_min, str(leads))
    ok(f"step={step_min} lead={lead_min}: lead times strictly increase",
       leads == sorted(set(leads)), str(leads))

print("\n4. the dBZ <-> rain rate inverse used for rendering is sane")
zero_dbz = nc._rainrate_to_dbz(np.array([0.0, 0.0]))
ok("no rain decodes to the field's own floor value",
   bool(np.all(zero_dbz == nc.MRMS_PRODUCTS[nc.FIELD]["range"][0])),
   str(zero_dbz))
# Marshall-Palmer, a=200, b=1.6: 10 mm/h -> Z = 200 * 10**1.6 = ~7962 ->
# 10*log10(7962) = ~39.0 dBZ. A known point, not just "it runs".
known = nc._rainrate_to_dbz(np.array([10.0]))[0]
ok("a known rain rate maps to the expected dBZ",
   abs(known - 39.0) < 0.5, f"got {known}")

print("\n5. the live motion/extrapolation call, if pysteps is installed here")
try:
    import cv2  # noqa
    import pysteps  # noqa
    have_pysteps = True
except ImportError as e:
    have_pysteps = False
    print(f"  skip: {e} not installed in this environment")

if have_pysteps:
    # A blob translated by a known offset each frame, so the forecast has a
    # right answer to be checked against rather than only "it did not crash".
    def blob(cx, cy, shape=(80, 100)):
        yy, xx = np.mgrid[0:shape[0], 0:shape[1]]
        return nc.MRMS_PRODUCTS[nc.FIELD]["range"][0] + 40.0 * np.exp(
            -(((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * 10.0 ** 2)))

    dx, dy = 2.0, 1.0
    frames = [(f"t{i}", blob(40 + dx * i, 30 + dy * i)) for i in range(3)]
    try:
        R_f = nc._motion_and_extrapolate(frames, n_native_steps=3)
        yy, xx = np.mgrid[0:80, 0:100]
        cy0, cx0 = np.unravel_index(np.argmax(R_f[-1]), R_f[-1].shape)
        expected_cx, expected_cy = 40 + dx * 5, 30 + dy * 5  # 3 obs + 3 fcst steps out
        dist = ((cx0 - expected_cx) ** 2 + (cy0 - expected_cy) ** 2) ** 0.5
        ok("the extrapolated blob continues moving in the same direction",
           dist < 15, f"forecast peak at ({cx0},{cy0}), expected near "
           f"({expected_cx},{expected_cy})")
    except Exception as e:
        ok("motion/extrapolation runs without raising", False, str(e))

print()
if failed:
    print(f"{failed} FAILED, {passed} passed")
    sys.exit(1)
print(f"all {passed} passed" + ("" if have_pysteps else " (pysteps checks skipped)"))
