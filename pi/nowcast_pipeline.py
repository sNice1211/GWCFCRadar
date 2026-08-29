#!/usr/bin/env python3
"""
Extrapolates the last few minutes of radar into a 0-2 hour nowcast.

radar_pipeline.py already fetches MRMS's national composite reflectivity
every five minutes and, since the raw-retention hook was added to
build_mrms(), also keeps the last few scans of it as real dBZ rather than
only as a colour (composite_raw.png, beside composite.png in each scan
folder). This reads three of those, works out which way the echoes are
moving with pysteps, and pushes the most recent frame forward along that
motion to produce a picture of where things will probably be.

    python3 pi/nowcast_pipeline.py            # build once
    python3 pi/nowcast_pipeline.py --check    # what is available, no work

Output lands in ~/wxdata/radar/nowcast/ and is served by the same serve.py
as everything else, so nothing else has to change.

Kept as its own script rather than folded into radar_pipeline.py's build_mrms
pass: that pass has its own budget (MRMS_PASS_SECS/MRMS_PASS_MAX) shared
across seventy-odd products, and a slow pysteps run has no business eating
into it. It also means pysteps and opencv, both sizeable, stay a dependency
of the one file that uses them rather than of the whole radar pipeline, the
same way netCDF4 is confined to satellite_pipeline.py.
"""

import os
import sys
import time
import warnings
from datetime import datetime, timedelta, timezone

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gfs_pipeline import MAX_EDGE_PX, Lock, band_alpha, disk_ok, free_mb, \
    log, lut_for, read_data_png, write_json  # noqa: E402
from radar_pipeline import MRMS_PRODUCTS  # noqa: E402

OUT_DIR = os.path.expanduser("~/wxdata/radar")
MRMS_DIR = os.path.join(OUT_DIR, "mrms")
NOWCAST_DIR = os.path.join(OUT_DIR, "nowcast")

# The field this extrapolates. Imported from MRMS_PRODUCTS rather than
# repeated here, so the nowcast frames are colour-identical to the composite
# reflectivity frames they extend: same range, same ramp, same floor. If that
# product's range or ramp is ever tuned, this follows it without a second
# edit sitting somewhere else to forget about.
FIELD = "composite"

# How many recent scans to base a motion estimate on. pysteps' own reference
# usage for Lucas-Kanade motion works from the last three frames; composite
# refreshes on a five-minute cadence (MRMS_PRODUCTS["composite"]["every"]),
# so three frames is ten minutes of lookback, comfortably inside what a scan
# folder still holds by the time this runs.
LOOKBACK_FRAMES = 3

# pysteps.nowcasts.extrapolation.forecast's `timesteps`, given as a plain
# int, steps forward at the *velocity field's own* timestep, which is
# whatever "accutime" is set to - not an independent unit of its own. Passed
# as 5-minute steps here (composite's own fetch cadence) and then thinned
# below to the spacing actually wanted, rather than trusted to mean minutes.
NATIVE_STEP_MIN = float(MRMS_PRODUCTS[FIELD].get("every", 5))

# Every ten minutes out to two hours. Finer than that is false precision for
# pure extrapolation: skill falls off quickly past about an hour, so a
# five-minute step here would just be more frames of the same fading signal.
STEP_MINUTES = int(os.environ.get("GWCFC_NOWCAST_STEP_MIN", "10"))
LEAD_MINUTES = int(os.environ.get("GWCFC_NOWCAST_LEAD_MIN", "120"))

# A base frame older than this is not worth extrapolating from: the picture
# it would produce is already stale before the first forecast minute.
MAX_BASE_AGE_MIN = float(os.environ.get("GWCFC_NOWCAST_MAX_AGE_MIN", "15"))

KEEP_HOURS = float(os.environ.get("GWCFC_NOWCAST_KEEP_HOURS", "6"))
MAX_RUNS = int(os.environ.get("GWCFC_NOWCAST_MAX_RUNS", "24"))

# composite_raw.png is kept at full MRMS resolution (7000x3500, 24.5M points
# nationwide - see build_mrms's comment on why). pysteps' motion estimate and
# semi-Lagrangian extrapolation each hold several arrays that size for every
# lead time, and running that on the full national grid measured out at
# 15GB+ before the kernel OOM-killed it. Shrinking first, the way every
# other MRMS product's display PNG already does, is the fix - just with a
# mean rather than a max, since a block max would bias the motion estimate
# toward overestimating intensity and persistence at every step it was ever
# downsampled at (the exact reason composite kept a full-res copy to begin
# with; a block *mean* has no such bias, it only costs sharpness).
# Reuses gfs_pipeline's own display-image ceiling as the default rather than
# inventing a second number that could drift from it.
NOWCAST_MAX_EDGE_PX = int(os.environ.get("GWCFC_NOWCAST_MAX_EDGE_PX", str(MAX_EDGE_PX)))


def _downsample_mean(arr, factor):
    """NaN-aware block-mean downsample by an integer factor. Trims any
    leftover rows/cols that don't fill a whole block, same as build_mrms's
    block-max halving does."""
    if factor <= 1:
        return arr
    nj, ni = arr.shape
    nj, ni = nj - nj % factor, ni - ni % factor
    blocks = arr[:nj, :ni].reshape(nj // factor, factor, ni // factor, factor)
    with warnings.catch_warnings():
        # An all-NaN block (out of radar coverage) warns on every mean;
        # ordinary and expected for a national grid's edges and gaps.
        warnings.simplefilter("ignore", RuntimeWarning)
        return np.nanmean(blocks, axis=(1, 3))


def _scan_dirs():
    """Every MRMS scan folder that has a raw composite frame, oldest first."""
    if not os.path.isdir(MRMS_DIR):
        return []
    out = []
    for d in sorted(os.listdir(MRMS_DIR)):
        if not d[:1].isdigit():
            continue
        p = os.path.join(MRMS_DIR, d, "composite_raw.png")
        if os.path.exists(p):
            out.append((d, p))
    return out


def _latest_raw_frames(n=LOOKBACK_FRAMES):
    """The n newest raw composite frames, oldest first, as (stamp, values),
    downsampled to NOWCAST_MAX_EDGE_PX on the long edge if the source is
    bigger - see NOWCAST_MAX_EDGE_PX above for why."""
    dirs = _scan_dirs()[-n:]
    lo, hi = MRMS_PRODUCTS[FIELD]["range"]
    frames = []
    factor = None
    for stamp, path in dirs:
        q, has = read_data_png(path)
        vals = lo + q / 65535.0 * (hi - lo)
        vals[~has] = np.nan
        if factor is None:
            factor = max(1, -(-max(vals.shape) // NOWCAST_MAX_EDGE_PX))  # ceil div
            if factor > 1:
                log(f"nowcast: downsampling {vals.shape[1]}x{vals.shape[0]} "
                    f"by {factor}x to stay under {NOWCAST_MAX_EDGE_PX}px")
        vals = _downsample_mean(vals, factor)
        frames.append((stamp, vals))
    return frames


def _bounds_for(stamp):
    """The lat/lon box of a scan, read from the display product's own manifest
    entry rather than recomputed, so nowcast frames line up with the observed
    ones exactly."""
    try:
        man = read_manifest()
        b = ((man.get("products") or {}).get(FIELD) or {}).get("bounds")
        if b:
            return b
    except Exception:
        pass
    return None


def read_manifest():
    import json
    with open(os.path.join(MRMS_DIR, "mrms.json")) as fh:
        return json.load(fh)


def _motion_and_extrapolate(frames, n_native_steps):
    """
    The pysteps call sequence: dBZ -> rain rate -> dB(rain rate), Lucas-Kanade
    motion off the last three frames, semi-Lagrangian extrapolation forward
    n_native_steps steps of NATIVE_STEP_MIN each, then back to rain rate.
    Returns (n_native_steps, m, n) float32 mm/h, one frame per native step -
    the caller thins this to the spacing actually wanted to display.

    Kept as one function so the unit conversions and the unit *reversions*
    stay next to each other: pysteps' motion and extrapolation both expect a
    dB-transformed rain rate, not the raw dBZ this pipeline stores everywhere
    else, and getting the forward and inverse transforms out of sync would
    silently wreck the forecast without ever raising an error.
    """
    from pysteps import motion, nowcasts
    from pysteps.utils import conversion, transformation

    lo, hi = MRMS_PRODUCTS[FIELD]["range"]
    floor = MRMS_PRODUCTS[FIELD].get("floor", lo)
    R = np.stack([f for _, f in frames]).astype(np.float64)
    metadata = {
        "unit": "dBZ", "transform": None, "accutime": NATIVE_STEP_MIN,
        "threshold": floor, "zerovalue": lo,
        "zr_a": 200.0, "zr_b": 1.6,
    }
    R, metadata = conversion.to_rainrate(R, metadata)
    R, metadata = transformation.dB_transform(
        R, metadata, threshold=0.1, zerovalue=-15.0)
    R[~np.isfinite(R)] = metadata["zerovalue"]

    oflow = motion.get_method("LK")
    V = oflow(R)

    extrapolate = nowcasts.get_method("extrapolation")
    # An int here steps forward at the velocity field's own timestep
    # (accutime, set above to NATIVE_STEP_MIN) - not an independently
    # chosen unit, which is why the caller thins the result afterward
    # instead of asking for STEP_MINUTES-sized steps directly.
    R_f = extrapolate(R[-1], V, n_native_steps,
                       extrap_method="semilagrangian")

    R_f, _ = transformation.dB_transform(
        R_f, threshold=-10.0, zerovalue=-15.0, inverse=True)
    return R_f.astype(np.float32)


def _rainrate_to_dbz(mmh):
    """The inverse of pysteps' Marshall-Palmer Z-R, back to what the rest of
    this pipeline's colour ramp and range are written in terms of."""
    a, b = 200.0, 1.6
    with np.errstate(all="ignore"):
        z = a * np.power(np.maximum(mmh, 0.0), b)
        dbz = 10.0 * np.log10(np.maximum(z, 1e-6))
    dbz[mmh <= 0] = MRMS_PRODUCTS[FIELD]["range"][0]
    return dbz


def _render(dbz, out_path):
    lo, hi = MRMS_PRODUCTS[FIELD]["range"]
    ramp = MRMS_PRODUCTS[FIELD]["ramp"]
    norm = (dbz - lo) / float(hi - lo)
    idx = np.clip(np.nan_to_num(norm) * 255.0, 0, 255).astype(np.uint8)
    rgb = lut_for(ramp, lo, hi)[idx]
    alpha = np.where(np.isfinite(dbz), 205, 0).astype(np.uint8)
    band_alpha(ramp, idx, alpha, lo, hi)
    Image.fromarray(np.dstack([rgb, alpha]), mode="RGBA").save(
        out_path, optimize=True)


def _prune(hours=None):
    import shutil
    if not os.path.isdir(NOWCAST_DIR):
        return
    hours = KEEP_HOURS if hours is None else hours
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    dirs = []
    for d in sorted(os.listdir(NOWCAST_DIR)):
        full = os.path.join(NOWCAST_DIR, d)
        if not (os.path.isdir(full) and d[:1].isdigit()):
            continue
        try:
            when = datetime.strptime(d, "%Y%m%d_%H%M%S").replace(
                tzinfo=timezone.utc)
        except ValueError:
            continue
        if when < cutoff:
            shutil.rmtree(full, ignore_errors=True)
        else:
            dirs.append(full)
    if len(dirs) > MAX_RUNS:
        for full in dirs[:len(dirs) - MAX_RUNS]:
            shutil.rmtree(full, ignore_errors=True)


def build_nowcast():
    frames = _latest_raw_frames()
    if len(frames) < LOOKBACK_FRAMES:
        log(f"nowcast: only {len(frames)} raw composite frame(s) on disk, "
            f"need {LOOKBACK_FRAMES}; nothing to build yet")
        return 1

    base_stamp = frames[-1][0]
    base_time = datetime.strptime(base_stamp, "%Y%m%d_%H%M%S").replace(
        tzinfo=timezone.utc)
    age_min = (datetime.now(timezone.utc) - base_time).total_seconds() / 60.0
    if age_min > MAX_BASE_AGE_MIN:
        log(f"nowcast: newest raw composite is {age_min:.0f} min old, "
            f"older than {MAX_BASE_AGE_MIN:.0f}; skipping a stale forecast")
        return 1

    bounds = _bounds_for(base_stamp)
    if not bounds:
        log("nowcast: no bounds in mrms.json for the composite product; "
            "skipping")
        return 1

    # STEP_MINUTES has to land on a whole multiple of the native cadence -
    # extrapolation only ever steps in units of it - so the actual spacing
    # used is the nearest multiple, not necessarily the env var verbatim.
    stride = max(1, round(STEP_MINUTES / NATIVE_STEP_MIN))
    actual_step_min = stride * NATIVE_STEP_MIN
    n_native = max(stride, round(LEAD_MINUTES / NATIVE_STEP_MIN))

    t0 = time.time()
    try:
        R_f = _motion_and_extrapolate(frames, n_native)
    except Exception as e:
        log(f"nowcast: motion/extrapolation failed: {e}")
        return 1

    os.makedirs(NOWCAST_DIR, exist_ok=True)
    if not disk_ok(NOWCAST_DIR):
        log(f"nowcast: only {free_mb(NOWCAST_DIR):.0f} MB free, skipping "
            "this run")
        return 1

    fout = os.path.join(NOWCAST_DIR, base_stamp)
    os.makedirs(fout, exist_ok=True)
    entries = []
    for i in range(stride - 1, R_f.shape[0], stride):
        lead_min = int(round((i + 1) * NATIVE_STEP_MIN))
        dbz = _rainrate_to_dbz(R_f[i])
        fname = f"lead_{lead_min:03d}.png"
        _render(dbz, os.path.join(fout, fname))
        valid = base_time + timedelta(minutes=lead_min)
        entries.append({"lead_min": lead_min, "valid": valid.isoformat(),
                         "file": f"{base_stamp}/{fname}"})

    lo, hi = MRMS_PRODUCTS[FIELD]["range"]
    man = {
        "updated": datetime.now(timezone.utc).isoformat(),
        "base": {"t": base_stamp, "source": f"mrms/{base_stamp}/composite.png"},
        "unit": MRMS_PRODUCTS[FIELD]["unit"], "min": lo, "max": hi,
        "ramp": MRMS_PRODUCTS[FIELD]["ramp"], "bounds": bounds,
        "step_minutes": actual_step_min, "method": "pysteps-LK-extrapolation",
        "frames": entries,
    }
    write_json(os.path.join(NOWCAST_DIR, "nowcast.json"), man)
    _prune()
    log(f"nowcast: {len(entries)} lead times from {base_stamp} in "
        f"{time.time() - t0:.0f}s")
    return 0


def check():
    """What is available, without downloading or running anything."""
    frames = _scan_dirs()
    print(f"raw composite frames on disk: {len(frames)}")
    if frames:
        newest = frames[-1][0]
        when = datetime.strptime(newest, "%Y%m%d_%H%M%S").replace(
            tzinfo=timezone.utc)
        age = (datetime.now(timezone.utc) - when).total_seconds() / 60.0
        print(f"  newest: {newest}  ({age:.0f} min old)")
        if age > MAX_BASE_AGE_MIN:
            print(f"  older than the {MAX_BASE_AGE_MIN:.0f} min freshness "
                  "cutoff; a run right now would skip rather than build")
    else:
        print("  none yet; build_mrms() has not run with the raw-retention "
              "hook, or no scans have landed")
    ok = True
    try:
        import cv2  # noqa
        print("  opencv is installed")
    except ImportError as e:
        print(f"  opencv missing: {e}")
        ok = False
    try:
        import pysteps  # noqa
        print("  pysteps is installed")
    except ImportError as e:
        print(f"  pysteps missing: {e}")
        ok = False
    return 0 if ok else 1


def main(argv):
    if "--check" in argv:
        return check()
    return build_nowcast()


if __name__ == "__main__":
    if "--check" in sys.argv:
        sys.exit(main(sys.argv[1:]))
    with Lock(os.path.expanduser("~/.gwcfc-nowcast.lock")):
        sys.exit(main(sys.argv[1:]))
