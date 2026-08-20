#!/usr/bin/env python3
"""
Builds forecast-model map overlays on the Pi, so the browser does not have to.

The web app is a static page with no backend, and has to run in the PlayStation
5 browser, which has no WebGL. Both of those rule out doing this work on the
client. So the Pi fetches GRIB2 from NOAA, decodes it, and writes finished PNGs
that Leaflet drops on the map as a plain image overlay. The browser's entire job
becomes displaying a picture.

Measured on the target Pi, with NOAA cropping to CONUS before sending:
    0.52 MB downloaded per forecast hour, about 1 second each
    ~21 MB and ~40 seconds per run, ~83 MB per day
    ~6 MB on disk once old runs are being pruned, because a rendered field is
    mostly flat colour and PNG compresses it hard

Run it from cron every hour. It works out whether there is anything to do and
exits quickly when there is not.
"""

import bz2
import json
import os
import shutil
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone

import numpy as np
import requests
from PIL import Image

# ── Configuration ───────────────────────────────────────────────────────────

# Where the finished PNGs go. This is what the tunnel serves, so it must match
# the directory the web server was pointed at. Deliberately under the home
# directory: cron runs as you, and /var/www is not yours to write to.
OUT_DIR = os.path.expanduser("~/wxdata/models")

# The box NOAA crops to. Longitudes are 0-360 here because that is the
# convention NOMADS expects; they are converted back for the manifest.
BOX = {"toplat": 55.0, "bottomlat": 20.0, "leftlon": 230.0, "rightlon": 300.0}
BOUNDS_LATLON = [[20.0, -130.0], [55.0, -60.0]]   # what Leaflet wants

# The tropics are somewhere else. The box above stops at 20 north, which is
# north of almost everywhere Atlantic storms form: the main development region
# runs roughly 10 to 20 north between Africa and the Caribbean, and a chart
# cropped to the United States shows a hurricane only once it is nearly ashore.
# This one reaches from the equator to 45 north and from the central Pacific to
# west Africa, so it holds both basins the Hurricane Center forecasts, the Gulf
# and the Caribbean, and the wave that is going to become next week's storm.
TROPICS_BOX = {"toplat": 45.0, "bottomlat": 0.0,
               "leftlon": 195.0, "rightlon": 350.0}
TROPICS_BOUNDS = [[0.0, -165.0], [45.0, -10.0]]

# The places the CONUS box leaves out entirely. Each regional model runs over
# its own small domain, and cropping it to the lower 48 would return nothing.
ALASKA_BOX = {"toplat": 72.0, "bottomlat": 50.0,
              "leftlon": 185.0, "rightlon": 232.0}
ALASKA_BOUNDS = [[50.0, -175.0], [72.0, -128.0]]

HAWAII_BOX = {"toplat": 24.0, "bottomlat": 17.0,
              "leftlon": 197.0, "rightlon": 207.0}
HAWAII_BOUNDS = [[17.0, -163.0], [24.0, -153.0]]

# Puerto Rico earns its place twice over: it is a populated domain the CONUS
# box misses, and it sits in the path of most Atlantic hurricanes, so a 3 km
# model over it is a tropical product as much as a regional one.
PRICO_BOX = {"toplat": 22.0, "bottomlat": 15.0,
             "leftlon": 289.0, "rightlon": 300.0}
PRICO_BOUNDS = [[15.0, -71.0], [22.0, -60.0]]

# Where a model can be drawn. A model and a region together make one set of
# pictures; the model says what the forecast is, the region says which part of
# the world it was cut to.
#
# This exists because the same model over two places was two entries in the
# list, and reading "GFS" and "GFS Tropical" as different models is wrong: it
# is one model, cropped twice. Now GFS is one entry with two regions, and the
# page offers the region beside the model rather than hiding it in the name.
REGIONS = {
    "conus":   {"label": "CONUS",       "box": BOX,
                "bounds": BOUNDS_LATLON},
    "tropics": {"label": "Tropics",     "box": TROPICS_BOX,
                "bounds": TROPICS_BOUNDS},
    "alaska":  {"label": "Alaska",      "box": ALASKA_BOX,
                "bounds": ALASKA_BOUNDS},
    "hawaii":  {"label": "Hawaii",      "box": HAWAII_BOX,
                "bounds": HAWAII_BOUNDS},
    "prico":   {"label": "Puerto Rico", "box": PRICO_BOX,
                "bounds": PRICO_BOUNDS},
}


def region_spec(m, key):
    """
    One model over one region, as a single flat definition.

    The region contributes its box, and anything else it names wins over the
    model: a regional nest is a different file from the parent, and the
    tropical crop of a global model wants a longer reach and the shear field
    that only makes sense there.
    """
    spec = dict(m)
    spec.pop("regions", None)
    if m.get("per_storm"):
        # A storm is not a place. There is no box to apply: the model already
        # publishes a small grid that follows the storm, and the bounds come
        # from the data the way they do for everything else.
        spec["storm"] = key
        return spec
    spec.update(REGIONS[key])
    spec.update((m.get("regions") or {}).get(key) or {})
    return spec


# Every model NOAA publishes through the same filter service, which is what
# makes adding one a few lines rather than a new program. They differ only in
# where the files live, how often they run, how far out they go and how long
# after the hour they appear.
#
#   lag    hours after the cycle before the run is on the server
#   step   spacing of forecast hours to fetch
#   out    how far out to go
# What a high resolution model carries. These are the ones people open for a
# storm in the next few hours, and at 3 km over a large box every extra field
# is real money: the fine models are most of the bandwidth bill between them.
# Dewpoint, pressure and column moisture are left to the coarse models, which
# cost almost nothing and are just as good at a field that varies smoothly.
FINE_FIELDS = {"refc", "t2m", "wind", "gust", "apcp", "cape"}


MODELS = {
    "gfs": {
        "label": "GFS", "res": "0.25 deg", "cycle_h": 6, "lag_h": 5,
        "filter": "filter_gfs_0p25.pl",
        "dir": "/gfs.{date}/{cyc}/atmos",
        "file": "gfs.t{cyc}z.pgrb2.0p25.f{fhr:03d}",
        "raw": "gfs/prod/gfs.{date}/{cyc}/atmos/gfs.t{cyc}z.pgrb2.0p25.f{fhr:03d}.idx",
        "step": 3, "out": 120,
        # The tropical crop is not another model, it is this one cut somewhere
        # else and asked different questions: further out, six-hourly, and with
        # the shear field that only means anything over warm water.
        "regions": {"conus": {},
                    "tropics": {"step": 6, "out": 192, "shear": True}},
    },
    "nam": {
        "fetch": "range",
        "label": "NAM", "res": "12 km", "cycle_h": 6, "lag_h": 4,
        "filter": "filter_nam.pl",
        "dir": "/nam.{date}",
        "file": "nam.t{cyc}z.awphys{fhr:02d}.tm00.grib2",
        "raw": "nam/prod/nam.{date}/nam.t{cyc}z.awphys{fhr:02d}.tm00.grib2.idx",
        "step": 3, "out": 60,
        # Backslashes are real characters here, not an escape for this file:
        # the service reads a level name as a regular expression, so brackets
        # have to be escaped for it. They must NOT be percent-encoded in
        # advance either, since the request encoder does that itself.
        "levs": ["lev_2_m_above_ground", "lev_10_m_above_ground",
                 "lev_mean_sea_level", "lev_surface",
                 r"lev_entire_atmosphere_\(considered_as_a_single_layer\)"],
    },
    # NAM's regional nests: the same 12 km NAM run, cropped and re-published
    # under their own filenames for three areas the CONUS file doesn't cover.
    # Same host, same byte-range mechanism, same level list as "nam" above -
    # only the directory/filename differ, so nothing new needed to fetch them.
    "namak": {
        "fetch": "range",
        "label": "NAM Alaska", "res": "6 km", "cycle_h": 6, "lag_h": 4,
        "filter": "filter_nam.pl",
        "dir": "/nam.{date}",
        "file": "nam.t{cyc}z.alaskanest.hiresf{fhr:02d}.tm00.grib2",
        "raw": "nam/prod/nam.{date}/nam.t{cyc}z.alaskanest.hiresf{fhr:02d}.tm00.grib2.idx",
        "step": 3, "out": 60,
        "levs": ["lev_2_m_above_ground", "lev_10_m_above_ground",
                 "lev_mean_sea_level", "lev_surface",
                 r"lev_entire_atmosphere_\(considered_as_a_single_layer\)"],
    },
    "namhi": {
        "fetch": "range",
        "label": "NAM Hawaii", "res": "6 km", "cycle_h": 6, "lag_h": 4,
        "filter": "filter_nam.pl",
        "dir": "/nam.{date}",
        "file": "nam.t{cyc}z.hawaiinest.hiresf{fhr:02d}.tm00.grib2",
        "raw": "nam/prod/nam.{date}/nam.t{cyc}z.hawaiinest.hiresf{fhr:02d}.tm00.grib2.idx",
        "step": 3, "out": 60,
        "levs": ["lev_2_m_above_ground", "lev_10_m_above_ground",
                 "lev_mean_sea_level", "lev_surface",
                 r"lev_entire_atmosphere_\(considered_as_a_single_layer\)"],
    },
    "nampr": {
        "fetch": "range",
        "label": "NAM Puerto Rico", "res": "6 km", "cycle_h": 6, "lag_h": 4,
        "filter": "filter_nam.pl",
        "dir": "/nam.{date}",
        "file": "nam.t{cyc}z.priconest.hiresf{fhr:02d}.tm00.grib2",
        "raw": "nam/prod/nam.{date}/nam.t{cyc}z.priconest.hiresf{fhr:02d}.tm00.grib2.idx",
        "step": 3, "out": 60,
        "levs": ["lev_2_m_above_ground", "lev_10_m_above_ground",
                 "lev_mean_sea_level", "lev_surface",
                 r"lev_entire_atmosphere_\(considered_as_a_single_layer\)"],
    },
    # ── Same-directory variants of models already proven to build ──────────
    # These carry the strongest evidence available without probing NOAA: the
    # directory itself is one this pipeline already fetches from successfully
    # every cycle, and only the filename changes, following NOAA's own
    # resolution/product naming inside that directory. Run check_models.py
    # against them before trusting any of it.
    "gfs0p50": {
        "label": "GFS 0.5 deg", "res": "0.5 deg", "cycle_h": 6, "lag_h": 5,
        "filter": "filter_gfs_0p50.pl",
        "dir": "/gfs.{date}/{cyc}/atmos",
        "file": "gfs.t{cyc}z.pgrb2.0p50.f{fhr:03d}",
        "raw": "gfs/prod/gfs.{date}/{cyc}/atmos/gfs.t{cyc}z.pgrb2.0p50.f{fhr:03d}.idx",
        "step": 3, "out": 180,
        "regions": {"conus": {},
                    "tropics": {"step": 6, "out": 240, "shear": True}},
    },
    "gfs1p00": {
        # The cheapest global field here by a wide margin, which is the point:
        # a coarse look much further out for almost no bandwidth.
        "label": "GFS 1.0 deg", "res": "1.0 deg", "cycle_h": 6, "lag_h": 5,
        "filter": "filter_gfs_1p00.pl",
        "dir": "/gfs.{date}/{cyc}/atmos",
        "file": "gfs.t{cyc}z.pgrb2.1p00.f{fhr:03d}",
        "raw": "gfs/prod/gfs.{date}/{cyc}/atmos/gfs.t{cyc}z.pgrb2.1p00.f{fhr:03d}.idx",
        "step": 6, "out": 240,
        "regions": {"conus": {},
                    "tropics": {"out": 384, "shear": True}},
    },
    "nam32": {
        # NAM on its wider 32 km grid: the same run as "nam" above, published
        # over a domain that reaches well past the CONUS cut.
        "fetch": "range",
        "label": "NAM 32 km", "res": "32 km", "cycle_h": 6, "lag_h": 4,
        "filter": "filter_nam.pl",
        "dir": "/nam.{date}",
        "file": "nam.t{cyc}z.awip32{fhr:02d}.tm00.grib2",
        "raw": "nam/prod/nam.{date}/nam.t{cyc}z.awip32{fhr:02d}.tm00.grib2.idx",
        "step": 3, "out": 84,
        "levs": ["lev_2_m_above_ground", "lev_10_m_above_ground",
                 "lev_mean_sea_level", "lev_surface",
                 r"lev_entire_atmosphere_\(considered_as_a_single_layer\)"],
    },
    "hrefpmmn": {
        # Probability matched mean: the ensemble's average intensity put back
        # onto a realistic storm-shaped field, so peaks survive the averaging
        # that flattens a plain mean. For "how hard will it actually come
        # down" this is the member of the HREF family worth reading.
        "fetch": "range", "fields": FINE_FIELDS,
        "label": "HREF PMM", "res": "3 km ens", "cycle_h": 6, "lag_h": 4,
        "dir": "/href.{date}/ensprod",
        "file": "href.t{cyc}z.conus.pmmn.f{fhr:02d}.grib2",
        "raw": "href/prod/href.{date}/ensprod/"
               "href.t{cyc}z.conus.pmmn.f{fhr:02d}.grib2.idx",
        "step": 3, "first": 1, "out": 48,
    },
    "hrefsprd": {
        # How much the members disagree, which is the honest measure of how
        # much to trust the mean beside it.
        "fetch": "range", "fields": FINE_FIELDS,
        "label": "HREF spread", "res": "3 km ens", "cycle_h": 6, "lag_h": 4,
        "dir": "/href.{date}/ensprod",
        "file": "href.t{cyc}z.conus.sprd.f{fhr:02d}.grib2",
        "raw": "href/prod/href.{date}/ensprod/"
               "href.t{cyc}z.conus.sprd.f{fhr:02d}.grib2.idx",
        "step": 3, "first": 1, "out": 48,
        "ranges": {"t2m": (0, 8), "apcp": (0, 20), "wind": (0, 20)},
        "ramp": "spread",
    },
    "gefsc00": {
        # The ensemble's control run: one unperturbed member, useful beside
        # the mean because it is a real single forecast rather than an
        # average of many.
        "label": "GEFS control", "res": "0.5 deg ens", "cycle_h": 6, "lag_h": 7,
        "filter": "filter_gefs_atmos_0p50a.pl",
        "dir": "/gefs.{date}/{cyc}/atmos/pgrb2ap5",
        "file": "gec00.t{cyc}z.pgrb2a.0p50.f{fhr:03d}",
        "raw": "gens/prod/gefs.{date}/{cyc}/atmos/pgrb2ap5/"
               "gec00.t{cyc}z.pgrb2a.0p50.f{fhr:03d}.idx",
        "step": 6, "out": 168,
        "vars": ["var_TMP", "var_UGRD", "var_VGRD", "var_PRMSL", "var_APCP"],
        "levs": ["lev_2_m_above_ground", "lev_10_m_above_ground",
                 "lev_mean_sea_level", "lev_surface"],
        "regions": {"conus": {}, "tropics": {"out": 240, "shear": True}},
    },
    "gefsp01": {
        "label": "GEFS member 1", "res": "0.5 deg ens", "cycle_h": 6, "lag_h": 7,
        "filter": "filter_gefs_atmos_0p50a.pl",
        "dir": "/gefs.{date}/{cyc}/atmos/pgrb2ap5",
        "file": "gep01.t{cyc}z.pgrb2a.0p50.f{fhr:03d}",
        "raw": "gens/prod/gefs.{date}/{cyc}/atmos/pgrb2ap5/"
               "gep01.t{cyc}z.pgrb2a.0p50.f{fhr:03d}.idx",
        "step": 6, "out": 168,
        "vars": ["var_TMP", "var_UGRD", "var_VGRD", "var_PRMSL", "var_APCP"],
        "levs": ["lev_2_m_above_ground", "lev_10_m_above_ground",
                 "lev_mean_sea_level", "lev_surface"],
        "regions": {"conus": {}, "tropics": {"out": 240, "shear": True}},
    },
    # ── Regional analyses and blends, on NOAA's regional naming ────────────
    # Same shape as their CONUS parents above, on the per-area directories
    # NOAA publishes them under. Lower confidence than the same-directory
    # variants: the directory itself is the part being guessed, so a wrong
    # one shows up as a skipped model rather than a broken build.
    "rtmaak": {
        "label": "RTMA Alaska (now)", "res": "3 km analysis", "cycle_h": 1, "lag_h": 1,
        "filter": "filter_akrtma.pl",
        "dir": "/akrtma.{date}",
        "file": "akrtma.t{cyc}z.2dvaranl_ndfd_3p0.grb2",
        "raw": "rtma/prod/akrtma.{date}/akrtma.t{cyc}z.2dvaranl_ndfd_3p0.grb2.idx",
        "fetch": "range", "step": 1, "out": 0,
    },
    "rtmahi": {
        "label": "RTMA Hawaii (now)", "res": "2.5 km analysis", "cycle_h": 1, "lag_h": 1,
        "filter": "filter_hirtma.pl",
        "dir": "/hirtma.{date}",
        "file": "hirtma.t{cyc}z.2dvaranl_ndfd.grb2",
        "raw": "rtma/prod/hirtma.{date}/hirtma.t{cyc}z.2dvaranl_ndfd.grb2.idx",
        "fetch": "range", "step": 1, "out": 0,
    },
    "rtmapr": {
        "label": "RTMA Puerto Rico (now)", "res": "2.5 km analysis", "cycle_h": 1, "lag_h": 1,
        "filter": "filter_prrtma.pl",
        "dir": "/prrtma.{date}",
        "file": "prrtma.t{cyc}z.2dvaranl_ndfd.grb2",
        "raw": "rtma/prod/prrtma.{date}/prrtma.t{cyc}z.2dvaranl_ndfd.grb2.idx",
        "fetch": "range", "step": 1, "out": 0,
    },
    "nbmak": {
        "label": "NBM Alaska", "res": "3 km blend", "cycle_h": 6, "lag_h": 2,
        "filter": "filter_blend.pl",
        "dir": "/blend.{date}/{cyc}/core",
        "file": "blend.t{cyc}z.core.f{fhr:03d}.ak.grib2",
        "raw": "blend/prod/blend.{date}/{cyc}/core/"
               "blend.t{cyc}z.core.f{fhr:03d}.ak.grib2.idx",
        "fetch": "range", "first": 3, "step": 3, "out": 120,
    },
    "nbmhi": {
        "label": "NBM Hawaii", "res": "2.5 km blend", "cycle_h": 6, "lag_h": 2,
        "filter": "filter_blend.pl",
        "dir": "/blend.{date}/{cyc}/core",
        "file": "blend.t{cyc}z.core.f{fhr:03d}.hi.grib2",
        "raw": "blend/prod/blend.{date}/{cyc}/core/"
               "blend.t{cyc}z.core.f{fhr:03d}.hi.grib2.idx",
        "fetch": "range", "first": 3, "step": 3, "out": 120,
    },
    "hrrr": {
        "fetch": "range",
        # Hourly and 3 km: the one worth having when something is happening
        # right now, which is why it is fetched hourly and only 18 hours out.
        "fields": FINE_FIELDS,
        "label": "HRRR", "res": "3 km", "cycle_h": 1, "lag_h": 2,
        "filter": "filter_hrrr_2d.pl",
        "dir": "/hrrr.{date}/conus",
        "file": "hrrr.t{cyc}z.wrfsfcf{fhr:02d}.grib2",
        "raw": "hrrr/prod/hrrr.{date}/conus/hrrr.t{cyc}z.wrfsfcf{fhr:02d}.grib2.idx",
        "step": 1, "out": 18,
        # Alaska is its own file on its own cadence, not a different crop of
        # the same one, so the region replaces the address as well as the box.
        "regions": {
            "conus": {},
            "alaska": {
                "dir": "/hrrr.{date}/alaska",
                "file": "hrrr.t{cyc}z.wrfsfcf{fhr:02d}.ak.grib2",
                "raw": "hrrr/prod/hrrr.{date}/alaska/"
                       "hrrr.t{cyc}z.wrfsfcf{fhr:02d}.ak.grib2.idx",
                "cycle_h": 3, "step": 3, "out": 48,
            },
        },
        "levs": ["lev_2_m_above_ground", "lev_10_m_above_ground",
                 "lev_mean_sea_level", "lev_surface",
                 "lev_entire_atmosphere"],
    },
    "gefs": {
        # The ensemble mean: 30-odd runs of the same model averaged, which is
        # steadier than any single run beyond a couple of days.
        "label": "GEFS mean", "res": "0.5 deg ens", "cycle_h": 6, "lag_h": 7,
        "filter": "filter_gefs_atmos_0p50a.pl",
        "dir": "/gefs.{date}/{cyc}/atmos/pgrb2ap5",
        "file": "geavg.t{cyc}z.pgrb2a.0p50.f{fhr:03d}",
        "raw": "gens/prod/gefs.{date}/{cyc}/atmos/pgrb2ap5/"
               "geavg.t{cyc}z.pgrb2a.0p50.f{fhr:03d}.idx",
        "step": 6, "out": 168,
        "vars": ["var_TMP", "var_UGRD", "var_VGRD", "var_PRMSL", "var_APCP"],
        "levs": ["lev_2_m_above_ground", "lev_10_m_above_ground",
                 "lev_mean_sea_level", "lev_surface"],
        "regions": {"conus": {},
                    "tropics": {"out": 240, "shear": True}},
    },
    "gefsspr": {
        # The spread: how far apart those runs are. High spread is the model
        # telling you it does not know, which a single deterministic chart
        # cannot say at all, and is the useful half of an ensemble.
        "label": "GEFS spread", "res": "0.5 deg ens", "cycle_h": 6, "lag_h": 7,
        "filter": "filter_gefs_atmos_0p50a.pl",
        "dir": "/gefs.{date}/{cyc}/atmos/pgrb2ap5",
        "file": "gespr.t{cyc}z.pgrb2a.0p50.f{fhr:03d}",
        "raw": "gens/prod/gefs.{date}/{cyc}/atmos/pgrb2ap5/"
               "gespr.t{cyc}z.pgrb2a.0p50.f{fhr:03d}.idx",
        "step": 6, "out": 168,
        "vars": ["var_TMP", "var_UGRD", "var_VGRD", "var_PRMSL", "var_APCP"],
        "levs": ["lev_2_m_above_ground", "lev_10_m_above_ground",
                 "lev_mean_sea_level", "lev_surface"],
        # Spread is a distance, never negative, and small: its own scale.
        "ranges": {"t2m": (0, 12), "d2m": (0, 12), "mslp": (0, 12),
                   "wind": (0, 25), "apcp": (0, 25)},
        "ramp": "spread",
    },
    "rap": {
        "fetch": "range",
        # Fills the gap HRRR leaves. HRRR is sharper but stops at 18 hours;
        # RAP is the same idea at 13 km and runs every hour as well, so there
        # is always something hourly and recent past the end of HRRR.
        "label": "RAP", "res": "13 km", "cycle_h": 1, "lag_h": 2,
        "filter": "filter_rap.pl",
        "dir": "/rap.{date}",
        "file": "rap.t{cyc}z.awp130pgrbf{fhr:02d}.grib2",
        "raw": "rap/prod/rap.{date}/rap.t{cyc}z.awp130pgrbf{fhr:02d}.grib2.idx",
        "step": 1, "out": 21,
    },
    "namnest": {
        "fields": FINE_FIELDS,
        "fetch": "range",
        # HRRR's resolution, three times HRRR's reach. The 3 km nest inside
        # NAM: the same 12 km model run again over a smaller box at a grid
        # fine enough to resolve individual storms, out to 60 hours.
        "label": "NAM Nest", "res": "3 km", "cycle_h": 6, "lag_h": 4,
        "filter": "filter_nam_conusnest.pl",
        "dir": "/nam.{date}",
        "file": "nam.t{cyc}z.conusnest.hiresf{fhr:02d}.tm00.grib2",
        "raw": "nam/prod/nam.{date}/nam.t{cyc}z.conusnest.hiresf{fhr:02d}"
               ".tm00.grib2.idx",
        "step": 3, "out": 60,
        # Four domains of the same nest, which is how NOAA publishes them: one
        # model run four times over four boxes, not four models.
        "regions": {
            "conus": {},
            "alaska": {
                "file": "nam.t{cyc}z.alaskanest.hiresf{fhr:02d}.tm00.grib2",
                "raw": "nam/prod/nam.{date}/"
                       "nam.t{cyc}z.alaskanest.hiresf{fhr:02d}.tm00.grib2.idx"},
            "hawaii": {
                "file": "nam.t{cyc}z.hawaiinest.hiresf{fhr:02d}.tm00.grib2",
                "raw": "nam/prod/nam.{date}/"
                       "nam.t{cyc}z.hawaiinest.hiresf{fhr:02d}.tm00.grib2.idx"},
            "prico": {
                "file": "nam.t{cyc}z.priconest.hiresf{fhr:02d}.tm00.grib2",
                "raw": "nam/prod/nam.{date}/"
                       "nam.t{cyc}z.priconest.hiresf{fhr:02d}.tm00.grib2.idx"},
        },
    },
    "nbm": {
        # Not a model. The National Blend of Models is the Weather Service's
        # own combination of many models, corrected against what actually
        # verified, and it is what a great deal of the official forecast is
        # built from. For "what is the temperature going to be" it beats any
        # single model here, which is the whole point of carrying it.
        # NBM publishes every hour, but this takes it four times a day. It is
        # a five day forecast built by blending and bias-correcting other
        # models, and it does not meaningfully change in an hour, so fetching
        # 41 forecast hours of 2.5 km data every hour would be by far the
        # largest thing here in exchange for almost nothing.
        "label": "NBM", "res": "2.5 km blend", "cycle_h": 6, "lag_h": 2,
        "filter": "filter_blend.pl",
        "dir": "/blend.{date}/{cyc}/core",
        "file": "blend.t{cyc}z.core.f{fhr:03d}.co.grib2",
        "raw": "blend/prod/blend.{date}/{cyc}/core/"
               "blend.t{cyc}z.core.f{fhr:03d}.co.grib2.idx",
        "fetch": "range",
        "first": 3, "step": 3, "out": 120,
    },
    "rtma": {
        # The odd one out: an analysis, not a forecast. One frame, F+000, of
        # what the Weather Service believes is happening right now at 2.5 km,
        # built from observations rather than projected forward. Useful as the
        # thing to check a forecast against.
        "label": "RTMA (now)", "res": "2.5 km analysis", "cycle_h": 1,
        "lag_h": 1,
        "filter": "filter_rtma2p5.pl",
        "dir": "/rtma2p5.{date}",
        "file": "rtma2p5.t{cyc}z.2dvaranl_ndfd.grb2",
        "raw": [
            "rtma/prod/rtma2p5.{date}/rtma2p5.t{cyc}z.2dvaranl_ndfd.grb2.idx",
            "rtma/prod/rtma2p5.{date}/rtma2p5.t{cyc}z.2dvaranl_ndfd.grb2_wexp.idx",
            "rtma/prod/rtma2p5.{date}/rtma2p5.t{cyc}z.varanl.grb2.idx",
            "urma/prod/urma2p5.{date}/urma2p5.t{cyc}z.2dvaranl_ndfd.grb2.idx",
        ],
        "fetch": "range",
        "step": 1, "out": 0,
    },
    # ── Tropical ────────────────────────────────────────────────────────────
    # The same GFS file, cropped somewhere else and asked different questions.
    # A tropical chart is not a CONUS chart moved south: what matters is
    # moisture, shear and sea temperature rather than the two metre
    # temperature, and it matters a week out rather than tomorrow, so this
    # steps six-hourly and runs to eight days where the CONUS one stops at
    # five.
    "gfswave": {
        # Waves, which reach a coast days before the storm that made them.
        # Long period swell running ahead of a hurricane is what closes
        # beaches and floods low ground while the sky is still clear, and it
        # is the part of a tropical forecast that is easiest to miss.
        "label": "Waves", "res": "0.16 deg", "cycle_h": 6, "lag_h": 5,
        "filter": "filter_gfswave.pl",
        "dir": "/gfs.{date}/{cyc}/wave/gridded",
        "file": "gfswave.t{cyc}z.global.0p16.f{fhr:03d}.grib2",
        "raw": "gfs/prod/gfs.{date}/{cyc}/wave/gridded/"
               "gfswave.t{cyc}z.global.0p16.f{fhr:03d}.grib2.idx",
        "step": 6, "out": 120,
        "regions": {"tropics": {}},
    },
    # ── Two more opinions at 3 km ───────────────────────────────────────────
    # The High Resolution Window: the same box run by two different models,
    # ARW and FV3. Their value is precisely that they are not HRRR, so when
    # all three put a storm in the same place that is worth more than any one
    # of them saying it twice.
    "hireswarw": {
        "fields": FINE_FIELDS,
        "fetch": "range",
        "label": "HiResW ARW", "res": "5 km", "cycle_h": 12, "lag_h": 4,
        "filter": "filter_hiresw.pl",
        "dir": "/hiresw.{date}",
        "file": "hiresw.t{cyc}z.arw_5km.f{fhr:02d}.conus.grib2",
        "raw": "hiresw/prod/hiresw.{date}/"
               "hiresw.t{cyc}z.arw_5km.f{fhr:02d}.conus.grib2.idx",
        "step": 3, "out": 48,
    },
    "hireswfv3": {
        "fields": FINE_FIELDS,
        "fetch": "range",
        "label": "HiResW FV3", "res": "5 km", "cycle_h": 12, "lag_h": 4,
        "filter": "filter_hiresw.pl",
        "dir": "/hiresw.{date}",
        "file": "hiresw.t{cyc}z.fv3_5km.f{fhr:02d}.conus.grib2",
        "raw": "hiresw/prod/hiresw.{date}/"
               "hiresw.t{cyc}z.fv3_5km.f{fhr:02d}.conus.grib2.idx",
        "step": 3, "out": 48,
    },

    # ── The places the main box leaves out ──────────────────────────────────

    # ── Not from NOAA ───────────────────────────────────────────────────────
    # ECMWF, which is generally the best global model there is, and which has
    # published a free 0.25 degree forecast since 2024. It is fetched
    # differently from everything above: there is no service to crop it, so
    # the whole world arrives and the box is cut out here after decoding. What
    # makes that affordable is the index file published beside each forecast
    # hour, which gives a byte range per field, so only the handful of fields
    # wanted are downloaded rather than the whole 100 MB file.
    "ecmwf": {
        "label": "ECMWF", "res": "0.25 deg", "cycle_h": 12, "lag_h": 8,
        "source": "ecmwf",
        "step": 6, "out": 144,
        "crop": True,
        "regions": {"conus": {},
                    "tropics": {"out": 240, "shear": True}},
    },

    # ── More of the same, from your list ────────────────────────────────────
    "href": {
        # The convection allowing ensemble: HRRR, NAM Nest and the window
        # models run together and averaged. For "will a storm actually happen
        # here" it is worth more than any single one of them, which is the
        # same argument as the blend but for the next day rather than the next
        # five.
        "fetch": "range", "fields": FINE_FIELDS,
        "label": "HREF mean", "res": "3 km ens", "cycle_h": 6, "lag_h": 4,
        "dir": "/href.{date}/ensprod",
        "file": "href.t{cyc}z.conus.mean.f{fhr:02d}.grib2",
        "raw": "href/prod/href.{date}/ensprod/"
               "href.t{cyc}z.conus.mean.f{fhr:02d}.grib2.idx",
        "step": 3, "first": 1, "out": 48,
    },
    "hireswarw2": {
        # The second ARW member. A different starting guess of the same model,
        # which is exactly what makes it worth having beside the first.
        "fetch": "range", "fields": FINE_FIELDS,
        "label": "HiResW ARW 2", "res": "5 km", "cycle_h": 12, "lag_h": 4,
        "dir": "/hiresw.{date}",
        "file": "hiresw.t{cyc}z.arw_5km.f{fhr:02d}.conusmem2.grib2",
        "raw": "hiresw/prod/hiresw.{date}/"
               "hiresw.t{cyc}z.arw_5km.f{fhr:02d}.conusmem2.grib2.idx",
        "step": 3, "out": 48,
    },
    "rrfs": {
        # The model meant to replace HRRR and RAP with one thing. Still being
        # brought up, so the name it is published under has moved more than
        # once, and all the spellings seen so far are tried.
        "fetch": "range", "fields": FINE_FIELDS,
        "label": "RRFS", "res": "3 km", "cycle_h": 1, "lag_h": 2,
        # There is no prod/ under com/rrfs/: the listing shows only v1.0/ and
        # para/, because the model has not been declared operational yet. v1.0
        # is the one being fed, para is the experimental one beside it.
        "raw": [
            "rrfs/v1.0/rrfs.{date}/{cyc}/"
            "rrfs.t{cyc}z.prslev.f{fhr:03d}.conus_3km.grib2.idx",
            "rrfs/para/rrfs.{date}/{cyc}/"
            "rrfs.t{cyc}z.prslev.f{fhr:03d}.conus_3km.grib2.idx",
            "rrfs_a/prod/rrfs_a.{date}/{cyc}/"
            "rrfs.t{cyc}z.prslev.f{fhr:03d}.conus_3km.grib2.idx",
        ],
        "step": 3, "out": 18,
    },
    "hrrrsub": {
        # HRRR again at fifteen minute steps rather than hourly. Only useful
        # inside the next few hours, which is why it stops at six.
        "fetch": "range", "fields": FINE_FIELDS,
        "label": "HRRR Sub-Hourly", "res": "3 km", "cycle_h": 1, "lag_h": 2,
        "raw": "hrrr/prod/hrrr.{date}/conus/"
               "hrrr.t{cyc}z.wrfsubhf{fhr:02d}.grib2.idx",
        "step": 1, "first": 1, "out": 6,
    },
    "ecmwfaifs": {
        # ECMWF's machine learned model, running beside their physical one and
        # on several measures beating it. Same files, same index, one word
        # different in the path.
        "label": "ECMWF AIFS", "res": "0.25 deg AI", "cycle_h": 12, "lag_h": 8,
        "source": "ecmwf", "ecmwf_model": "aifs-single",
        "step": 6, "out": 144, "crop": True,
        "regions": {"conus": {}, "tropics": {"out": 240, "shear": True}},
    },
    "ecmwfens": {
        # The ensemble mean, from the enfo stream. Published as type "em"
        # rather than "fc", which is the only real difference in the address.
        "label": "ECMWF ENS mean", "res": "0.25 deg ens", "cycle_h": 12,
        "lag_h": 9,
        "source": "ecmwf", "ecmwf_stream": "enfo", "ecmwf_type": "em",
        # An ensemble mean at step 0 is just the analysis, which ECMWF does not
        # publish as "em", so hour 0 would 404 every run. Start at the first
        # forecast step, where the mean actually exists.
        "first": 6, "step": 6, "out": 240, "crop": True,
        "regions": {"conus": {}, "tropics": {"shear": True}},
    },

    # ── Not from NOAA and not from ECMWF ────────────────────────────────────
    "gem": {
        # Environment Canada's global model. Published on a plain latitude and
        # longitude grid, which most global models are not, so it needs no
        # regridding. One file per field per hour and no index, so each field
        # is its own request.
        "label": "GEM Global", "res": "0.24 deg", "cycle_h": 12, "lag_h": 5,
        "source": "gem", "crop": True,
        "step": 6, "out": 168,
        "regions": {"conus": {}, "tropics": {"out": 240}},
    },
    "icon": {
        # DWD's global model, and a genuinely good one. Awkward in two ways:
        # every file is bz2 compressed, and the grid is icosahedral, which is
        # to say triangles on a sphere rather than rows and columns. The
        # regridder already handles a grid that is not rows and columns, since
        # HRRR is not either, so this falls out of that.
        "label": "ICON Global", "res": "0.125 deg", "cycle_h": 12, "lag_h": 5,
        "source": "icon", "crop": True,
        "step": 6, "out": 120,
        "regions": {"conus": {}, "tropics": {}},
    },
    "hafs": {
        # The hurricane model. Unlike everything else here it is not published
        # on a fixed domain: there is one run per active storm, on a grid that
        # follows that storm, and when nothing is out there it does not run at
        # all. So its regions are worked out at build time from the Hurricane
        # Center's own list of what is active, and the bounds come from the
        # data, which they already did for every model.
        "fetch": "range", "per_storm": True,
        "label": "HAFS-A", "res": "storm following", "cycle_h": 6, "lag_h": 5,
        "raw": "hafs/prod/hfsa.{date}/{cyc}/"
               "{storm}.{date}{cyc}.hfsa.parent.atm.f{fhr:03d}.grb2.idx",
        "step": 3, "out": 72,
    },
    "hafsb": {
        "fetch": "range", "per_storm": True,
        "label": "HAFS-B", "res": "storm following", "cycle_h": 6, "lag_h": 5,
        "raw": "hafs/prod/hfsb.{date}/{cyc}/"
               "{storm}.{date}{cyc}.hfsb.parent.atm.f{fhr:03d}.grb2.idx",
        "step": 3, "out": 72,
    },
    "hwrf": {
        # Still running alongside HAFS on your reference site, so carried
        # rather than assumed retired. Storm following, like HAFS, and the
        # exact filename is the part worth checking: scan_sources.py hur will
        # print what is really there.
        "fetch": "range", "per_storm": True,
        "label": "HWRF", "res": "storm following", "cycle_h": 6, "lag_h": 5,
        "raw": [
            "hur/prod/hwrf.{date}{cyc}/"
            "{storm}.{date}{cyc}.hwrfprs.storm.0p015.f{fhr:03d}.grb2.idx",
            "hur/prod/hwrf.{date}{cyc}/"
            "{storm}.{date}{cyc}.hwrfprs.core.0p02.f{fhr:03d}.grb2.idx",
            "hur/prod/hwrf.{date}{cyc}/"
            "{storm}.{date}{cyc}.hwrfprs.synoptic.0p125.f{fhr:03d}.grb2.idx",
        ],
        "step": 3, "out": 72,
    },
    "hmon": {
        "fetch": "range", "per_storm": True,
        "label": "HMON", "res": "storm following", "cycle_h": 6, "lag_h": 5,
        "raw": [
            "hur/prod/hmon.{date}{cyc}/"
            "{storm}.{date}{cyc}.hmon.trk.grbf{fhr:02d}.grb2.idx",
            "hur/prod/hmon.{date}{cyc}/"
            "{storm}.{date}{cyc}.hmonprs.grb2f{fhr:02d}.idx",
            "hur/prod/hmon.{date}{cyc}/"
            "{storm}.{date}{cyc}.hmon.grb2f{fhr:02d}.idx",
        ],
        "step": 3, "out": 72,
    },
    # ── The rest of the list, where it is free and fits ─────────────────────
    "rrfssub": {
        "fetch": "range", "fields": FINE_FIELDS,
        "label": "RRFS Sub-Hourly", "res": "3 km", "cycle_h": 1, "lag_h": 2,
        "raw": ["rrfs/v1.0/rrfs.{date}/{cyc}/"
                "rrfs.t{cyc}z.prslev.f{fhr:03d}.subh.conus_3km.grib2.idx",
                "rrfs/para/rrfs.{date}/{cyc}/"
                "rrfs.t{cyc}z.prslev.f{fhr:03d}.subh.conus_3km.grib2.idx"],
        "first": 1, "step": 1, "out": 6,
    },
    "rrfsfire": {
        # The fire weather nest, run over wherever the fire weather is, which
        # is why its domain moves and its bounds come from the data.
        "fetch": "range", "fields": FINE_FIELDS,
        "label": "RRFS FireWx", "res": "3 km", "cycle_h": 6, "lag_h": 3,
        "raw": ["rrfs/v1.0/rrfs.{date}/{cyc}/"
                "rrfs.t{cyc}z.prslev.f{fhr:03d}.firewx.grib2.idx",
                "rrfs/para/rrfs.{date}/{cyc}/"
                "rrfs.t{cyc}z.prslev.f{fhr:03d}.firewx.grib2.idx"],
        "step": 3, "out": 36,
    },
    "gefswave": {
        # Byte ranges rather than the filter service. There is no
        # filter_gefs_wave.pl on NOMADS, which is why every request 404'd, but
        # the index beside the file is there and holds all 23 messages. So the
        # data was always reachable; only the door being knocked on was wrong.
        "fetch": "range",
        "label": "GEFS Wave", "res": "0.25 deg ens", "cycle_h": 6, "lag_h": 7,
        # The wave directory holds the members, not a mean: the listing shows
        # c00 (the control run) and p01..p30, and no "mean" file at all. The
        # control member is the one to take, so that is what is asked for.
        "raw": "gens/prod/gefs.{date}/{cyc}/wave/gridded/"
               "gefs.wave.t{cyc}z.c00.global.0p25.f{fhr:03d}.grib2.idx",
        "step": 6, "out": 120,
        "regions": {"tropics": {}},
    },
    "ecmwfwave": {
        # ECMWF's wave model, which is the same files one stream over.
        "label": "ECMWF Wave", "res": "0.25 deg", "cycle_h": 12, "lag_h": 8,
        "source": "ecmwf", "ecmwf_stream": "wave", "ecmwf_type": "wf",
        "step": 6, "out": 144, "crop": True,
        "regions": {"tropics": {}},
    },
    "aqm": {
        # Air quality: the ozone and fine particulate the health advisories
        # are written against, on the same 5 km grid the AirNow map uses.
        # Whole files rather than byte ranges, because the listing proved there
        # are no indexes to range against. Affordable here for the reason it
        # would not be for a 3 km model: one file is a single surface field and
        # holds every hour at once, so a run is two downloads.
        "source": "aqm", "crop": True,
        "fields": {"ozone", "pm25"},
        "label": "AQM Air Quality", "res": "5 km",
        # Once a day, on the 12z run. Each file is about 90 MB because it holds
        # every forecast hour, and we render one, so four runs a day cost 700 MB
        # to redraw the same two pictures. Air quality does not move like a
        # thunderstorm: between one run and the next it barely changes, so the
        # other three were paying full price for almost nothing.
        "cycle_h": 24, "cycle_offset": 12, "lag_h": 3,
        "step": 1, "out": 0,
    },
    "etss": {
        # Extratropical storm surge: water above the normal tide, which is the
        # number that floods a coast. The wind is what a storm is named for,
        # this is what does most of the damage.
        "fetch": "range", "fields": {"surge"},
        "label": "ETSS Storm Surge", "res": "surge", "cycle_h": 6, "lag_h": 3,
        "raw": ["etss/prod/etss.{date}/"
                "etss.t{cyc}z.stormsurge.con.grib2.idx",
                "estofs/prod/estofs.{date}/"
                "estofs.atl.t{cyc}z.fields.cwl.grib2.idx"],
        "step": 1, "out": 0,
    },
    "hrdps": {
        "label": "HRDPS", "res": "2.5 km", "cycle_h": 6, "lag_h": 4,
        "source": "hrdps", "crop": True,
        "step": 3, "out": 48,
    },
    "rdps": {
        "label": "RDPS", "res": "10 km", "cycle_h": 6, "lag_h": 4,
        "source": "rdps", "crop": True,
        "step": 3, "out": 84,
    },
    "iconeu": {
        "label": "ICON EU", "res": "0.0625 deg", "cycle_h": 6, "lag_h": 4,
        "source": "iconeu", "crop": True,
        "step": 3, "out": 78,
        # Europe only, so the box is Europe rather than the United States.
        "box": {"toplat": 70.0, "bottomlat": 34.0,
                "leftlon": 348.0, "rightlon": 400.0},
        "bounds": [[34.0, -12.0], [70.0, 40.0]],
        "regions": {"conus": {}},
    },
    "icond2": {
        "label": "ICON D2", "res": "2.2 km", "cycle_h": 3, "lag_h": 3,
        "source": "icond2", "crop": True,
        "step": 1, "out": 27,
        "box": {"toplat": 56.0, "bottomlat": 44.0,
                "leftlon": 358.0, "rightlon": 378.0},
        "bounds": [[44.0, -2.0], [56.0, 18.0]],
        "regions": {"conus": {}},
    },
    "hireswnssl": {
        # The NSSL member of the window, which is the third opinion at that
        # resolution after the two ARW runs and FV3.
        "fetch": "range", "fields": FINE_FIELDS,
        "label": "HiResW NSSL", "res": "5 km", "cycle_h": 12, "lag_h": 4,
        "raw": ["hiresw/prod/hiresw.{date}/"
                "hiresw.t{cyc}z.nssl_5km.f{fhr:02d}.conus.grib2.idx",
                "hiresw/prod/hiresw.{date}/"
                "hiresw.t{cyc}z.arw_5km.f{fhr:02d}.conusnssl.grib2.idx"],
        "step": 3, "out": 48,
    },
    "cmce": {
        # The Canadian ensemble, carried on NOAA's server as half of NAEFS.
        # Worth having beside GEFS for the same reason two deterministic
        # models are worth more than one: when two ensembles from different
        # centres agree, that is a stronger statement than either alone.
        "label": "CMCE mean", "res": "0.5 deg ens", "cycle_h": 12, "lag_h": 8,
        "filter": "filter_cmcens.pl",
        "dir": "/cmce.{date}/{cyc}/pgrb2ap5",
        "file": "cmc_geavg.t{cyc}z.pgrb2a.0p50.f{fhr:03d}",
        "raw": "naefs/prod/cmce.{date}/{cyc}/pgrb2ap5/"
               "cmc_geavg.t{cyc}z.pgrb2a.0p50.f{fhr:03d}.idx",
        "step": 6, "out": 240,
        "regions": {"conus": {}, "tropics": {"shear": True}},
    },
    "iconeps": {
        # DWD's ensemble mean, on the same server and in the same shape as
        # their deterministic one.
        "label": "ICON EPS mean", "res": "0.25 deg ens", "cycle_h": 12,
        "lag_h": 6,
        "source": "iconeps", "crop": True,
        "step": 6, "out": 120,
        "regions": {"conus": {}, "tropics": {}},
    },
    "ecmwfaifsens": {
        "label": "ECMWF AIFS ENS", "res": "0.25 deg AI ens", "cycle_h": 12,
        "lag_h": 9,
        "source": "ecmwf", "ecmwf_model": "aifs-ens",
        "ecmwf_stream": "enfo", "ecmwf_type": "em",
        "first": 6, "step": 6, "out": 240, "crop": True,
        "regions": {"conus": {}, "tropics": {"shear": True}},
    },
}

# Order matters: this is also the order they are built in, and the time budget
# below stops starting new ones once the hour is nearly gone. So the ones worth
# having most are first, and the long range ones that nobody minds being an
# hour stale are last.
DEFAULT_MODELS = ["hrrr", "rtma", "rap", "gfs", "nam", "namnest", "nbm",
                  "href", "gefs", "gefsspr", "gfswave",
                  "ecmwf", "ecmwfaifs",
                  "hireswarw", "hireswarw2", "hireswfv3",
                  "hrrrsub",
                  "hafs", "hafsb",
                  "gefswave",
                  "iconeu", "cmce",
                  # NAM's three regional nests. Same byte-range mechanism and
                  # publish schedule as "nam", built from the documented
                  # NOMADS filename convention rather than a checked live
                  # directory listing (unlike the entries above) - if one of
                  # these three logs nothing but skips, that means the actual
                  # filename drifted from what's coded here and it belongs in
                  # OFF_BY_DEFAULT until re-checked, the same as any entry
                  # below that's been confirmed broken.
                  "namak", "namhi", "nampr",
                  # Same-directory variants of models already building here,
                  # so the address is the most nearly certain kind of guess
                  # available without probing NOAA.
                  "gfs0p50", "gfs1p00", "nam32",
                  "hrefpmmn", "hrefsprd", "gefsc00", "gefsp01",
                  # Regional analyses and blends, on NOAA's per-area naming.
                  "rtmaak", "rtmahi", "rtmapr", "nbmak", "nbmhi"]

# Defined above and deliberately not built. Each of these was checked against
# the publisher's own directory listing and the files are not there: HWRF and
# HMON have been retired in favour of HAFS, the NSSL window member is gone,
# ETSS moved off the open server, and the Canadian and German addresses used
# here changed shape. They are kept rather than deleted because the definitions
# are still correct in shape, so when an address is worked out again the model
# comes back by adding one word here. Until then they are still buildable by
# hand with --models, which is how you would test a new address.
OFF_BY_DEFAULT = ["hwrf", "hmon", "hireswnssl", "etss",
                  "ecmwfens", "ecmwfaifsens", "ecmwfwave",
                  "gem", "hrdps", "rdps", "icond2", "iconeps",
                  # RRFS is here for a different reason from the rest, and a
                  # more interesting one. The directory exists and has files
                  # in it, but not one of them has a .idx beside it, and every
                  # file is 2dfld.2p5km for Hawaii and Puerto Rico rather than
                  # prslev for CONUS. No index means no byte ranges, and this
                  # pipeline lives on byte ranges: fetching a 3 km CONUS file
                  # whole to keep six fields out of it is most of a gigabyte
                  # an hour. So it waits until NOAA publishes indexes with it.
                  "rrfs", "rrfssub", "rrfsfire",
                  # AQM publishes no index either, so it is fetched as whole
                  # files, and those come down at a trickle NOMADS never cuts
                  # off: the socket timeout only fires on dead silence, so one
                  # air-quality hour held a whole build hostage for half an
                  # hour. Off until it can be fetched by byte range.
                  "aqm",
                  # ICON Global's icosahedral files carry no Ni/Nj and no
                  # coordinates at all: DWD ships the point positions as
                  # separate CLAT/CLON companion files. So every message dies
                  # on "Key/value not found" and the model has never built
                  # once, at ten minutes of downloads per attempt, and a 2.9
                  # million point regrid every hour is more than this board
                  # has memory for anyway. ICON Europe (iconeu) is on a plain
                  # lat-lon grid and stays on, so ICON is still represented.
                  "icon"]

# ── Soundings ───────────────────────────────────────────────────────────────
# A sounding is a vertical profile, so it needs the same variables at many
# pressure levels rather than one surface field.
#
# These are written differently from the map overlays. An overlay is a picture
# and only has to look right; a sounding has to be read back as numbers, so the
# value is encoded into the pixel instead of a colour: high byte in red, low
# byte in green, giving 65536 steps across the range the manifest records.
# Alpha marks where there is no data. The browser draws the image to a canvas,
# reads one pixel column, and has a profile, with no extra endpoint and no
# server to ask.
SND_LEVELS = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150, 100]
SND_VARS = {
    "t":  {"short": ("t",),    "convert": lambda a: a - 273.15, "range": (-90, 45)},
    "rh": {"short": ("r",),    "convert": lambda a: a,          "range": (0, 100)},
    "u":  {"short": ("u",),    "convert": lambda a: a * 1.94384, "range": (-200, 200)},
    "v":  {"short": ("v",),    "convert": lambda a: a * 1.94384, "range": (-200, 200)},
}
# Every 6 hours to two days. A sounding is read at a moment rather than
# animated, and 44 fields an hour adds up, so it is sampled more coarsely than
# the maps.
SND_HOURS = list(range(0, 49, 6))
SND_VAR_FLAGS = ["var_TMP", "var_RH", "var_UGRD", "var_VGRD"]

KEEP_RUNS = 4          # about 24 hours of runs
REQUEST_TIMEOUT = 60
RETRIES = 3

# The longest edge any overlay image is allowed to have. See render_png: the
# limit exists for the PlayStation 5 browser, which holds a decoded image in
# memory and does not have much of it. Coarse models are well under this and
# are untouched.
MAX_EDGE_PX = 1600


# How long a standard build may spend before it stops starting new models.
# With twenty of them a bad afternoon at NOAA could otherwise run past the
# hour, and since the next run cannot start while this one holds the lock,
# one slow build would swallow the following one. Forty minutes leaves the
# hourly rhythm intact. Models named explicitly on the command line ignore
# this: asking for one by name means meaning it.
TIME_BUDGET_S = 40 * 60

# The budget above exists to protect the hourly rhythm. A first build has no
# rhythm to protect: nothing is on the map yet, and stopping after forty
# minutes leaves most of the list missing until several more hours have gone
# by. So a model that has never produced a picture is allowed to finish, up to
# this much longer limit, and only the hourly refreshing of models that already
# have one is held to the shorter figure.
CATCHUP_BUDGET_S = 3 * 3600

# Roughly what one forecast hour of each costs, in megabytes, measured on the
# target Pi by check_models.py. Only ever compared against each other, to
# decide what to build first on a cold start, so being out of date makes the
# order slightly wrong rather than anything worse. Re-measure with:
#
#     ~/wxenv/bin/python pi/check_models.py
MB_PER_HOUR = {
    "hrrr": 5.4, "rtma": 17.3, "rap": 0.7, "gfs": 0.6, "nam": 1.8,
    "namnest": 10.4, "nbm": 11.1, "gefs": 0.07, "gefsspr": 0.05,
    "gfswave": 1.6, "ecmwf": 4.3, "hireswarw": 6.0, "hireswfv3": 6.7,
    # Not yet measured, so estimated from a comparable model and corrected the
    # first time check_models.py runs against them.
    "href": 10.4, "hireswarw2": 6.0, "rrfs": 5.4, "hrrrsub": 5.4,
    "ecmwfaifs": 4.3, "ecmwfens": 4.3,
    # Whole global fields with no cropping and no index, so these are the
    # expensive ones per hour even though the models are not large.
    "gem": 11.0, "icon": 21.0,
    # Storm domains are small.
    "hafs": 2.0, "hafsb": 2.0, "hwrf": 2.0, "hmon": 2.0,
    "rrfssub": 5.4, "rrfsfire": 2.0, "gefswave": 1.6, "ecmwfwave": 4.0,
    # Measured, not guessed: 89 MB a species and two species, for the one
    # hour it builds. Much the most expensive single frame here, which is
    # exactly why the cheapest-first ordering needs to be told.
    "aqm": 179.0, "etss": 1.0, "hrdps": 14.0, "rdps": 6.0,
    "iconeu": 6.0, "icond2": 4.0,
    "hireswnssl": 6.0, "cmce": 0.1, "iconeps": 21.0, "ecmwfaifsens": 4.3,
    # Regional nests, cropped to one small area apiece rather than CONUS -
    # estimated well under "nam" itself until check_models.py has a real
    # measurement to replace this with.
    "namak": 0.5, "namhi": 0.3, "nampr": 0.3,
    # Coarser grids cost far less per hour than the 0.25 deg run they are cut
    # from; the regional analyses are single frames over small areas.
    "gfs0p50": 0.2, "gfs1p00": 0.05, "nam32": 1.2,
    "hrefpmmn": 10.4, "hrefsprd": 10.4, "gefsc00": 0.07, "gefsp01": 0.07,
    "rtmaak": 2.0, "rtmahi": 0.8, "rtmapr": 0.8, "nbmak": 4.0, "nbmhi": 1.5,
}

# Some servers refuse the default python-requests user agent outright, and a
# 403 from that is indistinguishable from a wrong address. Saying who we are
# costs nothing and removes a whole class of confusing failure.
HTTP = requests.Session()
HTTP.headers.update({"User-Agent": "GWCFCRadar/1.0 (Raspberry Pi; weather map tiles)"})

FILTER_BASE = "https://nomads.ncep.noaa.gov/cgi-bin"
RAW_BASE = "https://nomads.ncep.noaa.gov/pub/data/nccf/com"

# NOMADS rate limits, and it does it with a 302 to a throttle page rather than
# an honest 429. So a burst of requests, which is exactly what a full build or
# a --check pass is, sails through for the first handful and then every request
# after is redirected and looks like a missing file. That was the whole of
# "some models are not working": GFS answered and GFS tropical did not, on the
# identical URL, seconds apart.
#
# Two defences. A minimum gap between NOMADS requests so the burst never trips
# the limiter, and a back-off retry when one slips through anyway. Only NOMADS
# needs this; the S3 buckets and ECMWF do not throttle this way.
_NOMADS_MIN_GAP = 0.7          # seconds; NOMADS allows about 120 hits a minute
_nomads_last = [0.0]


def is_nomads(url):
    return "nomads.ncep.noaa.gov" in url


def http_get(url, tries=4, **kw):
    """
    A GET that paces itself against NOMADS and retries its throttle redirect.

    A 302 from NOMADS is not a real redirect to follow, it is "you are asking
    too fast". allow_redirects stays off for NOMADS so that 302 is seen as the
    throttle it is rather than chased into a loop, and the answer is to wait and
    ask again, longer each time.
    """
    nomads = is_nomads(url)
    for attempt in range(tries):
        if nomads:
            gap = _NOMADS_MIN_GAP - (time.time() - _nomads_last[0])
            if gap > 0:
                time.sleep(gap)
            _nomads_last[0] = time.time()
        try:
            r = HTTP.get(url, allow_redirects=not nomads, **kw)
        except requests.RequestException:
            if attempt == tries - 1:
                raise
            time.sleep(1.5 * (attempt + 1))
            continue
        # 302 is the throttle; 403, 429 and 503 are the other faces it shows
        # for a burst. The files are public, so a 403 on one is the limiter,
        # not a real permission wall.
        if r.status_code in (302, 403, 429, 503) and attempt < tries - 1:
            time.sleep(1.5 * (attempt + 1))
            continue
        return r
    return r

# Fields to render. Matched on the GRIB shortName, level type and level that
# GRIB itself defines, rather than on a name invented during conversion,
# because those names differ between versions (t2m vs t, msl vs prmsl).
#
# convert turns raw GRIB units into what the map should show.
# Several of these accept more than one spelling. eccodes renames level types
# between versions (atmosphere became entireAtmosphere, meanSea became
# meanSeaLevel) and GFS labels precipitation differently depending on how it is
# accumulated, so pinning one spelling means a field silently vanishes after an
# upgrade. Matching a small set costs nothing and survives that.
FIELDS = {
    "t2m":   {"short": ("2t", "t"),  "levtype": ("heightAboveGround",), "level": 2,
              "convert": lambda a: a - 273.15, "range": (-40, 45),  "ramp": "temp"},
    "d2m":   {"short": ("2d", "dpt"), "levtype": ("heightAboveGround",), "level": 2,
              "convert": lambda a: a - 273.15, "range": (-40, 30),  "ramp": "temp"},
    # HRRR carries MSLMA rather than PRMSL, and NAM carries MSLET. Same field
    # as far as a map is concerned, three different names.
    "mslp":  {"short": ("prmsl", "msl", "mslma", "mslet"),
              "levtype": ("meanSea", "meanSeaLevel"), "level": 0,
              "convert": lambda a: a / 100.0,  "range": (960, 1050), "ramp": "viridis"},
    "cape":  {"short": ("cape",),    "levtype": ("surface",), "level": 0,
              "convert": lambda a: a,          "range": (0, 5000),  "ramp": "heat"},
    "refc":  {"short": ("refc",),
              "levtype": ("atmosphere", "entireAtmosphere"), "level": 0,
              "convert": lambda a: a,          "range": (-10, 75),  "ramp": "radar"},
    "apcp":  {"short": ("tp", "acpcp", "apcp"), "levtype": ("surface",), "level": 0,
              "convert": lambda a: a,          "range": (0, 50),    "ramp": "precip"},
    # Wind speed is taken directly when the file has it and worked out from the
    # two components when it does not. NBM and RTMA publish speed itself and no
    # components at all, so deriving was the only path and they came out with
    # no wind chart. The components are still the common case.
    "wind":  {"short": ("10si", "ws"), "levtype": ("heightAboveGround",), "level": 10,
              "convert": lambda a: a * 1.94384, "range": (0, 80),   "ramp": "wind"},

    # ── Tropical ────────────────────────────────────────────────────────────
    # Precipitable water: all the water vapour in the column, as the depth of
    # rain it would make if it all fell. The first thing to look at for a
    # tropical system, because a storm moving into dry air weakens whatever
    # else is in its favour. The 50 mm line is roughly where the tropics
    # begin, and the scale is set so that line lands in the middle.
    "pwat":  {"short": ("pwat", "tcwv"),
              "levtype": ("atmosphereSingleLayer", "entireAtmosphere",
                          "atmosphere", "unknown"), "level": 0,
              "convert": lambda a: a,           "range": (0, 80),
              "ramp": "moisture"},
    # Sea surface temperature. A hurricane runs on warm water and needs about
    # 26 C to keep going, so the range is narrow and centred on that: a scale
    # from freezing would put every number worth reading in one band.
    "sst":   {"short": ("wtmp", "sst"), "levtype": ("surface",), "level": 0,
              "convert": lambda a: a - 273.15,  "range": (16, 34), "ramp": "sst"},
    # Wind gust at the surface, which is what actually breaks things. Sustained
    # wind is the number a storm is named for, the gust is the number that
    # takes the roof off.
    "gust":  {"short": ("gust", "i10fg", "fg10"), "levtype": ("surface",),
              "level": 0,
              "convert": lambda a: a * 1.94384, "range": (0, 120), "ramp": "wind"},
    # Deep layer wind shear: how much the wind changes between 850 and 200 mb.
    # Worked out from the four component fields rather than read, because no
    # model publishes it. It is the other half of the question PWAT asks: a
    # storm needs moisture and it needs the wind to be roughly the same all
    # the way up, and about 20 knots of shear is enough to tear one apart.
    "shear": {"short": (), "levtype": (), "level": 0,
              "convert": lambda a: a * 1.94384, "range": (0, 60),
              "ramp": "shear", "derive": "shear"},

    # ── Waves ───────────────────────────────────────────────────────────────
    # Significant wave height, which is the average of the highest third, so
    # the biggest waves in a sea are noticeably larger than this number. Swell
    # from a hurricane reaches a coast days before the storm does, and is what
    # closes beaches and floods low ground well ahead of landfall.
    "swh":   {"short": ("swh", "htsgw"), "levtype": ("surface",), "level": (0, 1),
              "convert": lambda a: a,           "range": (0, 12),
              "ramp": "viridis"},
    # Wave period. Long period swell is the signature of a distant storm: wind
    # waves from local weather are short and choppy, a 15 second swell has
    # travelled a long way to get here.
    "perpw": {"short": ("perpw", "pp1d"), "levtype": ("surface",), "level": (0, 1),
              "convert": lambda a: a,           "range": (0, 20), "ramp": "heat"},

    # ── Air quality ─────────────────────────────────────────────────────────
    # Ozone and fine particulate, the two the health advisories are written
    # against. Scaled to where the advisories change rather than to the range
    # the data happens to span, so the colour changing means something.
    "ozone": {"short": ("ozcon", "o3mr", "massden"), "levtype": ("surface",),
              "level": 0,
              "convert": lambda a: a,           "range": (0, 120),
              "ramp": "heat"},
    "pm25":  {"short": ("pmtf", "pmtc", "pm2p5"), "levtype": ("surface",),
              "level": 0,
              "convert": lambda a: a,           "range": (0, 150),
              "ramp": "heat"},

    # ── Storm surge ─────────────────────────────────────────────────────────
    # Water above the normal tide, which is what actually floods a coast. A
    # hurricane's wind is the number it is named for and this is the number
    # that does most of the killing.
    "surge": {"short": ("etsrg", "surge", "htsgw"), "levtype": ("surface",),
              "level": 0,
              "convert": lambda a: a,           "range": (0, 4),
              "ramp": "precip"},
}

# The two pressure levels the shear field is worked out from. Fetched only by
# models that ask for shear, since for everything else they are dead weight.
SHEAR_LEVELS = (200, 850)


def _matches(spec, short, levtype, level):
    # "level" may be one number or several. Wave files write the surface as
    # level 1 where every other model writes 0, and demanding exactly 0 threw
    # away five perfectly good messages an hour, every hour.
    want = spec["level"]
    if not isinstance(want, tuple):
        want = (want,)
    return (short in spec["short"]
            and levtype in spec["levtype"]
            and int(level) in tuple(int(v) for v in want))

# NOMADS query flags: which variables and which levels to ask for.
#
# These cannot be one list. The filter service returns HTTP 500, not an empty
# file, when asked for something a particular model does not contain, so one
# wrong flag loses the whole request. GEFS at half a degree carries no dewpoint,
# no CAPE and no reflectivity, and the level a model calls "entire atmosphere"
# is spelled differently between them.
#
# So each model states what it has, and if the full ask still fails there is a
# minimal set below that every one of them carries. Better a chart with four
# fields than no chart at all.
VAR_FLAGS = ["var_TMP", "var_DPT", "var_PRMSL", "var_CAPE",
             "var_REFC", "var_APCP", "var_UGRD", "var_VGRD"]
LEV_FLAGS = ["lev_2_m_above_ground", "lev_10_m_above_ground",
             "lev_mean_sea_level", "lev_surface", "lev_entire_atmosphere"]

FALLBACK_VARS = ["var_TMP", "var_UGRD", "var_VGRD", "var_PRMSL"]
FALLBACK_LEVS = ["lev_2_m_above_ground", "lev_10_m_above_ground",
                 "lev_mean_sea_level"]

# What to ask for, before knowing what a given file contains. Written as the
# plain names NOAA's index uses rather than as query flags, because the ask is
# now built by matching these against that index.
WANT_VARS = {"TMP", "DPT", "PRMSL", "MSLET", "MSLMA",
             "CAPE", "REFC", "APCP", "UGRD", "VGRD",
             # NBM and RTMA publish wind speed itself and no components.
             "WIND",
             # Tropical: column moisture, sea temperature, gusts.
             "PWAT", "WTMP", "GUST",
             # Waves.
             "HTSGW", "PERPW",
             # Air quality and storm surge.
             "OZCON", "PMTF", "PMTC", "ETSRG"}
# Exact level names, except the last, which is a prefix: models spell the whole
# column differently. GFS says "entire atmosphere (considered as a single
# layer)", HRRR just says "entire atmosphere", and guessing wrong is what turns
# a whole forecast hour into an error.
WANT_LEVELS = ["2 m above ground", "10 m above ground",
               "mean sea level", "surface"]
WANT_LEVEL_PREFIX = "entire atmosphere"
# Asked for only by models that build the shear field.
SHEAR_LEVEL_NAMES = [f"{mb} mb" for mb in SHEAR_LEVELS]


def lev_flag(level):
    """
    The query flag NOMADS gives a level.

    Not a label: the filter service treats it as a regular expression, so the
    brackets in "entire atmosphere (considered as a single layer)" have to be
    escaped or they read as a group and match nothing.

    The backslashes go in as real characters. They were written here already
    percent-encoded once, which meant the encoder encoded the percent signs and
    the level arrived as literal "%5C%28" text. Nothing is called that, so the
    service refused the whole request, and NAM produced no charts at all.
    """
    out = level.replace(" ", "_")
    for ch in "()":
        out = out.replace(ch, "\\" + ch)
    return "lev_" + out


def inventory(m, date_str, cyc, fhr):
    """
    What this file actually holds, read from NOAA's own index beside it.

    The filter service answers 500, not an empty file, when asked for something
    a model does not carry, so one hopeful flag loses the whole hour. Guessing
    per model was the previous approach and it does not survive contact: HRRR
    calls its pressure field MSLMA where GFS calls it PRMSL, GEFS at half a
    degree has no dewpoint, CAPE or reflectivity, and the level names differ
    again. The index says exactly what is in there, costs a few KB, and turns
    the ask from a guess into a fact.

    Returns {(variable, level)} or None when the index cannot be read, in which
    case the caller falls back to asking blind.
    """
    url = f"{RAW_BASE}/" + m["raw"].format(date=date_str, cyc=cyc, fhr=fhr)
    try:
        r = http_get(url, timeout=30)
        if r.status_code != 200 or "<" in r.text[:40]:
            return None
    except requests.RequestException:
        return None
    pairs = set()
    for line in r.text.splitlines():
        # 1:0:d=2026081412:PRMSL:mean sea level:anl:
        f = line.split(":")
        if len(f) > 5:
            pairs.add((f[3], f[4]))
    return pairs or None


# Exactly which message in a GRIB file feeds each field, as the variable and
# level names NOAA's index uses. Spellings are in preference order and the
# first one present wins, which is how one entry covers models that disagree
# about what to call the same thing. A trailing star matches a prefix, since
# "entire atmosphere" is sometimes followed by "(considered as a single
# layer)" and sometimes not.
#
# This exists because the filter service takes variables and levels as two
# separate lists and returns every combination of them. Asking HRRR for 11
# variables at 5 levels returns up to 55 messages to draw 7 fields, which
# measured at 26 MB per forecast hour and just under 12 GB a day. Naming the
# messages instead means fetching 7.
FIELD_SOURCES = {
    "t2m":   [("TMP", "2 m above ground")],
    "d2m":   [("DPT", "2 m above ground")],
    "mslp":  [("PRMSL", "mean sea level"), ("MSLET", "mean sea level"),
              ("MSLMA", "mean sea level")],
    "cape":  [("CAPE", "surface")],
    "refc":  [("REFC", "entire atmosphere*")],
    "apcp":  [("APCP", "surface")],
    "gust":  [("GUST", "surface")],
    "pwat":  [("PWAT", "entire atmosphere*")],
    "sst":   [("WTMP", "surface")],
    "swh":   [("HTSGW", "surface")],
    "perpw": [("PERPW", "surface")],
    "ozone": [("OZCON", "surface")],
    "pm25":  [("PMTF", "surface"), ("PMTC", "surface")],
    "surge": [("ETSRG", "surface")],
}
# Wind is its own case: taken as a speed where the model publishes one, and
# from both components where it does not. Fetching all three, which the cross
# product did, is paying for the same field twice.
WIND_SPEED = ("WIND", "10 m above ground")
WIND_PARTS = [("UGRD", "10 m above ground"), ("VGRD", "10 m above ground")]


def _lev_matches(pattern, level):
    if pattern.endswith("*"):
        return level.startswith(pattern[:-1])
    return level == pattern


def parse_idx(text):
    """
    NOAA's index for one GRIB file, as a list of messages with byte ranges.

    A line is `number:startbyte:date:variable:level:forecast:`. Only the start
    is given, so a message ends where the next one begins, and the last one
    runs to the end of the file.
    """
    rows = []
    for line in text.splitlines():
        f = line.split(":")
        if len(f) > 5:
            try:
                rows.append({"start": int(f[1]), "var": f[3], "lev": f[4]})
            except ValueError:
                pass
    for i, r in enumerate(rows):
        r["end"] = rows[i + 1]["start"] - 1 if i + 1 < len(rows) else None
    return rows


def select_from_idx(rows, want_shear=False, only=None):
    """
    The messages worth downloading, as byte ranges, and what they are.

    "only" narrows the list for models where the rest is not worth the
    bandwidth. HRRR is the case that forces it: hourly, 3 km, and the largest
    single line on the bill by a factor of three. Nobody opens HRRR to read a
    dewpoint or a pressure pattern, they open it for reflectivity and wind in
    the next few hours, so it carries those and lets the coarse models carry
    the rest.
    """
    # The exact messages, not the pairs they matched. Matching pairs again at
    # the end takes every message that shares a name and level, and the blend
    # publishes a dozen APCP at surface for different accumulation windows and
    # percentiles. That is how six fields turned into 23 messages and 42 MB a
    # forecast hour.
    chosen = []
    names = []

    def take(row, label):
        if not any(r is row for r in chosen):
            chosen.append(row)
            names.append(label)

    for key, options in FIELD_SOURCES.items():
        if only and key not in only:
            continue
        for var, levpat in options:
            hit = next((r for r in rows
                        if r["var"] == var and _lev_matches(levpat, r["lev"])),
                       None)
            if hit:
                take(hit, f"{key}<-{var}")
                break            # the first spelling that exists, and no more

    if not only or "wind" in only:
        speed = next((r for r in rows
                      if (r["var"], r["lev"]) == WIND_SPEED), None)
        if speed:
            take(speed, "wind<-WIND")
        else:
            # One of each component, not every message that shares the name.
            for want in WIND_PARTS:
                one = next((r for r in rows
                            if (r["var"], r["lev"]) == want), None)
                if one:
                    take(one, f"wind<-{want[0]}")

    if want_shear:
        levels = {f"{mb} mb" for mb in SHEAR_LEVELS}
        for var in ("UGRD", "VGRD"):
            for lev in sorted(levels):
                one = next((r for r in rows
                            if r["var"] == var and r["lev"] == lev), None)
                if one:
                    take(one, f"shear<-{var} {lev}")

    keep = sorted(chosen, key=lambda r: r["start"])
    return keep, names


def merge_ranges(spans, gap=65536):
    """
    Join byte ranges that are close together.

    Several small requests over one connection cost more in round trips than
    the few unwanted bytes between them, but only while the gap is small:
    merging across a large one downloads the large one.
    """
    out = []
    for start, end in spans:
        if out and out[-1][1] is not None and start - out[-1][1] <= gap:
            out[-1] = (out[-1][0], end)
        else:
            out.append((start, end))
    return out


def fetch_hour_range(m, date_str, cyc, fhr, path):
    """
    Download one forecast hour by naming the messages, not the combinations.

    The index beside the file gives a byte offset per message, so the wanted
    ones are asked for by range and glued together. GRIB is a sequence of self
    describing messages, so a handful concatenated is a valid file.

    Nothing here goes through the filter service, which is the other half of
    why this exists: that service is a separate CGI per model, its names are
    not guessable, and three models were failing on a 404 from it while their
    data sat on the file server perfectly reachable.
    """
    found_idx = find_index(m, date_str, cyc, fhr, timeout=REQUEST_TIMEOUT)
    if not found_idx:
        log(f"    f{fhr:03d}: no index")
        return False
    idx_url, idx_text = found_idx
    grib_url = idx_url[:-4] if idx_url.endswith(".idx") else idx_url

    rows = parse_idx(idx_text)
    keep, _names = select_from_idx(rows, m.get("shear"), m.get("fields"))
    if not keep:
        log(f"    f{fhr:03d}: index had none of the wanted fields")
        return False

    spans = merge_ranges([(k["start"], k["end"]) for k in keep])
    try:
        with open(path, "wb") as f:
            for start, end in spans:
                rng = f"bytes={start}-" + ("" if end is None else str(end))
                rr = http_get(grib_url, timeout=REQUEST_TIMEOUT,
                                  headers={"Range": rng})
                # 206 is the answer to a range request. A 200 means the server
                # ignored it and is sending the whole file, which for these is
                # a hundred megabytes rather than a handful.
                if rr.status_code != 206:
                    log(f"    f{fhr:03d}: range refused, HTTP {rr.status_code}")
                    return False
                f.write(rr.content)
    except requests.RequestException as e:
        log(f"    f{fhr:03d}: {e}")
        return False

    if os.path.getsize(path) < 5000:
        log(f"    f{fhr:03d}: only {os.path.getsize(path)} bytes")
        return False
    return True


# ── Sources that are not NOAA and not ECMWF ────────────────────────────────
# Both of these publish one file per field per forecast hour rather than one
# file holding everything, so there is no index to range-request against and
# nothing to crop server side. The whole field arrives and the box is cut out
# after decoding, the same as ECMWF.
GEM_BASE = "https://dd.weather.gc.ca/model_gem_global/25km/grib2/lat_lon"
ICON_BASE = "https://opendata.dwd.de/weather/nwp/icon/grib"

# Environment Canada names a file after the variable, the level type and the
# level, so the wanted fields are listed the way that server spells them.
GEM_FIELDS = [
    ("TMP", "TGL", "2"), ("DEPR", "TGL", "2"), ("PRMSL", "MSL", "0"),
    ("UGRD", "TGL", "10"), ("VGRD", "TGL", "10"), ("APCP", "SFC", "0"),
    ("PWAT", "EATM", "0"),
]

# DWD names theirs after the variable alone, in lower case, one directory each.
ICON_FIELDS = ["t_2m", "td_2m", "pmsl", "u_10m", "v_10m", "tot_prec", "tqv"]


def gem_urls(m, date_str, cyc, fhr):
    return [f"{GEM_BASE}/{cyc}/{fhr:03d}/"
            f"CMC_glb_{var}_{lvt}_{lvl}_latlon.24x.24_"
            f"{date_str}{cyc}_P{fhr:03d}.grib2"
            for var, lvt, lvl in GEM_FIELDS]


# Air quality, which publishes no indexes at all. The directory listing shows
# 28 files and not one .idx among them, so byte ranges are impossible and the
# file has to come whole. That is affordable here and nowhere else: one AQM
# file is a single surface field on a 5 km grid, a few megabytes, and it holds
# every forecast hour at once, so a run is two downloads rather than seventy.
#
# The grid number in the name is the one thing not settled. 227 is the old 5 km
# grid and 793 the one the current version uses, so it is probed once per run
# and remembered, rather than guessed at in the filename.
AQM_BASE = f"{RAW_BASE}/aqm/prod"
AQM_SPECIES = {"ozone": "o3", "pm25": "pm25"}
_aqm_grid = {}


def aqm_urls(m, date_str, cyc, fhr):
    key = (date_str, cyc)
    if key not in _aqm_grid:
        _aqm_grid[key] = None
        for grid in ("793", "227"):
            for bc in ("_bc", ""):
                url = (f"{AQM_BASE}/aqm.{date_str}/{cyc}/"
                       f"aqm.t{cyc}z.ave_1hr_o3{bc}.{grid}.grib2")
                try:
                    r = http_get(url, timeout=30,
                                 headers={"Range": "bytes=0-32"})
                except requests.RequestException:
                    continue
                if r.status_code in (200, 206) and r.content[:4] == b"GRIB":
                    # Bias corrected where it exists: same field, adjusted
                    # against what the monitors actually measured, which is
                    # the number the advisories are written against.
                    _aqm_grid[key] = (grid, bc)
                    break
            if _aqm_grid[key]:
                break
    if not _aqm_grid[key]:
        return []
    grid, bc = _aqm_grid[key]
    return [f"{AQM_BASE}/aqm.{date_str}/{cyc}/"
            f"aqm.t{cyc}z.ave_1hr_{sp}{bc}.{grid}.grib2"
            for sp in AQM_SPECIES.values()]


def icon_urls(m, date_str, cyc, fhr):
    return [f"{ICON_BASE}/{cyc}/{f}/"
            f"icon_global_icosahedral_single-level_{date_str}{cyc}_"
            f"{fhr:03d}_{f.upper()}.grib2.bz2"
            for f in ICON_FIELDS]


# Environment Canada's regional models. Same server and the same one file per
# field, but a different grid name in every filename, and both are on a polar
# stereographic grid rather than latitude and longitude, so both go through the
# regridder.
CA_REGIONAL = {
    "hrdps": ("model_hrdps/continental/grib2", "hrdps_continental", "ps2.5km"),
    "rdps":  ("model_gem_regional/10km/grib2", "reg", "ps10km"),
}


def ca_urls(m, date_str, cyc, fhr):
    path, tag, grid = CA_REGIONAL[m["source"]]
    return [f"https://dd.weather.gc.ca/{path}/{cyc}/{fhr:03d}/"
            f"CMC_{tag}_{var}_{lvt}_{lvl}_{grid}_{date_str}{cyc}_P{fhr:03d}"
            f"-00.grib2"
            for var, lvt, lvl in GEM_FIELDS]


# DWD publishes Europe and Germany on plain latitude and longitude grids,
# unlike the global one, so those two need no regridding at all.
ICON_REGIONAL = {
    "iconeu": ("icon-eu", "icon-eu_europe_regular-lat-lon"),
    "icond2": ("icon-d2", "icon-d2_germany_regular-lat-lon"),
    # The ensemble mean is global and icosahedral like the deterministic run,
    # so it goes through the regridder rather than straight onto the map.
    "iconeps": ("icon-eps", "icon-eps_global_icosahedral"),
}


def icon_regional_urls(m, date_str, cyc, fhr):
    path, tag = ICON_REGIONAL[m["source"]]
    return [f"https://opendata.dwd.de/weather/nwp/{path}/grib/{cyc}/{f}/"
            f"{tag}_single-level_{date_str}{cyc}_{fhr:03d}_{f.upper()}.grib2.bz2"
            for f in ICON_FIELDS]


URL_SOURCES = {"aqm": aqm_urls, "gem": gem_urls, "icon": icon_urls,
               "hrdps": ca_urls, "rdps": ca_urls,
               "iconeu": icon_regional_urls, "icond2": icon_regional_urls,
               "iconeps": icon_regional_urls}


def fetch_hour_files(m, date_str, cyc, fhr, path):
    """
    Download one forecast hour that arrives as a file per field.

    Everything NOAA publishes puts a whole run's worth of fields in one file
    with an index beside it, which is what makes a byte range possible. These
    two do the opposite: one file per field per hour, no index. So each wanted
    field is a separate request, and they are glued together into one GRIB,
    which is valid because GRIB is a sequence of self describing messages.

    A field that is missing is skipped rather than failing the hour. These
    servers do not publish every field at every step, and losing precipitation
    at hour zero should not cost the temperature.
    """
    urls = URL_SOURCES[m["source"]](m, date_str, cyc, fhr)
    got = 0
    try:
        with open(path, "wb") as f:
            for url in urls:
                try:
                    r = http_get(url, timeout=REQUEST_TIMEOUT)
                except requests.RequestException:
                    continue
                if r.status_code != 200 or len(r.content) < 500:
                    continue
                data = r.content
                if url.endswith(".bz2"):
                    # DWD compresses every file. bz2 on a few megabytes is
                    # well under the time the download itself took.
                    try:
                        data = bz2.decompress(data)
                    except Exception:
                        continue
                if data[:4] != b"GRIB":
                    continue
                f.write(data)
                got += 1
    except OSError as e:
        log(f"    f{fhr:03d}: {e}")
        return False

    if got == 0:
        log(f"    f{fhr:03d}: none of {len(urls)} files were there")
        return False
    if got < len(urls):
        log(f"    f{fhr:03d}: {got} of {len(urls)} fields")
    return True


# Two doors to the same files. ECMWF publishes its open data on its own host
# and mirrors it to AWS Open Data with identical paths. Both are tried in
# order, because a host that is slow, down, or unreachable from one network
# otherwise reads as the model quietly never existing, which is exactly what
# "nothing built for this model yet" looks like from the panel.
ECMWF_BASES = (
    "https://data.ecmwf.int/forecasts",
    "https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com",
)
# The host that answered last, tried first next time. A dead first host costs
# a round of retries to discover; without this a 41 hour run pays that round
# 41 times, which is minutes of sleeping at a problem already diagnosed.
_ecmwf_host_hint = [None]

# What to take from ECMWF, by its own parameter names. Everything not listed is
# skipped without downloading it, which is the point: the whole file is around
# 100 MB and this pulls a few MB of it.
ECMWF_PARAMS = {"2t", "2d", "msl", "10u", "10v", "tp", "tcwv", "sst"}
ECMWF_SHEAR_PARAMS = {"u", "v"}


def ecmwf_paths(m, date_str, cyc, fhr, host=None):
    """
    The forecast file and the index beside it.

    The index name is returned as a list because there are two conventions in
    the wild and picking the wrong one looks exactly like the model not being
    published: ECMWF names it by replacing the extension, giving
    `...-fc.index`, where NOAA appends to the whole filename. Both are tried
    and the first that answers wins, the same as the RTMA paths.

    The stream is `oper` for the 00 and 12 cycles. The 06 and 18 cycles are
    published as `scda`, a shorter cut-off run, so a model wanting those has to
    say so rather than assume this name.
    """
    model = m.get("ecmwf_model", "ifs")
    stream = m.get("ecmwf_stream", "oper")
    kind = m.get("ecmwf_type", "fc")
    host = host or ECMWF_BASES[0]
    base = (f"{host}/{date_str}/{cyc}z/{model}/0p25/{stream}/"
            f"{date_str}{cyc}0000-{fhr}h-{stream}-{kind}")
    grib = base + ".grib2"
    return grib, [base + ".index", grib + ".index"]


def ecmwf_index(m, date_str, cyc, fhr, timeout=REQUEST_TIMEOUT):
    """The first index that answers, its text, the codes tried, and which
    host it answered on, so the data fetch goes through the same door."""
    codes = []
    hosts = list(ECMWF_BASES)
    if _ecmwf_host_hint[0] in hosts:
        hosts.insert(0, hosts.pop(hosts.index(_ecmwf_host_hint[0])))
    for host in hosts:
        for url in ecmwf_paths(m, date_str, cyc, fhr, host)[1]:
            try:
                r = http_get(url, timeout=timeout)
            except requests.RequestException as e:
                codes.append((url, str(e)))
                continue
            codes.append((url, r.status_code))
            if r.status_code == 200 and "{" in r.text[:200]:
                _ecmwf_host_hint[0] = host
                return url, r.text, codes, host
    return None, None, codes, None


def fetch_hour_ecmwf(m, date_str, cyc, fhr, path):
    """
    Download one ECMWF forecast hour, a few fields at a time.

    There is no filter service here, so the alternative to this would be
    pulling roughly 100 MB to keep about two of it. The index beside each file
    lists every field with a byte offset and a length, so the wanted ones are
    asked for by range and glued together. GRIB is a sequence of self
    describing messages, so a handful of messages concatenated is a valid GRIB
    file and the decoder cannot tell the difference.

    Ranges are merged when they are adjacent or nearly so, because thirty
    small requests over one connection cost more in round trips than the few
    wasted bytes between them.
    """
    _url, text, codes, host = ecmwf_index(m, date_str, cyc, fhr)
    grib_url = ecmwf_paths(m, date_str, cyc, fhr, host)[0]
    if not text:
        log(f"    f{fhr:03d}: no index ("
            + ", ".join(f"{c}" for _u, c in codes) + ")")
        return False

    want = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        param = rec.get("param")
        if param in ECMWF_PARAMS and rec.get("levtype") == "sfc":
            pass
        elif (m.get("shear") and param in ECMWF_SHEAR_PARAMS
              and rec.get("levtype") == "pl"
              and int(rec.get("levelist", 0) or 0) in SHEAR_LEVELS):
            pass
        else:
            continue
        try:
            want.append((int(rec["_offset"]), int(rec["_length"])))
        except (KeyError, TypeError, ValueError):
            continue

    if not want:
        log(f"    f{fhr:03d}: index had none of the wanted fields")
        return False

    want.sort()
    merged = []
    for off, ln in want:
        if merged and off - (merged[-1][0] + merged[-1][1]) <= 65536:
            start = merged[-1][0]
            merged[-1] = (start, off + ln - start)
        else:
            merged.append((off, ln))

    try:
        with open(path, "wb") as f:
            for off, ln in merged:
                rr = http_get(
                    grib_url, timeout=REQUEST_TIMEOUT,
                    headers={"Range": f"bytes={off}-{off + ln - 1}"})
                # 206 is the answer to a range request. A 200 means the server
                # ignored the range and is sending the whole file, which would
                # quietly turn a few MB into a hundred.
                if rr.status_code != 206:
                    log(f"    f{fhr:03d}: range refused, HTTP {rr.status_code}")
                    return False
                f.write(rr.content)
    except requests.RequestException as e:
        log(f"    f{fhr:03d}: {e}")
        return False

    got = os.path.getsize(path)
    if got < 5000:
        log(f"    f{fhr:03d}: only {got} bytes")
        return False
    return True


def regrid_to_latlon(vals, plats, plons, box, max_edge=MAX_EDGE_PX, edge=None):
    """
    Put a model's own grid onto a plain latitude and longitude mesh.

    HRRR, RAP, NAM and every nest are on a Lambert Conformal grid: the rows
    are not lines of latitude and the columns are not lines of longitude, they
    are straight lines on a cone wrapped around the earth. Treating that as if
    it were evenly spaced in latitude and longitude, which is what reading only
    the first and last corner amounts to, puts the picture in roughly the right
    part of the world and wrong everywhere within it, by tens of kilometres at
    the edges. A storm drawn there is not where it is.

    So the real coordinate of every point is read and the values are dropped
    into whichever cell of a regular mesh they land in. Averaging where several
    land in one cell, and leaving a gap where none do.

    Binning with bincount rather than a loop or add.at because this runs on a
    Pi over a few million points per field, and bincount is the one that is
    actually C underneath.
    """
    plons = np.where(plons < 0.0, plons + 360.0, plons)
    sel = ((plats >= box["bottomlat"]) & (plats <= box["toplat"]) &
           (plons >= box["leftlon"]) & (plons <= box["rightlon"]))
    n = int(sel.sum())
    if n < 100:
        return None
    la, lo, v = plats[sel], plons[sel], np.asarray(vals, np.float32)[sel]

    lat0, lat1 = float(la.min()), float(la.max())
    lon0, lon1 = float(lo.min()), float(lo.max())
    span_lat, span_lon = lat1 - lat0, lon1 - lon0
    if span_lat <= 0 or span_lon <= 0:
        return None

    # Roughly one output cell per input point, keeping the aspect ratio, then
    # capped. Asking for more cells than there are points only spreads the same
    # data over more gaps.
    #
    # A caller that knows the data's own resolution can say so with edge, and
    # for radar it must. Counting points is right for a model grid, whose
    # points are spread evenly, and wrong for a sweep, whose points crowd
    # around the antenna: the count is diluted by the empty corners of the
    # bounding box and by gates that cover more ground the further out they
    # are, so the honest native resolution comes out two or three times
    # coarser than the file actually is.
    if edge:
        long_side = max(span_lat, span_lon)
        scale = float(edge) / long_side
    else:
        scale = np.sqrt(n / (span_lat * span_lon))
    nrow = int(min(max_edge, max(32, round(span_lat * scale))))
    ncol = int(min(max_edge, max(32, round(span_lon * scale))))

    # Row 0 is the top of the image, which is north.
    row = np.clip(((lat1 - la) / span_lat * (nrow - 1)).astype(np.int32),
                  0, nrow - 1)
    col = np.clip(((lo - lon0) / span_lon * (ncol - 1)).astype(np.int32),
                  0, ncol - 1)
    flat = row * ncol + col

    good = np.isfinite(v)
    total = np.bincount(flat[good], weights=v[good].astype(np.float64),
                        minlength=nrow * ncol)
    count = np.bincount(flat[good], minlength=nrow * ncol)
    out = np.full(nrow * ncol, np.nan, np.float32)
    hit = count > 0
    out[hit] = (total[hit] / count[hit]).astype(np.float32)

    return (out.reshape(nrow, ncol),
            np.linspace(lat1, lat0, nrow),
            np.linspace(lon0, lon1, ncol))


def bounds_from(lats, lons):
    """
    The rectangle a finished image actually covers.

    Taken from the data rather than from the box that was asked for, because
    a grid has a spacing and the edges land on the nearest cell. Stretching a
    picture into a rectangle it does not fill is how everything in it ends up
    a few kilometres from where it belongs.
    """
    def to180(x):
        x = float(x)
        return x - 360.0 if x > 180.0 else x

    return [[float(min(lats[0], lats[-1])), to180(min(lons[0], lons[-1]))],
            [float(max(lats[0], lats[-1])), to180(max(lons[0], lons[-1]))]]


def crop_to_box(arr, lats, lons, box):
    """
    Cut a global field down to the box, after the fact.

    NOAA crops before sending and this is not needed there. ECMWF sends the
    whole world, so the box is applied here instead. Longitudes are compared
    in the 0 to 360 convention the box is written in, which is also what
    ECMWF's grid uses, so nothing has to be rotated.

    Returns (arr, lats, lons, bounds) with bounds being the extent actually
    kept rather than the extent asked for, so the picture and the rectangle it
    is stretched into are the same thing.
    """
    lat_ok = np.where((lats >= box["bottomlat"]) & (lats <= box["toplat"]))[0]
    lon_ok = np.where((lons >= box["leftlon"]) & (lons <= box["rightlon"]))[0]
    if lat_ok.size < 2 or lon_ok.size < 2:
        return None
    arr = arr[np.ix_(lat_ok, lon_ok)]
    lats, lons = lats[lat_ok], lons[lon_ok]

    def to180(x):
        return x - 360.0 if x > 180.0 else x

    bounds = [[float(min(lats[0], lats[-1])), float(to180(lons[0]))],
              [float(max(lats[0], lats[-1])), float(to180(lons[-1]))]]
    return arr, lats, lons, bounds


def ask_from_inventory(pairs, extra_levels=()):
    """
    Turn what is in the file into the flags that ask for the useful part.

    extra_levels are pressure levels a model wants on top of the surface set,
    and only the wind components are taken from them. Asking for everything at
    850 mb would pull temperature and humidity too, which nothing here draws,
    on a box big enough that the waste is real.
    """
    vars_, levs_ = set(), set()
    for var, level in pairs:
        if var not in WANT_VARS:
            continue
        if level in WANT_LEVELS or level.startswith(WANT_LEVEL_PREFIX):
            vars_.add("var_" + var)
            levs_.add(lev_flag(level))
        elif level in extra_levels and var in ("UGRD", "VGRD"):
            vars_.add("var_" + var)
            levs_.add(lev_flag(level))
    return sorted(vars_), sorted(levs_)


def write_json(path, obj):
    """
    Write a file that is either the old one or the new one, never half of both.

    Opening a path for writing truncates it immediately, so a run interrupted
    between the truncate and the write leaves an empty file behind. For the
    manifest and the index that is worse than useless: the manifest is what
    marks a run finished, so an empty one claims a run is ready and then fails
    to say anything about it.

    Writing beside it and renaming avoids that. A rename within a directory is
    atomic, so a reader sees one file or the other.
    """
    tmp = f"{path}.tmp{os.getpid()}"
    try:
        with open(tmp, "w") as f:
            json.dump(obj, f, indent=1)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def log(msg):
    print(f"{datetime.now(timezone.utc):%H:%M:%S} {msg}", flush=True)


# ── Colour ramps ────────────────────────────────────────────────────────────
# Kept here rather than pulled from matplotlib, because matplotlib would be a
# figure, axes and a savefig per image: 328 of those is minutes of work on a Pi
# for something that is a lookup table applied to an array. It is also the
# source of the classic alignment bug, since bbox_inches='tight' silently crops
# the picture and the result no longer matches the bounds handed to Leaflet.
RAMPS = {
    "temp":   [(0,(12,12,80)),(0.25,(0,150,220)),(0.45,(60,200,140)),
               (0.6,(240,230,90)),(0.8,(230,110,40)),(1,(150,20,20))],
    "viridis":[(0,(68,1,84)),(0.25,(59,82,139)),(0.5,(33,145,140)),
               (0.75,(94,201,98)),(1,(253,231,37))],
    "heat":   [(0,(0,0,0)),(0.3,(140,0,90)),(0.6,(240,90,40)),
               (0.85,(250,200,60)),(1,(255,255,220))],
    "radar":  [(0,(4,233,231)),(0.25,(1,159,244)),(0.4,(3,0,244)),
               (0.55,(2,253,2)),(0.7,(253,248,2)),(0.85,(253,139,0)),
               (0.95,(253,0,0)),(1,(188,0,188))],
    "precip": [(0,(200,240,200)),(0.25,(60,190,110)),(0.5,(40,140,220)),
               (0.75,(140,60,200)),(1,(230,60,120))],
    "wind":   [(0,(230,245,255)),(0.3,(90,180,230)),(0.6,(60,200,120)),
               (0.8,(245,200,70)),(1,(220,60,50))],
    # spread reads as confidence, so it runs pale (models agree) to dark
    # (they do not) rather than through a rainbow that invites reading a
    # value where the point is the disagreement.
    "spread": [(0,(240,248,255)),(0.25,(150,200,235)),(0.5,(120,140,220)),
               (0.75,(150,80,190)),(1,(120,20,90))],
    # Moisture, for precipitable water. Runs dry brown through green to blue
    # and purple, which is the convention on tropical charts and reads the
    # right way round: the dry air that kills a storm looks like desert, and
    # the deep moisture that feeds one looks like ocean.
    "moisture":[(0,(120,90,50)),(0.3,(200,190,130)),(0.5,(90,190,120)),
                (0.7,(40,140,210)),(0.87,(90,60,200)),(1,(230,90,200))],
    # Shear, inverted on purpose. Low shear is what lets a hurricane grow, so
    # the dangerous end of this scale is the low end, and it is the low end
    # that is coloured. High shear fades out: it is the absence of a problem.
    "shear":  [(0,(200,30,60)),(0.18,(240,140,40)),(0.35,(240,225,120)),
               (0.55,(120,200,150)),(0.8,(70,120,180)),(1,(30,40,80))],
    # Sea surface temperature, with the 26 C line that matters. Hurricanes
    # need about 26 C to keep going, so the ramp is built to change character
    # there rather than to be pretty across its whole width.
    # Velocity, which is the one ramp that has to be symmetric. The number
    # means "towards the radar" on one side of zero and "away" on the other,
    # and the thing worth seeing is the two sitting next to each other, which
    # is rotation. Green towards, red away, and nothing at the middle, because
    # a colour at zero would fill the whole map with air that is not moving.
    "velocity":[(0,(0,90,0)),(0.25,(0,220,0)),(0.45,(120,255,120)),
                (0.5,(20,20,20)),(0.55,(255,140,140)),(0.75,(230,0,0)),
                (1,(120,0,0))],
    "sst":    [(0,(20,20,90)),(0.35,(30,110,190)),(0.55,(60,180,170)),
               (0.62,(250,250,180)),(0.75,(245,160,60)),(1,(170,20,30))],
}


def build_lut(name):
    """256-entry RGB lookup table for a ramp, built once and reused."""
    stops = RAMPS[name]
    lut = np.zeros((256, 3), dtype=np.uint8)
    for i in range(256):
        t = i / 255.0
        for j in range(1, len(stops)):
            p0, c0 = stops[j - 1]
            p1, c1 = stops[j]
            if t <= p1 or j == len(stops) - 1:
                f = 0.0 if p1 == p0 else (t - p0) / (p1 - p0)
                f = min(max(f, 0.0), 1.0)
                lut[i] = [round(c0[k] + (c1[k] - c0[k]) * f) for k in range(3)]
                break
    return lut


LUTS = {name: build_lut(name) for name in RAMPS}


# ── NOAA ────────────────────────────────────────────────────────────────────

def fhours_for(m):
    """
    The forecast hours to fetch for a model, from its step and reach.

    "first" exists because not every model has an hour zero. The National
    Blend has nothing at f000, because a blend of forecasts has nothing to say
    about a time that has already happened, and asking for it got a 404 that
    read as the whole model being missing.
    """
    return list(range(m.get("first", 0), m["out"] + 1, m["step"]))


def raw_candidates(m):
    """
    The index paths to try, in order.

    A list rather than a string because a few products are published under
    more than one name and the right one is not guessable from here. The first
    that answers is used, and check_models.py reports which.
    """
    raw = m["raw"]
    raw = raw if isinstance(raw, (list, tuple)) else [raw]
    # A storm following model has one more thing in its filename than a date
    # and an hour, and format leaves an unknown field alone only if it is
    # given, so it is filled in here rather than at every call site.
    storm = m.get("storm")
    return [r.replace("{storm}", storm) if storm else r for r in raw]


def find_index(m, date_str, cyc, fhr, timeout=30):
    """The first index path that answers, with its text. (url, text) or None."""
    for tmpl in raw_candidates(m):
        url = f"{RAW_BASE}/" + tmpl.format(date=date_str, cyc=cyc, fhr=fhr)
        try:
            r = http_get(url, timeout=timeout)
        except requests.RequestException:
            continue
        if r.status_code == 200 and ":" in r.text and "<" not in r.text[:40]:
            return url, r.text
    return None


def cycle_for(m, now=None):
    """
    The most recent run of this model that should actually be published.

    The lag is subtracted before rounding to the cycle. Rounding the clock
    alone picks a run that does not exist yet, and then every wake-up sits
    waiting for it. Each model has its own cadence and its own lag: GFS runs
    four times a day and lands about five hours later, HRRR runs every hour and
    lands about two.

    cycle_offset is for a model whose runs do not start at midnight. Rounding
    assumes cycle zero is 00z, which is true of everything on NOMADS except
    where we deliberately want one run a day out of a model that publishes
    several: a daily cadence rounds to 00z, and if the run we actually want is
    12z then the offset is what says so. It must be smaller than cycle_h.
    """
    now = now or datetime.now(timezone.utc)
    t = now - timedelta(hours=m["lag_h"])
    off = m.get("cycle_offset", 0)
    hour = t.hour - off
    if hour < 0:
        # Before today's first cycle, so the newest run is yesterday's last.
        t -= timedelta(days=1)
        hour += 24
    cyc = (hour // m["cycle_h"]) * m["cycle_h"] + off
    return t.strftime("%Y%m%d"), f"{cyc:02d}"


def run_is_complete(m, date_str, cyc):
    """
    True when the last forecast hour of this run has published.

    Checked against the real index file on the data path. The filter service
    does not serve .idx at all: asking it for one returns an HTML error with a
    200, which reads as success and makes the check useless.
    """
    last = fhours_for(m)[-1]
    if m.get("source") == "ecmwf":
        return ecmwf_index(m, date_str, cyc, last, timeout=30)[1] is not None
    if m.get("source") in URL_SOURCES:
        # No index to ask, so the last hour's first file standing in for the
        # run being finished is the best available signal.
        try:
            r = http_get(URL_SOURCES[m["source"]](m, date_str, cyc, last)[0],
                         timeout=30, headers={"Range": "bytes=0-32"})
            return r.status_code in (200, 206)
        except requests.RequestException:
            return False
    return find_index(m, date_str, cyc, last) is not None


def fetch_hour(m, date_str, cyc, fhr, path):
    """
    Download one forecast hour, cropped to the box by NOAA before sending.

    The ask is built from NOAA's index for this exact file, so it names only
    fields that are in there. That is what makes a model work rather than
    return 500: the service refuses the entire request over one field it does
    not have, and every model spells its fields and levels a little
    differently.

    Two fallbacks behind that, for when the index cannot be read at all: the
    model's declared list, then the four fields every model carries. A chart
    with four fields beats no chart.
    """
    if m.get("source") == "ecmwf":
        return fetch_hour_ecmwf(m, date_str, cyc, fhr, path)
    if m.get("source") in URL_SOURCES:
        return fetch_hour_files(m, date_str, cyc, fhr, path)
    if m.get("fetch") == "range":
        return fetch_hour_range(m, date_str, cyc, fhr, path)

    attempts = []
    pairs = inventory(m, date_str, cyc, fhr)
    if pairs:
        v, l = ask_from_inventory(
            pairs, SHEAR_LEVEL_NAMES if m.get("shear") else ())
        if v and l:
            attempts.append((v, l, "indexed"))
    attempts.append((m.get("vars", VAR_FLAGS), m.get("levs", LEV_FLAGS), "declared"))
    attempts.append((FALLBACK_VARS, FALLBACK_LEVS, "reduced"))
    url = f"{FILTER_BASE}/{m['filter']}"
    last = ""
    for vars_, levs_, what in attempts:
        params = {
            "file": m["file"].format(cyc=cyc, fhr=fhr),
            "dir": m["dir"].format(date=date_str, cyc=cyc),
            "subregion": "",
            **{k: "on" for k in vars_},
            **{k: "on" for k in levs_},
            # Each model states the box it wants, so a tropical model is
            # cropped to the tropics rather than to the United States.
            **{k: v for k, v in m.get("box", BOX).items()},
        }
        for attempt in range(RETRIES):
            try:
                r = http_get(url, params=params, timeout=REQUEST_TIMEOUT)
                if (r.status_code == 200 and len(r.content) > 5000
                        and r.content[:4] == b"GRIB"):
                    with open(path, "wb") as f:
                        f.write(r.content)
                    if what != "indexed":
                        log(f"    f{fhr:03d}: index unusable, took the {what} set")
                    return True
                last = f"HTTP {r.status_code}, {len(r.content)} bytes"
                # A refusal is about what was asked for, not about timing, so
                # asking the same thing again just wastes the wait.
                if r.status_code in (400, 404, 500):
                    break
            except requests.RequestException as e:
                last = str(e)
            time.sleep(2 ** attempt)
    log(f"    f{fhr:03d}: {last}")
    return False


# ── Decode and render ───────────────────────────────────────────────────────

def open_fields(grib_path, regrid_box=None):
    """
    Pull the wanted fields out of a GRIB file as plain arrays.

    Read with eccodes directly rather than through cfgrib and xarray. A GRIB
    file is a flat sequence of self-describing messages, which is exactly the
    shape this needs: walk them, read the keys, keep the ones wanted. Going via
    xarray means asking it to assemble those messages into labelled cubes and
    then taking them apart again, which on a mixed file it cannot always do at
    all, and which drags a large dependency onto a small board for no gain.

    Matched on shortName, typeOfLevel and level, which are GRIB's own keys and
    do not drift, rather than on a variable name invented during conversion.

    Returns {key: (2-D array, lats, lons)}.
    """
    import eccodes

    found = {}
    uv = {}
    coords = {}        # real point coordinates, per grid, read at most once
    seen = []          # every message in the file, for when nothing matches

    try:
        fh = open(grib_path, "rb")
    except OSError as e:
        log(f"    open failed: {e}")
        return found

    try:
        while True:
            try:
                gid = eccodes.codes_grib_new_from_file(fh)
            except Exception as e:
                log(f"    message read failed: {e}")
                break
            if gid is None:
                break
            try:
                short = str(eccodes.codes_get(gid, "shortName"))
                levt = str(eccodes.codes_get(gid, "typeOfLevel"))
                lev = int(eccodes.codes_get(gid, "level"))
                seen.append(f"{short}/{levt}/{lev}")
                ni = int(eccodes.codes_get(gid, "Ni"))
                nj = int(eccodes.codes_get(gid, "Nj"))

                want = short in ("10u", "10v") or any(
                    _matches(s, short, levt, lev) for s in FIELDS.values())
                if not want:
                    continue

                # Ask for missing values as NaN so gaps stay gaps rather than
                # becoming a real number at the edge of the colour scale.
                try:
                    eccodes.codes_set(gid, "missingValue", float("nan"))
                except Exception:
                    pass

                vals = np.asarray(eccodes.codes_get_values(gid),
                                  dtype=np.float32)
                if vals.size != ni * nj:
                    log(f"    {short}: {vals.size} values for a {ni}x{nj} grid")
                    continue
                arr = vals.reshape(nj, ni)

                # Only a grid that really is evenly spaced in latitude and
                # longitude can be described by its two corners. Everything
                # else has to be asked where each point is.
                gtype = str(eccodes.codes_get(gid, "gridType"))
                if gtype == "regular_ll":
                    lat1 = float(eccodes.codes_get(
                        gid, "latitudeOfFirstGridPointInDegrees"))
                    lat2 = float(eccodes.codes_get(
                        gid, "latitudeOfLastGridPointInDegrees"))
                    lon1 = float(eccodes.codes_get(
                        gid, "longitudeOfFirstGridPointInDegrees"))
                    lon2 = float(eccodes.codes_get(
                        gid, "longitudeOfLastGridPointInDegrees"))
                    lats = np.linspace(lat1, lat2, nj)
                    lons = np.linspace(lon1, lon2, ni)
                elif regrid_box is not None:
                    # Read once per file: every message in it shares a grid,
                    # and pulling several million coordinates per message
                    # would cost more than the decode.
                    sig = (gtype, ni, nj)
                    if sig not in coords:
                        coords[sig] = (
                            np.asarray(eccodes.codes_get_array(
                                gid, "latitudes"), dtype=np.float32),
                            np.asarray(eccodes.codes_get_array(
                                gid, "longitudes"), dtype=np.float32))
                    plats, plons = coords[sig]
                    got = regrid_to_latlon(vals, plats, plons, regrid_box)
                    if got is None:
                        continue
                    arr, lats, lons = got
                else:
                    log(f"    {short}: {gtype} grid and nowhere to put it")
                    continue

                if short in ("10u", "10v"):
                    uv[short] = (arr, lats, lons)
                    continue

                # Wind components at the two shear levels, kept aside the same
                # way. Nothing draws the wind at 200 mb on its own; it is only
                # here to be differenced against 850.
                if short in ("u", "v") and levt == "isobaricInhPa" \
                        and lev in SHEAR_LEVELS:
                    uv[f"{short}{lev}"] = (arr, lats, lons)
                    continue

                for key, spec in FIELDS.items():
                    if not _matches(spec, short, levt, lev):
                        continue
                    # A file can hold more than one spelling of the same field:
                    # NAM carries PRMSL and MSLET at mean sea level, and they
                    # are not identical. Last one read used to win, which made
                    # the chart depend on the order messages happen to sit in
                    # the file. The order in FIELDS is the preference, so an
                    # earlier spelling is never replaced by a later one.
                    rank = spec["short"].index(short)
                    if key in found and found[key][3] <= rank:
                        continue
                    found[key] = (arr, lats, lons, rank)
            except Exception as e:
                # One unreadable message should cost that message, not the run.
                log(f"    skipping a message: {e}")
            finally:
                try:
                    eccodes.codes_release(gid)
                except Exception:
                    pass
    finally:
        fh.close()

    # Drop the preference rank now it has done its job, so callers see the
    # (values, lats, lons) they expect.
    found = {k: v[:3] for k, v in found.items()}

    # Only worked out from the components when the file did not simply carry
    # the speed. A file that has both is not overridden by the derived one.
    if "wind" not in found and "10u" in uv and "10v" in uv:
        u, lats, lons = uv["10u"]
        v = uv["10v"][0]
        found["wind"] = (np.sqrt(u ** 2 + v ** 2), lats, lons)

    # Shear is the length of the difference between the two wind vectors, not
    # the difference of their two speeds. Those are not the same thing and the
    # distinction is the whole point: a 40 knot wind at both levels blowing in
    # opposite directions is 80 knots of shear and shreds a storm, while the
    # difference of the speeds would call it zero and say the storm was fine.
    hi, lo = SHEAR_LEVELS
    if all(f"{c}{p}" in uv for c in ("u", "v") for p in (hi, lo)):
        du = uv[f"u{hi}"][0] - uv[f"u{lo}"][0]
        dv = uv[f"v{hi}"][0] - uv[f"v{lo}"][0]
        found["shear"] = (np.sqrt(du ** 2 + dv ** 2), uv[f"u{hi}"][1],
                          uv[f"u{hi}"][2])

    # A file full of messages that matched nothing means the keys in FIELDS
    # disagree with what this eccodes build calls them. Printing what was
    # actually there turns that from a silent skip into a one-line fix.
    if not found and seen:
        log(f"    {len(seen)} messages, none matched. Present: "
            + ", ".join(sorted(set(seen))[:24]))

    return found


def render_png(values, lats, spec, out_path):
    """
    Turn one field into an RGBA PNG the size of the grid.

    Written straight from the array, so one pixel is one grid cell and the
    image lines up exactly with the bounds given to Leaflet. Nothing crops or
    pads it, which is what goes wrong when this is done through a plot.

    A very fine grid is thinned first. HRRR and the NAM nest are 3 km, which
    across this box is about 2300 by 1300 cells, and the blend is finer still.
    That is a picture of several million pixels, which the PlayStation 5
    browser has to hold in memory decoded, and it has little to spare. Taking
    every second or third cell keeps the long edge under the cap below, and at
    that size a pixel is still about 4 km, which is the width of a couple of
    city blocks more than the model's own resolution. Thinning by striding
    rather than averaging is deliberate: an average of reflectivity smears a
    storm's core into its surroundings, where taking every Nth cell leaves the
    values the model actually produced.
    """
    data = spec["convert"](np.asarray(values, dtype=np.float32))

    step = max(1, int(np.ceil(max(data.shape) / float(MAX_EDGE_PX))))
    if step > 1:
        # Picked with linspace rather than a plain [::step] slice so the first
        # and last cell are always kept. A slice drops up to step-1 cells off
        # the far edge, and since the image is stretched to fixed bounds, that
        # is not a smaller picture, it is the same picture shifted: every
        # feature slides a few kilometres north and west of where it happened.
        pick = lambda n: np.unique(np.linspace(
            0, n - 1, int(np.ceil(n / float(step)))).round().astype(int))
        rows, cols = pick(data.shape[0]), pick(data.shape[1])
        data = data[np.ix_(rows, cols)]
        if lats is not None and len(lats) > 1:
            lats = np.asarray(lats)[rows]

    # GRIB usually scans north to south. An image's first row is its top, which
    # is also north, so the array only needs flipping when it does not.
    if lats is not None and len(lats) > 1 and lats[0] < lats[-1]:
        data = np.flipud(data)

    lo, hi = spec["range"]
    norm = (data - lo) / float(hi - lo)
    bad = ~np.isfinite(norm)
    idx = np.clip(np.nan_to_num(norm) * 255.0, 0, 255).astype(np.uint8)

    rgb = LUTS[spec["ramp"]][idx]
    alpha = np.full(idx.shape, 200, dtype=np.uint8)
    alpha[bad] = 0
    # Values at the very bottom of the scale are usually "nothing here" for
    # precipitation and reflectivity, so they fade out instead of tinting the
    # whole map.
    if spec["ramp"] in ("precip", "radar"):
        alpha[idx < 6] = 0

    Image.fromarray(np.dstack([rgb, alpha]), mode="RGBA").save(
        out_path, optimize=True)
    return float(np.nanmin(data)), float(np.nanmax(data))


# ── Housekeeping ────────────────────────────────────────────────────────────

def render_data_png(values, lats, lo, hi, out_path):
    """
    Write a field as numbers rather than as a picture.

    A sounding has to be read back, so the value goes into the pixel: high byte
    in red, low byte in green, 65536 steps across [lo, hi]. Alpha is 0 where
    there is no data. The browser draws this to a canvas, reads one pixel per
    level, and has a profile without any endpoint to ask.

    Blue is left at zero. It is spare precision if a third byte is ever wanted.
    """
    data = np.asarray(values, dtype=np.float32)
    if lats is not None and len(lats) > 1 and lats[0] < lats[-1]:
        data = np.flipud(data)
    span = float(hi - lo) or 1.0
    norm = (data - lo) / span
    bad = ~np.isfinite(norm)
    q = np.clip(np.nan_to_num(norm) * 65535.0, 0, 65535).astype(np.uint32)
    hib = (q >> 8).astype(np.uint8)
    lob = (q & 0xFF).astype(np.uint8)
    zero = np.zeros_like(hib)
    alpha = np.full(hib.shape, 255, dtype=np.uint8)
    alpha[bad] = 0
    Image.fromarray(np.dstack([hib, lob, zero, alpha]), mode="RGBA").save(
        out_path, optimize=True)


def open_levels(grib_path):
    """
    Pull pressure-level fields out of a GRIB file.

    Same walk as open_fields, but keyed by (variable, level) since a sounding
    wants the same variable at every level rather than one field.
    """
    import eccodes
    found = {}
    try:
        fh = open(grib_path, "rb")
    except OSError:
        return found
    try:
        while True:
            try:
                gid = eccodes.codes_grib_new_from_file(fh)
            except Exception:
                break
            if gid is None:
                break
            try:
                levt = str(eccodes.codes_get(gid, "typeOfLevel"))
                if levt != "isobaricInhPa":
                    continue
                short = str(eccodes.codes_get(gid, "shortName"))
                lev = int(eccodes.codes_get(gid, "level"))
                if lev not in SND_LEVELS:
                    continue
                key = next((k for k, v in SND_VARS.items() if short in v["short"]), None)
                if key is None:
                    continue
                ni = int(eccodes.codes_get(gid, "Ni"))
                nj = int(eccodes.codes_get(gid, "Nj"))
                try:
                    eccodes.codes_set(gid, "missingValue", float("nan"))
                except Exception:
                    pass
                vals = np.asarray(eccodes.codes_get_values(gid), dtype=np.float32)
                if vals.size != ni * nj:
                    continue
                lat1 = float(eccodes.codes_get(gid, "latitudeOfFirstGridPointInDegrees"))
                lat2 = float(eccodes.codes_get(gid, "latitudeOfLastGridPointInDegrees"))
                found[(key, lev)] = (vals.reshape(nj, ni),
                                     np.linspace(lat1, lat2, nj))
            except Exception as e:
                log(f"    skipping a level message: {e}")
            finally:
                try:
                    eccodes.codes_release(gid)
                except Exception:
                    pass
    finally:
        fh.close()
    return found


def fetch_sounding_hour(m, date_str, cyc, fhr, path):
    """One forecast hour of pressure-level data, cropped to the box."""
    params = {
        "file": m["file"].format(cyc=cyc, fhr=fhr),
        "dir": m["dir"].format(date=date_str, cyc=cyc),
        "subregion": "",
        **{k: "on" for k in SND_VAR_FLAGS},
        **{f"lev_{lev}_mb": "on" for lev in SND_LEVELS},
        **{k: v for k, v in BOX.items()},
    }
    url = f"{FILTER_BASE}/{m['filter']}"
    for attempt in range(RETRIES):
        try:
            r = http_get(url, params=params, timeout=REQUEST_TIMEOUT)
            if (r.status_code == 200 and len(r.content) > 5000
                    and r.content[:4] == b"GRIB"):
                with open(path, "wb") as f:
                    f.write(r.content)
                return True
            if attempt == RETRIES - 1:
                log(f"    snd f{fhr:03d}: HTTP {r.status_code}, {len(r.content)} bytes")
        except requests.RequestException as e:
            if attempt == RETRIES - 1:
                log(f"    snd f{fhr:03d}: {e}")
        time.sleep(2 ** attempt)
    return False


def build_soundings(name="gfs"):
    """Build the pressure-level stack a sounding is read from."""
    m = MODELS[name]
    date_str, cyc = cycle_for(m)
    run_id = f"{date_str}_{cyc}"
    snd_dir = os.path.join(OUT_DIR, "sounding", run_id)
    done = os.path.join(snd_dir, "manifest.json")

    if os.path.exists(done):
        try:
            with open(done) as f:
                return json.load(f)
        except (OSError, ValueError):
            pass
    if not run_is_complete(m, date_str, cyc):
        return _newest_manifest(os.path.join(OUT_DIR, "sounding"))

    log(f"sounding: building {run_id} ({len(SND_HOURS)} hours x "
        f"{len(SND_VARS)} vars x {len(SND_LEVELS)} levels)")
    os.makedirs(snd_dir, exist_ok=True)
    t0 = time.time()
    hours_done = []
    shape = None

    for fhr in SND_HOURS:
        with tempfile.NamedTemporaryFile(suffix=".grib2", delete=False) as tf:
            tmp = tf.name
        try:
            if not fetch_sounding_hour(m, date_str, cyc, fhr, tmp):
                continue
            levels = open_levels(tmp)
            if not levels:
                continue
            wrote = 0
            for (var, lev), (arr, lats) in levels.items():
                spec = SND_VARS[var]
                lo, hi = spec["range"]
                render_data_png(spec["convert"](arr), lats, lo, hi,
                                os.path.join(snd_dir, f"{var}_{lev}_f{fhr:03d}.png"))
                shape = shape or [int(arr.shape[0]), int(arr.shape[1])]
                wrote += 1
            if wrote:
                hours_done.append(fhr)
                log(f"  snd f{fhr:03d} ok ({wrote} level fields)")
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass

    if not hours_done:
        log("sounding: no hours succeeded")
        return _newest_manifest(os.path.join(OUT_DIR, "sounding"))

    manifest = {
        "kind": "sounding", "model": name, "run": run_id,
        "cycle": f"{date_str}T{cyc}:00Z",
        "built_at": datetime.now(timezone.utc).isoformat(),
        "bounds": BOUNDS_LATLON, "shape": shape,
        "levels": SND_LEVELS, "hours": hours_done,
        # The client needs these to turn a pixel back into a number.
        "vars": {k: {"min": v["range"][0], "max": v["range"][1],
                     "unit": ("C" if k == "t" else "%" if k == "rh" else "kt")}
                 for k, v in SND_VARS.items()},
        "encoding": "value = min + ((R*256 + G) / 65535) * (max - min); alpha 0 means no data",
        "pattern": "{var}_{level}_f{fhr:03d}.png",
        "seconds": round(time.time() - t0, 1),
    }
    write_json(done, manifest)
    log(f"sounding: {len(hours_done)}/{len(SND_HOURS)} hours in {manifest['seconds']}s")
    prune(os.path.join(OUT_DIR, "sounding"))
    return manifest


def prune(model_dir, keep=KEEP_RUNS):
    """Keep the newest few runs of one model and drop the rest."""
    if not os.path.isdir(model_dir):
        return
    runs = sorted(d for d in os.listdir(model_dir)
                  if os.path.isdir(os.path.join(model_dir, d)) and d[0].isdigit())
    for old in (runs[:-keep] if len(runs) > keep else []):
        log(f"  pruning {os.path.basename(model_dir)}/{old}")
        shutil.rmtree(os.path.join(model_dir, old), ignore_errors=True)


class Lock:
    """
    Stops two runs overlapping.

    Cron fires hourly and a run takes minutes, so without this a slow run gets
    a second copy of itself on top, both writing the same files and both
    hammering NOAA.
    """

    def __init__(self, path=os.path.expanduser("~/.gwcfc-models.lock")):
        self.path = path
        self.fd = None

    def __enter__(self):
        try:
            self.fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(self.fd, str(os.getpid()).encode())
            return self
        except FileExistsError:
            # The lock records a pid, so ask whether that process is still
            # alive rather than waiting out a timeout. Closing the terminal on
            # a run leaves the file behind with nothing holding it, and an hour
            # of cron refusing to start because of a process that died is a
            # worse failure than the one the lock is for.
            if not self._holder_alive():
                log("clearing a lock left by a run that is no longer running")
                try:
                    os.unlink(self.path)
                except OSError:
                    pass
                return self.__enter__()
            log("another run is already going; exiting")
            sys.exit(0)

    def _holder_alive(self):
        """True only if the pid in the lock file is a process that still exists."""
        try:
            with open(self.path) as f:
                pid = int(f.read().strip() or 0)
        except (OSError, ValueError):
            return False              # unreadable or empty: not a live holder
        if pid <= 0 or pid == os.getpid():
            return False
        try:
            os.kill(pid, 0)           # signal 0 only tests for existence
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True               # exists, owned by someone else
        except OSError:
            return False

    def __exit__(self, *exc):
        if self.fd is not None:
            os.close(self.fd)
        try:
            os.unlink(self.path)
        except OSError:
            pass


# ── Main ────────────────────────────────────────────────────────────────────

NHC_STORMS = "https://www.nhc.noaa.gov/CurrentStorms.json"
_storms_cache = {"at": 0, "ids": []}


def active_storms():
    """
    The storms the Hurricane Center currently lists, as HAFS names them.

    HAFS publishes one run per storm, named for it: 05l is the fifth Atlantic
    storm of the season, 03e the third eastern Pacific one. Nothing in a fixed
    list can know that, so it is asked.

    Cached for the length of a build, because every HAFS model would otherwise
    ask again for an answer that cannot have changed in the meantime.
    """
    if time.time() - _storms_cache["at"] < 900:
        return _storms_cache["ids"]
    ids = []
    try:
        r = http_get(NHC_STORMS, timeout=30)
        if r.status_code == 200:
            for st in (r.json().get("activeStorms") or []):
                # "al052026" is basin, number, year. HAFS wants "05l": the
                # number, then one letter for the basin.
                sid = str(st.get("id") or "").lower()
                if len(sid) >= 8 and sid[:2] in ("al", "ep", "cp", "wp"):
                    ids.append(f"{sid[2:4]}{sid[0]}")
    except Exception as e:
        log(f"could not read the storm list: {e}")
    _storms_cache.update(at=time.time(), ids=ids)
    if ids:
        log(f"active storms: {', '.join(ids)}")
    return ids


def regions_of(m):
    """
    The regions a model is built for, defaulting to the main box.

    A storm following model has no fixed regions: what exists depends on what
    is out there today, so its regions are the storms rather than places.
    """
    if m.get("per_storm"):
        return active_storms()
    return list((m.get("regions") or {"conus": {}}).keys())


def build_model(name, m, region="conus"):
    """
    Build one run of one model over one region.

    Returns its manifest, or None if there is nothing to do.
    """
    m = region_spec(m, region)
    date_str, cyc = cycle_for(m)
    run_id = f"{date_str}_{cyc}"
    model_dir = os.path.join(OUT_DIR, name, region)
    run_dir = os.path.join(model_dir, run_id)
    done = os.path.join(run_dir, "manifest.json")

    if os.path.exists(done):
        try:
            with open(done) as f:
                man = json.load(f)
            if man.get("fields"):
                return man
            log(f"{name}: {run_id} manifest is empty, rebuilding")
        except (OSError, ValueError):
            log(f"{name}: {run_id} manifest is unreadable, rebuilding")

    if not run_is_complete(m, date_str, cyc):
        log(f"{name}: {run_id} not published yet")
        return _newest_manifest(model_dir)

    hours = fhours_for(m)
    log(f"{name}: building {run_id} ({len(hours)} hours)")
    os.makedirs(run_dir, exist_ok=True)
    t0 = time.time()

    built = {}
    ranges = {}
    scales = {}
    ok = 0
    # Filled in by the crop, for sources that send the whole world. The box
    # asked for and the box that comes back are not identical: a grid has a
    # spacing, so the edges land on the nearest cell. Recording what was
    # actually kept is what stops the image being stretched to a rectangle it
    # does not fill.
    bounds_seen = None
    for fhr in hours:
        with tempfile.NamedTemporaryFile(suffix=".grib2", delete=False) as tf:
            tmp = tf.name
        try:
            if not fetch_hour(m, date_str, cyc, fhr, tmp):
                continue
            # A model on its own projection is put onto a plain lat/lon mesh
            # here, which crops it at the same time.
            fields = open_fields(tmp, m.get("box", BOX))
            if not fields:
                continue
            for key, (vals, lats, _lons) in fields.items():
                spec = FIELDS.get(key)
                if spec is None:
                    continue
                # A source with no cropping service sends the whole world, so
                # the box is applied here instead. The bounds that come back
                # are the extent actually kept rather than the extent asked
                # for, which is what keeps the picture and the rectangle it is
                # stretched into the same shape.
                if m.get("crop"):
                    cut = crop_to_box(vals, lats, _lons, m.get("box", BOX))
                    if cut is None:
                        continue
                    vals, lats, _lons, _b = cut
                # Always taken from the data, for every model. The box asked
                # for and the grid that comes back are never quite the same
                # thing, and the difference is what puts a picture a few
                # kilometres from where it belongs.
                bounds_seen = bounds_from(lats, _lons)
                # A model may override the scale. Spread is a distance, so
                # the deterministic range would put every value at one end.
                if m.get("ranges", {}).get(key) or m.get("ramp"):
                    spec = dict(spec)
                    if m.get("ranges", {}).get(key):
                        spec["range"] = m["ranges"][key]
                    if m.get("ramp"):
                        spec["ramp"] = m["ramp"]
                # The scale the picture was painted with, recorded so the
                # site's Inspector can turn a pixel color back into the
                # number it stood for. min/max below are what the data did;
                # this is what the colors mean, which is not the same thing.
                scales[key] = {"lo": spec["range"][0], "hi": spec["range"][1],
                               "ramp": spec["ramp"]}
                lo, hi = render_png(vals, lats, spec,
                                    os.path.join(run_dir, f"{key}_f{fhr:03d}.png"))
                built.setdefault(key, []).append(fhr)
                r = ranges.setdefault(key, [lo, hi])
                r[0], r[1] = min(r[0], lo), max(r[1], hi)
            ok += 1
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass

    if ok == 0:
        log(f"{name}: no hours succeeded, leaving no manifest so it retries")
        return _newest_manifest(model_dir)

    manifest = {
        "model": name, "label": m["label"], "res": m["res"],
        "run": run_id, "cycle": f"{date_str}T{cyc}:00Z",
        "built_at": datetime.now(timezone.utc).isoformat(),
        "bounds": bounds_seen or m.get("bounds", BOUNDS_LATLON),
        "hours": hours,
        "fields": {k: {"hours": v,
                       "min": round(ranges[k][0], 2), "max": round(ranges[k][1], 2),
                       "scale": scales.get(k),
                       "pattern": f"{k}_f{{fhr:03d}}.png"}
                   for k, v in built.items()},
        "seconds": round(time.time() - t0, 1),
    }
    # Written last: a run that died halfway leaves no manifest, so the site
    # keeps serving the previous complete one rather than a half-built set.
    write_json(done, manifest)
    log(f"{name}: {ok}/{len(hours)} hours in {manifest['seconds']}s")
    prune(model_dir)
    return manifest


def _newest_manifest(model_dir):
    """The most recent finished run of a model, if there is one."""
    if not os.path.isdir(model_dir):
        return None
    for run in sorted((d for d in os.listdir(model_dir) if d[0].isdigit()),
                      reverse=True):
        p = os.path.join(model_dir, run, "manifest.json")
        if os.path.exists(p):
            try:
                with open(p) as f:
                    return json.load(f)
            except (OSError, ValueError):
                continue
    return None


def _model_head(name, m):
    """A model's entry in the index, before any of its regions are filled in."""
    return {"label": m.get("label", name), "res": m.get("res", ""),
            "regions": {}}


def _index_entry(name, region, man):
    """One model's line in latest.json, which is all the page reads to start."""
    return {
        "label": man.get("label", name), "res": man.get("res", ""),
        "run": man["run"], "cycle": man.get("cycle", ""),
        "path": f"{name}/{region}/{man['run']}/manifest.json",
        "fields": sorted(man.get("fields", {}).keys()),
        "bounds": man.get("bounds"),
    }


def _publish(index, names, any_ok=True):
    """
    Write latest.json, filling in anything on disk that this run has not
    reached yet, so the file is always the full picture of what exists rather
    than only what today's run has got to.
    """
    for name in names:
        m = MODELS.get(name)
        if not m:
            continue
        for reg in regions_of(m):
            if reg in (index["models"].get(name, {}).get("regions") or {}):
                continue
            man = _newest_manifest(os.path.join(OUT_DIR, name, reg))
            if man:
                index["models"].setdefault(name, _model_head(name, m))[
                    "regions"][reg] = _index_entry(name, reg, man)
    index["updated"] = datetime.now(timezone.utc).isoformat()
    write_json(os.path.join(OUT_DIR, "latest.json"), index)
    return bool(index["models"])


def main(models=None):
    names = models or DEFAULT_MODELS
    index = {"updated": datetime.now(timezone.utc).isoformat(), "models": {}}
    any_ok = False
    started = time.time()
    # Only when running the standard list. Naming models explicitly means
    # meaning it, and a hand-run build should finish what it was asked for.
    budget = TIME_BUDGET_S if not models else None

    # Written before anything is built, from whatever is already on disk. The
    # site reads this file and nothing else, so while it is absent there is no
    # map at all: after a reset the whole thing is missing until the first
    # model finishes, which for a large one is twenty minutes of a site that
    # looks broken rather than busy.
    _publish(index, names, any_ok=False)

    # Flattened to model and region, then ordered so anything that has never
    # produced a picture goes first.
    #
    # Without that the tail of the list starves. The hourly models come first
    # by design, they rebuild every hour, and they are the expensive ones, so
    # they would take the budget every single time and a model at the end of
    # the list would never get built at all. Which is exactly what it looks
    # like from the outside: a site showing the first six models and never the
    # other seven, no matter how long you leave it.
    jobs = []
    for name in names:
        if name == "sounding":
            continue                      # handled below
        m = MODELS.get(name)
        if not m:
            log(f"unknown model: {name}")
            continue
        for region in regions_of(m):
            never = _newest_manifest(os.path.join(OUT_DIR, name, region)) is None
            sp = region_spec(m, region)
            # Roughly what this will cost: how many hours, times how big a
            # grid. Only ever compared against other models, so the units do
            # not matter, only the ordering.
            cost = len(fhours_for(sp)) * MB_PER_HOUR.get(name, 5.0)
            jobs.append((0 if never else 1, cost, name, region, m))
    # Never built first, and among those the cheap ones first. A cold start
    # otherwise spends twenty minutes on the single most expensive model
    # before anything at all reaches the site, which looks like nothing is
    # happening. Cheapest first puts most of the list on the map in the first
    # few minutes and lets the big ones fill in behind.
    jobs.sort(key=lambda j: (j[0], j[1]))
    jobs = [(p, n, r, m) for p, _c, n, r, m in jobs]
    fresh = sum(1 for j in jobs if j[0] == 0)
    if fresh:
        log(f"{fresh} of {len(jobs)} have never been built, doing those first")

    for n, (_new, name, region, m) in enumerate(jobs):
        # A never-built model gets the long budget, a refresh gets the short
        # one. Otherwise the first pass never reaches the end of the list: the
        # hourly models are the expensive ones, they go first, and forty
        # minutes is gone before the rest have had a turn.
        limit = CATCHUP_BUDGET_S if _new == 0 else budget
        if limit and time.time() - started > limit:
            # Out of time rather than out of models. Everything already built
            # is kept and listed, and the rest are picked up next run, which
            # will put them first because they are the ones with nothing.
            left = ", ".join(f"{a}/{b}" for _p, a, b, _m in jobs[n:][:6])
            mins = int((time.time() - started) / 60)
            log(f"stopping after {mins} min with {len(jobs) - n} left: {left}"
                + (" ..." if len(jobs) - n > 6 else ""))
            for _p, later, reg, _lm in jobs[n:]:
                man = _newest_manifest(os.path.join(OUT_DIR, later, reg))
                if man:
                    any_ok = True
                    index["models"].setdefault(later, _model_head(
                        later, MODELS[later]))["regions"][reg] = _index_entry(
                            later, reg, man)
            break

        try:
            man = build_model(name, m, region)
        except Exception as e:
            # One model failing must not cost the others.
            log(f"{name}/{region}: failed: {e}")
            man = _newest_manifest(os.path.join(OUT_DIR, name, region))
        if man:
            any_ok = True
            index["models"].setdefault(name, _model_head(name, m))[
                "regions"][region] = _index_entry(name, region, man)
        done = sum(len(v["regions"]) for v in index["models"].values())
        log(f"  [{done}/{len(jobs)}] {name}/{region}"
            + ("" if man else "  nothing yet"))
        # Written as it goes rather than only at the end, so a model that has
        # just finished shows up on the site within the minute instead of
        # waiting for every other model to finish first.
        # Published after every model rather than at the end, so one that has
        # just finished is on the site within the minute.
        any_ok = _publish(index, names) or any_ok

    # Soundings are their own product rather than a model: same source, but
    # pressure levels instead of surface fields, and read back as numbers.
    if not models or "sounding" in names:
        try:
            snd = build_soundings()
        except Exception as e:
            log(f"sounding: failed: {e}")
            snd = _newest_manifest(os.path.join(OUT_DIR, "sounding"))
        if snd:
            any_ok = True
            index["sounding"] = {
                "run": snd["run"], "cycle": snd.get("cycle", ""),
                "path": f"sounding/{snd['run']}/manifest.json",
                "levels": snd.get("levels", []), "hours": snd.get("hours", []),
            }

    if not any_ok:
        log("nothing available from any model")
        return 1

    write_json(os.path.join(OUT_DIR, "latest.json"), index)
    log("index updated: " + ", ".join(
        f"{k}[{'/'.join(v['regions'])}]" for k, v in index["models"].items()))
    return 0


if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)
    with Lock():
        sys.exit(main(sys.argv[1:] or None))
