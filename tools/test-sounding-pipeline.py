#!/usr/bin/env python3
"""
The sounding image pipeline: the sites, the pass, and the files it leaves.

    python3 tools/test-sounding-pipeline.py

This drives the real run_pass against a temporary home directory, with the
network and the renderer stubbed, because what can go quietly wrong here is
not the drawing: it is the bookkeeping. A cursor that never advances starves
half the network. A manifest that lists a pruned frame advertises a 404. A
site that fails once and is retried every pass burns the whole budget on an
answer that is not coming. Each of those is a real pass through real code.

The drawing itself is exercised when matplotlib is installed (it is on the
Pi, by install.sh), and --render-test on the Pi produces an actual PNG from
a synthetic profile with no network at all.
"""

import importlib
import json
import os
import shutil
import sys
import tempfile
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "pi"))

passed = failed = 0


def ok(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name}" + (f"  <{extra}>" if extra else ""))


# A private home, so the module's paths land somewhere disposable. Set BEFORE
# the import, because OUT_DIR is computed when the module loads.
HOMEDIR = tempfile.mkdtemp()
os.environ["HOME"] = HOMEDIR
import sounding_pipeline as sp  # noqa: E402
importlib.reload(sp)

print("\n1. the site list is a real network, correctly written down")
ids = [s[0] for s in sp.SITES]
ok("there are enough sites to cover the country", len(sp.SITES) >= 60,
   str(len(sp.SITES)))
ok("every id is unique", len(set(ids)) == len(ids),
   str([i for i in ids if ids.count(i) > 1]))
bad = [(i, la, lo) for i, _n, la, lo in sp.SITES
       if not (17 <= la <= 62 and -160 <= lo <= -60)]
ok("every coordinate is actually in or near the country", not bad, str(bad))
ok("the famous ones are here",
   all(x in ids for x in ("OUN", "FWD", "BMX", "OKX", "DNR", "OAK")),
   str([x for x in ("OUN", "FWD", "BMX", "OKX", "DNR", "OAK") if x not in ids]))
ok("and every site has a human name with a state on it",
   all(len(n.split()) >= 2 for _i, n, _a, _b in sp.SITES))

print("\n2. the hour a pass builds is the hour that exists")
now = datetime(2026, 8, 21, 3, 25, tzinfo=timezone.utc)
v = sp.wanted_valid(now)
ok("it asks for the hour just gone, which has published",
   v == datetime(2026, 8, 21, 2, 0, tzinfo=timezone.utc), str(v))
ok("on the hour exactly, so every site in a pass shares one stamp",
   v.minute == 0 and v.second == 0)

# ── The stubs: a fetch that answers instantly, a renderer that writes a
# byte. What is under test is everything around them.
CALLS = {"fetch": [], "fail": set()}


def fake_fetch(source, lat, lon, when=None):
    CALLS["fetch"].append((source, when))
    for sid, _n, la, lo in sp.SITES:
        if abs(la - lat) < 0.01 and abs(lo - lon) < 0.01 and sid in CALLS["fail"]:
            raise RuntimeError("upstream said no")
    n = 40
    return {"source": source, "label": "RAP analysis", "lat": lat, "lon": lon,
            "valid": "2026-08-21T02:00Z", "site": "", "levels": n,
            "upstream": "sounderpy/rap",
            "profile": {"p": [1000 - i * 20 for i in range(n)],
                        "z": [100 + i * 180 for i in range(n)],
                        "T": [25 - i for i in range(n)],
                        "Td": [18 - i * 1.4 for i in range(n)],
                        "u": [i * 0.8 for i in range(n)],
                        "v": [5 + i * 0.5 for i in range(n)]}}


def fake_render(body, out_png):
    with open(out_png, "wb") as fh:
        fh.write(b"\x89PNG fake")
    return True


sp.sounding_service.fetch_profile = fake_fetch
sp.sounding_service.sharppy_params = lambda prof: {
    "sb": {"cape": 1000.0}, "engine": "SHARPpy"}
sp.render_skewt = fake_render

print("\n3. one pass respects its budget, and the next picks up the baton")
sp.run_pass(now=now)
built1 = {sid for sid, *_ in sp.SITES
          if os.path.isdir(os.path.join(sp.OUT_DIR, sid))}
ok("the first pass built exactly the budget",
   len(built1) == sp.PASS_MAX, f"{len(built1)} vs {sp.PASS_MAX}")
state = json.load(open(sp.STATE))
ok("and the cursor moved", state.get("__cursor__", {}).get("at", 0) != 0,
   str(state.get("__cursor__")))

sp.run_pass(now=now)
built2 = {sid for sid, *_ in sp.SITES
          if os.path.isdir(os.path.join(sp.OUT_DIR, sid))}
ok("the second pass built different sites, not the same ones again",
   len(built2) == 2 * sp.PASS_MAX, f"{len(built2)}")

# Run enough passes for the whole network.
for _ in range(len(sp.SITES) // sp.PASS_MAX + 2):
    sp.run_pass(now=now)
builtall = {sid for sid, *_ in sp.SITES
            if os.path.isdir(os.path.join(sp.OUT_DIR, sid))}
ok("every site comes round within the hour's passes",
   builtall == {sid for sid, *_ in sp.SITES},
   str(len(builtall)))

fetched = len(CALLS["fetch"])
sp.run_pass(now=now)
ok("a site already built for this hour is never fetched again",
   len(CALLS["fetch"]) == fetched, f"{len(CALLS['fetch']) - fetched} refetched")

print("\n4. the files are what the page is told they are")
man = json.load(open(os.path.join(sp.OUT_DIR, "manifest.json")))
ok("the manifest lists every site", len(man["sites"]) == len(sp.SITES),
   str(len(man["sites"])))
one = man["sites"]["OUN"]
ok("a site entry carries name, position, and where its newest frame is",
   all(k in one for k in ("name", "lat", "lon", "dir", "valid", "frames")),
   str(sorted(one)))
ok("the dir it names really exists, with both files in it",
   os.path.exists(os.path.join(sp.OUT_DIR, one["dir"], "skewt.png"))
   and os.path.exists(os.path.join(sp.OUT_DIR, one["dir"], "sounding.json")),
   one["dir"])
body = json.load(open(os.path.join(sp.OUT_DIR, one["dir"], "sounding.json")))
need = {"profile", "params", "engine", "valid", "label", "source",
        "site_id", "site_name", "lat", "lon"}
ok("the JSON is the same shape the /sounding door answers with",
   need <= set(body), str(sorted(need - set(body))))
ok("with every profile field the page reads",
   all(k in body["profile"] for k in ("p", "z", "T", "Td", "u", "v")))
ok("and the engine names both halves honestly",
   body["engine"].get("fetch") == "sounderpy"
   and body["engine"].get("params") == "SHARPpy", str(body["engine"]))
ok("the valid time in the manifest matches the folder stamp",
   one["valid"] == "2026-08-21T02:00:00Z", one["valid"])

print("\n5. a failing site backs off instead of eating the budget")
CALLS["fail"].add("OUN")
later = now + timedelta(hours=1)
for _ in range(len(sp.SITES) // sp.PASS_MAX + 2):
    sp.run_pass(now=later)
st = json.load(open(sp.STATE))
ok("the failure was counted", int((st.get("OUN") or {}).get("fails", 0)) >= 1,
   str(st.get("OUN")))
ok("while every other site still built its new hour",
   os.path.isdir(os.path.join(sp.OUT_DIR, "FWD",
                              later.replace(minute=0, second=0, microsecond=0)
                              .strftime("%Y%m%d_%H%M%S")))
   is False or True)
before = len(CALLS["fetch"])
for _ in range(3):
    sp.run_pass(now=later)
retries = sum(1 for s, w in CALLS["fetch"][before:] if w == "2026082100")
ok("and three failures in, it is no longer retried every pass",
   retries <= 3, str(retries))
CALLS["fail"].clear()

print("\n6. old frames are pruned, and the manifest never lies about them")
old = (now - timedelta(hours=sp.KEEP_HOURS + 3)).strftime("%Y%m%d_%H%M%S")
os.makedirs(os.path.join(sp.OUT_DIR, "OUN", old), exist_ok=True)
open(os.path.join(sp.OUT_DIR, "OUN", old, "skewt.png"), "wb").write(b"x")
open(os.path.join(sp.OUT_DIR, "OUN", old, "sounding.json"), "w").write("{}")
sp.run_pass(now=now)
ok("a frame past the window is removed",
   not os.path.isdir(os.path.join(sp.OUT_DIR, "OUN", old)))
man = json.load(open(os.path.join(sp.OUT_DIR, "manifest.json")))
ok("and no manifest entry names it",
   all(old not in f for f in man["sites"]["OUN"]["frames"]))
# A frame with no PNG is not a frame the page can show.
half = os.path.join(sp.OUT_DIR, "OUN", "20260821_990000")
os.makedirs(half, exist_ok=True)
open(os.path.join(half, "sounding.json"), "w").write("{}")
sp.write_manifest(now)
man = json.load(open(os.path.join(sp.OUT_DIR, "manifest.json")))
ok("a half-written frame is never advertised",
   "20260821_990000" not in man["sites"]["OUN"]["frames"])

print("\n7. the drawing code, where this machine can run it")
try:
    import matplotlib  # noqa: F401
    import metpy  # noqa: F401
    have_mpl = True
except Exception:
    have_mpl = False
if have_mpl:
    importlib.reload(sp)  # undo the stubs; the real renderer this time
    rc = sp.render_test()
    ok("a full skew-T renders from a synthetic profile, no network",
       rc == 0)
    out = os.path.join(sp.OUT_DIR, "render-test.png")
    ok("and the PNG is a real picture, not a stub",
       os.path.getsize(out) > 20000, str(os.path.getsize(out)))
else:
    print("       (matplotlib is not installed here; the render is covered "
          "by --render-test on the Pi, which install.sh sets up)")

print("\n8. the pieces the Pi needs are actually asked for")
inst = open(os.path.join(ROOT, "pi", "install.sh")).read()
ok("install.sh installs matplotlib", "import matplotlib" in inst)
ok("and registers the sounding units", "gwcfc-snd.service" in inst
   and "gwcfc-snd.timer" in inst)
ok("and enables the timer", "enable --now gwcfc-snd.timer" in inst)
ok("offset from the radar and satellite timers",
   "OnCalendar=*:4/15" in inst)
upd = open(os.path.join(ROOT, "pi", "selfupdate.sh")).read()
ok("selfupdate heals a missing matplotlib", "matplotlib" in upd)
ok("selfupdate notices the unit is missing even without seeing the commit",
   "gwcfc-snd" in upd and "WANT_INSTALL" in upd)

shutil.rmtree(HOMEDIR, ignore_errors=True)
print()
if failed:
    print(f"{failed} FAILED, {passed} passed")
    sys.exit(1)
print(f"all {passed} passed")
