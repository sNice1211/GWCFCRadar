#!/usr/bin/env python3
"""
Upper air, ECMWF's real layout, and AIGFS.

    python3 tools/test-upper-air.py

Three separate things landed together and each fails silently in its own way.

ECMWF publishes five products under names the pipeline was guessing at. The
ensemble mean is not "em", the AI ensemble is not "em" either, and the wave
model is not "wf". A wrong name is a 404, and a 404 from a model that is only
published twice a day reads exactly like "not built yet", which is why this
went unnoticed. So the names are pinned here.

AIGFS was renamed from GraphCastGFS and moved bucket. It carries pressure
levels and nothing at the ground, so it can only produce charts if the five
upper air fields it names actually exist. A model whose declared fields match
nothing downloads zero messages and produces zero charts without erroring.

And the upper air fields themselves have to line up across four tables in two
files: the Pi's FIELDS, the messages they are read from, the page's field
list, and the Inspector's scale for each. Any one out of step is a chart that
never appears or one painted on a scale it was not drawn with.

This parses the pipeline rather than importing it, so it runs without eccodes,
metpy or numpy installed.
"""

import ast
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = os.path.join(ROOT, "pi", "gfs_pipeline.py")
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


src = open(PY, encoding="utf-8").read()
html = open(HTML, encoding="utf-8").read()

# Loaded rather than parsed. The field tables are generated from a spec now
# rather than written out, so reading the source text finds an empty dict and
# a loop, and an earlier version of this test cheerfully reported that there
# were no upper air fields at all. The heavy dependencies are stubbed so this
# still runs without a GRIB stack installed.
import importlib.util  # noqa: E402
import types  # noqa: E402

for _n in ("eccodes", "numpy", "PIL", "PIL.Image", "requests"):
    try:
        __import__(_n)
    except ImportError:
        _m = types.ModuleType(_n)
        _m.__getattr__ = lambda k: types.SimpleNamespace()
        sys.modules[_n] = _m

_spec = importlib.util.spec_from_file_location("gp", PY)
gp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gp)

MODELS = gp.MODELS
FIELDS = gp.FIELDS
UPPER = gp.UPPER_FIELDS
UPPER_SOURCES = gp.UPPER_SOURCES
RAMPS = gp.RAMPS


def const(name):
    return getattr(gp, name)

print("\n1. ECMWF asks for the products that are actually published")
# Verified against a live listing of the open data bucket: the ensemble mean
# is published as enfo-ef, the AI ensemble as enfo-cf, and the wave model as
# wave-fc. Anything else 404s, and a 404 here looks like "not built yet".
EXPECTED = {
    "ecmwf":        (None,          None,   None),   # oper / fc, the defaults
    "ecmwfaifs":    ("aifs-single", None,   None),
    "ecmwfens":     (None,          "enfo", "ef"),
    "ecmwfaifsens": ("aifs-ens",    "enfo", "cf"),
    "ecmwfwave":    (None,          "wave", "fc"),
}
for name, (model, stream, kind) in EXPECTED.items():
    m = MODELS.get(name, {})
    ok(f"{name} is still in the catalogue", bool(m))
    if model:
        ok(f"{name} names model {model}", m.get("ecmwf_model") == model,
           m.get("ecmwf_model"))
    if stream:
        ok(f"{name} names stream {stream}", m.get("ecmwf_stream") == stream,
           m.get("ecmwf_stream"))
    if kind:
        ok(f"{name} names type {kind}", m.get("ecmwf_type") == kind,
           m.get("ecmwf_type"))
ok("no ECMWF model still asks for the old em type",
   not any(m.get("ecmwf_type") == "em" for m in MODELS.values()))
ok("no ECMWF model still asks for the old wf type",
   not any(m.get("ecmwf_type") == "wf" for m in MODELS.values()))

print("\n2. the ECMWF mirror is paced rather than hammered")
# The S3 mirror answers 503 SlowDown under a burst. The old code asserted in a
# comment that it did not throttle and retried on a flat 1.5s ladder, which is
# why ECMWF failed in clumps rather than one hour at a time.
ok("there is a minimum gap between ECMWF requests",
   "_ECMWF_MIN_GAP" in src)
ok("something recognises an ECMWF host", "def is_ecmwf(" in src)
ok("both ECMWF hosts are recognised",
   "data.ecmwf.int" in src and "ecmwf-forecasts" in src)
ok("503 is treated as a reason to back off further",
   re.search(r"status_code in \([^)]*503", src) is not None)
ok("the back off actually doubles",
   re.search(r"2\.0 \* \(2 \*\* attempt\)", src) is not None)

print("\n3. AIGFS is addressed where it is actually published")
ai = MODELS.get("aigfs", {})
ok("AIGFS is in the catalogue", bool(ai))
raw = ai.get("raw", "")
ok("it points at the open data bucket",
   "noaa-nws-graphcastgfs-pds" in raw, raw[:60])
ok("it uses the new aigfs prefix, not graphcastgfs",
   "aigfs.{date}" in raw, raw[:60])
ok("it asks for the pressure level file", "pres" in raw)
ok("it fetches by byte range, since there is no filter service for it",
   ai.get("fetch") == "range")
ok("it is in the default list",
   "aigfs" in const("DEFAULT_MODELS"))
ok("it has a disk estimate", "aigfs" in const("MB_PER_HOUR"))
ok("no model still points at the retired graphcastgfs prefix",
   "graphcastgfs." not in src.replace("noaa-nws-graphcastgfs-pds", ""))

print("\n4. AIGFS asks for fields that exist")
# This is the one that fails silently: a "fields" set is used to narrow the
# download, and a name in it that no table defines simply matches nothing.
# It used to name five fields, which capped it at three charts because it
# carries no surface fields for the other two to come from. Asking for the
# whole upper air set instead is what takes it to fifteen.
ok("AIGFS asks for upper air", ai.get("upper") is True)
ok("and does not narrow itself to a handful of fields",
   ai.get("fields") is None, repr(ai.get("fields")))

print("\n5. the upper air fields are defined all the way through")
# Twenty now: heights, temperatures, humidity, dewpoint, vorticity and
# vertical motion across the levels a forecast is actually reasoned at, plus
# a wind at each of six of them.
ok("there are twenty of them", len(UPPER) == 20, f"{len(UPPER)}: {UPPER}")
ok("every level a wind is drawn at has a field",
   all(f"wind{lev}" in UPPER for lev in gp.WIND_PL_LEVELS),
   str(gp.WIND_PL_LEVELS))
for f in UPPER:
    ok(f"{f} is in the Pi's field table", f in FIELDS)
for f in UPPER:
    spec = FIELDS.get(f, {})
    ok(f"{f} names a ramp that exists", spec.get("ramp") in RAMPS,
       str(spec.get("ramp")))
    rng = spec.get("range")
    ok(f"{f}'s range runs low to high",
       isinstance(rng, tuple) and len(rng) == 2 and rng[0] < rng[1], str(rng))

# Every one except the jet is read straight out of a message; the jet is built
# from its two components, exactly like the 10 m wind.
# The level is checked, not only that a source exists. A field named gh500
# read off the 550 mb message is a chart that draws, looks plausible and is
# simply the wrong layer, which is the worst kind of wrong.
# The level in a field's name has to be the level it is downloaded at AND the
# level the decoder reads it at. A gh500 read off the 550 mb message draws
# fine, looks entirely plausible, and is the wrong layer.
for f in UPPER:
    if f.startswith("wind"):
        continue
    want = re.sub(r"^[a-z]+", "", f) + " mb"
    ok(f"{f} says which message to read it from", f in UPPER_SOURCES)
    levs = {lev for _var, lev in UPPER_SOURCES.get(f, [])}
    ok(f"and reads {f} at {want}", levs == {want}, ", ".join(sorted(levs)))
    ok(f"and the decoder agrees {f} is at {want}",
       str(FIELDS.get(f, {}).get("level")) == want.split()[0],
       str(FIELDS.get(f, {}).get("level")))
# No model publishes a wind speed at a pressure level, so every one of these
# is built from its two components the way the 10 m wind is.
for _lev in gp.WIND_PL_LEVELS:
    ok(f"the {_lev}mb wind is built from components rather than read",
       FIELDS.get(f"wind{_lev}", {}).get("derive") == "windpl")
    ok(f"and both {_lev}mb components are asked for",
       len(gp.WIND_PL_PARTS.get(_lev, [])) == 2)
ok("the decoder keeps every one of those levels aside",
   "lev in KEEP_UV_LEVELS" in src)
ok("and turns each pair into a speed",
   'found[f"wind{_lev}"]' in src)
ok("the shear levels are kept aside too, so shear still works",
   all(lev in gp.KEEP_UV_LEVELS for lev in gp.SHEAR_LEVELS))

print("\n6. upper air is opt in, and the right models opted in")
# A pressure level is an extra message per field per forecast hour. Every
# model paying for five of those would be a real bill, so it is asked for.
ok("the selector takes an upper flag",
   "def select_from_idx(rows, want_shear=False, only=None, want_upper=False)"
   in src)
ok("the byte range fetch passes it through",
   re.search(r'select_from_idx\(rows, m\.get\("shear"\), m\.get\("fields"\),\s*'
             r'm\.get\("upper"\)\)', src) is not None)
ok("the filter service path passes it through",
   'bool(m.get("upper"))' in src)
ok("the ECMWF path passes it through",
   'm.get("upper") and pl and (param, plev) in ECMWF_UPPER' in src)
want_upper = {"gfs", "nam", "gefs", "gdas", "ecmwf", "ecmwfaifs", "aigfs",
              "gefsp02", "gefsp03", "gefsp04", "gefsp05",
              "gefsp06", "gefsp07"}
for name in sorted(want_upper):
    ok(f"{name} asks for upper air", MODELS.get(name, {}).get("upper") is True)
# Nothing else should have quietly picked it up.
extra = sorted(k for k, v in MODELS.items()
               if v.get("upper") is True and k not in want_upper)
ok("and nothing else did", not extra, ", ".join(extra))

print("\n7. ECMWF's own names for the same five")
pairs = set(gp.ECMWF_UPPER)
# ECMWF publishes a pressure level parameter called "d" and it is DIVERGENCE,
# not dewpoint. Painting divergence on a dewpoint scale looks entirely
# plausible and is completely wrong, so the dewpoint chart is deliberately
# absent from ECMWF rather than read off the wrong message.
ok("ECMWF is never asked for a pressure level dewpoint",
   not any(p == "d" for p, _l in pairs))
for want in [("gh", 500), ("t", 850), ("r", 700), ("vo", 500)]:
    ok(f"ECMWF {want[0]} at {want[1]} mb is wanted", want in pairs)
ok("and both jet components", ("u", 250) in pairs and ("v", 250) in pairs)
ok("the ECMWF reader tells a pressure level from the surface",
   'rec.get("levtype") == "pl"' in src)

print("\n8. the page offers the same five, on the same scales")
mfields = re.search(r"const HD_FIELDS = \[(.*?)\n\];", html, re.S)
ok("the page has a field list", bool(mfields))
listed = re.findall(r"id:\s*'([a-z0-9]+)'", mfields.group(1)) if mfields else []
for f in UPPER:
    ok(f"the page offers {f}", f in listed)

mscales = re.search(r"const HD_INSP_SCALES = \{(.*?)\n\};", html, re.S)
ok("the page has an Inspector scale table", bool(mscales))
stext = mscales.group(1) if mscales else ""
for f in UPPER:
    m = re.search(rf"\b{f}:\s*\{{\s*ramp:\s*'([a-z]+)',\s*lo:\s*(-?[\d.]+),"
                  rf"\s*hi:\s*(-?[\d.]+)", stext)
    ok(f"the Inspector knows {f}'s scale", bool(m))
    if m and f in FIELDS:
        spec = FIELDS[f]
        ok(f"{f}'s ramp matches the Pi's", m.group(1) == spec.get("ramp"),
           f"page {m.group(1)} vs pi {spec.get('ramp')}")
        lo, hi = spec.get("range", (None, None))
        ok(f"{f}'s range matches the Pi's",
           float(m.group(2)) == lo and float(m.group(3)) == hi,
           f"page {m.group(2)}-{m.group(3)} vs pi {lo}-{hi}")

# The new ramp has to be drawn on the page too, or the Inspector reads a chart
# it has no colours for and silently gives up.
mramps = re.search(r"const HD_INSP_RAMPS = \{(.*?)\n\};", html, re.S)
rtext = mramps.group(1) if mramps else ""
for f in UPPER:
    r = FIELDS.get(f, {}).get("ramp")
    ok(f"the page draws the {r} ramp {f} uses", re.search(rf"\b{r}\s*:", rtext)
       is not None)

# And it has to be the same ramp, not a ramp with the same name. A stop out of
# place turns every Inspector reading on that field into a wrong number.
def stops_from_py(name):
    # Same bracket counting, for the same reason.
    m = re.search(rf'"{name}":\s*\[', src)
    if not m:
        return None
    i = m.end() - 1
    depth = 0
    for j in range(i, len(src)):
        if src[j] == "[":
            depth += 1
        elif src[j] == "]":
            depth -= 1
            if depth == 0:
                return re.findall(r"\d+", src[i + 1:j])
    return None


def stops_from_js(name):
    # Counted by bracket rather than matched by regex. A ramp is a list of
    # lists, so the first "]]," inside it is the end of its first stop, not
    # the end of the ramp, and a lazy match reads one colour and calls it the
    # whole table. That made this check pass on ramps that did not match.
    m = re.search(rf"\b{name}\s*:\s*\[", rtext)
    if not m:
        return None
    i = m.end() - 1
    depth = 0
    for j in range(i, len(rtext)):
        if rtext[j] == "[":
            depth += 1
        elif rtext[j] == "]":
            depth -= 1
            if depth == 0:
                return re.findall(r"\d+", rtext[i + 1:j])
    return None


for name in sorted({FIELDS[f].get("ramp") for f in UPPER if f in FIELDS}):
    a, b = stops_from_py(name), stops_from_js(name)
    ok(f"the {name} ramp is identical in both files",
       a is not None and a == b, f"pi {a} vs page {b}")

print("\n9. forecast hour playback exists on the page")
ok("there is a play button", 'class="hd-t hd-play"' in html)
ok("there are step buttons",
   'class="hd-t hd-prev"' in html and 'class="hd-t hd-next"' in html)
ok("there is a speed picker", 'class="hd-speed"' in html)
ok("playback runs on a timer",
   "_hdPlayTimer = setInterval" in html)
ok("it wraps round rather than stopping at the end",
   "(_hdHourIdx + 1) % _hdHoursFor(_hdField).length" in html)
ok("frames are warmed into cache first, so the first pass is not a slideshow",
   "function _hdPreload()" in html and "_hdPreload();" in html)
ok("the preload is keyed so it does not re-run for the same field",
   "_hdPreloaded === key" in html)
ok("dragging the scrubber stops playback", "_hdPlayStop();" in html)
ok("closing the panel stops playback",
   re.search(r"function _hdDisable\(\) \{[^}]*_hdPlayStop\(\)", html, re.S)
   is not None)
ok("the transport hides when there is only one frame",
   "hours.length > 1 ? 'flex' : 'none'" in html)
ok("the button says pause while it is running",
   "_hdPlayTimer ? 'Pause'" in html)
ok("the transport is styled", "#hd-panel .hd-tape" in html)

print("\n10. thirteen more models, and every model's product count")
# The count of what a model can actually build is measured live by
# tools/check-model-products.py, which fetches the real index and matches it
# against the field table. That needs network, so it is not run here; what is
# pinned here is everything that made those numbers move, so a change that
# would quietly undo them fails without needing the network.
NEW_MODELS = {
    "gdas": "GDAS Global Analysis", "urma": "URMA 2.5 km Analysis",
    "gefs0p25": "GEFS Mean 0.25 deg", "cfs": "CFS Seasonal",
    "gefschem": "GEFS Aerosol", "namfire": "NAM Fire Weather Nest",
    "gefswavemean": "GEFS Wave Mean",
    "gefsp02": "GEFS Member 2", "gefsp03": "GEFS Member 3",
    "gefsp04": "GEFS Member 4", "gefsp05": "GEFS Member 5",
    "gefsp06": "GEFS Member 6", "gefsp07": "GEFS Member 7",
}
ok("thirteen models were added", len(NEW_MODELS) == 13)
for name, label in NEW_MODELS.items():
    m = MODELS.get(name, {})
    ok(f"{name} is in the catalogue", bool(m))
    ok(f"{name} is labelled {label}", m.get("label") == label, m.get("label"))
    ok(f"{name} is built by default", name in const("DEFAULT_MODELS"))
    ok(f"{name} has a disk estimate", name in const("MB_PER_HOUR"))
# nam32 is NAM's conus32 region, not a model. Adding it back as a model would
# undo the fold that made one entry per model with the place as a switch.
ok("the 32 km NAM is a region of NAM rather than a model again",
   "nam32" not in MODELS and "conus32" in (MODELS["nam"].get("regions") or {}))
ok("the wave model's three published grids are regions of it",
   set(MODELS["gfswave"].get("regions") or {})
   >= {"tropics", "atlantic", "epacific", "arctic"},
   str(list(MODELS["gfswave"].get("regions") or {})))
ok("and RAP's Alaska file is a region of RAP",
   "alaska" in (MODELS["rap"].get("regions") or {}))
regions = {r for m in MODELS.values() for r in (m.get("regions") or {})}
undefined = sorted(r for r in regions
                   if r not in const("REGIONS") and not r[0].isdigit())
ok("every region a model names has a box and a label",
   not undefined, ", ".join(undefined))
ok("and the page has a readable name for each",
   all(f"{r}:" in html or f"'{r}'" in html for r in const("REGIONS")))

# The high resolution models were capped at six fields to save bandwidth,
# which is not a model. Six is still available behind an environment switch.
FINE = const("FINE_FULL")
ok("the fine models ask for at least fifteen fields",
   len(FINE) >= 15, str(len(FINE)))
ok("including the storm scale ones only they carry",
   {"uphl", "echotop", "vil", "hail", "ltng", "satir"} <= FINE)
ok("and the lean six are still reachable by environment variable",
   "GWCFC_FINE_LEAN" in src and len(const("FINE_CORE")) == 6)

# Mirrors. Every entry was checked by building the address for a real model
# and fetching it; the ones with no working mirror are deliberately absent.
MIRRORS = const("S3_MIRRORS")
ok("the NOMADS paths have AWS mirrors to fall back on", len(MIRRORS) >= 8)
ok("and only buckets that actually answered are listed",
   not ({"blend", "href", "hiresw"} & set(MIRRORS)),
   ", ".join(sorted({"blend", "href", "hiresw"} & set(MIRRORS))))
ok("a NOMADS path becomes an AWS address",
   const("mirror_url")("gfs/prod/gfs.20260825/00/atmos/x.idx")
   == "https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.20260825/00/atmos/x.idx",
   str(const("mirror_url")("gfs/prod/gfs.20260825/00/atmos/x.idx")))
ok("and a path with no mirror says so rather than inventing one",
   const("mirror_url")("rrfs/prod/rrfs.20260825/x.idx") is None)
ok("the mirror is tried as well as NOMADS, not instead of it",
   "tried.append(f\"{RAW_BASE}/\" + tail)" in src)

print("\n11. ninety seven products, every one labelled and grouped")
ok("the Pi can build ninety plus fields", len(FIELDS) >= 90, str(len(FIELDS)))
ok("the page offers every one of them", len(listed) == len(FIELDS),
   f"page {len(listed)} vs pi {len(FIELDS)}")
ok("and offers nothing the Pi cannot build",
   not [f for f in listed if f not in FIELDS],
   ", ".join(f for f in listed if f not in FIELDS)[:120])
groups = re.findall(r"group:\s*'([^']+)'", mfields.group(1) if mfields else "")
ok("every field is in a group", len(groups) == len(listed),
   f"{len(groups)} groups for {len(listed)} fields")
ok("there are enough groups to be worth grouping by",
   len(set(groups)) >= 8, ", ".join(sorted(set(groups))))
ok("the panel renders them grouped rather than as one wall of buttons",
   "hd-gt" in html and "class=\"hd-g\"" in html)
ok("and the dropdown groups them too", "optgroup" in html)
# A label like "Instability" says nothing. Every label should name the
# quantity, and the level where the level is the point.
labels = re.findall(r"label:\s*'([^']+)'", mfields.group(1) if mfields else "")
ok("no label is a bare single word for a levelled field",
   all(("mb" in l or "(" in l or " " in l)
       for l in labels), ", ".join(l for l in labels if " " not in l))
ok("the page's tables are generated rather than hand kept",
   html.count("GENERATED by tools/sync-model-fields.py") == 3,
   str(html.count("GENERATED by tools/sync-model-fields.py")))

print("\n12. house rules")
# Built from its code point rather than written out, so this file can check
# for the character without containing one and failing its own rule.
EM_DASH = chr(0x2014)
for path, text in ((PY, src), (HTML, html), (__file__, None)):
    text = text if text is not None else open(path, encoding="utf-8").read()
    ok(f"no em dash in {os.path.basename(path)}", EM_DASH not in text)

print(f"\n{'all ' if not failed else ''}{passed} passed"
      + (f", {failed} FAILED" if failed else ""))
sys.exit(1 if failed else 0)
