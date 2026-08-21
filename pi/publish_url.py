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

# Who we say we are, and it matters more than it looks.
#
# urllib introduces itself as "Python-urllib/3.11" unless told otherwise, and
# Cloudflare treats a bare scripting agent very differently from a browser:
# a burst of requests from one gets challenged or refused. diagnose.sh, which
# uses curl, could read the tunnel perfectly while this file was being told
# no, and the difference between those two was never the tunnel.
_UA = "gwcfc-pi/1.0 (+https://ralphhtml.github.io/GWCFCRadar/)"

# The last thing a probe saw, so a failure can be described rather than just
# counted. Nothing depends on it; it exists to be printed.
last_probe = ""


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


def _probe(url, path, timeout):
    """(status, headers, body) from one knock, or None if nothing answered.

    An error status is still an answer and is still worth reading: what
    matters is WHO sent it, and the difference between "Cloudflare says it
    cannot reach your tunnel" and "nothing is listening at all" lives in
    exactly that distinction.
    """
    global last_probe
    # A cache buster, because something between here and the Pi does hold on
    # to answers: diagnose.sh proves it by fetching the same file twice, once
    # plain and once busted, and getting two different files. Without this, a
    # single unlucky error could be handed back for as long as it was cached,
    # and the address would read as dead long after it came back.
    sep = "&" if "?" in path else "?"
    full = f"{url.rstrip('/')}{path}{sep}_={int(time.time())}"
    try:
        req = urllib.request.Request(
            full, method="GET",
            headers={"User-Agent": _UA, "Cache-Control": "no-cache"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            last_probe = f"{path} -> HTTP {r.status}"
            return r.status, r.headers, r.read(_PROBE_BYTES)
    except urllib.error.HTTPError as e:
        try:
            body = e.read(_PROBE_BYTES)
        except Exception:
            body = b""
        last_probe = f"{path} -> HTTP {e.code}"
        return e.code, e.headers, body
    except Exception as e:
        last_probe = f"{path} -> {e.__class__.__name__}: {e}"
        return None


def answers(url, timeout=5):
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

    So the answer has to look like this server rather than merely exist. Two
    doors, and only one of them has to open:

      - the root really being the directory listing http.server writes. That
        string is unmistakable and is there from the very first boot, before
        a single model has been built, so it is asked first and on its own.
      - the model index really being JSON, for the case where something has
        put an index.html in the served directory and there is no listing to
        read. That one also wants the CORS header, because JSON alone is a
        much weaker signature than the listing text.

    The CORS header is deliberately NOT required of the first door. It is the
    permission the browser needs and serve.py always sends it, but requiring
    it of the strongest signature would mean any proxy that dropped the header
    could make a perfectly good address look dead, and this function refusing
    a good address is just as bad as it accepting a wrong one.
    """
    got = _probe(url, "/", timeout)
    if got and got[0] == 200 and _looks_like_listing(got[2]):
        return True
    got = _probe(url, "/models/latest.json", timeout)
    if got and got[0] == 200 and _looks_like_json(got[2]) and _cors_ok(got[1]):
        return True
    return False


def candidates(path=None):
    """Every address worth knocking on, newest first, without repeats.

    The path is resolved when called rather than defaulted at import, so the
    log location is one thing rather than a copy frozen at load time.

    Only a handful. The unit appends to this log and never truncates it, so
    after a few months it holds dozens of retired addresses, and none of them
    are worth a network round trip.
    """
    try:
        with open(path or TUNNEL_LOG, errors="ignore") as f:
            found = _tunnel_urls(f.read())
    except OSError:
        return []
    seen, ordered = set(), []
    for u in reversed(found):
        if u not in seen:
            seen.add(u)
            ordered.append(u)
    return ordered[:4]


def log_tail(n=6, path=None):
    """The tunnel's own last words, for when nothing it said worked."""
    try:
        with open(path or TUNNEL_LOG, errors="ignore") as f:
            lines = [ln.rstrip() for ln in f.read().splitlines() if ln.strip()]
    except OSError:
        return []
    return lines[-n:]


def current_url(path=None, patience=0):
    """
    The address the tunnel is on now, proven rather than assumed.

    The log is append-only, so the newest match is USUALLY the live one, and
    that is where this used to stop. A quick tunnel breaks that assumption in
    the worst way: it reconnects on its own and writes another address, and a
    second later the one that was newest a moment ago is dead. Reading the
    last line published a dead address over a working one and the site lost
    the Pi while the tunnel sat there running.

    So the candidates are walked newest first and the first one that actually
    answers is the answer. If none answer, nothing is published, because a
    published address that does not work is worse than leaving the previous
    one alone.

    And then it waits, which is the part that is easy to leave out.

    A quick tunnel is not usable the instant cloudflared prints its address.
    The name has to reach the edge first, and for those few seconds the
    address is real, correct, and answers with an error. The old check
    accepted any reply at all, so it never noticed; tightening it turned that
    same window into "nothing answers, publishing nothing", which is a
    healthy tunnel refused for being young. Both are wrong. So it is asked
    again, for as long as the caller is willing to wait, re-reading the log
    each time because the address may not even have been written yet.
    """
    deadline = time.monotonic() + max(0, patience)
    said = False
    seen_any = 0
    first_pass = True
    while True:
        ordered = candidates(path)
        seen_any = max(seen_any, len(ordered))
        # Every retired address gets one chance, and after that only the
        # newest is asked again. Knocking on four dead addresses every five
        # seconds is dozens of requests a minute at an edge that answers a
        # burst from a script by refusing it, so the retries were making the
        # very failure they were retrying.
        ask = ordered if first_pass else ordered[:1]
        first_pass = False
        for u in ask:
            if answers(u):
                if ordered and u != ordered[0]:
                    log(f"the newest address in the log is dead, using {u}")
                return u
        if time.monotonic() >= deadline:
            break
        if not said:
            log("nothing answers yet. A tunnel that has just started takes a "
                "moment to become routable, so this waits rather than "
                "publishing nothing.")
            said = True
        time.sleep(5)
    if not seen_any:
        log(f"no tunnel address has been written to {path or TUNNEL_LOG} yet")
    else:
        log(f"none of the {seen_any} newest addresses in the log answer, "
            "so nothing is published")
        log(f"  the last thing tried said: {last_probe or 'nothing at all'}")
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


def publish_if_changed(force=False, patience=0):
    url = pinned_url() or current_url(patience=patience)
    if not url:
        return False           # current_url already said why, specifically
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


def check(patience=45):
    """Report where things stand, in words, without changing anything.

    Patient by default, because the commonest moment to run this is right
    after restarting the tunnel, and a tunnel that has just started is not
    routable for a few seconds. Reporting a failure then is reporting
    impatience.
    """
    pin = pinned_url()
    # Whether this address was PROVEN alive a moment ago, rather than merely
    # read out of a file. It changes what a failure below means, and the two
    # meanings are miles apart.
    proven = False
    if pin:
        url = pin
    else:
        url = current_url(patience=patience)
        proven = url is not None
    if not url:
        # Two very different faults, and the old wording said the first about
        # both of them: "NONE FOUND in ~/tunnel.log" is simply untrue when
        # the log is full of addresses that no longer answer.
        found = candidates()
        if found:
            print("  tunnel address : none that answer. The newest in the log is")
            print(f"                   {found[0]}")
            print("    That address is in the log but nothing is behind it, so the")
            print("    tunnel is not running even though the log remembers it.")
        else:
            print(f"  tunnel address : none has been written to {TUNNEL_LOG}")
            print("    cloudflared has not printed one, so it is not connecting.")
        tail = log_tail(6)
        if tail:
            print("    the tunnel's own last words:")
            for line in tail:
                print(f"      {line[:150]}")
        print("    FIX: systemctl --user restart gwcfc-tunnel gwcfc-publish")
        return 1
    src = 'pinned' if pin else 'from the log'
    print(f"  tunnel address : {url} ({src})")
    # Knock on the door, and use the same knock the publisher uses, so this
    # check and the thing it is checking can never disagree. The log is
    # append-only across restarts, so after a reboot with a dead tunnel the
    # last address in it still reads as current, and this once said
    # "match: yes" about an address nothing answered. Agreeing with the
    # database means nothing unless the Pi is what is on the other end.
    # An address that came from the log has ALREADY been proved alive, two
    # lines ago, by the only thing that can prove it. Asking a second time
    # was not a check, it was another request at an edge that dislikes a
    # burst of them, and when that second one was refused this printed "the
    # tunnel is not actually running" straight over the top of its own
    # evidence. A pinned address has had no such proof and still needs one.
    alive = True if proven else answers(url, timeout=10)
    if alive:
        print("  answers        : yes, the tunnel is alive")
    else:
        print("  answers        : NO. Nothing that looks like this Pi answers")
        print(f"    there. The last try said: {last_probe or 'nothing at all'}")
        print("    FIX: systemctl --user restart gwcfc-serve gwcfc-tunnel "
              "gwcfc-publish")
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


def why():
    """What every address in the log actually returns, one line each.

    check() answers yes or no, and a no has been wrong twice now for reasons
    a yes-or-no cannot express: an edge that refuses a burst of requests, a
    cached error, a name that is not routable yet. All three read as "dead".
    This asks each door of each address once, slowly, and prints what came
    back, so the next argument about it is settled by evidence.
    """
    found = candidates()
    if not found:
        print(f"no tunnel address in {TUNNEL_LOG} at all")
        return 1
    print(f"{len(found)} address(es) in the log, newest first:")
    for u in found:
        print(f"\n  {u}")
        for path in ("/", "/models/latest.json"):
            got = _probe(u, path, 10)
            if not got:
                print(f"    {path:22} {last_probe.split(' -> ', 1)[-1]}")
                continue
            status, headers, body = got
            cors = (headers.get("Access-Control-Allow-Origin") or "").strip()
            via = " via Cloudflare" if headers.get("cf-ray") else ""
            peek = body.decode(errors="ignore").strip().replace("\n", " ")[:52]
            print(f"    {path:22} HTTP {status}{via}"
                  f"{'  browser-readable' if cors == '*' else ''}  {peek!r}")
            time.sleep(1)          # gently, for the same reason as above
        print(f"    {'verdict':22} "
              + ("this is the Pi" if answers(u, timeout=10)
                 else "not recognised as the Pi"))
    return 0


def main():
    if "--why" in sys.argv:
        return why()
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
        # A one-shot run gets one chance, so it is the one that most needs to
        # wait for a tunnel that is still coming up.
        return 0 if publish_if_changed(force="--force" in sys.argv,
                                       patience=60) else 1
    # The tunnel can take a while to come up, and can be restarted underneath
    # us, so this keeps looking rather than checking once and giving up. No
    # patience is needed inside a single pass here: the loop below IS the
    # patience, and a pass that waits would only delay noticing a restart.
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
