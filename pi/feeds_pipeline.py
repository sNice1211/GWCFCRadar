#!/usr/bin/env python3
"""Fetch the feeds the browser cannot: JTWC and the SPC mesoscale discussions.

    python3 feeds_pipeline.py
    python3 feeds_pipeline.py --check      # probe the addresses, write nothing

Both of these have been broken in the app for the same reason: the sources do
not send CORS headers, so a browser is forbidden from reading them directly
and had to go through public relay services, and every one of those relays is
someone else's free machine that rate limits, changes its envelope format, or
simply goes away. Three relays in a failover chain was still three ways to be
let down.

A server has no CORS. This fetches each feed the plain way, verifies it looks
like what it claims to be, and writes it under ~/wxdata/feeds/ where serve.py
already exposes everything. The page then reads its own backend first and only
falls back to the relay chain when the backend is unreachable, which flips the
relays from the only path into the spare.

Failure policy: a fetch that fails leaves the previous file in place rather
than overwriting it with nothing. Each file carries its own fetched-at stamp,
so the page can tell fresh from stale instead of guessing.
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone

import requests

OUT_DIR = os.path.expanduser("~/wxdata/feeds")

HTTP = requests.Session()
# JTWC sits behind a Navy frontend that refuses default python user agents.
HTTP.headers.update({"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) "
                                   "GWCFCRadar feeds fetcher"})

# The same four basins the page's JTWC layer asks for, keyed the way its
# fetch keys them, so the browser-side lookup is a dictionary read.
JTWC_BASINS = ["wp", "io", "sh", "cp"]
JTWC_URL = "https://www.metoc.navy.mil/jtwc/rss/jtwc.rss?{basin}"

MCD_SOURCES = [
    # NOAA's vector MapServer first: it is the source SPC itself feeds.
    "https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/"
    "SPC_mcd/MapServer/0/query?where=1%3D1&outFields=*&f=geojson",
    "https://mesonet.agron.iastate.edu/geojson/spc_mcd.geojson",
    "https://www.spc.noaa.gov/products/md/md.geojson",
]


def log(msg):
    print(f"{datetime.now():%H:%M:%S}   {msg}", flush=True)


def write_json(path, obj):
    """Old file or new file, never half of both."""
    tmp = f"{path}.tmp{os.getpid()}"
    with open(tmp, "w") as fh:
        json.dump(obj, fh)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def fetch_jtwc():
    """Every basin's RSS, kept as the raw text the page already knows how to
    parse. Parsing here would mean two parsers to keep in agreement."""
    basins, errors = {}, {}
    for b in JTWC_BASINS:
        url = JTWC_URL.format(basin=b)
        try:
            r = HTTP.get(url, timeout=30)
            r.raise_for_status()
            text = r.text
        except Exception as e:
            errors[b] = str(e)
            continue
        # The feed is RSS with <item> entries; an HTML block page or an error
        # page is not, and must not be served to the browser as if it were.
        if "<item" not in text and "<rss" not in text:
            errors[b] = "answered, but not an RSS feed: " \
                        + re.sub(r"\s+", " ", text)[:100]
            continue
        basins[b] = text
    return basins, errors


def fetch_mcd():
    """The active mesoscale discussions as GeoJSON, from the first source
    that answers with features - or with a well-formed empty set, because
    'no MCDs right now' is a real and common answer."""
    empty_ok = None
    errors = []
    for url in MCD_SOURCES:
        try:
            r = HTTP.get(url, timeout=30)
            r.raise_for_status()
            d = r.json()
        except Exception as e:
            errors.append(f"{url.split('/')[2]}: {e}")
            continue
        feats = d.get("features")
        if isinstance(feats, list) and feats:
            return d, url, errors
        if isinstance(feats, list):
            empty_ok = (d, url)
    if empty_ok:
        return empty_ok[0], empty_ok[1], errors
    return None, None, errors


def check():
    code = 0
    basins, errors = fetch_jtwc()
    for b in JTWC_BASINS:
        if b in basins:
            print(f"  jtwc {b}: ok, {len(basins[b])} bytes")
        else:
            print(f"  jtwc {b}: {errors.get(b)}")
            code = 1
    d, src, errs = fetch_mcd()
    if d is not None:
        print(f"  mcd: ok, {len(d.get('features') or [])} feature(s) "
              f"from {src.split('/')[2]}")
    else:
        print("  mcd: every source failed: " + "; ".join(errs))
        code = 1
    return code


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args(argv)
    if a.check:
        return check()

    os.makedirs(OUT_DIR, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat()
    t0 = time.time()

    basins, errors = fetch_jtwc()
    if basins:
        write_json(os.path.join(OUT_DIR, "jtwc.json"),
                   {"fetched": now, "basins": basins, "errors": errors})
        log(f"jtwc: {len(basins)}/{len(JTWC_BASINS)} basins"
            + (f", failed: {sorted(errors)}" if errors else ""))
    else:
        # Nothing usable arrived; the previous file, if any, stays.
        log("jtwc: every basin failed: "
            + "; ".join(f"{k}: {v}" for k, v in errors.items()))

    d, src, errs = fetch_mcd()
    if d is not None:
        write_json(os.path.join(OUT_DIR, "mcd.json"),
                   {"fetched": now, "source": src, "geojson": d})
        log(f"mcd: {len(d.get('features') or [])} feature(s) "
            f"from {src.split('/')[2]}")
    else:
        log("mcd: every source failed: " + "; ".join(errs))

    log(f"feeds: done in {time.time() - t0:.0f}s")
    # Feeds being down is upstream weather, not a broken unit.
    return 0


if __name__ == "__main__":
    sys.exit(main())
