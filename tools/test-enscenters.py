#!/usr/bin/env python3
"""
Ensemble cyclone detection: does it find storms, and does it reject impostors.

    python3 tools/test-enscenters.py
    python3 tools/test-enscenters.py --live    # also hit the real GEFS bucket

The detector's job is not "find low pressure". Low pressure is everywhere, and
the mid latitude storm track has far more of it than the tropics do. The job is
to find the closed lows that have a warm column above them and throw away
everything else, and the only way to know it does that is to hand it fields
where the right answer is known in advance.

So this builds three systems on a real global grid and asserts what happens to
each:

  A TROPICAL CYCLONE   a deep closed low with a warm thickness core above it.
                       Must be found, and must survive the warm core filter.
  AN EXTRATROPICAL LOW just as deep, just as closed, but COLD aloft. Must be
                       found by the pressure detector and then thrown out. This
                       is the case the whole warm core step exists for, and a
                       detector without it reports a January nor'easter as a
                       hurricane.
  AN OPEN TROUGH       a valley in the pressure field with no closed contour.
                       Must never be found at all.

Plus the two traps that are easy to write and hard to notice:

  THE DATE LINE   a storm at 179E is one storm, not two half storms. Longitude
                  has to wrap in the minimum filter and in every index lookup.
  THE BACKGROUND  thickness runs thick at the equator and thin at the poles.
                  Subtracting a wide mean removes that, but not perfectly: a
                  boxcar mean of a curved field leaves a residual of a few
                  metres, which on this background is about seven and in the
                  real atmosphere is similar. Seven metres clears the six metre
                  tropical amplitude gate, so amplitude alone would call empty
                  ocean a warm core. The closure requirement is what stops it,
                  and section 4 is written to fail if closure is ever dropped.

--live additionally checks that the real GEFS index still carries the three
records the pipeline asks for, since a renamed level matches nothing and the
member silently produces no centres.
"""

import argparse
import importlib.util
import math
import os
import sys
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = os.path.join(ROOT, "pi", "enscenters_pipeline.py")

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
    from scipy.ndimage import minimum_filter          # noqa: F401
except ImportError:
    print("needs numpy and scipy: apt install python3-numpy python3-scipy")
    sys.exit(0)

# eccodes is only used by the fetch half, which is not exercised here.
if "eccodes" not in sys.modules:
    try:
        import eccodes                                # noqa: F401
    except ImportError:
        m = types.ModuleType("eccodes")
        m.__getattr__ = lambda k: (lambda *a, **kw: None)
        sys.modules["eccodes"] = m

_spec = importlib.util.spec_from_file_location("ens", PY)
ens = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ens)


# ── A world to put storms in ─────────────────────────────────────────────────
# Half a degree, the grid GEFS actually publishes on, and latitude descending
# the way GRIB writes it, so the descending-axis handling is exercised rather
# than assumed.
LATS = np.arange(90.0, -90.5, -0.5)
LONS = np.arange(0.0, 360.0, 0.5)


def blob(field, lat0, lon0, amp, radius_deg):
    """Add a smooth circular feature centred on a point, wrapping longitude."""
    la = LATS[:, None]
    lo = LONS[None, :]
    dlat = la - lat0
    # Shortest way round the globe, so a feature at 179E is not treated as
    # being 358 degrees away from one at 179W.
    dlon = ((lo - lon0 + 180.0) % 360.0) - 180.0
    dlon = dlon * np.cos(np.radians(la))
    d2 = (dlat ** 2 + dlon ** 2) / (radius_deg ** 2)
    field += amp * np.exp(-d2)


def world():
    """A plausible background: 1013 hPa everywhere, thickness that thins poleward."""
    mslp = np.full((LATS.size, LONS.size), 1013.0)
    # The real climatological gradient, roughly: about 9400 gpm of 300-500
    # thickness in the deep tropics falling to about 8700 near the poles. This
    # is the background the anomaly step has to remove.
    #
    # Cosine squared, which is roughly the real shape and, more to the point,
    # is CURVED. See the note in section 4: a boxcar mean of any curved field
    # leaves a residual, and that residual is not a flaw in this test.
    thk = 8700.0 + 700.0 * np.cos(np.radians(LATS[:, None])) ** 2
    thk = thk + np.zeros((1, LONS.size))
    return mslp, thk


print("\n1. a tropical cyclone is found and kept")
{}
mslp, thk = world()
blob(mslp, 15.0, 300.0, -45.0, 3.0)      # deep closed low, 15N 60W
blob(thk, 15.0, 300.0, 45.0, 3.5)        # warm column above it
c = ens.detect_centers(mslp, LATS, LONS)
near = [x for x in c if ens.haversine_km(x["lat"], x["lon"], 15.0, -60.0) < 200]
ok("the pressure detector finds it", len(near) == 1,
   f"{len(near)} of {len(c)} centres near 15N 60W")
if near:
    ok("at about the right place",
       abs(near[0]["lat"] - 15) < 1 and abs(near[0]["lon"] + 60) < 1,
       f"{near[0]['lat']}, {near[0]['lon']}")
    ok("with a sensible central pressure",
       960 < near[0]["mslp_hpa"] < 975, str(near[0]["mslp_hpa"]))
    ok("and a wind estimated from it", near[0]["vmax_kt"] > 40,
       str(near[0]["vmax_kt"]))
kept = ens.filter_warm(c, thk, LATS, LONS)
ok("and the warm core filter keeps it",
   any(ens.haversine_km(x["lat"], x["lon"], 15.0, -60.0) < 200 for x in kept))

print("\n2. a cold core low is found, then thrown out")
mslp, thk = world()
blob(mslp, 45.0, 330.0, -45.0, 3.0)      # identical depth, 45N 30W
blob(thk, 45.0, 330.0, -45.0, 3.5)       # COLD aloft: thickness minimum
c = ens.detect_centers(mslp, LATS, LONS)
found = [x for x in c if ens.haversine_km(x["lat"], x["lon"], 45.0, -30.0) < 200]
ok("the pressure detector finds it too, because it is a real closed low",
   len(found) == 1, str(len(found)))
kept = ens.filter_warm(c, thk, LATS, LONS)
ok("but the warm core filter rejects it",
   not any(ens.haversine_km(x["lat"], x["lon"], 45.0, -30.0) < 200
           for x in kept),
   f"{len(kept)} kept")

print("\n3. the two side by side, which is the real test")
# Both at once. A detector that keeps both is useless and a filter that drops
# both is worse; exactly one must survive.
mslp, thk = world()
blob(mslp, 15.0, 300.0, -45.0, 3.0)
blob(thk, 15.0, 300.0, 45.0, 3.5)
blob(mslp, 45.0, 330.0, -45.0, 3.0)
blob(thk, 45.0, 330.0, -45.0, 3.5)
c = ens.detect_centers(mslp, LATS, LONS)
kept = ens.filter_warm(c, thk, LATS, LONS)
trop = [x for x in kept if ens.haversine_km(x["lat"], x["lon"], 15, -60) < 200]
extr = [x for x in kept if ens.haversine_km(x["lat"], x["lon"], 45, -30) < 200]
ok("the tropical one survives", len(trop) == 1, str(len(trop)))
ok("the extratropical one does not", len(extr) == 0, str(len(extr)))

print("\n4. the anomaly is what removes the background")
# The claim the whole warm core step rests on: subtracting a wide mean leaves
# storm sized structure and nothing else. Measured on a world with no storms in
# it at all, so anything left is the background failing to cancel.
mslp_q, thk_q = world()
dlat = abs(float(LATS[1] - LATS[0]))
dlon = abs(float(LONS[1] - LONS[0]))
quiet = ens.thickness_anomaly(thk_q, dlat, dlon)
trop = quiet[int((90 - 30) / 0.5):int((90 + 30) / 0.5), :]
resid = float(np.abs(trop).max())
# Worth being exact about, because the first version of this test asserted the
# residual was near zero, and it is not.
#
# A boxcar mean of a CURVED field does not equal the field at the centre of the
# box: the leftover is about (sigma squared / 2) times the second derivative,
# which for a 10 degree box on this background is about 7 m, and that is what
# is measured here. The real thickness field is curved the same way, so the
# real pipeline sees this too. Seven metres also clears the 6 m amplitude gate
# for the deep tropics, so amplitude ALONE would call an empty ocean a warm
# core.
#
# What saves it is the closure requirement: the residual is a smooth zonal band
# that never falls away in every direction, so it is never enclosed. That is
# why the closure test is not optional decoration, and the second assertion
# here is the one that actually matters.
ok("the background residual is small and bounded, not zero",
   resid < 10.0, f"max {resid:.2f} m")
ok("and nothing in an empty world reads as a warm core, because a smooth "
   "band never closes",
   not ens.is_warm_core(15.0, -60.0, quiet, LATS, LONS))
ok("which holds across the tropics, not just at one point",
   not any(ens.is_warm_core(la, lo, quiet, LATS, LONS)
           for la in (-20.0, -5.0, 0.0, 8.0, 22.0) for lo in (-140.0, 30.0)))

# With a storm in it, the anomaly IS the storm: its amplitude is the core, not
# the nine thousand metres of background the raw field carries.
mslp, thk = world()
blob(mslp, 15.0, 300.0, -45.0, 3.0)
blob(thk, 15.0, 300.0, 45.0, 3.5)
anom = ens.thickness_anomaly(thk, dlat, dlon)
i15, j60 = int((90 - 15) / 0.5), int(300 / 0.5)
ok("at the storm the anomaly is the core's own size, tens of metres",
   20.0 < float(anom[i15, j60]) < 60.0, f"{float(anom[i15, j60]):.1f} m")
ok("where the raw field is thousands, because it is mostly background",
   float(thk[i15, j60]) > 9000.0, f"{float(thk[i15, j60]):.0f} m")
ok("the storm's anomaly stands well clear of the background residual",
   float(anom[i15, j60]) > 4 * resid,
   f"{float(anom[i15, j60]):.1f} vs {resid:.2f}")
ok("and the warm core test passes on it", ens.is_warm_core(15.0, -60.0, anom,
                                                           LATS, LONS))

print("\n5. an open trough is not a storm")
mslp, thk = world()
# A north to south valley: low along a line, open at both ends. Real pressure
# fields are full of these and none of them are cyclones.
lo_idx = np.argmin(np.abs(LONS - 200.0))
for k in range(-8, 9):
    mslp[:, (lo_idx + k) % LONS.size] -= 18.0 * math.exp(-(k / 4.0) ** 2)
c = ens.detect_centers(mslp, LATS, LONS)
ok("nothing is reported along an open trough",
   not any(abs(x["lon"] - (-160.0)) < 6 for x in c),
   ", ".join(f"{x['lat']},{x['lon']}" for x in c[:4]))

print("\n6. a storm on the date line is one storm")
mslp, thk = world()
blob(mslp, 12.0, 179.5, -40.0, 3.0)
blob(thk, 12.0, 179.5, 40.0, 3.5)
c = ens.detect_centers(mslp, LATS, LONS)
near = [x for x in c
        if ens.haversine_km(x["lat"], x["lon"], 12.0, 179.5) < 300]
ok("found exactly once, not split in half by the seam", len(near) == 1,
   f"{len(near)}: " + ", ".join(f"{x['lat']},{x['lon']}" for x in near))
if near:
    ok("and reported in [-180, 180)", -180 <= near[0]["lon"] < 180,
       str(near[0]["lon"]))
ok("the warm core survives the seam too",
   any(ens.haversine_km(x["lat"], x["lon"], 12.0, 179.5) < 300
       for x in ens.filter_warm(c, thk, LATS, LONS)))

print("\n7. centres do not snap to the grid")
# Without sub-grid refinement every centre lands on a node and a hundred
# members tile into a visible lattice instead of a cloud of positions.
offs = []
for shift in (0.0, 0.13, 0.27, 0.41):
    mslp, thk = world()
    blob(mslp, 15.0 + shift, 300.0 + shift, -45.0, 3.0)
    c = ens.detect_centers(mslp, LATS, LONS)
    n = [x for x in c if ens.haversine_km(x["lat"], x["lon"],
                                          15.0 + shift, -60.0 + shift) < 200]
    if n:
        offs.append(n[0]["lat"])
ok("a storm moved a fraction of a cell reports a moved position",
   len(set(offs)) == len(offs) and len(offs) == 4,
   ", ".join(str(o) for o in offs))
ok("and at least one lands off a half degree node",
   any(abs((o / 0.5) - round(o / 0.5)) > 0.02 for o in offs),
   ", ".join(str(o) for o in offs))

print("\n8. tracks are stitched, and cannot teleport")
by_step = {0:  [{"lat": 15.0, "lon": -60.0, "mslp_hpa": 990.0, "vmax_kt": 45}],
           6:  [{"lat": 15.6, "lon": -61.5, "mslp_hpa": 985.0, "vmax_kt": 50}],
           12: [{"lat": 16.2, "lon": -63.0, "mslp_hpa": 980.0, "vmax_kt": 55}]}
t = ens.stitch(by_step, 6)
ok("three steps of one storm become one track", len(t) == 1, str(len(t)))
ok("with all three points", len(t[0]["points"]) == 3 if t else False)
# A low on the far side of an ocean is not the same storm however near it is
# in the list.
by_step = {0:  [{"lat": 15.0, "lon": -60.0, "mslp_hpa": 990.0, "vmax_kt": 45}],
           6:  [{"lat": 15.0, "lon": -130.0, "mslp_hpa": 990.0, "vmax_kt": 45}]}
t = ens.stitch(by_step, 6)
ok("a low 7000 km away is a different storm, not a 1200 kt jump",
   all(len(x["points"]) == 1 for x in t) or len(t) == 0,
   str([len(x["points"]) for x in t]))
# Single point tracks are one frame of noise, not a forecast.
t = ens.stitch({0: [{"lat": 5.0, "lon": 5.0, "mslp_hpa": 1005.0,
                     "vmax_kt": 10}]}, 6)
ok("a centre that exists for one frame is not published", t == [], str(t))

print("\n9. the wind estimate is labelled as an estimate, and behaves")
ok("a pressure at the environment gives no wind",
   ens.ah_vmax_kt(1010.0) == 0.0)
ok("deeper means windier", ens.ah_vmax_kt(950) > ens.ah_vmax_kt(980) > 0)
ok("a category five pressure gives a category five wind",
   130 < ens.ah_vmax_kt(910) < 175, str(round(ens.ah_vmax_kt(910), 1)))
ok("it is named as Atkinson-Holliday in the source, not passed off as model "
   "output", "Atkinson-Holliday" in open(PY, encoding="utf-8").read())

print("\n10. house rules and credit")
src = open(PY, encoding="utf-8").read()
ok("no em dash", chr(0x2014) not in src)
ok("Triple-A Tropics is credited in the source", "Triple-A Tropics" in src)
ok("and so is its author", "Austin-Adler" in src)
ok("the member list is the real ensemble, 31 of them",
   len(ens.MEMBERS) == 31 and ens.MEMBERS[0] == "gec00"
   and ens.MEMBERS[-1] == "gep30", str(len(ens.MEMBERS)))
ok("it asks for the three records the warm core needs",
   set(ens.WANT) == {("PRMSL", "mean sea level"), ("HGT", "300 mb"),
                     ("HGT", "500 mb")}, str(ens.WANT))

if "--live" in sys.argv:
    print("\n11. the real bucket still carries those three records")
    import datetime as dt
    import urllib.request
    d = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=12))
    url = (f"{ens.BUCKET}/{ens.member_path(d.strftime('%Y%m%d'), '00', 'gep01', 24)}.idx")
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            text = r.read().decode()
        pairs = {(x.split(':')[3], x.split(':')[4])
                 for x in text.splitlines() if len(x.split(':')) > 5}
        for want in ens.WANT:
            ok(f"{want[0]} at {want[1]} is published", want in pairs)
    except Exception as e:
        ok("the bucket answered", False, str(e)[:80])

print(f"\n{'all ' if not failed else ''}{passed} passed"
      + (f", {failed} FAILED" if failed else ""))
sys.exit(1 if failed else 0)
