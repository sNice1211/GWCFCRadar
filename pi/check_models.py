#!/usr/bin/env python3
"""
Checks every model's address and reports what it would actually get.

    ~/wxenv/bin/python ~/GWCFCRadar/pi/check_models.py
    ~/wxenv/bin/python ~/GWCFCRadar/pi/check_models.py nbm rtma

Nothing is rendered and nothing is written. For each model this finds the
current cycle, confirms the file is really on the server, reads NOAA's index
to see which of the fields we want are in it, and downloads one forecast hour
to measure what a real request costs.

It exists because a model is defined here by four strings, and a wrong one
fails in a way that looks like the model simply not existing: the request comes
back 500 and the run is skipped. This says which of the four is wrong, and it
says it in about a minute rather than after a build.

Run it after adding a model, and after NOAA reorganises anything.
"""

import json
import sys
import time
from datetime import datetime, timedelta, timezone

import requests

from gfs_pipeline import (BOX, DEFAULT_MODELS, ECMWF_PARAMS,
                          ECMWF_SHEAR_PARAMS, FILTER_BASE, MODELS, RAW_BASE,
                          SHEAR_LEVELS, SHEAR_LEVEL_NAMES, WANT_VARS,
                          ask_from_inventory, cycle_for, ecmwf_paths,
                          fhours_for)

GREEN, RED, DIM, BOLD, OFF = "\033[32m", "\033[31m", "\033[2m", "\033[1m", "\033[0m"


def check_ecmwf(name, m):
    """
    ECMWF is fetched by byte range from an index, so it is checked that way.

    The two things that can be wrong here are different from the NOAA models:
    the index may not be published yet, and the server may ignore a Range
    header, which would quietly turn a few megabytes into a hundred.
    """
    hours = fhours_for(m)
    for back in range(0, 4):
        when = datetime.now(timezone.utc) - timedelta(hours=back * m["cycle_h"])
        date_str, cyc = cycle_for(m, when)
        _, idx_url = ecmwf_paths(m, date_str, cyc, hours[0])
        try:
            r = requests.get(idx_url, timeout=60)
        except requests.RequestException as e:
            print(f"  {RED}network{OFF} {e}")
            return False
        if r.status_code == 200:
            break
    else:
        print(f"  {RED}no index found{OFF} for the last few cycles")
        print(f"  {DIM}tried {idx_url}{OFF}")
        return False

    print(f"  {GREEN}index found{OFF}  {date_str} {cyc}z"
          + (f"  {DIM}({back} cycle(s) back){OFF}" if back else ""))

    recs = []
    for line in r.text.splitlines():
        line = line.strip()
        if line:
            try:
                recs.append(json.loads(line))
            except ValueError:
                pass
    print(f"  {len(recs)} fields in the file")

    want = [x for x in recs
            if (x.get("param") in ECMWF_PARAMS and x.get("levtype") == "sfc")
            or (m.get("shear") and x.get("param") in ECMWF_SHEAR_PARAMS
                and x.get("levtype") == "pl"
                and int(x.get("levelist", 0) or 0) in SHEAR_LEVELS)]
    if not want:
        print(f"  {RED}none of the fields we want are in it{OFF}")
        have = sorted({x.get("param", "?") for x in recs})[:25]
        print(f"  {DIM}it has: {', '.join(have)}{OFF}")
        return False
    print(f"  we would take: {', '.join(sorted({x['param'] for x in want}))}")

    total = sum(int(x.get("_length", 0)) for x in want)
    whole = max(int(x.get("_offset", 0)) + int(x.get("_length", 0))
                for x in recs)
    grib_url = ecmwf_paths(m, date_str, cyc, hours[0])[0]
    one = want[0]
    off, ln = int(one["_offset"]), int(one["_length"])
    t0 = time.time()
    try:
        rr = requests.get(grib_url, timeout=120,
                          headers={"Range": f"bytes={off}-{off + ln - 1}"})
    except requests.RequestException as e:
        print(f"  {RED}range request failed{OFF} {e}")
        return False
    dt = time.time() - t0
    if rr.status_code != 206:
        print(f"  {RED}the server ignored the byte range{OFF}: "
              f"HTTP {rr.status_code}, {len(rr.content)} bytes")
        print(f"  {DIM}without ranges this would pull the whole "
              f"{whole / 1e6:.0f} MB file per forecast hour{OFF}")
        return False
    if rr.content[:4] != b"GRIB":
        print(f"  {RED}that range is not the start of a GRIB message{OFF}")
        return False

    print(f"  {GREEN}byte range works{OFF} {len(rr.content) / 1e6:.2f} MB "
          f"in {dt:.1f}s for one field")
    per_hour = total / 1e6
    per_run = per_hour * len(hours)
    print(f"  {per_hour:.1f} MB per forecast hour out of {whole / 1e6:.0f} MB "
          f"whole, {len(hours)} hours: about {per_run:.0f} MB a run, "
          f"{per_run * (24 / m['cycle_h']) / 1000:.1f} GB a day")
    return True


def check(name):
    m = MODELS[name]
    print(f"\n{BOLD}{name}{OFF}  {m['label']}, {m['res']}")
    if m.get("source") == "ecmwf":
        return check_ecmwf(name, m)

    # Recent cycles, not just the newest: a model can be a run behind without
    # anything being wrong with the address, and reporting that as a broken
    # model would send someone looking in the wrong place.
    hours = fhours_for(m)
    idx_url = ""
    for back in range(0, 4):
        when = datetime.now(timezone.utc) - timedelta(hours=back * m["cycle_h"])
        date_str, cyc = cycle_for(m, when)
        idx_url = f"{RAW_BASE}/" + m["raw"].format(
            date=date_str, cyc=cyc, fhr=hours[0])
        try:
            r = requests.get(idx_url, timeout=30)
            ok = r.status_code == 200 and "<" not in r.text[:40]
        except requests.RequestException as e:
            print(f"  {RED}network{OFF} {e}")
            return False
        if ok:
            break
    else:
        print(f"  {RED}no index found{OFF} for the last few cycles")
        print(f"  {DIM}tried {idx_url}{OFF}")
        print(f"  {DIM}so either 'raw' or 'dir'/'file' is wrong, or the model "
              f"is not published yet{OFF}")
        return False

    print(f"  {GREEN}index found{OFF}  {date_str} {cyc}z"
          + (f"  {DIM}({back} cycle(s) back){OFF}" if back else ""))

    pairs = {(f.split(":")[3], f.split(":")[4])
             for f in r.text.splitlines() if len(f.split(":")) > 5}
    print(f"  {len(pairs)} fields in the file")

    vars_, levs_ = ask_from_inventory(
        pairs, SHEAR_LEVEL_NAMES if m.get("shear") else ())
    if not vars_:
        print(f"  {RED}none of the fields we want are in it{OFF}")
        have = sorted({v for v, _ in pairs})[:20]
        print(f"  {DIM}it has: {', '.join(have)}{OFF}")
        return False
    print(f"  we would ask for: {', '.join(v[4:] for v in vars_)}")

    missing = sorted(WANT_VARS - {v[4:] for v in vars_})
    if missing:
        print(f"  {DIM}not in this model: {', '.join(missing)}{OFF}")

    # One real request, so the cost is measured rather than guessed.
    params = {
        "file": m["file"].format(cyc=cyc, fhr=hours[0]),
        "dir": m["dir"].format(date=date_str, cyc=cyc),
        "subregion": "",
        **{k: "on" for k in vars_},
        **{k: "on" for k in levs_},
        **BOX,
    }
    t0 = time.time()
    try:
        g = requests.get(f"{FILTER_BASE}/{m['filter']}", params=params,
                         timeout=120)
    except requests.RequestException as e:
        print(f"  {RED}download failed{OFF} {e}")
        return False
    dt = time.time() - t0

    if g.status_code != 200 or g.content[:4] != b"GRIB":
        print(f"  {RED}the filter refused it{OFF}: HTTP {g.status_code}, "
              f"{len(g.content)} bytes")
        print(f"  {DIM}{g.text[:200]}{OFF}")
        print(f"  {DIM}'filter' is probably wrong: {m['filter']}{OFF}")
        return False

    mb = len(g.content) / 1e6
    print(f"  {GREEN}downloaded{OFF} {mb:.2f} MB in {dt:.1f}s "
          f"for one forecast hour")
    per_run = mb * len(hours)
    per_day = per_run * (24 / m["cycle_h"])
    print(f"  {len(hours)} hours per run: about {per_run:.0f} MB a run, "
          f"{per_day / 1000:.1f} GB a day if it runs every cycle")
    return True


def main():
    names = [a for a in sys.argv[1:] if a in MODELS] or DEFAULT_MODELS
    bad = [n for n in names if not check(n)]
    print()
    if bad:
        print(f"{RED}not working: {', '.join(bad)}{OFF}")
        print("Send this output back. Each failure line says which of the "
              "model's four addresses is the wrong one.")
    else:
        print(f"{GREEN}all {len(names)} models reachable{OFF}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
