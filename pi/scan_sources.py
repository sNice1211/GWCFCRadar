#!/usr/bin/env python3
"""
Lists what NOAA actually publishes, so models stop being added from memory.

    ~/wxenv/bin/python ~/GWCFCRadar/pi/scan_sources.py            # everything
    ~/wxenv/bin/python ~/GWCFCRadar/pi/scan_sources.py hur hafs   # just these
    ~/wxenv/bin/python ~/GWCFCRadar/pi/scan_sources.py --new      # not carried

Every model added here so far has been four strings written from memory, and
several were wrong in ways that look identical to the model not existing. The
file server has a plain directory listing, so this walks it: every model family
NOAA publishes, the newest dated directory inside it, and a sample filename
with the forecast hour picked out.

That turns "what else is there" and "what is HWRF really called" from questions
into a command. Paste the output back and a model becomes a few lines that are
known to be right rather than hoped to be.
"""

import re
import sys

from gfs_pipeline import HTTP, MODELS, RAW_BASE

GREEN, DIM, BOLD, OFF = "\033[32m", "\033[2m", "\033[1m", "\033[0m"

# The families already carried, so the scan can say what is new. Taken from the
# raw paths rather than a second list, which would only go out of date.
def carried():
    out = set()
    for m in MODELS.values():
        raw = m.get("raw")
        if not raw:
            continue
        for r in (raw if isinstance(raw, (list, tuple)) else [raw]):
            out.add(r.split("/", 1)[0])
    return out


def listing(url):
    """The entries in one directory, or None if it does not answer."""
    try:
        r = HTTP.get(url, timeout=30)
        if r.status_code != 200:
            return None
    except Exception:
        return None
    names = re.findall(r'href="([^"?][^"]*)"', r.text)
    # Apache puts sorting links and a parent link in there too.
    return [n for n in names if not n.startswith(("/", "?", "http"))]


def newest_dated(entries):
    """The most recent thing that looks like a dated directory."""
    dated = [e for e in entries if re.search(r"\d{8}", e)]
    return sorted(dated)[-1] if dated else None


def sample(family, depth=3):
    """Walk into a family until files appear, and report one."""
    url = f"{RAW_BASE}/{family}/prod/"
    entries = listing(url)
    if entries is None:
        return None, "no prod directory"

    path = "prod"
    for _ in range(depth):
        nxt = newest_dated(entries) or (entries[0] if entries else None)
        if not nxt or not nxt.endswith("/"):
            break
        url += nxt
        path += "/" + nxt.rstrip("/")
        got = listing(url)
        if got is None:
            break
        entries = got

    files = [e for e in entries if not e.endswith("/")]
    grib = [f for f in files if f.endswith((".grib2", ".grb2"))] or files
    if not grib:
        return path, "no files found"
    return path, grib[len(grib) // 2]


def describe(name):
    """One family, with the forecast hour in its filename picked out."""
    path, sam = sample(name)
    if path is None:
        return False
    print(f"\n{BOLD}{name}{OFF}  {DIM}{path}{OFF}")
    print(f"  {sam}")
    # The number that changes with forecast hour is the one worth naming, and
    # it is nearly always the last run of digits before the extension.
    m = re.search(r"f(\d{2,3})", sam)
    if m:
        tmpl = sam[:m.start(1)] + "{fhr:0%dd}" % len(m.group(1)) + sam[m.end(1):]
        print(f"  {DIM}forecast hour looks like f{m.group(1)}, so the file is{OFF}")
        print(f"  {GREEN}{tmpl}{OFF}")
    return True


def main(argv):
    only_new = "--new" in argv
    want = [a for a in argv if not a.startswith("-")]

    have = carried()
    families = want
    if not families:
        top = listing(f"{RAW_BASE}/") or []
        families = sorted(e.rstrip("/") for e in top if e.endswith("/"))
        print(f"{len(families)} model families on the server\n")
        print("carried already: " + ", ".join(sorted(have)))
        if only_new:
            families = [f for f in families if f not in have]
            print(f"\nnot carried: {len(families)}")

    shown = 0
    for f in families:
        tag = "" if f in have else f"  {GREEN}(not carried){OFF}"
        if describe(f):
            shown += 1
            if tag:
                print(f" {tag}")
    print(f"\n{shown} of {len(families)} answered")
    print("Paste this back and any of them becomes four lines in MODELS.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
