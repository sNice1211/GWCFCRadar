#!/usr/bin/env python3
"""
Serves the rendered model files with the one header that makes them usable,
and relays the site's chat and feedback posts to Discord.

`python3 -m http.server` is almost enough, but not quite. The page lives on
github.io and the Pi answers on a tunnel, so every read is cross-origin, and a
browser refuses a cross-origin fetch unless the server says it is allowed.
Images are exempt from that rule, so the PNGs would load while latest.json and
manifest.json silently failed: the map would look broken with nothing in the
log to explain it.

    python3 pi/serve.py            # port 8080, serving ~/wxdata
    python3 pi/serve.py 9000 /srv  # or say where

Reads are read-only as before, with two read-side doors:
GET /relay/ambient fetches the owner's Ambient Weather stations with keys kept
on the Pi, and GET /sounding builds one analysed vertical profile through
sounding_service.py (SounderPy to fetch, SHARPpy to compute). Neither writes
anything. The ONLY writes accepted are two relay doors,
POST /relay/chat and POST /relay/feedback, which forward a message to a
Discord webhook. The webhook URLs used to be written INTO the public page,
and to Discord a webhook URL is the entire credential: anyone who reads it
can post anything to the channel, @everyone included, which is exactly the
abuse that happened. Now the URLs live only here, in a file that is NOT
inside the served directory, so no request can read them:

    ~/.gwcfc_webhooks.json      {"chat": "https://discord.com/api/webhooks/...",
                                 "feedback": "https://discord.com/api/webhooks/..."}

The relay also strips @everyone/@here from every string and pins
allowed_mentions to nothing, so even the Pi's own door cannot be used to
mass-ping, and it rate limits per sender.
"""

import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

# Outside the served tree on purpose: a file under ~/wxdata would itself be
# downloadable, which is the exact mistake this relay exists to end.
WEBHOOKS_FILE = os.path.expanduser("~/.gwcfc_webhooks.json")
RELAY_PATHS = {"/relay/chat": "chat", "/relay/feedback": "feedback"}
RELAY_MAX_BYTES = 8192
RELAY_MIN_GAP_S = 2.0

_relay_last = {}  # sender ip -> monotonic time of the last accepted post

# The Ambient Weather account keys, same rule as the webhooks: on the Pi,
# outside the served tree, never in the page or the repo. The upstream
# answer is cached briefly so a whole crowd of visitors with the layer on
# costs one call against AWN's one-request-per-second allowance.
#     ~/.gwcfc_ambient.json    {"apiKey": "...", "applicationKey": "..."}
AMBIENT_FILE = os.path.expanduser("~/.gwcfc_ambient.json")
AMBIENT_CACHE_S = 30.0
_ambient_cache = {"at": -AMBIENT_CACHE_S, "body": None}

# GET /sounding is the one door that makes the Pi do real work: SounderPy
# downloads a model file and SHARPpy chews through every level of it, which on
# a Pi 4 is seconds, not milliseconds. So it gets a queue of its own.
#
# Two at a time, because a third would just make all three slow. Everyone else
# waits a little and is then told to try again, which is a better answer than a
# request that hangs until the browser gives up on it.
SOUNDING_WORKERS = int(os.environ.get("GWCFC_SND_WORKERS", "2"))
SOUNDING_QUEUE_WAIT_S = 25.0
_sounding_gate = threading.Semaphore(SOUNDING_WORKERS)

# sounding_service.py lives beside this file. Python already puts a script's
# own directory on the path, but a systemd unit can be started in ways that do
# not, and "no soundings" is a confusing symptom for a path problem.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)


def ambient_upstream():
    """The real AWN endpoint, or a loopback stand-in for the test suite."""
    if (os.environ.get("GWCFC_RELAY_ALLOW_LOCAL") == "1"
            and os.environ.get("GWCFC_AMBIENT_URL", "").startswith("http://127.0.0.1:")):
        return os.environ["GWCFC_AMBIENT_URL"]
    return "https://api.ambientweather.net/v1/devices"


def load_webhooks():
    """Read on every post, so a new webhook works without a restart."""
    try:
        with open(WEBHOOKS_FILE) as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def sanitize_text(s):
    """
    No relayed text may ping the whole server or carry a working server
    invite, whatever it says. A zero-width space keeps the words readable
    while making them inert: Discord no longer parses the ping, and an
    invite link with one in the middle does not resolve.
    """
    s = s.replace("@everyone", "@\u200beveryone").replace("@here", "@\u200bhere")
    s = re.sub(r"(?i)(discord(?:app)?\.(?:gg|com/invite))/", "\\1/\u200b", s)
    return s


def shape_payload(kind, payload):
    """
    The message is REBUILT from scratch out of the few fields the site
    actually sends, never forwarded as-is. Whatever else a caller stuffs
    into the JSON (embed images, urls, author spoofing, extra embeds) simply
    does not exist on the other side. Returns None when there is nothing
    worth relaying.
    """
    if kind == "chat":
        name = sanitize_text(str(payload.get("username", "")))[:80].strip() or "Radar user"
        content = sanitize_text(str(payload.get("content", "")))[:1900].strip()
        if not content:
            return None
        return {"username": name, "content": content}

    # feedback: exactly one embed with a known shape
    embeds = payload.get("embeds")
    e = embeds[0] if isinstance(embeds, list) and embeds and isinstance(embeds[0], dict) else None
    if not e:
        return None
    desc = sanitize_text(str(e.get("description", "")))[:1500].strip()
    if not desc:
        return None
    out = {"title": sanitize_text(str(e.get("title", "Feedback")))[:120],
           "description": desc}
    color = e.get("color")
    if isinstance(color, int) and 0 <= color <= 0xFFFFFF:
        out["color"] = color
    fields = e.get("fields")
    if isinstance(fields, list) and fields and isinstance(fields[0], dict):
        val = sanitize_text(str(fields[0].get("value", "")))[:200].strip()
        if val:
            out["fields"] = [{"name": "Contact", "value": val, "inline": True}]
    ts = e.get("timestamp")
    if isinstance(ts, str) and len(ts) < 40:
        out["timestamp"] = ts
    return {"embeds": [out]}


class CORSHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # The whole point of this file.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
        # The relay takes JSON, and a JSON POST from a page triggers a CORS
        # preflight that asks about this exact header.
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        # A finished run never changes, so let it cache. latest.json is the one
        # thing that does change, and it is the one thing that must not be
        # cached, or a new run would go unnoticed until the browser felt like
        # asking again.
        path = self.path.split("?")[0]
        if path.endswith("latest.json"):
            self.send_header("Cache-Control", "no-cache, must-revalidate")
        elif path == "/sounding":
            # An analysis is hourly, so five minutes of browser cache costs
            # nothing in freshness and saves the Pi a rebuild every time
            # somebody closes the panel and opens it again.
            self.send_header("Cache-Control", "public, max-age=300")
        elif path.endswith((".png", "manifest.json")):
            self.send_header("Cache-Control", "public, max-age=21600")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    # Two read-side doors; every other GET is plain file serving.
    def do_GET(self):
        head = self.path.split("?")[0]
        if head == "/relay/ambient":
            self._relay_ambient()
            return
        if head == "/sounding":
            self._sounding()
            return
        super().do_GET()

    def _sounding(self):
        """GET /sounding?lat=&lon=&source=&when= -> one analysed profile.

        The page can already draw a sounding from the Pi's pressure-level
        images without this door, so every failure here answers with a
        readable reason and the page quietly falls back. A 500 with a stack
        trace in it would be worse than useless: nobody reading the map can
        act on one.
        """
        from urllib.parse import parse_qs, urlparse
        q = parse_qs(urlparse(self.path).query)

        def one(name, default=""):
            v = q.get(name, [default])
            return (v[0] if v else default).strip()

        try:
            lat = float(one("lat"))
            lon = float(one("lon"))
        except ValueError:
            self._reply_json(400, {"error": "lat and lon are required, as numbers"})
            return
        if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
            self._reply_json(400, {"error": f"{lat}, {lon} is not a place on Earth"})
            return

        try:
            import sounding_service as snd
        except Exception as e:
            self._reply_json(501, {"error": "the sounding service is not installed "
                                            f"beside serve.py ({e})"})
            return

        source = one("source", "rap") or "rap"
        if source not in snd.SOURCES:
            self._reply_json(400, {"error": f"unknown source {source!r}",
                                   "sources": sorted(snd.SOURCES)})
            return
        when = one("when") or None
        if when and not (len(when) == 10 and when.isdigit()):
            self._reply_json(400, {"error": "when must be YYYYMMDDHH in UTC"})
            return

        # A cache hit costs a file read, so it skips the queue entirely. That
        # is what makes clicking around the same storm feel instant even while
        # somebody else's fetch is running.
        key = snd._cache_key(source, lat, lon, when)
        hit = snd._cache_read(key)
        if hit:
            hit["cached"] = True
            self._reply_json(200, hit)
            return

        if not _sounding_gate.acquire(timeout=SOUNDING_QUEUE_WAIT_S):
            self._reply_json(503, {"error": "the Pi is already working on other "
                                            "soundings. Try again in a moment.",
                                   "retry": True})
            return
        try:
            out = snd.sounding(source, lat, lon, when)
        except RuntimeError as e:
            # The expected failures: library missing, hour not published yet,
            # too few levels. All of them are sentences a person can read.
            self._reply_json(502, {"error": str(e)})
            return
        except Exception as e:
            self._reply_json(502, {"error": "the sounding could not be built: "
                                            f"{e.__class__.__name__}"})
            return
        finally:
            _sounding_gate.release()
        self._reply_json(200, out)

    def _relay_ambient(self):
        now = time.monotonic()
        if _ambient_cache["body"] is not None and now - _ambient_cache["at"] < AMBIENT_CACHE_S:
            self._reply_raw(200, _ambient_cache["body"])
            return
        try:
            with open(AMBIENT_FILE) as fh:
                c = json.load(fh)
        except (OSError, ValueError):
            c = {}
        api = c.get("apiKey") if isinstance(c, dict) else None
        app = c.get("applicationKey") if isinstance(c, dict) else None
        if not api or not app:
            self._reply_json(503, {"error": "ambient relay not configured on the "
                                            "Pi. Put the keys in ~/.gwcfc_ambient.json"})
            return
        from urllib.parse import quote
        url = (f"{ambient_upstream()}?applicationKey={quote(str(app))}"
               f"&apiKey={quote(str(api))}")
        req = urllib.request.Request(url, headers={"User-Agent": "gwcfc-relay"})
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                body = r.read(1024 * 1024)
        except urllib.error.HTTPError as e:
            # 429 passes through so the page can say "rate limited" honestly;
            # anything else is summarized rather than parroted.
            code = 429 if e.code == 429 else 502
            self._reply_json(code, {"error": f"Ambient Weather answered HTTP {e.code}"})
            return
        except Exception:
            self._reply_json(502, {"error": "could not reach Ambient Weather"})
            return
        _ambient_cache["at"] = now
        _ambient_cache["body"] = body
        self._reply_raw(200, body)

    def _reply_raw(self, code, body):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except OSError:
            pass

    def _reply_json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except OSError:
            pass

    # The two relay doors are the only POSTs answered; everything else that
    # could change the Pi is refused, since this is reachable from the public
    # internet.
    def do_POST(self):
        kind = RELAY_PATHS.get(self.path.split("?")[0])
        if not kind:
            self.send_error(405)
            return

        url = load_webhooks().get(kind)
        # Only a real Discord webhook is ever forwarded to. The loopback
        # allowance exists solely for the test suite, which stands up a fake
        # webhook on 127.0.0.1, and it must be asked for explicitly.
        ok_target = isinstance(url, str) and (
            url.startswith("https://discord.com/api/webhooks/")
            or (os.environ.get("GWCFC_RELAY_ALLOW_LOCAL") == "1"
                and url.startswith("http://127.0.0.1:")))
        if not ok_target:
            self._reply_json(503, {"error": "relay not configured on the Pi. "
                                            "Put the webhook URL in ~/.gwcfc_webhooks.json"})
            return

        # Behind the tunnel every connection is local, so the sender is the
        # forwarded address when the tunnel provides one.
        ip = self.headers.get("CF-Connecting-IP") \
            or self.headers.get("X-Forwarded-For", "").split(",")[0].strip() \
            or self.client_address[0]
        now = time.monotonic()
        if now - _relay_last.get(ip, -RELAY_MIN_GAP_S) < RELAY_MIN_GAP_S:
            self._reply_json(429, {"error": "slow down a moment"})
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > RELAY_MAX_BYTES:
            self._reply_json(413, {"error": "message too large"})
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("not an object")
        except (ValueError, UnicodeDecodeError):
            self._reply_json(400, {"error": "bad JSON"})
            return

        payload = shape_payload(kind, payload)
        if payload is None:
            self._reply_json(400, {"error": "nothing to relay"})
            return
        # Belt and braces: sanitize_text defangs the words, this tells
        # Discord to ping nobody regardless of what slipped through.
        payload["allowed_mentions"] = {"parse": []}

        req = urllib.request.Request(
            url, data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json",
                     "User-Agent": "gwcfc-relay"},
            method="POST")
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                code = r.status
        except urllib.error.HTTPError as e:
            code = e.code
        except Exception:
            self._reply_json(502, {"error": "could not reach Discord"})
            return

        _relay_last[ip] = now
        ok = 200 <= code < 300
        self._reply_json(200 if ok else 502, {"ok": ok, "discord": code})

    def do_PUT(self): self.send_error(405)
    def do_DELETE(self): self.send_error(405)

    def log_message(self, fmt, *args):
        # One line per request is noise when a page pulls 40 frames.
        if not str(args[1] if len(args) > 1 else "").startswith("2"):
            super().log_message(fmt, *args)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    root = sys.argv[2] if len(sys.argv) > 2 else os.path.expanduser("~/wxdata")
    if not os.path.isdir(root):
        print(f"no such directory: {root}")
        return 1
    handler = partial(CORSHandler, directory=root)
    srv = ThreadingHTTPServer(("127.0.0.1", port), handler)
    print(f"serving {root} on 127.0.0.1:{port} with CORS enabled")
    print("point the tunnel at this, not at python -m http.server")
    if not load_webhooks():
        print("note: no ~/.gwcfc_webhooks.json yet, so the chat/feedback relay "
              "answers 503 until you create it")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
