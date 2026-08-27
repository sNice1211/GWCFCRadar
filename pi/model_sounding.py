#!/usr/bin/env python3
"""
A vertical profile through any model the Pi already runs.

    python3 pi/model_sounding.py --model gfs --lat 35.4 --lon -97.6 --fhr 12

The models panel draws horizontal slices: temperature at 2 m, wind at 10 m,
reflectivity, all of them one level at a time across a map. A sounding is the
other cut through the same data: every level at one point. Same models, same
runs, same servers, turned ninety degrees.

Until now the only way to ask a model for a sounding here was SounderPy, which
serves RAP and the reanalyses and nothing else at a latitude and longitude.
There was no way to ask the GFS run that the map is drawn from what the air
looks like above a point, which is the question a forecaster asks next.

This asks it. For a given model, run and forecast hour it requests the
pressure-level fields at one small box around the point, straight from the
NOMADS filter service that gfs_pipeline already uses, and reads them into the
same profile shape sounding_service produces. SHARPpy then works on it exactly
as it does on a SounderPy profile, so the panel needs to know nothing new.

Everything about WHERE the data lives is borrowed from gfs_pipeline rather
than restated: the model catalogue, the cycle arithmetic, the index reader,
the rate-limited fetcher and the AWS mirrors. A second copy of any of that
would drift, and the first symptom of drift is a sounding that quietly
disagrees with the map beside it.
"""

import math
import os
import re
import sys
import tempfile

# gfs_pipeline lives beside this file, and the service that imports this one
# may be started from anywhere.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# A pressure level, as NOAA's index spells it: "500 mb". Deliberately anchored
# at both ends, because "500 mb" and "0.4 mb" are both levels and only one of
# them belongs in a sounding, and because "surface" must never match.
MB_LEVEL_RE = re.compile(r"^(\d+(?:\.\d+)?) mb$")

# The fields a sounding is made of, and what each is for.
#
# HGT is not optional the way it looks. SHARPpy's whole parameter suite is
# defined on layers, and a layer with no depth has no meaning, so a profile
# with no heights gets a chart and no numbers under it.
#
# Dewpoint is asked for two ways because models disagree about which they
# publish. GFS carries DPT at pressure levels; plenty of others carry only
# RH and expect you to do the arithmetic. Asking for both and using whichever
# arrived is cheaper than maintaining a table of which model has which.
WANT = ("TMP", "DPT", "RH", "HGT", "UGRD", "VGRD")

# How wide a box to ask for around the point. Half a degree either side is
# about 55 km, which is more than one grid cell of even the coarsest model
# here and small enough that the download is a few tens of kilobytes rather
# than the tens of megabytes a continental crop would be.
BOX_PAD = 0.5

# Below this many complete levels there is no sounding worth drawing, only a
# misleading one. Twelve is roughly what a model publishes between the surface
# and the tropopause at its coarsest.
MIN_LEVELS = 8

# Models whose file in the catalogue is a SURFACE file, and where the same run
# publishes a pressure-level file beside it.
#
# HRRR is the one that matters. The map draws it from wrfsfc, the 2-D file,
# which is right for reflectivity and 2 m temperature and contains no column
# at all. Its soundings live in wrfprs, on a different filter script, and HRRR
# soundings are the ones a severe weather forecaster reaches for first, so
# quietly reporting "HRRR has no pressure levels" would be the wrong answer to
# a reasonable question.
#
# These addresses follow NOMADS' documented layout. They could not be checked
# against the live service from where this was written, so if one is wrong the
# error below names the file it asked for rather than blaming the model.
SOUNDING_OVERRIDE = {
    "hrrr": {"filter": "filter_hrrr_3d.pl",
             "dir": "/hrrr.{date}/conus",
             "file": "hrrr.t{cyc}z.wrfprsf{fhr:02d}.grib2",
             # The index moves with the file. Leaving this behind would read
             # the surface file's inventory and then ask the pressure file for
             # what the surface file contains, which is the exact half-rename
             # bug test-model-paths.py exists to catch.
             "raw": "hrrr/prod/hrrr.{date}/conus/"
                    "hrrr.t{cyc}z.wrfprsf{fhr:02d}.grib2.idx"},
}

# How far each model actually publishes, for a SOUNDING.
#
# Not the same number as the catalogue's "out", and this is the whole point.
# That number is how far the image pipeline builds, and it is a bandwidth
# choice: every extra forecast hour is another set of full-domain pictures
# down a home connection, so GFS stops at 120 and HRRR at 18. A sounding is
# one request for one half-degree box, a few tens of kilobytes, so none of
# that reasoning applies and there is no reason to stop where the pictures do.
#
# (reach, step). Where a model's reach depends on which run it is, the second
# entry is (cycles, longer_reach): HRRR and RAP publish much further out on
# their four-hourly extended runs than on the ones in between, and offering
# hour 40 of a run that stops at 18 is offering a stop that cannot answer.
#
# Anything not named here keeps the catalogue's own numbers, which is the safe
# answer for a model whose reach was never checked.
SOUNDING_REACH = {
    "gfs":      {"out": 384, "step": 3},
    "gfs0p50":  {"out": 384, "step": 3},
    "gfs1p00":  {"out": 384, "step": 6},
    "nam":      {"out": 84,  "step": 3},
    "namnest":  {"out": 60,  "step": 3},
    "rap":      {"out": 21,  "step": 1,
                 "long": {"cycles": (3, 9, 15, 21), "out": 51}},
    "hrrr":     {"out": 18,  "step": 1,
                 "long": {"cycles": (0, 6, 12, 18), "out": 48}},
    "gefs":     {"out": 384, "step": 6},
    "gefsc00":  {"out": 384, "step": 6},
    "gefsp01":  {"out": 384, "step": 6},
    "gefsspr":  {"out": 384, "step": 6},
    "cmce":     {"out": 384, "step": 6},
    "hireswarw": {"out": 48, "step": 1},
    "hireswfv3": {"out": 48, "step": 1},
}


def reach_for(key, m, cyc=None):
    """How far out, and at what step, this model can be asked for a column.

    cyc is the run being asked about. HRRR runs to 18 hours three times in
    four and to 48 on the fourth, so a menu built without knowing the run
    either hides two days of a real forecast or offers stops that answer with
    an error. Given the run, it is simply a fact.
    """
    r = SOUNDING_REACH.get(key)
    if not r:
        return int(m.get("out") or 48), max(1, int(m.get("step") or 1))
    out = int(r["out"])
    long = r.get("long")
    if long and cyc is not None:
        try:
            if int(cyc) in long["cycles"]:
                out = int(long["out"])
        except (TypeError, ValueError):
            pass
    return out, max(1, int(r.get("step") or 1))


# Products that are two-dimensional by definition rather than by accident, so
# there is no column in them to find and no version of them that has one.
# Waves are the sea, RTMA is a surface analysis, and the National Blend is a
# blend of surface elements. Offering these in a sounding menu would be a menu
# entry that always fails. Keyed by filter script, because a model's regional
# variants share it.
NO_COLUMN_FILTERS = {"filter_gfswave.pl", "filter_rtma2p5.pl",
                     "filter_blend.pl"}


def _pipeline():
    """gfs_pipeline, imported late.

    It pulls in requests and numpy at import, and this module is imported by
    the web server on every sounding request. An import that throws at module
    scope there takes the whole door down rather than one request.
    """
    import gfs_pipeline
    return gfs_pipeline


def models():
    """Which models can be asked for a sounding, and what to call them.

    Not every model in the catalogue can. A model is only useful here if it
    publishes pressure levels: a surface-only product like RTMA has nothing to
    stack, and the wave models have nothing to do with the air at all. Rather
    than keep a second list that goes stale, this asks the catalogue what each
    model declares and reports what it finds.
    """
    gp = _pipeline()
    out = {}
    for key, m in gp.MODELS.items():
        if m.get("source") == "ecmwf" or m.get("source") in getattr(
                gp, "URL_SOURCES", {}):
            continue          # not served by the filter service this uses
        if not m.get("filter") or not m.get("file"):
            continue
        if m["filter"] in NO_COLUMN_FILTERS:
            continue
        # The run that would be asked for right now, so the reach reported is
        # this run's reach rather than a best case that may not apply today.
        try:
            date_str, cyc = gp.cycle_for(m)
        except Exception:
            date_str, cyc = None, None
        reach, step = reach_for(key, m, cyc)
        out[key] = {
            "label": m.get("label", key),
            "res": m.get("res", ""),
            "cycle_h": m.get("cycle_h"),
            "run": f"{date_str}/{cyc}" if date_str else None,
            # Deliberately NOT the catalogue's "out". That number is how far
            # the picture pipeline builds, which is a bandwidth budget; a
            # sounding is one small request and is not bound by it.
            "out": reach,
            "step": step,
            "mapOut": m.get("out"),
            # A model that already asks for pressure levels for its own charts
            # is a safe bet; one that does not may still carry them, so it is
            # offered with a note rather than hidden. HRRR counts, because the
            # override below sends it to the file that does.
            "upper": bool(m.get("upper") or m.get("shear")
                          or key in SOUNDING_OVERRIDE),
        }
    return out


def column_spec(m, key):
    """The model, addressed at its COLUMN rather than at its map file.

    Returned as a whole model dict with the override folded in, so everything
    downstream (the index reader, the filter request) reads one consistent set
    of addresses. Overriding them one at a time is how a file and its index
    end up pointing at two different files.
    """
    over = SOUNDING_OVERRIDE.get(key)
    return (dict(m, **over) if over else m), bool(over)


def _dewpoint_from_rh(t_c, rh_pct):
    """Magnus, the same approximation the browser side uses.

    Kept identical on purpose: a dewpoint computed one way on the Pi and
    another way in the page would make the two disagree by a fraction of a
    degree, which is exactly enough to make a forecaster mistrust both.
    """
    if t_c is None or rh_pct is None:
        return None
    rh = max(1.0, min(100.0, float(rh_pct)))
    a, b = 17.625, 243.04
    g = math.log(rh / 100.0) + (a * t_c) / (b + t_c)
    return (b * g) / (a - g)


def _ask(gp, m, date_str, cyc, fhr, lat, lon, levels, want):
    """One filter request for a column, saved to a temp file.

    The subregion is what makes this cheap. The same request without it is the
    whole model domain at every pressure level, which is the difference between
    forty kilobytes and several hundred megabytes.
    """
    params = {
        "file": m["file"].format(cyc=cyc, fhr=fhr),
        "dir": m["dir"].format(date=date_str, cyc=cyc),
        "subregion": "",
        "toplat": round(lat + BOX_PAD, 2),
        "bottomlat": round(lat - BOX_PAD, 2),
        # NOMADS wants 0..360 the same way the pipeline's boxes are written.
        "leftlon": round((lon - BOX_PAD) % 360.0, 2),
        "rightlon": round((lon + BOX_PAD) % 360.0, 2),
    }
    for v in want:
        params["var_" + v] = "on"
    for lv in levels:
        params[gp.lev_flag(lv)] = "on"

    url = f"{gp.FILTER_BASE}/{m['filter']}"
    r = gp.http_get(url, params=params, timeout=90)
    if r.status_code != 200 or r.content[:4] != b"GRIB":
        raise RuntimeError(
            f"the filter service answered HTTP {r.status_code} with "
            f"{len(r.content)} bytes for {m.get('label', '?')} f{fhr:03d}")
    fd, path = tempfile.mkstemp(suffix=".grib2", prefix="gwcfc_snd_")
    with os.fdopen(fd, "wb") as fh:
        fh.write(r.content)
    return path


def _read_column(path, lat, lon):
    """{shortName: {level_mb: value}} at the grid point nearest the point.

    Read with eccodes directly, message by message, for the same reason
    gfs_pipeline does: a GRIB file is a flat sequence of self-describing
    messages, and that is exactly the shape this wants.

    The nearest point is found rather than interpolated. Interpolating between
    grid cells sounds better and is not: it smooths away the inversion or the
    dry layer that is the whole reason for looking, and a model's own idea of
    a point is its grid cell.
    """
    import eccodes
    import numpy as np

    out = {}
    fh = open(path, "rb")
    try:
        while True:
            gid = eccodes.codes_grib_new_from_file(fh)
            if gid is None:
                break
            try:
                if str(eccodes.codes_get(gid, "typeOfLevel")) != "isobaricInhPa":
                    continue
                short = str(eccodes.codes_get(gid, "shortName")).upper()
                level = float(eccodes.codes_get(gid, "level"))
                ni = int(eccodes.codes_get(gid, "Ni"))
                nj = int(eccodes.codes_get(gid, "Nj"))
                if ni < 1 or nj < 1:
                    continue
                lat1 = float(eccodes.codes_get(gid, "latitudeOfFirstGridPointInDegrees"))
                lat2 = float(eccodes.codes_get(gid, "latitudeOfLastGridPointInDegrees"))
                lon1 = float(eccodes.codes_get(gid, "longitudeOfFirstGridPointInDegrees"))
                lon2 = float(eccodes.codes_get(gid, "longitudeOfLastGridPointInDegrees"))
                eccodes.codes_set(gid, "missingValue", float("nan"))
                vals = np.asarray(eccodes.codes_get_values(gid),
                                  dtype="float64").reshape(nj, ni)

                lats = np.linspace(lat1, lat2, nj)
                # The box can straddle the meridian, where first is 359.x and
                # last is 0.x and a plain linspace runs backwards through the
                # entire world. Unwrapping keeps it a short span.
                if lon2 < lon1:
                    lon2 += 360.0
                lons = np.linspace(lon1, lon2, ni)
                want_lon = lon % 360.0
                if want_lon < lons[0] - 0.001:
                    want_lon += 360.0
                j = int(np.argmin(np.abs(lats - lat)))
                i = int(np.argmin(np.abs(lons - want_lon)))
                v = float(vals[j, i])
                if v == v:                     # not NaN
                    out.setdefault(short, {})[level] = v
            finally:
                eccodes.codes_release(gid)
    finally:
        fh.close()
    return out


def model_profile(model_key, lat, lon, fhr=0, run=None):
    """One model sounding, in the shape sounding_service already speaks.

    run is "YYYYMMDD/HH" when a particular run is wanted; without it the
    newest one that should have published is used, worked out by the same
    cycle arithmetic the map uses, so the sounding and the chart beside it are
    from the same run rather than from two runs an hour apart.
    """
    gp = _pipeline()
    if model_key not in gp.MODELS:
        raise RuntimeError(f"there is no model called {model_key} on this Pi")
    m = gp.MODELS[model_key]
    if not m.get("filter") or not m.get("file"):
        raise RuntimeError(
            f"{m.get('label', model_key)} is not served by the filter service, "
            "so a column cannot be cut out of it")
    if m["filter"] in NO_COLUMN_FILTERS:
        raise RuntimeError(
            f"{m.get('label', model_key)} is a surface product. There is no "
            "column in it to draw.")

    # The cycle comes from the model's own catalogue entry, not the override:
    # the run schedule belongs to the model, and only the file address moves.
    fhr = int(fhr or 0)
    if run:
        date_str, cyc = str(run).split("/")
    else:
        date_str, cyc = gp.cycle_for(m)
    m, overridden = column_spec(m, model_key)

    # What is actually in this file, at this hour, read from NOAA's own index.
    # Guessing loses the whole request: the filter service answers 500, not an
    # empty file, when asked for one field a model does not carry.
    pairs = gp.inventory(m, date_str, cyc, fhr)
    if not pairs:
        raise RuntimeError(
            f"no index beside {m['file'].format(cyc=cyc, fhr=fhr)} for "
            f"{date_str} {cyc}z, so what is in it cannot be known. Either the "
            "run has not published this hour yet"
            + (", or the pressure-level file this model is redirected to is "
               "not where it is expected" if overridden else "") + ".")

    levels, want = set(), set()
    for var, lev in pairs:
        mb = MB_LEVEL_RE.match(lev or "")
        if not mb:
            continue
        v = (var or "").upper()
        if v in WANT:
            levels.add(lev)
            want.add(v)
    if not levels or "TMP" not in want:
        raise RuntimeError(
            f"{m.get('label', model_key)} publishes no temperature on pressure "
            "levels in this file, so it has no sounding in it. Try GFS, NAM, "
            "RAP or HRRR.")

    # Highest pressure first is the order a sounding is read in, and sorting
    # the ASK as well keeps the request stable enough to be cached upstream.
    levels = sorted(levels, key=lambda s: -float(MB_LEVEL_RE.match(s).group(1)))

    path = _ask(gp, m, date_str, cyc, fhr, lat, lon, levels, sorted(want))
    try:
        col = _read_column(path, lat, lon)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass

    # eccodes names are not the index's names. t, dpt, r, gh, u, v.
    def pick(*names):
        for n in names:
            if n in col:
                return col[n]
        return {}

    t = pick("T", "TMP")
    dpt = pick("DPT", "TD")
    rh = pick("R", "RH", "RELATIVEHUMIDITY")
    gh = pick("GH", "HGT", "Z")
    u = pick("U", "UGRD", "10U")
    v = pick("V", "VGRD", "10V")
    if not t:
        raise RuntimeError(
            "the file came back without temperature in it, which usually "
            "means the run is still being written")

    prof = {"p": [], "z": [], "T": [], "Td": [], "u": [], "v": []}
    for lev in sorted(t.keys(), reverse=True):
        tk = t.get(lev)
        if tk is None:
            continue
        t_c = tk - 273.15 if tk > 100 else tk        # K in the file, C here
        if lev in dpt:
            d = dpt[lev]
            td_c = d - 273.15 if d > 100 else d
        else:
            td_c = _dewpoint_from_rh(t_c, rh.get(lev))
        uu, vv = u.get(lev), v.get(lev)
        zz = gh.get(lev)
        if td_c is None or uu is None or vv is None or zz is None:
            continue
        prof["p"].append(float(lev))
        prof["z"].append(float(zz))
        prof["T"].append(round(t_c, 2))
        prof["Td"].append(round(td_c, 2))
        # Metres per second in the file, knots on a sounding, everywhere.
        prof["u"].append(round(uu * 1.943844, 2))
        prof["v"].append(round(vv * 1.943844, 2))

    n = len(prof["p"])
    if n < MIN_LEVELS:
        raise RuntimeError(
            f"only {n} complete level(s) came back for "
            f"{m.get('label', model_key)} f{fhr:03d}. A level counts only when "
            "temperature, dewpoint, height and both wind components are all "
            "there, and a run part way through writing has holes.")

    return {
        "profile": prof,
        "source": model_key,
        "label": f"{m.get('label', model_key)} f{fhr:03d}",
        "model": m.get("label", model_key),
        "res": m.get("res", ""),
        "run": f"{date_str}/{cyc}",
        "fhr": fhr,
        "levels": n,
        "via": "model",
        "lat": round(float(lat), 4),
        "lon": round(float(lon), 4),
    }


def main(argv=None):
    import argparse
    import json

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--model", default="gfs")
    # Not required, because --list asks nothing about a place. Checked below
    # instead, so "what can this Pi do" does not demand a latitude first.
    ap.add_argument("--lat", type=float)
    ap.add_argument("--lon", type=float)
    ap.add_argument("--fhr", type=int, default=0)
    ap.add_argument("--run", default=None, help="YYYYMMDD/HH")
    ap.add_argument("--list", action="store_true",
                    help="what this Pi can build a sounding from")
    a = ap.parse_args(argv)

    if a.list:
        for k, v in sorted(models().items()):
            print(f"  {k:12s} {v['label']:22s} {v['res']:10s} "
                  f"run {str(v['run']):14s} "
                  f"f000 to f{v['out']:03d} every {v['step']}h"
                  f"{'   (maps stop at f%03d)' % v['mapOut'] if v.get('mapOut') and v['mapOut'] != v['out'] else ''}")
        return 0
    if a.lat is None or a.lon is None:
        print("--lat and --lon are needed to build one. --list shows what can.")
        return 2
    try:
        out = model_profile(a.model, a.lat, a.lon, a.fhr, a.run)
    except Exception as e:
        print(f"could not build it: {e}")
        return 1
    print(json.dumps({k: v for k, v in out.items() if k != "profile"}, indent=2))
    print(f"  {out['levels']} levels, "
          f"{out['profile']['p'][0]:.0f} mb to {out['profile']['p'][-1]:.0f} mb")
    return 0


if __name__ == "__main__":
    sys.exit(main())
