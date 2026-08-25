#!/usr/bin/env python3
"""
The model catalogue: what is offered, where it is offered, and what it draws.

    python3 tools/test-models.py

Two things happened to this catalogue and both can go wrong quietly.

The list had grown a row per model per place: NAM, NAM Alaska, NAM Hawaii, NAM
Puerto Rico, NAM 32 km, and the same again for the analyses and the blends.
Reading those as different models is wrong - it is one forecast, cut somewhere
else - so they folded into regions of their parent. A fold is exactly the kind
of change that silently loses an address, so this checks that every filename
that used to be reachable still is.

The other is that every model now reads eight more fields out of files it was
already downloading. A field is defined in three places that have to agree:
the Pi's FIELDS table, the plain name it is asked for by, and the page's own
list of what to show. Any one of them out of step is a chart that never
appears, or one that appears painted on a scale it was not drawn with.

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
    """A dict of dicts where the values may contain lambdas or names."""
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
# Loaded rather than parsed. The field table is generated from a spec now
# (twenty pressure level charts differ only in level and scale, so writing
# each by hand was twenty chances to paste the wrong range under the right
# name), and reading the source text finds an empty dict and a loop.
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
_gp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_gp)
FIELDS = _gp.FIELDS
REGIONS = shallow(node("REGIONS"))
DEFAULTS = const("DEFAULT_MODELS")
COST = const("MB_PER_HOUR")
RCOST = const("REGION_COST")
RAMPS = set(const("RAMPS").keys())
WANT = const("WANT_VARS")
FIELD_SOURCES = shallow(node("FIELD_SOURCES"))


def regions_of(m):
    r = m.get("regions")
    if isinstance(r, dict):
        return sorted(r)
    return ["conus"] if not m.get("per_storm") else []


print("\n1. the catalogue holds together")
ok("every model asked for by default is actually defined",
   not [d for d in DEFAULTS if d not in MODELS],
   str([d for d in DEFAULTS if d not in MODELS]))
ok("no model is asked for twice",
   len(DEFAULTS) == len(set(DEFAULTS)),
   str([d for d in set(DEFAULTS) if DEFAULTS.count(d) > 1]))
ok("every default has a cost estimate, so the cheapest-first order is real",
   not [d for d in DEFAULTS if d not in COST],
   str([d for d in DEFAULTS if d not in COST]))
ok("no cost is carried for a model that no longer exists",
   not [k for k in COST if k not in MODELS],
   str([k for k in COST if k not in MODELS]))

used = set()
for k, v in MODELS.items():
    if isinstance(v.get("regions"), dict):
        used |= set(v["regions"])
ok("every region a model names is a region that exists",
   not (used - set(REGIONS)), str(sorted(used - set(REGIONS))))
ok("every region has a relative cost, so a nest is not charged CONUS rates",
   not (used - set(RCOST)), str(sorted(used - set(RCOST))))

print("\n2. the regional nests folded in without losing an address")
# Each of these used to be its own model. The filename is the thing that was
# genuinely unique about it, so the filename is what must still be reachable.
FOLDED = {
    "nam": {
        "alaska": "alaskanest",
        "hawaii": "hawaiinest",
        "prico": "priconest",
        "conus32": "awip32",
    },
    "rtma": {
        "alaska": "akrtma",
        "hawaii": "hirtma",
        "prico": "prrtma",
    },
    "nbm": {
        "alaska": ".ak.grib2",
        "hawaii": ".hi.grib2",
    },
}
for model, wanted in FOLDED.items():
    m = MODELS.get(model, {})
    have = m.get("regions") or {}
    for region, marker in wanted.items():
        spec = have.get(region)
        blob = str(spec)
        ok(f"{model} still reaches its {region} file ({marker})",
           spec is not None and marker in blob, blob[:90])

ok("the nine folded models are gone from the list",
   not [n for n in ("namak", "namhi", "nampr", "nam32", "rtmaak", "rtmahi",
                    "rtmapr", "nbmak", "nbmhi") if n in MODELS])
ok("and nothing anywhere in the pipeline still refers to them by name",
   not [n for n in ("namak", "namhi", "nampr", "nam32", "rtmaak", "rtmahi",
                    "rtmapr", "nbmak", "nbmhi") if n in src])
ok("their parents are still built by default",
   all(n in DEFAULTS for n in ("nam", "rtma", "nbm")))

print("\n3. a region does not steal its model's name")
# region_spec merges REGIONS[key] into the spec, and REGIONS carries a label.
# Left alone, a NAM run over Alaska would be labelled "Alaska".
seg = ast.get_source_segment(src, node("MODELS"))  # keeps the parse honest
fn = [n for n in tree.body
      if isinstance(n, ast.FunctionDef) and n.name == "region_spec"]
ok("region_spec exists", len(fn) == 1)
body = ast.get_source_segment(src, fn[0]) if fn else ""
ok("the region's own label is kept under a separate name",
   "region_label" in body, body[-200:])
ok("so the model's label is not overwritten by the region's",
   'pop("label"' in body, body[-200:])

print("\n4. every model still names a real file")
# Three kinds of address live here: a filename inside a NOMADS directory, a
# raw path read by byte range against its own .idx, or a whole source URL for
# the models that are not on NOMADS at all.
missing = [k for k, v in MODELS.items()
           if not v.get("per_storm")
           and not (v.get("file") or v.get("raw") or v.get("source"))]
ok("no model was left without an address by the fold", not missing, str(missing))
res_missing = [k for k, v in MODELS.items() if not v.get("res")]
ok("every model states its resolution", not res_missing, str(res_missing))
lbl_missing = [k for k, v in MODELS.items() if not v.get("label")]
ok("every model states its label", not lbl_missing, str(lbl_missing))

print("\n5. the eight new fields are defined all the way through")
NEW = ["rh2m", "tcc", "vis", "cin", "prate", "snod", "lftx", "dswrf"]
ok("all eight are in the Pi's field table",
   not [f for f in NEW if f not in FIELDS],
   str([f for f in NEW if f not in FIELDS]))

bad_ramp = sorted({v["ramp"] for v in FIELDS.values() if isinstance(v, dict)
                   and v.get("ramp") not in RAMPS and v.get("ramp") != "<expr>"})
ok("every field names a colour ramp that exists", not bad_ramp, str(bad_ramp))

bad_range = [k for k, v in FIELDS.items()
             if isinstance(v.get("range"), tuple) and v["range"][0] >= v["range"][1]]
ok("every field's range runs low to high", not bad_range, str(bad_range))

if True:
    ok("each new field says which plain name and level to read it from",
       not [f for f in NEW if f not in FIELD_SOURCES],
       str([f for f in NEW if f not in FIELD_SOURCES]))
    # The plain name asked for has to be in WANT_VARS, or the byte-range
    # fetcher never selects that message out of the index.
    asked = set()
    for f in NEW:
        for name, _lev in (FIELD_SOURCES.get(f) or []):
            asked.add(name)
    ok("and every one of those names is in the list actually asked for",
       not (asked - set(WANT)), str(sorted(asked - set(WANT))))

print("\n6. the page knows about the same fields the Pi builds")
m = re.search(r"const HD_FIELDS = \[(.*?)\n\];", html, re.S)
ok("the page has a field list", bool(m))
page_fields = re.findall(r"\{\s*id:\s*'([a-z0-9]+)'", m.group(1)) if m else []
ok("every new field is offered on the page",
   not [f for f in NEW if f not in page_fields],
   str([f for f in NEW if f not in page_fields]))
ok("the page does not offer a field the Pi cannot build",
   not [f for f in page_fields if f not in FIELDS],
   str([f for f in page_fields if f not in FIELDS]))

ms = re.search(r"const HD_INSP_SCALES = \{(.*?)\n\};", html, re.S)
scales = dict(re.findall(r"(\w+):\s*\{\s*ramp:\s*'(\w+)'", ms.group(1))) if ms else {}
ok("the Inspector has a scale for every new field",
   not [f for f in NEW if f not in scales],
   str([f for f in NEW if f not in scales]))

mr = re.search(r"const HD_INSP_RAMPS = \{(.*?)\n\};", html, re.S)
page_ramps = set(re.findall(r"^\s*(\w+):\s*\[", mr.group(1), re.M)) if mr else set()
ok("every ramp the Inspector names is drawn on the page",
   not (set(scales.values()) - page_ramps),
   str(sorted(set(scales.values()) - page_ramps)))
ok("and the page's ramps mirror the Pi's",
   not (page_ramps - RAMPS), str(sorted(page_ramps - RAMPS)))

# A scale that disagrees with the Pi paints the right picture and reads the
# wrong number off it, which is worse than no Inspector at all.
if ms:
    page_scale = dict(
        (k, (float(lo), float(hi)))
        for k, lo, hi in re.findall(
            r"(\w+):\s*\{\s*ramp:\s*'\w+',\s*lo:\s*(-?[\d.]+),\s*hi:\s*(-?[\d.]+)",
            ms.group(1)))
    off = {}
    for k, (lo, hi) in page_scale.items():
        f = FIELDS.get(k)
        if isinstance(f, dict) and isinstance(f.get("range"), tuple):
            if (float(f["range"][0]), float(f["range"][1])) != (lo, hi):
                off[k] = (f["range"], (lo, hi))
    ok("and every range matches the one the Pi paints with", not off, str(off))

print("\n7. the page knows the new region names")
mrl = re.search(r"const HD_REGION_LABELS = \{(.*?)\n\};", html, re.S)
labels = set(re.findall(r"(\w+):", mrl.group(1))) if mrl else set()
ok("every region the Pi can build has a readable name on the page",
   not (used - labels), str(sorted(used - labels)))

print()
if failed:
    print(f"{failed} FAILED, {passed} passed")
    sys.exit(1)
print(f"all {passed} passed")
