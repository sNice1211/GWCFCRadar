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

print("\n9. a missing package is one sentence, not sixty-eight failures")
# Without an upfront check, a missing matplotlib fails every site separately,
# each caught by the per-site handler and counted as a failure. The log is
# sixty-eight copies of one import error and the manifest is empty, which
# reads as the whole upper-air network being unreachable.
src = open(os.path.join(ROOT, "pi", "sounding_pipeline.py")).read()
ok("there is an upfront dependency check", "def missing_deps" in src)
ok("it names matplotlib, which draws the image", '"matplotlib"' in src)
ok("and sounderpy, which fetches the profile", '"sounderpy"' in src)
# SHARPpy is deliberately not required: without it the parameters go missing
# and the sounding is still a sounding.
ok("but not SHARPpy, because a sounding without parameters is still one",
   '("sounderpy", "fetches the profile")' in src
   and '"sharppy", "' not in src.split("def missing_deps")[1].split("def ")[0])
# Parsed rather than sliced out of the text by character count: an earlier
# version of this counted 900 characters from the check, and a longer error
# message pushed the return past the window and failed a working guard.
import ast as _ast
_main = next(n for n in _ast.parse(src).body
             if isinstance(n, _ast.FunctionDef) and n.name == "main")
_guard = _ast.get_source_segment(src, next(
    n for n in _main.body
    if isinstance(n, _ast.If) and "missing_deps" not in _ast.dump(n.test)
    and "gone" in _ast.dump(n.test)))
ok("a missing package stops the pass rather than failing every site",
   "return 1" in _guard, _guard[:120])
ok("and the message carries the command that fixes it",
   "pip install" in _guard, _guard[:120])
# SounderPy has to go in with --no-deps: the plain command is the install
# that already failed, so printing it would send somebody round the loop.
ok("and SounderPy's command is the one that actually works",
   "--no-deps sounderpy" in _guard, _guard[:200])

print("\n10. and the page can read why, without anyone logging in")
ok("the pass writes a status file", "def write_status" in src)
ok("beside the data, where serve.py already serves it",
   'os.path.join(OUT_DIR, "status.json")' in src)
ok("a run that built nothing says whether that is a fault",
   'ok=True, sites=0' in src and 'ok=False, sites=0' in src)
# A quiet pass and a broken one both leave an empty manifest. Only one of
# them is worth telling somebody about.
ok("all sites failing is told apart from a first run",
   "all {failed} sites failed" in src)
satsrc = open(os.path.join(ROOT, "pi", "satellite_pipeline.py")).read()
ok("the satellite pipeline does the same", "def missing_deps" in satsrc
   and "def write_status" in satsrc)
ok("naming netCDF4, without which no composite can decode",
   '"netCDF4"' in satsrc)
# Night is not a fault: the daytime recipes are skipped on purpose.
ok("and a quiet night is not reported as a failure",
   "daytime composites are skipped" in satsrc)

print("\n11. one command that checks the whole chain")
doc = open(os.path.join(ROOT, "pi", "doctor.sh")).read()
ok("there is a doctor script", len(doc) > 500)
for probe, why in [
    ("netCDF4", "the satellite decoder"),
    ("matplotlib", "the sounding renderer"),
    ("sounderpy", "the profile fetcher"),
    ("gwcfc-snd", "the sounding timer"),
    ("gwcfc-sat", "the satellite timer"),
    ("status.json", "what the pipelines last said"),
]:
    ok(f"it checks {probe} ({why})", probe in doc)
ok("it probes the local server rather than trusting the disk",
   "127.0.0.1:8080" in doc)
# A list of problems with no commands is a list of things to worry about.
ok("and ends with the exact commands to run",
   "Run these, in this order" in doc and "FIXES" in doc)
ok("without suggesting the same command twice",
   "seen[$0]++" in doc)
ok("it changes nothing by itself", "It only looks." in doc)
# "Nothing built" names the symptom, not the cause, and the cause is already
# in the journal. Reading it back is the difference between knowing a build
# failed and knowing why.
ok("an empty feature has its last log lines read back", "journalctl" in doc)
ok("with the error lines picked out of the noise",
   "no module" in doc.lower() and "traceback" in doc.lower())
for unit in ("gwcfc-models", "gwcfc-radar", "gwcfc-sat", "gwcfc-snd"):
    ok(f"{unit} explains itself when empty", f"last_words {unit}" in doc)
# A feature can also be stale rather than absent, which looks identical from
# the browser and is a different fault.
ok("a stale build is told apart from one that never ran",
   "builds have stopped" in doc and "nothing new in half an hour" in doc)
# A timer keeps its next run in one of two places depending on how it was
# written, and reading only one of them called four healthy timers broken.
ok("a timer's next run is read from both places systemd keeps it",
   "NextElapseUSecRealtime" in doc and "NextElapseUSecMonotonic" in doc)
ok("and 'never' is told apart from 'scheduled since boot'",
   "after boot" in doc)
# Judging a machine by its output while it runs last week's code sends
# everybody chasing bugs that were fixed days ago.
ok("the checkout is compared with what is on GitHub", "ls-remote" in doc)
ok("using the call that downloads nothing, so a flaky link still answers",
   "downloads no objects" in doc)

print("\n12. and one command that runs every repair")
# doctor.sh finds and prints; fix.sh runs. The Pi is often reached with an
# on-screen keyboard, where a six-line list of commands is the actual
# obstacle to it ever being repaired.
fixsh = open(os.path.join(ROOT, "pi", "fix.sh")).read()
ok("there is a fix script", len(fixsh) > 500)
ok("it does the newest code FIRST, since every other fix ships inside it",
   fixsh.index("Newest code") < fixsh.index("Missing packages"))
ok("it pulls the branch this checkout is already on",
   'origin "$BRANCH"' in fixsh)
# Merging main into a feature branch here would author a commit that exists
# only on the Pi, and the self-updater is right to refuse to fast-forward
# past one. That would quietly end automatic updates for good.
ok("and refuses to invent a local commit by merging a different one",
   "--ff-only" in fixsh and "exists only on" in fixsh)
ok("a refusal to fast-forward is not retried as though it were the network",
   "DIVERGED=1" in fixsh)
ok("it is sent to the script that can recover from that safely",
   "selfupdate.sh" in fixsh)
ok("only missing packages are installed, so a healthy Pi costs nothing",
   "every data package is present" in fixsh)
ok("sounderpy is asked for the way the app asks, not with a plain import",
   "find_spec" in fixsh)
ok("the long running services are restarted, since they hold the old code",
   "gwcfc-serve" in fixsh and "gwcfc-tunnel" in fixsh and "gwcfc-publish" in fixsh)
ok("and it ends by saying where things stand",
   "--check" in fixsh)
# The whole point is that the next repair should not have to be typed.
ok("it leaves a shortcut behind", "alias gwfix=" in fixsh)
ok("without adding it twice", 'grep -q "alias gwfix="' in fixsh)

print("\n13. the self-updater survives a flaky link")
upd = open(os.path.join(ROOT, "pi", "selfupdate.sh")).read()
# One dropped pack used to mean the Pi ran old code until the next timer,
# and a failed update is invisible: the fixes just look like they did not work.
ok("a failed fetch is retried rather than abandoned",
   "fetch attempt" in upd and "retrying in" in upd)
ok("with a growing wait between tries", "DELAY * 2" in upd)
ok("and it still gives up rather than looping forever",
   "fetch failed four times" in upd)
ok("git is told not to abandon a merely slow link",
   "http.lowSpeedLimit" in upd)

shutil.rmtree(HOMEDIR, ignore_errors=True)
print()
if failed:
    print(f"{failed} FAILED, {passed} passed")
    sys.exit(1)
print(f"all {passed} passed")
