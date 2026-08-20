#!/usr/bin/env python3
"""
Real soundings, from SounderPy, with SHARPpy's numbers on them.

    ~/wxenv/bin/python ~/GWCFCRadar/pi/sounding_service.py --check
    ~/wxenv/bin/python ~/GWCFCRadar/pi/sounding_service.py --lat 35.4 --lon -97.6

Not a service of its own: serve.py calls into this for /sounding, so it rides
the one tunnel and the one origin everything else already uses.

Why this exists beside the level images
---------------------------------------
The page could already draw a sounding by reading the Pi's pressure-level PNGs
one pixel at a time. That works offline, costs nothing extra to build, and is
the right fallback - but it is twelve mandatory levels of one model, and every
number on the panel is worked out in the browser from them.

SounderPy fetches the real thing: hundreds of levels, from the RAP analysis,
from a model forecast, or from an actual balloon. SHARPpy then computes the
parameters the way the Storm Prediction Center's own tooling does, rather than
the way a page reimplemented them. Same panel, better numbers underneath, and
where they disagree SHARPpy is the one to believe.

Neither library is required for the app to work. If they are not installed
this reports that plainly and the page falls back to the level images, which
is why the import is inside the function rather than at the top.

A note on trust
---------------
This has never run against live data on the machine that wrote it, which has
no route to the internet. The SounderPy and SHARPpy calls follow their
published interfaces, and --check probes them without a network so an install
problem is told apart from a data problem before anyone goes looking.
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone

CACHE_DIR = os.path.expanduser("~/wxdata/soundings")

# What a point can be asked for. SounderPy names its sources this way, and
# each one answers a different question:
#
#   rap   what the atmosphere is doing right now, analysed. The default,
#         because "what is happening here" is the usual question.
#   rap-  the same analysis at a past hour, for looking back at a storm.
#   obs   an actual balloon. Truth, but only twice a day and only where one
#         was released, which is rarely where the storm is.
#   *     a forecast, for what the atmosphere is going to do.
SOURCES = {
    "rap":    {"label": "RAP analysis",    "kind": "analysis"},
    "rap-now": {"label": "RAP analysis",   "kind": "analysis"},
    "obs":    {"label": "Observed (RAOB)", "kind": "obs"},
    "hrrr":   {"label": "HRRR forecast",   "kind": "model"},
    "rap-fcst": {"label": "RAP forecast",  "kind": "model"},
    "nam":    {"label": "NAM forecast",    "kind": "model"},
    "gfs":    {"label": "GFS forecast",    "kind": "model"},
}

# How long an answer stays good. A RAP analysis is hourly, so re-fetching the
# same point inside the hour is paying twice for one number; a forecast for a
# fixed hour never changes at all once published.
CACHE_SECS = int(os.environ.get("GWCFC_SND_CACHE_SECS", "900"))
# The Pi is a small computer on a home connection. Two of these at once is
# already a lot, and an unbounded queue would mean a page load could be
# waiting behind ten of them.
MAX_WAIT_SECS = int(os.environ.get("GWCFC_SND_TIMEOUT", "60"))


def _cache_key(source, lat, lon, when):
    # Rounded, because two clicks a hundred metres apart are the same sounding
    # and should not be two fetches.
    return (f"{source}_{round(float(lat), 2)}_{round(float(lon), 2)}"
            f"_{when or 'now'}").replace("-", "m").replace(".", "p")


def _cache_read(key):
    path = os.path.join(CACHE_DIR, key + ".json")
    try:
        if time.time() - os.path.getmtime(path) > CACHE_SECS:
            return None
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _cache_write(key, payload):
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        tmp = os.path.join(CACHE_DIR, key + ".tmp")
        with open(tmp, "w") as fh:
            json.dump(payload, fh)
        os.replace(tmp, os.path.join(CACHE_DIR, key + ".json"))
    except OSError:
        pass


def _prune_cache(keep=200):
    """Oldest first, so a season of clicking does not fill the card."""
    try:
        files = [(os.path.getmtime(os.path.join(CACHE_DIR, f)), f)
                 for f in os.listdir(CACHE_DIR) if f.endswith(".json")]
    except OSError:
        return
    if len(files) <= keep:
        return
    files.sort()
    for _, f in files[:len(files) - keep]:
        try:
            os.remove(os.path.join(CACHE_DIR, f))
        except OSError:
            pass


def have_libs():
    """Which of the two are installed, without importing the world twice."""
    out = {}
    for name in ("sounderpy", "sharppy"):
        try:
            __import__(name)
            out[name] = True
        except Exception:
            out[name] = False
    return out


def _as_list(x, unit=None):
    """SounderPy hands back numpy arrays or pint quantities depending on the
    field. Both become plain lists here, because JSON knows about neither.

    `unit` is asked for rather than assumed. Units are the one thing a profile
    cannot be checked for by looking at it: a wind of 40 is a strong wind in
    knots and a violent one in metres per second, and the sounding drawn from
    the wrong one looks completely plausible and is completely wrong. When the
    value carries pint units this converts; when it does not, SounderPy's
    documented units are what arrive, which are the ones asked for here.
    """
    try:
        if unit is not None and hasattr(x, "to"):
            x = x.to(unit)
    except Exception:
        pass
    try:
        x = getattr(x, "magnitude", x)      # strip pint units if present
    except Exception:
        pass
    try:
        return [None if v != v else round(float(v), 3) for v in x]
    except TypeError:
        return []


def fetch_profile(source, lat, lon, when=None):
    """One profile from SounderPy, as plain numbers.

    `when` is a UTC hour as YYYYMMDDHH for a past analysis, or None for now.
    Raises with a readable message rather than returning a half answer.
    """
    try:
        import sounderpy as spy
    except Exception as e:
        raise RuntimeError(
            "SounderPy is not installed on this Pi. Run install.sh again to "
            f"add it. ({e.__class__.__name__})")

    now = datetime.now(timezone.utc)
    if when:
        t = datetime.strptime(str(when), "%Y%m%d%H").replace(tzinfo=timezone.utc)
    else:
        # The analysis for the hour just gone: the current hour is not
        # published yet, and asking for it is the commonest way to get an
        # empty answer that looks like a broken address.
        t = now - timedelta(hours=1)
    year, month, day, hour = (f"{t.year}", f"{t.month:02d}",
                              f"{t.day:02d}", f"{t.hour:02d}")

    kind = (SOURCES.get(source) or {}).get("kind", "analysis")
    try:
        if kind == "obs":
            # A station identifier rather than a point: a balloon is released
            # somewhere specific, and the nearest one is what can be had.
            clean = spy.get_obs_data(str(lon), year, month, day, hour)
        elif kind == "model":
            clean = spy.get_model_data(source.split("-")[0], [float(lat)],
                                       [float(lon)], year, month, day, hour)
        else:
            clean = spy.get_model_data("rap", [float(lat)], [float(lon)],
                                       year, month, day, hour)
    except Exception as e:
        raise RuntimeError(
            f"SounderPy could not fetch a {source} profile for "
            f"{lat}, {lon} at {year}-{month}-{day} {hour}Z: {e}")

    if not clean:
        raise RuntimeError(
            f"No {source} profile exists for {lat}, {lon} at "
            f"{year}-{month}-{day} {hour}Z. Analyses publish about an hour "
            "behind, so the newest hour is often not there yet.")

    # The units the page reads: millibars, metres above sea level, degrees
    # Celsius, knots. Same as the pressure-level images it falls back to, so
    # the two paths draw the same chart and can be compared honestly.
    prof = {
        "p": _as_list(clean.get("p"), "hPa"),
        "z": _as_list(clean.get("z"), "meter"),
        "T": _as_list(clean.get("T"), "degC"),
        "Td": _as_list(clean.get("Td"), "degC"),
        "u": _as_list(clean.get("u"), "knot"),
        "v": _as_list(clean.get("v"), "knot"),
    }
    n = min(len(v) for v in prof.values() if v) if any(prof.values()) else 0
    for k in prof:
        prof[k] = prof[k][:n]

    # Only the levels where every field is really there, sorted surface first.
    #
    # SHARPpy walks a profile assuming it is complete and ordered, and a
    # single missing dew point part way up does not make it complain: it makes
    # the CAPE come out wrong. Dropping the level instead costs one level of
    # resolution out of several hundred and keeps every number below honest.
    req = ["p", "T", "Td", "u", "v"]
    # Height joins the required set only when the source sent any at all. A
    # model always does; demanding it from one that does not would throw away
    # a perfectly good profile over a field nothing strictly needs.
    if prof["z"]:
        req.append("z")
    keep = [i for i in range(n)
            if all(prof[k][i] is not None for k in req)]
    keep.sort(key=lambda i: -prof["p"][i])
    for k in prof:
        prof[k] = [prof[k][i] for i in keep] if prof[k] else []
    n = len(keep)
    if n < 5:
        raise RuntimeError(
            f"The {source} profile came back with only {n} complete levels, "
            "which is too few to read as a sounding.")

    site = clean.get("site_info") or {}
    return {
        "source": source,
        "label": (SOURCES.get(source) or {}).get("label", source),
        "lat": float(lat), "lon": float(lon),
        "valid": f"{year}-{month}-{day}T{hour}:00Z",
        "site": site.get("site-name") or site.get("site-id") or "",
        "levels": n,
        "profile": prof,
    }


def sharppy_params(prof):
    """The SHARPpy parameter suite for one profile.

    This is the reason the whole path exists. The browser can work out CAPE
    and shear from twelve levels, and does; SHARPpy works them out from every
    level the way the Storm Prediction Center's own tooling does, and adds the
    composites nobody should be reimplementing by hand.

    Returns None rather than raising when SHARPpy is missing, because a
    profile with no derived parameters is still a sounding worth drawing.
    """
    try:
        import numpy as np
        from sharppy.sharptab import profile as sp_profile
        from sharppy.sharptab import params, winds, interp, utils
    except Exception:
        return None

    p = prof["profile"]
    # SHARPpy needs a height for every level: its whole parameter suite is
    # defined on layers, and a layer with no depth has no meaning.
    if len(p.get("z") or []) != len(p.get("p") or []):
        return {"error": "the profile arrived with no heights, so SHARPpy "
                         "cannot work out layer depths from it"}
    try:
        pres = np.asarray(p["p"], dtype=float)
        hght = np.asarray(p["z"], dtype=float)
        tmpc = np.asarray(p["T"], dtype=float)
        dwpc = np.asarray(p["Td"], dtype=float)
        u = np.asarray(p["u"], dtype=float)
        v = np.asarray(p["v"], dtype=float)
        wdir, wspd = utils.comp2vec(u, v)
        pro = sp_profile.create_profile(profile="convective", pres=pres,
                                        hght=hght, tmpc=tmpc, dwpc=dwpc,
                                        wdir=wdir, wspd=wspd)
    except Exception as e:
        return {"error": f"SHARPpy could not build the profile: {e}"}

    def num(x):
        try:
            x = float(x)
            return None if x != x else round(x, 2)
        except (TypeError, ValueError):
            return None

    out = {}
    try:
        for name, parcel in (("sb", pro.sfcpcl), ("ml", pro.mlpcl),
                             ("mu", pro.mupcl), ("fcst", pro.fcstpcl)):
            out[name] = {
                "cape": num(parcel.bplus), "cin": num(parcel.bminus),
                "lcl": num(parcel.lclhght), "lfc": num(parcel.lfchght),
                "el": num(parcel.elhght), "li": num(parcel.li5),
            }
    except Exception:
        pass

    # The wind numbers. Written out one at a time rather than in a loop
    # because SHARPpy names them all differently and a loop would only hide
    # that behind a table that also has to be maintained.
    try:
        srh = {
            "srh1": num(pro.srh1km[0]), "srh3": num(pro.srh3km[0]),
            "esrh": num(pro.right_esrh[0]),
        }
        shear = {
            "shear1": num(utils.mag(*pro.sfc_1km_shear)),
            "shear3": num(utils.mag(*pro.sfc_3km_shear)),
            "shear6": num(utils.mag(*pro.sfc_6km_shear)),
            "shear8": num(utils.mag(*pro.sfc_8km_shear)),
            "ebwd": num(utils.mag(*pro.ebwd)),
        }
        motion = {
            "rm": [num(pro.srwind[0]), num(pro.srwind[1])],
            "lm": [num(pro.srwind[2]), num(pro.srwind[3])],
            "mean": [num(pro.mean_lcl_el[0]), num(pro.mean_lcl_el[1])],
        }
        out["wind"] = dict(srh, **shear)
        out["motion"] = motion
    except Exception:
        pass

    try:
        out["composite"] = {
            "stp_fixed": num(pro.stp_fixed), "stp_cin": num(pro.stp_cin),
            "scp": num(pro.right_scp), "ship": num(pro.ship),
            "sherb": num(pro.sherb), "dcape": num(pro.dcape),
            "pwat": num(pro.pwat), "k_index": num(pro.k_idx),
            "lapse03": num(pro.lapserate_3km),
            "lapse36": num(pro.lapserate_3_6km),
            "eil": [num(pro.ebottom), num(pro.etop)],
        }
    except Exception:
        pass

    out["engine"] = "SHARPpy"
    return out


def sounding(source, lat, lon, when=None, use_cache=True):
    """A full answer: profile, parameters, and where both came from."""
    key = _cache_key(source, lat, lon, when)
    if use_cache:
        hit = _cache_read(key)
        if hit:
            hit["cached"] = True
            return hit

    prof = fetch_profile(source, lat, lon, when)
    prof["params"] = sharppy_params(prof)
    prof["engine"] = {
        "fetch": "SounderPy",
        "params": "SHARPpy" if (prof["params"] and "error" not in prof["params"])
                  else None,
    }
    prof["built"] = datetime.now(timezone.utc).isoformat()
    prof["cached"] = False
    _cache_write(key, prof)
    _prune_cache()
    return prof


def check():
    """Say what is installed and what is not, without a network."""
    libs = have_libs()
    print("  SounderPy:", "installed" if libs["sounderpy"] else "MISSING")
    print("  SHARPpy:  ", "installed" if libs["sharppy"] else "MISSING")
    if not libs["sounderpy"]:
        print("\n  Without SounderPy the page falls back to reading the Pi's")
        print("  pressure-level images, which still draws a sounding.")
        print("  Run install.sh again to add it.")
    if libs["sounderpy"] and not libs["sharppy"]:
        print("\n  Profiles will be fetched but not analysed: the page will")
        print("  work the numbers out itself from the levels it is given.")
    print(f"\n  Sources offered: {', '.join(sorted(SOURCES))}")
    print(f"  Cache: {CACHE_DIR} ({CACHE_SECS}s)")
    return 0 if libs["sounderpy"] else 1


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="say what is installed, fetch nothing")
    ap.add_argument("--lat", type=float)
    ap.add_argument("--lon", type=float)
    ap.add_argument("--source", default="rap", choices=sorted(SOURCES))
    ap.add_argument("--when", help="YYYYMMDDHH in UTC; default is the last hour")
    ap.add_argument("--no-cache", action="store_true")
    a = ap.parse_args(argv)

    if a.check or a.lat is None or a.lon is None:
        return check()
    try:
        out = sounding(a.source, a.lat, a.lon, a.when, not a.no_cache)
    except RuntimeError as e:
        print(json.dumps({"error": str(e)}, indent=1))
        return 1
    print(json.dumps(out, indent=1)[:4000])
    return 0


if __name__ == "__main__":
    sys.exit(main())
