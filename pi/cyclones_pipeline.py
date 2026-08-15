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

# Which variants to fetch. The large ensemble is last because it is the only
# one with genesis fields and therefore the slow one.
VARIANTS = ["OPER", "FNV3P0", "FNV3P1", "FNV3P2", "FNV3_LARGE_ENSEMBLE"]

# Runs at 00 and 12. Published a few hours later, like everything else.
CYCLE_H = 12
LAG_H = 4

KEEP_RUNS = 4


def run_stamp(dt):
    """The way WeatherLab spells a run in a URL: 2026_08_15T12_00."""
    return f"{dt.year:04d}_{dt.month:02d}_{dt.day:02d}T{dt.hour:02d}_00"


def cycle_for(now=None):
    now = now or datetime.now(timezone.utc)
    t = now - timedelta(hours=LAG_H)
    return t.replace(hour=(t.hour // CYCLE_H) * CYCLE_H,
                     minute=0, second=0, microsecond=0)


def track_url(variant, stamp, ensemble="ensemble_mean"):
    return (f"{BASE}/{variant}/{ensemble}/paired/csv/"
            f"{variant}_{stamp}_paired.csv")


def genesis_url(variant, stamp, kind="csv", field=None):
    if kind == "csv":
        return (f"{BASE}/{variant}/ensemble/cyclogenesis/csv/"
                f"{variant}_{stamp}_cyclogenesis.csv")
    return (f"{BASE}/{variant}/ensemble/cyclogenesis/netcdf/{field}/"
            f"{variant}_{stamp}_{field}.nc.gz.base64")


def get(url, timeout=120):
    try:
        r = HTTP.get(url, timeout=timeout)
        if r.status_code != 200 or len(r.content) < 40:
            return None
        return r.content
    except Exception:
        return None


# ── Tracks ──────────────────────────────────────────────────────────────────

# The column names are not known here and are not worth guessing at, so each
# wanted value lists the spellings it might arrive under and the first that is
# present wins. A file with none of them still parses, and --check prints the
# header so a missing one can be added rather than hunted.
TRACK_COLUMNS = {
    "lat":    ("lat", "latitude", "lat_deg"),
    "lon":    ("lon", "longitude", "lon_deg"),
    "time":   ("time", "valid_time", "timestamp", "datetime", "valid"),
    "lead":   ("lead_time", "lead", "fhr", "forecast_hour", "step"),
    "wind":   ("wind_speed", "max_wind", "vmax", "wind", "intensity"),
    "mslp":   ("mslp", "min_pressure", "pressure", "pmin"),
    "member": ("member", "ensemble_member", "realization", "number"),
    "storm":  ("storm_id", "storm", "cyclone_id", "id", "name"),
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
    A paired CSV as points grouped by storm and member.

    "Paired" means the model's storms have been matched to the real ones, so a
    row knows which actual cyclone it is a forecast of. That is what makes
    these drawable next to the Hurricane Center's own track rather than as a
    separate unlabelled tangle.
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

        storm = row[idx["storm"]] if "storm" in idx else "unknown"
        member = row[idx["member"]] if "member" in idx else "mean"
        key = f"{storm}|{member}"

        pt = {"lat": round(lat, 3), "lon": round(lon, 3)}
        for extra in ("time", "lead", "wind", "mslp"):
            if extra in idx and row[idx[extra]] not in ("", "NaN"):
                v = row[idx[extra]]
                try:
                    pt[extra] = round(float(v), 1)
                except ValueError:
                    pt[extra] = v
        tracks.setdefault(key, []).append(pt)

    # A track is a line, so its points have to be in order along it.
    for pts in tracks.values():
        if pts and "lead" in pts[0]:
            pts.sort(key=lambda p: p.get("lead", 0))
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

def build(variants, stamp, run_dir):
    man = {"run": stamp, "tracks": {}, "genesis": {},
           "built_at": datetime.now(timezone.utc).isoformat()}

    for variant in variants:
        for ens in ("ensemble_mean", "ensemble"):
            raw = get(track_url(variant, stamp, ens))
            if not raw:
                continue
            tracks, _hdr = parse_tracks(raw)
            if not tracks:
                continue
            name = f"{variant}_{ens}"
            write_json(os.path.join(run_dir, f"tracks_{name}.json"),
                       {"variant": variant, "kind": ens, "run": stamp,
                        "tracks": tracks})
            man["tracks"][name] = {
                "variant": variant, "kind": ens,
                "path": f"tracks_{name}.json",
                "storms": len({k.split("|")[0] for k in tracks}),
                "lines": len(tracks),
            }
            log(f"{name}: {len(tracks)} lines")

        if "LARGE_ENSEMBLE" not in variant:
            continue

        # Genesis, which only the large ensemble publishes.
        raw = get(genesis_url(variant, stamp, "csv"))
        if raw:
            write_json(os.path.join(run_dir, "cyclogenesis.json"),
                       {"run": stamp,
                        "rows": raw.decode("utf-8", errors="ignore")
                        .splitlines()[:2000]})
            man["genesis"]["csv"] = "cyclogenesis.json"

        for field in ("cumulative_probability_fields",
                      "instantaneous_probability_fields"):
            raw = get(genesis_url(variant, stamp, "nc", field), timeout=180)
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


def check(variants):
    """What is published for the newest run or two, downloading nothing big."""
    now = datetime.now(timezone.utc)
    ok = False
    for back in range(0, 3):
        run = cycle_for(now - timedelta(hours=back * CYCLE_H))
        stamp = run_stamp(run)
        print(f"\nrun {stamp}")
        for variant in variants:
            url = track_url(variant, stamp)
            raw = get(url)
            if not raw:
                print(f"  {variant:22} not there")
                continue
            ok = True
            tracks, hdr = parse_tracks(raw)
            print(f"  {variant:22} {len(raw)//1024:4d} KB, "
                  f"{len(tracks)} lines")
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
    variants = [a for a in argv if not a.startswith("-")] or VARIANTS
    if "--check" in argv:
        return check(variants)

    now = datetime.now(timezone.utc)
    os.makedirs(OUT_DIR, exist_ok=True)
    t0 = time.time()

    # A run that is not published yet is not an error, so a couple of cycles
    # back are tried before giving up.
    for back in range(0, 3):
        stamp = run_stamp(cycle_for(now - timedelta(hours=back * CYCLE_H)))
        run_dir = os.path.join(OUT_DIR, stamp)
        if os.path.exists(os.path.join(run_dir, "manifest.json")):
            log(f"{stamp} already built")
            return 0
        os.makedirs(run_dir, exist_ok=True)
        man = build(variants, stamp, run_dir)
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
