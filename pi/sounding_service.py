#!/usr/bin/env python3
"""
Real soundings, fetched with nothing but the standard library.

    ~/wxenv/bin/python ~/GWCFCRadar/pi/sounding_service.py --check
    ~/wxenv/bin/python ~/GWCFCRadar/pi/sounding_service.py --lat 35.4 --lon -97.6

Not a service of its own: serve.py calls into this for /sounding, so it rides
the one tunnel and the one origin everything else already uses.

Why this exists beside the level images
---------------------------------------
The page can already draw a sounding by reading the Pi's pressure-level PNGs
one pixel at a time. That works offline, costs nothing extra to build, and is
the right fallback - but it is twelve mandatory levels of one model, and
twelve levels is not enough to trust an effective inflow layer or a 0-1 km
helicity from, because both live inside the gaps between them.

This fetches the real thing: a hundred or more levels, from the RAP analysis,
from a model forecast, or from an actual balloon.

Why no SounderPy and no SHARPpy
--------------------------------
Both were tried and both refuse to install on a current Raspberry Pi, for
reasons that have nothing to do with weather:

  SHARPpy   pins a NumPy old enough to need distutils.msvccompiler, which
            Python removed. It cannot build on 3.13 at all.
  SounderPy pulls in arm-pyart and cartopy, which are large C and C++ source
            builds on ARM. On a Pi that is a long compile and a lot of disk,
            and the disk is the thing that just ran out.

Neither was ever needed. NOAA already serves exactly this: a plain text
sounding at any point, from rucsoundings.noaa.gov, in the GSD format that
every sounding program has read for thirty years. One HTTP GET and a parser
that fits on a page. No wheels, no compiler, no NumPy pin, nothing to break
next time Python moves.

The parameters are worked out in the browser, where the whole thermodynamic
suite already lives: parcels, CAPE, CIN, LCL, LFC, EL, shear, helicity,
storm motion, composites. If SHARPpy does happen to be installed, its numbers
are used instead, because it is the implementation forecasters read. That is a
bonus rather than a requirement.

A note on trust
---------------
This has never run against live data on the machine that wrote it, which has
no route to the internet. The address and the text format follow what NOAA
publishes. `--check` fetches one real sounding and says exactly what came
back, so a broken address is one command rather than a guess.
"""

import argparse
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

CACHE_DIR = os.path.expanduser("~/wxdata/soundings")

# What a point can be asked for, and what NOAA calls it.
#
# Each answers a different question, which is why there is a list rather than
# one address:
#
#   rap   what the atmosphere is doing right now, analysed. The default,
#         because "what is happening here" is the usual question.
#   obs   an actual balloon. Truth, but only twice a day and only where one
#         was released, which is rarely where the storm is.
#   *     a forecast, for what the atmosphere is going to do.
#
# Op40 is the operational RAP. Bak40 is the same model one cycle back, which
# is what answers when the newest hour has not published yet.
SOURCES = {
    "rap":      {"label": "RAP analysis",    "src": "Op40",  "fallback": "Bak40"},
    "rap-now":  {"label": "RAP analysis",    "src": "Op40",  "fallback": "Bak40"},
    "rap-fcst": {"label": "RAP forecast",    "src": "Op40",  "fallback": "Bak40"},
    "obs":      {"label": "Observed (RAOB)", "src": "RAOB",  "fallback": None},
    "nam":      {"label": "NAM forecast",    "src": "NAM",   "fallback": None},
    "gfs":      {"label": "GFS forecast",    "src": "GFS",   "fallback": None},
    # HRRR is not served in this format, so it maps to the RAP analysis it is
    # initialised from rather than quietly returning nothing.
    "hrrr":     {"label": "RAP analysis",    "src": "Op40",  "fallback": "Bak40"},
}

SOUNDING_URL = "https://rucsoundings.noaa.gov/get_soundings.cgi"
FETCH_TIMEOUT = int(os.environ.get("GWCFC_SND_FETCH_TIMEOUT", "25"))

# ── The second source, and why there are two ───────────────────────────────
#
# rucsoundings.noaa.gov still resolves and no longer answers: DNS returns an
# address, port 443 refuses the connection. The rest of NOAA is fine from the
# same machine, so this is that one service rather than the network.
#
# Open-Meteo serves the same thing as pressure level fields, and the app
# already talks to it for the wind, temperature and marine layers, so it is a
# host this Pi is known to reach rather than one hoped about. Nineteen levels
# instead of a hundred, which is fewer than a balloon and still more than the
# twelve the Pi's own images carry, and it brings real geopotential heights,
# which removes an approximation from every layer depth on the panel.
#
# Both are tried, best first. A source that comes back is a source that comes
# back, and neither being available is not a thing to find out one at a time.
OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"

# The pressure levels Open-Meteo publishes, thickest air first.
OM_LEVELS = [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500,
             400, 300, 250, 200, 150, 100, 70, 50, 30]

# Which Open-Meteo model answers for each source name here.
OM_MODELS = {
    "rap": "best_match", "rap-now": "best_match", "rap-fcst": "best_match",
    "hrrr": "gfs_hrrr", "nam": "gfs_seamless", "gfs": "gfs_seamless",
    "obs": None,          # a balloon is not a model; only NOAA has those
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
    """Whether the optional analyser is installed. Nothing depends on it."""
    out = {}
    for name in ("sharppy",):
        try:
            __import__(name)
            out[name] = True
        except Exception:
            out[name] = False
    return out


# ── The GSD text format ────────────────────────────────────────────────────
#
# Every line is a level, and the first number says what kind of level it is.
# Types 4 through 9 carry data; the low numbers are headers. The columns are
# always the same six:
#
#     type  pressure  height  temperature  dewpoint  wind dir  wind speed
#
# Pressure is in TENTHS of a millibar and both temperatures are in TENTHS of
# a degree, which is the single thing most likely to be got wrong here: a
# profile read without dividing by ten is a plausible looking sounding of a
# planet nobody lives on. 99999 means the value is missing.
GSD_MISSING = 99999


def _gsd_num(tok, scale=1.0):
    """One column, or None where the file says there is nothing."""
    try:
        v = int(tok)
    except (TypeError, ValueError):
        return None
    if abs(v) >= GSD_MISSING:
        return None
    return v / scale


def parse_gsd(text):
    """A GSD sounding into plain lists, surface first.

    Levels missing any of pressure, temperature or dewpoint are dropped
    rather than carried with holes in them. A hole part way up a profile does
    not make the chart look wrong, it makes the CAPE come out wrong, which is
    far harder to notice and far worse to act on.
    """
    prof = {"p": [], "z": [], "T": [], "Td": [], "u": [], "v": []}
    station = ""
    for raw in (text or "").splitlines():
        parts = raw.split()
        if len(parts) < 7:
            # The header lines are shorter than a data line. The station name
            # is worth keeping off them; the rest is not.
            if parts and parts[0] == "3" and len(parts) >= 3:
                station = " ".join(parts[1:3])
            continue
        try:
            kind = int(parts[0])
        except ValueError:
            continue
        if kind < 4 or kind > 9:
            continue
        p = _gsd_num(parts[1], 10.0)        # tenths of a millibar
        z = _gsd_num(parts[2])              # metres above sea level
        t = _gsd_num(parts[3], 10.0)        # tenths of a degree C
        td = _gsd_num(parts[4], 10.0)
        wd = _gsd_num(parts[5])             # degrees the wind comes FROM
        ws = _gsd_num(parts[6])             # knots
        if p is None or t is None or td is None:
            continue
        # Wind is reported as a direction and a speed and drawn as a vector.
        # The minus signs are the meteorological convention: a wind FROM the
        # north blows TOWARDS the south, so a 360 degree wind has a negative
        # v. Getting this backwards mirrors every hodograph.
        if wd is None or ws is None:
            u = v = None
        else:
            rad = math.radians(wd)
            u = round(-ws * math.sin(rad), 3)
            v = round(-ws * math.cos(rad), 3)
        prof["p"].append(round(p, 2))
        prof["z"].append(z)
        prof["T"].append(round(t, 2))
        prof["Td"].append(round(td, 2))
        prof["u"].append(u)
        prof["v"].append(v)
    return prof, station


def _sounding_url(src, lat, lon, when=None):
    q = {
        "data_source": src,
        "latest": "latest",
        "start": "latest" if not when else when,
        "n_hrs": "1",
        "fcst_len": "shortest",
        "airport": f"{float(lat):.4f},{float(lon):.4f}",
        "text": "Ascii text (GSD format)",
        "hydrometeors": "false",
        "startSecs": "",
        "endSecs": "",
    }
    return SOUNDING_URL + "?" + urllib.parse.urlencode(
        {k: v for k, v in q.items() if v != ""})


def _http_text(url):
    req = urllib.request.Request(url, headers={"User-Agent": "gwcfc-sounding"})
    with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as r:
        return r.read(2 * 1024 * 1024).decode("utf-8", "replace")


def _dewpoint(t_c, rh):
    """Dew point from temperature and relative humidity, Magnus.

    Open-Meteo publishes humidity at pressure levels and not dew point, and a
    sounding is read as dew point: the gap between the two lines IS the
    picture. Bolton's coefficients, the same ones the browser uses on the
    other path, so the two agree rather than disagreeing by a tenth.
    """
    if t_c is None or rh is None:
        return None
    rh = max(min(float(rh), 100.0), 0.1)
    a, b = 17.625, 243.04
    g = math.log(rh / 100.0) + (a * float(t_c)) / (b + float(t_c))
    try:
        return round((b * g) / (a - g), 2)
    except ZeroDivisionError:
        return None


def fetch_open_meteo(source, lat, lon, when=None):
    """One profile from Open-Meteo's pressure level fields."""
    model = OM_MODELS.get(source, "best_match")
    if model is None:
        raise RuntimeError("Open-Meteo has models, not balloons, so it cannot "
                           "answer an observed sounding.")
    fields = ["temperature_2m", "dew_point_2m", "surface_pressure",
              "wind_speed_10m", "wind_direction_10m"]
    for lev in OM_LEVELS:
        fields += [f"temperature_{lev}hPa", f"relative_humidity_{lev}hPa",
                   f"wind_speed_{lev}hPa", f"wind_direction_{lev}hPa",
                   f"geopotential_height_{lev}hPa"]
    q = {
        "latitude": f"{float(lat):.4f}", "longitude": f"{float(lon):.4f}",
        "hourly": ",".join(fields),
        # Knots, so nothing downstream has to know what unit this arrived in.
        "wind_speed_unit": "kn",
        "timezone": "UTC",
        # Two days back, so the slider can look at a storm after the fact.
        "past_days": "2", "forecast_days": "2",
    }
    if model != "best_match":
        q["models"] = model

    url = OPEN_METEO_URL + "?" + urllib.parse.urlencode(q)
    try:
        body = json.loads(_http_text(url))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Open-Meteo answered HTTP {e.code} {e.reason}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"could not reach Open-Meteo ({e.reason})")
    except ValueError:
        raise RuntimeError("Open-Meteo sent something that is not JSON")

    hourly = (body or {}).get("hourly") or {}
    times = hourly.get("time") or []
    if not times:
        raise RuntimeError("Open-Meteo returned no hours for this point")

    # Which hour. The one asked for, or the last one that is not in the
    # future: a forecast hour is published, an unobserved hour is not.
    want = (datetime.strptime(str(when), "%Y%m%d%H").replace(tzinfo=timezone.utc)
            if when else datetime.now(timezone.utc))
    stamp = want.strftime("%Y-%m-%dT%H:00")
    idx = times.index(stamp) if stamp in times else None
    if idx is None:
        past = [i for i, t in enumerate(times) if t <= stamp]
        idx = past[-1] if past else 0

    def at(name):
        col = hourly.get(name)
        if not isinstance(col, list) or idx >= len(col):
            return None
        v = col[idx]
        return None if v is None else float(v)

    prof = {"p": [], "z": [], "T": [], "Td": [], "u": [], "v": []}

    def push(p, z, t, td, spd, direc):
        if p is None or t is None or td is None:
            return
        if spd is None or direc is None:
            u = v = None
        else:
            rad = math.radians(direc)
            u = round(-spd * math.sin(rad), 3)
            v = round(-spd * math.cos(rad), 3)
        prof["p"].append(round(p, 2))
        prof["z"].append(None if z is None else round(z, 1))
        prof["T"].append(round(t, 2))
        prof["Td"].append(round(td, 2))
        prof["u"].append(u)
        prof["v"].append(v)

    # The surface first, and it is not a pressure level: it is where the
    # ground actually is, which on high terrain is well above the 1000 mb
    # level that would otherwise be the bottom of the chart.
    sfc_p = at("surface_pressure")
    push(sfc_p, None, at("temperature_2m"), at("dew_point_2m"),
         at("wind_speed_10m"), at("wind_direction_10m"))

    for lev in OM_LEVELS:
        # A level below the ground is not a level. On the Rockies the 1000
        # and 925 mb fields are extrapolated into rock, and drawing them puts
        # the bottom of the sounding underground.
        #
        # At or above, not just above: a station whose surface pressure lands
        # exactly on a published level would otherwise appear twice, once as
        # the ground and once as the level, and a profile with two entries at
        # one pressure has a layer of zero depth in it. Every layer average
        # divides by that depth.
        if sfc_p is not None and lev >= sfc_p - 0.5:
            continue
        t = at(f"temperature_{lev}hPa")
        push(lev, at(f"geopotential_height_{lev}hPa"), t,
             _dewpoint(t, at(f"relative_humidity_{lev}hPa")),
             at(f"wind_speed_{lev}hPa"), at(f"wind_direction_{lev}hPa"))

    if len(prof["p"]) < 5:
        raise RuntimeError(
            f"Open-Meteo returned only {len(prof['p'])} complete levels, "
            "which is too few to read as a sounding.")

    label = (SOURCES.get(source) or {}).get("label", source)
    return {
        "source": source,
        "label": f"{label} via Open-Meteo",
        "lat": float(lat), "lon": float(lon),
        "valid": times[idx] + "Z",
        "site": "",
        "levels": len(prof["p"]),
        "upstream": "open-meteo/" + model,
        "profile": prof,
    }


def fetch_noaa(source, lat, lon, when=None):
    """One profile from NOAA's GSD text, as plain numbers.

    `when` is a UTC hour as YYYYMMDDHH for a past analysis, or None for now.
    Raises with a readable message rather than returning a half answer.
    """
    spec = SOURCES.get(source) or SOURCES["rap"]
    # The newest analysis hour is often not published yet, which is the
    # commonest way to get an empty answer that looks like a broken address.
    # The previous cycle is asked for rather than giving up.
    tries = [spec["src"]] + ([spec["fallback"]] if spec.get("fallback") else [])
    text = None
    last_err = None
    used = None
    reached = False        # did the request get as far as an HTTP reply?
    for src in tries:
        try:
            text = _http_text(_sounding_url(src, lat, lon, when))
            reached = True
        except urllib.error.HTTPError as e:
            # An HTTP status IS a reply: the host is there and answering.
            reached = True
            last_err = f"HTTP {e.code} {e.reason}"
            continue
        except urllib.error.URLError as e:
            # No reply at all: DNS, TLS, refused, timed out. The reason is
            # the whole diagnosis and it used to be thrown away, leaving
            # "URLError" and a sentence about publishing schedules that has
            # nothing to do with a connection that never opened.
            last_err = f"could not reach the host ({e.reason})"
            continue
        except Exception as e:
            last_err = f"{e.__class__.__name__}: {e}"
            continue
        if text and text.count("\n") > 5:
            used = src
            break
        last_err = "an empty answer"
        text = None

    if not text:
        # Two completely different failures, and they were being reported
        # with one sentence. A server that answered and had nothing is a
        # question about timing; a host that never answered is a question
        # about the network or the address, and telling someone to wait an
        # hour for that is sending them the wrong way.
        why = ("Analyses publish about an hour behind, so the newest hour is "
               "often not there yet." if reached else
               "Nothing answered at " + SOUNDING_URL + ". That is a network "
               "or an address problem rather than a timing one: check the Pi "
               "can reach it at all.")
        raise RuntimeError(
            f"No {spec['label']} for {lat}, {lon}"
            + (f" at {when}Z" if when else "")
            + f": {last_err}. {why}")

    prof, station = parse_gsd(text)
    n = len(prof["p"])
    if n < 5:
        raise RuntimeError(
            f"The {spec['label']} came back with only {n} complete levels, "
            "which is too few to read as a sounding.")

    # Surface first, which is what everything downstream walks from.
    order = sorted(range(n), key=lambda i: -prof["p"][i])
    for k in prof:
        prof[k] = [prof[k][i] for i in order]

    now = datetime.now(timezone.utc)
    t = (datetime.strptime(str(when), "%Y%m%d%H").replace(tzinfo=timezone.utc)
         if when else now - timedelta(hours=1))
    return {
        "source": source,
        "label": spec["label"] + (" (previous cycle)"
                                  if used and used != spec["src"] else ""),
        "lat": float(lat), "lon": float(lon),
        "valid": t.strftime("%Y-%m-%dT%H:00Z"),
        "site": station,
        "levels": n,
        "upstream": used,
        "profile": prof,
    }



def fetch_profile(source, lat, lon, when=None):
    """One profile, from whichever source answers.

    Open-Meteo first, because it is the one this Pi is known to reach: the
    app already talks to it for the wind and temperature layers. NOAA's text
    soundings second, because when they work they are a hundred levels rather
    than nineteen and include real balloons, which no model can give.

    Both failing is reported as both failing, with each reason, rather than
    as whichever happened to be tried last.
    """
    order = [("Open-Meteo", fetch_open_meteo), ("NOAA", fetch_noaa)]
    # A balloon is not a model, so an observed sounding can only come from
    # NOAA and there is no point asking Open-Meteo for one.
    if source == "obs":
        order = [("NOAA", fetch_noaa)]
    why = []
    for name, fn in order:
        try:
            return fn(source, lat, lon, when)
        except RuntimeError as e:
            why.append(f"{name}: {e}")
        except Exception as e:
            why.append(f"{name}: {e.__class__.__name__}: {e}")
    raise RuntimeError("No sounding for "
                       f"{lat}, {lon}" + (f" at {when}Z" if when else "")
                       + ". " + "  ".join(why))


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
        "fetch": "NOAA rucsoundings",
        "params": "SHARPpy" if (prof["params"] and "error" not in prof["params"])
                  else None,
    }
    prof["built"] = datetime.now(timezone.utc).isoformat()
    prof["cached"] = False
    _cache_write(key, prof)
    _prune_cache()
    return prof


def check(lat=35.4, lon=-97.6):
    """Fetch one real sounding and say exactly what happened.

    The only question worth asking when the panel is empty, and the reason it
    fetches rather than just reporting what is installed: nothing is installed
    any more. If this works, soundings work.
    """
    libs = have_libs()
    print(f"  Source:   {SOUNDING_URL}")
    print(f"  Point:    {lat}, {lon}")
    for name in sorted(SOURCES):
        try:
            prof = fetch_profile(name, lat, lon)
            p = prof["profile"]["p"]
            print(f"  {name:9} ok  {prof['levels']:>4} levels, "
                  f"{p[0]:.0f} to {p[-1]:.0f} mb, valid {prof['valid']}"
                  f"  [{prof.get('upstream')}]")
        except RuntimeError as e:
            print(f"  {name:9} --  {e}")
        except Exception as e:
            print(f"  {name:9} !!  {e.__class__.__name__}: {e}")
    print()
    print("  SHARPpy:", "installed, so it does the parameters"
          if libs["sharppy"] else "not installed, so the browser does the "
          "parameters. That is the normal case and nothing is missing.")
    print(f"  Cache:    {CACHE_DIR} ({CACHE_SECS}s)")
    return 0


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
        return check(a.lat if a.lat is not None else 35.4,
                     a.lon if a.lon is not None else -97.6)
    try:
        out = sounding(a.source, a.lat, a.lon, a.when, not a.no_cache)
    except RuntimeError as e:
        print(json.dumps({"error": str(e)}, indent=1))
        return 1
    print(json.dumps(out, indent=1)[:4000])
    return 0


if __name__ == "__main__":
    sys.exit(main())
