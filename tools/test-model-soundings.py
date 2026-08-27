#!/usr/bin/env python3
"""
Soundings cut out of the models the map is already drawing.

    python3 tools/test-model-soundings.py

The models panel draws one level across a map. A sounding is the same data
turned ninety degrees: every level at one point, same run, same server. Until
now the only model soundings available here came from SounderPy, which serves
RAP and the reanalyses and nothing else at a latitude and longitude, so the
GFS run the map was drawn from could not be asked what the air looked like
above a point.

What is checked, and why each one is a way this goes quietly wrong:

  - the addresses. A model's map file is not always the file with a column in
    it: HRRR's map is wrfsfc, which is two-dimensional and has no levels at
    all, and its soundings live in wrfprs. When a model is redirected, its
    INDEX has to move with it, or the ask is built from one file's inventory
    and sent to another. That is the same shape of bug as the half-finished
    pgrb2full rename.

  - the menu. Waves, RTMA and the National Blend are surface products by
    definition. Offering them in a sounding menu is offering an entry that
    always fails.

  - the units. A GRIB carries kelvin and metres per second; a sounding is
    read in celsius and knots. Getting this wrong does not throw, it draws a
    plausible and completely wrong chart.

  - the cache key. f000 and f012 at one point are two different soundings.
    One key for both serves whichever was asked for first, for an hour.

Nothing here touches NOMADS. The catalogue is read, the arithmetic is run on
made-up numbers, and the wiring is read as text.
"""

import ast
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "pi"))

passed = failed = 0


def ok(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print("  ok   " + name)
    else:
        failed += 1
        print("  FAIL " + name + (("  <" + str(extra) + ">") if extra else ""))


import model_sounding as ms                                # noqa: E402

pi_src = open(os.path.join(ROOT, "pi", "gfs_pipeline.py"), encoding="utf-8").read()
svc = open(os.path.join(ROOT, "pi", "sounding_service.py"), encoding="utf-8").read()
serve = open(os.path.join(ROOT, "pi", "serve.py"), encoding="utf-8").read()
app = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()


def literal_dict(node):
    out = {}
    if not isinstance(node, ast.Dict):
        return out
    for k, v in zip(node.keys, node.values):
        if not isinstance(k, ast.Constant) or not isinstance(k.value, str):
            continue
        if isinstance(v, ast.Constant):
            out[k.value] = v.value
        elif isinstance(v, ast.Dict):
            out[k.value] = literal_dict(v)
    return out


MODELS = None
for node in ast.parse(pi_src).body:
    if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "") == "MODELS":
        MODELS = literal_dict(node.value)
assert MODELS

print("\n1. there are models to cut a column out of")
avail = ms.models()
ok("several", len(avail) >= 8, len(avail))
for want in ("gfs", "nam", "rap", "hrrr"):
    ok("%s is offered" % want, want in avail, sorted(avail))

print("\n2. and the surface-only products are NOT offered")
# Each of these is two-dimensional by definition. There is no version of a
# wave model with an air column in it.
for key, why in (("gfswave", "waves are the sea"),
                 ("rtma", "a surface analysis"),
                 ("nbm", "a blend of surface elements")):
    if key in MODELS:
        ok("%s is left out (%s)" % (key, why), key not in avail)

print("\n3. HRRR is redirected to the file that HAS a column")
over = ms.SOUNDING_OVERRIDE.get("hrrr")
ok("there is an override for it", bool(over), str(over))
ok("the map draws it from the surface file",
   "wrfsfc" in MODELS["hrrr"]["file"], MODELS["hrrr"]["file"])
ok("and the sounding asks the pressure file",
   "wrfprs" in over["file"], over["file"])
ok("on the 3d filter script, not the 2d one",
   over["filter"].endswith("_3d.pl"), over["filter"])

print("\n4. and its INDEX moved with it, which is the easy half to forget")
spec, was_over = ms.column_spec(MODELS["hrrr"], "hrrr")
ok("column_spec says it was overridden", was_over)
ok("the index is the pressure file's index",
   "wrfprs" in spec["raw"], spec["raw"])
ok("file and index name the same file",
   spec["raw"].endswith(spec["file"] + ".idx"),
   f"{spec['file']} vs {spec['raw']}")
# Every override, not just this one.
for key, o in ms.SOUNDING_OVERRIDE.items():
    s, _ = ms.column_spec(MODELS[key], key)
    ok("%s: file and index agree" % key,
       s["raw"].endswith(s["file"] + ".idx"), f"{s['file']} vs {s['raw']}")

print("\n5. a model with no override is left exactly as it is")
s, was = ms.column_spec(MODELS["gfs"], "gfs")
ok("not marked overridden", was is False)
ok("and its addresses are untouched",
   s["file"] == MODELS["gfs"]["file"] and s["raw"] == MODELS["gfs"]["raw"])

print("\n6. only real pressure levels count as levels")
for good in ("1000 mb", "500 mb", "250 mb", "925 mb"):
    ok("%r is a level" % good, bool(ms.MB_LEVEL_RE.match(good)))
for bad in ("surface", "2 m above ground", "mean sea level",
            "entire atmosphere", "0.4 mb above ground", "500 mb above ground"):
    ok("%r is not" % bad, not ms.MB_LEVEL_RE.match(bad))

print("\n7. dewpoint from humidity, the same way the browser does it")
# Saturated air has a dewpoint equal to its temperature. Anything else here
# is the formula being wrong rather than approximate.
ok("100 percent humidity gives back the temperature",
   abs(ms._dewpoint_from_rh(20.0, 100.0) - 20.0) < 0.05,
   ms._dewpoint_from_rh(20.0, 100.0))
ok("drier air gives a lower dewpoint",
   ms._dewpoint_from_rh(20.0, 50.0) < 20.0,
   ms._dewpoint_from_rh(20.0, 50.0))
ok("and about 9.3 C at 20 C and 50 percent, which is the known answer",
   abs(ms._dewpoint_from_rh(20.0, 50.0) - 9.27) < 0.2,
   ms._dewpoint_from_rh(20.0, 50.0))
ok("a missing humidity is None, not a guess",
   ms._dewpoint_from_rh(20.0, None) is None)
ok("zero humidity does not divide by zero",
   ms._dewpoint_from_rh(20.0, 0.0) is not None)

print("\n8. the units a sounding is actually read in")
src = open(os.path.join(ROOT, "pi", "model_sounding.py"), encoding="utf-8").read()
body = src[src.index("def model_profile("):]
ok("kelvin is turned into celsius", "273.15" in body)
ok("and only when the number looks like kelvin, so a celsius file is not "
   "shifted twice", "> 100" in body)
ok("metres per second are turned into knots", "1.943844" in body)
ok("both components, not just one",
   body.count("1.943844") == 2, body.count("1.943844"))

print("\n9. a level counts only when it is complete")
ok("temperature, dewpoint, height and both winds are all required",
   re.search(r"if td_c is None or uu is None or vv is None or zz is None",
             body) is not None)
ok("and a handful of complete levels is refused rather than drawn",
   "MIN_LEVELS" in body and ms.MIN_LEVELS >= 5, ms.MIN_LEVELS)

print("\n10. the service routes model: sources somewhere else entirely")
ok("there is a prefix", 'MODEL_PREFIX = "model:"' in svc)
ok("sounding() sends them to the model path",
   "fetch_model_profile" in svc)
ok("the forecast hour is part of the cache key, so f000 and f012 are two "
   "soundings", 'key += f"_f{int(fhr or 0):03d}"' in svc)
ok("and the look-back loop is NOT applied to them, since a forecast has "
   "forecast hours rather than recent ones",
   svc.index("fetch_model_profile(source") > svc.index("MODEL_PREFIX"))

print("\n11. the door accepts and checks the new arguments")
ok("fhr is read", 'one("fhr"' in serve)
ok("and range checked, so a typo cannot ask for hour 90000",
   "0 <= fhr <= 384" in serve)
ok("run is checked to be a real run stamp",
   r'\d{8}/\d{2}' in serve)
ok("an unknown model is refused by name, with the list",
   "no model called" in serve and '"models"' in serve)
ok("the cache key on this side carries the hour too",
   'key += f"_f{fhr:03d}"' in serve)
ok("and there is a door that says what this Pi can serve",
   "/sounding/sources" in serve and "def _sounding_sources" in serve)

print("\n12. the app asks the Pi rather than carrying a typed list")
ok("it fetches the sources door", "/sounding/sources" in app)
ok("model entries are built from that answer, not written down",
   "_sndLoadPiSources" in app and "isModel: true" in app)
ok("the picker groups them apart from the analyses",
   "Models, at a forecast hour" in app)
ok("a model sounding has its own fetch, not a flag on the analysis one",
   "_sndPiModelSounding" in app)
ok("and it sends fhr rather than when, because the hour means the opposite "
   "thing", re.search(r"_sndPiModelSounding[\s\S]{0,1200}fhr:", app) is not None)

print("\n13. the sources that were hidden while nothing built are back")
row = re.search(r"const SND_SOURCES = \[([\s\S]*?)\n\];", app)
ok("the list is there", bool(row))
block = row.group(1)
for sid in ("'rap'", "'obs'", "'pisite'", "'levels'"):
    line = next((ln for ln in block.splitlines() if sid in ln), "")
    ok("%s is offered again" % sid.strip("'"),
       bool(line) and "hidden: true" not in line, line.strip()[:90])

print("\n14b. soundings reach further than the pictures do")
# The catalogue's "out" is a bandwidth budget for full-domain images. A
# sounding is one small box, so stopping where the pictures stop throws away
# most of a run for no reason.
for key, want in (("gfs", 384), ("nam", 84), ("gefs", 384)):
    reach, step = ms.reach_for(key, MODELS[key], cyc="06")
    ok("%s reaches f%03d for a sounding" % (key, want), reach == want, reach)
    ok("  which is further than its maps go (f%03d)" % MODELS[key]["out"],
       reach > MODELS[key]["out"])
# HRRR and RAP publish much further on their extended runs, and offering
# hour 40 of a run that stops at 18 is offering a stop that cannot answer.
ok("HRRR reaches 48 on an extended run",
   ms.reach_for("hrrr", MODELS["hrrr"], cyc="06")[0] == 48)
ok("and only 18 on the ones in between",
   ms.reach_for("hrrr", MODELS["hrrr"], cyc="07")[0] == 18)
ok("RAP reaches 51 on an extended run",
   ms.reach_for("rap", MODELS["rap"], cyc="15")[0] == 51)
ok("and only 21 on the ones in between",
   ms.reach_for("rap", MODELS["rap"], cyc="16")[0] == 21)
ok("a model with no reach of its own keeps the catalogue's numbers",
   ms.reach_for("nosuch", {"out": 33, "step": 7}) == (33, 7))
ok("and the menu reports the reach, not the picture budget",
   ms.models()["gfs"]["out"] > ms.models()["gfs"]["mapOut"],
   f"{ms.models()['gfs']['out']} vs {ms.models()['gfs']['mapOut']}")

print("\n15. the failures that made this look dead the first time")
ok("an empty answer from the Pi is NOT cached forever, because an empty "
   "array is truthy and that made the first try the last one",
   "_sndPiSources && _sndPiSources.length" in app)
ok("and a Pi with no such door says so in the console rather than silently "
   "offering half a menu", "has no /sounding/sources yet" in app)
ok("the slider scale is set from the SOURCE before the fetch, not from "
   "whatever answered after it",
   "_sndSyncHourScale" in app and "_wantModel" in app)
ok("a model that fell back to Open-Meteo keeps its forecast-hour scale",
   "if (_wantModel) el._piMode = false;" in app)
ok("and that fallback asks for the current hour rather than reading the "
   "forecast hour as hours ago", "_sndOpenMeteo(lat, lon, 0, pick.id)" in app)

print("\n16. the slider means forecast hours for a model, and says so")
ok("a model gets its own hour scale", "_sndModelHours" in app)
ok("switching source rebuilds it before fetching, not after",
   app.index("_sndSyncHourScale(el);\n      _sndRefresh(el, 0);") > 0)
ok("the label reads F+ for a model", "'F+' + String(hr).padStart(3, '0')" in app)
ok("and the note says it is a forecast rather than an analysis",
   "not what it is doing" in app)

print()
if failed:
    print("%d FAILED, %d passed" % (failed, passed))
    sys.exit(1)
print("all %d passed" % passed)
