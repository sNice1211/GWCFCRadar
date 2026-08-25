#!/usr/bin/env python3
"""
How many charts each model can actually produce, counted against live data.

    python3 tools/check-model-products.py            # every model
    python3 tools/check-model-products.py gfs hrrr   # just these
    python3 tools/check-model-products.py --min 15   # fail under this count

This fetches the real index beside a real forecast file for each model and
counts how many of the pipeline's fields are genuinely in it. That is the only
honest answer to "does this model have fifteen products": the catalogue can
list a hundred fields and a model that carries six still draws six.

Counting rather than trusting matters because the failure is silent. A field
is asked for by a variable name and a level name, and a level spelled even
slightly differently, "entire atmosphere" against "entire atmosphere
(considered as a single layer)", matches nothing at all. Nothing errors. The
chart just never appears, and the model quietly looks thinner than it is.

Models that do not publish an index (ECMWF, ICON, GEM, the Canadian regional
pair, the air quality model) are listed as not countable here rather than
counted wrongly. ECMWF's index is JSON and is counted through its own path.

Four models cannot reach fifteen and never will, because their published
files do not hold fifteen fields. Read straight off the real indexes:

    rtma / urma      13 messages in the whole file, several of them the two
                     components of one wind, so nine and ten charts
    gefschem          7 messages, all of them aerosol optics
    gefswavemean     12 messages, four of which are a second copy of the
                     swell height and period

Those are limits of the product, not of this pipeline, and are reported with
a star rather than quietly padded out with fields that would draw nothing.

Needs network. Run it from anywhere that can reach the AWS open data mirrors.
"""

import argparse
import importlib.util
import json
import os
import sys
import types
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Loaded rather than imported, and with the heavy dependencies stubbed, so
# this runs on a laptop without eccodes or a GRIB stack installed.
for _n in ("eccodes", "numpy", "PIL", "PIL.Image"):
    try:
        __import__(_n)
    except ImportError:
        _m = types.ModuleType(_n)
        _m.__getattr__ = lambda k: types.SimpleNamespace()
        sys.modules[_n] = _m

try:
    import requests
except ImportError:
    print("needs requests: pip install requests")
    sys.exit(0)

_spec = importlib.util.spec_from_file_location(
    "gp", os.path.join(ROOT, "pi", "gfs_pipeline.py"))
gp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gp)

# The models whose files carry no index. Each is a file per field, so what it
# can produce is set by the field list its URL builder walks, not by anything
# fetchable here.
NO_INDEX = {"ecmwf", "ecmwfaifs", "ecmwfens", "ecmwfaifsens", "ecmwfwave",
            "icon", "iconeu", "icond2", "iconeps", "gem", "hrdps", "rdps",
            "aqm"}

# The hurricane models publish a grid per active storm, named after that
# storm, so there is no fixed address to fetch and nothing to count unless a
# storm happens to be running. They are reported as such rather than as
# broken, which is what a bare 404 would look like.
PER_STORM = {"hafs", "hafsb", "hwrf", "hmon"}


def sample_hour(m):
    """A forecast hour this model definitely publishes.

    Not hour zero: several models publish no precipitation, no reflectivity
    and no accumulations at the analysis time, so counting there under counts
    them by a third.
    """
    step = int(m.get("step", 3) or 3)
    out = int(m.get("out", 0) or 0)
    if out <= 0:
        return 0
    return min(step * 2, out)


def index_for(name, m):
    """(url, text) for one model's index, trying a few recent cycles.

    Several cycles, because a model's newest run is often still uploading and
    the one before it is complete. Reporting "no products" for a model whose
    run is twenty minutes old would be a lie about the model.
    """
    now = datetime.now(timezone.utc)
    fhr = sample_hour(m)
    for back in (0, 1, 2, 3, 4):
        t = now - timedelta(hours=m.get("lag_h", 5) + back * m.get("cycle_h", 6))
        cyc_h = int(m.get("cycle_h", 6) or 6)
        hour = (t.hour // cyc_h) * cyc_h
        date_str = t.strftime("%Y%m%d")
        cyc = f"{hour:02d}"
        got = gp.find_index(m, date_str, cyc, fhr, timeout=25)
        if got:
            return got
    return None


def countable(rows, m):
    """The field keys this index can actually feed."""
    only = m.get("fields")
    keep, names = gp.select_from_idx(
        rows, m.get("shear"), only, m.get("upper"))
    # names look like "t2m<-TMP"; the key is what matters, and the derived
    # fields contribute two messages each under one name.
    return sorted({n.split("<-")[0] for n in names})


def check(name, m):
    if name in NO_INDEX:
        return name, None, "no index to count (one file per field)"
    if name in PER_STORM or m.get("per_storm"):
        return name, None, "one grid per active storm, no fixed address"
    got = index_for(name, m)
    if not got:
        return name, None, "index did not answer"
    url, text = got
    rows = gp.parse_idx(text)
    if not rows:
        return name, None, "index was empty"
    keys = countable(rows, m)
    return name, keys, url


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("models", nargs="*")
    ap.add_argument("--min", type=int, default=0,
                    help="exit non-zero if a countable model has fewer")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    names = args.models or list(gp.MODELS)
    todo = [(n, gp.MODELS[n]) for n in names if n in gp.MODELS]
    unknown = [n for n in names if n not in gp.MODELS]
    for n in unknown:
        print(f"unknown model: {n}")

    out = {}
    # Eight at a time. The mirrors are fine with it and fifty eight models one
    # after another is several minutes of waiting on the network.
    with ThreadPoolExecutor(max_workers=8) as pool:
        for name, keys, note in pool.map(lambda a: check(*a), todo):
            out[name] = {"count": len(keys) if keys is not None else None,
                         "fields": keys, "note": note}

    if args.json:
        print(json.dumps(out, indent=1))
        return 0

    short = []
    print(f"{'model':<16} {'products':>8}  fields")
    for name in names:
        r = out.get(name)
        if not r:
            continue
        if r["count"] is None:
            print(f"{name:<16} {'-':>8}  {r['note']}")
            continue
        mark = " " if r["count"] >= args.min else "*"
        print(f"{name:<16} {r['count']:>8}{mark} "
              + ", ".join(r["fields"][:10])
              + (" ..." if len(r["fields"]) > 10 else ""))
        if args.min and r["count"] < args.min:
            short.append((name, r["count"]))

    counted = [r for r in out.values() if r["count"] is not None]
    if counted:
        print(f"\n{len(counted)} models counted, "
              f"median {sorted(r['count'] for r in counted)[len(counted)//2]}, "
              f"lowest {min(r['count'] for r in counted)}, "
              f"highest {max(r['count'] for r in counted)}")
    if short:
        print("\nunder the minimum: "
              + ", ".join(f"{n} ({c})" for n, c in short))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
