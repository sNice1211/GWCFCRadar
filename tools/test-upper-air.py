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
tree = ast.parse(src)


def node(name):
    for n in tree.body:
        if isinstance(n, ast.Assign) and getattr(n.targets[0], "id", "") == name:
            return n.value
    raise AssertionError(f"{name} not found in gfs_pipeline.py")


def const(name):
    return ast.literal_eval(node(name))


def shallow(dict_node):
    out = {}
    for k, v in zip(dict_node.keys, dict_node.values):
        if isinstance(v, ast.Dict):
            inner = {}
            for kk, vv in zip(v.keys, v.values):
                try:
                    inner[kk.value] = ast.literal_eval(vv)
                except Exception:
                    inner[kk.value] = "<expr>"
            out[k.value] = inner
        else:
            try:
                out[k.value] = ast.literal_eval(v)
            except Exception:
                out[k.value] = "<expr>"
    return out


MODELS = shallow(node("MODELS"))
FIELDS = shallow(node("FIELDS"))
UPPER = const("UPPER_FIELDS")
UPPER_SOURCES = const("UPPER_SOURCES")
RAMPS = const("RAMPS")

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
declared = ai.get("fields")
ok("AIGFS declares which fields it wants", isinstance(declared, (set, frozenset)),
   repr(declared))
if isinstance(declared, (set, frozenset)):
    missing = sorted(f for f in declared if f not in FIELDS)
    ok("every field it names is defined in the Pi's field table",
       not missing, ", ".join(missing))
    ok("it asks for upper air", ai.get("upper") is True)
    # AIGFS carries no surface fields at all, so a surface field in its list
    # would be a chart that never appears.
    surface = sorted(f for f in declared
                     if f in FIELDS and "isobaricInhPa"
                     not in str(FIELDS[f].get("levtype", "")) and f != "wind250")
    ok("it asks for nothing at the ground, because it carries nothing there",
       not surface, ", ".join(surface))

print("\n5. the upper air fields are defined all the way through")
ok("there are five of them", len(UPPER) == 5, str(UPPER))
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
LEVEL_FOR = {"gh500": "500 mb", "t850": "850 mb",
             "rh700": "700 mb", "vort500": "500 mb"}
for f in UPPER:
    if f == "wind250":
        continue
    ok(f"{f} says which message to read it from", f in UPPER_SOURCES)
    levs = {lev for _var, lev in UPPER_SOURCES.get(f, [])}
    ok(f"and reads {f} at {LEVEL_FOR[f]}", levs == {LEVEL_FOR[f]},
       ", ".join(sorted(levs)))
    # The level in the name has to be the level in the field table too, or the
    # decoder and the downloader are reading two different layers.
    ok(f"and the decoder agrees {f} is at {LEVEL_FOR[f]}",
       str(FIELDS.get(f, {}).get("level")) == LEVEL_FOR[f].split()[0],
       str(FIELDS.get(f, {}).get("level")))
ok("the jet is built from components rather than read",
   FIELDS.get("wind250", {}).get("derive") == "wind250")
ok("and both of its components are asked for",
   "WIND250_PARTS" in src and src.count("WIND250_LEVEL") >= 4)
ok("the decoder keeps the jet's components aside",
   "lev == WIND250_LEVEL" in src)
ok("and turns them into a speed",
   'found["wind250"]' in src)

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
want_upper = {"gfs", "nam", "gefs", "ecmwf", "ecmwfaifs", "aigfs"}
for name in sorted(want_upper):
    ok(f"{name} asks for upper air", MODELS.get(name, {}).get("upper") is True)
# Nothing else should have quietly picked it up.
extra = sorted(k for k, v in MODELS.items()
               if v.get("upper") is True and k not in want_upper)
ok("and nothing else did", not extra, ", ".join(extra))

print("\n7. ECMWF's own names for the same five")
# Parsed by hand rather than evaluated: the jet's level is written as the
# WIND250_LEVEL name so the two halves of the pipeline cannot drift apart, and
# a name is not a literal.
LEVEL_NAMES = {"WIND250_LEVEL": const("WIND250_LEVEL")}
pairs = set()
for elt in node("ECMWF_UPPER").elts:
    param = elt.elts[0].value
    lev = elt.elts[1]
    pairs.add((param, LEVEL_NAMES.get(getattr(lev, "id", ""),
                                      getattr(lev, "value", None))))
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

print("\n10. house rules")
# Built from its code point rather than written out, so this file can check
# for the character without containing one and failing its own rule.
EM_DASH = chr(0x2014)
for path, text in ((PY, src), (HTML, html), (__file__, None)):
    text = text if text is not None else open(path, encoding="utf-8").read()
    ok(f"no em dash in {os.path.basename(path)}", EM_DASH not in text)

print(f"\n{'all ' if not failed else ''}{passed} passed"
      + (f", {failed} FAILED" if failed else ""))
sys.exit(1 if failed else 0)
