#!/usr/bin/env python3
"""
Sea-surface temperature and ocean heat, as fields the browser can read.

    ~/wxenv/bin/python ~/GWCFCRadar/pi/sst_pipeline.py
    ~/wxenv/bin/python ~/GWCFCRadar/pi/sst_pipeline.py --source oisst --check

Three open NOAA products, none of which needs a login:

    OISST v2.1   0.25 deg daily analysis, 1982 to now, from NCEI.
    Coral Reef Watch   5 km daily, from STAR NESDIS.
    AOML   tropical cyclone heat potential and the depth of the 26 C
           isotherm, from the CoastWatch THREDDS server.

The design here differs from the site this was modelled on
(Triple-A-Tropics, by Andrew Austin-Adler, whose product choices and
anomaly conventions this follows with permission) in two deliberate ways,
both because the destination is a map rather than a page.

FIELDS, NOT PICTURES. That site renders finished figures with axes, a
colourbar and a title, one per region, because they are shown as pictures
on a web page. Here they are draped on a Leaflet map, so a picture with
axes baked into it would be nonsense. One bare global field per variant
covers every region, because the map does the zooming: 16 images a day
instead of the 252 the per-region cut would need, which is the difference
between a Raspberry Pi keeping up and a Raspberry Pi falling behind.

VALUES, NOT COLOURS. The pixels carry the measurement rather than a
colour: high byte in red, low byte in green, 65536 steps across a stated
range, exactly the encoding pi/gfs_pipeline.py already uses for soundings
and the browser already knows how to read. That buys two things a
coloured picture cannot. The Inspector can report the real temperature
under the cursor instead of guessing from a colour ramp, and the colours
themselves become a browser setting: changing the scale recolours what is
already downloaded, with nothing rebuilt here.

THE CLIMATOLOGY IS CACHED, AND THAT IS THE WHOLE TRICK. An anomaly needs
the 1991-2020 daily mean, and a record check needs the 1982-present
envelope, both at one day of the year. Computed the obvious way that is
around 45 files downloaded per day-of-year, and the change maps need
their own endpoints too, so a naive daily run is roughly 360 MB and a
long afternoon. But a past climatology cannot change: the mean of 1991 to
2020 for the third of May is the same number forever. So each day-of-year
is computed once, stored, and reused every year after. The first run of a
given calendar day is slow; the second is a file read.
"""

from __future__ import annotations

import argparse
import calendar
import datetime as dt
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from gfs_pipeline import (  # noqa: E402
    HTTP, bounds_from, disk_ok, free_mb, http_get, log, render_data_png,
)

try:
    from netCDF4 import Dataset
except Exception:                                    # pragma: no cover
    Dataset = None

OUT_DIR = os.path.expanduser("~/wxdata/sst")
CACHE_DIR = os.path.join(OUT_DIR, "_cache")

# The baselines, said once. Anomalies are against 1991-2020 because that is
# the current WMO normal and what OISST anomaly products quote; records are
# against the whole OISST era, which starts in September 1981 and is complete
# from 1982.
CLIMO_START, CLIMO_END = 1991, 2020
RECORDS_START = 1982

# How much of a pass to spend before stopping and leaving the rest for the
# next one. Same idea as the MRMS builder: a budget with a rotating start,
# so a slow product cannot starve everything behind it and radar, which is
# the time-critical build on this machine, is never held up.
PASS_BUDGET_S = float(os.environ.get("GWCFC_SST_BUDGET_S", "900"))

# Prune only when the disk is genuinely filling. Asked for as "keep the
# maximum" with deletion at 70 percent used, so that is the rule: below it
# nothing is ever thrown away, above it the oldest days go first.
PRUNE_AT_PCT = float(os.environ.get("GWCFC_SST_PRUNE_PCT", "70"))

# ── What gets built ─────────────────────────────────────────────────────────
#
# `range` is the encode range, not a colour choice: it is the span the 65536
# steps are laid across, so it has to cover everything the field can really
# be. Too narrow and the extremes clip; far too wide and the resolution goes.
# The browser reads these back out of the manifest, so widening one here is
# picked up without a page change.
VARIANTS = {
    "actual":           {"label": "Actual",            "unit": "C",  "range": (-2.0, 36.0)},
    "anomaly":          {"label": "Anomaly",           "unit": "C",  "range": (-8.0, 8.0)},
    "anomaly_gmr":      {"label": "Anom minus global", "unit": "C",  "range": (-8.0, 8.0)},
    "anomaly_records":  {"label": "Anomaly + records", "unit": "C",  "range": (-8.0, 8.0)},
    "change7d":         {"label": "7-day change",      "unit": "C",  "range": (-6.0, 6.0)},
    "change15d":        {"label": "15-day change",     "unit": "C",  "range": (-6.0, 6.0)},
    "change30d":        {"label": "30-day change",     "unit": "C",  "range": (-6.0, 6.0)},
}
SURFACE_VARIANTS = list(VARIANTS)

SOURCES = {
    "oisst": {
        "label": "OISST (0.25 deg)",
        "note": "NOAA OISST v2.1 daily analysis, 1982 to present.",
        "variants": SURFACE_VARIANTS,
        # OISST publishes about a day behind, and the newest file spends a
        # while as _preliminary before the final one replaces it.
        "lag_days": 1,
    },
    "crw": {
        "label": "Coral Reef Watch (5 km)",
        "note": "NOAA Coral Reef Watch 5 km daily SST.",
        "variants": SURFACE_VARIANTS,
        "lag_days": 1,
    },
    "aoml": {
        "label": "AOML ocean heat",
        "note": "NOAA AOML tropical cyclone heat potential and 26 C isotherm depth.",
        "variants": ["tchp", "d26"],
        "lag_days": 1,
    },
}
AOML_VARIANTS = {
    # TCHP is the heat available to a hurricane above the 26 C isotherm, the
    # single most useful ocean number for intensity. 50 kJ/cm2 is roughly
    # where rapid intensification becomes plausible.
    "tchp": {"label": "Cyclone heat potential", "unit": "kJ/cm2", "range": (0.0, 180.0)},
    "d26":  {"label": "26 C isotherm depth",    "unit": "m",      "range": (0.0, 250.0)},
}

OISST_BASE = ("https://www.ncei.noaa.gov/data/"
              "sea-surface-temperature-optimum-interpolation/v2.1/access/avhrr")
CRW_BASE = ("https://www.star.nesdis.noaa.gov/pub/sod/mecb/crw/data/"
            "5km/v3.1/nc/v1.0/daily")
AOML_URL = "https://cwcgom.aoml.noaa.gov/thredds/dodsC/TCHP/TCHP.nc"


def variant_spec(source, variant):
    if source == "aoml":
        return AOML_VARIANTS.get(variant)
    return VARIANTS.get(variant)


# ── Fetching ────────────────────────────────────────────────────────────────

def oisst_urls(d: dt.date):
    """Both spellings of one day's file, final first.

    A day appears as `_preliminary` within hours and is replaced by the final
    file a week or two later. Asking for the final one first means a day that
    has been finalised is never served from the preliminary copy.
    """
    stamp = d.strftime("%Y%m%d")
    base = f"{OISST_BASE}/{d:%Y%m}"
    return [f"{base}/oisst-avhrr-v02r01.{stamp}.nc",
            f"{base}/oisst-avhrr-v02r01.{stamp}_preliminary.nc"]


def crw_url(d: dt.date):
    return (f"{CRW_BASE}/sst/{d:%Y}/"
            f"coraltemp_v3.1_{d:%Y%m%d}.nc")


def _download(url, path, timeout=180):
    try:
        r = http_get(url, timeout=timeout, stream=True)
        if r is None or r.status_code != 200:
            return False
        tmp = path + ".part"
        with open(tmp, "wb") as fh:
            for chunk in r.iter_content(1 << 20):
                if chunk:
                    fh.write(chunk)
        os.replace(tmp, path)
        return True
    except Exception:
        try:
            os.remove(path + ".part")
        except Exception:
            pass
        return False


def _raw_path(source, d: dt.date):
    return os.path.join(CACHE_DIR, "raw", source, f"{d:%Y%m%d}.nc")


def fetch_day(source, d: dt.date):
    """One day's file on disk, downloading it if it is not already there.

    Kept rather than deleted after use, because the climatology walk asks for
    the same calendar day in thirty different years and the change maps ask
    for days this run already has. Pruned with everything else.
    """
    path = _raw_path(source, d)
    if os.path.exists(path) and os.path.getsize(path) > 4096:
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    urls = oisst_urls(d) if source == "oisst" else [crw_url(d)]
    for u in urls:
        if _download(u, path):
            return path
    return None


def read_sst(source, path):
    """The SST grid, its latitudes and its longitudes, in degrees C.

    Both products store a masked array with a fill value; the mask becomes
    NaN here so that missing water is missing rather than zero, which would
    paint the land freezing.
    """
    if Dataset is None:
        raise RuntimeError("netCDF4 is not installed in this environment")
    with Dataset(path) as nc:
        if source == "oisst":
            var = nc.variables["sst"]
            arr = np.asarray(var[:], dtype=np.float32)
            # (time, zlev, lat, lon) -> (lat, lon)
            while arr.ndim > 2:
                arr = arr[0]
            lats = np.asarray(nc.variables["lat"][:], dtype=np.float64)
            lons = np.asarray(nc.variables["lon"][:], dtype=np.float64)
        else:
            key = "analysed_sst" if "analysed_sst" in nc.variables else "sea_surface_temperature"
            var = nc.variables[key]
            arr = np.asarray(var[:], dtype=np.float32)
            while arr.ndim > 2:
                arr = arr[0]
            lats = np.asarray(nc.variables["lat"][:], dtype=np.float64)
            lons = np.asarray(nc.variables["lon"][:], dtype=np.float64)
        fill = getattr(var, "_FillValue", None)
        if fill is not None:
            arr = np.where(arr == float(fill), np.nan, arr)
        # Both are already Celsius, but a Kelvin file would be silently 273
        # degrees wrong, and an ocean is never 200 C.
        if np.nanmax(arr) > 100.0:
            arr = arr - 273.15
    arr = np.where(np.isfinite(arr), arr, np.nan)
    arr[arr < -5.0] = np.nan
    return arr, lats, lons


# ── The cached climatology, which is what makes this affordable ─────────────

def _doy_key(source, month, day, kind):
    return os.path.join(CACHE_DIR, "clim", source, f"{month:02d}{day:02d}_{kind}.npy")


def _load_npy(path):
    try:
        if os.path.exists(path):
            return np.load(path)
    except Exception:
        pass
    return None


def _save_npy(path, arr):
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp.npy"
        # float32 rather than float64: a hundredth of a degree is far finer
        # than the measurement, and it halves a file that is kept forever.
        np.save(tmp, np.asarray(arr, dtype=np.float32))
        os.replace(tmp, path)
    except Exception as e:
        log(f"sst: could not cache {os.path.basename(path)}: {e}")


def climatology_for(source, month, day, deadline=None):
    """The 1991-2020 mean and the 1982-present envelope for one calendar day.

    Computed once and kept. The mean of thirty past Mays cannot change, so
    the expensive walk happens on the first run of a given calendar day and
    never again. Returns (mean, record_high, record_low) or Nones.

    February 29 borrows February 28, because there are only seven leap years
    in the baseline and a mean of seven is visibly noisier than a mean of
    thirty sitting next to it.
    """
    if month == 2 and day == 29:
        month, day = 2, 28
    mean_p = _doy_key(source, month, day, "mean")
    hi_p = _doy_key(source, month, day, "recmax")
    lo_p = _doy_key(source, month, day, "recmin")
    mean, hi, lo = _load_npy(mean_p), _load_npy(hi_p), _load_npy(lo_p)
    if mean is not None and hi is not None and lo is not None:
        return mean, hi, lo

    log(f"sst: building {source} climatology for {month:02d}-{day:02d} "
        f"(one time, then cached)")
    acc = None          # running sum for the 1991-2020 mean
    cnt = None          # how many years contributed to each pixel
    rmax = rmin = None
    used_clim = 0
    this_year = dt.date.today().year
    for year in range(RECORDS_START, this_year + 1):
        if deadline and time.time() > deadline:
            log("sst: climatology hit the pass budget, will finish next run")
            return None, None, None
        if month == 2 and day == 29 and not calendar.isleap(year):
            continue
        try:
            d = dt.date(year, month, day)
        except ValueError:
            continue
        if d > dt.date.today():
            continue
        path = fetch_day(source, d)
        if not path:
            continue
        try:
            arr, _, _ = read_sst(source, path)
        except Exception:
            continue
        if rmax is None:
            rmax = np.full(arr.shape, np.nan, dtype=np.float32)
            rmin = np.full(arr.shape, np.nan, dtype=np.float32)
            acc = np.zeros(arr.shape, dtype=np.float64)
            cnt = np.zeros(arr.shape, dtype=np.int32)
        if arr.shape != rmax.shape:
            continue
        good = np.isfinite(arr)
        rmax = np.fmax(rmax, np.where(good, arr, np.nan))
        rmin = np.fmin(rmin, np.where(good, arr, np.nan))
        if CLIMO_START <= year <= CLIMO_END:
            acc[good] += arr[good]
            cnt[good] += 1
            used_clim += 1

    if rmax is None or used_clim == 0:
        log(f"sst: no {source} history available for {month:02d}-{day:02d}")
        return None, None, None
    with np.errstate(invalid="ignore"):
        mean = np.where(cnt > 0, acc / np.maximum(cnt, 1), np.nan).astype(np.float32)
    _save_npy(mean_p, mean)
    _save_npy(hi_p, rmax)
    _save_npy(lo_p, rmin)
    log(f"sst: cached {source} {month:02d}-{day:02d} from {used_clim} baseline years")
    return mean, rmax, rmin


# ── The fields ──────────────────────────────────────────────────────────────

def anomaly_of(arr, mean):
    if mean is None or arr.shape != mean.shape:
        return None
    with np.errstate(invalid="ignore"):
        return (arr - mean).astype(np.float32)


def build_variant(source, variant, day, deadline=None):
    """One field, as numbers. Returns (values, lats, lons) or (None, None, None)."""
    path = fetch_day(source, day)
    if not path:
        return None, None, None
    arr, lats, lons = read_sst(source, path)

    if variant == "actual":
        return arr, lats, lons

    mean, rhi, rlo = climatology_for(source, day.month, day.day, deadline)
    anom = anomaly_of(arr, mean)
    if anom is None:
        return None, None, None

    if variant == "anomaly":
        return anom, lats, lons

    if variant == "anomaly_gmr":
        # The same anomaly with the day's global mean taken out, which is what
        # separates "this patch is unusually warm" from "the whole ocean is
        # warmer than it was". Area weighted, because a degree cell near the
        # pole is a fraction of the area of one at the equator and a plain
        # mean would let the Arctic outvote the tropics.
        w = np.cos(np.deg2rad(np.asarray(lats, dtype=np.float64)))[:, None]
        w = np.broadcast_to(w, anom.shape)
        good = np.isfinite(anom)
        if not good.any():
            return None, None, None
        gm = float(np.sum(anom[good] * w[good]) / np.sum(w[good]))
        return (anom - gm).astype(np.float32), lats, lons

    if variant == "anomaly_records":
        # The anomaly, with anywhere at or past its own record pushed outside
        # the normal range so the browser can mark it. A record is a fact
        # about one pixel's whole history, so it cannot be read off the
        # anomaly alone: +2 is a record in one place and ordinary in another.
        if rhi is None:
            return None, None, None
        out = anom.copy()
        with np.errstate(invalid="ignore"):
            hit_hi = np.isfinite(arr) & np.isfinite(rhi) & (arr >= rhi)
            hit_lo = np.isfinite(arr) & np.isfinite(rlo) & (arr <= rlo)
        out[hit_hi] = 99.0
        out[hit_lo] = -99.0
        return out, lats, lons

    if variant.startswith("change"):
        back = int(variant[len("change"):-1])
        then = day - dt.timedelta(days=back)
        p2 = fetch_day(source, then)
        if not p2:
            return None, None, None
        prev, _, _ = read_sst(source, p2)
        if prev.shape != arr.shape:
            return None, None, None
        mean2, _, _ = climatology_for(source, then.month, then.day, deadline)
        anom2 = anomaly_of(prev, mean2)
        if anom2 is None:
            return None, None, None
        # The change in the ANOMALY, not in the temperature. Over a month the
        # temperature change is mostly the season turning, which is not news;
        # the anomaly change is the ocean doing something the season does not
        # explain.
        with np.errstate(invalid="ignore"):
            return (anom - anom2).astype(np.float32), lats, lons

    return None, None, None


def build_aoml(variant):
    """TCHP or the 26 C isotherm depth, from AOML's THREDDS server."""
    if Dataset is None:
        raise RuntimeError("netCDF4 is not installed in this environment")
    # Read straight over OPeNDAP: the whole file is large and only the newest
    # time step is wanted, which is exactly what OPeNDAP is for.
    with Dataset(AOML_URL) as nc:
        key = "Tropical_Cyclone_Heat_Potential" if variant == "tchp" else "D26"
        names = {k.lower(): k for k in nc.variables}
        if key not in nc.variables:
            want = "heat" if variant == "tchp" else "d26"
            match = [v for k, v in names.items() if want in k]
            if not match:
                raise RuntimeError(f"AOML has no variable for {variant}")
            key = match[0]
        var = nc.variables[key]
        arr = np.asarray(var[:], dtype=np.float32)
        while arr.ndim > 2:
            arr = arr[-1]
        latk = names.get("latitude", names.get("lat"))
        lonk = names.get("longitude", names.get("lon"))
        lats = np.asarray(nc.variables[latk][:], dtype=np.float64)
        lons = np.asarray(nc.variables[lonk][:], dtype=np.float64)
        fill = getattr(var, "_FillValue", None)
        if fill is not None:
            arr = np.where(arr == float(fill), np.nan, arr)
    arr = np.where(np.isfinite(arr) & (arr > -1e10), arr, np.nan)
    return arr, lats, lons


# ── Writing ─────────────────────────────────────────────────────────────────

def out_path(source, variant, day):
    return os.path.join(OUT_DIR, source, variant, f"{day:%Y%m%d}.png")


def write_field(source, variant, day, values, lats, lons):
    spec = variant_spec(source, variant)
    lo, hi = spec["range"]
    p = out_path(source, variant, day)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp.png"
    render_data_png(values, lats, lo, hi, tmp)
    os.replace(tmp, p)
    return {
        "stamp": f"{day:%Y%m%d}",
        "bounds": bounds_from(lats, lons),
        "range": [lo, hi],
        "unit": spec["unit"],
        "bytes": os.path.getsize(p),
    }


def read_index():
    p = os.path.join(OUT_DIR, "index.json")
    try:
        with open(p) as fh:
            return json.load(fh)
    except Exception:
        return {}


def write_index(idx):
    os.makedirs(OUT_DIR, exist_ok=True)
    idx["updated"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    tmp = os.path.join(OUT_DIR, "index.json.tmp")
    with open(tmp, "w") as fh:
        json.dump(idx, fh, separators=(",", ":"))
    os.replace(tmp, os.path.join(OUT_DIR, "index.json"))


def scan_frames(source, variant):
    d = os.path.join(OUT_DIR, source, variant)
    try:
        return sorted(f[:-4] for f in os.listdir(d) if f.endswith(".png"))
    except Exception:
        return []


# ── Housekeeping ────────────────────────────────────────────────────────────

def disk_pct_used(path):
    try:
        st = os.statvfs(path)
        total = st.f_blocks * st.f_frsize
        free = st.f_bavail * st.f_frsize
        if total <= 0:
            return 0.0
        return 100.0 * (1.0 - free / float(total))
    except Exception:
        return 0.0


def prune():
    """Drop the oldest days, but only once the card is actually filling.

    Asked for as keep the maximum, delete at 70 percent. Below that nothing
    goes, so the archive grows as deep as the disk allows; above it the
    oldest day of every product is dropped until it is back under. Raw
    downloads go before rendered fields, because a raw file can be fetched
    again and a rendered day is what somebody is scrubbing through.
    """
    os.makedirs(OUT_DIR, exist_ok=True)
    if disk_pct_used(OUT_DIR) < PRUNE_AT_PCT:
        return 0
    dropped = 0
    for _ in range(400):
        if disk_pct_used(OUT_DIR) < PRUNE_AT_PCT - 2:
            break
        oldest, oldest_path = None, None
        raw_root = os.path.join(CACHE_DIR, "raw")
        for root in (raw_root, OUT_DIR):
            for dirpath, _dirs, files in os.walk(root):
                if os.path.join(OUT_DIR, "_cache", "clim") in dirpath:
                    continue          # a cached climatology is never redone
                for f in files:
                    if not (f.endswith(".png") or f.endswith(".nc")):
                        continue
                    stamp = f.split(".")[0]
                    if not (len(stamp) == 8 and stamp.isdigit()):
                        continue
                    if oldest is None or stamp < oldest:
                        oldest, oldest_path = stamp, os.path.join(dirpath, f)
            if oldest:                # raw first, and only fall through if none
                break
        if not oldest_path:
            break
        try:
            os.remove(oldest_path)
            dropped += 1
        except Exception:
            break
    if dropped:
        log(f"sst: pruned {dropped} old files, disk now "
            f"{disk_pct_used(OUT_DIR):.0f}% used")
    return dropped


# ── The pass ────────────────────────────────────────────────────────────────

def newest_day(source):
    """The most recent day worth trying, given the product's publish lag."""
    lag = SOURCES[source]["lag_days"]
    return dt.date.today() - dt.timedelta(days=lag)


def build_pass(only_source=None, only_variant=None, day=None, budget=None):
    deadline = time.time() + (budget if budget is not None else PASS_BUDGET_S)
    idx = read_index()
    idx.setdefault("sources", {})
    built = skipped = 0

    order = [only_source] if only_source else list(SOURCES)
    # Rotate the starting point so a budget that runs out does not always cut
    # the same product. Same reason the MRMS builder rotates.
    if not only_source and len(order) > 1:
        shift = dt.date.today().toordinal() % len(order)
        order = order[shift:] + order[:shift]

    for source in order:
        if source not in SOURCES:
            log(f"sst: no such source {source!r}")
            continue
        sinfo = SOURCES[source]
        entry = idx["sources"].setdefault(source, {})
        entry["label"] = sinfo["label"]
        entry["note"] = sinfo["note"]
        entry.setdefault("variants", {})
        target = day or newest_day(source)

        for variant in sinfo["variants"]:
            if only_variant and variant != only_variant:
                continue
            if time.time() > deadline:
                log("sst: pass budget reached, the rest waits for the next run")
                skipped += 1
                continue
            if not disk_ok(OUT_DIR):
                log("sst: too little free disk to write, stopping this pass")
                break
            p = out_path(source, variant, target)
            if os.path.exists(p) and os.path.getsize(p) > 1024:
                continue                     # already built for this day
            try:
                if source == "aoml":
                    vals, lats, lons = build_aoml(variant)
                else:
                    vals, lats, lons = build_variant(source, variant, target, deadline)
            except Exception as e:
                log(f"sst: {source}/{variant} failed: {e}")
                continue
            if vals is None:
                log(f"sst: {source}/{variant} for {target} not available yet")
                continue
            try:
                meta = write_field(source, variant, target, vals, lats, lons)
            except Exception as e:
                log(f"sst: {source}/{variant} could not be written: {e}")
                continue
            spec = variant_spec(source, variant)
            v = entry["variants"].setdefault(variant, {})
            v.update({"label": spec["label"], "unit": spec["unit"],
                      "range": list(spec["range"]), "bounds": meta["bounds"],
                      "newest": meta["stamp"]})
            built += 1
            log(f"sst: built {source}/{variant} {target} "
                f"({meta['bytes'] // 1024} KB)")

        for variant in list(entry["variants"]):
            entry["variants"][variant]["frames"] = scan_frames(source, variant)

    prune()
    idx["disk_pct"] = round(disk_pct_used(OUT_DIR), 1)
    write_index(idx)
    log(f"sst: pass done, {built} built, {skipped} left for next time, "
        f"disk {idx['disk_pct']:.0f}% used")
    return built


def check():
    """Say what this machine can and cannot do, without building anything."""
    print("sst_pipeline check")
    print(f"  netCDF4 importable: {'yes' if Dataset is not None else 'NO'}")
    print(f"  output dir: {OUT_DIR}")
    print(f"  free: {free_mb(OUT_DIR):.0f} MB, "
          f"{disk_pct_used(OUT_DIR):.0f}% used, prune at {PRUNE_AT_PCT:.0f}%")
    for source in SOURCES:
        d = newest_day(source)
        url = (oisst_urls(d)[0] if source == "oisst"
               else crw_url(d) if source == "crw" else AOML_URL)
        try:
            r = HTTP.head(url, timeout=25, allow_redirects=True)
            state = f"HTTP {r.status_code}"
        except Exception as e:
            state = f"unreachable ({e.__class__.__name__})"
        print(f"  {source:6s} newest={d} {state}")
        cached = 0
        cdir = os.path.join(CACHE_DIR, "clim", source)
        if os.path.isdir(cdir):
            cached = len([f for f in os.listdir(cdir) if f.endswith("_mean.npy")])
        print(f"         climatology days cached: {cached}/366")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--source", help="only this source")
    ap.add_argument("--variant", help="only this variant")
    ap.add_argument("--date", help="build this UTC day, YYYYMMDD")
    ap.add_argument("--budget", type=float, help="seconds to spend")
    ap.add_argument("--backfill", type=int, default=0,
                    help="also build this many earlier days")
    ap.add_argument("--check", action="store_true", help="report and exit")
    a = ap.parse_args()
    if a.check:
        check()
        return
    os.makedirs(OUT_DIR, exist_ok=True)
    day = dt.datetime.strptime(a.date, "%Y%m%d").date() if a.date else None
    build_pass(a.source, a.variant, day, a.budget)
    for i in range(1, max(0, a.backfill) + 1):
        base = day or newest_day(a.source or "oisst")
        build_pass(a.source, a.variant, base - dt.timedelta(days=i), a.budget)


if __name__ == "__main__":
    main()
