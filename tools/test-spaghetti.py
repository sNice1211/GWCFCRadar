#!/usr/bin/env python3
"""The a-deck spaghetti pipeline, tested against the format's real traps.

    python3 tools/test-spaghetti.py

Every fixture row here is shaped from the REAL public decks, following the
calibration Triple-A Tropics published with its guidance package (verified
by them across all 23 live 2026 files, 521,842 rows): the traps this guards
against are the ones the live data actually contains, not the ones the
format document warns about. The five that matter most:

  * 0 is MISSING for VMAX and MSLP, never zero of anything
  * 0N/0W is a sentinel that parses perfectly and poisons everything
  * the primary key includes RAD, so radii rows are not duplicates,
    and counting them as track points triples every trace
  * CARQ carries negative TAUs that are history, not forecasts
  * the antimeridian is encoded 1800E and E longitudes are real

Everything runs on fixtures. The pipeline's own --check flag is the live
half, run on the Pi where the NHC host is reachable.
"""
import importlib.util
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

spec = importlib.util.spec_from_file_location(
    "spag", os.path.join(ROOT, "pi", "spaghetti_pipeline.py"))
spag = importlib.util.module_from_spec(spec)
spec.loader.exec_module(spag)

passed = failed = 0


def ok(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name}" + (f"  <{extra}>" if extra else ""))


def row(basin="AL", cy=9, dtg="2026082600", tech="AVNO", tau=0,
        lat="218N", lon="0651W", vmax="65", mslp="985", rad="34", extra=""):
    """One 18-field ATCF row, the width 86% of live rows actually use."""
    return (f"{basin}, {cy:02d}, {dtg},   , {tech}, {tau:4d}, {lat}, {lon}, "
            f"{vmax}, {mslp}, XX,  {rad}, NEQ,    0,    0,    0,    0,"
            + extra)


print("\n1. positions, with the hemisphere and the sentinel")
ok("tenths of a degree with hemisphere",
   spag.parse_latlon("218N", "0651W") == (21.8, -65.1))
ok("southern and eastern hemispheres are real",
   spag.parse_latlon("155S", "1511E") == (-15.5, 151.1))
ok("east longitude stays positive",
   spag.parse_latlon("120N", "1400E") == (12.0, 140.0))
ok("the antimeridian is encoded 1800E and survives",
   spag.parse_latlon("120N", "1800E") == (12.0, 180.0))
ok("0N/0W is the sentinel, not the Gulf of Guinea",
   spag.parse_latlon("0N", "0W") is None)
ok("so is 000N/0000W", spag.parse_latlon("000N", "0000W") is None)
ok("a real fix NEAR the origin is not eaten",
   spag.parse_latlon("001N", "0001W") == (0.1, -0.1))
ok("garbage is None, not an exception",
   all(spag.parse_latlon(a, b) is None for a, b in
       [("", "0651W"), ("218", "0651W"), ("218X", "0651W")]))

print("\n2. the three missing-value sentinels")
ok("0 is missing", spag.int_or_none("0") is None)
ok("-99 is a second, independent missing", spag.int_or_none("-99") is None)
ok("-999 is a third", spag.int_or_none("-999") is None)
ok("65 is sixty-five", spag.int_or_none("65") == 65)
ok("empty is missing", spag.int_or_none("  ") is None)

print("\n3. deck parsing and the primary key")
deck = "\n".join([
    row(tech="AVNO", tau=0, rad="34"),
    row(tech="AVNO", tau=0, rad="50"),      # same (dtg,tech,tau), NOT a dup
    row(tech="AVNO", tau=0, rad="64"),
    row(tech="AVNO", tau=12, lat="228N", lon="0672W", vmax="70", mslp="980"),
    row(tech="CARQ", tau=-12, lat="200N", lon="0630W"),   # history, not fcst
    row(tech="OFCL", tau=0, lat="219N", mslp="0"),        # OFCL MSLP mostly 0
    row(tech="IVCN", tau=0, lat="0N", lon="0W", vmax="68"),  # intensity-only
    "AL, 09, 2026082600",                                 # short row
    row(tech="TVCN", tau=12, lat="230N", lon="0670W", vmax="0", mslp="0"),
])
deck += "\n" + row(tech="HFSA", tau=0) + "\n" + row(tech="HFSA", tau=0)  # dup
rows, qc = spag.parse_deck(deck)
ok("CARQ is excluded", not any(r["tech"] == "CARQ" for r in rows))
ok("the short row is counted malformed, not crashed on",
   qc.get("malformed", 0) == 1, str(qc))
ok("the byte-identical adjacent duplicate is skipped",
   qc.get("exact_dup", 0) == 1)
ok("the radii rows all survive parsing, because RAD is part of the key",
   sum(1 for r in rows if r["tech"] == "AVNO" and r["tau"] == 0) == 3)
tr = spag.traces(rows)
ok("but only the primary row reaches the trace",
   len([p for p in tr["AVNO"] if p["tau"] == 0]) == 1)
ok("so AVNO's trace is two points, not four",
   len(tr["AVNO"]) == 2, str(tr["AVNO"]))
# Row order is not guaranteed by the format, so a 50 kt radii row arriving
# FIRST must not become the trace point: the rad guard, not luck, decides.
scrambled = "\n".join([
    row(tech="HMON", tau=0, rad="50", lat="999N", lon="0999W"),
    row(tech="HMON", tau=0, rad="34", lat="218N", lon="0651W"),
])
srows, _ = spag.parse_deck(scrambled)
strace = spag.traces(srows)
ok("a radii row arriving first still loses to the primary row",
   strace["HMON"][0]["lat"] == 21.8, str(strace["HMON"]))
ok("OFCL's zero MSLP arrives as None, not as vacuum",
   tr["OFCL"][0]["mslp"] is None)
ok("IVCN keeps its intensity and loses its sentinel position",
   tr["IVCN"][0]["vmax"] == 68 and tr["IVCN"][0]["lat"] is None)

print("\n4. the aid catalog, which kinds must never blur")
ok("TVCN is consensus", spag.classify("TVCN") == "consensus")
ok("AEMN is an ensemble MEAN, never consensus: one model averaged with "
   "itself is not several models agreeing",
   spag.classify("AEMN") == "ensemble_mean")
ok("AP07 is an ensemble member", spag.classify("AP07") == "ensemble_member")
ok("AC00 is the control member", spag.classify("AC00") == "ensemble_member")
ok("AP31 does not exist and is not one", spag.classify("AP31") == "other")
ok("HFSA is dynamical", spag.classify("HFSA") == "dynamical")
ok("a JTWC basin refuses the consensus claim outright",
   spag.classify("TVCN", "wp") == "other")
ok("labels resolve", spag.label("AVNO") == "GFS"
   and spag.label("AP07") == "GEFS p07")

print("\n5. the honesty block: a consensus nobody can recompute")
cm = spag.consensus_membership(["TVCN", "AVNI", "HWFI"], "al")
ok("TVCN is reported", len(cm) == 1 and cm[0]["tech"] == "TVCN")
states = {m["tech"]: m["state"] for m in cm[0]["members"]}
ok("its present members are present",
   states["AVNI"] == "present" and states["HWFI"] == "present")
ok("its ECMWF members are WITHHELD, which is not the same as absent",
   states["EMXI"] == "withheld" and states["EMNI"] == "withheld")
ok("and the consensus is marked not reproducible",
   cm[0]["reproducible"] is False)
ok("a JTWC basin has no membership to describe and none is invented",
   spag.consensus_membership(["TVCN"], "wp") == [])

print("\n6. the per-storm document")
adeck = "\n".join([
    # An older cycle that must NOT leak into the current guidance.
    row(dtg="2026082512", tech="AVNO", tau=0, lat="205N", lon="0640W",
        vmax="55", mslp="992"),
    row(tech="AVNO", tau=0), row(tech="AVNO", tau=0, rad="50"),
    row(tech="AVNO", tau=12, lat="228N", lon="0672W", vmax="70", mslp="980"),
    row(tech="AVNI", tau=0, lat="219N"),
    row(tech="AVNI", tau=12, lat="229N", lon="0671W"),
    row(tech="OFCL", tau=0, lat="219N", mslp="0"),
    row(tech="OFCL", tau=12, lat="229N", lon="0671W", mslp="0"),
    row(tech="TVCN", tau=12, lat="230N", lon="0670W", vmax="0", mslp="0"),
    row(tech="AEMN", tau=12, lat="231N", lon="0669W"),
    row(tech="AP05", tau=12, lat="233N", lon="0668W"),
    row(tech="CARQ", tau=-6),
])
bdeck = "\n".join([
    "AL, 09, 2026082518,   , BEST,   0, 210N,  645W,  60,  990, TS,  34, NEQ,"
    "  120,   90,   60,   90, 1008,  200,  20,  55,   0,   L,   0,    ,"
    "   0,   0, GABRIELLE,",
    "AL, 09, 2026082600,   , BEST,   0, 218N,  651W,  65,  985, HU,  34, NEQ,"
    "  120,   90,   60,   90, 1008,  200,  20,  60,   0,   L,   0,    ,"
    "   0,   0, GABRIELLE,",
])
doc = spag.build_document(adeck, bdeck, "al", 9, 2026)
ok("the document is for the NEWEST cycle only",
   doc["cycle"] == "2026082600")
ok("the older cycle's rows are gone",
   all(p["tau"] in (0, 12) for p in doc["aids"]["AVNO"])
   and doc["aids"]["AVNO"][0]["lat"] == 21.8)
ok("the storm has its name, read from the b-deck's own column",
   doc["name"] == "GABRIELLE")
ok("the best track is the whole history in order",
   [p["dtg"] for p in doc["best_track"]]
   == ["2026082518", "2026082600"])
ok("the official forecast is resolved server-side",
   doc["official"] == "OFCL")
ok("every present aid has meta",
   set(doc["aid_meta"]) == set(doc["aids"]))
ok("the GEFS member is classified as one",
   doc["aid_meta"]["AP05"]["kind"] == "ensemble_member")
ok("TVCN's irreproducibility rides along",
   any(c["tech"] == "TVCN" and not c["reproducible"]
       for c in doc["consensus_membership"]))
ok("the withheld-ECMWF note is on the document",
   "ECMWF" in (doc["withheld_note"] or ""))
ok("has_track needs two positioned points, one is a dot not a line",
   doc["aid_meta"]["TVCN"]["has_track"] is False
   and doc["aid_meta"]["AVNO"]["has_track"] is True)
# A-decks persist all season, so a dead June storm still has a file in
# August and would fan stale guidance across a quiet map. The active flag is
# what stops that: dead when the last best-track fix is older than two days,
# alive when it is fresh. Both sides pinned relative to the real clock.
import datetime as _dt
def _bdeck_at(dtg):
    return (f"AL, 09, {dtg},   , BEST,   0, 218N,  651W,  65,  985, HU,"
            "  34, NEQ,  120,   90,   60,   90, 1008,  200,  20,  60,   0,"
            "   L,   0,    ,   0,   0, GABRIELLE,")
_now = _dt.datetime.now(_dt.timezone.utc)
stale = spag.build_document(adeck,
    _bdeck_at((_now - _dt.timedelta(days=30)).strftime("%Y%m%d%H")),
    "al", 9, 2026)
ok("a storm whose last fix is a month old is marked inactive",
   stale["active"] is False)
fresh = spag.build_document(adeck,
    _bdeck_at((_now - _dt.timedelta(hours=6)).strftime("%Y%m%d%H")),
    "al", 9, 2026)
ok("and one fixed six hours ago is active", fresh["active"] is True)

print("\n7. storm discovery, from the directory listing")
listing = ("<a href='aal092026.dat.gz'>x</a> <a href='aal832026.dat.gz'>t</a> "
           "<a href='aep052026.dat.gz'>x</a> <a href='aal902026.dat.gz'>i</a> "
           "<a href='aal092025.dat.gz'>old</a>").encode()
real_get = spag.http_get
spag.http_get = lambda url, timeout=45: listing
try:
    found = spag.discover_storms(2026)
finally:
    spag.http_get = real_get
ok("live storms and invests are found",
   ("al", 9) in found and ("ep", 5) in found and ("al", 90) in found)
ok("the GSTEST fixture decks (80-89) are excluded, their values are absurd",
   ("al", 83) not in found)
ok("last year's deck is not this year's storm",
   all(True for _ in [0]) and len([f for f in found if f == ("al", 9)]) == 1)

print("\n8. a failing season never publishes an empty lie")
tmp = tempfile.mkdtemp()
spag.OUT_DIR = tmp
old_index = {"updated": "yesterday", "storms": [{"id": "al082026"}]}
with open(os.path.join(tmp, "latest.json"), "w") as f:
    json.dump(old_index, f)


def _boom(*a, **k):
    raise RuntimeError("the network is down")


real_fetch = spag.fetch_deck
spag.fetch_deck = _boom
try:
    rc = spag.build(2026, only=[("al", 9)])
finally:
    spag.fetch_deck = real_fetch
ok("the run reports failure", rc == 1)
with open(os.path.join(tmp, "latest.json")) as f:
    kept = json.load(f)
ok("and the previous good index is still there, not overwritten with []",
   kept == old_index)

print("\n9. house rules and credit")
src = open(os.path.join(ROOT, "pi", "spaghetti_pipeline.py")).read()
ok("no em dash in the pipeline", chr(0x2014) not in src)
ok("Triple-A Tropics is credited at source", "Triple-A Tropics" in src)
ok("and its author", "Andrew Austin-Adler" in src)
ok("the source of truth is NHC's own host", "ftp.nhc.noaa.gov" in src)
ok("this test has no em dash either",
   chr(0x2014) not in open(os.path.abspath(__file__)).read())
inst = open(os.path.join(ROOT, "pi", "install.sh")).read()
ok("the installer registers the service", "gwcfc-spag.timer" in inst)

print(f"\n{'all ' if not failed else ''}{passed} passed"
      + (f", {failed} FAILED" if failed else ""))
sys.exit(1 if failed else 0)
