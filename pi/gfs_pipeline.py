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
# The wave model's regional grids, as published: the Atlantic basin, the
# eastern Pacific, and everything above 50 north.
ATLANTIC_BOX = {"toplat": 55.0, "bottomlat": 0.0,
                "leftlon": 260.0, "rightlon": 360.0}
ATLANTIC_BOUNDS = [[0.0, -100.0], [55.0, 0.0]]
EPACIFIC_BOX = {"toplat": 60.0, "bottomlat": 0.0,
                "leftlon": 190.0, "rightlon": 250.0}
EPACIFIC_BOUNDS = [[0.0, -170.0], [60.0, -110.0]]
ARCTIC_BOX = {"toplat": 90.0, "bottomlat": 50.0,
              "leftlon": 0.0, "rightlon": 360.0}
ARCTIC_BOUNDS = [[50.0, -180.0], [90.0, 180.0]]

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
    # The same ground as CONUS, under its own name, so a model published at
    # two resolutions over one place can offer both without a second control
    # existing purely to say "resolution".
    "conus32": {"label": "CONUS 32 km", "box": BOX,
                "bounds": BOUNDS_LATLON},
    # The wave model's three regional grids. Each is a real published grid
    # rather than a crop invented here, so the box matches what the file
    # actually covers.
    "atlantic": {"label": "Atlantic", "box": ATLANTIC_BOX,
                 "bounds": ATLANTIC_BOUNDS},
    "epacific": {"label": "E Pacific", "box": EPACIFIC_BOX,
                 "bounds": EPACIFIC_BOUNDS},
    "arctic":   {"label": "Arctic", "box": ARCTIC_BOX,
                 "bounds": ARCTIC_BOUNDS},
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
    # The region carries a label of its own ("Alaska"), which must not become
    # the model's label: a NAM run over Alaska is still NAM. It is kept under
    # its own name so the region picker can read it, and the model's label
    # survives into the manifest where the page looks for it.
    box = dict(REGIONS[key])
    spec["region_label"] = box.pop("label", key)
    spec.update(box)
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
# What a high resolution model is asked for.
#
# At 3 km over a large box every extra field is real money, and the fine
# models are most of the bandwidth bill between them, so this used to be six
# fields. Six is not a model, though: HRRR's own file carries the whole storm
# scale picture, and asking it for reflectivity and temperature and nothing
# else threw away the fields it is uniquely good at. Updraft helicity, echo
# tops, hail size and lightning do not exist in a global model at all.
#
# So the full set is the default now. It is roughly three times the download,
# which on a home connection is worth knowing about, and GWCFC_FINE_LEAN=1
# puts any of these models back to the original six.
#
# Still deliberately absent: the pressure levels. A coarse global model is
# just as good at a field that varies smoothly across a continent, and costs
# almost nothing to fetch.
FINE_CORE = {"refc", "t2m", "wind", "gust", "apcp", "cape"}
FINE_FULL = FINE_CORE | {
    # The storm scale fields, which are the reason to open one of these.
    "refd1km", "refd4km", "echotop", "vil", "tcoli", "hail", "ltng",
    "uphl", "hlcy", "shear06", "cin",
    # What a satellite would see, and where the cloud actually sits.
    "satir", "cldbase", "cldtop",
    # The rain and snow line, and the sleet counted apart from the snow.
    "cpofp", "frozr",
    # The everyday ones, at a resolution that actually resolves a valley.
    "d2m", "rh2m", "apt", "mslp", "prate", "snowacc", "vis", "ceil",
    "hpbl", "tcc", "wind80",
}
FINE_FIELDS = FINE_CORE if os.environ.get("GWCFC_FINE_LEAN") else FINE_FULL


MODELS = {
    "gfs": {
        "label": "GFS", "res": "0.25 deg", "cycle_h": 6, "lag_h": 5,
        "filter": "filter_gfs_0p25.pl",
        "dir": "/gfs.{date}/{cyc}/atmos",
        "file": "gfs.t{cyc}z.pgrb2.0p25.f{fhr:03d}",
        "raw": "gfs/prod/gfs.{date}/{cyc}/atmos/gfs.t{cyc}z.pgrb2.0p25.f{fhr:03d}.idx",
        "step": 3, "out": 120,
        # Upper air on. Five pressure level charts on top of the surface
        # set: the 500 mb pattern, the 850 mb air mass, the jet, the mid
        # level moisture and the spin at 500. Costs five more messages a
        # forecast hour and turns a surface model into a full one.
        "upper": True,
        # The tropical crop is not another model, it is this one cut somewhere
        # else and asked different questions: further out, six-hourly, and with
        # the shear field that only means anything over warm water.
        "regions": {"conus": {},
                    "tropics": {"step": 6, "out": 192, "shear": True}},
    },
    # NAM is one model. It was five entries in the list, because NOAA publishes
    # the same run cropped and re-gridded under four other filenames, and each
    # of those had been added as if it were a separate forecast. Reading "NAM"
    # and "NAM Alaska" as two models is wrong the same way "GFS" and "GFS
    # Tropical" were: it is one forecast, cut somewhere else. So the four nests
    # and the wider coarse grid are regions of it, chosen beside the model.
    #
    # Every region names its own file, because a nest genuinely is a different
    # file from the parent, and its own resolution, because they differ. Only
    # the directory, the host and the level list are shared.
    "nam": {
        "fetch": "range",
        "label": "NAM", "res": "12 km", "cycle_h": 6, "lag_h": 4,
        "filter": "filter_nam.pl",
        "dir": "/nam.{date}",
        "file": "nam.t{cyc}z.awphys{fhr:02d}.tm00.grib2",
        "raw": "nam/prod/nam.{date}/nam.t{cyc}z.awphys{fhr:02d}.tm00.grib2.idx",
        "step": 3, "out": 60,
        # Upper air on. Five pressure level charts on top of the surface
        # set: the 500 mb pattern, the 850 mb air mass, the jet, the mid
        # level moisture and the spin at 500. Costs five more messages a
        # forecast hour and turns a surface model into a full one.
        "upper": True,
        # Backslashes are real characters here, not an escape for this file:
        # the service reads a level name as a regular expression, so brackets
        # have to be escaped for it. They must NOT be percent-encoded in
        # advance either, since the request encoder does that itself.
        "levs": ["lev_2_m_above_ground", "lev_10_m_above_ground",
                 "lev_mean_sea_level", "lev_surface",
                 r"lev_entire_atmosphere_\(considered_as_a_single_layer\)"],
        "regions": {
            "conus": {},
            "alaska": {
                "res": "6 km",
                "file": "nam.t{cyc}z.alaskanest.hiresf{fhr:02d}.tm00.grib2",
                "raw": "nam/prod/nam.{date}/"
                       "nam.t{cyc}z.alaskanest.hiresf{fhr:02d}.tm00.grib2.idx",
            },
            "hawaii": {
                "res": "6 km",
                "file": "nam.t{cyc}z.hawaiinest.hiresf{fhr:02d}.tm00.grib2",
                "raw": "nam/prod/nam.{date}/"
                       "nam.t{cyc}z.hawaiinest.hiresf{fhr:02d}.tm00.grib2.idx",
            },
            "prico": {
                "res": "6 km",
                "file": "nam.t{cyc}z.priconest.hiresf{fhr:02d}.tm00.grib2",
                "raw": "nam/prod/nam.{date}/"
                       "nam.t{cyc}z.priconest.hiresf{fhr:02d}.tm00.grib2.idx",
            },
            # Not a place but a grid: the same run published over a domain
            # that reaches well past the CONUS cut, and further out in time.
            # A region because that is the control the page already has for
            # "the same forecast, drawn differently", and inventing a second
            # one would be a worse answer than reusing this.
            "conus32": {
                "res": "32 km", "out": 84,
                "file": "nam.t{cyc}z.awip32{fhr:02d}.tm00.grib2",
                "raw": "nam/prod/nam.{date}/"
                       "nam.t{cyc}z.awip32{fhr:02d}.tm00.grib2.idx",
            },
        },
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
        # Upper air on. Five pressure level charts on top of the surface
        # set: the 500 mb pattern, the 850 mb air mass, the jet, the mid
        # level moisture and the spin at 500. Costs five more messages a
        # forecast hour and turns a surface model into a full one.
        "upper": True,
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
        # Alaska is its own file on its own grid, the same as HRRR's, so the
        # region replaces the address rather than only the box.
        "regions": {
            "conus": {},
            "alaska": {
                "res": "13 km",
                "file": "rap.t{cyc}z.awp242f{fhr:02d}.grib2",
                "raw": "rap/prod/rap.{date}/"
                       "rap.t{cyc}z.awp242f{fhr:02d}.grib2.idx",
            },
        },
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
        # One blend, three domains, told apart by a two letter suffix on the
        # filename and nothing else. They were three rows in the model list.
        "regions": {
            "conus": {},
            "alaska": {
                "res": "3 km blend",
                "file": "blend.t{cyc}z.core.f{fhr:03d}.ak.grib2",
                "raw": "blend/prod/blend.{date}/{cyc}/core/"
                       "blend.t{cyc}z.core.f{fhr:03d}.ak.grib2.idx",
            },
            "hawaii": {
                "file": "blend.t{cyc}z.core.f{fhr:03d}.hi.grib2",
                "raw": "blend/prod/blend.{date}/{cyc}/core/"
                       "blend.t{cyc}z.core.f{fhr:03d}.hi.grib2.idx",
            },
        },
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
        # Same reason NAM is one entry: these are the same analysis run over
        # four domains, published under four filenames on four hosts, and they
        # were four separate rows in the model list. The region replaces the
        # whole address here rather than only the filename, because each domain
        # has its own filter service and its own directory.
        "regions": {
            "conus": {},
            "alaska": {
                "res": "3 km analysis",
                "filter": "filter_akrtma.pl",
                "dir": "/akrtma.{date}",
                "file": "akrtma.t{cyc}z.2dvaranl_ndfd_3p0.grb2",
                "raw": "rtma/prod/akrtma.{date}/"
                       "akrtma.t{cyc}z.2dvaranl_ndfd_3p0.grb2.idx",
            },
            "hawaii": {
                "filter": "filter_hirtma.pl",
                "dir": "/hirtma.{date}",
                "file": "hirtma.t{cyc}z.2dvaranl_ndfd.grb2",
                "raw": "rtma/prod/hirtma.{date}/"
                       "hirtma.t{cyc}z.2dvaranl_ndfd.grb2.idx",
            },
            "prico": {
                "filter": "filter_prrtma.pl",
                "dir": "/prrtma.{date}",
                "file": "prrtma.t{cyc}z.2dvaranl_ndfd.grb2",
                "raw": "rtma/prod/prrtma.{date}/"
                       "prrtma.t{cyc}z.2dvaranl_ndfd.grb2.idx",
            },
        },
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
        # The three regional grids are the same model run finer
        # over a smaller box, which is a region rather than
        # another model. Read off the live bucket listing:
        # arctic at 9 km, Atlantic and east Pacific at a sixth
        # of a degree.
        "regions": {
            "tropics": {},
            "atlantic": {
                "res": "0.16 deg",
                "file": "gfswave.t{cyc}z.atlocn.0p16.f{fhr:03d}.grib2",
                "raw": "gfs/prod/gfs.{date}/{cyc}/wave/gridded/"
                       "gfswave.t{cyc}z.atlocn.0p16.f{fhr:03d}.grib2.idx",
            },
            "epacific": {
                "res": "0.16 deg",
                "file": "gfswave.t{cyc}z.epacif.0p16.f{fhr:03d}.grib2",
                "raw": "gfs/prod/gfs.{date}/{cyc}/wave/gridded/"
                       "gfswave.t{cyc}z.epacif.0p16.f{fhr:03d}.grib2.idx",
            },
            "arctic": {
                "res": "9 km",
                "file": "gfswave.t{cyc}z.arctic.9km.f{fhr:03d}.grib2",
                "raw": "gfs/prod/gfs.{date}/{cyc}/wave/gridded/"
                       "gfswave.t{cyc}z.arctic.9km.f{fhr:03d}.grib2.idx",
            },
        },
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
        # Upper air on. Five pressure level charts on top of the surface
        # set: the 500 mb pattern, the 850 mb air mass, the jet, the mid
        # level moisture and the spin at 500. Costs five more messages a
        # forecast hour and turns a surface model into a full one.
        "upper": True,
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
        # Upper air on. Five pressure level charts on top of the surface
        # set: the 500 mb pattern, the 850 mb air mass, the jet, the mid
        # level moisture and the spin at 500. Costs five more messages a
        # forecast hour and turns a surface model into a full one.
        "upper": True,
        "regions": {"conus": {}, "tropics": {"out": 240, "shear": True}},
    },
    "aigfs": {
        # NOAA's machine learned model, the American answer to AIFS. It began
        # life as GraphCastGFS and was renamed; the old name's files stop in
        # May, which is why anything still asking for graphcastgfs finds
        # nothing. It is published only to the open data bucket and never to
        # the file server, so its index is named by full URL.
        #
        # Pressure levels only: thirteen of them, carrying heights,
        # temperature, wind, humidity and vertical motion, and no surface
        # fields at all. That is what makes it an upper air model in the menu
        # rather than another surface one.
        "fetch": "range",
        "label": "AIGFS", "res": "0.25 deg AI", "cycle_h": 6, "lag_h": 6,
        "raw": "https://noaa-nws-graphcastgfs-pds.s3.amazonaws.com/"
               "aigfs.{date}/{cyc}/model/atmos/grib2/"
               "aigfs.t{cyc}z.pres.f{fhr:03d}.grib2.idx",
        # No narrow list. It carries heights, temperature, wind, humidity and
        # vertical motion at thirteen pressure levels, which is fifteen
        # charts on its own, and naming five of them threw the rest away.
        "upper": True,
        "step": 6, "out": 240,
        "regions": {"conus": {}, "tropics": {"out": 384}},
    },
    "ecmwfens": {
        # The ensemble mean, from the enfo stream. Published as type "em"
        # rather than "fc", which is the only real difference in the address.
        "label": "ECMWF ENS mean", "res": "0.25 deg ens", "cycle_h": 12,
        "lag_h": 9,
        # Published as "ef", not "em". The ensemble mean was asked for by a
        # name ECMWF does not use in open data, so every hour 404ed and the
        # model built nothing at all. Checked against the bucket listing.
        "source": "ecmwf", "ecmwf_stream": "enfo", "ecmwf_type": "ef",
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
        # The wave stream's type is "fc" like the atmospheric one, not "wf".
        "source": "ecmwf", "ecmwf_stream": "wave", "ecmwf_type": "fc",
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
        # The AI ensemble publishes a control run ("cf") and perturbed members
        # ("pf"), and no mean. The control is the one member worth drawing.
        "ecmwf_stream": "enfo", "ecmwf_type": "cf",
        "first": 6, "step": 6, "out": 240, "crop": True,
        "regions": {"conus": {}, "tropics": {"shear": True}},
    },

    # ── Twelve more, every address checked against the live buckets ─────────
    # These go to NOAA's open data mirrors on S3 by full URL rather than to
    # NOMADS by path. NOMADS rate limits with a redirect to a throttle page,
    # which reads as a missing file, and a build that adds twelve models to
    # the list is exactly the burst that triggers it. The mirrors carry the
    # identical files with no limit.
    "gefs0p25": {
        # The ensemble mean again, but on the quarter degree grid rather than
        # the half degree one. Twice the detail in each direction, published
        # in a smaller "s" file that carries the everyday fields only, so it
        # is the one to open for a readable ensemble map of the weather
        # rather than for upper air.
        "fetch": "range",
        "label": "GEFS Mean 0.25 deg", "res": "0.25 deg ens",
        "cycle_h": 6, "lag_h": 7,
        "raw": "https://noaa-gefs-pds.s3.amazonaws.com/gefs.{date}/{cyc}/"
               "atmos/pgrb2sp25/geavg.t{cyc}z.pgrb2s.0p25.f{fhr:03d}.idx",
        "step": 6, "out": 168,
        "regions": {"conus": {}, "tropics": {"out": 240}},
    },

    "cfs": {
        # The Climate Forecast System, which is the one model here that is
        # not answering "what is the weather". It runs months out at a coarse
        # grid, so a single day in it means nothing and the pattern over a
        # fortnight means quite a lot. Six hourly surface fluxes.
        "fetch": "range",
        "label": "CFS Seasonal", "res": "0.5 deg seasonal",
        "cycle_h": 6, "lag_h": 8,
        "raw": "https://noaa-cfs-pds.s3.amazonaws.com/cfs.{date}/{cyc}/"
               "6hrly_grib_01/flxf{date}{cyc}.01.{date}{cyc}.grb2.idx",
        "step": 6, "out": 240,
        "regions": {"conus": {}, "tropics": {"out": 384}},
    },

    "urma": {
        # RTMA's later, better cousin. Same analysis at the same 2.5 km, but
        # rerun hours afterwards once the late reporting observations have
        # arrived, so it is the best available answer to "what actually
        # happened" rather than the fastest one.
        "fetch": "range",
        "label": "URMA 2.5 km Analysis", "res": "2.5 km analysis",
        "cycle_h": 1, "lag_h": 7,
        "raw": [
            "https://noaa-urma-pds.s3.amazonaws.com/urma2p5.{date}/"
            "urma2p5.t{cyc}z.2dvaranl_ndfd.grb2_wexp.idx",
            "https://noaa-urma-pds.s3.amazonaws.com/urma2p5.{date}/"
            "urma2p5.t{cyc}z.2dvaranl_ndfd.grb2.idx",
        ],
        "step": 1, "out": 0,
    },

    "gefschem": {
        # The aerosol half of GEFS: dust lifted off deserts, smoke off fires,
        # sea salt and sulphate, carried around the world. This is the model
        # behind a hazy orange sky a continent away from the fire, and the
        # one that says whether Saharan dust is about to sit on top of a
        # developing tropical wave and kill it.
        "fetch": "range",
        "label": "GEFS Aerosol", "res": "0.25 deg aerosol",
        "cycle_h": 12, "lag_h": 8,
        "raw": "https://noaa-gefs-pds.s3.amazonaws.com/gefs.{date}/{cyc}/"
               "chem/pgrb2ap25/gefs.chem.t{cyc}z.a2d_0p25.f{fhr:03d}"
               ".grib2.idx",
        "step": 6, "out": 120,
        "regions": {"conus": {}, "tropics": {"out": 120}},
    },

    "namfire": {
        # NAM's fire weather nest: 1.33 km, and movable. It is repositioned
        # each day over wherever the fire weather threat actually is, so its
        # box is not fixed and its bounds come from the file rather than from
        # a region here.
        "fetch": "range",
        "label": "NAM Fire Weather Nest", "res": "1.33 km",
        "cycle_h": 6, "lag_h": 4,
        "raw": "https://noaa-nam-pds.s3.amazonaws.com/nam.{date}/"
               "nam.t{cyc}z.firewxnest.hiresf{fhr:02d}.tm00.grib2.idx",
        "step": 1, "out": 36,
    },


    "gdas": {
        # The global analysis GFS is launched from: the model's own best
        # estimate of the state of the whole atmosphere right now, at a
        # quarter degree, with every observation on earth folded in. RTMA
        # does this at 2.5 km over the United States; this does it worldwide.
        "fetch": "range",
        "label": "GDAS Global Analysis", "res": "0.25 deg analysis",
        "cycle_h": 6, "lag_h": 7,
        "raw": "https://noaa-gfs-bdp-pds.s3.amazonaws.com/gdas.{date}/{cyc}/"
               "atmos/gdas.t{cyc}z.pgrb2.0p25.f{fhr:03d}.idx",
        "step": 6, "out": 0,
        "upper": True,
        "regions": {"conus": {}, "tropics": {}},
    },

    "gefswavemean": {
        # The wave ensemble's mean. A single wave run says how big the swell
        # will be; the mean of thirty says how confident that is, which for
        # a coastal warning is the more useful half.
        "fetch": "range",
        "label": "GEFS Wave Mean", "res": "0.25 deg wave ens",
        "cycle_h": 6, "lag_h": 7,
        "raw": "https://noaa-gefs-pds.s3.amazonaws.com/gefs.{date}/{cyc}/"
               "wave/gridded/gefs.wave.t{cyc}z.mean.global.0p25"
               ".f{fhr:03d}.grib2.idx",
        "step": 6, "out": 168,
        "regions": {"tropics": {}},
    },

    "gefsp02": {
        # One more member of the ensemble, run from a slightly different
        # starting point. Five of them side by side is what spaghetti is:
        # where they agree the forecast is solid, where they fan out it is a
        # coin toss, and no single chart can tell you which.
        "fetch": "range",
        "label": "GEFS Member 2", "res": "0.5 deg ens",
        "cycle_h": 6, "lag_h": 7,
        "raw": "https://noaa-gefs-pds.s3.amazonaws.com/gefs.{date}/{cyc}/"
               "atmos/pgrb2ap5/gep02.t{cyc}z.pgrb2a.0p50"
               ".f{fhr:03d}.idx",
        "step": 6, "out": 168,
        "upper": True,
        "regions": {"conus": {}, "tropics": {"out": 240, "shear": True}},
    },

    "gefsp03": {
        # One more member of the ensemble, run from a slightly different
        # starting point. Five of them side by side is what spaghetti is:
        # where they agree the forecast is solid, where they fan out it is a
        # coin toss, and no single chart can tell you which.
        "fetch": "range",
        "label": "GEFS Member 3", "res": "0.5 deg ens",
        "cycle_h": 6, "lag_h": 7,
        "raw": "https://noaa-gefs-pds.s3.amazonaws.com/gefs.{date}/{cyc}/"
               "atmos/pgrb2ap5/gep03.t{cyc}z.pgrb2a.0p50"
               ".f{fhr:03d}.idx",
        "step": 6, "out": 168,
        "upper": True,
        "regions": {"conus": {}, "tropics": {"out": 240, "shear": True}},
    },

    "gefsp04": {
        # One more member of the ensemble, run from a slightly different
        # starting point. Five of them side by side is what spaghetti is:
        # where they agree the forecast is solid, where they fan out it is a
        # coin toss, and no single chart can tell you which.
        "fetch": "range",
        "label": "GEFS Member 4", "res": "0.5 deg ens",
        "cycle_h": 6, "lag_h": 7,
        "raw": "https://noaa-gefs-pds.s3.amazonaws.com/gefs.{date}/{cyc}/"
               "atmos/pgrb2ap5/gep04.t{cyc}z.pgrb2a.0p50"
               ".f{fhr:03d}.idx",
        "step": 6, "out": 168,
        "upper": True,
        "regions": {"conus": {}, "tropics": {"out": 240, "shear": True}},
    },

    "gefsp05": {
        # One more member of the ensemble, run from a slightly different
        # starting point. Five of them side by side is what spaghetti is:
        # where they agree the forecast is solid, where they fan out it is a
        # coin toss, and no single chart can tell you which.
        "fetch": "range",
        "label": "GEFS Member 5", "res": "0.5 deg ens",
        "cycle_h": 6, "lag_h": 7,
        "raw": "https://noaa-gefs-pds.s3.amazonaws.com/gefs.{date}/{cyc}/"
               "atmos/pgrb2ap5/gep05.t{cyc}z.pgrb2a.0p50"
               ".f{fhr:03d}.idx",
        "step": 6, "out": 168,
        "upper": True,
        "regions": {"conus": {}, "tropics": {"out": 240, "shear": True}},
    },
    "gefsp06": {
        # One more member of the ensemble, run from a slightly different
        # starting point. Five of them side by side is what spaghetti is:
        # where they agree the forecast is solid, where they fan out it is a
        # coin toss, and no single chart can tell you which.
        "fetch": "range",
        "label": "GEFS Member 6", "res": "0.5 deg ens",
        "cycle_h": 6, "lag_h": 7,
        "raw": "https://noaa-gefs-pds.s3.amazonaws.com/gefs.{date}/{cyc}/"
               "atmos/pgrb2ap5/gep06.t{cyc}z.pgrb2a.0p50"
               ".f{fhr:03d}.idx",
        "step": 6, "out": 168,
        "upper": True,
        "regions": {"conus": {}, "tropics": {"out": 240, "shear": True}},
    },
    "gefsp07": {
        # One more member of the ensemble, run from a slightly different
        # starting point. Five of them side by side is what spaghetti is:
        # where they agree the forecast is solid, where they fan out it is a
        # coin toss, and no single chart can tell you which.
        "fetch": "range",
        "label": "GEFS Member 7", "res": "0.5 deg ens",
        "cycle_h": 6, "lag_h": 7,
        "raw": "https://noaa-gefs-pds.s3.amazonaws.com/gefs.{date}/{cyc}/"
               "atmos/pgrb2ap5/gep07.t{cyc}z.pgrb2a.0p50"
               ".f{fhr:03d}.idx",
        "step": 6, "out": 168,
        "upper": True,
        "regions": {"conus": {}, "tropics": {"out": 240, "shear": True}},
    },
}

# Order matters: this is also the order they are built in, and the time budget
# below stops starting new ones once the hour is nearly gone. So the ones worth
# having most are first, and the long range ones that nobody minds being an
# hour stale are last.
DEFAULT_MODELS = ["hrrr", "rtma", "rap", "gfs", "nam", "namnest", "nbm",
                  "href", "gefs", "gefsspr", "gfswave",
                  "ecmwf", "ecmwfaifs", "aigfs",
                  "hireswarw", "hireswarw2", "hireswfv3",
                  "hrrrsub",
                  "hafs", "hafsb",
                  "gefswave",
                  "iconeu", "cmce",
                  # Same-directory variants of models already building here,
                  # so the address is the most nearly certain kind of guess
                  # available without probing NOAA.
                  "gfs0p50", "gfs1p00",
                  "hrefpmmn", "hrefsprd", "gefsc00", "gefsp01",
                  # Added this pass, every address checked against the live
                  # open data buckets. The analyses and the seasonal run are
                  # cheap; the six ensemble members go last because together
                  # they still cost less than one high resolution model and
                  # nothing breaks if the clock runs out before them.
                  "gdas", "urma", "gefs0p25", "cfs", "gefschem",
                  "namfire", "gefswavemean",
                  "gefsp02", "gefsp03", "gefsp04", "gefsp05",
                  "gefsp06", "gefsp07"]
# NAM's nests, the regional analyses and the regional blends used to be nine
# more names on that list. They are regions of "nam", "rtma" and "nbm" now, so
# they are built by naming the parent: build_model walks a model's regions.
# Nothing was dropped, and nothing new was added.

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

# How small a picture is allowed to be before it gets interpolated up.
#
# One pixel per grid cell is exact, but it is not what anybody sees. A global
# model at 0.25 degrees is about 240 cells across a continental box, and the
# browser stretches those 240 pixels over a screen more than a thousand wide,
# so every cell arrives as a visible square. That is the blockiness: not a
# lack of smoothing, a lack of pixels to smooth.
#
# So a coarse field is resampled up to this long edge before it is coloured.
# The interpolation happens on the VALUES, not on the finished colours, which
# matters: blending two colours from opposite ends of a ramp produces a colour
# from the middle of the ramp, which would paint a temperature that nothing
# forecast. Interpolating the numbers first and colouring afterwards gives the
# colour each interpolated value actually earns.
#
# 1000 rather than the 1600 cap because this is generated detail, not measured
# detail: past about four times the model's own resolution the picture is
# larger without being truer, and every one of those pixels costs Pi time,
# card space and download.
SMOOTH_MIN_EDGE_PX = 1000


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
    "ecmwfaifs": 4.3, "ecmwfens": 4.3, "aigfs": 3.2,
    # The thirteen added in this pass. Estimated from the nearest comparable
    # model and corrected the first time check_models.py runs against them,
    # the same as everything else in this block.
    "gefs0p25": 0.3, "cfs": 0.2, "urma": 17.3, "gefschem": 0.3,
    "namfire": 4.0, "gdas": 0.6, "gefswavemean": 1.6,
    "gefsp02": 0.07, "gefsp03": 0.07, "gefsp04": 0.07, "gefsp05": 0.07,
    "gefsp06": 0.07, "gefsp07": 0.07,
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
    # Coarser grids cost far less per hour than the 0.25 deg run they are cut
    # from.
    "gfs0p50": 0.2, "gfs1p00": 0.05,
    "hrefpmmn": 10.4, "hrefsprd": 10.4, "gefsc00": 0.07, "gefsp01": 0.07,
}

# What one region costs relative to its model's CONUS figure above. The nests
# and the regional analyses are cut to one small area apiece rather than the
# lower 48, so charging them the parent's rate would order the cheapest-first
# build wrongly and overstate the day's bandwidth several times over.
REGION_COST = {"conus": 1.0, "conus32": 0.7, "tropics": 1.4, "alaska": 0.3,
               "hawaii": 0.12, "prico": 0.12,
               "atlantic": 1.2, "epacific": 0.8, "arctic": 1.0}

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
# the limiter, and a back-off retry when one slips through anyway.
#
# ECMWF needs the same treatment, which the earlier note here denied. Its S3
# mirror answers a burst with 503 SlowDown, and a full build asks for one
# index and one range per forecast hour back to back. Four quick retries are
# not enough to outlast that, so ECMWF hours failed in clumps and the model
# looked like it was not published. Measured against the live bucket: paced
# requests answer, bursts do not.
_NOMADS_MIN_GAP = 0.7          # seconds; NOMADS allows about 120 hits a minute
_nomads_last = [0.0]
_ECMWF_MIN_GAP = 0.35
_ecmwf_last = [0.0]


def is_nomads(url):
    return "nomads.ncep.noaa.gov" in url


def is_ecmwf(url):
    return "data.ecmwf.int" in url or "ecmwf-forecasts" in url


def http_get(url, tries=4, **kw):
    """
    A GET that paces itself against NOMADS and retries its throttle redirect.

    A 302 from NOMADS is not a real redirect to follow, it is "you are asking
    too fast". allow_redirects stays off for NOMADS so that 302 is seen as the
    throttle it is rather than chased into a loop, and the answer is to wait and
    ask again, longer each time.
    """
    nomads = is_nomads(url)
    ecmwf = is_ecmwf(url)
    for attempt in range(tries):
        if nomads:
            gap = _NOMADS_MIN_GAP - (time.time() - _nomads_last[0])
            if gap > 0:
                time.sleep(gap)
            _nomads_last[0] = time.time()
        elif ecmwf:
            gap = _ECMWF_MIN_GAP - (time.time() - _ecmwf_last[0])
            if gap > 0:
                time.sleep(gap)
            _ecmwf_last[0] = time.time()
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
            # SlowDown means the host is asking for a real pause, not a
            # polite one: doubling beats a linear crawl at outlasting it.
            wait = 1.5 * (attempt + 1)
            if ecmwf or r.status_code in (429, 503):
                wait = max(wait, 2.0 * (2 ** attempt))
            time.sleep(wait)
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
    "cape":  {"short": ("cape", "mucape"), "levtype": ("surface",), "level": 0,
              "convert": lambda a: a,          "range": (0, 5000),  "ramp": "heat"},
    "refc":  {"short": ("refc", "dbz_cmax", "dbzcmax"),
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
    "gust":  {"short": ("gust", "i10fg", "fg10", "10fg"),
              "levtype": ("surface",),
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

    # ── Everyday fields most models carry, at levels already being asked for ─
    # Nothing here needs a new request: these live at 2 m, 10 m, the surface or
    # the whole column, which is what every fetch already covers. They were
    # simply never read out of the files that were already being downloaded.
    #
    # A model that does not carry one of them just does not produce that chart,
    # the same way GEFS produces no reflectivity today. Nothing fails.

    # Relative humidity at head height. The everyday companion to dewpoint:
    # dewpoint says how much moisture is in the air, this says how close that
    # is to as much as the air can hold, which is what fog and comfort follow.
    "rh2m":  {"short": ("2r", "r", "rh"), "levtype": ("heightAboveGround",),
              "level": 2,
              "convert": lambda a: a,           "range": (0, 100),
              "ramp": "moisture"},
    # Total cloud cover through the whole column. Reads as "how much sky is
    # covered", which is the one thing a forecast is asked for more than any
    # other and which no chart here answered.
    "tcc":   {"short": ("tcc", "tcdc"),
              "levtype": ("atmosphere", "entireAtmosphere",
                          "atmosphereSingleLayer", "unknown"), "level": 0,
              "convert": lambda a: a,           "range": (0, 100),
              "ramp": "cloud"},
    # Surface visibility, in kilometres. Inverted on purpose in the ramp: the
    # interesting end is the low end, where fog and heavy snow are.
    "vis":   {"short": ("vis",),      "levtype": ("surface",), "level": 0,
              "convert": lambda a: a / 1000.0,  "range": (0, 20),
              "ramp": "visibility"},
    # Convective inhibition: the lid holding a storm down. Published negative,
    # and flipped to a positive depth here so the scale reads "how strong is
    # the cap" rather than running backwards. CAPE says how much fuel there is;
    # this says whether it can get lit.
    "cin":   {"short": ("cin",),      "levtype": ("surface",), "level": 0,
              "convert": lambda a: -a,          "range": (0, 300),
              "ramp": "heat"},
    # Instantaneous precipitation rate, as millimetres per hour. Different
    # question from accumulated precipitation: this is how hard it is coming
    # down at that moment, which is what flash flooding follows.
    "prate": {"short": ("prate", "tprate"), "levtype": ("surface",), "level": 0,
              "convert": lambda a: a * 3600.0,  "range": (0, 25),
              "ramp": "precip"},
    # Snow on the ground, as centimetres. Published in metres.
    "snod":  {"short": ("sde", "snod", "sd"), "levtype": ("surface",), "level": 0,
              "convert": lambda a: a * 100.0,   "range": (0, 60),
              "ramp": "snow"},
    # Surface lifted index. Negative means the atmosphere is unstable, so the
    # sign is flipped here for the same reason CIN is: the map should get
    # brighter as the weather gets more interesting.
    "lftx":  {"short": ("lftx", "4lftx"), "levtype": ("surface",), "level": 0,
              "convert": lambda a: -a,          "range": (0, 12),
              "ramp": "heat"},
    # Downward shortwave radiation: how much sun is reaching the ground. Reads
    # as cloud cover from the other direction, and is the field solar output
    # actually follows.
    "dswrf": {"short": ("dswrf", "sdswrf", "ssrd"),
              "levtype": ("surface",), "level": 0,
              "convert": lambda a: a,           "range": (0, 1000),
              "ramp": "heat"},

    # ── Storm surge ─────────────────────────────────────────────────────────
    # Water above the normal tide, which is what actually floods a coast. A
    # hurricane's wind is the number it is named for and this is the number
    # that does most of the killing.
    "surge": {"short": ("etsrg", "surge", "htsgw"), "levtype": ("surface",),
              "level": 0,
              "convert": lambda a: a,           "range": (0, 4),
              "ramp": "precip"},

    # ── Upper air ───────────────────────────────────────────────────────────
    # Everything above here is read at the ground, at head height, or through
    # the whole column, which is one slice of the atmosphere and the one the
    # weather is felt in. These are read at pressure levels: the layers a
    # forecaster actually reasons with. The ground tells you what today is;
    # these tell you why, and what tomorrow is going to be.
    #
    # They are fetched only by models that ask for them, the same way shear
    # is, because a pressure level is a whole extra message per field per
    # forecast hour and most models are not opened for this.
    #
    # Built from the table below rather than written out one at a time. There
    # are twenty of them and they differ only in level and scale, so writing
    # each by hand would be twenty chances to paste the wrong range under the
    # right name, and a chart painted on the wrong scale looks completely
    # normal.
}

# level: (low, high) for the chart's colour scale, in the units the field is
# converted to. The scales are per level on purpose: 500 mb heights run near
# 550 decametres and 300 mb heights near 920, so one shared scale would paint
# every level but one a flat single colour.
UPPER_SPECS = {
    # Geopotential height, in decametres. The pattern the weather is steered
    # by. 500 mb is the classic one; 850 and 700 show how a system tilts with
    # height, and 300 is the level the jet lives on.
    "gh": {"short": ("gh",), "convert": lambda a: a / 10.0, "ramp": "height",
           "levels": {850: (120, 160), 700: (280, 325),
                      500: (480, 600), 300: (870, 980)}},
    # Temperature, in Celsius. 850 is the air mass and roughly the snow line;
    # 925 is the layer that mixes to the ground on a windy day; 700 and 500
    # are the cold aloft that makes an atmosphere unstable.
    "t": {"short": ("t",), "convert": lambda a: a - 273.15, "ramp": "temp",
          "levels": {925: (-30, 35), 850: (-30, 30),
                     700: (-40, 20), 500: (-45, -5)}},
    # Relative humidity, as a percentage. Where the moisture is stacked, and
    # where the dry slots are that stop cloud thickening into rain.
    "r": {"short": ("r",), "convert": lambda a: a, "ramp": "moisture",
          "key": "rh",
          "levels": {850: (0, 100), 700: (0, 100), 500: (0, 100)}},
    # Dewpoint at 850 mb, in Celsius. The moisture actually being fed into
    # storms, without the daytime noise the surface dewpoint carries.
    # Only the one spelling on purpose. ECMWF publishes a pressure level
    # parameter called "d" and it is divergence, not dewpoint. Accepting that
    # spelling would paint divergence on a dewpoint scale, which looks
    # entirely plausible and is completely wrong. ECMWF carries no pressure
    # level dewpoint at all, so it simply does not offer this chart.
    "dpt": {"short": ("dpt",), "convert": lambda a: a - 273.15,
            "ramp": "temp", "key": "d", "no_ecmwf": True,
            "levels": {850: (-30, 25)}},
    # Absolute vorticity, scaled to the units charts are drawn in. Spin. A
    # blob of it moving along the 500 mb flow is a shortwave, and the air
    # ahead of one is being lifted.
    "absv": {"short": ("absv", "vo"), "convert": lambda a: a * 1e5,
             "ramp": "heat", "key": "vort", "ecmwf": "vo",
             "levels": {500: (0, 40)}},
    # Vertical motion at 700 mb, in microbars per second, with the sign
    # flipped so up is positive. Published the other way round, which reads
    # backwards on a map. This is the field that says where it is actually
    # raining rather than where it could.
    "w": {"short": ("w", "dzdt"), "convert": lambda a: -a * 10.0,
          "ramp": "velocity", "levels": {700: (-25, 25)}},
}

# Wind at a pressure level is never published as a speed, so every one of
# these is built from its two components, the same way the 10 m wind is when
# a model carries no speed field.
WIND_PL_SPECS = {925: (0, 70), 850: (0, 80), 700: (0, 90),
                 500: (0, 120), 300: (0, 170), 250: (0, 170)}

# The plain names NOAA's index uses, so the download knows which messages to
# ask for. ECMWF's own names are the FIELDS short names above.
_IDX_VAR = {"gh": "HGT", "t": "TMP", "r": "RH", "dpt": "DPT",
            "absv": "ABSV", "w": "VVEL"}

UPPER_FIELDS = []
UPPER_SOURCES = {}
ECMWF_UPPER = set()

for _fam, _spec in UPPER_SPECS.items():
    # The name a chart is known by is not always the parameter it is read
    # from: humidity is "r" in the files and "rh" everywhere else, and
    # vorticity is "absv" in the files and "vort" on the page. The alias is
    # here so the two can differ without the page and the Pi disagreeing.
    _pref = _spec.get("key", _fam)
    for _lev, _rng in _spec["levels"].items():
        _key = f"{_pref}{_lev}"
        FIELDS[_key] = {
            "short": _spec["short"], "levtype": ("isobaricInhPa",),
            "level": _lev, "convert": _spec["convert"], "range": _rng,
            "ramp": _spec["ramp"],
        }
        UPPER_FIELDS.append(_key)
        UPPER_SOURCES[_key] = [(_IDX_VAR[_fam], f"{_lev} mb")]
        FIELDS[_key]["family"] = _fam
        # RELV is the relative kind, which differs from absolute vorticity by
        # the earth's own spin. That is a smooth background across a map
        # rather than a feature, so either draws the same shortwaves.
        if _fam == "absv":
            UPPER_SOURCES[_key].append(("RELV", f"{_lev} mb"))
        # DZDT is the same vertical motion in metres per second where VVEL is
        # in pascals per second. The high resolution models publish one, the
        # global models the other.
        if _fam == "w":
            UPPER_SOURCES[_key].append(("DZDT", f"{_lev} mb"))
        if not _spec.get("no_ecmwf"):
            ECMWF_UPPER.add((_spec.get("ecmwf", _spec["short"][0]), _lev))

for _lev, _rng in WIND_PL_SPECS.items():
    FIELDS[f"wind{_lev}"] = {
        "short": (), "levtype": (), "level": _lev,
        "convert": lambda a: a * 1.94384, "range": _rng,
        "ramp": "wind", "derive": "windpl",
    }
    UPPER_FIELDS.append(f"wind{_lev}")
    ECMWF_UPPER.add(("u", _lev))
    ECMWF_UPPER.add(("v", _lev))

UPPER_FIELDS = tuple(UPPER_FIELDS)

# The rest of the catalogue, added after the pressure levels above simply
# because those are generated and this is written out. Same table.
FIELDS.update({

    # == Severe weather =====================================================
    # The fields a storm is actually diagnosed from, rather than the ones it
    # is felt as. Every one of these was already sitting in files the Pi
    # downloads; none of them had ever been read out.

    # Storm relative helicity through the lowest 3 km, in square metres per
    # square second. How much the wind turns with height in the layer a
    # thunderstorm's inflow comes from. Turning inflow is what makes a
    # rotating storm, so this is the tornado ingredient CAPE cannot supply:
    # CAPE says the storm can be strong, this says it can spin.
    "hlcy": {"short": ("hlcy",),
             "levtype": ("heightAboveGroundLayer", "heightAboveGround",
                         "unknown"), "level": 3000,
             "convert": lambda a: a,           "range": (0, 600),
             "ramp": "helicity"},
    # Updraft helicity through the 2 to 5 km layer. Rotation in the updraft
    # itself, which is the model's own way of saying "this is a supercell".
    # High values on a forecast map are where the discrete rotating storms
    # are expected, and it is the field severe outlooks are drawn against.
    "uphl": {"short": ("mxuphl", "uphl", "unknown"),
             "levtype": ("heightAboveGroundLayer", "heightAboveGround",
                         "unknown"), "level": 5000,
             "convert": lambda a: a,           "range": (0, 250),
             "ramp": "helicity"},
    # Reflectivity a kilometre above the ground rather than the strongest
    # anywhere in the column. Closer to what a radar beam actually sees near
    # a storm, and it does not light up from high hail cores the way
    # composite reflectivity does.
    "refd1km": {"short": ("refd",), "levtype": ("heightAboveGround",),
                "level": 1000,
                "convert": lambda a: a,        "range": (-10, 75),
                "ramp": "radar"},
    # Echo top: how high the storm's radar echo reaches, in kilometres. A
    # tall echo is a strong updraft, and a collapsing one often precedes a
    # downburst.
    "echotop": {"short": ("retop",),
                "levtype": ("cloudTop", "nominalTop", "unknown"), "level": 0,
                "convert": lambda a: a / 1000.0, "range": (0, 18),
                "ramp": "radar"},
    # Vertically integrated liquid: how much water the whole column of storm
    # is holding, in kilograms per square metre. The classic hail signature,
    # because ice aloft reads to a radar as an enormous amount of liquid.
    "vil": {"short": ("vil", "tcolw"),
            "levtype": ("atmosphere", "entireAtmosphere",
                        "atmosphereSingleLayer", "unknown"), "level": 0,
            "convert": lambda a: a,            "range": (0, 70),
            "ramp": "radar"},
    # Forecast hail size at the ground, in millimetres.
    "hail": {"short": ("hail",), "levtype": ("surface",), "level": 0,
             "convert": lambda a: a * 1000.0,  "range": (0, 75),
             "ramp": "heat"},
    # Lightning flash rate, flashes per square kilometre per five minutes.
    # The high resolution models forecast this directly now, which turns
    # "there might be storms" into "here, and this many strikes".
    "ltng": {"short": ("ltng", "ltpinx"),
             "levtype": ("atmosphere", "entireAtmosphere",
                         "atmosphereSingleLayer", "unknown"), "level": 0,
             "convert": lambda a: a,           "range": (0, 12),
             "ramp": "heat"},
    # Bulk wind difference through the lowest 6 km, in knots. Not the same as
    # the deep layer shear used for hurricanes: this is the shallower layer
    # that decides whether a thunderstorm organises into a supercell. About
    # 35 knots is the usual threshold. Built from its two components.
    "shear06": {"short": (), "levtype": (), "level": 6000,
                "convert": lambda a: a * 1.94384, "range": (0, 80),
                "ramp": "wind", "derive": "shear06"},

    # == Aviation and the boundary layer ====================================

    # Mixing height: how deep the layer is that the ground stirs up during
    # the day, in metres. Sets how far smoke and pollution spread out, how
    # gusty an afternoon gets, and how high a fire's smoke plume goes.
    "hpbl": {"short": ("hpbl", "blh"), "levtype": ("surface",), "level": 0,
             "convert": lambda a: a,           "range": (0, 3500),
             "ramp": "moisture"},
    # Cloud ceiling height above ground, in metres. The number an airport
    # closes on. Read together with visibility it is the whole of an
    # aviation forecast.
    "ceil": {"short": ("ceil", "hgt", "gh", "ceiling"),
             "levtype": ("cloudCeiling", "unknown"), "level": 0,
             "convert": lambda a: a,           "range": (0, 4000),
             "ramp": "visibility"},
    # Freezing level, in metres. Where the air first reaches 0 C going up.
    # It is the snow line on a mountain, the icing level for aircraft, and
    # the difference between rain and snow at any given elevation.
    "frzlvl": {"short": ("hgt", "gh", "hzerocl", "deg0l"),
               "levtype": ("isothermZero", "isothermal", "unknown"),
               "level": 0,
               "convert": lambda a: a,         "range": (0, 5000),
               "ramp": "snow"},
    # Wind at 80 metres, in knots. Turbine hub height, and also the level
    # that says whether a strong low level jet will mix down to the ground
    # overnight. Built from its two components.
    "wind80": {"short": (), "levtype": (), "level": 80,
               "convert": lambda a: a * 1.94384, "range": (0, 80),
               "ramp": "wind", "derive": "wind80"},
    # The three cloud decks, as percentages. Total cloud cover says how much
    # sky is covered; these say at what height, which is the difference
    # between a grey day and a bright one with cirrus.
    "lcdc": {"short": ("lcc", "lcdc"),
             "levtype": ("lowCloudLayer", "unknown"), "level": 0,
             "convert": lambda a: a,           "range": (0, 100),
             "ramp": "cloud"},
    "mcdc": {"short": ("mcc", "mcdc"),
             "levtype": ("middleCloudLayer", "unknown"), "level": 0,
             "convert": lambda a: a,           "range": (0, 100),
             "ramp": "cloud"},
    "hcdc": {"short": ("hcc", "hcdc"),
             "levtype": ("highCloudLayer", "unknown"), "level": 0,
             "convert": lambda a: a,           "range": (0, 100),
             "ramp": "cloud"},

    # == Ground, water and snow =============================================

    # Station pressure at the actual surface, in hectopascals. Different from
    # mean sea level pressure, which is that number corrected to sea level so
    # maps can be compared. This one follows the terrain, so it reads as a
    # map of elevation with the weather on top.
    "pres": {"short": ("sp", "pres"), "levtype": ("surface",), "level": 0,
             "convert": lambda a: a / 100.0,   "range": (600, 1050),
             "ramp": "viridis"},
    # Soil temperature in the top 10 cm, in Celsius. What decides whether
    # falling snow sticks or melts on contact, and whether a freeze reaches
    # roots and pipes.
    "soilt": {"short": ("st", "tsoil"),
              "levtype": ("depthBelowLandLayer", "depthBelowLand", "unknown"),
              "level": (0, 10),
              "convert": lambda a: a - 273.15, "range": (-20, 40),
              "ramp": "temp"},
    # Soil moisture in the top 10 cm, as a fraction of the soil's volume.
    # Dry soil heats faster and burns; saturated soil turns the next rain
    # straight into runoff.
    "soilm": {"short": ("soilw", "swvl1"),
              "levtype": ("depthBelowLandLayer", "depthBelowLand", "unknown"),
              "level": (0, 10),
              "convert": lambda a: a * 100.0,  "range": (0, 50),
              "ramp": "moisture"},
    # Snowfall accumulation, in centimetres. The number a snow forecast is
    # actually written in, as opposed to snow depth, which is what is lying
    # there already.
    "snowacc": {"short": ("asnow", "sf", "snow_gsp"),
                "levtype": ("surface",), "level": 0,
                "convert": lambda a: a * 100.0, "range": (0, 60),
                "ramp": "snow"},
    # Snow water equivalent, in millimetres. How much water is locked up in
    # the snowpack, which is what melts into a river in spring and what
    # collapses a roof in winter.
    "weasd": {"short": ("sdwe", "weasd"), "levtype": ("surface",), "level": 0,
              "convert": lambda a: a,          "range": (0, 150),
              "ramp": "snow"},
    # Apparent temperature, in Celsius: what it feels like once humidity and
    # wind are taken into account. Heat index in summer, wind chill in
    # winter, one field.
    "apt": {"short": ("aptmp",), "levtype": ("heightAboveGround",), "level": 2,
            "convert": lambda a: a - 273.15,   "range": (-45, 50),
            "ramp": "temp"},
    # Outgoing longwave radiation at the top of the atmosphere, in watts per
    # square metre. This is essentially the infrared satellite picture the
    # model is forecasting: cold high cloud tops radiate little, so low
    # numbers are deep convection.
    "olr": {"short": ("ulwrf", "ttr"),
            "levtype": ("nominalTop", "topOfAtmosphere", "unknown"),
            "level": 0,
            "convert": lambda a: a,            "range": (80, 320),
            "ramp": "cloud"},

    # == Smoke and dust =====================================================
    # The high resolution models and the aerosol ensemble carry these; most
    # do not, so most simply do not offer them.

    # Smoke concentration in the air people are breathing, in micrograms per
    # cubic metre, published at 8 m above ground.
    "smoke": {"short": ("massden", "mass_density"),
              "levtype": ("heightAboveGround",), "level": 8,
              "convert": lambda a: a * 1e9,    "range": (0, 250),
              "ramp": "heat"},
    # The whole column of smoke or dust overhead, in milligrams per square
    # metre. This is the one that reads as a plume on a map: the haze you
    # can see from the ground and the orange sun, rather than what is being
    # inhaled.
    "colmd": {"short": ("colmd", "col_mass"),
              "levtype": ("atmosphere", "entireAtmosphere",
                          "atmosphereSingleLayer", "unknown"), "level": 0,
              "convert": lambda a: a * 1e6,    "range": (0, 400),
              "ramp": "heat"},
    # Aerosol optical depth: how much sunlight the whole column of haze
    # blocks. Unitless, and the number air quality and solar forecasts both
    # follow.
    "aod": {"short": ("aotk", "aod550"),
            "levtype": ("atmosphere", "entireAtmosphere",
                        "atmosphereSingleLayer", "unknown"), "level": 0,
            "convert": lambda a: a,            "range": (0, 3),
            "ramp": "heat"},

    # == Marine =============================================================
    # Waves come in two kinds and a wave model publishes both separately.
    # Combining them into one significant wave height, which is all this had
    # before, throws away the distinction that matters most at a coast.

    # Wind sea: the short choppy waves the local wind is making right now.
    "wvhgt": {"short": ("shww", "wvhgt"), "levtype": ("surface",),
              "level": (0, 1),
              "convert": lambda a: a,          "range": (0, 8),
              "ramp": "viridis"},
    # Swell: the long waves that have travelled here from somewhere else.
    # Swell from a hurricane reaches a coast days before the storm does, and
    # is what closes beaches under a clear sky.
    "swell": {"short": ("shts", "swell"), "levtype": ("surface", "unknown"),
              "level": (0, 1),
              "convert": lambda a: a,          "range": (0, 10),
              "ramp": "viridis"},
    # And their two periods, in seconds. Period is how a forecaster tells
    # them apart: local wind waves are short and choppy, a 15 second swell
    # has crossed an ocean to get here.
    "wvper": {"short": ("mpww", "wvper"), "levtype": ("surface",),
              "level": (0, 1),
              "convert": lambda a: a,          "range": (0, 14),
              "ramp": "heat"},
    "swper": {"short": ("mpts", "swper"), "levtype": ("surface", "unknown"),
              "level": (0, 1),
              "convert": lambda a: a,          "range": (0, 22),
              "ramp": "heat"},
    # Wave direction, in degrees. Which way the sea is running, which is what
    # decides whether a harbour entrance is workable.
    "dirpw": {"short": ("mwd", "dirpw"), "levtype": ("surface",),
              "level": (0, 1),
              "convert": lambda a: a,          "range": (0, 360),
              "ramp": "direction"},
    # Sea ice cover, as a percentage.
    "icec": {"short": ("ci", "icec", "siconc"), "levtype": ("surface",),
             "level": 0,
             "convert": lambda a: a * 100.0,   "range": (0, 100),
             "ramp": "snow"},
    # Which way the wind is blowing from, in degrees. Wraps, so it uses the
    # ramp that comes back to where it started rather than one that runs low
    # to high, or every northerly would draw a hard seam across the map.
    "wdir": {"short": ("wdir", "10wdir"),
             "levtype": ("heightAboveGround", "surface"), "level": (0, 10),
             "convert": lambda a: a,           "range": (0, 360),
             "ramp": "direction"},
    # The day's high and low, which is what a forecast is actually read for
    # and which no chart here answered: the temperature field is the value at
    # one instant, and the instant a run happens to land on is rarely the
    # warmest or coldest part of the day.
    "tmax": {"short": ("tmax", "mx2t", "mx2t3"),
             "levtype": ("heightAboveGround",),
             "level": 2,
             "convert": lambda a: a - 273.15, "range": (-40, 50),
             "ramp": "temp"},
    "tmin": {"short": ("tmin", "mn2t", "mn2t3"),
             "levtype": ("heightAboveGround",),
             "level": 2,
             "convert": lambda a: a - 273.15, "range": (-45, 35),
             "ramp": "temp"},
    # Coarse particulate, the bigger grit that dust storms carry, beside the
    # fine stuff the health advisories are written against.
    "pm10": {"short": ("pmtc",), "levtype": ("surface",), "level": 0,
             "convert": lambda a: a,           "range": (0, 300),
             "ramp": "heat"},
    # Scattering aerosol depth: the part of the haze that scatters light
    # rather than absorbing it, which is the difference between a white sky
    # and a brown one.
    "sctaod": {"short": ("sctaotk",),
               "levtype": ("atmosphere", "entireAtmosphere",
                           "atmosphereSingleLayer", "unknown"), "level": 0,
               "convert": lambda a: a,         "range": (0, 3),
               "ramp": "heat"},
    # Single scattering albedo: how much of what the haze does is scattering
    # rather than absorbing. Low numbers are sooty smoke, which heats the air
    # it is in; high numbers are dust and sea salt, which do not.
    "ssalb": {"short": ("ssalbk",),
              "levtype": ("atmosphere", "entireAtmosphere",
                          "atmosphereSingleLayer", "unknown"), "level": 0,
              "convert": lambda a: a,          "range": (0.7, 1.0),
              "ramp": "viridis"},
    # A second and third swell, because a sea often carries more than one,
    # from more than one distant storm, running in different directions.
    # Where they cross is where the water gets genuinely dangerous.
    "swell2": {"short": ("shts", "swell"), "levtype": ("surface", "unknown"),
               "level": (0, 2),
               "convert": lambda a: a,         "range": (0, 8),
               "ramp": "viridis"},
    "swper2": {"short": ("mpts", "swper"), "levtype": ("surface", "unknown"),
               "level": (0, 2),
               "convert": lambda a: a,         "range": (0, 22),
               "ramp": "heat"},
    "swdir":  {"short": ("dwts", "swdir"), "levtype": ("surface", "unknown"),
               "level": (0, 1),
               "convert": lambda a: a,         "range": (0, 360),
               "ramp": "direction"},
    "wvdir":  {"short": ("mdww", "wvdir"), "levtype": ("surface",),
               "level": (0, 1),
               "convert": lambda a: a,         "range": (0, 360),
               "ramp": "direction"},
    "swell3": {"short": ("shts", "swell"), "levtype": ("surface", "unknown"),
               "level": (0, 3),
               "convert": lambda a: a,         "range": (0, 6),
               "ramp": "viridis"},
    "swper3": {"short": ("mpts", "swper"), "levtype": ("surface", "unknown"),
               "level": (0, 3),
               "convert": lambda a: a,         "range": (0, 22),
               "ramp": "heat"},
    "swdir2": {"short": ("dwts", "swdir"), "levtype": ("surface", "unknown"),
               "level": (0, 2),
               "convert": lambda a: a,         "range": (0, 360),
               "ramp": "direction"},
    # Asymmetry factor: whether the haze scatters light forward or back,
    # which is why a smoky sky is bright looking away from the sun and dark
    # looking towards it.
    # Skin temperature: the temperature of whatever the atmosphere is actually
    # touching. Over water that is the sea surface; over land it is the ground
    # itself, which on a summer afternoon runs far hotter than the air at head
    # height and is what a fire and a heat wave both follow.
    # == Simulated satellite and cloud structure =============================
    # The high resolution models run a radiative transfer step and publish
    # what a satellite would see if the forecast came true. Put beside the
    # real satellite picture an hour from now, it is the fastest way to tell
    # whether a model has the storm in the right place.

    # Clean infrared, which is the channel every satellite loop on television
    # is made of. Cold is high cloud, so the scale runs backwards from most:
    # the interesting end is the cold end.
    "satir": {"short": ("sbt113", "sbt114", "btmp"),
              "levtype": ("nominalTop", "topOfAtmosphere", "unknown"),
              "level": 0,
              "convert": lambda a: a - 273.15,  "range": (-80, 40),
              "ramp": "satir"},
    # Cloud base and cloud top height, in metres. The thickness between them
    # is the difference between a deck of stratus and a thunderstorm.
    "cldbase": {"short": ("hgt", "gh"),
                "levtype": ("cloudBase", "unknown"), "level": 0,
                "convert": lambda a: a,         "range": (0, 6000),
                "ramp": "cloud"},
    "cldtop": {"short": ("hgt", "gh"),
               "levtype": ("cloudTop", "unknown"), "level": 0,
               "convert": lambda a: a,          "range": (0, 16000),
               "ramp": "cloud"},
    # Reflectivity at 4 km, which is up near the level where hail grows. A
    # strong echo up there with a weaker one below is the classic overhang.
    "refd4km": {"short": ("refd",), "levtype": ("heightAboveGround",),
                "level": 4000,
                "convert": lambda a: a,         "range": (-10, 75),
                "ramp": "radar"},
    # Column ice, which is the frozen half of what integrated liquid counts.
    "tcoli": {"short": ("tcoli",),
              "levtype": ("atmosphere", "entireAtmosphere",
                          "atmosphereSingleLayer", "unknown"), "level": 0,
              "convert": lambda a: a,           "range": (0, 20),
              "ramp": "snow"},
    # Frozen precipitation accumulation, in millimetres: the sleet and
    # graupel, counted apart from the snow.
    "frozr": {"short": ("frozr",), "levtype": ("surface",), "level": 0,
              "convert": lambda a: a,           "range": (0, 30),
              "ramp": "snow"},
    # Percent of precipitation falling frozen. This is the rain and snow line
    # drawn as a field rather than guessed at from the temperature: 50 per
    # cent is where it is falling as both at once.
    "cpofp": {"short": ("cpofp",), "levtype": ("surface",), "level": 0,
              "convert": lambda a: a,           "range": (0, 100),
              "ramp": "snow"},

    "skt":    {"short": ("skt", "tmp"), "levtype": ("surface",), "level": 0,
               "convert": lambda a: a - 273.15, "range": (-40, 60),
               "ramp": "temp"},
    "asyf":   {"short": ("asysfk",),
               "levtype": ("atmosphere", "entireAtmosphere",
                           "atmosphereSingleLayer", "unknown"), "level": 0,
               "convert": lambda a: a,         "range": (0.4, 0.9),
               "ramp": "viridis"},
})

# The two pressure levels the shear field is worked out from. Fetched only by
# models that ask for shear, since for everything else they are dead weight.
SHEAR_LEVELS = (200, 850)

# The pressure levels whose winds are built from components. Every level any
# wind chart is drawn at, plus the two the shear field is differenced across,
# since the decoder keeps all of them aside the same way.
WIND_PL_LEVELS = tuple(sorted(WIND_PL_SPECS))
KEEP_UV_LEVELS = tuple(sorted(set(WIND_PL_LEVELS) | set(SHEAR_LEVELS)))
# The height above ground the 80 m wind is built at, which is turbine hub
# height and the level a low level jet mixes down from.
WIND80_LEVEL = 80


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
             "OZCON", "PMTF", "PMTC", "ETSRG",
             # Everyday fields that were being downloaded past and never read:
             # humidity, cloud, visibility, the convective cap, rain rate,
             # snow on the ground, lifted index and incoming sunlight.
             "RH", "TCDC", "VIS", "CIN", "PRATE", "SNOD", "WEASD",
             "LFTX", "4LFTX", "DSWRF",
             # Severe, aviation, ground, smoke and marine. Same rule as
             # above: these ride in files already being downloaded, at
             # levels already being asked for, and were never read.
             "HLCY", "MXUPHL", "REFD", "RETOP", "VIL", "TCOLW", "HAIL",
             "LTNG", "HPBL", "HGT", "LCDC", "MCDC", "HCDC",
             "PRES", "TSOIL", "SOILW", "ASNOW", "APTMP", "ULWRF",
             "MASSDEN", "COLMD", "AOTK",
             "WVHGT", "SWELL", "WVPER", "SWPER", "DIRPW", "ICEC",
             "CEIL", "WDIR", "TMAX", "TMIN", "SCTAOTK", "SSALBK",
             "WVDIR", "SWDIR", "ASYSFK"}
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
    tail = m["raw"].format(date=date_str, cyc=cyc, fhr=fhr)
    url = tail if tail.startswith("http") else f"{RAW_BASE}/" + tail
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
    # The analyses put the gust at 10 m where the forecast models put it at
    # the surface. Same field, and without the second spelling RTMA and URMA
    # produce no gust chart at all.
    "gust":  [("GUST", "surface"), ("GUST", "10 m above ground")],
    "pwat":  [("PWAT", "entire atmosphere*")],
    "sst":   [("WTMP", "surface")],
    "swh":   [("HTSGW", "surface")],
    "perpw": [("PERPW", "surface")],
    "ozone": [("OZCON", "surface")],
    "pm25":  [("PMTF", "surface"), ("PMTC", "surface")],
    "surge": [("ETSRG", "surface")],
    # The everyday fields. Every one of these sits at a level already being
    # asked for, so adding them costs no extra request, only the bytes of the
    # messages themselves.
    "rh2m":  [("RH", "2 m above ground")],
    "tcc":   [("TCDC", "entire atmosphere*")],
    "vis":   [("VIS", "surface")],
    "cin":   [("CIN", "surface")],
    "prate": [("PRATE", "surface")],
    "snod":  [("SNOD", "surface")],
    "lftx":  [("LFTX", "surface"), ("4LFTX", "surface")],
    "dswrf": [("DSWRF", "surface")],

    # Severe weather. Every var and level name here was read out of a real
    # GFS or HRRR index rather than guessed: a level spelled even slightly
    # differently matches nothing and the chart silently never appears.
    "hlcy":    [("HLCY", "3000-0 m above ground")],
    "uphl":    [("MXUPHL", "5000-2000 m above ground"),
                ("UPHL", "5000-2000 m above ground"),
                ("MXUPHL", "3000-0 m above ground")],
    "refd1km": [("REFD", "1000 m above ground")],
    "echotop": [("RETOP", "cloud top")],
    "vil":     [("VIL", "entire atmosphere"), ("TCOLW", "entire atmosphere*")],
    "hail":    [("HAIL", "surface")],
    "ltng":    [("LTNG", "entire atmosphere")],

    # Aviation and the boundary layer.
    "hpbl":    [("HPBL", "surface")],
    # CEIL is what the analyses call it; the forecast models publish the same
    # thing as a height at the ceiling level.
    "ceil":    [("HGT", "cloud ceiling"), ("CEIL", "cloud ceiling")],
    "frzlvl":  [("HGT", "0C isotherm")],
    "lcdc":    [("LCDC", "low cloud layer"), ("TCDC", "low cloud layer")],
    "mcdc":    [("MCDC", "middle cloud layer"), ("TCDC", "middle cloud layer")],
    "hcdc":    [("HCDC", "high cloud layer"), ("TCDC", "high cloud layer")],

    # Ground, water and snow.
    "pres":    [("PRES", "surface")],
    "soilt":   [("TSOIL", "0-0.1 m below ground")],
    "soilm":   [("SOILW", "0-0.1 m below ground")],
    "snowacc": [("ASNOW", "surface")],
    "weasd":   [("WEASD", "surface")],
    "apt":     [("APTMP", "2 m above ground")],
    "olr":     [("ULWRF", "top of atmosphere")],

    # Smoke and dust.
    "smoke":   [("MASSDEN", "8 m above ground")],
    "colmd":   [("COLMD", "entire atmosphere*")],
    "aod":     [("AOTK", "entire atmosphere*")],

    # Marine. Swell arrives numbered by sequence rather than by level, since
    # a sea can carry several swells from several distant storms at once, and
    # the first in the sequence is the dominant one.
    "wvhgt":   [("WVHGT", "surface")],
    "swell":   [("SWELL", "1 in sequence"), ("SWELL", "surface")],
    "wvper":   [("WVPER", "surface")],
    "swper":   [("SWPER", "1 in sequence"), ("SWPER", "surface")],
    "dirpw":   [("DIRPW", "surface")],
    "icec":    [("ICEC", "surface")],
    "wdir":    [("WDIR", "10 m above ground"), ("WDIR", "surface")],
    "asyf":    [("ASYSFK", "entire atmosphere*")],
    "skt":     [("TMP", "surface")],
    "satir":   [("SBT113", "top of atmosphere"),
                ("SBT114", "top of atmosphere")],
    "cldbase": [("HGT", "cloud base")],
    "cldtop":  [("HGT", "cloud top")],
    "refd4km": [("REFD", "4000 m above ground")],
    "tcoli":   [("TCOLI", "entire atmosphere*")],
    "frozr":   [("FROZR", "surface")],
    "cpofp":   [("CPOFP", "surface")],
    "tmax":    [("TMAX", "2 m above ground")],
    "tmin":    [("TMIN", "2 m above ground")],
    "pm10":    [("PMTC", "surface")],
    "sctaod":  [("SCTAOTK", "entire atmosphere*")],
    "ssalb":   [("SSALBK", "entire atmosphere*")],
    "swell2":  [("SWELL", "2 in sequence")],
    "swell3":  [("SWELL", "3 in sequence")],
    "swper2":  [("SWPER", "2 in sequence")],
    "swper3":  [("SWPER", "3 in sequence")],
    "swdir2":  [("SWDIR", "2 in sequence")],
    "swdir":   [("SWDIR", "1 in sequence"), ("SWDIR", "surface")],
    "wvdir":   [("WVDIR", "surface")],
}
# Wind is its own case: taken as a speed where the model publishes one, and
# from both components where it does not. Fetching all three, which the cross
# product did, is paying for the same field twice.
WIND_SPEED = ("WIND", "10 m above ground")
WIND_PARTS = [("UGRD", "10 m above ground"), ("VGRD", "10 m above ground")]
# A wave model runs on its own grid and publishes the wind driving the sea at
# "surface" rather than at 10 m. Without this spelling every wave model shows
# waves with no wind, which is the one thing a mariner wants beside them.
WIND_SPEED_ALT = ("WIND", "surface")

# The component messages every pressure level wind is built from, and the two
# height level ones. UPPER_SOURCES itself is generated up beside the fields it
# names, so the level in a field's name and the level it is read at cannot
# drift apart.
WIND_PL_PARTS = {lev: [("UGRD", f"{lev} mb"), ("VGRD", f"{lev} mb")]
                 for lev in WIND_PL_LEVELS}
WIND80_PARTS = [("UGRD", "80 m above ground"), ("VGRD", "80 m above ground")]
# The 0 to 6 km bulk shear, which the high resolution models publish as its
# two components already differenced across the layer.
SHEAR06_PARTS = [("VUCSH", "0-6000 m above ground"),
                 ("VVCSH", "0-6000 m above ground")]


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


def select_from_idx(rows, want_shear=False, only=None, want_upper=False):
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
                      if (r["var"], r["lev"]) in (WIND_SPEED, WIND_SPEED_ALT)),
                     None)
        if speed:
            take(speed, "wind<-WIND")
        else:
            # One of each component, not every message that shares the name.
            for want in WIND_PARTS:
                one = next((r for r in rows
                            if (r["var"], r["lev"]) == want), None)
                if one:
                    take(one, f"wind<-{want[0]}")

    if want_upper:
        for key, options in UPPER_SOURCES.items():
            if only and key not in only:
                continue
            for var, levpat in options:
                hit = next((r for r in rows
                            if r["var"] == var
                            and _lev_matches(levpat, r["lev"])), None)
                if hit:
                    take(hit, f"{key}<-{var}")
                    break
        for lev, parts in WIND_PL_PARTS.items():
            if only and f"wind{lev}" not in only:
                continue
            for want in parts:
                one = next((r for r in rows
                            if (r["var"], r["lev"]) == want), None)
                if one:
                    take(one, f"wind{lev}<-{want[0]}")

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
    keep, _names = select_from_idx(rows, m.get("shear"), m.get("fields"),
                                   m.get("upper"))
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
# Environment Canada publishes one file per field per hour, so widening this
# list costs one more small request per hour rather than a bigger download.
# Seven fields was leaving most of a good model on the shelf.
#
# A name that is not published is skipped rather than failing the hour, which
# is what makes a list this long safe: the Canadians rename things between
# versions and a field that vanishes costs that field, not the run.
GEM_FIELDS = [
    # Surface and near surface.
    ("TMP", "TGL", "2"), ("DEPR", "TGL", "2"), ("RH", "TGL", "2"),
    ("PRMSL", "MSL", "0"), ("PRES", "SFC", "0"),
    ("UGRD", "TGL", "10"), ("VGRD", "TGL", "10"),
    ("WIND", "TGL", "10"), ("GUST", "TGL", "10"), ("WDIR", "TGL", "10"),
    # Precipitation and snow.
    ("APCP", "SFC", "0"), ("PRATE", "SFC", "0"),
    ("SNOD", "SFC", "0"), ("WEASD", "SFC", "0"),
    # Cloud, moisture and radiation.
    ("TCDC", "SFC", "0"), ("PWAT", "EATM", "0"), ("DSWRF", "SFC", "0"),
    ("CAPE", "SFC", "0"),
    # Upper air, which is where a global model earns its keep.
    ("HGT", "ISBL", "0500"), ("HGT", "ISBL", "0700"), ("HGT", "ISBL", "0850"),
    ("TMP", "ISBL", "0500"), ("TMP", "ISBL", "0700"), ("TMP", "ISBL", "0850"),
    ("TMP", "ISBL", "0925"),
    ("RH", "ISBL", "0500"), ("RH", "ISBL", "0700"), ("RH", "ISBL", "0850"),
    ("UGRD", "ISBL", "0250"), ("VGRD", "ISBL", "0250"),
    ("UGRD", "ISBL", "0500"), ("VGRD", "ISBL", "0500"),
    ("UGRD", "ISBL", "0850"), ("VGRD", "ISBL", "0850"),
]

# DWD names theirs after the variable alone, in lower case, one directory each.
# DWD, same idea and the same skip-what-is-missing rule. These are the single
# level names ICON publishes; the global, European and German runs carry
# slightly different subsets of them and each simply builds what it has.
ICON_FIELDS = [
    # Temperature and moisture.
    "t_2m", "td_2m", "relhum_2m", "tmax_2m", "tmin_2m",
    # Pressure and wind.
    "pmsl", "ps", "u_10m", "v_10m", "vmax_10m",
    # Precipitation and snow.
    "tot_prec", "rain_gsp", "snow_gsp", "h_snow", "snowlmt",
    # Cloud, moisture, instability and the model's own reflectivity.
    "clct", "clcl", "clcm", "clch", "ceiling", "tqv",
    "cape_ml", "hzerocl", "dbz_cmax", "hbas_con",
    # Radiation.
    "asob_s",
]


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
# Read off a real ECMWF index rather than guessed. The whole surface list they
# publish is: 100u 100v 10fg 10u 10v 2d 2t asn ewss lsm mn2t3 msl mucape mx2t3
# nsss ptype ro rsn sd sf sithick skt sp ssr ssrd str strd sve svn tcc tcw
# tcwv tp tprate ttr zos. Eight of those were being taken and the rest, which
# includes the gust, the cloud, the CAPE, the snow and the day's high and low,
# were being skipped past inside a file already on the wire.
#
# "sst" stays in the list although ECMWF does not publish it: skin temperature
# is the closest they have and it is a different field over land, so it gets
# its own chart rather than being passed off as sea temperature.
ECMWF_PARAMS = {"2t", "2d", "msl", "10u", "10v", "tp", "tcwv", "sst",
                "10fg", "mucape", "tcc", "sd", "sf", "sp", "skt",
                "ssrd", "ttr", "mx2t3", "mn2t3", "tprate"}
ECMWF_SHEAR_PARAMS = {"u", "v"}
# ECMWF's own parameter names for the same set are generated beside the
# fields, up in UPPER_SPECS, for the same reason: a level written twice is a
# level that can be written differently twice.


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
        try:
            plev = int(rec.get("levelist", 0) or 0)
        except (TypeError, ValueError):
            plev = 0
        pl = rec.get("levtype") == "pl"
        if param in ECMWF_PARAMS and rec.get("levtype") == "sfc":
            pass
        elif (m.get("shear") and param in ECMWF_SHEAR_PARAMS
              and pl and plev in SHEAR_LEVELS):
            pass
        elif m.get("upper") and pl and (param, plev) in ECMWF_UPPER:
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


def ask_from_inventory(pairs, extra_levels=(), upper=False):
    """
    Turn what is in the file into the flags that ask for the useful part.

    extra_levels are pressure levels a model wants on top of the surface set,
    and only the wind components are taken from them. Asking for everything at
    850 mb would pull temperature and humidity too, which nothing here draws,
    on a box big enough that the waste is real.

    "upper" adds the five pressure level charts, each named as one variable at
    one level rather than as a level list, for the same reason: the filter
    service returns every combination of what it is given, so asking for four
    variables at four levels to draw four charts fetches sixteen messages.
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
    if upper:
        wanted = {(v, l) for opts in UPPER_SOURCES.values() for v, l in opts}
        for parts in WIND_PL_PARTS.values():
            wanted |= set(parts)
        for var, level in pairs:
            if (var, level) in wanted:
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


# ── The disk, which is the one resource that does not fail gracefully ───────
#
# Everything else here degrades: a model that will not download leaves the
# last one on screen, a radar site that times out is skipped, a product that
#404s backs itself off. A full SD card does none of that. It takes apt down,
# it takes git down, it takes the venv down, and the errors it produces are
# about writing files rather than about weather, so they point nowhere near
# the pipeline that filled it.
#
# Three days of frames is a promise the disk has to be able to keep. This is
# what makes it ask first. Retention is what fits, not what was wanted.
# A note on what this pass cost, since it is the number that matters on a
# home connection: the catalogue went from twenty nine fields to ninety seven
# and from six fields per high resolution model to twenty five, which is
# roughly three times the download it was. Nothing here breaks under that,
# because the guard below shortens the retention window rather than filling
# the card, but the window will be shorter. Two knobs pull it back:
#
#   GWCFC_FINE_LEAN=1     the high resolution models go back to six fields
#   --models a,b,c        build only the ones actually opened
#
# and dropping "upper" from a model's entry drops its twenty pressure levels.
DISK_FLOOR_MB = float(os.environ.get("GWCFC_DISK_FLOOR_MB", "1500"))


def free_mb(path):
    """Megabytes free on the filesystem holding path.

    Unknowable is treated as plenty: a guard that cannot read the disk should
    not be the reason nothing gets built.
    """
    try:
        st = os.statvfs(path if os.path.exists(path) else os.path.dirname(path) or ".")
        return (st.f_bavail * st.f_frsize) / (1024.0 * 1024.0)
    except (OSError, ValueError):
        return float("inf")


def hours_for_disk(path, want_hours):
    """The retention window the disk can actually afford right now.

    Stepped rather than smooth, because a window that drifts a little every
    pass would delete frames one at a time forever and never settle. Each
    step is a decision: plenty of room keeps the full window, tight room
    keeps a day, nearly full keeps a few hours, and full keeps the last
    couple so there is still something to show while space is recovered.
    """
    free = free_mb(path)
    if free >= DISK_FLOOR_MB * 2:
        return want_hours
    if free >= DISK_FLOOR_MB:
        return min(want_hours, 24.0)
    if free >= DISK_FLOOR_MB / 2:
        return min(want_hours, 6.0)
    return min(want_hours, 2.0)


def disk_ok(path, need_mb=None):
    """Whether there is room to write something new.

    Called before a build rather than after: skipping one product is a gap in
    a loop, and filling the card is a machine that needs a keyboard and a
    monitor to fix.
    """
    need = DISK_FLOOR_MB / 3.0 if need_mb is None else float(need_mb)
    return free_mb(path) >= need


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
    # Cloud cover: clear sky is deep blue and overcast is white, which is what
    # it looks like from above. Not a rainbow, because the field only runs one
    # way and a rainbow would invent structure that is not there.
    "cloud":  [(0,(10,30,70)),(0.3,(60,110,170)),(0.6,(160,190,215)),
               (1,(250,250,252))],
    # Visibility runs the other way from everything else: the interesting end
    # is the low end. Red is fog, and it fades out to nothing at clear.
    "visibility":[(0,(150,10,20)),(0.15,(230,90,40)),(0.35,(245,205,80)),
                  (0.6,(170,215,190)),(1,(235,245,250))],
    # Snow depth, white through blue into a deep indigo, the way depth reads
    # on any snow map anyone has seen before.
    "snow":   [(0,(245,250,255)),(0.2,(190,225,245)),(0.45,(110,175,225)),
               (0.7,(60,105,190)),(1,(30,30,110))],
    # 500 mb height. Purple and blue at the low end, red at the high end,
    # which is the convention every upper air chart is drawn in and which
    # reads correctly without a legend: the cold stormy troughs are the cool
    # colours and the warm settled ridges are the warm ones.
    "height": [(0,(70,20,110)),(0.25,(40,90,190)),(0.5,(60,180,170)),
               (0.7,(220,220,120)),(0.85,(230,130,50)),(1,(160,20,30))],
    # Rotation. Nothing at the bottom, because most of a map has no spin in
    # it and colouring that would bury the part that does, then straight up
    # through the severe weather colours. Deliberately not a rainbow: the
    # question this field answers is "where", not "how much".
    "helicity":[(0,(20,20,40)),(0.15,(40,90,160)),(0.4,(90,190,140)),
                (0.62,(245,225,110)),(0.8,(235,120,45)),(1,(180,10,60))],
    # Compass direction, which has to wrap: 359 degrees and 1 degree are next
    # to each other, so the ramp has to come back to where it started or
    # every north wind would show as a hard seam across the map.
    "direction":[(0,(230,90,80)),(0.25,(230,210,80)),(0.5,(80,200,130)),
                 (0.75,(80,150,230)),(1,(230,90,80))],
    # Simulated infrared, drawn the way every television satellite loop is:
    # warm ground in greys running to white, then colour piled onto the
    # coldest cloud tops, because on this field cold means tall and tall
    # means the storm is serious. Runs cold to warm, so it is reversed
    # relative to a temperature ramp.
    "satir":  [(0,(255,255,255)),(0.1,(200,40,220)),(0.2,(220,40,40)),
               (0.3,(240,180,40)),(0.4,(60,200,120)),(0.5,(30,60,160)),
               (0.62,(20,20,20)),(1,(235,235,235))],
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


# ── Radar bands, which are not a ramp ───────────────────────────────────────
# Radar has been drawn in discrete bands since it was drawn on paper, and that
# is not tradition for its own sake. A forecaster reads a band EDGE as a
# threshold: 35 dBZ is about where a shower becomes a storm, 50 is where hail
# starts being worth thinking about, 60 is a core. A smooth ramp has no edges,
# so none of those numbers can be read off the picture, and once a browser
# smooths the finished PNG as it magnifies it, every echo becomes a soft
# rainbow blob. That is what these replace.
#
# Values are in the field's own units, so the same table gives the right
# colours whatever range a product declares.
BANDS = {
    # The National Weather Service reflectivity scale, in dBZ. The one every
    # radar picture anyone has ever looked at uses.
    "radar": [
        (5, (4, 233, 231)), (10, (1, 159, 244)), (15, (3, 0, 244)),
        (20, (2, 253, 2)), (25, (1, 197, 1)), (30, (0, 142, 0)),
        (35, (253, 248, 2)), (40, (229, 188, 0)), (45, (253, 149, 0)),
        (50, (253, 0, 0)), (55, (212, 0, 0)), (60, (188, 0, 0)),
        (65, (248, 0, 253)), (70, (152, 84, 198)), (75, (253, 253, 253)),
    ],
    # Velocity in knots, symmetric because the number means "towards" on one
    # side of zero and "away" on the other, and the thing worth seeing is the
    # two side by side. Brightest at the extremes; near zero is nearly black
    # so still air does not shout.
    "velocity": [
        (-140, (0, 255, 255)), (-100, (0, 224, 192)), (-80, (0, 240, 0)),
        (-64, (0, 208, 0)), (-50, (0, 180, 0)), (-36, (0, 148, 0)),
        (-26, (0, 120, 0)), (-20, (0, 92, 0)), (-10, (0, 66, 0)),
        (-5, (20, 20, 20)), (5, (66, 0, 0)), (10, (92, 0, 0)),
        (20, (120, 0, 0)), (26, (148, 0, 0)), (36, (180, 0, 0)),
        (50, (208, 0, 0)), (64, (240, 0, 0)), (80, (255, 80, 80)),
        (100, (255, 144, 144)), (140, (255, 208, 208)),
    ],
}


def build_band_lut(name, lo, hi):
    """256 entries that step at the band edges instead of sliding between."""
    bands = BANDS[name]
    lut = np.zeros((256, 3), dtype=np.uint8)
    for i in range(256):
        v = lo + (i / 255.0) * (hi - lo)
        rgb = bands[0][1]
        for edge, colour in bands:
            if v >= edge:
                rgb = colour
            else:
                break
        lut[i] = rgb
    return lut


def _idx_at(value, lo, hi):
    """Which of the 256 encoded steps a real value lands on."""
    return int(round((value - lo) / float(hi - lo) * 255))


def band_alpha(ramp, idx, alpha, lo, hi):
    """Hide the readings a banded product should not paint at all.

    Below reflectivity's first band is clear-air return and ground clutter,
    not weather, and painting it turns every map into a solid wash centred on
    the radar. Within a few knots of zero is still air, and a wash of that
    across a whole sweep hides the couplet that is the only reason anyone
    opened velocity.

    Both cutoffs are read off the band table rather than typed in, so the
    picture and the palette can never drift apart.
    """
    if ramp not in BANDS:
        return alpha
    if ramp == "velocity":
        alpha[(idx > _idx_at(-5, lo, hi)) & (idx < _idx_at(5, lo, hi))] = 0
    else:
        alpha[idx < _idx_at(BANDS[ramp][0][0], lo, hi)] = 0
    return alpha


_BAND_LUTS = {}


def lut_for(ramp, lo, hi):
    """The lookup table for a ramp over a range.

    Banded where radar convention says bands, smooth everywhere else. The
    range has to be passed because a band edge is a real value: 50 dBZ is 50
    dBZ whether a product declares -10 to 75 or 0 to 80, and a table built for
    the wrong range would put the red where the yellow belongs.
    """
    if ramp not in BANDS:
        return LUTS[ramp]
    key = (ramp, lo, hi)
    if key not in _BAND_LUTS:
        _BAND_LUTS[key] = build_band_lut(ramp, lo, hi)
    return _BAND_LUTS[key]


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


# NOAA mirrors nearly everything on NOMADS to AWS open data, with the same
# filenames under a different prefix. The mirrors matter because NOMADS rate
# limits with a redirect to a throttle page rather than an honest 429, so a
# burst of requests, which is exactly what building fifty eight models is,
# starts answering "missing file" partway through. Same bytes, no limit.
#
# Keyed by the first path segment of the NOMADS path, which is the product
# name. The value is the bucket and what replaces that segment.
# Every one of these was checked by building the mirror address for a real
# model and fetching it. The blend, the ensemble of high resolution runs and
# the HiResW nests are deliberately absent: they have no mirror that answers,
# so listing them would be a fallback that quietly never works.
S3_MIRRORS = {
    "gfs":  "noaa-gfs-bdp-pds",
    "gdas": "noaa-gfs-bdp-pds",
    "nam":  "noaa-nam-pds",
    "hrrr": "noaa-hrrr-bdp-pds",
    "rap":  "noaa-rap-pds",
    "gens": "noaa-gefs-pds",
    "rtma": "noaa-rtma-pds",
    "urma": "noaa-urma-pds",
    "hafs": "noaa-nws-hafs-pds",
}


def mirror_url(tail):
    """The AWS address of a NOMADS path, or None if there is no mirror.

    A NOMADS path looks like `gfs/prod/gfs.20260825/00/atmos/...`. The bucket
    is chosen by the first segment and the `prod` that follows it is dropped,
    which is the whole of the difference between the two layouts.
    """
    parts = tail.split("/")
    if len(parts) < 3:
        return None
    bucket = S3_MIRRORS.get(parts[0])
    if not bucket:
        return None
    rest = parts[1:]
    if rest and rest[0] == "prod":
        rest = rest[1:]
    return f"https://{bucket}.s3.amazonaws.com/" + "/".join(rest)


def find_index(m, date_str, cyc, fhr, timeout=30):
    """The first index path that answers, with its text. (url, text) or None.

    A raw path may be a full URL rather than a path under NOMADS. NOAA has
    started publishing whole models only to S3 open-data buckets, so a model
    that lives there is addressed by naming its own host instead of being
    excluded for not being on the file server.

    Every NOMADS path is also tried on its AWS mirror. That is not belt and
    braces: NOMADS answers a burst with a redirect to a throttle page, which
    is indistinguishable from a missing file, and a run that builds the whole
    catalogue is a burst by definition.
    """
    tried = []
    for tmpl in raw_candidates(m):
        tail = tmpl.format(date=date_str, cyc=cyc, fhr=fhr)
        if tail.startswith("http"):
            tried.append(tail)
            continue
        tried.append(f"{RAW_BASE}/" + tail)
        alt = mirror_url(tail)
        if alt:
            tried.append(alt)
    for url in tried:
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
            pairs, SHEAR_LEVEL_NAMES if m.get("shear") else (),
            bool(m.get("upper")))
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
                # Wind components at any level a chart is built from, kept
                # aside rather than matched. No model publishes a wind speed
                # at a pressure level, so every one of those is built from
                # its two components, and the two shear levels are only here
                # to be differenced against each other.
                if short in ("u", "v") and levt == "isobaricInhPa" \
                        and lev in KEEP_UV_LEVELS:
                    uv[f"{short}{lev}"] = (arr, lats, lons)
                    continue

                # Turbine hub height, the same way.
                if short in ("u", "v") and levt == "heightAboveGround" \
                        and lev == WIND80_LEVEL:
                    uv[f"{short}h80"] = (arr, lats, lons)
                    continue

                # The 0 to 6 km bulk shear components, which arrive already
                # differenced across the layer, so this is a length rather
                # than a difference of two winds.
                if short in ("vucsh", "vvcsh") \
                        and lev in (6000, 0) and levt in (
                            "heightAboveGroundLayer", "heightAboveGround",
                            "unknown"):
                    uv[short] = (arr, lats, lons)
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

    # Every pressure level wind, which is a plain speed at one level rather
    # than a difference between two.
    for _lev in WIND_PL_LEVELS:
        ju, jv = f"u{_lev}", f"v{_lev}"
        if ju in uv and jv in uv:
            found[f"wind{_lev}"] = (
                np.sqrt(uv[ju][0] ** 2 + uv[jv][0] ** 2),
                uv[ju][1], uv[ju][2])

    # Turbine hub height, built the same way.
    if "uh80" in uv and "vh80" in uv:
        found["wind80"] = (np.sqrt(uv["uh80"][0] ** 2 + uv["vh80"][0] ** 2),
                           uv["uh80"][1], uv["uh80"][2])

    # And the 0 to 6 km bulk shear, whose components are already the
    # difference across the layer, so this is just their length.
    if "vucsh" in uv and "vvcsh" in uv:
        found["shear06"] = (
            np.sqrt(uv["vucsh"][0] ** 2 + uv["vvcsh"][0] ** 2),
            uv["vucsh"][1], uv["vucsh"][2])

    # A file full of messages that matched nothing means the keys in FIELDS
    # disagree with what this eccodes build calls them. Printing what was
    # actually there turns that from a silent skip into a one-line fix.
    if not found and seen:
        log(f"    {len(seen)} messages, none matched. Present: "
            + ", ".join(sorted(set(seen))[:24]))

    return found


def smooth_upsample(data, min_edge=None, max_edge=None):
    """Interpolate a coarse field up so it does not arrive as visible squares.

    Bicubic on the values themselves. See SMOOTH_MIN_EDGE_PX for why this
    happens before the colour ramp rather than after it.

    Two things it is careful about:

    Missing data does not survive interpolation. A NaN dragged through a
    bicubic kernel poisons every pixel it touches, so the holes are filled
    with a neutral value for the resize and then punched back out afterwards
    using a separately resampled mask. Without that, one missing cell at the
    edge of a domain eats a growing bite out of the picture.

    A field that is already fine enough is returned untouched. This only ever
    adds pixels; thinning a too-large grid is the caller's job, and doing both
    would mean resampling a field twice for no gain.
    """
    min_edge = SMOOTH_MIN_EDGE_PX if min_edge is None else int(min_edge)
    max_edge = MAX_EDGE_PX if max_edge is None else int(max_edge)
    data = np.asarray(data, dtype=np.float32)
    if data.ndim != 2 or data.size == 0:
        return data
    h, w = data.shape
    if h < 2 or w < 2:
        return data
    long_edge = max(h, w)
    if long_edge >= min_edge:
        return data

    scale = min(min_edge, max_edge) / float(long_edge)
    nw, nh = int(round(w * scale)), int(round(h * scale))
    if nw <= w and nh <= h:
        return data

    bad = ~np.isfinite(data)
    if bad.all():
        return data
    fill = float(np.nanmean(data[~bad])) if bad.any() else 0.0
    filled = np.where(bad, fill, data).astype(np.float32)

    # np.array, not np.asarray: PIL hands back a read-only view, and the
    # mask step below writes into this.
    out = np.array(
        Image.fromarray(filled, mode="F").resize((nw, nh), Image.BICUBIC),
        dtype=np.float32)

    if bad.any():
        # Resampled as "how much of this pixel was real data", then cut at a
        # half. Bilinear rather than bicubic on purpose: a bicubic kernel
        # overshoots past 0 and 1 and would carve holes in solid data.
        keep = np.asarray(
            Image.fromarray((~bad).astype(np.float32), mode="F")
                 .resize((nw, nh), Image.BILINEAR),
            dtype=np.float32)
        out[keep < 0.5] = np.nan
    return out


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

    data = smooth_upsample(data)

    lo, hi = spec["range"]
    norm = (data - lo) / float(hi - lo)
    bad = ~np.isfinite(norm)
    idx = np.clip(np.nan_to_num(norm) * 255.0, 0, 255).astype(np.uint8)

    rgb = lut_for(spec["ramp"], lo, hi)[idx]
    alpha = np.full(idx.shape, 200, dtype=np.uint8)
    alpha[bad] = 0
    # Values at the very bottom of the scale are usually "nothing here" for
    # precipitation and reflectivity, so they fade out instead of tinting the
    # whole map. A banded palette knows exactly where its own bottom is, so
    # reflectivity takes that rather than a flat index of six, which on the
    # -10 to 75 scale was minus eight: eight dBZ of nothing, painted.
    if spec["ramp"] == "precip":
        alpha[idx < 6] = 0
    band_alpha(spec["ramp"], idx, alpha, lo, hi)

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
            cost = (len(fhours_for(sp)) * MB_PER_HOUR.get(name, 5.0)
                    * REGION_COST.get(region, 1.0))
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
