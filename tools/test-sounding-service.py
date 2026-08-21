#!/usr/bin/env python3
"""
The Pi's /sounding door, and the service behind it.

    python3 tools/test-sounding-service.py

This is the path that makes the sounding panel show SHARPpy's numbers instead
of the browser's. Two halves get checked, differently, because they fail
differently.

The DOOR is exercised against a real HTTP server on a real socket, with a
stand-in sounding_service swapped into sys.modules. Query parsing, refusing
nonsense coordinates, the cache short circuit, the two-at-a-time queue, the
CORS header and the error wording are all things you cannot verify by reading:
they are what the socket actually says back.

The SERVICE is parsed rather than imported, because SounderPy, SHARPpy and
NumPy are not installed on the machine this runs on and will not be. What can
still be checked there is real: that neither library is imported at module
scope (so a Pi without them starts anyway), that the units are converted
explicitly rather than hoped for, and that every failure raises a sentence.

What is NOT checked here, and cannot be: whether SounderPy's addresses still
answer, and whether SHARPpy's attribute names still match. Both are live
questions about other people's libraries. `sounding_service.py --check` on the
Pi is the answer to the first half of that, which is why it exists.
"""

import ast
import json
import re
import os
import sys
import threading
import time
import types
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PI = os.path.join(ROOT, "pi")
SVC = os.path.join(PI, "sounding_service.py")
SERVE = os.path.join(PI, "serve.py")

passed = failed = 0


def ok(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name}" + (f"  <{extra}>" if extra else ""))


svc_src = open(SVC, encoding="utf-8").read()
src = svc_src
svc_tree = ast.parse(svc_src)
serve_src = open(SERVE, encoding="utf-8").read()


# ── 1. the service can be read without the libraries it uses ────────────────
print("\n1. it needs nothing that has to be installed")
top_imports = set()
for node in svc_tree.body:
    if isinstance(node, ast.Import):
        top_imports.update(a.name.split(".")[0] for a in node.names)
    elif isinstance(node, ast.ImportFrom) and node.module:
        top_imports.add(node.module.split(".")[0])
# SounderPy and SHARPpy were both tried and both refuse to build on a current
# Pi: SHARPpy pins a NumPy old enough to need distutils.msvccompiler, which
# Python removed, and SounderPy pulls in arm-pyart and cartopy, which are long
# C and C++ source builds on ARM. Neither was ever needed - NOAA serves the
# same profiles as plain text - and depending on them again would be walking
# back into a wall that has already been hit once.
ok("SounderPy is not imported anywhere",
   "sounderpy" not in top_imports and "import sounderpy" not in src,
   str(sorted(top_imports)))
ok("nor is SHARPpy required", "sharppy" not in top_imports, str(sorted(top_imports)))
ok("nor NumPy, which SHARPpy drags in",
   "numpy" not in top_imports, str(sorted(top_imports)))
# serve.py imports this file to answer a request, and an import that throws at
# module scope takes the door with it.
ok("so importing it costs nothing but the standard library",
   top_imports <= {"argparse", "json", "math", "os", "sys", "time",
                   "datetime", "urllib"},
   str(sorted(top_imports)))

# It really does import, here, now, with nothing installed.
sys.path.insert(0, PI)
import sounding_service as svc          # noqa: E402
ok("and it really does import on a machine with nothing installed", True)
ok("and can be asked what it can reach", callable(getattr(svc, "check", None)))
ok("SHARPpy is reported as an optional bonus, not a requirement",
   set(svc.have_libs()) == {"sharppy"}, str(svc.have_libs()))


# ── 2. units are converted, not assumed ─────────────────────────────────────
print("\n2. the text format is read in the units it is written in")
# The single thing most likely to be got wrong here. GSD writes pressure in
# TENTHS of a millibar and both temperatures in TENTHS of a degree, so a
# profile read without dividing by ten is a plausible looking sounding of a
# planet nobody lives on: a surface at 9720 mb and 248 degrees.
GSD = """    RAOB     12     00      21      Aug    2026
   CAPE    999    CIN    -50  Helic    150     PW     30
      3         35.40    -97.60  99999  99999
      9   9720    357    248    195    170     15
      4   9250    714    221    180    185     22
      4   8500   1450    172    120    200     35
      4   7000   3050     68    -20    230     45
      4   5000   5700   -130   -250    250     60
      5   2500  99999   -530   -650  99999  99999
      4   2000  11800   -570   -700    265     80"""
prof, station = svc.parse_gsd(GSD)
ok("pressure comes back in millibars, not tenths",
   prof["p"][0] == 972.0, str(prof["p"][:2]))
ok("temperature in degrees, not tenths",
   prof["T"][0] == 24.8, str(prof["T"][:2]))
ok("and the dew point too, which is below it as it must be",
   prof["Td"][0] == 19.5 and prof["Td"][0] < prof["T"][0], str(prof["Td"][:2]))
ok("height stays in metres", prof["z"][0] == 357, str(prof["z"][:2]))
ok("every data level is read, header lines are not",
   len(prof["p"]) == 7, str(len(prof["p"])))
ok("and the station line is picked out of the headers",
   "35.40" in station, station)

# Wind arrives as a direction and a speed and is drawn as a vector. The signs
# are the meteorological convention: a wind FROM the south blows TOWARDS the
# north, so a 170 degree wind has a POSITIVE v. Getting this backwards
# mirrors every hodograph in the app.
ok("a southerly wind blows north", prof["v"][0] > 0, str(prof["v"][0]))
ok("and barely east or west", abs(prof["u"][0]) < 3, str(prof["u"][0]))
ok("the speed survives the conversion",
   abs((prof["u"][0] ** 2 + prof["v"][0] ** 2) ** 0.5 - 15) < 0.01,
   str((prof["u"][0] ** 2 + prof["v"][0] ** 2) ** 0.5))
west = svc.parse_gsd("      9   9720    357    248    195    270     20")[0]
ok("and a westerly blows east, so u is positive",
   west["u"][0] > 19, str(west["u"][0]))
ok("with nothing north or south in it",
   abs(west["v"][0]) < 0.01, str(west["v"][0]))

# 99999 is how the file says "nothing here". Read as a number it is a
# pressure of ten thousand millibars.
ok("a missing wind is missing, not 99999",
   prof["u"][5] is None and prof["v"][5] is None, str(prof["u"][5]))
ok("and a level with no temperature at all is dropped rather than carried",
   all(t is not None for t in prof["T"]))
gap = svc.parse_gsd("      4   8500   1450  99999    120    200     35")[0]
ok("because a hole part way up makes the CAPE wrong, not the chart",
   len(gap["p"]) == 0, str(gap["p"]))

ok("a line that is not a sounding at all is ignored",
   svc.parse_gsd("this is not a sounding")[0]["p"] == [])
ok("and so is an empty answer", svc.parse_gsd("")[0]["p"] == [])
ok("or no answer", svc.parse_gsd(None)[0]["p"] == [])

print("\n2b. the address is built from real parameters")
url = svc._sounding_url("Op40", 35.4, -97.6)
for bit in ("data_source=Op40", "airport=35.4000%2C-97.6000", "GSD"):
    ok(f"the query carries {bit.split('=')[0]}", bit in url, url[:140])
ok("and every source names a real NOAA dataset",
   all(v["src"] in ("Op40", "Bak40", "RAOB", "NAM", "GFS")
       for v in svc.SOURCES.values()),
   str({k: v["src"] for k, v in svc.SOURCES.items()}))
# The newest analysis hour is often not published yet, which is the commonest
# way to get an empty answer that looks like a broken address.
ok("and the analysis has a previous cycle to fall back on",
   svc.SOURCES["rap"]["fallback"] == "Bak40")

print("\n2c. Open-Meteo answers when NOAA will not")
# rucsoundings.noaa.gov still resolves and no longer answers: DNS returns an
# address, port 443 refuses. The rest of NOAA is fine from the same machine,
# so that is one dead service rather than a network. Open-Meteo serves the
# same thing as pressure level fields and the app already talks to it for the
# wind and temperature layers, so it is a host known to be reachable.
import urllib.request as _ur

def _served(payload):
    """Stand in for the network, so this tests the parsing not the weather."""
    class _R:
        def read(self, *a): return json.dumps(payload).encode()
        def __enter__(self): return self
        def __exit__(self, *a): return False
    return lambda req, timeout=None: _R()

LEVELS = svc.OM_LEVELS
hourly = {"time": ["2026-08-21T17:00", "2026-08-21T18:00", "2026-08-21T19:00"],
          "temperature_2m": [30, 31, 32], "dew_point_2m": [21, 21, 21],
          "surface_pressure": [975, 975, 975],
          "wind_speed_10m": [12, 12, 12], "wind_direction_10m": [180, 180, 180]}
for n, lev in enumerate(LEVELS):
    hourly[f"temperature_{lev}hPa"] = [25 - n * 3] * 3
    hourly[f"relative_humidity_{lev}hPa"] = [70] * 3
    hourly[f"wind_speed_{lev}hPa"] = [20 + n * 3] * 3
    hourly[f"wind_direction_{lev}hPa"] = [200 + n] * 3
    hourly[f"geopotential_height_{lev}hPa"] = [300 + n * 800] * 3

_real_open = _ur.urlopen
_ur.urlopen = _served({"hourly": hourly})
try:
    om = svc.fetch_open_meteo("rap", 35.4, -97.6, "2026082118")
finally:
    _ur.urlopen = _real_open

ok("it builds a profile", om["levels"] >= 10, str(om["levels"]))
ok("more levels than the Pi's twelve images carry", om["levels"] > 12,
   str(om["levels"]))
# The surface is where the ground is, not the 1000 mb level. On high terrain
# those are hundreds of metres apart and the 1000 mb field is extrapolated
# into rock.
ok("the surface is the ground, not the thousand millibar level",
   om["profile"]["p"][0] == 975.0, str(om["profile"]["p"][:3]))
ok("and levels below the ground are left out rather than drawn underground",
   1000 not in om["profile"]["p"], str(om["profile"]["p"][:3]))
# Strictly falling: two entries at one pressure make a layer of zero depth,
# and every layer average in the panel divides by that depth.
ok("pressure falls all the way up, with no level repeated",
   all(b < a for a, b in zip(om["profile"]["p"], om["profile"]["p"][1:])),
   str(om["profile"]["p"][:6]))
ok("real geopotential heights come with it, so the depths are measured",
   om["profile"]["z"][1] is not None, str(om["profile"]["z"][:3]))
# Open-Meteo publishes humidity at pressure levels and not dew point, and a
# sounding is read as the gap between the two lines.
ok("humidity becomes a dew point, below the temperature as it must be",
   all(td <= t + 0.01 for t, td in zip(om["profile"]["T"], om["profile"]["Td"])),
   str(list(zip(om["profile"]["T"][:3], om["profile"]["Td"][:3]))))
ok("a southerly surface wind blows north", om["profile"]["v"][0] > 0,
   str(om["profile"]["v"][0]))
ok("the hour asked for is the hour returned",
   om["valid"].startswith("2026-08-21T18"), om["valid"])
ok("and it says which model answered", "open-meteo" in om["upstream"],
   om["upstream"])

# A balloon is not a model. Asking Open-Meteo for one and getting a model
# back would be quietly answering a different question.
try:
    svc.fetch_open_meteo("obs", 35.4, -97.6)
    ok("an observed sounding is refused rather than faked", False)
except RuntimeError as e:
    ok("an observed sounding is refused rather than faked",
       "balloon" in str(e), str(e))

# Both sources failing must report BOTH reasons, not whichever was last.
_ur.urlopen = _served({"hourly": {}})
try:
    svc.fetch_profile("rap", 35.4, -97.6)
    ok("both failing says so", False)
except RuntimeError as e:
    msg = str(e)
    ok("when both fail, both reasons are given",
       "Open-Meteo" in msg and "NOAA" in msg, msg[:200])
finally:
    _ur.urlopen = _real_open

print("\n3. the cache is keyed by place, not by pixel")
a = svc._cache_key("rap", 35.4012, -97.6033, None)
b = svc._cache_key("rap", 35.4038, -97.5975, None)
c = svc._cache_key("rap", 36.9, -97.6, None)
ok("two clicks a hundred metres apart are one sounding", a == b, f"{a} vs {b}")
ok("two places that are really different are not", a != c, f"{a} vs {c}")
ok("a different source is a different key",
   svc._cache_key("hrrr", 35.4, -97.6, None) != a)
ok("and so is a different hour",
   svc._cache_key("rap", 35.4, -97.6, "2026082012") != a)
ok("the key is safe to use as a filename",
   all(ch.isalnum() or ch == "_" for ch in a), a)


# ── 4. failures are sentences ───────────────────────────────────────────────
print("\n4. every failure says what to do about it")
raises = [n for n in ast.walk(svc_tree) if isinstance(n, ast.Raise)]
# Fewer than before on purpose: the whole surface of "the library is not\n# installed" went away with the library.\nok("there are failures to check", len(raises) >= 2, str(len(raises)))
msgs = []
for r in raises:
    seg = ast.get_source_segment(svc_src, r) or ""
    msgs.append(seg)
ok("all of them are RuntimeError, so the caller can tell them from a bug",
   all("RuntimeError" in m for m in msgs), str(msgs)[:200])
ok("the empty-answer one names the point that was asked about",
   any("lat" in m or "{lat}" in m for m in msgs), str(msgs)[:160])
# Two completely different failures that were reported with one sentence. A
# server that answered and had nothing is a question about timing; a host
# that never answered is a question about the network or the address, and
# telling somebody to wait an hour for that sends them the wrong way.
fn_src = ast.get_source_segment(svc_src, next(
    n for n in svc_tree.body if getattr(n, "name", "") == "fetch_noaa"))
ok("a server that answered and had nothing says analyses publish behind",
   "publish about an hour behind" in fn_src)
ok("a host that never answered says so instead",
   "Nothing answered at" in fn_src and "network" in fn_src)
ok("and the two are chosen apart by whether a reply arrived at all",
   "reached = True" in fn_src and "if reached else" in fn_src)
# URLError.reason IS the diagnosis. Thrown away it leaves the word
# "URLError" and nothing to act on.
ok("the real reason is carried rather than just the exception name",
   "e.reason" in fn_src, "reason discarded")
ok("nothing raises a bare Exception with no message",
   not any(m.strip() in ("raise", "raise Exception") for m in msgs))

# ── 5. SHARPpy returns nothing rather than exploding ────────────────────────
print("\n5. no SHARPpy is a smaller answer, not a failure")
fn = next(n for n in svc_tree.body
          if isinstance(n, ast.FunctionDef) and n.name == "sharppy_params")
body = ast.get_source_segment(svc_src, fn)
ok("the import is inside the function", "import numpy" in body)
ok("and a missing library returns None", "return None" in body)
# A profile with no parameters is still a sounding worth drawing, so this must
# not be allowed to take the fetch down with it.
ok("a profile with no heights is refused with a reason, not a traceback",
   "cannot work out layer depths" in body)
ok("the parcels asked for are the four a forecaster reads",
   all(p in body for p in ("sfcpcl", "mlpcl", "mupcl", "fcstpcl")))
ok("the composites include the ones nobody should reimplement by hand",
   all(p in body for p in ("stp_cin", "right_scp", "ship", "dcape")))
ok("SHARPpy really is what did the sum, and says so",
   '"engine"' in body and '"SHARPpy"' in body)
# Real: sharppy_params with no SHARPpy installed must give None and not throw.
ok("and calling it right now, with nothing installed, returns None",
   svc.sharppy_params({"profile": {"p": [1000], "z": [0], "T": [20],
                                   "Td": [15], "u": [0], "v": [0]}}) is None)


# ── 6. the door itself, on a real socket ────────────────────────────────────
print("\n6. the door answers, on a real socket")

# A stand-in service, swapped in before serve.py's handler imports it. The
# handler does `import sounding_service` inside the method, so sys.modules
# decides which one it gets - which is what makes this testable at all.
stub = types.ModuleType("sounding_service")
stub.SOURCES = dict(svc.SOURCES)
stub.calls = []
stub.cache = {}
stub.behaviour = "ok"
stub.hold = threading.Event()
stub.hold.set()


def _key(source, lat, lon, when):
    return f"{source}|{round(float(lat), 2)}|{round(float(lon), 2)}|{when}"


def _read(key):
    return stub.cache.get(key)


def _sounding(source, lat, lon, when=None, use_cache=True):
    stub.calls.append((source, lat, lon, when))
    stub.hold.wait(10)
    if stub.behaviour == "nolib":
        raise RuntimeError("SounderPy is not installed on this Pi. Run "
                           "install.sh again to add it.")
    if stub.behaviour == "boom":
        raise ValueError("something nobody predicted")
    return {"source": source, "lat": lat, "lon": lon, "levels": 3,
            "valid": "2026-08-20T12:00Z", "cached": False,
            "profile": {"p": [1000, 850, 500], "z": [10, 1500, 5600],
                        "T": [28, 16, -12], "Td": [22, 12, -25],
                        "u": [5, 20, 45], "v": [2, -3, 8]},
            "params": {"engine": "SHARPpy", "sb": {"cape": 2400}}}


stub._cache_key = _key
stub._cache_read = _read
stub.sounding = _sounding
sys.modules["sounding_service"] = stub

sys.argv = ["serve.py"]
import importlib.util                     # noqa: E402
spec = importlib.util.spec_from_file_location("gwcfc_serve", SERVE)
serve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(serve)

from functools import partial             # noqa: E402
from http.server import ThreadingHTTPServer  # noqa: E402

docroot = os.path.join(ROOT, "tools")
httpd = ThreadingHTTPServer(("127.0.0.1", 0),
                            partial(serve.CORSHandler, directory=docroot))
port = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{port}"


def get(path, timeout=15):
    req = urllib.request.Request(BASE + path)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode("utf-8", "replace")


code, hdr, body = get("/sounding?lat=35.4&lon=-97.6")
ok("a good request is answered", code == 200, f"{code} {body[:120]}")
try:
    got = json.loads(body)
except ValueError:
    got = {}
ok("with JSON, not an HTML error page", "profile" in got, body[:120])
ok("carrying the profile", len(got.get("profile", {}).get("p", [])) == 3)
ok("and SHARPpy's parameters with it",
   (got.get("params") or {}).get("engine") == "SHARPpy", str(got.get("params")))
# The page is on github.io and the Pi is on a tunnel: without this header the
# browser refuses to let the page read the answer at all.
ok("the CORS header is on it, or the page cannot read a word of it",
   hdr.get("Access-Control-Allow-Origin") == "*", str(hdr))
ok("and it is cacheable briefly, because an analysis is hourly",
   "max-age" in (hdr.get("Cache-Control") or ""), str(hdr.get("Cache-Control")))
ok("the default source is the analysis, since 'what is happening here' is "
   "the usual question",
   stub.calls and stub.calls[-1][0] == "rap", str(stub.calls[-1:]))

print("\n7. and refuses what it should refuse")
for path, why in [
    ("/sounding", "no coordinates at all"),
    ("/sounding?lat=35.4", "half a coordinate"),
    ("/sounding?lat=abc&lon=-97.6", "a coordinate that is not a number"),
    ("/sounding?lat=935&lon=-97.6", "a latitude off the planet"),
    ("/sounding?lat=35&lon=-400", "a longitude off the planet"),
]:
    code, _, body = get(path)
    ok(f"{why} is a 400 with a reason", code == 400 and "error" in body,
       f"{code} {body[:80]}")

code, _, body = get("/sounding?lat=35&lon=-97&source=wishful")
ok("an unknown source is refused and the real ones are listed",
   code == 400 and "rap" in body, f"{code} {body[:120]}")
code, _, body = get("/sounding?lat=35&lon=-97&when=tuesday")
ok("a malformed hour is refused before anything is fetched",
   code == 400 and "YYYYMMDDHH" in body, f"{code} {body[:120]}")

before = len(stub.calls)
get("/sounding?lat=35&lon=-97&when=2026081900")
ok("a well-formed hour is passed through to the service",
   stub.calls[-1][3] == "2026081900", str(stub.calls[-1:]))
ok("and it did reach the service, rather than being refused quietly",
   len(stub.calls) == before + 1)

print("\n8. a cached answer skips the queue entirely")
stub.cache[_key("rap", 35.4, -97.6, None)] = {"source": "rap", "cached": False,
                                              "profile": {"p": [1000]}}
before = len(stub.calls)
t0 = time.monotonic()
code, _, body = get("/sounding?lat=35.4&lon=-97.6")
lap = time.monotonic() - t0
ok("the cached answer comes back", code == 200 and '"p"' in body, body[:80])
ok("and the service was never asked", len(stub.calls) == before,
   f"{len(stub.calls)} vs {before}")
ok("it is marked as cached, so the panel can say so",
   json.loads(body).get("cached") is True, body[:120])
ok("and it is fast, because that is the whole point",
   lap < 1.0, f"{lap:.2f}s")
stub.cache.clear()

print("\n9. the queue is two deep, and says so rather than hanging")
# Real threads against the real socket. The Pi builds two profiles at a time
# because a third only makes all three slow, and the third caller has to be
# told that in words rather than left waiting for a browser timeout.
serve.SOUNDING_QUEUE_WAIT_S = 0.5
stub.hold.clear()
results = []


def hit(n):
    code, _, body = get(f"/sounding?lat=3{n}&lon=-97", timeout=20)
    results.append((code, body))


threads = [threading.Thread(target=hit, args=(i,)) for i in range(3)]
for t in threads:
    t.start()
time.sleep(1.5)                 # long enough for the third to give up waiting
stub.hold.set()
for t in threads:
    t.join(20)
codes = [c for c, _ in results]
turned_away = [b for c, b in results if c == 503]
ok("three at once, and one of them is turned away",
   codes.count(503) == 1, str(codes))
ok("the other two are served", codes.count(200) == 2, str(codes))
ok("the refusal says to try again rather than blaming the user",
   turned_away and "try again" in turned_away[0].lower(),
   str(turned_away)[:140])
ok("and it is flagged as worth retrying, not as a dead end",
   turned_away and json.loads(turned_away[0]).get("retry") is True,
   str(turned_away)[:140])
serve.SOUNDING_QUEUE_WAIT_S = 25.0

print("\n10. the queue reopens afterwards, rather than staying shut")
# The gate is released in a finally, so a failed fetch must not leak a slot.
# Three failures in a row followed by a success is what proves it: if the
# semaphore leaked, the fourth call would be the one that hangs.
stub.behaviour = "nolib"
for _ in range(3):
    get("/sounding?lat=35&lon=-97")
stub.behaviour = "ok"
code, _, body = get("/sounding?lat=35&lon=-97")
ok("after three failures the door still opens", code == 200, f"{code} {body[:80]}")

print("\n11. the failures a person will actually hit are readable")
stub.behaviour = "nolib"
code, _, body = get("/sounding?lat=35&lon=-97")
ok("a Pi without SounderPy answers 502 and names install.sh",
   code == 502 and "install.sh" in body, f"{code} {body[:140]}")
stub.behaviour = "boom"
code, _, body = get("/sounding?lat=35&lon=-97")
ok("an unexpected error is still JSON, not a stack trace",
   code == 502 and "error" in body and "Traceback" not in body,
   f"{code} {body[:140]}")
ok("and it names the kind of error without pasting the internals",
   "ValueError" in body, body[:140])
stub.behaviour = "ok"

print("\n12. the door does not shadow the files the map needs")
code, _, body = get("/test-sounding-service.py")
ok("an ordinary file is still served", code == 200 and "the Pi's /sounding door" in body,
   f"{code} {body[:60]}")
code, _, _ = get("/no-such-file.json")
ok("and a missing one is still a plain 404", code == 404, str(code))

httpd.shutdown()

print("\n13. serve.py wires it up the way the rest of the Pi expects")
ok("the door is a GET, beside the ambient relay",
   '"/sounding"' in serve_src and "_relay_ambient" in serve_src)
ok("the service is imported inside the handler, so a missing file is a 501",
   "501" in serve_src and "import sounding_service" in serve_src)
ok("and the directory beside serve.py is put on the path explicitly",
   "sys.path.insert" in serve_src)
ok("the worker count can be changed without editing code",
   "GWCFC_SND_WORKERS" in serve_src)
ok("nothing about this door writes anything",
   "do_PUT" in serve_src and "send_error(405)" in serve_src)

print("\n14. install.sh does not try to install what will not build")
ins = open(os.path.join(PI, "install.sh"), encoding="utf-8").read()
# Both were tried and both failed on a real Pi. SHARPpy pins a NumPy old
# enough to need distutils.msvccompiler, which Python removed, so it cannot
# build on 3.13 at all. SounderPy pulls in arm-pyart and cartopy, which are
# long C and C++ source builds on ARM. Trying anyway costs ten minutes of
# compiling, several hundred megabytes of build cache on a machine whose disk
# has already run out once, and ends in the same two warnings.
ok("SounderPy is not attempted", "install --quiet sounderpy" not in ins)
ok("nor is SHARPpy", "install --quiet sharppy" not in ins)
ok("but the reason is written down rather than just deleted",
   "distutils.msvccompiler" in ins and "arm-pyart" in ins)
ok("and it says where the profiles come from instead",
   "rucsoundings" in ins)
ok("the module check no longer expects them",
   '"sounderpy", "sharppy"' not in ins)
# The optional path is still there for anyone who wants it.
ok("SHARPpy is still used if somebody installs it by hand",
   "installing it by hand" in ins and "sharppy" in svc_src)

print("\n15. new code on disk means new code answering")
# The bug this section exists for: gwcfc-serve was started with
# "enable --now", and on a service that is ALREADY RUNNING that does nothing
# at all. serve.py kept running whatever file it was started with for as long
# as the Pi stayed up. Pulling new code and running the installer looked like
# a successful update and changed nothing, so the /sounding door was in the
# file on disk and not in the process answering requests. It looks exactly
# like a broken feature and is not one.
sup = open(os.path.join(PI, "selfupdate.sh"), encoding="utf-8").read()
ok("the installer restarts serve rather than only enabling it",
   "systemctl --user restart gwcfc-serve.service" in ins)
ok("and enables it too, so it survives a reboot",
   "systemctl --user enable  gwcfc-serve.service" in ins)
ok("the reason is written down, so it is not undone by someone tidying",
   "ALREADY RUNNING" in ins)
# The second half: serve.py imports sounding_service, so a change to the
# service is a change to the running server even though serve.py did not move.
ok("the self updater restarts serve when serve.py changes",
   "serve" in sup and "restart gwcfc-serve" in sup)
ok("and when the sounding service it imports changes",
   "sounding_service" in sup and re.search(
       r"grep -qE '\^pi/\(serve\|sounding_service\)", sup) is not None,
   "not watched")

print()
if failed:
    print(f"{failed} FAILED, {passed} passed")
    sys.exit(1)
print(f"all {passed} passed")
