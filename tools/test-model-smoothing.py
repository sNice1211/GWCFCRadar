#!/usr/bin/env python3
"""
Model charts arrive smooth rather than as visible squares.

    python3 tools/test-model-smoothing.py

The blockiness people report in model data is not a missing blur. It is a
missing pixel count: the Pi writes one pixel per grid cell, so a global model
at 0.25 degrees is about 240 pixels across a continental box, and the browser
stretches those 240 across a screen several times wider. Every cell lands as a
square you can count.

smooth_upsample() interpolates the field up before it is coloured. These check
the two things that can go wrong with that:

  - it has to actually smooth, measured as the step between neighbouring
    values, not assumed from the fact that a resize happened
  - it must not destroy anything. Missing data cannot spread (a NaN dragged
    through a bicubic kernel poisons every pixel it touches), already-fine
    grids must be left alone, and the odd shapes a real pipeline hands it
    must not raise.

Parsed and executed on its own rather than importing the pipeline, so this
runs without eccodes or the rest of the Pi's stack installed.
"""

import ast
import os
import sys

import numpy as np

try:
    from PIL import Image
except ImportError:                                    # pragma: no cover
    print("Pillow is not installed, skipping. pip install pillow")
    sys.exit(0)

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


def const(name):
    for node in ast.parse(src).body:
        if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "") == name:
            return ast.literal_eval(node.value)
    raise AssertionError(name + " not found")


MIN_EDGE = const("SMOOTH_MIN_EDGE_PX")
MAX_EDGE = const("MAX_EDGE_PX")

ns = {"np": np, "Image": Image,
      "SMOOTH_MIN_EDGE_PX": MIN_EDGE, "MAX_EDGE_PX": MAX_EDGE}
for node in ast.parse(src).body:
    if isinstance(node, ast.FunctionDef) and node.name == "smooth_upsample":
        exec(ast.get_source_segment(src, node), ns)
assert "smooth_upsample" in ns, "smooth_upsample not found"
smooth = ns["smooth_upsample"]


print("\n1. the target is enough pixels to be smooth, and no more")
ok("a coarse field is grown to the smoothing floor", MIN_EDGE >= 800, MIN_EDGE)
ok("but never past the memory cap the browser has to live within",
   MIN_EDGE <= MAX_EDGE, "%s vs %s" % (MIN_EDGE, MAX_EDGE))

print("\n2. a coarse model really is smoothed, measured not assumed")
# A 0.25 degree model over a continental box, which is the case people see.
coarse = np.add.outer(np.linspace(0, 30, 120),
                      np.linspace(0, 10, 240)).astype(np.float32)
out = smooth(coarse)
ok("it grows to the smoothing floor",
   max(out.shape) >= MIN_EDGE, str(out.shape))
step_before = float(np.abs(np.diff(coarse, axis=1)).mean())
step_after = float(np.abs(np.diff(out, axis=1)).mean())
ok("neighbouring pixels are much closer in value than before",
   step_after < step_before / 2.0,
   "%.4f then %.4f" % (step_before, step_after))
ok("and the field still spans what it did, not a washed-out version",
   abs(float(np.nanmax(out)) - float(np.nanmax(coarse))) < 0.5
   and abs(float(np.nanmin(out)) - float(np.nanmin(coarse))) < 0.5,
   "%.2f..%.2f vs %.2f..%.2f" % (float(np.nanmin(out)), float(np.nanmax(out)),
                                 float(np.nanmin(coarse)), float(np.nanmax(coarse))))

print("\n3. missing data does not spread, which is what kills a naive resize")
holed = coarse.copy()
holed[50:55, 100:105] = np.nan
o2 = smooth(holed)
frac_before = float(np.isnan(holed).mean())
frac_after = float(np.isnan(o2).mean())
ok("the hole stays roughly the size it was",
   frac_after < frac_before * 2.0,
   "%.5f then %.5f" % (frac_before, frac_after))
ok("and the rest of the picture survives it",
   float(np.isfinite(o2).mean()) > 0.95, float(np.isfinite(o2).mean()))
ok("a field that is entirely missing comes back unchanged rather than raising",
   smooth(np.full((10, 10), np.nan, dtype=np.float32)).shape == (10, 10))

print("\n4. it only ever adds pixels")
fine = np.zeros((1100, 1400), dtype=np.float32)
ok("a grid already past the floor is returned untouched",
   smooth(fine).shape == fine.shape, str(smooth(fine).shape))
ok("a grid at the cap is not pushed past it",
   max(smooth(np.zeros((MAX_EDGE, MAX_EDGE), dtype=np.float32)).shape) <= MAX_EDGE)

print("\n5. the shapes a real pipeline hands it do not raise")
for shape in [(1, 1), (0, 0), (1, 50), (50, 1), (2, 2)]:
    try:
        smooth(np.zeros(shape, dtype=np.float32))
        ok("survives %s" % (shape,), True)
    except Exception as e:                              # noqa: BLE001
        ok("survives %s" % (shape,), False, repr(e))

print("\n6. it is wired into the one place every model field is written")
ok("render_png smooths before it colours",
   src.index("data = smooth_upsample(data)") < src.index('rgb = lut_for('))
ok("the interpolation happens on values, not on finished colours",
   "smooth_upsample" not in src[src.index("rgb = lut_for("):
                                src.index("rgb = lut_for(") + 400])

print()
if failed:
    print("%d FAILED, %d passed" % (failed, passed))
    sys.exit(1)
print("all %d passed" % passed)
