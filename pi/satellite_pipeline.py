#!/usr/bin/env python3
"""
GOES RGB composites, built here from the raw bands.

    ~/wxenv/bin/python ~/GWCFCRadar/pi/satellite_pipeline.py
    ~/wxenv/bin/python ~/GWCFCRadar/pi/satellite_pipeline.py --sector fulldisk
    ~/wxenv/bin/python ~/GWCFCRadar/pi/satellite_pipeline.py --check

The page already shows single ABI bands straight from a WMS, which is what
every band picker does. What it could not show is a composite: Air Mass, Dust,
Day Cloud Phase, Fire Temperature, true colour. Those are not a band, they are
arithmetic across three or more bands, and no WMS serves them ready made. So
they are built here, the same way the model charts and the radar pictures are:
fetch the raw thing, do the sums, write a PNG and a manifest beside it.

Where the data comes from
-------------------------
NOAA publishes every ABI scan to a public S3 bucket, no key needed, one
NetCDF per band per scan. Files are laid out by sector, year, day-of-year and
hour, so the newest scan is the last key under the current hour's prefix,
which is the same trick radar_pipeline uses on the Level 3 bucket.

What it costs, and why the sectors are paced differently
--------------------------------------------------------
The 2 km infrared bands are a few MB each; the 0.5 km red visible band alone
is ten times that. CONUS and the two floating mesoscale sectors are small
enough to rebuild on the radar's own five minute beat. Full Disk is roughly
ten times CONUS and is therefore never built on a timer at all: it is built
only when asked for, by name, which is what --sector fulldisk is for.

A note on trust
---------------
Nothing in here has been run against live NOAA data on the machine that wrote
it, because that machine has no route to the internet. The addresses follow
NOAA's documented bucket layout and the recipes follow the published band
maths, but the first real run is the first real test: --check prints what it
would fetch and whether each address answers, without decoding anything.
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gfs_pipeline import (HTTP, MAX_EDGE_PX, bounds_from, disk_ok,  # noqa: E402
                          free_mb, hours_for_disk, log,
                          regrid_to_latlon, write_json)

OUT_DIR = os.path.expanduser("~/wxdata/satellite")

# How much history to keep on disk. This is what the page can loop over, so
# it is the difference between a five frame flicker and a real animation. The
# ceiling is the SD card, not the code: a CONUS composite is a few hundred KB.
KEEP_HOURS = float(os.environ.get("GWCFC_SAT_KEEP_HOURS", "72"))
# A composite is a few hundred kilobytes and CONUS rebuilds every ten minutes,
# so three days is about four hundred and thirty frames a product. The count
# ceiling is the real budget: the window alone says nothing about how many
# frames a faster sector produces inside it.
MAX_FRAMES = int(os.environ.get("GWCFC_SAT_MAX_FRAMES", "500"))

# GOES-East and GOES-West, as lists rather than single names.
#
# "GOES-East" is a post, not a spacecraft, and the satellite standing in it
# gets replaced. GOES-19 took over East from GOES-16, and when that happened
# the noaa-goes16 bucket did not break or disappear: it simply stopped
# gaining new files. Code pointed at it kept listing the current hour, kept
# getting an empty answer, and kept reporting "no complete scan found", which
# reads like a network problem and is not one.
#
# So each post lists the buckets that have held it, newest first. The first
# one with a scan in it wins, which means the handover costs nothing, and the
# retired satellite's archive still answers if the new one has a gap.
SATS = {
    "east": {"buckets": ["noaa-goes19", "noaa-goes16"],
             "label": "GOES-East", "lon": -75.0},
    "west": {"buckets": ["noaa-goes18", "noaa-goes17"],
             "label": "GOES-West", "lon": -137.0},
}

# ABI product per sector. RadC is CONUS, RadM1/RadM2 the two floating
# mesoscale boxes, RadF the full disk.
SECTORS = {
    "conus":    {"abi": "ABI-L1b-RadC", "label": "CONUS",        "on_demand": False},
    "meso1":    {"abi": "ABI-L1b-RadM", "label": "Mesoscale 1",  "on_demand": False, "meso": 1},
    "meso2":    {"abi": "ABI-L1b-RadM", "label": "Mesoscale 2",  "on_demand": False, "meso": 2},
    # Ten times the size of CONUS. Never on a timer; asked for by name only.
    "fulldisk": {"abi": "ABI-L1b-RadF", "label": "Full Disk",    "on_demand": True},
}

# Every recipe is (band -> weight) arithmetic per channel, then a stretch.
# "bands" lists what must be downloaded; "rgb" is how each output channel is
# built from them. A term is (band, coefficient); terms are summed, so a
# difference is just a negative coefficient.
#
# "range" is the low and high of the stretch for that channel, in the units
# the band arrives in (brightness temperature in kelvin for the emissive
# bands, reflectance 0..1 for the reflective ones). "invert" flips a channel,
# which is how cold cloud tops end up bright.
RGB_RECIPES = {
    "airmass": {
        "label": "Air Mass", "sectors": ("conus", "meso1", "meso2", "fulldisk"),
        "bands": (8, 10, 12, 13),
        "rgb": [
            {"terms": [(8, 1.0), (10, -1.0)], "range": (-26.2, 0.6)},
            {"terms": [(12, 1.0), (13, -1.0)], "range": (-43.2, 6.7)},
            {"terms": [(8, 1.0)], "range": (208.5, 243.9), "invert": True},
        ],
    },
    "dust": {
        "label": "Dust", "sectors": ("conus", "meso1", "meso2", "fulldisk"),
        "bands": (11, 13, 14, 15),
        "rgb": [
            {"terms": [(15, 1.0), (13, -1.0)], "range": (-6.7, 2.6)},
            {"terms": [(14, 1.0), (11, -1.0)], "range": (-0.5, 20.0), "gamma": 2.5},
            {"terms": [(13, 1.0)], "range": (261.2, 288.7)},
        ],
    },
    "ash": {
        "label": "Volcanic Ash", "sectors": ("conus", "meso1", "meso2", "fulldisk"),
        "bands": (11, 13, 14, 15),
        "rgb": [
            {"terms": [(15, 1.0), (13, -1.0)], "range": (-6.7, 2.6)},
            {"terms": [(14, 1.0), (11, -1.0)], "range": (-6.0, 6.3)},
            {"terms": [(13, 1.0)], "range": (243.6, 302.4)},
        ],
    },
    "nightmicro": {
        "label": "Night Microphysics", "sectors": ("conus", "meso1", "meso2", "fulldisk"),
        "bands": (7, 13, 15),
        "rgb": [
            {"terms": [(15, 1.0), (13, -1.0)], "range": (-6.7, 2.6)},
            {"terms": [(13, 1.0), (7, -1.0)], "range": (-3.1, 5.2)},
            {"terms": [(13, 1.0)], "range": (243.6, 292.6)},
        ],
    },
    "firetemp": {
        "label": "Fire Temperature", "sectors": ("conus", "meso1", "meso2"),
        "bands": (5, 6, 7),
        "rgb": [
            {"terms": [(7, 1.0)], "range": (273.0, 333.0), "gamma": 0.4},
            {"terms": [(6, 1.0)], "range": (0.0, 1.0), "gamma": 1.0},
            {"terms": [(5, 1.0)], "range": (0.0, 0.75), "gamma": 1.0},
        ],
    },
    # Day Cloud Phase is a daytime product, and the name is not decoration.
    # Its green comes from band 2 and its blue from band 5, and both of those
    # are reflective: at night they read zero, the green and blue channels go
    # flat, and what gets built and stored is a red rectangle. Ten minutes
    # apart, all night, every night. Skipping it costs nothing, because there
    # was never a picture there to lose.
    #
    # Fire Temperature is deliberately NOT marked, even though it also uses
    # reflective bands for green and blue. Its red is band 7 at 3.9 microns,
    # which sees hot ground in the dark, so a fire really does show at night.
    # That is arguably the most useful time to look at it.
    "cloudphase": {
        "label": "Day Cloud Phase", "sectors": ("conus", "meso1", "meso2"),
        "bands": (2, 5, 13),
        "daytime_only": True,
        "rgb": [
            {"terms": [(13, 1.0)], "range": (219.65, 280.65), "invert": True},
            {"terms": [(2, 1.0)], "range": (0.0, 0.78), "gamma": 1.0},
            {"terms": [(5, 1.0)], "range": (0.01, 0.59), "gamma": 1.0},
        ],
    },
    # The expensive one: needs the 0.5 km red band, and only works by day.
    # ABI has no true green, so green is the standard synthetic mix.
    "truecolor": {
        "label": "True Colour", "sectors": ("conus", "meso1", "meso2", "fulldisk"),
        "bands": (1, 2, 3),
        "daytime_only": True,
        "rgb": [
            {"terms": [(2, 1.0)], "range": (0.0, 1.0), "gamma": 0.5},
            {"terms": [(2, 0.45), (3, 0.10), (1, 0.45)], "range": (0.0, 1.0), "gamma": 0.5},
            {"terms": [(1, 1.0)], "range": (0.0, 1.0), "gamma": 0.5},
        ],
    },
}


def _doy_prefixes(sector_abi, now, meso=None, back_hours=2):
    """Newest-hour-first S3 prefixes to look in for the latest scan."""
    out = []
    for h in range(back_hours + 1):
        t = now - timedelta(hours=h)
        # Both floating mesoscale boxes live in the one RadM folder and are
        # told apart by the filename, not the path, so meso does not change
        # the prefix. It is filtered out of the listing instead.
        out.append(f"{sector_abi}/{t.year}/{t.timetuple().tm_yday:03d}/{t.hour:02d}/")
    return out


def _s3_list(bucket, prefix, timeout=30):
    # A refused or throttled listing used to look exactly like an empty one,
    # so a credentials or network problem was reported as "no scan found" and
    # sent whoever read it looking in the wrong place. Say which it was.
    url = f"https://{bucket}.s3.amazonaws.com/?list-type=2&prefix={prefix}"
    try:
        r = HTTP.get(url, timeout=timeout)
    except Exception as e:
        log(f"  s3 {bucket}: {e}")
        return []
    if r.status_code != 200:
        log(f"  s3 {bucket}/{prefix}: HTTP {r.status_code}")
        return []
    return re.findall(r"<Key>([^<]+)</Key>", r.text)


def latest_band_keys(buckets, sector, bands, now=None):
    """The bucket, scan stamp, and one S3 key per band, or None.

    Bands are published as separate files that share a start time in the
    name, so the scan is chosen first and the bands picked out of it. A scan
    missing any wanted band is skipped rather than half drawn.

    Takes a list of buckets because the satellite standing in a post gets
    replaced and the retired one's bucket stays up, empty of new scans. The
    first bucket with a complete scan wins.
    """
    now = now or datetime.now(timezone.utc)
    if isinstance(buckets, str):
        buckets = [buckets]
    spec = SECTORS[sector]
    meso = spec.get("meso")
    # RadM1 or RadM2 for a mesoscale box; RadC or RadF otherwise. This is the
    # part of the filename that says which sector a file belongs to.
    want_tag = f"RadM{meso}-" if meso else f"{spec['abi'].rsplit('-', 1)[-1]}-"
    for bucket in buckets:
        for prefix in _doy_prefixes(spec["abi"], now, meso):
            keys = _s3_list(bucket, prefix)
            if not keys:
                continue
            # Group by the scan start stamp embedded in every filename.
            scans = {}
            for k in keys:
                if want_tag not in k:
                    continue
                m = re.search(r"_s(\d{14})", k)
                b = re.search(r"-M\dC(\d\d)_", k)
                if not m or not b:
                    continue
                scans.setdefault(m.group(1), {})[int(b.group(1))] = k
            for stamp in sorted(scans, reverse=True):
                have = scans[stamp]
                if all(b in have for b in bands):
                    return bucket, stamp, {b: have[b] for b in bands}
    return None


def _stamp_utc(stamp):
    """The scan start time out of an ABI filename stamp (YYYYDDDHHMMSSt)."""
    try:
        return (datetime(int(stamp[0:4]), 1, 1, tzinfo=timezone.utc)
                + timedelta(days=int(stamp[4:7]) - 1, hours=int(stamp[7:9]),
                            minutes=int(stamp[9:11]), seconds=int(stamp[11:13])))
    except Exception:
        return None


def _sun_elevation(when, lat, lon):
    """Roughly how high the sun is above the horizon, in degrees.

    A visible band at night is a black rectangle, and true colour at night is
    three black rectangles stacked into one. Rather than spend the biggest
    download of the set on that, the recipes marked daytime_only ask this
    first. Half a degree of accuracy is plenty to tell noon from midnight.
    """
    n = (when - datetime(2000, 1, 1, 12, tzinfo=timezone.utc)).total_seconds() / 86400.0
    mean_lon = np.radians((280.460 + 0.9856474 * n) % 360.0)
    anomaly = np.radians((357.528 + 0.9856003 * n) % 360.0)
    lam = (mean_lon + np.radians(1.915) * np.sin(anomaly)
           + np.radians(0.020) * np.sin(2.0 * anomaly))
    eps = np.radians(23.439 - 0.0000004 * n)
    dec = np.arcsin(np.sin(eps) * np.sin(lam))
    ra = np.arctan2(np.cos(eps) * np.sin(lam), np.cos(lam))
    gmst = (18.697374558 + 24.06570982441908 * n) % 24.0
    ha = np.radians(gmst * 15.0 + lon) - ra
    la = np.radians(lat)
    return float(np.degrees(np.arcsin(
        np.sin(la) * np.sin(dec) + np.cos(la) * np.cos(dec) * np.cos(ha))))


# How much of the satellite's own resolution to keep.
#
# MAX_EDGE_PX is 1600 and is shared with the model pipeline, where it is the
# right number: a model grid is coarse to begin with and 1600 is already finer
# than the data. ABI is the opposite. A CONUS scan is 10000 pixels across at
# half a kilometre, so decimating it to 1600 throws away six of every seven
# pixels and puts about 3.5 km on the ground behind each one. Full disk is
# worse: 21696 across, decimated fourteen to one.
#
# That is where "very pixelated" came from, and it was never recoverable in
# the browser, because the detail had already been dropped here.
#
# These pipelines no longer run on a Raspberry Pi, so the memory this was
# protecting is not the constraint it was. The numbers below are per sector,
# because the sectors are wildly different sizes and one ceiling cannot serve
# a 1000 pixel mesoscale box and a 21696 pixel full disk at once.
SAT_EDGE_PX = {
    "conus":    int(os.environ.get("GWCFC_SAT_EDGE_CONUS", "5000")),
    "fulldisk": int(os.environ.get("GWCFC_SAT_EDGE_FD", "3400")),
    # The mesoscale boxes are only about a thousand pixels natively, so this
    # ceiling never binds and they come through untouched, which is what you
    # want for the sector aimed at the storm.
    "meso1":    int(os.environ.get("GWCFC_SAT_EDGE_MESO", "2400")),
    "meso2":    int(os.environ.get("GWCFC_SAT_EDGE_MESO", "2400")),
}
SAT_EDGE_DEFAULT = int(os.environ.get("GWCFC_SAT_EDGE_DEFAULT", "3000"))


def _sat_edge(sector):
    """The pixel ceiling for one sector, falling back to a sane middle."""
    return SAT_EDGE_PX.get(str(sector).lower(), SAT_EDGE_DEFAULT)


def _read_abi(bucket, key, max_edge=SAT_EDGE_DEFAULT):
    """One ABI NetCDF into (values, lats, lons), already thinned.

    The 0.5 km bands are 21 million points and this board will not hold
    several of those at once, so each band is decimated on the way in to no
    more than max_edge on its long side. Every band of a scan lands on the
    same fixed grid, so decimating each to the same target keeps them
    aligned without resampling anything.
    """
    import netCDF4  # imported here so --check runs without it installed

    url = f"https://{bucket}.s3.amazonaws.com/{key}"
    r = HTTP.get(url, timeout=180)
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code} for {key.rsplit('/', 1)[-1]}")
    ds = netCDF4.Dataset("inmem", mode="r", memory=r.content)
    try:
        rad = ds.variables["Rad"]
        ny, nx = rad.shape
        step = max(1, int(np.ceil(max(ny, nx) / float(max_edge))))
        vals = np.asarray(rad[::step, ::step], dtype=np.float32)

        # Fixed grid angles, thinned the same way.
        x = np.asarray(ds.variables["x"][::step], dtype=np.float64)
        y = np.asarray(ds.variables["y"][::step], dtype=np.float64)
        proj = ds.variables["goes_imager_projection"]
        lon0 = float(proj.longitude_of_projection_origin)
        H = float(proj.perspective_point_height) + float(proj.semi_major_axis)
        req = float(proj.semi_major_axis)
        rpol = float(proj.semi_minor_axis)

        # Emissive bands arrive as radiance and are converted to brightness
        # temperature; reflective bands to reflectance. Which is which is
        # told by the file itself rather than a hardcoded band list.
        if "planck_fk1" in ds.variables:
            fk1 = float(ds.variables["planck_fk1"][0])
            fk2 = float(ds.variables["planck_fk2"][0])
            bc1 = float(ds.variables["planck_bc1"][0])
            bc2 = float(ds.variables["planck_bc2"][0])
            with np.errstate(all="ignore"):
                vals = (fk2 / np.log((fk1 / np.maximum(vals, 1e-6)) + 1.0) - bc1) / bc2
        elif "kappa0" in ds.variables:
            vals = vals * float(ds.variables["kappa0"][0])
    finally:
        ds.close()

    lats, lons = _fixed_grid_latlon(x, y, lon0, H, req, rpol)
    return vals.astype(np.float32), lats, lons


def _fixed_grid_latlon(x, y, lon0, H, req, rpol):
    """ABI fixed-grid scan angles to latitude and longitude.

    Straight out of the GOES-R product definition: the scan angles are a
    look direction from the satellite, and this intersects that look with the
    ellipsoid. Points that miss the earth entirely - the corners of a full
    disk - come back as NaN, which is exactly what should not be drawn.
    """
    X, Y = np.meshgrid(x, y)
    sx, cx = np.sin(X), np.cos(X)
    sy, cy = np.sin(Y), np.cos(Y)
    del X, Y

    rr = (req * req) / (rpol * rpol)
    a = sx ** 2 + (cx ** 2) * (cy ** 2 + rr * sy ** 2)
    b = -2.0 * H * cx * cy
    c = H * H - req * req
    disc = b * b - 4.0 * a * c
    with np.errstate(all="ignore"):
        good = disc >= 0
        rs = np.where(good, (-b - np.sqrt(np.maximum(disc, 0))) / (2.0 * a), np.nan)
        sxk = rs * cx * cy
        syk = -rs * sx
        szk = rs * cx * sy
        lat = np.degrees(np.arctan(rr * szk / np.sqrt((H - sxk) ** 2 + syk ** 2)))
        lon = np.degrees(lon0 * np.pi / 180.0 - np.arctan(syk / (H - sxk)))
    lat = np.where(good, lat, np.nan).astype(np.float32)
    lon = np.where(good, lon, np.nan).astype(np.float32)
    return lat, lon


def _stretch(arr, lo, hi, invert=False, gamma=1.0):
    with np.errstate(all="ignore"):
        v = (arr - lo) / float(hi - lo)
    v = np.clip(np.nan_to_num(v, nan=0.0), 0.0, 1.0)
    if invert:
        v = 1.0 - v
    if gamma and gamma != 1.0:
        v = np.power(v, gamma)
    return v


def build_rgb(sat_key, sector, recipe_key, now=None):
    """One composite, for one satellite and sector, onto disk."""
    sat = SATS[sat_key]
    recipe = RGB_RECIPES[recipe_key]
    if sector not in recipe["sectors"]:
        return False

    found = latest_band_keys(sat["buckets"], sector, recipe["bands"], now)
    if not found:
        log(f"  sat {sat_key}/{sector}/{recipe_key}: no complete scan in "
            + " or ".join(sat["buckets"]))
        return False
    bucket, stamp, keys = found

    # The scan may not have moved on since the last pass. Rebuilding the same
    # picture costs the full download of every band it needs, so it is not
    # done: the frame already on disk is the answer.
    already = _stamp_utc(stamp)
    if already is not None:
        fdir = already.strftime("%Y%m%d_%H%M%S")
        side = os.path.join(OUT_DIR, sat_key, sector, fdir, f"{recipe_key}.json")
        if os.path.exists(side):
            log(f"  sat {sat_key}/{sector}/{recipe_key}: {stamp} already built")
            return False

    if recipe.get("daytime_only"):
        when = _stamp_utc(stamp)
        # Judged at the satellite's own longitude, which every sector it
        # serves sits near enough to for a day-or-night answer.
        if when is not None and _sun_elevation(when, 35.0, sat["lon"]) < -6.0:
            log(f"  sat {sat_key}/{sector}/{recipe_key}: dark, skipped")
            return False

    data, lats, lons = {}, None, None
    for b in recipe["bands"]:
        try:
            # Per sector, so a mesoscale box keeps all of its detail and a
            # full disk is still allowed to be large without being absurd.
            vals, la, lo = _read_abi(bucket, keys[b], _sat_edge(sector))
        except Exception as e:
            log(f"  sat {sat_key}/{sector}/{recipe_key}: band {b}: {e}")
            return False
        data[b] = vals
        # Bands differ in native resolution, so after thinning they can differ
        # by a row or column. The smallest common shape is what everything is
        # cut to, which keeps the arithmetic honest without resampling.
        if lats is None or la.size < lats.size:
            lats, lons = la, lo

    ny = min(min(v.shape[0] for v in data.values()), lats.shape[0])
    nx = min(min(v.shape[1] for v in data.values()), lats.shape[1])
    for b in data:
        data[b] = data[b][:ny, :nx]
    lats, lons = lats[:ny, :nx], lons[:ny, :nx]

    chans = []
    for spec in recipe["rgb"]:
        acc = np.zeros((ny, nx), dtype=np.float32)
        for band, coeff in spec["terms"]:
            acc += data[band] * np.float32(coeff)
        lo, hi = spec["range"]
        chans.append(_stretch(acc, lo, hi, spec.get("invert", False),
                              spec.get("gamma", 1.0)))
        del acc
    del data

    # The satellite's own grid is not rows of latitude, so the picture has to
    # be dropped onto a plain lat/lon mesh before Leaflet can lay it flat. The
    # same regridder the model charts use does it, and it wants the box in the
    # 0..360 longitude convention it works in. Points that missed the earth
    # came back NaN and are simply outside every edge of the box.
    with np.errstate(all="ignore"):
        lon360 = np.where(lons < 0.0, lons + 360.0, lons)
        box = {"bottomlat": float(np.nanmin(lats)), "toplat": float(np.nanmax(lats)),
               "leftlon": float(np.nanmin(lon360)), "rightlon": float(np.nanmax(lon360))}
    if not all(np.isfinite(v) for v in box.values()):
        log(f"  sat {sat_key}/{sector}/{recipe_key}: no points on the earth")
        return False

    # One output cell per source cell on the long side. Saying so explicitly
    # keeps every channel and the coverage mask on identical grids, which is
    # what lets them be stacked into one RGBA image at the end.
    edge = max(ny, nx)
    grids = []
    for ch in chans:
        g = regrid_to_latlon(ch, lats, lons, box, edge=edge)
        if g is None:
            log(f"  sat {sat_key}/{sector}/{recipe_key}: too few points in box")
            return False
        grids.append(np.clip(np.nan_to_num(g[0]) * 255.0, 0, 255).astype(np.uint8))
    glat, glon = g[1], g[2]

    # A cell nothing landed in is a gap, not black, so it is made transparent.
    cov = regrid_to_latlon(np.ones((ny, nx), np.float32), lats, lons, box, edge=edge)
    agrid = np.where(np.isfinite(cov[0]), 255, 0).astype(np.uint8)

    # Each scan gets its own folder named after its time, exactly like the
    # radar frames, because that is what makes a loop possible: an overwritten
    # single file can only ever be "now", and a page cannot animate one frame.
    when = _stamp_utc(stamp)
    fdir = (when or datetime.now(timezone.utc)).strftime("%Y%m%d_%H%M%S")
    out = os.path.join(OUT_DIR, sat_key, sector, fdir)
    os.makedirs(out, exist_ok=True)
    png = os.path.join(out, f"{recipe_key}.png")
    Image.fromarray(np.dstack(grids + [agrid]), mode="RGBA").save(png, optimize=True)
    # The mesoscale boxes float, so every frame carries its own rectangle
    # rather than borrowing the newest one and landing in the wrong place.
    write_json(os.path.join(out, f"{recipe_key}.json"),
               {"stamp": stamp, "bounds": bounds_from(glat, glon)})
    log(f"  sat {sat_key}/{sector}/{recipe_key}: built {stamp} "
        f"({agrid.shape[1]}x{agrid.shape[0]})")
    return {"file": f"{fdir}/{recipe_key}.png", "dir": fdir, "label": recipe["label"],
            "stamp": stamp, "bounds": bounds_from(glat, glon),
            "built": datetime.now(timezone.utc).isoformat()}


def prune(sector_dir, hours=KEEP_HOURS):
    """Drop frame folders older than the retention window.

    A frame folder's name is its own timestamp, so nothing else has to be
    written down to know how old it is. A name that will not parse is left
    alone rather than guessed about and deleted.
    """
    if not os.path.isdir(sector_dir):
        return
    import shutil
    # What the card can afford, not what was asked for. A composite is
    # several bands reprojected into one PNG and they are the largest
    # pictures this Pi writes, so the satellite folder is usually the first
    # place a full disk shows up.
    hours = hours_for_disk(sector_dir, hours)
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    kept = []
    for d in sorted(os.listdir(sector_dir)):
        full = os.path.join(sector_dir, d)
        if not (os.path.isdir(full) and d[:1].isdigit()):
            continue
        try:
            when = datetime.strptime(d, "%Y%m%d_%H%M%S").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if when < cutoff:
            shutil.rmtree(full, ignore_errors=True)
        else:
            kept.append(full)
    # The window is not a budget on its own: a mesoscale sector rebuilding
    # every ten minutes produces four times what Full Disk does inside the
    # same three days. Oldest first, so what goes is what is least missed.
    if MAX_FRAMES and len(kept) > MAX_FRAMES:
        for full in kept[:len(kept) - MAX_FRAMES]:
            shutil.rmtree(full, ignore_errors=True)


def _relist_frames(sector_dir, recipe_key):
    """Every frame of one product still on disk, oldest first.

    Read back off the disk rather than appended to a list in the manifest,
    so a frame that was pruned, or one that failed to write, can never be
    advertised to the page as something it can load.
    """
    out = []
    if not os.path.isdir(sector_dir):
        return out
    for d in sorted(os.listdir(sector_dir)):
        if not d[:1].isdigit():
            continue
        if not os.path.exists(os.path.join(sector_dir, d, f"{recipe_key}.png")):
            continue
        side = {}
        try:
            with open(os.path.join(sector_dir, d, f"{recipe_key}.json")) as fh:
                side = json.load(fh) or {}
        except Exception:
            pass
        out.append({"t": d, "file": f"{d}/{recipe_key}.png",
                    "bounds": side.get("bounds")})
    return out


def build_sector(sat_key, sector, only=None, now=None):
    sector_dir = os.path.join(OUT_DIR, sat_key, sector)
    man_path = os.path.join(sector_dir, "manifest.json")
    prev = {}
    try:
        with open(man_path) as fh:
            prev = (json.load(fh) or {}).get("products") or {}
    except Exception:
        pass

    built = 0
    for key, recipe in RGB_RECIPES.items():
        if only and key not in only:
            continue
        if sector not in recipe["sectors"]:
            continue
        try:
            got = build_rgb(sat_key, sector, key, now)
        except Exception as e:
            log(f"  sat {sat_key}/{sector}/{key}: {e}")
            got = False
        if got:
            prev[key] = got
            built += 1

    prune(sector_dir)

    # Rebuild the frame lists from what survived the prune, and drop any
    # product that has no frames left at all.
    products = {}
    for key, meta in prev.items():
        frames = _relist_frames(sector_dir, key)
        if not frames:
            continue
        newest = frames[-1]
        products[key] = {
            "label": RGB_RECIPES.get(key, {}).get("label") or meta.get("label") or key,
            "frames": frames,
            "latest": newest["t"],
            "file": newest["file"],
            "bounds": newest.get("bounds") or meta.get("bounds"),
            "built": meta.get("built"),
        }

    if products:
        os.makedirs(sector_dir, exist_ok=True)
        write_json(man_path, {"updated": datetime.now(timezone.utc).isoformat(),
                              "sector": sector, "sat": sat_key,
                              "keep_hours": KEEP_HOURS, "products": products})
    return built


# ── The global mosaic: GMGSI ────────────────────────────────────────────────
# NOAA's Global Mosaic of Geostationary Satellite Imagery: every operational
# geostationary satellite - GOES East and West, Himawari over the Pacific,
# Meteosat over Africa and the Indian Ocean - blended into one worldwide
# picture, published hourly as a plain netCDF on an equirectangular grid.
#
# This is what makes Himawari and Meteosat views possible here at all. Their
# raw feeds are a different format entirely (Himawari publishes HSD, which
# needs a decoder this pipeline does not carry), but the mosaic has already
# done that work, so a "Himawari sector" is a crop of a grid we can read with
# the netCDF reader we already have.
#
# The grid is regular in latitude and longitude, which is exactly the shape a
# Leaflet image overlay assumes, so no regridding happens: crop, downsample,
# paint. The values arrive already scaled 0-255.

GLOBAL_BUCKET = "noaa-gmgsi-pds"

GLOBAL_PRODUCTS = {
    # No channel is inverted. The mosaic's values are already display-scaled
    # (the variable is typed VISR): cold cloud tops arrive bright and warm
    # surface dark, which is the picture people expect. This was checked
    # against a real file - inverting it painted two Pacific typhoons as dark
    # swirls on a white ocean, which is how the mistake announces itself.
    "ir":   {"path": "GMGSI_LW",  "label": "Global Infrared",     "invert": False},
    "vis":  {"path": "GMGSI_VIS", "label": "Global Visible",      "invert": False},
    "wv":   {"path": "GMGSI_WV",  "label": "Global Water Vapor",  "invert": False},
    "swir": {"path": "GMGSI_SW",  "label": "Global Shortwave IR", "invert": False},
}

# Crops of the one global grid, named for the satellite whose view they
# frame. Nothing extra is downloaded per sector: one file, four windows.
GLOBAL_SECTORS = {
    "global":   {"label": "Global",              "lat": (-72, 72), "lon": (-180, 180)},
    "pacific":  {"label": "Himawari W Pacific",  "lat": (-55, 55), "lon": (80, 180)},
    "meteosat": {"label": "Meteosat Africa",     "lat": (-55, 65), "lon": (-45, 60)},
    "indian":   {"label": "Indian Ocean",        "lat": (-50, 45), "lon": (30, 120)},
}


def _gmgsi_latest_key(product_path, now=None):
    """The newest object for one GMGSI product, and its timestamp."""
    now = now or datetime.now(timezone.utc)
    for back in (0, 1):
        day = now - timedelta(days=back)
        prefix = f"{product_path}/{day:%Y/%m/%d}/"
        try:
            keys = _s3_list(GLOBAL_BUCKET, prefix)
        except Exception as e:
            log(f"  sat global: listing {prefix}: {e}")
            keys = []
        keys = [k for k in keys if k.endswith(".nc")]
        if keys:
            key = sorted(keys)[-1]
            m = re.search(r"_s(\d{14})", key)
            if not m:
                continue
            t = m.group(1)
            stamp = f"{t[0:8]}_{t[8:14]}"
            return key, stamp
    return None, None


def _gmgsi_read(key):
    """One GMGSI file as (uint8 values, mask, lat axis, lon axis).

    The grid is stored starting at the dateline, so the columns are rolled
    until longitude ascends from -180: an image overlay is a rectangle in
    lat/lon and cannot cross the antimeridian.
    """
    import netCDF4
    tmp = os.path.join(OUT_DIR, f".gmgsi_{os.getpid()}.nc")
    r = HTTP.get(f"https://{GLOBAL_BUCKET}.s3.amazonaws.com/{key}", timeout=120)
    r.raise_for_status()
    with open(tmp, "wb") as fh:
        fh.write(r.content)
    try:
        with netCDF4.Dataset(tmp) as d:
            vals = np.ma.filled(d.variables["data"][0].astype(np.float32), np.nan)
            la = np.ma.filled(d.variables["lat"][:, 0].astype(np.float64), np.nan)
            lo = np.ma.filled(d.variables["lon"][d.variables["lon"].shape[0] // 2, :]
                              .astype(np.float64), np.nan)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    # Find the wrap column and roll so longitude is monotonic from -180.
    d_lo = np.diff(lo)
    wraps = np.where(d_lo < -180)[0]
    if wraps.size:
        shift = -(int(wraps[0]) + 1)
        lo = np.roll(lo, shift)
        vals = np.roll(vals, shift, axis=1)
    # North must be row zero for the PNG. The feed already is, but reading the
    # axis makes it true rather than assumed.
    if la[0] < la[-1]:
        la = la[::-1]
        vals = vals[::-1, :]
    mask = ~np.isfinite(vals)
    vals = np.clip(np.nan_to_num(vals), 0, 255).astype(np.uint8)
    return vals, mask, la, lo


def build_global(only=None, now=None):
    """Every GMGSI product, cropped into every global sector, onto disk."""
    total = 0
    for pkey, spec in GLOBAL_PRODUCTS.items():
        if only and pkey not in only:
            continue
        key, stamp = _gmgsi_latest_key(spec["path"], now)
        if not key:
            log(f"  sat global/{pkey}: nothing listed in {GLOBAL_BUCKET}")
            continue
        fdir = stamp
        # One download serves four sectors, so it is skipped only when every
        # sector already holds this scan.
        missing = [sk for sk in GLOBAL_SECTORS
                   if not os.path.exists(os.path.join(
                       OUT_DIR, "global", sk, fdir, f"{pkey}.json"))]
        if not missing:
            continue
        try:
            vals, mask, la, lo = _gmgsi_read(key)
        except Exception as e:
            log(f"  sat global/{pkey}: {e}")
            continue
        if spec["invert"]:
            vals = (255 - vals.astype(np.int16)).astype(np.uint8)
        for sk in missing:
            sc = GLOBAL_SECTORS[sk]
            yi = np.where((la >= sc["lat"][0]) & (la <= sc["lat"][1]))[0]
            xi = np.where((lo >= sc["lon"][0]) & (lo <= sc["lon"][1]))[0]
            if yi.size < 8 or xi.size < 8:
                continue
            v = vals[yi[0]:yi[-1] + 1, xi[0]:xi[-1] + 1]
            m = mask[yi[0]:yi[-1] + 1, xi[0]:xi[-1] + 1]
            alpha = np.where(m, 0, 255).astype(np.uint8)
            out = os.path.join(OUT_DIR, "global", sk, fdir)
            os.makedirs(out, exist_ok=True)
            bounds = [[float(la[yi[-1]]), float(lo[xi[0]])],
                      [float(la[yi[0]]), float(lo[xi[-1]])]]
            Image.fromarray(np.dstack([v, v, v, alpha]), mode="RGBA").save(
                os.path.join(out, f"{pkey}.png"), optimize=True)
            write_json(os.path.join(out, f"{pkey}.json"),
                       {"stamp": stamp, "bounds": bounds})
            total += 1
        log(f"  sat global/{pkey}: built {stamp} for {len(missing)} sector(s)")

    # The same prune-then-relist the GOES sectors get, so the manifests only
    # ever advertise frames that are really on disk.
    for sk in GLOBAL_SECTORS:
        sector_dir = os.path.join(OUT_DIR, "global", sk)
        if not os.path.isdir(sector_dir):
            continue
        prune(sector_dir)
        products = {}
        for pkey, spec in GLOBAL_PRODUCTS.items():
            frames = _relist_frames(sector_dir, pkey)
            if not frames:
                continue
            newest = frames[-1]
            products[pkey] = {
                "label": spec["label"], "frames": frames,
                "latest": newest["t"], "file": newest["file"],
                "bounds": newest.get("bounds"),
            }
        if products:
            write_json(os.path.join(sector_dir, "manifest.json"),
                       {"updated": datetime.now(timezone.utc).isoformat(),
                        "sector": sk, "sat": "global",
                        "keep_hours": KEEP_HOURS, "products": products})
    return total


def check(now=None):
    """Say what would be fetched and whether the addresses answer.

    Decodes nothing, so it runs without netCDF4 installed and is the right
    first thing to run on a machine that has never built a composite.
    """
    now = now or datetime.now(timezone.utc)
    bad = 0
    for sat_key, sat in SATS.items():
        for sector, spec in SECTORS.items():
            wanted = sorted({b for r in RGB_RECIPES.values()
                             if sector in r["sectors"] for b in r["bands"]})
            found = latest_band_keys(sat["buckets"], sector, wanted, now)
            if not found:
                tried = " or ".join(sat["buckets"])
                print(f"  MISS {sat_key:5s} {sector:9s} no scan with all "
                      f"of {wanted} in {tried}")
                bad += 1
                continue
            bucket, stamp, keys = found
            print(f"  ok   {sat_key:5s} {sector:9s} scan {stamp}, "
                  f"{len(keys)} bands, from {bucket}")
    print("\nEvery sector answered." if not bad
          else f"\n{bad} sector(s) did not answer.")
    return 1 if bad else 0


# What a build actually needs, asked once and up front.
#
# netCDF4 is the reader for the raw band files. Without it every band of every
# recipe fails separately, deep inside build_rgb, with a message about one
# file - so a missing package presents as sixty unrelated-looking failures and
# a run that quietly builds nothing. Asked once, it is one sentence naming the
# package and the command that installs it.
def missing_deps():
    out = []
    for mod, why in (("netCDF4", "reads the raw GOES band files"),
                     ("numpy", "the arithmetic"),
                     ("PIL", "writes the PNG")):
        try:
            __import__(mod)
        except Exception as e:
            out.append((mod, why, f"{e.__class__.__name__}: {e}"))
    return out


# What the last run did, written where the PAGE can read it.
#
# Everything above this only ever reached a log file on a machine nobody logs
# into. A build that cannot run leaves no manifest, the page says "not built
# yet", and that sentence is true for a missing package, a dead bucket and a
# first run alike. Writing the reason down beside the data means the browser
# can say which.
def write_status(**fields):
    try:
        os.makedirs(OUT_DIR, exist_ok=True)
        fields["at"] = datetime.now(timezone.utc).isoformat()
        tmp = os.path.join(OUT_DIR, "status.json.tmp")
        with open(tmp, "w") as fh:
            json.dump(fields, fh)
        os.replace(tmp, os.path.join(OUT_DIR, "status.json"))
    except Exception:
        pass


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--sector", action="append",
                    help="conus, meso1, meso2, fulldisk. Repeatable. "
                         "Default: every sector that is not on-demand.")
    ap.add_argument("--sat", action="append", help="east, west")
    ap.add_argument("--only", action="append", help="one recipe key")
    ap.add_argument("--check", action="store_true",
                    help="probe the addresses and decode nothing")
    a = ap.parse_args(argv)

    if a.check:
        return check()

    gone = missing_deps()
    if gone:
        for mod, why, err in gone:
            log(f"satellite: {mod} is not installed, and it {why} ({err})")
        log("satellite: install it with")
        log(f"  ~/wxenv/bin/pip install {' '.join(m for m, _w, _e in gone)}")
        write_status(ok=False, reason="missing " + ", ".join(m for m, _w, _e in gone),
                     fix=f"~/wxenv/bin/pip install {' '.join(m for m, _w, _e in gone)}",
                     built=0)
        return 1

    sats = a.sat or list(SATS)
    sectors = a.sector or [s for s, spec in SECTORS.items()
                           if not spec.get("on_demand")]
    os.makedirs(OUT_DIR, exist_ok=True)
    total = 0
    t0 = time.time()
    for sat_key in sats:
        if sat_key == "global":
            continue                     # handled below, it is not an ABI bird
        if sat_key not in SATS:
            log(f"unknown satellite {sat_key}")
            continue
        for sector in sectors:
            if sector not in SECTORS:
                log(f"unknown sector {sector}")
                continue
            total += build_sector(sat_key, sector, a.only)
    # The global mosaic rides the same pass. It publishes hourly, and the
    # already-built check makes the passes in between cost one listing each.
    if not a.sat or "global" in a.sat:
        try:
            total += build_global(a.only)
        except Exception as e:
            log(f"satellite: global mosaic failed: {e}")
    log(f"satellite: {total} composite(s) in {time.time() - t0:.0f}s")
    # Nothing built is not automatically a fault: at night the daytime
    # recipes are skipped on purpose and a scan already on disk is not
    # rebuilt. So the status says what happened rather than calling it an
    # error, and the page can tell "working, nothing new" from "broken".
    if total:
        write_status(ok=True, built=total, reason="")
    else:
        write_status(ok=True, built=0,
                     reason="nothing new to build on this pass. At night the "
                            "daytime composites are skipped, and a scan "
                            "already on disk is not built twice.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
