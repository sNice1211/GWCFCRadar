#!/usr/bin/env python3
"""
Google DeepMind's cyclone forecasts, on the Pi.

These are not model charts and do not go through the model pipeline. Two
different things arrive from WeatherLab:

  Tracks, as CSV. Where each storm goes, one row per point, for every member
  of an ensemble. Drawn as lines, which is the spaghetti plot people mean when
  they say spaghetti plot, except from a model that has been beating the
  physical ones at track error.

  Cyclogenesis probability, as NetCDF. A grid of how likely a storm is to form
  where none exists yet, which is a genuinely different question from where an
  existing one is going, and the harder half of a tropical forecast.

Five variants are published: OPER is what they run operationally, FNV3P0
through P2 are versions of the experimental model, and FNV3_LARGE_ENSEMBLE is
the same thing with far more members, which is the only one carrying the
genesis fields.

    python3 pi/cyclones_pipeline.py             # everything for the newest run
    python3 pi/cyclones_pipeline.py --check     # what is published, no work
    python3 pi/cyclones_pipeline.py OPER        # one variant

Output lands in ~/wxdata/cyclones/ and is served by the same serve.py.
"""

import base64
import csv
import gzip
import io
import os
import sys
import time
from datetime import datetime, timedelta, timezone

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gfs_pipeline import (HTTP, LUTS, Lock, bounds_from, log,  # noqa: E402
                          regrid_to_latlon, write_json)

OUT_DIR = os.path.expanduser("~/wxdata/cyclones")
BASE = "https://deepmind.google.com/science/weatherlab/download/cyclones"

# The download API's model slugs, which are NOT the names the Weather Lab
# website shows. This pipeline spent weeks asking for OPER and FNV3P0 through
# FNV3_LARGE_ENSEMBLE, the labels a person sees in the site's model picker,
# and every request came back empty: the anonymous "Scriptable URLs" endpoint
# knows the models as FNV3 (the 50 member cyclone ensemble) and GENC
# (GenCast, rebranded WeatherNext Gen). That mapping, the working product
# path below, and the CSV column names are all live-verified findings from
# Triple-A Tropics' enscenters package, used with permission.
MODELS = ["FNV3", "GENC"]
MODEL_LABELS = {"FNV3": "Google FNV3 (50 members)",
                "GENC": "Google GenCast"}

# Four cycles a day on the synoptic hours. Published a few hours later.
CYCLE_H = 6
LAG_H = 2
CYCLES_BACK = 8          # ~2 days: a cycle that disseminated late still lands

# Adler's live observations: strictly 6-hourly steps, longest track ~312 h.
STEP_H = 6
MAX_LEAD_H = 480

KEEP_RUNS = 4


def run_stamp(dt):
    """The way WeatherLab spells a run in a URL: 2026_08_15T12_00."""
    return f"{dt.year:04d}_{dt.month:02d}_{dt.day:02d}T{dt.hour:02d}_00"


def cycle_for(now=None, back=0):
    now = now or datetime.now(timezone.utc)
    t = now - timedelta(hours=LAG_H + back * CYCLE_H)
    return t.replace(hour=(t.hour // CYCLE_H) * CYCLE_H,
                     minute=0, second=0, microsecond=0)


def track_url(model, stamp):
    """Every member's basin-wide tracks for one cycle.

    The cyclogenesis CSV, not the paired one. Paired sounds like the track
    product and is what this used to fetch, but it holds only the storms the
    model matched to OBSERVED systems: nearly empty most of the time, and
    never the ensemble fan. The cyclogenesis file is the whole ensemble,
    every member's every storm, one row per point.
    """
    return (f"{BASE}/{model}/ensemble/cyclogenesis/csv/"
            f"{model}_{stamp}_cyclogenesis.csv")


def genesis_url(model, stamp, field):
    """The probability-field guess. Unverified: nothing has ever been seen at
    this path, and it is tried cheaply once per run in case it appears."""
    return (f"{BASE}/{model}/ensemble/cyclogenesis/netcdf/{field}/"
            f"{model}_{stamp}_{field}.nc.gz.base64")


def get(url, timeout=120):
    try:
        r = HTTP.get(url, timeout=timeout)
        if r.status_code != 200 or len(r.content) < 40:
            return None
        return r.content
    except Exception:
        return None


# ── Tracks ──────────────────────────────────────────────────────────────────

# The verified spellings first (Triple-A Tropics read them off the live
# files), the old guesses kept behind them as fallbacks so a renamed column
# degrades to a hunt instead of a blank map. --check prints the header when
# nothing matches.
TRACK_COLUMNS = {
    "lat":    ("lat", "latitude", "lat_deg"),
    "lon":    ("lon", "longitude", "lon_deg"),
    "time":   ("time", "valid_time", "timestamp", "datetime", "valid"),
    "lead":   ("lead_time_hours", "lead_time", "lead", "fhr",
               "forecast_hour", "step"),
    "wind":   ("maximum_sustained_wind_speed_knots", "wind_speed",
               "max_wind", "vmax", "wind", "intensity"),
    "mslp":   ("minimum_sea_level_pressure_hpa", "mslp", "min_pressure",
               "pressure", "pmin"),
    "member": ("sample", "member", "ensemble_member", "realization",
               "number"),
    # track_id is deliberately NOT mapped to storm: it is a bare number that
    # separates one member's simultaneous storms, not a name anyone knows.
    # The site names these lines itself, from the nearest storm in the
    # a-deck index.
    "tid":    ("track_id",),
    "storm":  ("storm_id", "storm", "cyclone_id", "name"),
}


def _pick(header):
    """Which real column feeds each wanted value, by name, case insensitive."""
    low = {h.lower().strip(): h for h in header}
    out = {}
    for want, options in TRACK_COLUMNS.items():
        for opt in options:
            if opt in low:
                out[want] = low[opt]
                break
    return out


def parse_tracks(raw):
    """
    The cyclogenesis CSV as points grouped into drawable lines.

    One member holds several storms at once, split by track_id, so the line
    key is storm|member|track. The site splits on the bar and reads the
    first two, which keeps every existing consumer working while the third
    part keeps two simultaneous storms in one member from being welded into
    a single zigzag line.
    """
    text = raw.decode("utf-8", errors="ignore")
    # The file opens with a licence and staleness notice as comment lines, so
    # the first row is a sentence rather than a header. Skipping anything
    # starting with a hash finds the real one, and blank lines go with it
    # because a stray one before the header reads as an empty column list.
    lines = [ln for ln in text.splitlines()
             if ln.strip() and not ln.lstrip().startswith("#")]
    rows = list(csv.reader(lines))
    if len(rows) < 2:
        return {}, []
    header, body = rows[0], rows[1:]
    cols = _pick(header)
    if "lat" not in cols or "lon" not in cols:
        return {}, header

    idx = {k: header.index(v) for k, v in cols.items()}
    tracks = {}
    for row in body:
        if len(row) < len(header):
            continue
        try:
            lat = float(row[idx["lat"]])
            lon = float(row[idx["lon"]])
        except (ValueError, KeyError):
            continue
        if not (-90 <= lat <= 90):
            continue
        # Longitudes arrive either way round depending on the file, and a map
        # wants one of them.
        if lon > 180:
            lon -= 360

        storm = (row[idx["storm"]] or "unknown") if "storm" in idx else "unknown"
        member = row[idx["member"]] if "member" in idx else "mean"
        # sample arrives as "3" or "3.0" depending on the writer; both are
        # member three, and two spellings of one member is two half tangles.
        try:
            member = str(int(float(member)))
        except (TypeError, ValueError):
            pass
        tid = row[idx["tid"]] if "tid" in idx else "0"
        key = f"{storm}|{member}|{tid}"

        pt = {"lat": round(lat, 3), "lon": round(lon, 3)}
        for extra in ("time", "lead", "wind", "mslp"):
            if extra in idx and row[idx[extra]] not in ("", "NaN"):
                v = row[idx[extra]]
                try:
                    pt[extra] = round(float(v), 1)
                except ValueError:
                    pt[extra] = v
        # Strictly 6-hourly out to the observed maximum; anything else in the
        # lead column is a malformed row, not a finer forecast.
        if "lead" in pt and isinstance(pt["lead"], float):
            if pt["lead"] < 0 or pt["lead"] > MAX_LEAD_H or pt["lead"] % STEP_H:
                continue
        tracks.setdefault(key, []).append(pt)

    # A track is a line, so its points have to be in order along it. A single
    # point is a storm that existed for one frame, which draws as nothing.
    for k in list(tracks):
        pts = tracks[k]
        if pts and "lead" in pts[0]:
            pts.sort(key=lambda p: p.get("lead", 0))
        if len(pts) < 2:
            del tracks[k]
    return tracks, header


# ── Genesis probability ─────────────────────────────────────────────────────

def _read_netcdf(raw):
    """
    The probability grid out of a base64'd, gzipped NetCDF.

    Three wrappers deep, and each one is there for a reason on their side and
    is simply in the way on ours: base64 so it survives a text transport, gzip
    because a probability field is mostly zeroes, NetCDF because that is what
    the science world writes.

    Read with h5py rather than the netCDF4 package: NetCDF4 is HDF5 underneath,
    h5py is packaged for the Pi where netCDF4 wants building, and all that is
    needed here is one array and its two coordinates.
    """
    try:
        import h5py
    except ImportError:
        raise RuntimeError(
            "The genesis fields are NetCDF. On the Pi:\n"
            "    sudo apt install -y python3-h5py")

    data = gzip.decompress(base64.b64decode(raw))
    f = h5py.File(io.BytesIO(data), "r")

    def find(*names):
        for n in names:
            for k in f:
                if k.lower() == n:
                    return np.asarray(f[k])
        return None

    lat = find("lat", "latitude")
    lon = find("lon", "longitude")
    # The probability is whichever variable is two dimensional and is not a
    # coordinate, which avoids having to know what they called it.
    grid = None
    for k in f:
        a = f[k]
        if getattr(a, "ndim", 0) >= 2 and k.lower() not in (
                "lat", "latitude", "lon", "longitude"):
            grid = np.asarray(a)
            break
    if grid is None or lat is None or lon is None:
        return None
    while grid.ndim > 2:
        grid = grid[0]          # a leading time or member axis
    return grid.astype(np.float32), lat.astype(np.float32), lon.astype(np.float32)


def render_genesis(grid, lat, lon, out_path):
    """The probability field as a PNG, on the mesh everything else uses."""
    if lat.ndim == 1 and lon.ndim == 1:
        lon2, lat2 = np.meshgrid(lon, lat)
    else:
        lat2, lon2 = lat, lon
    lons = np.where(lon2 < 0, lon2 + 360.0, lon2)
    box = {"bottomlat": float(np.nanmin(lat2)), "toplat": float(np.nanmax(lat2)),
           "leftlon": float(np.nanmin(lons)), "rightlon": float(np.nanmax(lons))}
    got = regrid_to_latlon(grid.ravel(), lat2.ravel().astype(np.float32),
                           lons.ravel().astype(np.float32), box)
    if got is None:
        return None
    arr, lats, lo = got

    # Probabilities arrive as a fraction or a percentage depending on the file,
    # so the scale is taken from the data rather than assumed.
    hi = float(np.nanmax(arr)) if np.isfinite(arr).any() else 1.0
    scale = 100.0 if hi <= 1.5 else 1.0
    pct = np.clip(arr * scale, 0, 100)

    idx = (pct / 100.0 * 255).astype(np.uint8)
    rgb = LUTS["heat"][idx]
    alpha = np.full(idx.shape, 200, dtype=np.uint8)
    alpha[~np.isfinite(arr)] = 0
    # Below about two percent is not a forecast of anything, and painting it
    # covers the ocean in a wash that means nothing.
    alpha[idx < 6] = 0
    Image.fromarray(np.dstack([rgb, alpha]), mode="RGBA").save(
        out_path, optimize=True)
    return bounds_from(lats, lo)


# ── Building ────────────────────────────────────────────────────────────────

def build(models, stamp, run_dir):
    man = {"run": stamp, "tracks": {}, "genesis": {},
           "built_at": datetime.now(timezone.utc).isoformat()}

    for model in models:
        raw = get(track_url(model, stamp), timeout=240)
        if not raw:
            continue
        tracks, hdr = parse_tracks(raw)
        if not tracks:
            if hdr:
                log(f"{model}: parsed nothing; columns were "
                    + ", ".join(hdr[:10]))
            continue
        name = f"{model}_members"
        write_json(os.path.join(run_dir, f"tracks_{name}.json"),
                   {"variant": model, "kind": "members", "run": stamp,
                    "label": MODEL_LABELS.get(model, model),
                    "tracks": tracks})
        man["tracks"][name] = {
            "variant": model, "kind": "members",
            "label": MODEL_LABELS.get(model, model),
            "path": f"tracks_{name}.json",
            "storms": len({k.split("|")[0] for k in tracks}),
            "members": len({k.split("|")[1] for k in tracks}),
            "lines": len(tracks),
        }
        log(f"{name}: {len(tracks)} lines, "
            f"{man['tracks'][name]['members']} members")

        # The probability grids, on the unverified path: two cheap requests,
        # and if Google ever exposes them here the wash lights up by itself.
        for field in ("cumulative_probability_fields",
                      "instantaneous_probability_fields"):
            raw = get(genesis_url(model, stamp, field), timeout=180)
            if not raw:
                continue
            try:
                got = _read_netcdf(raw)
            except RuntimeError as e:
                log(str(e))
                break
            except Exception as e:
                log(f"{field}: {e}")
                continue
            if not got:
                continue
            short = "cumulative" if "cumulative" in field else "instantaneous"
            b = render_genesis(*got, os.path.join(run_dir, f"{short}.png"))
            if b:
                man["genesis"][short] = {"png": f"{short}.png", "bounds": b,
                                         "unit": "%"}
                log(f"genesis {short}: rendered")

    return man


def prune():
    if not os.path.isdir(OUT_DIR):
        return
    import shutil
    runs = sorted(d for d in os.listdir(OUT_DIR)
                  if os.path.isdir(os.path.join(OUT_DIR, d)))
    for old in runs[:-KEEP_RUNS] if len(runs) > KEEP_RUNS else []:
        shutil.rmtree(os.path.join(OUT_DIR, old), ignore_errors=True)


def check(models):
    """What is published for the recent cycles, downloading whole files only
    when they exist. Prints the header whenever parsing finds nothing, which
    is the fastest way to notice Google renamed a column."""
    ok = False
    for back in range(0, CYCLES_BACK):
        stamp = run_stamp(cycle_for(back=back))
        print(f"\nrun {stamp}")
        for model in models:
            raw = get(track_url(model, stamp), timeout=240)
            if not raw:
                print(f"  {model:6} not there")
                continue
            ok = True
            tracks, hdr = parse_tracks(raw)
            members = len({k.split('|')[1] for k in tracks}) if tracks else 0
            print(f"  {model:6} {len(raw)//1024:5d} KB, {len(tracks)} lines, "
                  f"{members} members")
            if hdr and not tracks:
                print(f"      columns: {', '.join(hdr[:12])}")
                print("      none of those look like lat and lon, so "
                      "TRACK_COLUMNS needs one adding")
        if ok:
            break
    try:
        import h5py                                     # noqa: F401
        print("\n  h5py is installed, so the genesis grids can be read")
    except ImportError:
        print("\n  h5py missing: sudo apt install -y python3-h5py")
    return 0 if ok else 1


def main(argv):
    models = [a for a in argv if not a.startswith("-")] or MODELS
    if "--check" in argv:
        return check(models)

    os.makedirs(OUT_DIR, exist_ok=True)
    t0 = time.time()

    # A cycle that has not disseminated yet is not an error, and one that
    # arrived late should still be picked up, so recent cycles are walked
    # newest first until one builds.
    for back in range(0, CYCLES_BACK):
        stamp = run_stamp(cycle_for(back=back))
        run_dir = os.path.join(OUT_DIR, stamp)
        if os.path.exists(os.path.join(run_dir, "manifest.json")):
            log(f"{stamp} already built")
            return 0
        os.makedirs(run_dir, exist_ok=True)
        man = build(models, stamp, run_dir)
        if man["tracks"] or man["genesis"]:
            write_json(os.path.join(run_dir, "manifest.json"), man)
            write_json(os.path.join(OUT_DIR, "latest.json"), {
                "run": stamp, "path": f"{stamp}/manifest.json",
                "updated": datetime.now(timezone.utc).isoformat(),
            })
            prune()
            log(f"{stamp}: {len(man['tracks'])} track sets, "
                f"{len(man['genesis'])} genesis in {time.time() - t0:.0f}s")
            return 0
        os.rmdir(run_dir) if not os.listdir(run_dir) else None

    log("nothing published for the last few runs")
    return 1


if __name__ == "__main__":
    with Lock(os.path.expanduser("~/.gwcfc-cyclones.lock")):
        sys.exit(main(sys.argv[1:]))
