#!/usr/bin/env python3
"""The server-side feed fetcher: JTWC RSS and the SPC mesoscale discussions.

    python3 tools/test-feeds-pipeline.py

These two feeds broke in the app over and over for one reason: the browser
cannot read them directly (no CORS) and every public relay in the failover
chain is someone else's free machine. feeds_pipeline.py moves the fetch to
the server. What this suite holds it to:

  - an answer that is not the feed (a block page, an error page) is refused,
    because serving it to the browser as if it were RSS breaks the layer in
    a way that looks like calm weather;
  - "no MCDs right now" - a valid, empty feature list - is accepted as a
    real answer, but only after every source with actual data has had its
    turn;
  - a run where everything fails leaves the previous file on disk untouched,
    so one bad upstream minute does not erase the last good answer.

Run against a stub HTTP session, not the Navy: what is under test is the
acceptance logic, not whether metoc.navy.mil is having a good day.
"""

import io
import json
import os
import sys
import tempfile
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "pi"))

# The pipeline imports requests at module load. The suite never lets a real
# request happen, so a machine without the package still runs the tests.
if "requests" not in sys.modules:
    stub = types.ModuleType("requests")
    class _Session:
        def __init__(self):
            self.headers = {}
        def get(self, *a, **k):
            raise RuntimeError("network use in a unit test")
    stub.Session = _Session
    sys.modules["requests"] = stub

import feeds_pipeline as fp

passed = failed = 0


def ok(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print("  ok   " + name)
    else:
        failed += 1
        print("  FAIL " + name + (f"  <{extra}>" if extra else ""))


class Resp:
    def __init__(self, text="", status=200, body=None):
        self.text = text
        self.status_code = status
        self._body = body
    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")
    def json(self):
        if self._body is None:
            return json.loads(self.text)
        return self._body


class FakeHTTP:
    """Answers by substring of the URL; anything unmatched is a dead host."""
    def __init__(self, routes):
        self.routes = routes
        self.asked = []
    def get(self, url, **kw):
        self.asked.append(url)
        for frag, resp in self.routes.items():
            if frag in url:
                if isinstance(resp, Exception):
                    raise resp
                return resp
        raise ConnectionError("unreachable")


RSS = ("<rss><channel><item><title>TROPICAL CYCLONE 30W</title>"
       "<description>12.3N 130.5E</description></item></channel></rss>")
RSS_EMPTY = "<rss><channel><title>quiet basin</title></channel></rss>"
BLOCK_PAGE = "<html><body>Access Denied by policy</body></html>"

print("\n1. jtwc: the feed is accepted, imposters are not")
fp.HTTP = FakeHTTP({
    "jtwc.rss?wp": Resp(RSS),
    "jtwc.rss?io": Resp(RSS_EMPTY),
    "jtwc.rss?sh": Resp(BLOCK_PAGE),
    "jtwc.rss?cp": ConnectionError("timed out"),
})
basins, errors = fp.fetch_jtwc()
ok("a basin with items is kept, as raw text", basins.get("wp") == RSS)
ok("a quiet-but-valid RSS document is also kept",
   basins.get("io") == RSS_EMPTY,
   repr(basins.get("io"))[:80])
ok("an HTML block page is refused, with the evidence quoted",
   "sh" not in basins and "Access Denied" in errors.get("sh", ""),
   errors.get("sh", ""))
ok("a dead host is an error, not a crash",
   "cp" not in basins and "timed out" in errors.get("cp", ""))

print("\n2. mcd: data wins, then a valid empty, then nothing")
real = {"type": "FeatureCollection",
        "features": [{"type": "Feature", "properties": {"product_id": "1"},
                      "geometry": None}]}
empty = {"type": "FeatureCollection", "features": []}

# The primary answers hollow while a mirror has the real MCD.
fp.HTTP = FakeHTTP({
    "mapservices.weather.noaa.gov": Resp(body=empty),
    "mesonet.agron.iastate.edu": Resp(body=real),
})
d, src, errs = fp.fetch_mcd()
ok("an empty primary does not end the search",
   d is real and "mesonet" in (src or ""), src)

# Everyone agrees the sky is quiet.
fp.HTTP = FakeHTTP({
    "mapservices.weather.noaa.gov": Resp(body=empty),
    "mesonet.agron.iastate.edu": ConnectionError("down"),
    "spc.noaa.gov": Resp(body=empty),
})
d, src, errs = fp.fetch_mcd()
ok("a well-formed empty set is a real answer",
   d is not None and d.get("features") == [], repr(d)[:60])

# Nobody answers with anything usable.
fp.HTTP = FakeHTTP({
    "mapservices.weather.noaa.gov": Resp("nonsense", 500),
    "mesonet.agron.iastate.edu": Resp("<html>err</html>"),
    "spc.noaa.gov": ConnectionError("down"),
})
d, src, errs = fp.fetch_mcd()
ok("total failure is None plus the reasons, one per source",
   d is None and len(errs) == 3, "; ".join(errs))

print("\n3. a failed run must not erase the last good file")
tmp = tempfile.mkdtemp(prefix="gwcfc-feeds-test-")
fp.OUT_DIR = tmp
fp.HTTP = FakeHTTP({
    "jtwc.rss?wp": Resp(RSS),
    "mesonet.agron.iastate.edu": Resp(body={
        "type": "FeatureCollection",
        "features": [{"type": "Feature", "properties": {}, "geometry": None}]}),
})
code = fp.main([])
jt = os.path.join(tmp, "jtwc.json")
mc = os.path.join(tmp, "mcd.json")
ok("a good run writes both files and exits 0",
   code == 0 and os.path.exists(jt) and os.path.exists(mc))
before_jt = io.open(jt).read()
before_mc = io.open(mc).read()

d = json.loads(before_jt)
ok("the jtwc file carries its own fetched-at stamp and the raw basins",
   "fetched" in d and d["basins"]["wp"] == RSS, sorted(d))

# Now the whole upstream goes dark.
fp.HTTP = FakeHTTP({})
code = fp.main([])
ok("the dark run still exits 0: upstream weather, not a broken unit",
   code == 0)
ok("and both previous files survive, byte for byte",
   io.open(jt).read() == before_jt and io.open(mc).read() == before_mc)

print("\n4. the systemd side is registered")
inst = io.open(os.path.join(ROOT, "pi", "install.sh"), encoding="utf-8").read()
ok("install.sh writes a gwcfc-feeds service", "gwcfc-feeds.service" in inst)
ok("and its timer", "gwcfc-feeds.timer" in inst)
ok("running feeds_pipeline.py", "feeds_pipeline.py" in inst)
src = io.open(os.path.join(ROOT, "pi", "feeds_pipeline.py"), encoding="utf-8").read()
ok("no em dash anywhere in the pipeline", "\u2014" not in src)
ok("writes are atomic: tmp file then replace",
   "os.replace" in src and ".tmp" in src)

print()
if failed:
    print(f"{failed} FAILED, {passed} passed")
    sys.exit(1)
print(f"all {passed} passed")
