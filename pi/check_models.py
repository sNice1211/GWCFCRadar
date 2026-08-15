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
import re
import sys
import time
from datetime import datetime, timedelta, timezone

import requests

from gfs_pipeline import (BOX, ECMWF_BASE, DEFAULT_MODELS, REGIONS, regions_of, region_spec, ECMWF_PARAMS,
                          ECMWF_SHEAR_PARAMS, FILTER_BASE, HTTP, MODELS,
                          RAW_BASE, SHEAR_LEVELS, SHEAR_LEVEL_NAMES,
                          WANT_VARS, ask_from_inventory, cycle_for,
                          ecmwf_paths, fhours_for, merge_ranges, parse_idx,
                          raw_candidates, select_from_idx)

requests = HTTP          # one session, one user agent, everywhere

GREEN, RED, DIM, BOLD, OFF = ("\033[32m", "\033[31m", "\033[2m",
                              "\033[1m", "\033[0m")


def listing(url, want=""):
    """
    What is really in a directory on the file server.

    The point of this tool is to stop guessing, and a 404 on its own is still
    a guess: it says the address is wrong without saying what the right one
    is. NOAA serves a plain directory listing, so when a path fails this asks
    the parent what it actually contains.
    """
    try:
        r = requests.get(url, timeout=30)
        if r.status_code != 200:
            return None
    except Exception:
        return None
    names = re.findall(r'href="([^"?/][^"]*)"', r.text)
    seen, out = set(), []
    for n in names:
        if want and want not in n:
            continue
        if n not in seen:
            seen.add(n)
            out.append(n)
    return out


def explain_missing(m, date_str, cyc, fhr):
    """Say what the server does have, where we expected something."""
    for tmpl in raw_candidates(m):
        rel = tmpl.format(date=date_str, cyc=cyc, fhr=fhr)
        parent = f"{RAW_BASE}/{rel}".rsplit("/", 1)[0] + "/"
        got = listing(parent)
        if got is None:
            print(f"  {DIM}no such directory: {parent}{OFF}")
            # Walk up until something answers, so the level that is wrong is
            # named rather than the whole path being called wrong.
            up = parent.rstrip("/").rsplit("/", 1)[0] + "/"
            for _ in range(3):
                here = listing(up)
                if here is not None:
                    print(f"  {DIM}but {up} contains:{OFF}")
                    for n in here[:12]:
                        print(f"  {DIM}    {n}{OFF}")
                    return
                up = up.rstrip("/").rsplit("/", 1)[0] + "/"
            return
        print(f"  {DIM}{parent} exists and contains:{OFF}")
        stem = rel.rsplit("/", 1)[-1].split(".")[0]
        near = [n for n in got if n.startswith(stem[:6])] or got
        for n in near[:12]:
            print(f"  {DIM}    {n}{OFF}")
        return

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
        print(f"  {DIM}HTTP {r.status_code}  {idx_url}{OFF}")
        # A 404 and a 403 need opposite fixes, and neither says what the right
        # address is. ECMWF serves a listing, so ask it.
        for probe in (idx_url.rsplit("/", 1)[0] + "/",
                      f"{ECMWF_BASE}/{date_str}/{cyc}z/ifs/0p25/",
                      f"{ECMWF_BASE}/{date_str}/",
                      f"{ECMWF_BASE}/"):
            got = listing(probe)
            if got:
                print(f"  {DIM}{probe} contains:{OFF}")
                for n in got[:14]:
                    print(f"  {DIM}    {n}{OFF}")
                break
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


def check(name, region="conus"):
    m = region_spec(MODELS[name], region)
    kind = m.get("source") or m.get("fetch") or "filter"
    tag = f"{name}/{region}" if region != "conus" else name
    print(f"\n{BOLD}{tag}{OFF}  {m['label']}, {m['res']}  {DIM}[{kind}]{OFF}")
    if m.get("source") == "ecmwf":
        return check_ecmwf(name, m)

    # Recent cycles, not just the newest: a model can be a run behind without
    # anything being wrong with its address, and calling that a broken model
    # sends someone looking in the wrong place.
    hours = fhours_for(m)
    idx_text = idx_url = None
    codes = []
    for back in range(0, 4):
        when = datetime.now(timezone.utc) - timedelta(hours=back * m["cycle_h"])
        date_str, cyc = cycle_for(m, when)
        for tmpl in raw_candidates(m):
            url = f"{RAW_BASE}/" + tmpl.format(date=date_str, cyc=cyc,
                                               fhr=hours[0])
            try:
                r = requests.get(url, timeout=30)
            except Exception as e:
                print(f"  {RED}network{OFF} {e}")
                return False
            codes.append((url, r.status_code))
            if r.status_code == 200 and "<" not in r.text[:40]:
                idx_text, idx_url = r.text, url
                break
        if idx_text:
            break

    if not idx_text:
        print(f"  {RED}no index found{OFF} for the last few cycles")
        # The status code matters: a 404 is a wrong address, a 403 is being
        # refused, and they need opposite fixes.
        for url, code in codes[:4]:
            print(f"  {DIM}HTTP {code}  {url}{OFF}")
        explain_missing(m, date_str, cyc, hours[0])
        return False

    print(f"  {GREEN}index found{OFF}  {date_str} {cyc}z"
          + (f"  {DIM}({back} cycle(s) back){OFF}" if back else ""))
    if idx_url != f"{RAW_BASE}/" + raw_candidates(m)[0].format(
            date=date_str, cyc=cyc, fhr=hours[0]):
        print(f"  {DIM}using the fallback name: "
              f"{idx_url.rsplit('/', 1)[-1]}{OFF}")

    rows = parse_idx(idx_text)
    print(f"  {len(rows)} messages in the file")

    if kind == "range":
        return _check_range(m, rows, idx_url, hours)
    return _check_filter(m, rows, date_str, cyc, hours)


def _check_range(m, rows, idx_url, hours):
    """Naming exact messages, which is what the regional models now do."""
    keep, names = select_from_idx(rows, m.get("shear"))
    if not keep:
        print(f"  {RED}none of the fields we want are in it{OFF}")
        print(f"  {DIM}it has: "
              f"{', '.join(sorted({r['var'] for r in rows})[:20])}{OFF}")
        return False
    print(f"  we take {len(keep)} messages: {', '.join(sorted(names))}")

    spans = merge_ranges([(k["start"], k["end"]) for k in keep])
    grib_url = idx_url[:-4] if idx_url.endswith(".idx") else idx_url
    whole = max((r["start"] for r in rows), default=0)

    t0 = time.time()
    got = 0
    for start, end in spans:
        rng = f"bytes={start}-" + ("" if end is None else str(end))
        try:
            rr = requests.get(grib_url, timeout=120, headers={"Range": rng})
        except Exception as e:
            print(f"  {RED}range request failed{OFF} {e}")
            return False
        if rr.status_code != 206:
            print(f"  {RED}the server ignored the byte range{OFF}: "
                  f"HTTP {rr.status_code}, {len(rr.content)} bytes")
            print(f"  {DIM}without ranges this pulls the whole "
                  f"{whole / 1e6:.0f} MB file per forecast hour{OFF}")
            return False
        got += len(rr.content)
    dt = time.time() - t0

    mb = got / 1e6
    print(f"  {GREEN}downloaded{OFF} {mb:.2f} MB in {dt:.1f}s for one "
          f"forecast hour, from a {whole / 1e6:.0f} MB file "
          f"({100 * got / max(whole, 1):.0f}%)")
    _report_cost(m, mb, hours)
    return True


def _check_filter(m, rows, date_str, cyc, hours):
    """The cross product, still used where cropping is the bigger win."""
    pairs = {(r["var"], r["lev"]) for r in rows}
    vars_, levs_ = ask_from_inventory(
        pairs, SHEAR_LEVEL_NAMES if m.get("shear") else ())
    if not vars_:
        print(f"  {RED}none of the fields we want are in it{OFF}")
        print(f"  {DIM}it has: "
              f"{', '.join(sorted({v for v, _ in pairs})[:20])}{OFF}")
        return False
    print(f"  we ask for: {', '.join(v[4:] for v in vars_)}")

    params = {
        "file": m["file"].format(cyc=cyc, fhr=hours[0]),
        "dir": m["dir"].format(date=date_str, cyc=cyc),
        "subregion": "",
        **{k: "on" for k in vars_},
        **{k: "on" for k in levs_},
        **m.get("box", BOX),
    }
    t0 = time.time()
    try:
        g = requests.get(f"{FILTER_BASE}/{m['filter']}", params=params,
                         timeout=120)
    except Exception as e:
        print(f"  {RED}download failed{OFF} {e}")
        return False
    dt = time.time() - t0

    if g.status_code != 200 or g.content[:4] != b"GRIB":
        print(f"  {RED}the filter refused it{OFF}: HTTP {g.status_code}, "
              f"{len(g.content)} bytes")
        print(f"  {DIM}'filter' is probably wrong: {m['filter']}{OFF}")
        print(f"  {DIM}the data itself is reachable, so this model could be "
              f"switched to \"fetch\": \"range\" instead{OFF}")
        return False

    mb = len(g.content) / 1e6
    print(f"  {GREEN}downloaded{OFF} {mb:.2f} MB in {dt:.1f}s for one "
          f"forecast hour")
    _report_cost(m, mb, hours)
    return True


def _report_cost(m, mb, hours):
    per_run = mb * len(hours)
    per_day = per_run * (24 / m["cycle_h"])
    warn = RED if per_day > 2000 else ""
    print(f"  {len(hours)} hours per run: about {per_run:.0f} MB a run, "
          f"{warn}{per_day / 1000:.1f} GB a day{OFF if warn else ''}")
    return per_day


def main():
    names = [a for a in sys.argv[1:] if a in MODELS] or DEFAULT_MODELS
    jobs = [(n, r) for n in names for r in regions_of(MODELS[n])]
    bad = [f"{n}/{r}" for n, r in jobs if not check(n, r)]
    print()
    if bad:
        print(f"{RED}not working: {', '.join(bad)}{OFF}")
        print("Send this output back. Each failure line says which of the "
              "model's four addresses is the wrong one.")
    else:
        print(f"{GREEN}all {len(jobs)} model and region combinations "
              f"reachable{OFF}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
