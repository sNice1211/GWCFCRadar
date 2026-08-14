#!/usr/bin/env python3
"""
Tells the site where the Pi is, so nobody has to.

A quick tunnel hands out a new address every time it restarts, and the site is
a static page with no way to guess it. The alternative was pasting the address
into the browser console after every reboot, which is a chore and an easy thing
to forget, and leaves the map quietly broken until somebody notices.

So the Pi publishes its own address. It reads the tunnel log, signs in
anonymously the same way the chat bridge does, and writes the address to a
document the page already looks in. Restart the tunnel and the page follows on
its own.

    python3 pi/publish_url.py            # read the log, publish once
    python3 pi/publish_url.py --watch    # keep watching, republish on change

Nothing secret lives here. The Firebase key below is the same one the page
ships to every visitor: it identifies the project, it does not authorise
anything. What may be written is fenced by the rules on the server.
"""

import json
import os
import re
import sys
import time
import urllib.request

PROJECT = "gwcfc-radar"
API_KEY = "AIzaSyAAPuBJFlhBFPhqPGlrNnn_c0NZFRgZTI8"
DOC = "piEndpoint/models"
TUNNEL_LOG = os.path.expanduser("~/tunnel.log")
STATE = os.path.expanduser("~/.gwcfc-published-url")

URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")


def log(m):
    print(f"[publish] {m}", flush=True)


def current_url(path=None):
    """
    The address the tunnel is on now.

    The path is resolved when called rather than defaulted at import, so the
    log location is one thing rather than a copy frozen at load time.

    The log is append-only across restarts, so the last match is the live one
    and every earlier match is an address that no longer answers.
    """
    try:
        with open(path or TUNNEL_LOG, errors="ignore") as f:
            found = URL_RE.findall(f.read())
        return found[-1] if found else None
    except OSError:
        return None


def _post(url, payload):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def sign_in():
    """An anonymous account, which is all a write to this one document needs."""
    r = _post(
        f"https://identitytoolkit.googleapis.com/v1/accounts:signUp?key={API_KEY}",
        {"returnSecureToken": True})
    return r["idToken"]


def publish(url, token):
    """Write the address, replacing whatever was there."""
    api = (f"https://firestore.googleapis.com/v1/projects/{PROJECT}"
           f"/databases/(default)/documents/{DOC}"
           "?updateMask.fieldPaths=url&updateMask.fieldPaths=at")
    body = json.dumps({"fields": {
        "url": {"stringValue": url},
        "at": {"integerValue": str(int(time.time() * 1000))},
    }}).encode()
    req = urllib.request.Request(
        api, data=body, method="PATCH",
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status in (200, 201)


def publish_if_changed(force=False):
    url = current_url()
    if not url:
        log("no address in the tunnel log yet")
        return False
    try:
        with open(STATE) as f:
            if f.read().strip() == url and not force:
                return True            # already published, nothing to do
    except OSError:
        pass
    try:
        ok = publish(url, sign_in())
    except Exception as e:
        log(f"could not publish: {e}")
        return False
    if ok:
        try:
            with open(STATE, "w") as f:
                f.write(url)
        except OSError:
            pass
        log(f"published {url}")
    return ok


def main():
    watch = "--watch" in sys.argv
    if not watch:
        return 0 if publish_if_changed(force="--force" in sys.argv) else 1
    # The tunnel can take a while to come up, and can be restarted underneath
    # us, so this keeps looking rather than checking once and giving up.
    log("watching the tunnel log")
    while True:
        try:
            publish_if_changed()
        except Exception as e:
            log(f"error: {e}")
        time.sleep(60)


if __name__ == "__main__":
    sys.exit(main())
