#!/usr/bin/env python3
"""
The weather radio recorder: what it is called, where it is, and whether it
should be installed here at all.

    python3 tools/test-nwr-recorder.py

Three things, all found by running it for real on 129 stations.

  1. A station id came out as the letter "A". _callsign_from_mount took the
     LAST hyphen-separated piece of a wxr mount, and some mounts carry an
     alternate feed of the same transmitter: /NE-Omaha-KIH61-A. So an
     alternate feed of KIH61 was archived under the id "A", while the real
     KIH61 from another relay was skipped as a duplicate of nothing.

  2. Stations indexed with state null. A lot of relays report their mounts as
     "no name" or "Unspecified name", so parse_state had nothing to read. The
     page files stations by region, so those stations fell off it entirely.
     The mount path says the state anyway: /FL-Largo-KEC38.

  3. install.sh put the recorder on every box, including one that is a radar
     Pi and nothing else, with about 50 GB free. Measured: 129 stations
     tone-only cost 8.26 GB a day, roughly 64 MB per station per day, so 90
     days is about 750 GB. That box would have filled in under a week and
     taken the radar, the models and the tunnel down with it, because a full
     disk does not announce itself as a disk.

Nothing here goes near a relay: the parsers are pure functions and the
installer is read as text.
"""

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


import nwr_archiver as arch                                # noqa: E402
import nwr_index as idx                                    # noqa: E402

cs = arch._callsign_from_mount

print("\n1. a plain wxr mount still reads the way it always did")
ok("state, city, callsign", cs("wxr", "http://relay/FL-Largo-KEC38") == "KEC38",
   cs("wxr", "http://relay/FL-Largo-KEC38"))
ok("a two word city does not confuse it",
   cs("wxr", "http://relay/TX-Fort-Worth-KEC55") == "KEC55",
   cs("wxr", "http://relay/TX-Fort-Worth-KEC55"))
ok("and a mount that is only a callsign",
   cs("wxr", "http://relay/WXL57") == "WXL57",
   cs("wxr", "http://relay/WXL57"))

print("\n2. an alternate feed is not a station called A")
got = cs("wxr", "http://relay/NE-Omaha-KIH61-A")
ok("it is KIH61, not A", got == "KIH61", got)
ok("specifically, it is not a single letter", len(got) > 1, got)
for tail in ("-B", "-2", "-alt"):
    g = cs("wxr", "http://relay/NE-Omaha-KIH61" + tail)
    ok("and neither is %s" % tail, g == "KIH61", g)

print("\n3. the town is never mistaken for the callsign")
# The digit is what does the work here. Without it "Omaha" and "Largo" are
# exactly as callsign-shaped as KIH61.
ok("Omaha is not a callsign", not arch.CALLSIGN_RE.match("Omaha"))
ok("Largo is not a callsign", not arch.CALLSIGN_RE.match("Largo"))
ok("a bare letter is not a callsign", not arch.CALLSIGN_RE.match("A"))
for call in ("KIH21", "WXL57", "KEC38", "WNG645", "KZZ12"):
    ok("%s is" % call, bool(arch.CALLSIGN_RE.match(call)))

print("\n4. the state is read from the name when the name has one")
ok("KIH21 Sebring FL 162.475",
   idx.parse_state("KIH21 Sebring FL 162.475") == "FL")
ok("WXR - Sebring, FL - KIH21",
   idx.parse_state("WXR - Sebring, FL - KIH21") == "FL")
ok("and the LAST state token wins, not a city that looks like one",
   idx.parse_state("KEC38 OR Portland ME 162.550") == "ME",
   idx.parse_state("KEC38 OR Portland ME 162.550"))

print("\n5. and from the mount when it does not, which is most of them")
for name in ("no name", "Unspecified name", "", None):
    got = idx.parse_state(name, "http://relay/FL-Largo-KEC38")
    ok("%r falls back to the mount path" % (name,), got == "FL", got)
ok("a mount with no state in it still gives null rather than a wrong one",
   idx.parse_state("no name", "http://relay/stream1.mp3") is None,
   idx.parse_state("no name", "http://relay/stream1.mp3"))
ok("and the name still wins when it has one",
   idx.parse_state("KIH21 Sebring FL", "http://relay/NE-Omaha-KIH61") == "FL")

print("\n6. the indexer actually passes the mount through")
src = open(os.path.join(ROOT, "pi", "nwr_index.py"), encoding="utf-8").read()
ok("stations.json is read for the url, not only the name",
   '"url"' in src, "no url read")
ok("and parse_state is given it", "parse_state(name, url)" in src)

print("\n7. the recorder is opt in, and refuses a disk it would fill")
ins = open(os.path.join(ROOT, "pi", "install.sh"), encoding="utf-8").read()
ok("there is a switch to ask for it", "GWCFC_NWR" in ins)
ok("and it says how to, rather than just going quiet",
   "GWCFC_NWR=1 bash" in ins)
ok("a box that already records keeps recording, so this is not a downgrade",
   re.search(r'NWR_WANT.*\n.*NWR_CONF', ins) is not None
   or '[ -s "$NWR_CONF" ]; then\n  NWR_WANT=1' in ins, "no keep-working path")
ok("free space is measured before anything is installed",
   "NWR_FREE_MB" in ins and "df -Pm" in ins)
ok("the budget is per station, from the measured 64 MB a day",
   "NWR_N * 64" in ins, "no per-station budget")
ok("the answer is given in DAYS, which is the unit the question is in",
   "days of recording" in ins)
ok("under a week of room means it is not installed",
   "NWR_DAYS" in ins and "-lt 7" in ins)
ok("and it says WHY that matters, since a full disk is not a disk error",
   "takes the radar" in ins)

print("\n8. an unasked-for recorder is cleaned off, not left running")
ok("the old units are disabled when it is not wanted",
   "disable --now gwcfc-nwr.service" in ins)
ok("and their files removed, so nothing tries to start them",
   'rm -f "$UNITS/gwcfc-nwr.service"' in ins)
ok("starting is guarded on BOTH the switch and the station list",
   '[ -n "$NWR_WANT" ] && [ -s "$NWR_CONF" ]' in ins)

print()
if failed:
    print("%d FAILED, %d passed" % (failed, passed))
    sys.exit(1)
print("all %d passed" % passed)
