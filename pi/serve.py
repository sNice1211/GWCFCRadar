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

Reads are read-only as before. The ONLY writes accepted are two relay doors,
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
        elif path.endswith((".png", "manifest.json")):
            self.send_header("Cache-Control", "public, max-age=21600")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

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
