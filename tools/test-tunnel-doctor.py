#!/usr/bin/env python3
"""
Reading cloudflared's log the way you would read it over somebody's shoulder.

    python3 tools/test-tunnel-doctor.py

A tunnel that carries no traffic has three quite different causes, and from
the browser they are one symptom: the site cannot reach the Pi. The tell that
separates them is not an error message. It is the absence of a single line,
in an append-only log where a success from last week sits directly above a
failure from today.

So the log samples below are real shapes, including the one off the actual Pi
that this was written for, and the point of every case is that the verdict is
read from the NEWEST run only.
"""

import importlib.util
import os
import socket
import sys
import threading

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


_spec = importlib.util.spec_from_file_location(
    "tunnel_doctor", os.path.join(ROOT, "pi", "tunnel_doctor.py"))
td = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(td)

# The real thing, pasted off the Pi. cloudflared starts, is given an address,
# prepares, and then simply stops: no "Registered tunnel connection", no
# error, nothing. That silence is the diagnosis.
STUCK = """\
2026-08-21T20:34:45Z INF Requesting new quick Tunnel on trycloudflare.com...
2026-08-21T20:34:45Z INF +------------------------------------------------+
2026-08-21T20:34:45Z INF |  Your quick Tunnel has been created! Visit it:  |
2026-08-21T20:34:45Z INF |  https://extending-contains-evans-few.trycloudflare.com  |
2026-08-21T20:34:45Z INF +------------------------------------------------+
2026-08-21T20:34:46Z INF Version 2026.8.2 (Checksum 7747d945)
2026-08-21T20:34:46Z INF GOOS: linux, GOVersion: go1.26.4, GoArch: arm64
2026-08-21T20:34:46Z INF Settings: map[p:http2 protocol:http2 url:http://localhost:8080]
2026-08-21T20:34:46Z INF Autoupdate frequency is set autoupdateFreq=86400000
2026-08-21T20:34:47Z INF Generated Connector ID: 3fbafedd-06d2-407e-9e04-2c11776da905
2026-08-21T20:34:48Z INF Initial protocol http2
"""

HEALTHY = """\
2026-08-21T18:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...
2026-08-21T18:00:01Z INF |  https://calm-river-fried-1234.trycloudflare.com  |
2026-08-21T18:00:02Z INF Initial protocol http2
2026-08-21T18:00:03Z INF Registered tunnel connection connIndex=0 location=ord07
"""

print("\n1. the newest run is the only one that counts")
# The unit appends and never truncates, so a log that has been healthy for
# months has a healthy run sitting directly above today's broken one. Reading
# the file as a whole would report the wrong machine's worth of history.
both = HEALTHY + STUCK
block = td.last_run(both)
ok("a success above today's failure does not mask it",
   td.CONNECTED not in block, "read the old healthy run")
ok("and the newest address is the one recovered",
   "extending-contains-evans-few" in block)
ok("the other way round, a healthy run after a failure IS seen",
   td.CONNECTED in td.last_run(STUCK + HEALTHY))
ok("a log with no start marker at all is still read rather than dropped",
   td.last_run("nothing familiar here") == "nothing familiar here")

print("\n2. the tell is a line that is missing, not one that is there")
# This is the whole reason this file exists. The stuck case contains no
# error, no warning and no complaint. Every line in it is an INF that reads
# like success. Only the absent one says anything.
ok("the stuck run reports no traffic ever carried",
   td.CONNECTED not in STUCK)
ok("even though it complains about nothing at all",
   td.complaints(STUCK) == [], str(td.complaints(STUCK)))
ok("and it DID get an address, which is what makes it so confusing",
   bool(td.publish_url._tunnel_urls(STUCK)))

print("\n3. it does not mistake Cloudflare's own address for the tunnel's")
publish_url = td.publish_url
ok("the address recovered is the tunnel's",
   publish_url._tunnel_urls(STUCK)
   == ["https://extending-contains-evans-few.trycloudflare.com"],
   str(publish_url._tunnel_urls(STUCK)))
asking = STUCK.replace("Requesting new quick Tunnel on trycloudflare.com...",
                       "Requesting tunnel from https://api.trycloudflare.com/t")
ok("and not the API host it asked on the way",
   "https://api.trycloudflare.com" not in publish_url._tunnel_urls(asking))

print("\n4. real complaints are picked out when there ARE any")
NOISY = STUCK + (
    "2026-08-21T20:35:20Z ERR Failed to dial a quic connection "
    "error=\"timeout: no recent network activity\"\n"
    "2026-08-21T20:35:21Z INF Retrying connection in up to 2s\n")
said = td.complaints(NOISY)
ok("the dial failure is surfaced", any("Failed to dial" in s for s in said),
   str(said))
ok("so is the retry, since a loop is itself the symptom",
   any("Retrying" in s for s in said), str(said))
ok("and the flood is capped rather than printed whole",
   len(td.complaints(NOISY * 40)) <= 6)

print("\n5. a port is knocked on for real")
# Blocked and closed are different, and the difference is the diagnosis: a
# closed port answers at once, a filtered one says nothing at all. Only the
# reachable case can be proved here, so that is the one that is proved.
srv = socket.socket()
srv.bind(("127.0.0.1", 0))
srv.listen(1)
port = srv.getsockname()[1]
threading.Thread(target=lambda: srv.accept(), daemon=True).start()
good, why = td.tcp_open("127.0.0.1", port, timeout=3)
ok("something listening reads as open", good is True, why)
ok("and it says where it got through", "127.0.0.1" in why, why)
srv.close()

bad, why = td.tcp_open("127.0.0.1", 1, timeout=3)
ok("nothing listening reads as not open", bad is False, why)
ok("and a refusal is named as a refusal, not as a filter",
   "refused" in why or "no answer" in why, why)

nx, why = td.tcp_open("no-such-host.invalid", 7844, timeout=3)
ok("a name that does not resolve is its own answer", nx is False, why)
ok("and says so rather than blaming the port",
   "resolve" in why, why)

print("\n6. it knows which port matters")
src = open(os.path.join(ROOT, "pi", "tunnel_doctor.py")).read()
ok("7844, which is the one a tunnel cannot live without",
   td.EDGE_PORT == 7844)
ok("on both edge regions, since one can be down on its own",
   len(td.EDGE_HOSTS) == 2)
# The decisive sentence. Ordinary browsing working while 7844 does not is
# the exact shape of a home filter, and it is invisible from the Pi.
ok("and it says outright when the network is the culprit",
   "network filter, not a fault in the Pi" in src)
ok("with a way to prove it that needs nobody's permission",
   "hotspot" in src)

print("\n7. when the tunnel says it IS connected, it stops guessing")
# The case that sent this round in circles. cloudflared reported itself
# connected, the port was open, ordinary https worked, and the address still
# did not answer. Every theory left is a different HTTP status, and a
# boolean cannot tell them apart. So the statuses are read out loud.
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer   # noqa


def _one(status, body, cors=False, cfray=False):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            self.send_response(status)
            if cors:
                self.send_header("Access-Control-Allow-Origin", "*")
            if cfray:
                self.send_header("cf-ray", "8a1b2c3d4e5f-ORD")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
    s = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s, f"http://127.0.0.1:{s.server_address[1]}/"


srv_ok, url_ok = _one(200, b"<title>Directory listing for /</title>",
                      cors=True, cfray=True)
line = td.describe(*td.fetch(url_ok, timeout=5))
ok("a good answer is reported with its status", "HTTP 200" in line, line)
ok("and says the reply came through Cloudflare rather than direct",
   "via Cloudflare" in line, line)
ok("and that a browser would be allowed to read it",
   "with the browser header" in line, line)
ok("and shows what the body actually was, not a verdict about it",
   "Directory listing" in line, line)
srv_ok.shutdown()

srv_bad, url_bad = _one(502, b"error code: 1033", cfray=True)
line = td.describe(*td.fetch(url_bad, timeout=5))
ok("an edge error is reported as itself", "HTTP 502" in line, line)
ok("with the code that says which end failed", "1033" in line, line)
srv_bad.shutdown()

line = td.describe(*td.fetch("http://127.0.0.1:1/", timeout=2))
ok("and nothing listening is not dressed up as a status",
   line.startswith("no answer"), line)

# Every restart of cloudflared rolls a brand new address, so the number of
# starts IS the churn, and churn is a fault the site can never keep up with.
ok("how often cloudflared has restarted is counted",
   td.starts(HEALTHY + STUCK) == 2, str(td.starts(HEALTHY + STUCK)))
src2 = open(os.path.join(ROOT, "pi", "tunnel_doctor.py")).read()
ok("an address that works sometimes is called flapping, not broken",
   "answers sometimes and not others" in src2)
ok("and the real cure for flapping is named", "NAMED_TUNNEL.md" in src2)
ok("serve.py is checked directly, so its end is ruled in or out",
   "straight to serve.py" in src2)

print("\n8. fix.sh goes straight on to why")
fixsh = open(os.path.join(ROOT, "pi", "fix.sh")).read()
ok("a failed address check runs the tunnel doctor by itself",
   "tunnel_doctor.py" in fixsh)
ok("rather than ending on a failure and another command to type",
   "--check ||" in fixsh)
# The Pi got stuck unable to update at all, from a merge commit a plain
# `git pull` wrote. Refusing that forever is worse than the drift.
ok("a drift made only of merge commits is recovered from",
   "--no-merges" in fixsh and "loses nothing" in fixsh)
ok("but real work is still refused, and named so it can be looked at",
   "has work of its own" in fixsh and "What is only here" in fixsh)

print("\n9. the network itself is treated as a fault that can be fixed")
net = open(os.path.join(ROOT, "pi", "fixnet.sh")).read()
# "Name or service not known" was reported for an address Cloudflare had made
# seconds earlier. That is not a wrong address, it is a question nobody
# answered, and restarting the tunnel forever cannot fix a name server.
ok("there is a script for the connection itself", len(net) > 800)
ok("it tells IPv4 and IPv6 apart, since only one of them was broken",
   "IPv4 does NOT reach" in net and "IPv6 does NOT reach" in net)
# A plain TCP connect to a literal address needs no DNS, which is the only
# way to tell "the network is down" from "nobody answered the question".
ok("it probes by address, so a broken resolver cannot skew the answer",
   "/dev/tcp/" in net)
ok("and checks whether names resolve as its own separate question",
   "getent hosts cloudflare.com" in net)
ok("it writes the setting where this Pi actually keeps it",
   "nmcli" in net and "systemd-resolved" in net and "resolv.conf" in net)
# Guessing wrong here means a change that lasts until the next DHCP lease.
ok("rather than one place and a hope", "dhcpcd.conf" in net)
ok("if IPv4 is the broken half, cloudflared is told to stop using it",
   "--edge-ip-version 6" in net)
ok("through a drop-in, so install.sh rewriting the unit does not undo it",
   "gwcfc-tunnel.service.d" in net)
ok("and it is undone by itself once IPv4 works again",
   "IPv4 works again" in net)
ok("it says how to undo it by hand too", "delete" in net and "to undo" in net)
# systemctl --user under sudo is root's session, which has none of these
# units in it, and would silently do nothing.
ok("user units are restarted as the user, not as root",
   "SUDO_USER" in net and "as_user" in net)
ok("fix.sh offers it exactly when names are what is broken",
   "fixnet.sh" in fixsh and "getent hosts" in fixsh)

print()
if failed:
    print(f"{failed} FAILED, {passed} passed")
    sys.exit(1)
print(f"all {passed} passed")
