#!/usr/bin/env python3
"""
Ensemble cyclone centres, found in raw model output rather than handed to us.

    python3 pi/enscenters_pipeline.py            # the newest GEFS run
    python3 pi/enscenters_pipeline.py --check    # what is published, no work
    python3 pi/enscenters_pipeline.py --step 12 --out 168

The AI Cyclones panel has only ever shown Google's Weather Lab forecasts, which
publish tropical cyclones directly: the model says "here is a storm and here is
its track" and we draw it. That is one source, and it is the only kind of model
that does that.

Every ordinary ensemble carries the same information without stating it. A
tropical cyclone in GEFS is a closed low in the pressure field with a warm
column above it, and it is there in every member of every run. This finds them.

The result is thirty one more opinions on where a storm goes, from data the box
already knows how to fetch, and the only kind of answer to "might something
form here" that an ensemble can give.

HOW IT WORKS

Three steps, and the second is the one that matters.

  1. CLOSED LOWS. Find every local minimum in mean sea level pressure, then
     keep one only if the pressure rises by a threshold in EVERY direction
     within a few hundred kilometres. That last part is what separates a storm
     from a trough: a trough is a valley open at one end, a cyclone is a bowl.

  2. WARM CORE. A minima detector finds every low on earth, and the mid
     latitude storm track has far more of them than the tropics do, so without
     this step the map is a mess of North Atlantic winter storms and nothing
     tropical is visible.

     The test is the thickness between the 300 and 500 mb surfaces. Warm air
     takes up more room than cold air, so a tropical cyclone, which is warm all
     the way up, has THICKER air above it than its surroundings. An
     extratropical low is cold aloft and has thinner air. So: a thickness
     maximum sitting on the surface low means tropical.

     The subtlety, and it is the whole game: test the thickness ANOMALY, never
     the raw thickness. Air is thick at the equator and thin at the poles, and
     that background gradient is steeper across a storm than the storm's own
     core is. Measured raw, every tropical low fails on its equatorward side
     and every polar low looks like it has a warm side. Subtracting a wide
     boxcar mean removes the background and leaves the storm.

  3. TRACKS. Stitch each member's centres from one forecast hour to the next by
     nearest neighbour, with a speed ceiling so a storm cannot teleport across
     an ocean to a low that happens to be there six hours later.

CREDIT

The detection and warm core method here is adapted, with permission, from
Andrew Austin-Adler's Triple-A Tropics (github.com/WeathermanAAA/Triple-A-Tropics),
whose enscenters package works out the same problem and whose notes on why the
raw thickness test fails saved this from shipping with that exact bug. The
tuning constants below are his. The fetching and output side are ours, built on
the byte range machinery gfs_pipeline.py already uses.

WHAT IT COSTS

Three GRIB records per member per forecast hour: pressure, and the two heights
the thickness needs. Thirty one members at half a degree is roughly three
quarters of a megabyte per member per hour, so a full 120 hour run at six
hourly steps is around half a gigabyte. --step and --out both move that, and
--members caps it outright.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import sys
import tempfile
import time

import numpy as np

# scipy is used for four array primitives and nothing else. Reimplementing a
# minimum filter and connected component labelling on top of numpy is possible
# and is not worth the bugs; install.sh installs python3-scipy from apt.
try:
    from scipy.ndimage import (label, minimum_filter, minimum_position,
                               uniform_filter)
    HAVE_SCIPY = True
except ImportError:                                   # pragma: no cover
    HAVE_SCIPY = False

try:
    import requests
except ImportError:                                   # pragma: no cover
    requests = None

try:
    import eccodes
except ImportError:                                   # pragma: no cover
    eccodes = None


OUT_DIR = os.path.expanduser("~/wxdata/enscenters")
BUCKET = "https://noaa-gefs-pds.s3.amazonaws.com"

# gec00 is the control run, gep01 through gep30 the perturbed members. Checked
# against the live bucket: gep31 is a 404, so thirty one is the whole ensemble.
MEMBERS = ["gec00"] + [f"gep{n:02d}" for n in range(1, 31)]

# The three records, as the index spells them. Verified in a real file rather
# than assumed: a level named even slightly differently matches nothing and the
# member silently produces no centres.
WANT = [("PRMSL", "mean sea level"), ("HGT", "300 mb"), ("HGT", "500 mb")]

CYCLE_H = 6
LAG_H = 7
DEFAULT_STEP = 6
DEFAULT_OUT = 120

REQUEST_TIMEOUT = 60
RETRIES = 3


def log(msg):
    print(f"[enscenters] {msg}", flush=True)


# ── Wind from pressure ───────────────────────────────────────────────────────
# Atkinson-Holliday: the standard way to put a wind on a cyclone when all you
# have is its central pressure. Not a measurement and not the model's own wind,
# which is why the output labels it as an estimate.
AH_ENV_HPA = 1010.0
AH_COEFF = 6.7
AH_EXP = 0.644


def ah_vmax_kt(pc_hpa, env=AH_ENV_HPA):
    """Peak one minute wind in knots implied by a central pressure in hPa."""
    deficit = env - pc_hpa
    if deficit <= 0:
        return 0.0
    return AH_COEFF * (deficit ** AH_EXP)


def norm_lon(lon):
    """Wrap a longitude into [-180, 180)."""
    return ((lon + 180.0) % 360.0) - 180.0


def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(norm_lon(lon2 - lon1))
    a = (math.sin(dp / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2)
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def _parabolic_offset(a, b, c):
    """Where the true minimum sits between three samples, in cells.

    Three points define a parabola, and its vertex is almost always somewhere
    between the samples rather than exactly on the middle one. Without this
    every centre snaps to a grid node and a hundred members tile into a visible
    lattice instead of a cloud.
    """
    denom = a - 2.0 * b + c
    if abs(denom) < 1e-9:
        return 0.0
    return max(-0.5, min(0.5, 0.5 * (a - c) / denom))


# ── Step one: closed lows ────────────────────────────────────────────────────
def detect_centers(mslp_hpa, lats, lons,
                   min_footprint_deg=2.5, closed_threshold_hpa=2.0,
                   search_radius_km=500.0, n_azimuth=16, n_radial=12,
                   dedup_km=250.0, lat_limit=75.0, max_central_hpa=1015.0):
    """Every closed low in a global pressure field.

    Returns [{lat, lon, mslp_hpa, vmax_kt}] deepest first.
    """
    field = np.asarray(mslp_hpa, dtype=float)
    lats = np.asarray(lats, dtype=float)
    lons = np.asarray(lons, dtype=float)
    nlat, nlon = field.shape
    dlat_deg = abs(float(lats[1] - lats[0]))
    dlon_deg = abs(float(lons[1] - lons[0]))
    lat_desc = lats[0] > lats[-1]
    lon0 = float(lons[0])

    # Local minima. Latitude is clamped at the poles and longitude wraps, so a
    # storm sitting on the date line is found rather than cut in half.
    radius_px = max(1, round(min_footprint_deg / max(dlat_deg, 1e-6)))
    filt = minimum_filter(field, size=2 * radius_px + 1,
                          mode=("nearest", "wrap"))
    cand = (field == filt) & (field <= max_central_hpa)
    # A flat trough floor marks every one of its pixels as a minimum, which is
    # hundreds of candidates for one feature. Collapse each connected blob to
    # its deepest pixel.
    lbl, n = label(cand, structure=np.ones((3, 3), dtype=int))
    if n == 0:
        return []
    pos = minimum_position(field, lbl, index=np.arange(1, n + 1))
    if not isinstance(pos, list):
        pos = [pos]

    def li(lat):
        idx = round((lats[0] - lat) / dlat_deg) if lat_desc \
            else round((lat - lats[0]) / dlat_deg)
        return int(min(max(idx, 0), nlat - 1))

    def lj(lon):
        return int(round((lon - lon0) / dlon_deg)) % nlon

    azimuths = np.linspace(0.0, 2.0 * math.pi, n_azimuth, endpoint=False)
    radii = np.linspace(search_radius_km / n_radial, search_radius_km, n_radial)

    keep = []
    for p in pos:
        i, j = int(p[0]), int(p[1])
        pc = float(field[i, j])
        lat0 = float(lats[i])
        if lat_limit is not None and abs(lat0) > lat_limit:
            continue
        target = pc + closed_threshold_hpa
        coslat = max(math.cos(math.radians(lat0)), 0.05)
        lonj = float(lons[j])
        closed = True
        for az in azimuths:
            s, c = math.sin(az), math.cos(az)
            reached = False
            for d in radii:
                la = lat0 + (d * c) / 111.0
                lo = lonj + (d * s) / (111.0 * coslat)
                # A ray that runs off the pole has not closed. Crediting it
                # would pass an open polar gradient, whose equatorward side
                # rises while its poleward side simply leaves the grid.
                if abs(la) > 89.5:
                    break
                if field[li(la), lj(lo)] >= target:
                    reached = True
                    break
            if not reached:
                closed = False
                break
        if not closed:
            continue
        off_i = (_parabolic_offset(float(field[i - 1, j]), pc,
                                   float(field[i + 1, j]))
                 if 0 < i < nlat - 1 else 0.0)
        off_j = _parabolic_offset(float(field[i, (j - 1) % nlon]), pc,
                                  float(field[i, (j + 1) % nlon]))
        rlat = lat0 + off_i * (float(lats[1]) - float(lats[0]))
        rlon = lonj + off_j * (float(lons[1]) - float(lons[0]))
        keep.append((pc, rlat, norm_lon(rlon)))

    # Two minima a hundred kilometres apart are one storm. Deepest wins.
    keep.sort(key=lambda t: t[0])
    out = []
    for pc, lat, lon in keep:
        if any(haversine_km(lat, lon, la, lo) < dedup_km
               for _p, la, lo in out):
            continue
        out.append((pc, lat, lon))
    return [{"lat": round(lat, 2), "lon": round(lon, 2),
             "mslp_hpa": round(pc, 1), "vmax_kt": round(ah_vmax_kt(pc), 1)}
            for pc, lat, lon in out]


# ── Step two: is it tropical ─────────────────────────────────────────────────
def thickness_anomaly(thk, dlat, dlon, bg_box_deg=10.0):
    """Thickness with the smooth background taken out.

    Subtracting a wide boxcar mean is the whole trick. Raw thickness runs thick
    at the equator and thin at the poles, and that slope across a storm is
    steeper than the storm's own core, so a raw test fails on the warm side of
    every genuine tropical cyclone and passes shallow local maxima in the cold
    extratropics. What is left after the subtraction is storm sized.
    """
    thk = np.asarray(thk, dtype=float)
    bx = max(3, 2 * int(round(bg_box_deg / max(dlat, 1e-6))) + 1)
    by = max(3, 2 * int(round(bg_box_deg / max(dlon, 1e-6))) + 1)
    return thk - uniform_filter(thk, size=(bx, by), mode=("nearest", "wrap"))


def is_warm_core(lat0, lon0, anom, lats, lons,
                 search_max_deg=1.0, warm_anom_min_m=6.0,
                 closed_drop_m=6.0, closed_radius_deg=6.5,
                 n_azimuth=16, n_radial=12):
    """True when the low sits on a closed warm anomaly.

    Two gates. The centre itself must sit on a warm anomaly, which rejects a
    cold low that merely has a warm feature nearby, and that warmth must be
    enclosed, which rejects an open gradient. A disturbance that has not built
    a core yet fails both and correctly does not appear until it has one.
    """
    anom = np.asarray(anom, dtype=float)
    nlat, nlon = anom.shape
    dlat = abs(float(lats[1] - lats[0]))
    dlon = abs(float(lons[1] - lons[0]))
    lat_desc = lats[0] > lats[-1]
    lon0g = float(lons[0])

    def li(lat):
        idx = round((lats[0] - lat) / dlat) if lat_desc \
            else round((lat - lats[0]) / dlat)
        return int(min(max(idx, 0), nlat - 1))

    def lj(lon):
        return int(round((lon - lon0g) / dlon)) % nlon

    ci, cj = li(lat0), lj(lon0)
    if float(anom[ci, cj]) < warm_anom_min_m:
        return False

    # The peak may be slightly off the surface centre: a tilted storm is still
    # a storm. Look within a degree and close the contour around whatever is
    # found there.
    rpx = max(1, int(round(search_max_deg / dlat)))
    i_lo, i_hi = max(0, ci - rpx), min(nlat, ci + rpx + 1)
    jcols = (np.arange(cj - rpx, cj + rpx + 1)) % nlon
    sub = anom[i_lo:i_hi][:, jcols]
    a0, a1 = np.unravel_index(int(np.argmax(sub)), sub.shape)
    mi, mj = i_lo + int(a0), int(jcols[a1])
    peak = float(anom[mi, mj])
    mlat, mlon = float(lats[mi]), float(lons[mj])

    target = peak - closed_drop_m
    coslat = max(math.cos(math.radians(mlat)), 0.05)
    for az in np.linspace(0.0, 2.0 * math.pi, n_azimuth, endpoint=False):
        s, c = math.sin(az), math.cos(az)
        reached = False
        for rd in np.linspace(closed_radius_deg / n_radial,
                              closed_radius_deg, n_radial):
            la = mlat + rd * c
            lo = mlon + rd * s / coslat
            if abs(la) > 89.5:
                break
            if anom[li(la), lj(lo)] <= target:
                reached = True
                break
        if not reached:
            return False
    return True


def filter_warm(centers, thk, lats, lons, max_lat=50.0, subtrop_lat=25.0):
    """Keep the tropical ones.

    Two tiers on purpose. In the deep tropics the test is lenient, because a
    forming storm has a real but shallow core and refusing to show it until it
    is strong defeats the point of looking. Outside the tropics it is strict,
    because that is where the impostors are.
    """
    if thk is None:
        return [c for c in centers if abs(c["lat"]) <= max_lat]
    dlat = abs(float(lats[1] - lats[0]))
    dlon = abs(float(lons[1] - lons[0]))
    anom = thickness_anomaly(thk, dlat, dlon)
    kept = []
    for c in centers:
        alat = abs(c["lat"])
        if alat > max_lat:
            continue
        if alat > subtrop_lat:
            wa, cd, cr = 12.0, 10.0, 5.0
        else:
            wa, cd, cr = 6.0, 6.0, 6.5
        if is_warm_core(c["lat"], c["lon"], anom, lats, lons,
                        warm_anom_min_m=wa, closed_drop_m=cd,
                        closed_radius_deg=cr):
            kept.append(c)
    return kept


# ── Step three: tracks ───────────────────────────────────────────────────────
# A storm moves. Twelve hours apart, two centres four hundred kilometres apart
# are almost certainly the same system; two thousand kilometres apart are not,
# however tempting the nearest neighbour is. 40 kt of forward speed is a
# generous ceiling for a tropical cyclone and a tight one for a coincidence.
MAX_SPEED_KT = 40.0


def stitch(by_step, step_h):
    """Turn per forecast hour centre lists into tracks.

    by_step is {step_hours: [centre, ...]} for ONE member. Greedy nearest
    neighbour forward in time, which is enough here: these are single member
    tracks that are drawn as a bundle, not a best track anyone will measure.
    """
    steps = sorted(by_step)
    tracks = []
    live = []          # (track index, last centre)
    for si, s in enumerate(steps):
        gap_h = (s - steps[si - 1]) if si else step_h
        reach_km = MAX_SPEED_KT * 1.852 * max(gap_h, 1)
        taken = set()
        nxt = []
        for ti, last in live:
            best, bestd = None, reach_km
            for ci, c in enumerate(by_step[s]):
                if ci in taken:
                    continue
                d = haversine_km(last["lat"], last["lon"], c["lat"], c["lon"])
                if d < bestd:
                    best, bestd = ci, d
            if best is None:
                continue                       # the track ends here
            taken.add(best)
            c = by_step[s][best]
            tracks[ti]["points"].append({"step_h": s, **c})
            nxt.append((ti, c))
        for ci, c in enumerate(by_step[s]):
            if ci in taken:
                continue
            tracks.append({"points": [{"step_h": s, **c}]})
            nxt.append((len(tracks) - 1, c))
        live = nxt
    # A single point is a low that existed for one frame, which is noise rather
    # than a forecast of anything.
    return [t for t in tracks if len(t["points"]) >= 2]


# ── Fetching ─────────────────────────────────────────────────────────────────
def http_get(url, headers=None, timeout=REQUEST_TIMEOUT):
    last = None
    for attempt in range(RETRIES):
        try:
            r = requests.get(url, headers=headers or {}, timeout=timeout)
            if r.status_code in (200, 206):
                return r
            last = r.status_code
            if r.status_code == 404:
                return r
        except requests.RequestException as e:
            last = str(e)
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"{url}: {last}")


def member_path(date_str, cyc, member, step):
    return (f"gefs.{date_str}/{cyc}/atmos/pgrb2ap5/"
            f"{member}.t{cyc}z.pgrb2a.0p50.f{step:03d}")


def fetch_records(date_str, cyc, member, step, path):
    """The three records we want, as one small GRIB file.

    The index beside each file gives a byte offset per record, so this asks for
    three ranges out of an eighty five record file rather than the whole thing.
    GRIB is a sequence of self describing messages, so three of them
    concatenated is a valid file and the decoder cannot tell.
    """
    base = f"{BUCKET}/{member_path(date_str, cyc, member, step)}"
    r = http_get(base + ".idx")
    if r.status_code != 200 or ":" not in r.text:
        return False
    rows = []
    for line in r.text.splitlines():
        f = line.split(":")
        if len(f) > 5:
            try:
                rows.append({"start": int(f[1]), "var": f[3], "lev": f[4]})
            except ValueError:
                pass
    for i, row in enumerate(rows):
        row["end"] = rows[i + 1]["start"] - 1 if i + 1 < len(rows) else None
    want = []
    for var, lev in WANT:
        hit = next((x for x in rows if x["var"] == var and x["lev"] == lev),
                   None)
        if hit is None:
            return False
        want.append(hit)
    want.sort(key=lambda x: x["start"])
    try:
        with open(path, "wb") as fh:
            for x in want:
                rng = f"bytes={x['start']}-" + ("" if x["end"] is None
                                                else str(x["end"]))
                rr = http_get(base, headers={"Range": rng})
                if rr.status_code not in (200, 206):
                    return False
                fh.write(rr.content)
    except OSError as e:
        log(f"    {e}")
        return False
    return True


def decode(path):
    """(mslp_hPa, thickness_gpm, lats, lons) out of the three record file."""
    got = {}
    lats = lons = None
    with open(path, "rb") as fh:
        while True:
            gid = eccodes.codes_grib_new_from_file(fh)
            if gid is None:
                break
            try:
                short = eccodes.codes_get(gid, "shortName")
                lev = int(eccodes.codes_get(gid, "level"))
                ni = int(eccodes.codes_get(gid, "Ni"))
                nj = int(eccodes.codes_get(gid, "Nj"))
                vals = np.asarray(eccodes.codes_get_values(gid),
                                  dtype=float).reshape(nj, ni)
                if lats is None:
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
                if short in ("prmsl", "msl"):
                    got["mslp"] = vals / 100.0          # Pa to hPa
                elif short == "gh":
                    got[f"gh{lev}"] = vals              # already gpm
            finally:
                eccodes.codes_release(gid)
    if "mslp" not in got:
        return None
    thk = None
    if "gh300" in got and "gh500" in got:
        thk = got["gh300"] - got["gh500"]
    return got["mslp"], thk, lats, lons


# ── Run ──────────────────────────────────────────────────────────────────────
def newest_cycle(now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    t = now - dt.timedelta(hours=LAG_H)
    hour = (t.hour // CYCLE_H) * CYCLE_H
    return t.strftime("%Y%m%d"), f"{hour:02d}"


def write_json(path, obj):
    """Write a file that is either the old one or the new one, never half."""
    tmp = f"{path}.tmp{os.getpid()}"
    try:
        with open(tmp, "w") as fh:
            json.dump(obj, fh, separators=(",", ":"))
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def build(date_str, cyc, step_h, out_h, members, verbose=True):
    steps = list(range(0, out_h + 1, step_h))
    run = f"{date_str}_{cyc}"
    out_run = os.path.join(OUT_DIR, run)
    os.makedirs(out_run, exist_ok=True)

    all_tracks = []
    done = 0
    for member in members:
        by_step = {}
        for s in steps:
            with tempfile.NamedTemporaryFile(suffix=".grib2",
                                             delete=False) as tf:
                tmp = tf.name
            try:
                if not fetch_records(date_str, cyc, member, s, tmp):
                    continue
                got = decode(tmp)
                if got is None:
                    continue
                mslp, thk, lats, lons = got
                centers = detect_centers(mslp, lats, lons)
                by_step[s] = filter_warm(centers, thk, lats, lons)
            except Exception as e:                    # one member, not the run
                log(f"  {member} f{s:03d}: {e}")
            finally:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
        if not by_step:
            continue
        for t in stitch(by_step, step_h):
            t["member"] = member
            all_tracks.append(t)
        done += 1
        if verbose:
            log(f"  {member}: {len(by_step)} steps, "
                f"{sum(len(v) for v in by_step.values())} centres")

    payload = {
        "model": "gefs",
        "label": "GEFS ensemble centres",
        "run": run,
        "members": done,
        "step_h": step_h,
        "out_h": out_h,
        "built": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "tracks": all_tracks,
    }
    write_json(os.path.join(out_run, "gefs.json"), payload)
    write_json(os.path.join(OUT_DIR, "latest.json"),
               {"run": run, "path": f"{run}/gefs.json",
                "model": "gefs", "members": done,
                "updated": payload["built"]})
    log(f"{done} members, {len(all_tracks)} tracks -> {out_run}/gefs.json")
    return payload


def check(date_str, cyc, step_h):
    """What is published, without downloading any of it."""
    ok = 0
    for member in MEMBERS:
        url = f"{BUCKET}/{member_path(date_str, cyc, member, step_h)}.idx"
        try:
            r = requests.get(url, timeout=20)
            if r.status_code == 200:
                ok += 1
        except requests.RequestException:
            pass
    log(f"{date_str} {cyc}z: {ok} of {len(MEMBERS)} members published")
    return ok


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--step", type=int, default=DEFAULT_STEP)
    ap.add_argument("--out", type=int, default=DEFAULT_OUT)
    ap.add_argument("--members", type=int, default=len(MEMBERS),
                    help="cap the member count, for a cheaper run")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--date")
    ap.add_argument("--cyc")
    args = ap.parse_args(argv)

    if requests is None:
        log("requests is not installed")
        return 1
    date_str, cyc = newest_cycle()
    if args.date:
        date_str = args.date
    if args.cyc:
        cyc = args.cyc

    if args.check:
        return 0 if check(date_str, cyc, args.step) else 1
    if not HAVE_SCIPY:
        log("scipy is not installed: apt install python3-scipy")
        return 1
    if eccodes is None:
        log("eccodes is not installed")
        return 1
    os.makedirs(OUT_DIR, exist_ok=True)
    build(date_str, cyc, args.step, args.out, MEMBERS[:args.members])
    return 0


if __name__ == "__main__":
    sys.exit(main())
