#!/usr/bin/env python3
"""
The Pi's publishing account, and the refusal to fail quietly about it.

    python3 tools/test-publish-auth.py

On 2026-08-27 gwcfc-publish failed 676 consecutive times over most of a day.
The chain was short and every link behaved as designed:

  - the rules started requiring a real account (isPiPublisher) on 2026-08-26
  - install.sh had never created ~/.gwcfc_fb_auth.json, and still did not
  - so sign_in() found no file, said NOTHING about it, and signed in
    anonymously, which the new rules refuse
  - the refusal logged one line, and the run carried on
  - 676 identical lines later, the only visible symptom was a site serving an
    address that had stopped working

The bug is not really the missing file. It is that a permanent, total failure
was indistinguishable from a passing glitch. So these check the loudness as
carefully as the correctness:

  - a missing account is named BEFORE the write, not only after it is refused
  - a refusal with no account explains how to make one
  - a run of failures is counted and reported as a run, not as N first-times
  - --check says the account is missing, because that is where anyone looks
  - install.sh sets it up rather than leaving it to a comment in a rules file

Executed by loading the module with the network cut off, so nothing here
touches Firebase or needs a Pi.
"""

import io
import json
import os
import sys
import tempfile
import contextlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "pi"))

passed = failed = 0


def ok(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print("  ok   " + name)
    else:
        failed += 1
        print("  FAIL " + name + (("  <" + str(extra) + ">") if extra else ""))


import publish_url as p                                    # noqa: E402

# Nothing in this file may reach the network. Anything that tries is a bug in
# the test, and should say so rather than quietly taking twelve seconds.
def _no_network(*a, **k):
    raise AssertionError("this test must not make a network call")


p._post = _no_network

TMP = tempfile.mkdtemp()
p.AUTH_FILE = os.path.join(TMP, "auth.json")
p.FAIL_STATE = os.path.join(TMP, "failures.json")


def caught(fn, *a, **k):
    """Run something and hand back everything it printed."""
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        try:
            fn(*a, **k)
        except AssertionError:
            raise
        except Exception:
            pass
    return buf.getvalue()


print("\n1. the account file is read, not guessed at")
ok("no file means no credentials", p.auth_creds() is None)

with open(p.AUTH_FILE, "w") as fh:
    fh.write("{ this is not json")
ok("a corrupt file is treated as no account, not as a crash",
   p.auth_creds() is None)

with open(p.AUTH_FILE, "w") as fh:
    json.dump({"email": "pi-publisher@gwcfc-radar.local"}, fh)
ok("an email with no password is not an account", p.auth_creds() is None)

with open(p.AUTH_FILE, "w") as fh:
    json.dump({"email": "pi-publisher@gwcfc-radar.local", "password": "x"}, fh)
c = p.auth_creds()
ok("a complete one is", c and c["email"] == "pi-publisher@gwcfc-radar.local",
   str(c))

os.unlink(p.AUTH_FILE)

print("\n2. a missing account is said out loud BEFORE the write is attempted")
# sign_in() genuinely does reach out for an anonymous token, which is the
# fallback under test, so that one call is stubbed rather than forbidden.
p._post = lambda *a, **k: {"idToken": "anonymous-token"}
out = caught(p.sign_in)
p._post = _no_network
ok("it names the file that does not exist", ".gwcfc_fb_auth.json" in out
   or "auth.json" in out, out.strip()[:160])
ok("it says what will happen: anonymous, which is refused",
   "anonym" in out.lower() and "refuse" in out.lower(), out.strip()[:200])
ok("and it gives the command that fixes it",
   "--set-auth" in out, out.strip()[:200])

print("\n3. a refusal with no account explains how to get one")
out = caught(p._report_failure, 403, "Missing or insufficient permissions")
ok("the refusal itself is reported", "403" in out, out.strip()[:120])
ok("it says the Firebase console, Authentication, Users",
   "Authentication" in out and "Users" in out, out.strip()[:400])
ok("it names the account to create",
   p.DEFAULT_PI_EMAIL in out, out.strip()[:400])
ok("and the command to run afterwards", "--set-auth" in out, out.strip()[:400])

print("\n4. a run of failures is reported as a run")
p._fail_count(reset=True)
first = caught(p._report_failure, 403, "Missing or insufficient permissions")
ok("the first failure does not claim a history",
   "times in a row" not in first, first.strip()[:200])
for _ in range(5):
    later = caught(p._report_failure, 403, "Missing or insufficient permissions")
ok("a later one says how many, so 676 identical lines cannot read as one",
   "6 times in a row" in later, later.strip()[:300])
ok("and says the site is stuck on an older address",
   "published BEFORE" in later or "may have stopped working" in later,
   later.strip()[:300])

print("\n5. the count survives a restart, because the publisher is restarted")
n, since = 0, 0.0
with open(p.FAIL_STATE) as fh:
    d = json.load(fh)
ok("it is written to disk, not held in memory", int(d.get("n", 0)) == 6,
   json.dumps(d))
ok("with a start time, so a run can be described in hours",
   float(d.get("since", 0)) > 0, json.dumps(d))

print("\n6. success clears it, so a fixed Pi stops shouting")
p._fail_count(reset=True)
ok("the record is gone", not os.path.exists(p.FAIL_STATE))
fresh = caught(p._report_failure, 403, "nope")
ok("and the next failure is a first failure again",
   "times in a row" not in fresh, fresh.strip()[:200])

print("\n7. a refusal WITH an account blames the rules, not the file")
with open(p.AUTH_FILE, "w") as fh:
    json.dump({"email": "pi-publisher@gwcfc-radar.local", "password": "x"}, fh)
p._fail_count(reset=True)
out = caught(p._report_failure, 403, "Missing or insufficient permissions")
ok("it points at the rules in the console",
   "FIRESTORE_RULES" in out or "rules refusing" in out, out.strip()[:300])
ok("and does not tell you to create an account you already have",
   "Add user" not in out, out.strip()[:300])
os.unlink(p.AUTH_FILE)

print("\n8. --check reports the account, because that is where people look")
src = open(os.path.join(ROOT, "pi", "publish_url.py"), encoding="utf-8").read()
chk = src[src.index("def check("):src.index("def why(")]
ok("check() looks at the credentials at all", "auth_creds()" in chk)
ok("it says so before the tunnel lines, since every one of those can read "
   "perfectly while this is the thing that is wrong",
   chk.index("auth_creds()") < chk.index("pinned_url()"))
ok("it offers the fix", "--set-auth" in chk)
ok("and it surfaces a run of failures", "consecutive failures" in chk)

print("\n9. --set-auth exists and proves the password before storing it")
ok("the flag is wired up", '"--set-auth" in sys.argv' in src)
sa = src[src.index("def set_auth("):src.index("def sign_in(")]
ok("it signs in with what it was given first",
   "signInWithPassword" in sa, sa[:200])
ok("it only writes the file after that worked",
   sa.index("signInWithPassword") < sa.index("json.dump"))
ok("the file is locked down, because it holds a password in plain text",
   "0o600" in sa)
ok("EMAIL_NOT_FOUND is explained as 'create the user first'",
   "EMAIL_NOT_FOUND" in sa and "Add user" in sa)
ok("and a wrong password explains why no reset email can arrive",
   "INVALID_PASSWORD" in sa and ".local" in sa)

print("\n10. install.sh sets it up rather than leaving it to a comment")
ins = open(os.path.join(ROOT, "pi", "install.sh"), encoding="utf-8").read()
ok("install.sh knows about the account file",
   ".gwcfc_fb_auth.json" in ins)
ok("it runs --set-auth when somebody is at a terminal",
   "--set-auth" in ins and "[ -t 0 ]" in ins)
ok("it warns loudly when nobody is",
   "CANNOT be published" in ins)
ok("and it does this BEFORE starting the publisher, not after",
   ins.index(".gwcfc_fb_auth.json")
   < ins.index("systemctl --user restart gwcfc-publish.service"))

print("\n11. the anonymous fallback is kept, for deployments on the old rules")
si = src[src.index("def sign_in("):src.index("def _fail_count(")]
ok("it still falls back rather than hard-failing", "accounts:signUp" in si)
ok("but never silently: the missing file is logged on the way past",
   "does not exist" in si)

print()
if failed:
    print("%d FAILED, %d passed" % (failed, passed))
    sys.exit(1)
print("all %d passed" % passed)
