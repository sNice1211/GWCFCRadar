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
import importlib
import types
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

# Which model SounderPy is asked for. None means a balloon rather than a
# model, which is a different call and a different kind of answer.
SPY_MODELS = {
    "rap": "rap", "rap-now": "rap", "rap-fcst": "rap",
    "hrrr": "hrrr", "nam": "nam", "gfs": "gfs", "obs": None,
}

SOUNDING_URL = "https://rucsoundings.noaa.gov/get_soundings.cgi"
FETCH_TIMEOUT = int(os.environ.get("GWCFC_SND_FETCH_TIMEOUT", "25"))

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
    """Which of the two are installed, and whether they really import.

    Installed and importable are different questions on a Pi: a package can
    unpack cleanly and then fail on an ancient NumPy call the moment anything
    touches it, which is a failure that only shows up when somebody clicks.
    """
    out = {}
    for name in ("sounderpy", "sharppy"):
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



def _as_list(x, unit=None):
    """One SounderPy field as a plain list of numbers.

    SounderPy hands back numpy arrays or pint quantities depending on the
    field, and JSON knows about neither.

    The unit is asked for by name rather than assumed. Units are the one
    thing a profile cannot be checked for by looking at it: a wind of 40 is a
    strong wind in knots and a violent one in metres per second, and the
    sounding drawn from the wrong one looks entirely plausible and is
    entirely wrong.
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


# ── Importing SounderPy on a machine that never draws anything ────────────
#
# This is the bug that kept the soundings dark, and it is not obvious from
# any error anyone would see. SounderPy is installed with --no-deps, because
# its dependency list includes cartopy and pyart: hours of C++ building on an
# ARM board, hundreds of megabytes of build cache, for code that only ever
# draws pictures. This Pi does not draw with SounderPy. It asks SounderPy for
# numbers and draws them itself with matplotlib.
#
# The catch is that SounderPy imports those libraries at MODULE scope, for
# functions nobody here calls. So `import sounderpy` raised ImportError, the
# fetch reported "SounderPy is not installed", somebody ran the install again,
# pip said it was already there, and round it went. The package was installed
# perfectly. It simply could not be imported.
#
# So the drawing-only libraries are stood in for. Every module below was found
# by importing SounderPy and writing down what it asked for, one at a time:
#
#   cartopy, pyart          maps and radar plots. Drawing, never called here.
#   metpy.plots.USCOUNTIES  a county map layer, which needs cartopy anyway.
#
# Everything that touches DATA is installed for real and is deliberately not
# in this list: siphon fetches, netCDF4 reads, bs4 parses listings,
# ecape_parcel is a real calculation. Stubbing one of those would not save a
# build, it would silently break a fetch, so the line is drawn at "does this
# module make a picture".
_SPY_DRAWING_ONLY = ("cartopy", "cartopy.crs", "cartopy.feature", "cartopy.io",
                     "pyart")
_spy_cached = None


class _AnythingMeta(type):
    """Attribute access on the CLASS, not just on an instance.

    cartopy is used as `ccrs.PlateCarree()` - an attribute read off the
    class itself, before anything is instantiated. A plain __getattr__ is an
    instance method and never sees that, so the class needs one of its own.
    """

    def __getattr__(cls, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return cls


class _Anything(metaclass=_AnythingMeta):
    """Whatever a plotting library was going to hand over.

    It has to be a CLASS and not a function, which is the whole subtlety
    here. MetPy does `class MetPyMapFeature(Feature)` with a name taken
    straight out of cartopy, and a function cannot be subclassed: handing
    back a function produced "TypeError: function() argument 'code' must be
    code, not str", which says nothing at all about the real problem. A
    permissive class can be subclassed, called, instantiated and read from,
    which covers every way a module-scope import is likely to use one.
    """

    def __init__(self, *a, **k):
        pass

    def __call__(self, *a, **k):
        return _Anything()

    def __getattr__(self, name):
        return _Anything()


class _DrawingStub(types.ModuleType):
    """Stands in for a plotting library on a machine that never draws."""

    __path__ = []

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return _Anything


def import_sounderpy():
    """SounderPy, with its drawing-only imports satisfied. Cached."""
    global _spy_cached
    if _spy_cached is not None:
        return _spy_cached
    for name in _SPY_DRAWING_ONLY:
        if name not in sys.modules:
            try:
                importlib.import_module(name)      # real one wins if present
            except Exception:
                sys.modules[name] = _DrawingStub(name)
    # A county boundary layer, and only defined by MetPy when cartopy is real.
    try:
        import metpy.plots as _mp
        if not hasattr(_mp, "USCOUNTIES"):
            _mp.USCOUNTIES = None
    except Exception:
        pass
    try:
        import sounderpy as spy
    except Exception as e:
        raise RuntimeError(
            "SounderPy will not import on this Pi. It is probably installed "
            "but missing something it reads data with: try "
            "'~/wxenv/bin/pip install siphon netCDF4 bs4 ecape_parcel cdsapi'. "
            f"({e.__class__.__name__}: {e})")
    _spy_cached = spy
    return spy


def fetch_sounderpy(source, lat, lon, when=None):
    """One profile from SounderPy: a hundred levels or more.

    This is the good path. SounderPy pulls the real model or balloon data
    rather than a handful of published pressure levels, which is the whole
    reason to want it: an effective inflow layer and a 0-1 km helicity live
    inside the gaps that coarser sources leave.

    The import is inside the function on purpose. serve.py imports this file
    to answer every /sounding request, and an import that throws at module
    scope takes the door down with it rather than one request.
    """
    spy = import_sounderpy()

    now = datetime.now(timezone.utc)
    if when:
        t = datetime.strptime(str(when), "%Y%m%d%H").replace(tzinfo=timezone.utc)
    else:
        # The analysis for the hour just gone. The current hour is not
        # published yet, and asking for it is the commonest way to get an
        # empty answer that looks like a broken address.
        t = now - timedelta(hours=1)
    year, month, day, hour = (f"{t.year}", f"{t.month:02d}",
                              f"{t.day:02d}", f"{t.hour:02d}")

    spec = SOURCES.get(source) or SOURCES["rap"]
    model = SPY_MODELS.get(source, "rap")
    try:
        if model is None:               # a balloon, not a model
            clean = spy.get_obs_data(str(lon), year, month, day, hour)
        else:
            clean = spy.get_model_data(model, [float(lat)], [float(lon)],
                                       year, month, day, hour)
    except Exception as e:
        raise RuntimeError(
            f"SounderPy could not fetch a {spec['label']} for {lat}, {lon} "
            f"at {year}-{month}-{day} {hour}Z: {e}")

    if not clean:
        raise RuntimeError(
            f"SounderPy found no {spec['label']} for {lat}, {lon} at "
            f"{year}-{month}-{day} {hour}Z. Analyses publish about an hour "
            "behind, so the newest hour is often not there yet.")

    # The units the page reads: millibars, metres above sea level, degrees
    # Celsius, knots. Identical to what the NOAA text path produces, so the
    # two draw the same chart and can be compared honestly.
    prof = {
        "p": _as_list(clean.get("p"), "hPa"),
        "z": _as_list(clean.get("z"), "meter"),
        "T": _as_list(clean.get("T"), "degC"),
        "Td": _as_list(clean.get("Td"), "degC"),
        "u": _as_list(clean.get("u"), "knot"),
        "v": _as_list(clean.get("v"), "knot"),
    }
    n = min((len(v) for v in prof.values() if v), default=0)
    for k in prof:
        prof[k] = prof[k][:n]

    # Only the levels where every field is really there, surface first.
    #
    # A hole part way up does not make the chart look wrong, it makes the
    # CAPE come out wrong, which is far harder to notice and far worse to act
    # on. Dropping the level costs one out of a hundred.
    req = ["p", "T", "Td", "u", "v"] + (["z"] if prof["z"] else [])
    keep = [i for i in range(n) if all(prof[k][i] is not None for k in req)]
    keep.sort(key=lambda i: -prof["p"][i])
    for k in prof:
        prof[k] = [prof[k][i] for i in keep] if prof[k] else []
    n = len(keep)
    if n < 5:
        raise RuntimeError(
            f"The {spec['label']} came back with only {n} complete levels, "
            "which is too few to read as a sounding.")

    site = clean.get("site_info") or {}
    return {
        "source": source,
        "label": spec["label"],
        "lat": float(lat), "lon": float(lon),
        "valid": f"{year}-{month}-{day}T{hour}:00Z",
        "site": site.get("site-name") or site.get("site-id") or "",
        "levels": n,
        "upstream": "sounderpy/" + (model or "obs"),
        "profile": prof,
    }


def fetch_profile(source, lat, lon, when=None):
    """One profile, from whichever source answers.

    SounderPy first, because it is the real thing: a hundred levels or more
    of the actual model or balloon data. NOAA's plain text soundings second,
    so a Pi where SounderPy will not install still draws a sounding rather
    than an error.

    Both failing is reported as both failing, with each reason, rather than
    as whichever happened to be tried last.
    """
    order = [("SounderPy", fetch_sounderpy), ("NOAA", fetch_noaa)]

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
        # The date and latitude are not decoration. SHARPpy's convective
        # profile works out sun position for its own diagnostics and dies
        # with "'NoneType' object has no attribute 'strftime'" when no date
        # is given - which meant every parameter request since this door
        # opened came back as an error, and the browser quietly did its own
        # arithmetic instead. The panel looked fine, and the entire point of
        # this function never ran once. Latitude feeds the left/right mover
        # climatology, so it is passed too rather than defaulted silently.
        try:
            when = datetime.strptime(str(prof.get("valid", "")),
                                     "%Y-%m-%dT%H:%M%z").replace(tzinfo=None)
        except (ValueError, TypeError):
            try:
                when = datetime.strptime(str(prof.get("valid", "")),
                                         "%Y-%m-%dT%H:%MZ")
            except (ValueError, TypeError):
                when = datetime.now(timezone.utc).replace(tzinfo=None)
        try:
            lat = float(prof.get("lat"))
        except (TypeError, ValueError):
            lat = 35.0
        pro = sp_profile.create_profile(profile="convective", pres=pres,
                                        hght=hght, tmpc=tmpc, dwpc=dwpc,
                                        wdir=wdir, wspd=wspd,
                                        date=when, latitude=lat)
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

    # One at a time, because SHARPpy renames things between versions: this
    # build has no `sherb` at all, and one AttributeError inside a single
    # shared try meant the ENTIRE composite table vanished - PWAT, STP, SCP
    # and DCAPE all gone because one index was spelled differently. Each key
    # now stands or falls alone, with the known alternate spellings tried.
    def attr(*names):
        for nm in names:
            try:
                return num(getattr(pro, nm))
            except Exception:
                continue
        return None

    out["composite"] = {
        "stp_fixed": attr("stp_fixed"), "stp_cin": attr("stp_cin"),
        "scp": attr("right_scp", "scp"), "ship": attr("ship"),
        "sherb": attr("sherb", "sherbe"), "dcape": attr("dcape"),
        "pwat": attr("pwat"), "k_index": attr("k_idx"),
        "lapse03": attr("lapserate_3km"),
        "lapse36": attr("lapserate_3_6km"),
        "eil": [attr("ebottom"), attr("etop")],
    }

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
        "fetch": prof.get("upstream", "").split("/")[0] or "NOAA",
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
    print("  SounderPy:", "installed" if libs["sounderpy"] else "MISSING")
    print("  SHARPpy:  ", "installed" if libs["sharppy"] else "MISSING")
    print(f"  Fallback: {SOUNDING_URL}")
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
    if not libs["sounderpy"]:
        print("  SounderPy is missing, so the plain text soundings above are")
        print("  what answers. Run install.sh again to add it.")
    if not libs["sharppy"]:
        print("  SHARPpy is missing, so the browser works the parameters out")
        print("  from the levels it is sent. The chart is the same either way.")
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
