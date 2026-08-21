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

# The tunnel's own address, and NOT Cloudflare's.
#
# This used to be `https://[a-z0-9-]+\.trycloudflare\.com`, which is the
# right shape and matches one host too many: cloudflared writes
# "api.trycloudflare.com" into its own log while asking for a tunnel, so the
# newest match in the log was Cloudflare's API endpoint rather than the
# tunnel. That address was published, the site dutifully asked it for the
# Pi's files, and every Pi-backed feature went dark while the Pi sat there
# building everything correctly and serving it on the right port.
#
# A quick tunnel's hostname is words joined by hyphens. api, www and the
# other service names are not that shape and are refused by name as well,
# because being wrong here is invisible: the address looks entirely
# plausible in a log line.
_RESERVED_SUBS = {"api", "www", "dash", "developers", "docs", "blog"}
URL_RE = re.compile(r"https://([a-z0-9][a-z0-9-]*)\.trycloudflare\.com")


def _tunnel_urls(text):
    """Every plausible quick-tunnel address in a log, in order."""
    out = []
    for sub in URL_RE.findall(text):
        if sub in _RESERVED_SUBS:
            continue
        out.append(f"https://{sub}.trycloudflare.com")
    return out


def log(m):
    print(f"[publish] {m}", flush=True)


# Only the first couple of kilobytes of a probe are ever looked at. The
# question is what kind of thing answered, not what it said.
_PROBE_BYTES = 2048


def _cors_ok(headers):
    """Would a browser be allowed to read this answer?

    serve.py puts Access-Control-Allow-Origin on every response it makes,
    which is also the exact permission the site needs, so an address without
    it is useless to the page even when it answers a script perfectly well.
    """
    try:
        return (headers.get("Access-Control-Allow-Origin") or "").strip() == "*"
    except Exception:
        return False


def _looks_like_json(body):
    return body.lstrip()[:1] in (b"{", b"[")


def _looks_like_listing(body):
    # What http.server writes for a directory with no index in it, which is
    # what ~/wxdata is. Present from the very first boot, before a single
    # model has been built.
    return b"Directory listing for" in body


def answers(url, timeout=8):
    """
    Does this address reach the Pi's OWN file server?

    This used to accept any HTTP reply at all, on the reasoning that even a
    404 is a server saying "not that file", which still proves the road goes
    through. It proves a road goes through, to somebody. When the log
    misreading above published api.trycloudflare.com, that host answered the
    probe with a perfectly ordinary 404, this function called the address
    alive, and the one check meant to catch a wrong address confirmed it
    instead. The site was then told to fetch the Pi's files from Cloudflare's
    API, and every Pi-backed feature went dark while the Pi sat there healthy.

    So the answer now has to look like this server rather than merely exist:
    the CORS header the page depends on, plus a body that is either the model
    index really being JSON or the root really being http.server's directory
    listing. Cloudflare's API sends neither of those bodies at these paths.
    """
    base = url.rstrip("/")
    for path, recognise in (("/models/latest.json", _looks_like_json),
                            ("/", _looks_like_listing)):
        try:
            req = urllib.request.Request(base + path, method="GET")
            with urllib.request.urlopen(req, timeout=timeout) as r:
                if (r.status == 200 and _cors_ok(r.headers)
                        and recognise(r.read(_PROBE_BYTES))):
                    return True
        except Exception:
            continue           # try the other door before giving up
    return False


def current_url(path=None):
    """
    The address the tunnel is on now, proven rather than assumed.

    The path is resolved when called rather than defaulted at import, so the
    log location is one thing rather than a copy frozen at load time.

    The log is append-only, so the newest match is USUALLY the live one, and
    that is where this used to stop. A quick tunnel breaks that assumption
    in the worst way: it reconnects on its own and writes another address,
    and a second later the one that was newest a moment ago is dead. Reading
    the last line published a dead address over a working one and the site
    lost the Pi while the tunnel sat there running.

    So the candidates are walked newest first and the first one that
    actually answers is the answer. If none answer, nothing is published,
    because a published address that does not work is worse than leaving
    the previous one alone.
    """
    try:
        with open(path or TUNNEL_LOG, errors="ignore") as f:
            found = _tunnel_urls(f.read())
    except OSError:
        return None
    if not found:
        return None
    # Newest first, without repeats, and only a handful: a long-lived log
    # can hold dozens of retired addresses and none of them are worth a
    # network round trip.
    seen, ordered = set(), []
    for u in reversed(found):
        if u not in seen:
            seen.add(u)
            ordered.append(u)
    for u in ordered[:6]:
        if answers(u):
            if u != ordered[0]:
                log(f"the newest address in the log is dead, using {u}")
            return u
    log("no address in the log answers, so nothing is published")
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


AUTH_FILE = os.path.expanduser("~/.gwcfc_fb_auth.json")


def sign_in():
    """
    The Pi's own account when one is configured, else anonymous.

    Anonymous was the original scheme, and it is the weak half of a hijack:
    ANYBODY can sign in anonymously with the public web key, and rules that
    accept "any signed-in user" therefore accept the whole internet - anyone
    could overwrite the published address and point every visitor's browser
    at a server of their choosing. With ~/.gwcfc_fb_auth.json in place
    ({"email": "...", "password": "..."}, a user created in the Firebase
    console just for the Pi), the write is made as that account, and the
    published rules can then refuse everyone else.
    """
    try:
        with open(AUTH_FILE) as fh:
            c = json.load(fh)
    except (OSError, ValueError):
        c = {}
    if isinstance(c, dict) and c.get("email") and c.get("password"):
        try:
            r = _post(
                "https://identitytoolkit.googleapis.com/v1/"
                f"accounts:signInWithPassword?key={API_KEY}",
                {"email": c["email"], "password": c["password"],
                 "returnSecureToken": True})
            return r["idToken"]
        except urllib.error.HTTPError as e:
            log(f"pi-account sign-in failed ({_detail(e)}), "
                "falling back to anonymous")
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


def usable_from_the_web(url):
    """Why a browser could never load this address, or None if it could.

    The site is served over https from GitHub Pages, and a browser will not
    fetch http from an https page: it refuses before the request is even
    sent. So publishing a plain http address, or one only routable on the
    home network, does not half work - every Pi-backed feature reports the
    Pi as dead while the Pi is perfectly healthy, and the reason is invisible
    from the Pi's side because nothing ever arrives.

    The tunnel is what avoids all of this, which is why an address that is
    not the tunnel's is worth refusing rather than publishing.
    """
    if not url.startswith("https://"):
        return (f"{url} is not https. The site is served over https and "
                "browsers refuse to load http from an https page, so this "
                "address would make the Pi look dead everywhere.")
    host = url.split("://", 1)[1].split("/")[0].split(":")[0].lower()
    private = (host in ("localhost",)
               or host.endswith(".local")
               or host.startswith(("127.", "10.", "192.168.", "169.254."))
               or re.match(r"^172\.(1[6-9]|2\d|3[01])\.", host))
    if private:
        return (f"{url} is a private address on this network. It works from "
                "a device on the same network and from nowhere else.")
    return None


def pinned_url():
    """The fixed address, if one was set and it could actually be used."""
    try:
        with open(PINNED) as f:
            url = f.read().strip() or None
    except OSError:
        return None
    if not url:
        return None
    why = usable_from_the_web(url)
    if why:
        # Refused rather than published. Publishing it would replace a
        # working tunnel address with one that cannot work, and the failure
        # would show up in a browser somewhere else entirely.
        log(f"ignoring the pinned address: {why}")
        log(f"  remove {PINNED} to go back to the tunnel's own address")
        return None
    return url


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
    # Knock on the door, and use the same knock the publisher uses, so this
    # check and the thing it is checking can never disagree. The log is
    # append-only across restarts, so after a reboot with a dead tunnel the
    # last address in it still reads as current, and this once said
    # "match: yes" about an address nothing answered. Agreeing with the
    # database means nothing unless the Pi is what is on the other end.
    alive = answers(url, timeout=20)
    print("  answers        : " + ("yes, the tunnel is alive" if alive else
        "NO. Nothing that looks like this Pi answers there, so the tunnel is "
        "not actually running.\n    FIX: systemctl --user restart "
        "gwcfc-serve gwcfc-tunnel gwcfc-publish"))
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
