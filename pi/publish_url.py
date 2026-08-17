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
import urllib.error
import urllib.request

PROJECT = "gwcfc-radar"
API_KEY = "AIzaSyAAPuBJFlhBFPhqPGlrNnn_c0NZFRgZTI8"
DOC = "piEndpoint/models"
TUNNEL_LOG = os.path.expanduser("~/tunnel.log")
STATE = os.path.expanduser("~/.gwcfc-published-url")
# Written by --set, which is what the named tunnel uses. Its presence means the
# address is fixed and must not be worked out from a log again.
#
# Without this the two halves fight each other. The quick tunnel appends its
# address to ~/tunnel.log, the log is never truncated, and --watch takes the
# last match in it. So a minute after switching to a permanent address, the
# watcher would find the old trycloudflare line still sitting in that file and
# publish it back over the good one, and the site would go to an address that
# stopped answering when the quick tunnel did.
PINNED = os.path.expanduser("~/.gwcfc-pinned-url")

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


def _detail(e):
    """
    What the server actually said.

    urllib raises HTTPError with the body unread, so an authorisation failure
    arrives as a bare "HTTP Error 403: Forbidden" with the reason still sitting
    in the response. Firestore puts something specific there, and it is the
    difference between "the rules are not published" and "the network is down".
    """
    try:
        body = e.read().decode(errors="ignore")[:400]
        msg = json.loads(body).get("error", {}).get("message", "")
        return msg or body
    except Exception:
        return str(e)


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


def pinned_url():
    """The fixed address, if one was set, else None."""
    try:
        with open(PINNED) as f:
            return f.read().strip() or None
    except OSError:
        return None


def publish_if_changed(force=False):
    url = pinned_url() or current_url()
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
    except urllib.error.HTTPError as e:
        detail = _detail(e)
        log(f"could not publish: HTTP {e.code}: {detail}")
        if e.code in (401, 403):
            log("  that is the rules refusing the write. Publish the piEndpoint")
            log("  block from firebase/FIRESTORE_RULES.txt in the console.")
        elif e.code == 400 and "CONFIGURATION_NOT_FOUND" in detail:
            log("  anonymous sign-in is switched off for this project. Turn it")
            log("  on under Authentication, Sign-in method, Anonymous.")
        return False
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


def check():
    """Report where things stand, in words, without changing anything."""
    url = pinned_url() or current_url()
    src = 'pinned' if pinned_url() else 'from the log'
    print(f"  tunnel address : {url + ' (' + src + ')' if url else 'NONE FOUND in ' + TUNNEL_LOG}")
    if not url:
        print("    the tunnel may still be starting. systemctl --user status gwcfc-tunnel")
        return 1
    # Knock on the door. The log is append-only across restarts, so after a
    # reboot with a dead tunnel the last address in it still reads as current,
    # and this check once said "match: yes" about an address nothing answered.
    # Agreeing with the database means nothing unless the address is alive.
    alive = False
    try:
        with urllib.request.urlopen(url + "/models/latest.json", timeout=20) as r:
            alive = r.status == 200
    except Exception:
        pass
    print("  answers        : " + ("yes, the tunnel is alive" if alive else
        "NO. The address does not answer, so the tunnel is not actually "
        "running.\n    FIX: systemctl --user restart gwcfc-tunnel gwcfc-publish"))
    try:
        with urllib.request.urlopen(
                f"https://firestore.googleapis.com/v1/projects/{PROJECT}"
                f"/databases/(default)/documents/{DOC}", timeout=30) as r:
            doc = json.load(r)
        have = doc.get("fields", {}).get("url", {}).get("stringValue", "")
        print(f"  site is told   : {have or '(nothing)'}")
        good = have == url and alive
        print("  match          : " + ("yes, the site can find the Pi"
                                       if good else
                                       "NO, the site is pointed somewhere else"
                                       if have != url else
                                       "the addresses agree but nothing answers there"))
        return 0 if good else 1
    except urllib.error.HTTPError as e:
        print(f"  could not read it back: HTTP {e.code}: {_detail(e)}")
        return 1
    except Exception as e:
        print(f"  could not read it back: {e}")
        return 1


def main():
    if "--check" in sys.argv:
        return check()
    # A named tunnel never changes, so its address is given once rather than
    # read out of a log that only a quick tunnel writes.
    if "--set" in sys.argv:
        i = sys.argv.index("--set")
        if i + 1 >= len(sys.argv):
            log("--set needs the address, e.g. --set https://pi.example.com")
            return 1
        url = sys.argv[i + 1].rstrip("/")
        try:
            ok = publish(url, sign_in())
        except urllib.error.HTTPError as e:
            log(f"could not publish: HTTP {e.code}: {_detail(e)}")
            return 1
        except Exception as e:
            log(f"could not publish: {e}")
            return 1
        if ok:
            for path in (STATE, PINNED):
                try:
                    with open(path, "w") as f:
                        f.write(url)
                except OSError:
                    pass
            log(f"published {url}")
            log("pinned, so --watch will stop reading the tunnel log")
        return 0 if ok else 1
    if "--unpin" in sys.argv:
        # Going back to a quick tunnel, which is the only reason to do this.
        try:
            os.unlink(PINNED)
            log("unpinned, the address will be read from the log again")
        except OSError:
            log("was not pinned")
        return 0
    watch = "--watch" in sys.argv
    if not watch:
        return 0 if publish_if_changed(force="--force" in sys.argv) else 1
    # The tunnel can take a while to come up, and can be restarted underneath
    # us, so this keeps looking rather than checking once and giving up.
    fixed = pinned_url()
    log(f"address is pinned to {fixed}, republishing only if it is lost"
        if fixed else "watching the tunnel log")
    while True:
        try:
            publish_if_changed()
        except Exception as e:
            log(f"error: {e}")
        time.sleep(60)


if __name__ == "__main__":
    sys.exit(main())
