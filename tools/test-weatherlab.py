#!/usr/bin/env python3
"""The Weather Lab cyclones fetch, tested against the verified layout.

    python3 tools/test-weatherlab.py

The Google models never worked because the pipeline asked the download
endpoint for the model names the Weather Lab WEBSITE shows (OPER, FNV3P0,
FNV3_LARGE_ENSEMBLE) and for the paired product, and the endpoint has never
known either. The working layout, live-verified by Triple-A Tropics: models
FNV3 and GENC, the ensemble/cyclogenesis CSV (every member's basin-wide
tracks), columns sample / track_id / lead_time_hours / lat / lon /
minimum_sea_level_pressure_hpa / maximum_sustained_wind_speed_knots.

Everything here runs on a fixture shaped from those verified columns. The
live half is the pipeline's own --check on the Pi, where the host is
reachable.
"""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

spec = importlib.util.spec_from_file_location(
    "cyc", os.path.join(ROOT, "pi", "cyclones_pipeline.py"))
cyc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cyc)

passed = failed = 0


def ok(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name}" + (f"  <{extra}>" if extra else ""))


print("\n1. the URL is the one the endpoint actually serves")
stamp = "2026_08_26T00_00"
url = cyc.track_url("FNV3", stamp)
ok("the model slug is the download API's, not the website's",
   "/FNV3/" in url and "OPER" not in url, url)
ok("the product is the cyclogenesis CSV, which holds every member's tracks",
   url.endswith("/FNV3/ensemble/cyclogenesis/csv/"
                f"FNV3_{stamp}_cyclogenesis.csv"), url)
ok("not the paired product, which holds only observed-matched storms",
   "paired" not in url)
ok("GenCast is the second model, on the identical pattern",
   cyc.track_url("GENC", stamp)
   == url.replace("FNV3", "GENC"))
ok("the fetch list is exactly those two",
   cyc.MODELS == ["FNV3", "GENC"], str(cyc.MODELS))

print("\n2. the verified columns parse")
CSV = "\n".join([
    "# Weather Lab terms preamble",
    "# more preamble",
    "sample,track_id,lead_time_hours,lat,lon,"
    "minimum_sea_level_pressure_hpa,maximum_sustained_wind_speed_knots",
    "0,0,0,21.9,-65.2,986.2,63.1",
    "0,0,6,22.4,-66.1,979.0,71.4",
    "0,1,0,14.0,-40.0,1004.0,32.0",
    "0,1,6,14.5,-41.0,1002.5,35.0",
    "3.0,0,0,21.8,-65.0,987.0,60.0",
    "3.0,0,6,22.2,-65.9,981.0,68.0",
    "3.0,0,7,23.0,-66.5,980.0,69.0",
    "17,4,0,15.0,200.5,1005.0,30.0",
    "17,4,6,15.4,201.5,1004.0,31.0",
]).encode()
tracks, hdr = cyc.parse_tracks(CSV)
ok("the licence preamble is skipped and the header found",
   "sample" in hdr, ",".join(hdr))
ok("one member's two simultaneous storms stay two lines",
   "unknown|0|0" in tracks and "unknown|0|1" in tracks,
   ",".join(sorted(tracks)))
ok("sample 3.0 and sample 3 are the same member",
   "unknown|3|0" in tracks and not any("3.0" in k for k in tracks))
ok("lead, wind and pressure ride along under their long names",
   tracks["unknown|0|0"][1]["lead"] == 6.0
   and tracks["unknown|0|0"][1]["wind"] == 71.4
   and tracks["unknown|0|0"][1]["mslp"] == 979.0)
ok("an off-grid 7-hour row is malformed, not a finer forecast",
   all(p["lead"] % 6 == 0 for p in tracks["unknown|3|0"]))
ok("east-of-180 longitudes come back round the right way",
   tracks["unknown|17|4"][0]["lon"] == -159.5,
   str(tracks["unknown|17|4"][0]))
ok("points are ordered along the line",
   [p["lead"] for p in tracks["unknown|0|0"]] == [0.0, 6.0])

print("\n3. the key shape the site splits")
for key in tracks:
    parts = key.split("|")
    ok(f"{key} is storm|member|track", len(parts) == 3)
ok("the member field is the middle part, as the site reads it",
   {k.split("|")[1] for k in tracks} == {"0", "3", "17"},
   str({k.split("|")[1] for k in tracks}))

print("\n4. what a single point is worth")
one = ("sample,track_id,lead_time_hours,lat,lon,"
       "minimum_sea_level_pressure_hpa,maximum_sustained_wind_speed_knots\n"
       "5,0,12,15.0,-60.0,1005.0,30.0\n").encode()
t1, _ = cyc.parse_tracks(one)
ok("a one-point storm draws as nothing and is dropped", t1 == {}, str(t1))

print("\n5. cycles walk the 6-hour grid")
import datetime as dt
now = dt.datetime(2026, 8, 26, 3, 30, tzinfo=dt.timezone.utc)
c0 = cyc.cycle_for(now)
c1 = cyc.cycle_for(now, back=1)
ok("the newest candidate sits on a synoptic hour behind the lag",
   c0.hour in (0, 6, 12, 18) and c0.minute == 0, str(c0))
ok("each step back is one six-hour cycle",
   (c0 - c1) == dt.timedelta(hours=6))
ok("the stamp spells it the way the URL wants",
   cyc.run_stamp(dt.datetime(2026, 8, 15, 12)) == "2026_08_15T12_00")

print("\n6. house rules and credit")
src = open(os.path.join(ROOT, "pi", "cyclones_pipeline.py")).read()
ok("no em dash", chr(0x2014) not in src)
ok("the verified-layout credit is at source", "Triple-A Tropics" in src)
ok("the old website names survive only as history, not as fetch targets",
   "FNV3_LARGE_ENSEMBLE" not in repr(cyc.MODELS))
ok("the timer covers four cycles a day",
   "02,05,08,11,14,17,20,23" in
   open(os.path.join(ROOT, "pi", "install.sh")).read())

print(f"\n{'all ' if not failed else ''}{passed} passed"
      + (f", {failed} FAILED" if failed else ""))
sys.exit(1 if failed else 0)
