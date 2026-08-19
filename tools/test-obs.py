#!/usr/bin/env python3
"""
The Pi's surface-observations pipeline, decoded from canned NOAA data.

    python3 tools/test-obs.py

No network: a fake HTTP session hands obs_pipeline a gzipped CSV in the exact
shape of aviationweather.gov's bulk cache, then a JSON payload in the shape of
its API. We check that:

  - the compact latest.json comes out in the column order the page decodes
  - temperature, wind, gust and sky survive the trip and land in the right slot
  - pressure is read by range: inches of mercury become millibars, millibars
    are left alone
  - relative humidity is computed from temperature and dew point
  - a station too old, or with no temperature/wind/pressure at all, is dropped
  - when the bulk file cannot be read, the JSON API is used instead

This is what makes "all the observation data is decoded on the Pi" a checked
fact: the page only ever sees this file's shape.
"""

import gzip
import json
import os
import sys
import tempfile
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "pi"))

import obs_pipeline as op  # noqa: E402

passed = failed = 0


def ok(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name}  <{extra}>")


NOW = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
OLD = "2000-01-01T00:00:00Z"

# A bulk-cache CSV: banner lines, a count, the header, then rows. Two sky_cover
# columns, exactly like the real file.
CSV_BODY = (
    "No errors\n"
    "No warnings\n"
    "12 ms\n"
    "data source=metars\n"
    "3 results\n"
    "raw_text,station_id,observation_time,latitude,longitude,temp_c,dewpoint_c,"
    "wind_dir_degrees,wind_speed_kt,wind_gust_kt,visibility_statute_mi,"
    "altim_in_hg,sea_level_pressure_mb,sky_cover,cloud_base_ft_agl,"
    "sky_cover,cloud_base_ft_agl\n"
    # Good station: inches of mercury altimeter, two cloud layers (BKN wins).
    f"KOKC ...,KOKC,{NOW},35.39,-97.6,31.0,21.0,180,12,20,10.0,"
    "29.92,,SCT,3000,BKN,8000\n"
    # Millibar pressure this time, no gust, no dew point.
    f"KJFK ...,KJFK,{NOW},40.64,-73.78,18.0,,90,8,,10.0,,1015.0,OVC,1200,,\n"
    # Too old: must be dropped.
    f"KOLD ...,KOLD,{OLD},34.0,-98.0,25.0,10.0,200,5,,10.0,29.9,,CLR,,,\n"
)

JSON_BODY = [
    {"icaoId": "KAUS", "name": "Austin Bergstrom", "lat": 30.19, "lon": -97.68,
     "temp": 27.0, "dewp": 19.0, "wdir": 160, "wspd": 10, "wgst": 15,
     "slp": 1013.0, "altim": 1013.2, "visib": "10+", "obsTime": NOW,
     "clouds": [{"cover": "FEW", "base": 4000}, {"cover": "BKN", "base": 9000}]},
]


class FakeResp:
    def __init__(self, status, content=b"", payload=None):
        self.status_code = status
        self.content = content
        self._payload = payload

    def json(self):
        return self._payload


class FakeHTTP:
    """Answers the CSV url with gz bytes and the JSON url with a list."""
    def __init__(self, csv_bytes=None, json_payload=None):
        self.csv_bytes = csv_bytes
        self.json_payload = json_payload

    def get(self, url, timeout=0):
        if url == op.CSV_URL:
            if self.csv_bytes is None:
                return FakeResp(404)
            return FakeResp(200, content=self.csv_bytes)
        if url.startswith(op.JSON_URL.split("?")[0]):
            if self.json_payload is None:
                return FakeResp(404)
            return FakeResp(200, payload=self.json_payload)
        return FakeResp(404)


def run_build(home, http):
    real_http = op.HTTP
    op.HTTP = http
    old_home = os.environ.get("HOME")
    os.environ["HOME"] = home
    op.OUT_DIR = os.path.join(home, "wxdata", "obs")
    try:
        rc = op.build()
    finally:
        op.HTTP = real_http
        if old_home is not None:
            os.environ["HOME"] = old_home
    path = os.path.join(op.OUT_DIR, "latest.json")
    doc = json.load(open(path)) if os.path.exists(path) else None
    return rc, doc


def by_id(doc, sid):
    ci = {c: i for i, c in enumerate(doc["cols"])}
    for row in doc["obs"]:
        if row[ci["id"]] == sid:
            return {c: row[ci[c]] for c in doc["cols"]}
    return None


def main():
    print("\n1. the bulk CSV, decoded to the page's compact file")
    home = tempfile.mkdtemp(prefix="obs-csv-")
    gz = gzip.compress(CSV_BODY.encode())
    rc, doc = run_build(home, FakeHTTP(csv_bytes=gz))
    ok("build succeeds and writes latest.json", rc == 0 and doc is not None, str(rc))
    ok("columns are exactly the page's contract", doc and doc["cols"] == op.COLS,
       str(doc and doc["cols"]))
    ok("the two current stations are kept, the old one dropped",
       doc and doc["count"] == 2, str(doc and doc["count"]))

    k = by_id(doc, "KOKC") or {}
    ok("KOKC temperature and wind land in the right slots",
       k.get("tC") == 31.0 and k.get("wkt") == 12 and k.get("gkt") == 20, str(k))
    ok("inches of mercury altimeter became millibars",
       k.get("pmb") is not None and 1010 < k["pmb"] < 1015, str(k.get("pmb")))
    ok("relative humidity is computed from temp and dew point",
       k.get("rh") is not None and 50 <= k["rh"] <= 60, str(k.get("rh")))
    ok("the densest sky layer wins (BKN over SCT)", k.get("sky") == "BKN",
       str(k.get("sky")))

    j = by_id(doc, "KJFK") or {}
    ok("a millibar pressure is passed through untouched", j.get("pmb") == 1015.0,
       str(j.get("pmb")))
    ok("a missing gust and dew point come out null",
       j.get("gkt") is None and j.get("dC") is None, str(j))

    print("\n2. the JSON API, used when the bulk file is unreachable")
    home2 = tempfile.mkdtemp(prefix="obs-json-")
    rc2, doc2 = run_build(home2, FakeHTTP(csv_bytes=None, json_payload=JSON_BODY))
    ok("build falls back and still writes a file", rc2 == 0 and doc2 is not None, str(rc2))
    a = by_id(doc2, "KAUS") or {}
    ok("the JSON station is decoded with its name and gust",
       a.get("name") == "Austin Bergstrom" and a.get("gkt") == 15, str(a))
    ok("visibility \"10+\" parses to a number", a.get("vis") == 10.0, str(a.get("vis")))
    ok("the densest JSON cloud layer wins (BKN)", a.get("sky") == "BKN", str(a.get("sky")))

    print("\n3. nothing to serve is a refusal, not an empty file")
    home3 = tempfile.mkdtemp(prefix="obs-none-")
    rc3, doc3 = run_build(home3, FakeHTTP(csv_bytes=None, json_payload=None))
    ok("with no source reachable, build reports failure and writes nothing",
       rc3 == 1 and doc3 is None, str(rc3))

    print()
    print(f"{failed} FAILED, {passed} passed" if failed else f"all {passed} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
