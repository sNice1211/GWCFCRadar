#!/usr/bin/env python3
"""
The Pi's Discord relay, end to end, against a fake webhook.

    python3 tools/test-relay.py

Stands up pi/serve.py on a loopback port with HOME pointed at a scratch
directory, and a second tiny server playing the part of Discord's webhook
endpoint. Then it knocks the way friend and foe both would, and checks that:

  - an unconfigured relay answers 503, and a POST anywhere else 405
  - a legitimate chat post arrives at the "webhook" rebuilt and clean
  - @everyone, @here and discord.gg invite links are neutered in transit
  - attacker-supplied embeds on the chat path simply do not come out
  - allowed_mentions is pinned to nothing on every forwarded message
  - a second post inside the rate window answers 429
  - an oversized body answers 413 and junk answers 400
  - the webhook URLs themselves can never be read through the server,
    because the file lives outside the served directory

This is the suite that makes "the webhook can never be abused like that
again" a checked fact instead of a hope.
"""

import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVE = os.path.join(ROOT, "pi", "serve.py")

passed = failed = 0


def ok(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name}  <{extra}>")


received = []
ambient_hits = []


class FakeDiscord(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        received.append(json.loads(self.rfile.read(length).decode()))
        body = b'{"id":"1"}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # Doubles as the fake Ambient Weather endpoint for the /relay/ambient
    # scenes: it records the query string (which is where the keys travel)
    # and answers with one station.
    def do_GET(self):
        ambient_hits.append(self.path)
        body = json.dumps([{
            "info": {"name": "Test Station",
                     "coords": {"coords": {"lat": 35.0, "lon": -97.0}}},
            "lastData": {"tempf": 72, "dateutc": 1700000000000},
        }]).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def post(port, path, payload, raw=None):
    data = raw if raw is not None else json.dumps(payload).encode()
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", data=data,
        headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.load(e)
        except Exception:
            return e.code, {}


def get(port, path):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=10) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, b""


def get_json(port, path):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=10) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.load(e)
        except Exception:
            return e.code, {}


def main():
    home = tempfile.mkdtemp(prefix="relay-home-")
    wxdata = os.path.join(home, "wxdata")
    os.makedirs(wxdata)
    with open(os.path.join(wxdata, "hello.txt"), "w") as f:
        f.write("served")

    fake = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeDiscord)
    fake_port = fake.server_address[1]
    threading.Thread(target=fake.serve_forever, daemon=True).start()

    env = {**os.environ, "HOME": home, "GWCFC_RELAY_ALLOW_LOCAL": "1",
           "GWCFC_AMBIENT_URL": f"http://127.0.0.1:{fake_port}/ambient"}
    port = 18321
    srv = subprocess.Popen([sys.executable, SERVE, str(port), wxdata],
                           env=env, stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT)
    try:
        for _ in range(50):
            time.sleep(0.1)
            try:
                if get(port, "/hello.txt")[0] == 200:
                    break
            except Exception:
                pass
        else:
            print("serve.py never came up")
            return 1

        print("\n1. the doors that must stay shut")
        ok("files still serve", get(port, "/hello.txt")[1] == b"served")
        code, _ = post(port, "/anything", {"x": 1})
        ok("a POST anywhere but the relay is refused", code == 405, str(code))
        code, body = post(port, "/relay/chat", {"content": "hi"})
        ok("an unconfigured relay says so with 503", code == 503, str(code))
        code, _ = get(port, "/../.gwcfc_webhooks.json")
        ok("the webhook file cannot be read through the server",
           code in (301, 400, 404), str(code))

        with open(os.path.join(home, ".gwcfc_webhooks.json"), "w") as f:
            json.dump({"chat": f"http://127.0.0.1:{fake_port}/hook/chat",
                       "feedback": f"http://127.0.0.1:{fake_port}/hook/fb"}, f)

        print("\n2. a real message goes through, rebuilt and clean")
        code, body = post(port, "/relay/chat", {
            "username": "Ralph (radar)",
            "content": "storms firing @everyone join discord.gg/insanityz now @here",
            "embeds": [{"title": "spam", "image": {"url": "http://evil"}}],
            "avatar_url": "http://evil/av.png",
        })
        ok("the relay answers ok", code == 200 and body.get("ok") is True, f"{code} {body}")
        m = received[-1] if received else {}
        ok("the message arrived at the webhook", m.get("username") == "Ralph (radar)", str(m))
        ok("@everyone and @here are neutered",
           "@everyone" not in m.get("content", "") and "@here" not in m.get("content", ""),
           m.get("content", ""))
        ok("the invite link is broken in transit",
           "discord.gg/i" not in m.get("content", ""), m.get("content", ""))
        ok("attacker embeds do not exist on the other side", "embeds" not in m, str(m.keys()))
        ok("avatar spoofing does not exist on the other side", "avatar_url" not in m, str(m.keys()))
        ok("Discord is told to ping nobody, regardless",
           m.get("allowed_mentions") == {"parse": []}, str(m.get("allowed_mentions")))

        print("\n3. the brakes")
        code, _ = post(port, "/relay/chat", {"content": "again immediately"})
        ok("a second post inside the rate window answers 429", code == 429, str(code))
        time.sleep(2.1)
        code, _ = post(port, "/relay/chat", {"content": ""})
        ok("an empty message is refused", code == 400, str(code))
        code, _ = post(port, "/relay/chat", {}, raw=b"x" * 9000)
        ok("an oversized body answers 413", code == 413, str(code))
        code, _ = post(port, "/relay/chat", {}, raw=b"not json{{")
        ok("junk answers 400", code == 400, str(code))

        print("\n4. feedback keeps its shape and nothing else")
        time.sleep(2.1)
        code, body = post(port, "/relay/feedback", {"embeds": [{
            "title": "Bug - GWCFC Radar Feedback",
            "description": "the map @everyone discord.gg/spam",
            "color": 15158332,
            "fields": [{"name": "Contact", "value": "me@example.com"}],
            "image": {"url": "http://evil"},
            "url": "http://evil",
        }]})
        ok("feedback relays", code == 200 and body.get("ok") is True, f"{code} {body}")
        e = (received[-1].get("embeds") or [{}])[0]
        ok("the embed keeps title, text, color and contact",
           e.get("title", "").startswith("Bug") and e.get("color") == 15158332
           and e.get("fields", [{}])[0].get("value") == "me@example.com",
           str(e))
        ok("its text is neutered too",
           "@everyone" not in e.get("description", "")
           and "discord.gg/s" not in e.get("description", ""), e.get("description", ""))
        ok("embed images and links do not survive",
           "image" not in e and "url" not in e, str(e.keys()))

        print("\n5. the ambient door: keys stay home, answers get cached")
        code, body = get_json(port, "/relay/ambient")
        ok("unconfigured ambient relay says so with 503", code == 503, str(code))
        with open(os.path.join(home, ".gwcfc_ambient.json"), "w") as f:
            json.dump({"apiKey": "AAA", "applicationKey": "BBB"}, f)
        code, body = get_json(port, "/relay/ambient")
        ok("configured, it answers with the stations", code == 200
           and isinstance(body, list) and body[0].get("info", {}).get("name") == "Test Station",
           f"{code} {str(body)[:80]}")
        hits_before = len(ambient_hits)
        get_json(port, "/relay/ambient")
        get_json(port, "/relay/ambient")
        ok("repeat asks are served from the cache, one upstream call total",
           len(ambient_hits) == hits_before, f"{len(ambient_hits)} vs {hits_before}")
        q = ambient_hits[-1]
        ok("the keys travelled Pi-to-AWN only, never to the page",
           "apiKey=AAA" in q and "applicationKey=BBB" in q, q)

        print()
        print(f"{failed} FAILED, {passed} passed" if failed else f"all {passed} passed")
        return 1 if failed else 0
    finally:
        srv.terminate()
        fake.shutdown()
        shutil.rmtree(home, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
