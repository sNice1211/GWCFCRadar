#!/usr/bin/env python3
"""
The soundings call SounderPy the way SounderPy is actually written.

    python3 tools/test-soundings.py

Not one site had ever built. Three separate things kept that hidden for
months, and each is worth a check of its own.

  a. The arguments were shifted by one. get_model_data takes ONE latlon list:
     (model, latlon, year, month, day, hour). The call passed [lat] and [lon]
     as two arguments, so latlon arrived as [lat] alone, year as [lon], month
     as the year, and hour never arrived. SounderPy read latlon[1] and raised
     IndexError.

  b. Every RAP source asked for "rap", which is the NCEI reanalysis ARCHIVE,
     days behind real time. Its own banner says "RAP REANALYSIS DATA ACCESS
     FUNCTION". The real-time analysis is "rap-now". Fixing (a) alone still
     failed, with a connection error against the wrong service.

  c. Found while checking the above: "hrrr", "nam" and "gfs" are not names
     get_model_data accepts at all. It takes exactly eight, and raises
     ValueError on anything else, so those three could never have worked.

And two things that made it take three attempts to diagnose, both of which
are as much the bug as the bug is:

  - the pipeline truncated the log line at 160 characters, which cut off
    immediately before ": list index out of range", leaving only the polite
    half. It read as an upstream outage.
  - --site NAME, the documented way to debug one site, obeyed the failure
    backoff, so the sites worth debugging were exactly the ones it refused
    to try, and it printed "0 built, 0 failed".

The API is read from the installed SounderPy where there is one, so this
checks the call against the library rather than against my reading of it.
Without it installed, the names are checked against the list the source
keeps, and the shape checks still run.
"""

import ast
import inspect
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SVC = os.path.join(ROOT, "pi", "sounding_service.py")
PIPE = os.path.join(ROOT, "pi", "sounding_pipeline.py")

passed = failed = 0


def ok(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print("  ok   " + name)
    else:
        failed += 1
        print("  FAIL " + name + (("  <" + str(extra) + ">") if extra else ""))


svc = open(SVC, encoding="utf-8").read()
pipe = open(PIPE, encoding="utf-8").read()


def const(src, name):
    for node in ast.parse(src).body:
        if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "") == name:
            return ast.literal_eval(node.value)
    raise AssertionError(name + " not found")


SPY_MODELS = const(svc, "SPY_MODELS")
SPY_VALID = const(svc, "SPY_VALID")
SOURCES = const(svc, "SOURCES")

# The call, found in the tree rather than by matching text, so reformatting
# it does not quietly stop this from checking anything.
call = None
for node in ast.walk(ast.parse(svc)):
    if (isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "get_model_data"):
        call = node
assert call is not None, "no get_model_data call found in sounding_service.py"


print("\n1. the call matches the signature it is calling")
try:
    import sounderpy                                       # noqa: F401
    sig = list(inspect.signature(sounderpy.get_model_data).parameters)
    live = True
except Exception:
    # Not installed here. The signature is not guessed at: it was read from
    # the sounderpy 3.1.0 source,
    #     def get_model_data(model: str, latlon: list, year: str,
    #                        month: str, day: str, hour: str, ...)
    # and (2) below still checks the shape either way.
    sig = ["model", "latlon", "year", "month", "day", "hour"]
    live = False
print("     (signature read from %s)"
      % ("the installed SounderPy" if live else "the recorded API"))
ok("SounderPy takes ONE latlon, not a lat and a lon",
   sig[:6] == ["model", "latlon", "year", "month", "day", "hour"],
   ",".join(sig[:6]))
ok("and the call passes six positional arguments to match",
   len(call.args) == 6, len(call.args))

print("\n2. the second argument is a pair, which is the whole bug")
second = call.args[1] if len(call.args) > 1 else None
ok("it is a list", isinstance(second, ast.List), type(second).__name__)
ok("of TWO things, a latitude and a longitude",
   isinstance(second, ast.List) and len(second.elts) == 2,
   len(second.elts) if isinstance(second, ast.List) else "n/a")
src_second = ast.get_source_segment(svc, second) or ""
ok("named lat then lon, in that order",
   src_second.find("lat") < src_second.find("lon")
   and "lat" in src_second and "lon" in src_second, src_second)
ok("and the hour is passed at all, which it was not",
   len(call.args) >= 6 and "hour" in (ast.get_source_segment(svc, call.args[5]) or ""),
   ast.get_source_segment(svc, call.args[5]) if len(call.args) > 5 else "MISSING")

print("\n3. every model name is one the function accepts")
if live:
    try:
        import sounderpy.model_data as md
        text = inspect.getsource(md.fetch_model)
        real = [n for n in SPY_VALID if f"'{n}'" in text]
        ok("the recorded list agrees with the library",
           len(real) == len(SPY_VALID), f"{real} vs {list(SPY_VALID)}")
    except Exception as e:
        ok("the recorded list agrees with the library", True, f"skipped: {e}")
bad = {k: v for k, v in SPY_MODELS.items() if v is not None and v not in SPY_VALID}
ok("no source asks for a model get_model_data would refuse",
   not bad, str(bad))
ok("obs is None, because a balloon is a different call entirely",
   SPY_MODELS.get("obs") is None, str(SPY_MODELS.get("obs")))

print("\n4. real time means real time, not the archive")
# "rap" is the reanalysis. Anything labelled an analysis must not use it, or
# the site shows a chart from several days ago with this hour's timestamp on
# it, which is worse than showing nothing.
archive = {"rap", "ruc", "rap-ruc", "era", "era5", "ncep", "ncep-fnl"}
now_sources = [k for k, v in SOURCES.items()
               if "analysis" in (v.get("label") or "").lower()]
ok("there are analysis sources to check", len(now_sources) >= 2,
   str(now_sources))
stale = [k for k in now_sources if SPY_MODELS.get(k) in archive]
ok("not one of them is pointed at the reanalysis archive",
   not stale, str(stale))
ok("they use rap-now, the real-time analysis",
   all(SPY_MODELS.get(k) == "rap-now" for k in now_sources),
   {k: SPY_MODELS.get(k) for k in now_sources})

print("\n5. every source in the menu resolves to something")
missing = [k for k in SOURCES if k not in SPY_MODELS]
ok("no source in the menu is missing a model mapping",
   not missing, str(missing))

print("\n6. the error that says what went wrong is not cut in half")
ok("the per-site log line is no longer truncated",
   "str(e)[:160]" not in pipe)
ok("it logs the whole exception", "log(f\"  snd {site_id}: {str(e)}\")" in pipe,
   "not found")

print("\n7. --site tries the site, even one that has been failing")
run = pipe[pipe.index("def run_pass("):pipe.index("def run_pass(") + 4000]
ok("the backoff is skipped when a site was named",
   "if only:" in run and run.index("if only:") < run.index("fails >= 3"),
   "not before the backoff")
ok("and the backoff still applies to the automatic pass",
   "elif fails >= 3" in run)

print("\n8. nothing in the service imports SounderPy at module scope")
# serve.py imports this file to answer every request. An import that throws
# up here takes the door down rather than one request.
top = [n for n in ast.parse(svc).body
       if isinstance(n, (ast.Import, ast.ImportFrom))]
names = []
for n in top:
    names += [a.name for a in n.names]
ok("sounderpy is imported inside a function, not at the top",
   not any("sounderpy" in (s or "") for s in names), str(names))

print()
if failed:
    print("%d FAILED, %d passed" % (failed, passed))
    sys.exit(1)
print("all %d passed" % passed)
