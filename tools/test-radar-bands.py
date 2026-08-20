#!/usr/bin/env python3
"""
The Pi's radar colours, and why they are bands and not a gradient.

    python3 tools/test-radar-bands.py

The Pi paints reflectivity by normalising a value into a 0-255 index and
looking that index up in a 256-entry table. The table used to be built by
sliding between eight colour stops, which meant every dBZ got its own slightly
different shade and no two shades meant anything in particular.

That is not how radar is drawn. A forecaster reads a band EDGE as a threshold:
35 dBZ is about where a shower becomes a storm, 50 is where hail starts being
worth thinking about, 60 is a core. A gradient has no edges, so none of those
numbers can be read off the picture, and once the browser smooths the finished
PNG as it magnifies it, every echo becomes a soft rainbow blob.

So the edges are what is checked here, not the pretty colours: a tenth of a
dBZ either side of a threshold must give two different colours, a whole band
must give exactly one, and the table has to be rebuilt when a product declares
a different range, because 50 dBZ is 50 dBZ whatever the scale runs from.

The functions are compiled out of the source rather than imported, so this
runs without eccodes or metpy installed. NumPy is needed and is present.
"""

import ast
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GFS = os.path.join(ROOT, "pi", "gfs_pipeline.py")
RADAR = os.path.join(ROOT, "pi", "radar_pipeline.py")

passed = failed = 0


def ok(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name}" + (f"  <{extra}>" if extra else ""))


try:
    import numpy as np
except ImportError:
    print("numpy is not installed, skipping.")
    sys.exit(0)

gfs_src = open(GFS, encoding="utf-8").read()
radar_src = open(RADAR, encoding="utf-8").read()

# The colour machinery, compiled alone. Everything it needs is numpy.
ns = {"np": np}
WANT = {"RAMPS", "build_lut", "LUTS", "BANDS", "build_band_lut",
        "_BAND_LUTS", "lut_for", "_idx_at", "band_alpha"}
for node in ast.parse(gfs_src).body:
    name = None
    if isinstance(node, ast.FunctionDef):
        name = node.name
    elif isinstance(node, ast.Assign) and getattr(node.targets[0], "id", None):
        name = node.targets[0].id
    if name in WANT:
        exec(ast.get_source_segment(gfs_src, node), ns)
missing = WANT - set(ns)
if missing:
    print(f"could not compile {sorted(missing)} out of gfs_pipeline.py")
    sys.exit(1)


def colour(ramp, value, lo, hi):
    """What the Pi would actually paint for one reading."""
    idx = int(np.clip(round((value - lo) / (hi - lo) * 255), 0, 255))
    return tuple(int(x) for x in ns["lut_for"](ramp, lo, hi)[idx])


print("\n1. reflectivity is bands, and the edges are the thresholds")
REF_LO, REF_HI = -10, 75
# Half a dBZ either side rather than a tenth: the 256-entry encoding is a
# third of a dBZ per step on this scale, so a tenth can land on the same step
# and prove nothing either way.
for edge in (20, 35, 50, 60, 65):
    below = colour("radar", edge - 0.5, REF_LO, REF_HI)
    above = colour("radar", edge + 0.5, REF_LO, REF_HI)
    ok(f"{edge} dBZ is a real edge", below != above, f"{below} vs {above}")

inside = {colour("radar", v, REF_LO, REF_HI) for v in (35.5, 37, 39, 39.5)}
ok("and a whole band is one colour, which is what makes an edge readable",
   len(inside) == 1, str(inside))
ok("20 dBZ is the green everyone knows",
   colour("radar", 21, REF_LO, REF_HI) == (2, 253, 2),
   str(colour("radar", 21, REF_LO, REF_HI)))
ok("35 is yellow", colour("radar", 36, REF_LO, REF_HI) == (253, 248, 2))
ok("50 is red", colour("radar", 51, REF_LO, REF_HI) == (253, 0, 0))
ok("65 is magenta", colour("radar", 66, REF_LO, REF_HI) == (248, 0, 253))
seen = {colour("radar", e + 0.5, REF_LO, REF_HI) for e, _ in ns["BANDS"]["radar"]}
ok("and all fifteen bands are different colours from each other",
   len(seen) == 15, str(len(seen)))

print("\n2. the table follows the range, because a band edge is a real value")
# A product that declares 0 to 80 rather than -10 to 75 must still put red at
# 50 dBZ. A table built once for one range would put it wherever 50 happened
# to fall on the other.
for lo, hi in ((-10, 75), (0, 80), (-30, 80)):
    ok(f"50 dBZ is red on a {lo} to {hi} scale",
       colour("radar", 51, lo, hi) == (253, 0, 0), str(colour("radar", 51, lo, hi)))
ok("and the two tables really are different objects, not one reused",
   ns["lut_for"]("radar", -10, 75) is not ns["lut_for"]("radar", 0, 80))
ok("while asking twice for the same range is cached rather than rebuilt",
   ns["lut_for"]("radar", -10, 75) is ns["lut_for"]("radar", -10, 75))

print("\n3. everything that is not radar is left as a gradient")
# A ramp with no bands must be untouched: temperature, cloud cover and the
# rest are continuous fields and banding them would invent structure.
ok("a smooth ramp still comes back smooth",
   ns["lut_for"]("temp", -40, 45) is ns["LUTS"]["temp"])
ok("and the banded ones are only the two that should be",
   set(ns["BANDS"]) == {"radar", "velocity"}, str(sorted(ns["BANDS"])))

print("\n4. velocity is banded too, and symmetric")
VLO, VHI = -40, 40
ok("inbound is green",
   colour("velocity", -30, VLO, VHI)[1] > colour("velocity", -30, VLO, VHI)[0],
   str(colour("velocity", -30, VLO, VHI)))
ok("outbound is red",
   colour("velocity", 30, VLO, VHI)[0] > colour("velocity", 30, VLO, VHI)[1],
   str(colour("velocity", 30, VLO, VHI)))
ok("and the strong end is brighter than the weak end, so a couplet stands out",
   sum(colour("velocity", -38, VLO, VHI)) > sum(colour("velocity", -12, VLO, VHI)),
   f"{colour('velocity', -38, VLO, VHI)} vs {colour('velocity', -12, VLO, VHI)}")

print("\n5. what is below the lowest band is not painted at all")
# This is the haze. Below the first band a reading has no colour of its own,
# so it was painted in the first band's, and nine dBZ of clear-air return and
# ground clutter came out as a pale blue wash centred on the radar.
idx = np.clip(np.round((np.array([-8.0, -2.0, 0.0, 4.0, 6.0, 30.0])
                        - REF_LO) / (REF_HI - REF_LO) * 255), 0, 255).astype(np.uint8)
alpha = np.full(idx.shape, 210, dtype=np.uint8)
ns["band_alpha"]("radar", idx, alpha, REF_LO, REF_HI)
ok("everything under 5 dBZ is transparent",
   list(alpha[:4]) == [0, 0, 0, 0], str(list(alpha)))
ok("and everything at or above it is painted",
   alpha[4] > 0 and alpha[5] > 0, str(list(alpha)))

vidx = np.clip(np.round((np.array([-30.0, -4.0, 0.0, 3.0, 30.0]) - VLO)
                        / (VHI - VLO) * 255), 0, 255).astype(np.uint8)
valpha = np.full(vidx.shape, 210, dtype=np.uint8)
ns["band_alpha"]("velocity", vidx, valpha, VLO, VHI)
# A colour at zero would fill an entire sweep with air that is not moving, and
# the couplet worth seeing would be sitting inside it.
ok("still air is not painted either", list(valpha[1:4]) == [0, 0, 0], str(list(valpha)))
ok("but real motion both ways is", valpha[0] > 0 and valpha[4] > 0, str(list(valpha)))

talpha = np.full(idx.shape, 210, dtype=np.uint8)
ns["band_alpha"]("temp", idx, talpha, -40, 45)
ok("and a ramp with no bands has nothing hidden",
   list(talpha) == [210] * len(idx), str(list(talpha)))

print("\n6. every place the Pi paints one of these goes through the same door")
for path, src in (("gfs_pipeline.py", gfs_src), ("radar_pipeline.py", radar_src)):
    ok(f"{path} looks the table up by ramp AND range",
       'LUTS[spec["ramp"]]' not in src and 'lut_for(spec["ramp"], lo, hi)' in src)
ok("the single-site radar path hides its own clutter through band_alpha",
   radar_src.count("band_alpha(") >= 2, str(radar_src.count("band_alpha(")))
ok("and MRMS does as well, on top of its own per-product floor",
   'keep = np.isfinite(arr) & (arr >= spec["floor"])' in radar_src)
# The old hand-written floor was an index, not a value: 18 on the -10 to 75
# scale is minus four, so nine dBZ of nothing was being painted.
ok("the old hand-written index floor is gone",
   "alpha[idx < 18] = 0" not in radar_src)

print("\n7. the page and the Pi agree on what the colours are")
# Two implementations of one scale is two chances to be wrong, and a picture
# built on the Pi sitting beside one decoded in the browser must not be two
# different palettes for the same dBZ.
html = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
for value, hexes in ((20, "02fd02"), (35, "fdf802"), (50, "fd0000"),
                     (65, "f800fd"), (5, "04e9e7")):
    rgb = tuple(int(hexes[i:i + 2], 16) for i in (0, 2, 4))
    ok(f"{value} dBZ is the same colour in both",
       colour("radar", value + 0.5, REF_LO, REF_HI) == rgb
       and f"#{hexes}" in html,
       f"pi {colour('radar', value + 0.5, REF_LO, REF_HI)} vs page #{hexes}")

print()
if failed:
    print(f"{failed} FAILED, {passed} passed")
    sys.exit(1)
print(f"all {passed} passed")
