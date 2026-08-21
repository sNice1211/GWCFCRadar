#!/usr/bin/env python3
"""
The Pi's published address, and the two ways it can be silently useless.

    python3 tools/test-pi-address.py

Everything that needs the Pi - the RGB composites, the model layers, the
soundings - reaches it at one address, published by the Pi and read by the
browser. When that address is wrong, nothing says so usefully: every feature
reports "the Pi did not answer", which sounds like the Pi is off.

Twice it is not off at all, and the browser knew perfectly well why:

  - the address is plain http while the site is https, so the browser refuses
    to send the request. Nothing arrives at the Pi, so nothing on the Pi can
    notice, and the Pi looks dead while being completely healthy.
  - the address is a private one on the home network, which works from the
    sofa and from nowhere else.

Both are worth refusing to publish and both are worth naming when they
happen, so this checks the Pi side refuses them and the browser side tells
them apart.
"""

import ast
import importlib.util
import json
import os
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUB = os.path.join(ROOT, "pi", "publish_url.py")
HTML = os.path.join(ROOT, "index.html")

passed = failed = 0


def ok(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name}" + (f"  <{extra}>" if extra else ""))


src = open(PUB, encoding="utf-8").read()
html = open(HTML, encoding="utf-8").read()

ns = {"re": re}
for node in ast.parse(src).body:
    if isinstance(node, ast.FunctionDef) and node.name == "usable_from_the_web":
        exec(ast.get_source_segment(src, node), ns)
assert "usable_from_the_web" in ns, "usable_from_the_web not found"
usable = ns["usable_from_the_web"]


print("\n1. a tunnel address is fine, which is the whole point")
for url in ("https://calm-river-1234.trycloudflare.com",
            "https://wx.example.com",
            "https://wx.example.com:8443"):
    ok(f"{url} is publishable", usable(url) is None, str(usable(url)))
# 172.16 through 172.31 is the private block. 172.32 is not, and a range
# check written as a plain string prefix would get this wrong.
ok("and a public address that merely looks private is not refused",
   usable("https://172.32.4.4") is None, str(usable("https://172.32.4.4")))


print("\n2. plain http is refused, because a browser would never send it")
for url in ("http://wx.example.com", "http://192.168.0.130:8080"):
    why = usable(url)
    ok(f"{url} is refused", why is not None)
    ok("  and the reason names https rather than being vague",
       why and "https" in why, str(why))


print("\n3. so is an address only the home network can reach")
for url in ("https://192.168.0.130:8080", "https://10.25.97.201",
            "https://172.16.4.4", "https://172.31.255.1",
            "https://gwcfc-pi.local", "https://localhost:8080",
            "https://127.0.0.1", "https://169.254.1.1"):
    why = usable(url)
    ok(f"{url} is refused", why is not None, str(why))


print("\n4. refusing means not publishing, not publishing something else")
# The pinned file is read by pinned_url, and that is where a bad address
# would get in. Publishing it would replace a working tunnel address with
# one that cannot work, and the failure would surface in a browser somewhere
# else entirely, hours later.
ok("the pinned address is checked before it is used",
   "usable_from_the_web" in src.split("def pinned_url")[1][:600],
   "pinned_url does not check")
ok("and a refused one becomes None rather than being published",
   re.search(r"def pinned_url.*?log\(f\"ignoring the pinned address.*?return None",
             src, re.S) is not None)
ok("with the file to delete named, since that is the fix",
   "remove {PINNED}" in src or "remove {PINNED} to go back" in src)
# The tunnel's own address is matched by a regex that only accepts https
# trycloudflare names, so that path was never able to publish plain http.
ok("the tunnel's own address was already https only",
   'URL_RE = re.compile(r"https://' in src)


print("\n5. the browser tells the same three cases apart")
ok("there is one place that works out why, rather than a guess per feature",
   "function _hdWhyUnreachable" in html)
for token, what in [
    ("'mixed'", "http behind an https page"),
    ("'lan'", "a private address"),
    ("'down'", "genuinely not answering"),
    ("'none'", "no address published at all"),
]:
    ok(f"it can say: {what}", token in html.split("_hdWhyUnreachable")[1][:2600],
       token)
# The private ranges have to agree with the Pi's, or the Pi refuses to
# publish something the browser would have explained, or the other way round.
seg = html.split("function _hdWhyUnreachable")[1][:2600]
for net in ("127\\.", "10\\.", "192\\.168\\.", "169\\.254\\.", "localhost"):
    ok(f"and it knows {net.replace(chr(92), '')} is private", net in seg, net)
ok("including the awkward 172.16 to 172.31 block",
   "172\\.(1[6-9]|2\\d|3[01])" in seg)

print("\n6. every feature that reports the Pi dead uses it")
# Three separate places used to print their own guess. A message that says
# "it may be off" when the browser knows it was blocked sends whoever reads
# it to look at the wrong thing entirely.
ok("the satellite composites", "_hdWhyUnreachable().text" in html)
ok("the model panel",
   "_hdWhyUnreachable().text" in html and "hd-warn" in html)
ok("and the sounding panel", "_hdWhyUnreachable()" in html
   and "Web (no Pi needed)" in html)
# The composites are the Pi's own work and have no fallback, but the ABI
# bands in the same menu are a public service. "Satellite is broken" is
# usually "the composites are broken", and saying so saves a lot of looking.
ok("the composites say what still works without the Pi",
   "do not need the Pi at all" in html)
ok("and the sounding points at the source that needs no Pi",
   "Web (no Pi needed)" in html)


# The rest of this file runs the real functions against real little servers,
# because the two bugs below were both "the code says the right words and
# does the wrong thing", which reading the source cannot catch.
_spec = importlib.util.spec_from_file_location("publish_url", PUB)
pub = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pub)


class _Fake(BaseHTTPRequestHandler):
    """One stand-in server; ROUTES says what it answers with."""
    ROUTES = {}
    CORS = True

    def log_message(self, *a):
        pass

    def do_GET(self):
        code, body = self.ROUTES.get(self.path, (404, b"not found"))
        self.send_response(code)
        if self.CORS:
            self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def serve(routes, cors=True):
    """A throwaway server on a spare port. Returns its address."""
    cls = type("H", (_Fake,), {"ROUTES": routes, "CORS": cors})
    srv = ThreadingHTTPServer(("127.0.0.1", 0), cls)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    servers.append(srv)
    return f"http://127.0.0.1:{srv.server_address[1]}"


servers = []
LISTING = b"<html><title>Directory listing for /</title><ul></ul></html>"
LATEST = json.dumps({"run": "2026082112", "layers": []}).encode()
CF_404 = b'{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}'

print("\n7. the address is only accepted if the PI is what answers")
# The bug this exists for: `answers` took any HTTP reply as proof, so when a
# wrong address was published, the check meant to catch it confirmed it. The
# site was told to fetch the Pi's files from Cloudflare's API and every
# Pi-backed feature went dark while the Pi sat there perfectly healthy.
pi = serve({"/models/latest.json": (200, LATEST), "/": (200, LISTING)})
ok("a healthy Pi is accepted", pub.answers(pi, timeout=5) is True)

fresh = serve({"/": (200, LISTING)})
ok("so is a Pi that has not built a model yet, since the root still proves it",
   pub.answers(fresh, timeout=5) is True)

cf = serve({"/": (404, CF_404)})
ok("Cloudflare's API host is REFUSED even though it answers politely",
   pub.answers(cf, timeout=5) is False)

other = serve({"/": (200, b"<html><body>somebody else's website</body></html>")})
ok("and so is any other site that happens to answer on /",
   pub.answers(other, timeout=5) is False)

plain = serve({"/models/latest.json": (200, LATEST), "/": (200, LISTING)},
              cors=False)
ok("a server with no CORS header is refused, since a browser could not read it",
   pub.answers(plain, timeout=5) is False)

ok("nothing listening at all is refused",
   pub.answers("http://127.0.0.1:1", timeout=2) is False)

ok("and the --check knock is the same knock, so the two cannot disagree",
   "answers(url, timeout=20)" in src)


print("\n8. the tunnel's address is read out of the log, not Cloudflare's")
# cloudflared writes "api.trycloudflare.com" into its own log while asking
# for a tunnel. The old pattern matched it, and it was the newest match, so
# that is what got published.
log = """
2026-08-21T02:11:04Z INF Requesting new quick Tunnel on trycloudflare.com...
2026-08-21T02:11:05Z INF Requesting tunnel from https://api.trycloudflare.com/tunnel
2026-08-21T02:11:07Z INF +------------------------------------------+
2026-08-21T02:11:07Z INF |  https://calm-river-fried-1234.trycloudflare.com  |
2026-08-21T02:11:07Z INF +------------------------------------------+
"""
found = pub._tunnel_urls(log)
ok("Cloudflare's own API host is not mistaken for the tunnel",
   "https://api.trycloudflare.com" not in found, str(found))
ok("and the real tunnel address is found",
   found == ["https://calm-river-fried-1234.trycloudflare.com"], str(found))
ok("dash, www and the other service names are refused too",
   pub._tunnel_urls("https://www.trycloudflare.com https://dash.trycloudflare.com") == [],
   str(pub._tunnel_urls("https://www.trycloudflare.com")))
ok("order is kept, so the newest can still be preferred",
   pub._tunnel_urls("https://one-a.trycloudflare.com https://two-b.trycloudflare.com")
   == ["https://one-a.trycloudflare.com", "https://two-b.trycloudflare.com"])

for s in servers:
    s.shutdown()

print()
if failed:
    print(f"{failed} FAILED, {passed} passed")
    sys.exit(1)
print(f"all {passed} passed")
