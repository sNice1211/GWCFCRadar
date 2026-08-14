#!/usr/bin/env python3
"""
Builds forecast-model map overlays on the Pi, so the browser does not have to.

The web app is a static page with no backend, and has to run in the PlayStation
5 browser, which has no WebGL. Both of those rule out doing this work on the
client. So the Pi fetches GRIB2 from NOAA, decodes it, and writes finished PNGs
that Leaflet drops on the map as a plain image overlay. The browser's entire job
becomes displaying a picture.

Measured on the target Pi, with NOAA cropping to CONUS before sending:
    0.52 MB per forecast hour, about 1 second each
    ~21 MB and ~40 seconds per run, ~83 MB per day
    ~155 MB on disk once old runs are being pruced

Run it from cron every hour. It works out whether there is anything to do and
exits quickly when there is not.
"""

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

# Forecast hours. Three-hourly to five days is the range the app already shows,
# and it is 41 requests rather than 121 for the same span.
FHOURS = list(range(0, 121, 3))

KEEP_RUNS = 4          # about 24 hours of runs
REQUEST_TIMEOUT = 60
RETRIES = 3

FILTER_URL = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl"
RAW_BASE = "https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod"

# Fields to render. Matched on the GRIB shortName, level type and level that
# cfgrib preserves, rather than on the variable name it happens to invent,
# because those names differ between versions (t2m vs t, msl vs prmsl).
#
# convert turns raw GRIB units into what the map should show.
FIELDS = {
    "t2m":   {"short": "2t",    "levtype": "heightAboveGround", "level": 2,
              "convert": lambda a: a - 273.15, "range": (-40, 45),  "ramp": "temp"},
    "d2m":   {"short": "2d",    "levtype": "heightAboveGround", "level": 2,
              "convert": lambda a: a - 273.15, "range": (-40, 30),  "ramp": "temp"},
    "mslp":  {"short": "prmsl", "levtype": "meanSea",           "level": 0,
              "convert": lambda a: a / 100.0,  "range": (960, 1050), "ramp": "viridis"},
    "cape":  {"short": "cape",  "levtype": "surface",           "level": 0,
              "convert": lambda a: a,          "range": (0, 5000),  "ramp": "heat"},
    "refc":  {"short": "refc",  "levtype": "atmosphere",        "level": 0,
              "convert": lambda a: a,          "range": (-10, 75),  "ramp": "radar"},
    "apcp":  {"short": "tp",    "levtype": "surface",           "level": 0,
              "convert": lambda a: a,          "range": (0, 50),    "ramp": "precip"},
    "wind":  {"short": "10si",  "levtype": "heightAboveGround", "level": 10,
              "convert": lambda a: a * 1.94384, "range": (0, 80),   "ramp": "wind",
              "derive": "windspeed"},
}

# NOMADS query flags: which variables and which levels to include.
VAR_FLAGS = ["var_TMP", "var_DPT", "var_PRMSL", "var_CAPE",
             "var_REFC", "var_APCP", "var_UGRD", "var_VGRD"]
LEV_FLAGS = ["lev_2_m_above_ground", "lev_10_m_above_ground",
             "lev_mean_sea_level", "lev_surface", "lev_entire_atmosphere"]


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

def cycle_for(now=None):
    """
    The most recent run that should actually be published.

    GFS runs at 00/06/12/18Z and appears roughly 3.5 to 5 hours later, so the
    lag is subtracted before rounding. Picking the cycle by the clock alone
    selects a run that does not exist yet, and then every hourly cron wakes up
    and waits for it.
    """
    now = now or datetime.now(timezone.utc)
    t = now - timedelta(hours=5)
    return t.strftime("%Y%m%d"), f"{(t.hour // 6) * 6:02d}"


def run_is_complete(date_str, cycle):
    """
    True when the last forecast hour of this run has published.

    Checked against the real index file on the data path. The filter CGI does
    not serve .idx at all: asking it for one returns an HTML error with a 200,
    which reads as success and makes the check useless.
    """
    last = FHOURS[-1]
    url = (f"{RAW_BASE}/gfs.{date_str}/{cycle}/atmos/"
           f"gfs.t{cycle}z.pgrb2.0p25.f{last:03d}.idx")
    try:
        r = requests.get(url, timeout=30,
                         headers={"Range": "bytes=0-256"})
        # A real index is text listing fields. An error page is HTML.
        return r.status_code in (200, 206) and ":" in r.text and "<" not in r.text[:40]
    except requests.RequestException:
        return False


def fetch_hour(date_str, cycle, fhr, path):
    """Download one forecast hour, cropped to the box by NOAA before sending."""
    params = {
        "file": f"gfs.t{cycle}z.pgrb2.0p25.f{fhr:03d}",
        "dir": f"/gfs.{date_str}/{cycle}/atmos",
        "subregion": "",
        **{k: "on" for k in VAR_FLAGS},
        **{k: "on" for k in LEV_FLAGS},
        **{k: v for k, v in BOX.items()},
    }
    for attempt in range(RETRIES):
        try:
            r = requests.get(FILTER_URL, params=params, timeout=REQUEST_TIMEOUT)
            if r.status_code == 200 and len(r.content) > 5000 \
                    and r.content[:4] == b"GRIB":
                with open(path, "wb") as f:
                    f.write(r.content)
                return True
            log(f"    f{fhr:03d} attempt {attempt+1}: HTTP {r.status_code}, "
                f"{len(r.content)} bytes")
        except requests.RequestException as e:
            log(f"    f{fhr:03d} attempt {attempt+1}: {e}")
        time.sleep(2 ** attempt)
    return False


# ── Decode and render ───────────────────────────────────────────────────────

def open_fields(grib_path):
    """
    Pull the wanted fields out of a GRIB file as plain arrays.

    Matched on the GRIB keys cfgrib carries through (shortName, typeOfLevel,
    level) rather than on the variable name, which is not stable across
    versions. Returns {key: (array, lats, lons)}.
    """
    import cfgrib

    found = {}
    try:
        datasets = cfgrib.open_datasets(
            grib_path, backend_kwargs={"indexpath": ""})
    except Exception as e:
        log(f"    decode failed: {e}")
        return found

    uv = {}
    for ds in datasets:
        for name in ds.data_vars:
            da = ds[name]
            a = da.attrs
            short = a.get("GRIB_shortName", "")
            levt = a.get("GRIB_typeOfLevel", "")
            lev = a.get("GRIB_level", 0)
            lats = ds["latitude"].values
            lons = ds["longitude"].values

            # Wind speed is derived, so u and v are held until both are seen.
            if short in ("10u", "10v") and levt == "heightAboveGround":
                uv[short] = (da.values, lats, lons)
                continue

            for key, spec in FIELDS.items():
                if spec.get("derive"):
                    continue
                if short == spec["short"] and levt == spec["levtype"] \
                        and int(lev) == int(spec["level"]):
                    found[key] = (da.values, lats, lons)

    if "10u" in uv and "10v" in uv:
        u, lats, lons = uv["10u"]
        v = uv["10v"][0]
        found["wind"] = (np.sqrt(u ** 2 + v ** 2), lats, lons)

    for ds in datasets:
        try:
            ds.close()
        except Exception:
            pass
    return found


def render_png(values, lats, spec, out_path):
    """
    Turn one field into an RGBA PNG the size of the grid.

    Written straight from the array, so one pixel is one grid cell and the
    image lines up exactly with the bounds given to Leaflet. Nothing crops or
    pads it, which is what goes wrong when this is done through a plot.
    """
    data = spec["convert"](np.asarray(values, dtype=np.float32))

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

def prune(keep=KEEP_RUNS):
    if not os.path.isdir(OUT_DIR):
        return
    runs = sorted(d for d in os.listdir(OUT_DIR)
                  if os.path.isdir(os.path.join(OUT_DIR, d)) and d[0].isdigit())
    for old in runs[:-keep] if len(runs) > keep else []:
        log(f"pruning {old}")
        shutil.rmtree(os.path.join(OUT_DIR, old), ignore_errors=True)


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
            # A lock left behind by a crash should not block forever.
            try:
                if time.time() - os.path.getmtime(self.path) > 3 * 3600:
                    os.unlink(self.path)
                    return self.__enter__()
            except OSError:
                pass
            log("another run is already going; exiting")
            sys.exit(0)

    def __exit__(self, *exc):
        if self.fd is not None:
            os.close(self.fd)
        try:
            os.unlink(self.path)
        except OSError:
            pass


# ── Main ────────────────────────────────────────────────────────────────────

def main():
    date_str, cycle = cycle_for()
    run_id = f"{date_str}_{cycle}"
    run_dir = os.path.join(OUT_DIR, run_id)
    done_marker = os.path.join(run_dir, "manifest.json")

    if os.path.exists(done_marker):
        log(f"{run_id} already built")
        return 0

    if not run_is_complete(date_str, cycle):
        log(f"{run_id} not published yet; will try again next hour")
        return 0

    log(f"building {run_id}")
    os.makedirs(run_dir, exist_ok=True)
    t_start = time.time()

    built = {k: [] for k in FIELDS}
    ranges = {}
    ok_hours = 0

    for fhr in FHOURS:
        with tempfile.NamedTemporaryFile(suffix=".grib2", delete=False) as tf:
            tmp = tf.name
        try:
            if not fetch_hour(date_str, cycle, fhr, tmp):
                log(f"  f{fhr:03d} download failed, skipping")
                continue
            fields = open_fields(tmp)
            if not fields:
                log(f"  f{fhr:03d} nothing decoded, skipping")
                continue
            for key, (vals, lats, _lons) in fields.items():
                spec = FIELDS.get(key)
                if spec is None:
                    continue
                name = f"{key}_f{fhr:03d}.png"
                lo, hi = render_png(vals, lats, spec, os.path.join(run_dir, name))
                built[key].append(fhr)
                r = ranges.setdefault(key, [lo, hi])
                r[0], r[1] = min(r[0], lo), max(r[1], hi)
            ok_hours += 1
            log(f"  f{fhr:03d} ok ({len(fields)} fields)")
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass

    if ok_hours == 0:
        log("no forecast hours succeeded; leaving no manifest so this retries")
        return 1

    # The manifest is written last and is what marks the run finished. A run
    # that died halfway has no manifest, so the site keeps serving the previous
    # one rather than a half-built set of pictures.
    manifest = {
        "run": run_id,
        "cycle": f"{date_str}T{cycle}:00Z",
        "built_at": datetime.now(timezone.utc).isoformat(),
        "bounds": BOUNDS_LATLON,
        "hours": FHOURS,
        "fields": {k: {"hours": v,
                       "min": round(ranges.get(k, [0, 0])[0], 2),
                       "max": round(ranges.get(k, [0, 0])[1], 2),
                       "pattern": f"{k}_f{{fhr:03d}}.png"}
                   for k, v in built.items() if v},
        "seconds": round(time.time() - t_start, 1),
    }
    with open(done_marker, "w") as f:
        json.dump(manifest, f, indent=1)

    # A stable pointer, so the site does not have to guess the newest run.
    with open(os.path.join(OUT_DIR, "latest.json"), "w") as f:
        json.dump({"run": run_id, "path": f"{run_id}/manifest.json"}, f)

    log(f"done: {ok_hours}/{len(FHOURS)} hours in {manifest['seconds']}s")
    prune()
    return 0


if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)
    with Lock():
        sys.exit(main())
