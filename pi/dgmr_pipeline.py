#!/usr/bin/env python3
"""
Storm Spotlight: a learned, GPU-accelerated nowcast for whichever storm is
currently strongest anywhere in the US, using DeepMind's DGMR model (see
Ravuri et al., Nature 2021) via the pysteps-dgmr-nowcasts plugin.

This is a different kind of product from pi/nowcast_pipeline.py's national
extrapolation nowcast, not a replacement for it: DGMR only ever sees one
fixed 256x256 pixel window (roughly 2.5 degrees square, about 250km), so it
cannot cover the whole country the way plain pysteps extrapolation does. What
it can do instead is a sharper, learned prediction for one storm at a time -
this pipeline always points it at whichever storm is currently most intense
nationally, so there is always something worth looking at.

Runs on its own machine (a GPU is not optional here - see the timing note
below), independently of the Pi: it fetches its own MRMS composite frames
straight from NOAA rather than depending on the Pi having built them first,
so the only thing this machine needs from the rest of the deployment is
outbound internet. Its own local input archive lives under
~/wxdata/radar/dgmr_input/ and never needs to leave this machine; only the
finished forecast under ~/wxdata/radar/dgmr/ needs to reach the page, and
_publish() below is how - see its docstring for what that assumes.

    python3 pi/dgmr_pipeline.py            # fetch one frame, build if ready
    python3 pi/dgmr_pipeline.py --check    # what is available, no work
"""

import json
import os
import shutil
import sys
import time
from datetime import datetime, timedelta, timezone

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gfs_pipeline import (Lock, band_alpha, disk_ok, free_mb, log, lut_for,
                          read_data_png, render_data_png,
                          write_json)  # noqa: E402
from radar_pipeline import MRMS_BASE, MRMS_PRODUCTS, _mrms_read  # noqa: E402

FIELD = "composite"
SPEC = MRMS_PRODUCTS[FIELD]
LO, HI = SPEC["range"]
URL = f"{MRMS_BASE}/{SPEC['path']}/MRMS_{SPEC['path']}.latest.grib2.gz"

OUT_DIR = os.path.expanduser("~/wxdata/radar")
RAW_DIR = os.path.join(OUT_DIR, "dgmr_input")   # this machine's own archive
PUBLISH_DIR = os.path.join(OUT_DIR, "dgmr")     # what actually ships to the page

DGMR_SIZE = 256
NUM_INPUT_FRAMES = 4
# DGMR's own native cadence from training (Ravuri et al.): 5 minutes. Not
# configurable - it is baked into what the model learned, unlike
# nowcast_pipeline.py's STEP_MINUTES/LEAD_MINUTES.
NATIVE_STEP_MIN = 5
NUM_OUTPUT_FRAMES = 18  # -> 90 minutes, fixed by the model

# A frame older than this is not worth building from - see
# nowcast_pipeline.py's MAX_BASE_AGE_MIN for the same reasoning.
MAX_BASE_AGE_MIN = float(os.environ.get("GWCFC_DGMR_MAX_AGE_MIN", "15"))
# Only need the last few frames; unlike the Pi's multi-day radar archive
# this exists purely to feed DGMR, so it is pruned hard.
KEEP_RAW_HOURS = float(os.environ.get("GWCFC_DGMR_KEEP_RAW_HOURS", "1"))
KEEP_HOURS = float(os.environ.get("GWCFC_DGMR_KEEP_HOURS", "6"))
MAX_RUNS = int(os.environ.get("GWCFC_DGMR_MAX_RUNS", "24"))

# How wide a window DGMR gets around the storm it is centered on. 256px at
# MRMS's 0.01 degree pixels is ~2.56 degrees; half of that either side of
# the peak.
CROP_HALF_PX = DGMR_SIZE // 2


def _scan_raw_dirs():
    """Every raw input frame this machine has fetched, oldest first."""
    if not os.path.isdir(RAW_DIR):
        return []
    out = []
    for d in sorted(os.listdir(RAW_DIR)):
        if not d[:1].isdigit():
            continue
        p = os.path.join(RAW_DIR, d, "composite_raw.png")
        if os.path.exists(p):
            out.append((d, p))
    return out


def _prune_raw():
    cutoff = datetime.now(timezone.utc) - timedelta(hours=KEEP_RAW_HOURS)
    for d, _ in _scan_raw_dirs():
        try:
            when = datetime.strptime(d, "%Y%m%d_%H%M%S").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if when < cutoff:
            shutil.rmtree(os.path.join(RAW_DIR, d), ignore_errors=True)


def fetch_one_frame():
    """Pull the current national composite from NOAA and save it, full
    resolution, into this machine's own small rolling archive."""
    if not disk_ok(RAW_DIR):
        log(f"dgmr: only {free_mb(RAW_DIR):.0f} MB free, skipping this fetch")
        return None
    got = _mrms_read(URL)
    if not got:
        log("dgmr: no grid came back from NOAA")
        return None
    arr, south, north, west, east = got
    arr[arr < 0] = np.nan
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    fout = os.path.join(RAW_DIR, stamp)
    os.makedirs(fout, exist_ok=True)
    render_data_png(arr, np.linspace(north, south, arr.shape[0]), LO, HI,
                     os.path.join(fout, "composite_raw.png"))
    write_json(os.path.join(fout, "bounds.json"),
               {"south": south, "north": north, "west": west, "east": east})
    log(f"dgmr: fetched {stamp}")
    return stamp


def _crop_box(arr, south, north, west, east):
    """Pixel bounds of a DGMR_SIZE window centered on the strongest echo,
    and its lat/lon box."""
    nj, ni = arr.shape
    px_lat = (north - south) / (nj - 1)
    px_lon = (east - west) / (ni - 1)

    floor = SPEC.get("floor", LO)
    candidates = np.where(np.isfinite(arr) & (arr >= floor))
    if len(candidates[0]):
        peak_idx = np.argmax(arr[candidates])
        r0, c0 = candidates[0][peak_idx], candidates[1][peak_idx]
    else:
        r0, c0 = nj // 2, ni // 2  # quiet nationwide: just center it

    r_lo = max(0, min(nj - DGMR_SIZE, r0 - CROP_HALF_PX))
    c_lo = max(0, min(ni - DGMR_SIZE, c0 - CROP_HALF_PX))
    r_hi, c_hi = r_lo + DGMR_SIZE, c_lo + DGMR_SIZE
    box_bounds = [[north - r_hi * px_lat, west + c_lo * px_lon],
                  [north - r_lo * px_lat, west + c_hi * px_lon]]
    return (r_lo, r_hi, c_lo, c_hi), box_bounds


def _render(dbz, out_path):
    idx = np.clip(np.nan_to_num((dbz - LO) / (HI - LO)) * 255.0, 0, 255).astype(np.uint8)
    rgb = lut_for(SPEC["ramp"], LO, HI)[idx]
    alpha = np.where(np.isfinite(dbz), 205, 0).astype(np.uint8)
    band_alpha(SPEC["ramp"], idx, alpha, LO, HI)
    Image.fromarray(np.dstack([rgb, alpha]), mode="RGBA").save(out_path, optimize=True)


def _prune_published():
    if not os.path.isdir(PUBLISH_DIR):
        return
    cutoff = datetime.now(timezone.utc) - timedelta(hours=KEEP_HOURS)
    dirs = []
    for d in sorted(os.listdir(PUBLISH_DIR)):
        full = os.path.join(PUBLISH_DIR, d)
        if not (os.path.isdir(full) and d[:1].isdigit()):
            continue
        try:
            when = datetime.strptime(d, "%Y%m%d_%H%M%S").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        (shutil.rmtree(full, ignore_errors=True) if when < cutoff else dirs.append(full))
    if len(dirs) > MAX_RUNS:
        for full in dirs[:len(dirs) - MAX_RUNS]:
            shutil.rmtree(full, ignore_errors=True)


def _publish():
    """Ship the finished output to wherever the page actually reads it from.

    This machine is not the Pi the page already knows how to find (see
    pi/publish_url.py): it has no tunnel and is not the address in
    piEndpoint/models. Standing up a second tunnel plus a second Firestore
    document plus a second address-resolve function in the page is real new
    surface (auth account, security rules, another systemd unit set) for a
    feature that is still experimental - the far smaller move is landing
    these files inside the Pi's own served tree, so the page finds them at
    <pi base>/radar/dgmr/ exactly the way it already finds
    <pi base>/radar/mrms/ and <pi base>/radar/nowcast/, no frontend or
    Firebase change required.

    That needs this machine to be able to reach the Pi directly (rsync over
    SSH, a key that can write into ~/wxdata/radar/dgmr/ on it, nothing more
    privileged than that). Configured via ~/.gwcfc_dgmr_publish.json,
    matching how every other secret/target in this project lives outside
    the repo:
        {"host": "pi@192.168.1.23", "path": "/home/pi/wxdata/radar/dgmr/"}
    Left unconfigured, this just logs where the output sits locally and
    does nothing else - safe to run without it while this is still being
    evaluated.
    """
    cfg_path = os.path.expanduser("~/.gwcfc_dgmr_publish.json")
    if not os.path.exists(cfg_path):
        log(f"dgmr: {cfg_path} not set up, output stays local at {PUBLISH_DIR}")
        return
    import subprocess
    try:
        with open(cfg_path) as fh:
            cfg = json.load(fh)
        host, path = cfg["host"], cfg["path"]
    except (OSError, ValueError, KeyError) as e:
        log(f"dgmr: {cfg_path} is malformed ({e}), output stays local")
        return
    try:
        subprocess.run(
            ["rsync", "-a", "--delete", f"{PUBLISH_DIR}/", f"{host}:{path}"],
            check=True, timeout=120, capture_output=True, text=True)
        log(f"dgmr: published to {host}:{path}")
    except FileNotFoundError:
        log("dgmr: rsync is not installed on this machine")
    except subprocess.CalledProcessError as e:
        log(f"dgmr: rsync failed: {e.stderr.strip()[:300]}")
    except subprocess.TimeoutExpired:
        log("dgmr: rsync timed out")


def build():
    dirs = _scan_raw_dirs()
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=MAX_BASE_AGE_MIN)
    fresh = []
    for d, p in dirs:
        try:
            when = datetime.strptime(d, "%Y%m%d_%H%M%S").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if when >= cutoff:
            fresh.append((d, p, when))
    if len(fresh) < NUM_INPUT_FRAMES:
        log(f"dgmr: only {len(fresh)} fresh raw frame(s) on disk, "
            f"need {NUM_INPUT_FRAMES}; nothing to build yet")
        return 1
    fresh = fresh[-NUM_INPUT_FRAMES:]
    base_stamp, _, base_time = fresh[-1]

    raw_frames = []
    for d, p, _ in fresh:
        q, has = read_data_png(p)
        vals = LO + q / 65535.0 * (HI - LO)
        vals[~has] = np.nan
        raw_frames.append(vals)
    with open(os.path.join(RAW_DIR, base_stamp, "bounds.json")) as fh:
        b = json.load(fh)

    (r_lo, r_hi, c_lo, c_hi), box_bounds = _crop_box(
        raw_frames[-1], b["south"], b["north"], b["west"], b["east"])
    cropped = [f[r_lo:r_hi, c_lo:c_hi] for f in raw_frames]
    log(f"dgmr: centering on {box_bounds}")

    from pysteps.utils import conversion
    R = np.stack(cropped).astype(np.float64)
    metadata = {"unit": "dBZ", "transform": None, "accutime": NATIVE_STEP_MIN,
                "threshold": SPEC.get("floor", LO), "zerovalue": LO,
                "zr_a": 200.0, "zr_b": 1.6}
    rainrate, _ = conversion.to_rainrate(R, metadata)
    rainrate[~np.isfinite(rainrate)] = 0.0
    rainrate = np.maximum(rainrate, 0.0).astype(np.float32)

    if not disk_ok(PUBLISH_DIR):
        log(f"dgmr: only {free_mb(PUBLISH_DIR):.0f} MB free, skipping this run")
        return 1

    t0 = time.time()
    # dgmr_module_plugin.dgmr.forecast() reloads the model from disk on
    # every call (~10s on the deployment GPU, confirmed) - a plugin
    # limitation, not something worth working around here, since this
    # process runs once and exits: that 10s lands inside one ~12s run every
    # five minutes, not on a hot path. Revisit only if this ever becomes a
    # persistent service instead of a per-run script like every other
    # pipeline in this project.
    from dgmr_module_plugin.dgmr import forecast
    import tensorflow as tf
    input_frames = tf.constant(rainrate.reshape(NUM_INPUT_FRAMES, DGMR_SIZE, DGMR_SIZE, 1))
    samples = forecast(input_frames, num_samples=1)
    preds_mmh = samples.numpy()[0, :, :, :, 0]  # (18, 256, 256)

    a, b_zr = 200.0, 1.6  # inverse Z-R, back to dBZ for the site's own palette
    fout = os.path.join(PUBLISH_DIR, base_stamp)
    os.makedirs(fout, exist_ok=True)
    entries = []
    for i, mmh in enumerate(preds_mmh):
        with np.errstate(all="ignore"):
            z = a * np.power(np.maximum(mmh, 0.0), b_zr)
            dbz = 10.0 * np.log10(np.maximum(z, 1e-6))
        dbz[mmh <= 0] = LO
        lead_min = (i + 1) * NATIVE_STEP_MIN
        fname = f"lead_{lead_min:03d}.png"
        _render(dbz, os.path.join(fout, fname))
        valid = base_time + timedelta(minutes=lead_min)
        entries.append({"lead_min": lead_min, "valid": valid.isoformat(),
                        "file": f"{base_stamp}/{fname}"})

    man = {
        "updated": datetime.now(timezone.utc).isoformat(),
        "base": {"t": base_stamp, "source": f"dgmr_input/{base_stamp}/composite_raw.png"},
        "unit": SPEC["unit"], "min": LO, "max": HI, "ramp": SPEC["ramp"],
        "bounds": box_bounds, "step_minutes": NATIVE_STEP_MIN,
        "method": "dgmr", "model": "DeepMind DGMR (Ravuri et al. 2021)",
        # Honest about the one thing local evaluation actually found: see
        # local-test/try_dgmr.py's comparison against the same storm. Read
        # by the page to show a caveat alongside the FCST badge rather than
        # presenting this as equally trustworthy to the extrapolation
        # nowcast.
        "experimental": True,
        "frames": entries,
    }
    write_json(os.path.join(PUBLISH_DIR, "dgmr.json"), man)
    _prune_published()
    log(f"dgmr: {len(entries)} lead times from {base_stamp} in {time.time() - t0:.0f}s")
    _publish()
    return 0


def check():
    dirs = _scan_raw_dirs()
    print(f"raw input frames on disk: {len(dirs)}")
    if dirs:
        newest = dirs[-1][0]
        when = datetime.strptime(newest, "%Y%m%d_%H%M%S").replace(tzinfo=timezone.utc)
        age = (datetime.now(timezone.utc) - when).total_seconds() / 60.0
        print(f"  newest: {newest}  ({age:.0f} min old)")
    ok = True
    try:
        import tensorflow as tf
        gpus = tf.config.list_physical_devices("GPU")
        print(f"  tensorflow {tf.__version__}, GPU: {gpus or 'NONE - will run on CPU'}")
    except ImportError as e:
        print(f"  tensorflow missing: {e}")
        ok = False
    try:
        import dgmr_module_plugin.dgmr  # noqa: F401
        print("  dgmr plugin importable")
    except ImportError as e:
        print(f"  dgmr plugin missing: {e}")
        ok = False
    return 0 if ok else 1


def main(argv):
    if "--check" in argv:
        return check()
    os.makedirs(RAW_DIR, exist_ok=True)
    os.makedirs(PUBLISH_DIR, exist_ok=True)
    fetch_one_frame()
    _prune_raw()
    return build()


if __name__ == "__main__":
    if "--check" in sys.argv:
        sys.exit(main(sys.argv[1:]))
    with Lock(os.path.expanduser("~/.gwcfc-dgmr.lock")):
        sys.exit(main(sys.argv[1:]))
