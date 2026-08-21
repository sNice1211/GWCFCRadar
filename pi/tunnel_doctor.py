#!/usr/bin/env python3
"""
Why the tunnel is not carrying traffic.

    python3 pi/tunnel_doctor.py

publish_url.py --check answers one question: does the published address
work. When it does not, the next question has always been the same, and
until now nothing here could answer it. There are three quite different
faults and they all present as "the site cannot reach the Pi":

  1. cloudflared never got an address at all. It could not reach
     trycloudflare.com, so there is nothing to publish.
  2. cloudflared got an address, and then never managed to connect to
     Cloudflare's network. The address is real and correct and answers
     every request with an edge error, because there is nothing on the
     other end of it. This is the one that looks most like a bug in this
     project and is not one.
  3. The tunnel is connected, and the trouble is on this side: serve.py
     is not running, or not on the port the tunnel points at.

cloudflared says which of the three it is, in its log, and the tell is not
an error message. It is the ABSENCE of one line. So this reads the log the
way you would read it over somebody's shoulder, and then knocks on the one
outbound port a tunnel cannot live without, because a network that blocks
that port looks exactly like a broken program from here.
"""

import os
import socket
import ssl
import sys
import time
import urllib.error
import urllib.request

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import publish_url                                          # noqa: E402

# Where a tunnel connects once it has an address. Not 443, and that is the
# whole point: a home network filter that leaves web browsing alone very
# often drops this, and then everything else about the Pi looks broken.
EDGE_HOSTS = ("region1.v2.argotunnel.com", "region2.v2.argotunnel.com")
EDGE_PORT = 7844

# The line cloudflared prints once, and only once, it is actually carrying
# traffic. Everything before it is preparation.
CONNECTED = "Registered tunnel connection"
# Where one run of cloudflared begins in an append-only log. Reading the
# whole file would let a success from last week hide a failure from today.
START = "Requesting new quick Tunnel"

_NOISE = ("ERR ", "error", "failed", "timeout", "timed out", "refused",
          "deadline", "unable", "cannot", "retry", "retrying")


def out(m=""):
    print(m, flush=True)


def last_run(text):
    """Only the newest start of cloudflared, never the whole history."""
    for marker in (START, "Generated Connector ID", "Initial protocol"):
        i = text.rfind(marker)
        if i >= 0:
            # Back up to the start of that line so the timestamp comes too.
            nl = text.rfind("\n", 0, i)
            return text[nl + 1:] if nl >= 0 else text[i:]
    return text


def complaints(block, limit=6):
    """The lines in this run that sound like something going wrong."""
    hits = []
    for line in block.splitlines():
        low = line.lower()
        if any(n.lower() in low for n in _NOISE):
            hits.append(line.strip())
    return hits[-limit:]


def tcp_open(host, port, timeout=8):
    """(reachable, what happened in words)."""
    try:
        addrs = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as e:
        return False, f"the name does not resolve ({e.strerror or e})"
    fam, kind, proto, _, sa = addrs[0]
    s = socket.socket(fam, kind, proto)
    s.settimeout(timeout)
    try:
        s.connect(sa)
        return True, f"open ({sa[0]})"
    except socket.timeout:
        # The signature of a filter that drops rather than refuses. A closed
        # port answers immediately; a blocked one says nothing at all.
        return False, (f"no answer within {timeout}s at {sa[0]}, which is what "
                       "a filter that silently drops traffic looks like")
    except OSError as e:
        return False, f"refused at {sa[0]} ({e.strerror or e})"
    finally:
        try:
            s.close()
        except OSError:
            pass


def fetch(url, timeout=10):
    """What actually came back, in one line, whatever it was.

    Not a yes or a no. When a tunnel reports itself connected and the address
    still does not work, every remaining theory is a different HTTP status,
    and guessing between them from a boolean is how this went round in
    circles. 502 is the tunnel not reaching serve.py. 1033 is the edge not
    reaching the tunnel. 200 with the wrong body means the check is wrong.
    """
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "gwcfc"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.headers, r.read(200)
    except urllib.error.HTTPError as e:
        try:
            body = e.read(200)
        except Exception:
            body = b""
        return e.code, e.headers, body
    except Exception as e:
        return None, None, f"{e.__class__.__name__}: {e}".encode()


def describe(status, headers, body):
    """One readable line about a response, including who sent it."""
    if status is None:
        return f"no answer  ({body.decode(errors='ignore')})"
    who = ""
    if headers is not None:
        # cf-ray only exists on a reply that went through Cloudflare, so it
        # says whether the edge answered or the Pi did.
        if headers.get("cf-ray"):
            who = " via Cloudflare"
        if (headers.get("Access-Control-Allow-Origin") or "").strip() == "*":
            who += " with the browser header"
    peek = body.decode(errors="ignore").strip().replace("\n", " ")[:70]
    return f"HTTP {status}{who}  {peek!r}"


def starts(text):
    """How many times cloudflared has begun a run in this log."""
    return text.count(START)


def https_ok(url, timeout=10):
    """Can this machine fetch ordinary https at all?"""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "gwcfc"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return True, f"HTTP {r.status}"
    except urllib.error.HTTPError as e:
        return True, f"HTTP {e.code}, which still proves the road goes through"
    except ssl.SSLError as e:
        return False, (f"the secure connection was broken ({e.reason or e}). "
                       "Something on this network is interfering with https.")
    except Exception as e:
        return False, f"{e.__class__.__name__}: {e}"


def main():
    out("== What cloudflared last did")
    try:
        with open(publish_url.TUNNEL_LOG, errors="ignore") as f:
            text = f.read()
    except OSError:
        out(f"   there is no {publish_url.TUNNEL_LOG} at all, so the tunnel")
        out("   has never even started. FIX: bash ~/GWCFCRadar/pi/install.sh")
        return 1

    block = last_run(text)
    urls = publish_url._tunnel_urls(block)
    connected = CONNECTED in block

    if urls:
        out(f"   it was given an address:  {urls[-1]}")
    else:
        out("   it was NOT given an address in its most recent run.")
    out("   it reported carrying traffic:  "
        + ("yes" if connected else "NO"))

    said = complaints(block)
    if said:
        out("   what it complained about:")
        for line in said:
            out(f"     {line[:150]}")

    out()
    out("== The port a tunnel cannot live without")
    # Deliberately checked even when the log looks fine, because this is the
    # answer often enough to be worth the eight seconds either way.
    reach = {}
    for host in EDGE_HOSTS:
        okp, why = tcp_open(host, EDGE_PORT)
        reach[host] = okp
        out(f"   {host}:{EDGE_PORT}  {'OPEN' if okp else 'BLOCKED'}  {why}")
    web_ok, web_why = https_ok("https://www.cloudflare.com/cdn-cgi/trace")
    out(f"   ordinary https to cloudflare.com  "
        f"{'works' if web_ok else 'FAILS'}  {web_why}")

    edge = any(reach.values())
    out()
    out("== What that means")
    if not edge and web_ok:
        # The decisive case, and the one that is invisible without this.
        out("   Ordinary web traffic leaves this Pi fine, but the port the")
        out(f"   tunnel connects on ({EDGE_PORT}) does not.")
        out("   That is a network filter, not a fault in the Pi or in this")
        out("   project, and nothing done on the Pi will change it.")
        out()
        out("   It explains the whole picture: cloudflared can still ASK for")
        out("   an address, because that request goes over 443 like any web")
        out("   page. It then cannot connect, so the address it was given")
        out(f"   answers every request with an error. Port {EDGE_PORT} is the")
        out("   one most commonly blocked by home filtering and parental")
        out("   control software, because almost nothing else uses it.")
        out()
        out("   To fix it, one of:")
        out(f"     - allow outbound TCP {EDGE_PORT} on the router or filter")
        out("     - put the Pi on a different network, a phone hotspot is")
        out("       enough to prove this in two minutes")
        return 1
    if not edge and not web_ok:
        out("   This Pi cannot reach Cloudflare at all, on any port. That is")
        out("   the internet connection itself, not the tunnel.")
        out("   FIX: check the Pi's network, then run this again.")
        return 1
    if urls and not connected:
        out(f"   The port is open, and cloudflared still has not connected.")
        out("   That is usually a version too old for the edge to accept.")
        out("   FIX: sudo cloudflared update && systemctl --user restart gwcfc-tunnel")
        return 1
    if not urls:
        out("   The port is open but cloudflared was never given an address,")
        out("   so it could not reach trycloudflare.com to ask for one.")
        out("   FIX: systemctl --user restart gwcfc-tunnel, then run this again")
        return 1
    # Connected, and the address still does not work. Every theory left is a
    # different HTTP status, so stop theorising and read them.
    out("   The tunnel says it is connected. So the question is what actually")
    out("   comes back, from each end, which is below.")
    out()
    out("== What each end actually returns")
    local = fetch(f"http://127.0.0.1:{os.environ.get('GWCFC_PORT', '8080')}/",
                  timeout=6)
    out(f"   straight to serve.py   {describe(*local)}")
    tries = []
    if urls:
        addr = urls[-1].rstrip("/") + "/"
        for n in range(3):
            got = fetch(addr, timeout=10)
            tries.append(got[0])
            out(f"   through the tunnel {n + 1}   {describe(*got)}")
            if n < 2:
                time.sleep(3)
    out()
    out(f"   cloudflared has started {starts(text)} times in this log, on")
    out(f"   {len(publish_url._tunnel_urls(text))} different addresses. Every start rolls a new one.")

    # The publisher is the one thing in the chain with no visible output, so
    # when the site is told nothing at all it is the only place the reason
    # can be. It is a service, so its words are in the journal.
    out()
    out("   what the publisher last said:")
    said_any = False
    try:
        import subprocess
        j = subprocess.run(
            ["journalctl", "--user", "-u", "gwcfc-publish", "-n", "6",
             "--no-pager", "-o", "cat"],
            capture_output=True, text=True, timeout=20)
        for line in (j.stdout or "").splitlines():
            if line.strip():
                said_any = True
                out(f"     {line.strip()[:150]}")
    except Exception:
        pass
    if not said_any:
        out("     nothing, which means it has not run since the last reboot")

    out()
    out("== What that means")
    if local[0] != 200:
        out("   serve.py is not answering on this Pi, so there is nothing for")
        out("   the tunnel to carry. That is the whole problem and it is")
        out("   nothing to do with Cloudflare.")
        out("   FIX: systemctl --user restart gwcfc-serve")
        return 1
    if not tries:
        out("   serve.py is fine and there is no address to test against.")
        out("   FIX: systemctl --user restart gwcfc-tunnel")
        return 1
    good_tries = [t for t in tries if t == 200]
    if len(good_tries) == len(tries):
        out("   Both ends work and the address answers every time. So the")
        out("   address is good, and the site is simply being told an older")
        out("   one that has since died.")
        out("   FIX: systemctl --user restart gwcfc-publish")
        return 1
    if good_tries:
        out("   It answers sometimes and not others. Nothing is misconfigured;")
        out("   the connection itself is dropping and coming back, and each")
        out("   drop rolls a brand new address that the site cannot keep up")
        out("   with. A quick tunnel is the throwaway kind and does this on an")
        out("   unsteady connection.")
        out("   FIX: a named tunnel keeps ONE address for good, however often")
        out("   it reconnects. See pi/NAMED_TUNNEL.md, which is worth the")
        out("   twenty minutes precisely because this stops happening.")
        return 1
    out("   serve.py answers here, and nothing comes back through the tunnel.")
    out("   The tunnel is pointed somewhere other than serve.py, or the")
    out("   address just rolled and this one is already dead.")
    out("   FIX: systemctl --user restart gwcfc-tunnel gwcfc-publish")
    return 1


if __name__ == "__main__":
    sys.exit(main())
