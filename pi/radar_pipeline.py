#!/usr/bin/env python3
"""
Builds radar map overlays on the Pi, from the raw data rather than someone
else's picture.

The site currently shows radar as tiles somebody else rendered. That is fine
until you want a product they do not offer, a colour scale of your own, or a
frame from four minutes ago rather than whenever their cache last turned over.
This decodes the actual radar files and renders them here, the same way
gfs_pipeline.py does for forecast models.

Two sources, and they are very different things:

  Level 2 is what the radar itself produces: every gate of every sweep,
  reflectivity and velocity and the dual polarity fields, about 6 MB a volume
  and a new one every four to six minutes. It is the real data.

  Level 3 is what the Weather Service makes from it: a single product on a
  coarser grid, already quality controlled, about 30 KB. Much cheaper, slightly
  later, and missing the detail that makes Level 2 worth having.

Both are free on public S3 buckets with no account and no key.

    python3 pi/radar_pipeline.py                  # the configured sites
    python3 pi/radar_pipeline.py KTLX KFWS        # just these
    python3 pi/radar_pipeline.py --l3             # Level 3 instead
    python3 pi/radar_pipeline.py --check          # what is available, no work

Output lands in ~/wxdata/radar/ and is served by the same serve.py as the
models, so nothing else has to change.
"""

import os
import sys
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

import numpy as np
from PIL import Image

# Everything shared with the model pipeline is imported rather than copied: the
# colour ramps, the regridder, the atomic write, the lock. A radar sweep is
# polar and a model field is Lambert, but "scattered points onto a lat/lon
# mesh" is the same problem, and it is already solved next door.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gfs_pipeline import (HTTP, LUTS, MAX_EDGE_PX, Lock, bounds_from, log,
                          regrid_to_latlon, write_json)  # noqa: E402

OUT_DIR = os.path.expanduser("~/wxdata/radar")

L2_BUCKET = "https://noaa-nexrad-level2.s3.amazonaws.com"
L3_BUCKET = "https://unidata-nexrad-level3.s3.amazonaws.com"

# Which radars to build. Kept short on purpose: every site is another volume
# to fetch and decode, and a Pi doing ten of them every five minutes is busy.
# Override on the command line, or set GWCFC_RADAR_SITES.
SITES = (os.environ.get("GWCFC_RADAR_SITES", "").split()
         or ["KTLX", "KFWS", "KLOT", "KATX", "KMLB"])

# How many past volumes to keep, which is what the animation scrubs through.
KEEP_FRAMES = 12

# Level 2 products, as MetPy names the moments inside the file.
L2_PRODUCTS = {
    "ref": {"moment": "REF", "range": (-10, 75), "ramp": "radar",
            "label": "Reflectivity", "unit": "dBZ"},
    "vel": {"moment": "VEL", "range": (-40, 40), "ramp": "velocity",
            "label": "Velocity", "unit": "m/s"},
}

# Level 3 products, by the three letter code the Weather Service uses.
L3_PRODUCTS = {
    "n0q": {"code": "N0Q", "range": (-10, 75), "ramp": "radar",
            "label": "Base Reflectivity", "unit": "dBZ"},
    "n0u": {"code": "N0U", "range": (-40, 40), "ramp": "velocity",
            "label": "Base Velocity", "unit": "kt"},
    "ntp": {"code": "NTP", "range": (0, 100), "ramp": "precip",
            "label": "Storm Total Precip", "unit": "mm"},
}

EARTH_R = 6371000.0


# ── Finding files ───────────────────────────────────────────────────────────

def s3_list(bucket, prefix, limit=200):
    """
    What is in a public S3 bucket under a prefix, newest last.

    Plain HTTPS against the bucket's own listing, so there is no account, no
    key and no SDK. The response is XML with one Key per object.
    """
    url = f"{bucket}/?list-type=2&prefix={prefix}&max-keys={limit}"
    try:
        r = HTTP.get(url, timeout=30)
        if r.status_code != 200:
            return []
        root = ET.fromstring(r.text)
    except Exception as e:
        log(f"  listing failed: {e}")
        return []
    ns = "{http://s3.amazonaws.com/doc/2006-03-01/}"
    return sorted(k.text for k in root.iter(f"{ns}Key") if k.text)


def latest_l2_keys(site, count=1, now=None):
    """
    The newest Level 2 volumes for one site.

    Yesterday is listed as well as today when the day has only just turned
    over, because at 00:03 UTC today's prefix holds one file and the frames
    worth animating are all in yesterday's.
    """
    now = now or datetime.now(timezone.utc)
    keys = []
    for back in (0, 1):
        d = now - timedelta(days=back)
        keys = s3_list(L2_BUCKET,
                       f"{d.year:04d}/{d.month:02d}/{d.day:02d}/{site}/") + keys
        if len(keys) >= count + 2:
            break
    # The bucket carries a MDM marker file alongside the volumes, which is not
    # a volume and will not decode.
    keys = [k for k in keys if not k.endswith("_MDM")]
    return keys[-count:] if keys else []


def latest_l3_keys(site, code, count=1):
    """
    The newest Level 3 files for one site and product.

    The key is SSS_PPP_YYYY_MM_DD_HH_MM_SS with the leading K dropped from the
    site, which is a small thing to get wrong and returns an empty list rather
    than an error when you do.
    """
    short = site[1:] if len(site) == 4 and site[0] in "KPT" else site
    keys = s3_list(L3_BUCKET, f"{short}_{code}_", limit=400)
    return keys[-count:] if keys else []


def fetch(bucket, key, path):
    try:
        r = HTTP.get(f"{bucket}/{key}", timeout=120)
        if r.status_code != 200 or len(r.content) < 200:
            log(f"  {key}: HTTP {r.status_code}, {len(r.content)} bytes")
            return False
        with open(path, "wb") as f:
            f.write(r.content)
        return True
    except Exception as e:
        log(f"  {key}: {e}")
        return False


# ── Turning polar sweeps into map coordinates ───────────────────────────────

def gate_latlon(site_lat, site_lon, azimuths, ranges, elevation_deg=0.5):
    """
    Where every radar gate actually is.

    A sweep is polar: a value at an angle and a distance from the antenna. A
    map is not. So each gate's ground position is worked out from the azimuth
    it was measured at and how far out it was, and the beam's tilt is taken off
    the distance, because a beam at five degrees elevation reaching 100 km has
    only covered 99.6 km of ground.

    Flat earth over these distances rather than a full geodesic. The error at
    the 230 km edge of a sweep is a few tens of metres, which is far inside one
    pixel of the finished picture.

    Returns two arrays shaped like the sweep.
    """
    az = np.radians(np.asarray(azimuths, dtype=np.float64))[:, None]
    rng = np.asarray(ranges, dtype=np.float64)[None, :]
    ground = rng * np.cos(np.radians(elevation_deg))

    north = ground * np.cos(az)
    east = ground * np.sin(az)

    lat = site_lat + np.degrees(north / EARTH_R)
    # Longitude degrees get narrower towards the poles, so the conversion has
    # to know what latitude it is at. Using the site's own latitude for the
    # whole sweep is close enough at this range and avoids a division that
    # blows up near the poles.
    lon = site_lon + np.degrees(east / (EARTH_R *
                                        np.cos(np.radians(site_lat))))
    return lat, lon


# ── Decoding ────────────────────────────────────────────────────────────────

def _metpy():
    """
    MetPy, imported when needed and not before.

    A Pi without it should still run everything else, and this should be the
    only thing that complains. It is the right reader for both formats: the
    alternative, Py-ART, brings a scientific stack far larger than a Pi wants
    for what amounts to reading one sweep out of a file.
    """
    try:
        from metpy.io import Level2File, Level3File
        return Level2File, Level3File
    except ImportError:
        raise RuntimeError(
            "Radar decoding needs MetPy. On the Pi:\n"
            "    ~/wxenv/bin/pip install metpy")


def read_l2(path, moment="REF"):
    """
    The lowest sweep of one Level 2 volume, as values and where they are.

    Only the lowest sweep, deliberately. A volume holds a dozen elevations and
    a map shows one: the 0.5 degree scan is what "radar" means to almost
    everyone looking at one, and decoding the rest would be most of the work
    for none of the picture.

    Velocity lives on a different sweep from reflectivity in the split cut at
    the bottom of a volume, so the sweep carrying the wanted moment is found
    rather than assumed.
    """
    Level2File, _ = _metpy()
    f = Level2File(path)

    sweep = None
    for i, sw in enumerate(f.sweeps):
        if sw and moment.encode() in sw[0][4]:
            sweep = sw
            break
    if sweep is None:
        return None

    hdr = sweep[0][4][moment.encode()][0]
    az = np.array([ray[0].az_angle for ray in sweep])
    el = float(sweep[0][0].el_angle)
    rng = (np.arange(hdr.num_gates) * hdr.gate_width
           + hdr.first_gate)
    data = np.array([ray[4][moment.encode()][1] for ray in sweep],
                    dtype=np.float32)

    site_lat = float(f.sweeps[0][0][1].lat)
    site_lon = float(f.sweeps[0][0][1].lon)
    lat, lon = gate_latlon(site_lat, site_lon, az, rng, el)
    return data, lat, lon, (site_lat, site_lon)


def read_l3(path):
    """One Level 3 product, which is already a single sweep of one thing."""
    _, Level3File = _metpy()
    f = Level3File(path)
    sym = f.sym_block[0][0]
    data = np.array(f.map_data(sym["data"]), dtype=np.float32)
    az = np.array(sym["start_az"]) + 90.0
    rng = np.linspace(0, f.max_range * 1000.0, data.shape[-1])
    site_lat, site_lon = float(f.lat), float(f.lon)
    lat, lon = gate_latlon(site_lat, site_lon, az, rng)
    return data, lat, lon, (site_lat, site_lon)


# ── Rendering ───────────────────────────────────────────────────────────────

def render(data, lat, lon, spec, out_path):
    """
    One sweep as a PNG, on the same lat/lon mesh everything else uses.

    The regridder is the one written for the model pipeline. A radar sweep and
    a Lambert model grid have nothing in common meteorologically and exactly
    one thing in common here: neither is rows of latitude and columns of
    longitude, and both need to become that.
    """
    box = {"bottomlat": float(np.nanmin(lat)), "toplat": float(np.nanmax(lat)),
           "leftlon": float(np.nanmin(lon)) % 360.0,
           "rightlon": float(np.nanmax(lon)) % 360.0}
    got = regrid_to_latlon(data.ravel(),
                           lat.ravel().astype(np.float32),
                           (lon.ravel() % 360.0).astype(np.float32),
                           box, max_edge=min(MAX_EDGE_PX, 1200))
    if got is None:
        return None
    arr, lats, lons = got

    lo, hi = spec["range"]
    norm = (arr - lo) / float(hi - lo)
    bad = ~np.isfinite(norm)
    idx = np.clip(np.nan_to_num(norm) * 255.0, 0, 255).astype(np.uint8)

    rgb = LUTS[spec["ramp"]][idx]
    alpha = np.full(idx.shape, 210, dtype=np.uint8)
    alpha[bad] = 0
    # Below about 5 dBZ is clear air and ground clutter rather than weather,
    # and painting it turns every map into a solid wash centred on the radar.
    if spec["ramp"] == "radar":
        alpha[idx < 18] = 0
    if spec["ramp"] == "precip":
        alpha[idx < 4] = 0

    Image.fromarray(np.dstack([rgb, alpha]), mode="RGBA").save(
        out_path, optimize=True)
    return bounds_from(lats, lons)


# ── Housekeeping ────────────────────────────────────────────────────────────

def prune(site_dir, keep=KEEP_FRAMES):
    """Keep the newest few frames of one site and drop the rest."""
    if not os.path.isdir(site_dir):
        return
    frames = sorted(d for d in os.listdir(site_dir)
                    if os.path.isdir(os.path.join(site_dir, d))
                    and d[0].isdigit())
    import shutil
    for old in frames[:-keep] if len(frames) > keep else []:
        shutil.rmtree(os.path.join(site_dir, old), ignore_errors=True)


def key_stamp(key):
    """The time out of a bucket key, as the folder name to write under."""
    base = key.rsplit("/", 1)[-1]
    # Level 2: KTLX20260815_120000_V06
    if len(base) > 20 and base[4:12].isdigit():
        return f"{base[4:12]}_{base[13:19]}"
    # Level 3: TLX_N0Q_2026_08_15_12_00_00
    bits = base.split("_")
    if len(bits) >= 8:
        return f"{bits[2]}{bits[3]}{bits[4]}_{bits[5]}{bits[6]}{bits[7]}"
    return base


# ── Building ────────────────────────────────────────────────────────────────

def build_site_l2(site, frames=1):
    """Fetch and render the newest Level 2 volumes for one site."""
    keys = latest_l2_keys(site, count=frames)
    if not keys:
        log(f"{site}: nothing in the bucket")
        return None

    built = []
    for key in keys:
        stamp = key_stamp(key)
        out = os.path.join(OUT_DIR, "l2", site, stamp)
        if os.path.exists(os.path.join(out, "manifest.json")):
            built.append(stamp)
            continue
        os.makedirs(out, exist_ok=True)
        tmp = os.path.join(out, "_volume")
        if not fetch(L2_BUCKET, key, tmp):
            continue

        fields, bounds, where = {}, None, None
        try:
            for name, spec in L2_PRODUCTS.items():
                got = read_l2(tmp, spec["moment"])
                if not got:
                    continue
                data, lat, lon, where = got
                b = render(data, lat, lon, spec,
                           os.path.join(out, f"{name}.png"))
                if b:
                    fields[name] = {"label": spec["label"],
                                    "unit": spec["unit"],
                                    "min": spec["range"][0],
                                    "max": spec["range"][1]}
                    bounds = b
        except Exception as e:
            log(f"{site} {stamp}: {e}")
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass

        if not fields:
            continue
        write_json(os.path.join(out, "manifest.json"), {
            "site": site, "level": 2, "time": stamp, "bounds": bounds,
            "site_latlon": where, "fields": fields,
            "built_at": datetime.now(timezone.utc).isoformat(),
        })
        built.append(stamp)
        log(f"{site} {stamp}: {', '.join(fields)}")

    prune(os.path.join(OUT_DIR, "l2", site))
    return built[-1] if built else None


def build_site_l3(site, products=("n0q",), frames=1):
    """The same for Level 3, which is one file per product rather than one
    volume holding all of them."""
    newest = None
    for pname in products:
        spec = L3_PRODUCTS[pname]
        keys = latest_l3_keys(site, spec["code"], count=frames)
        for key in keys:
            stamp = key_stamp(key)
            out = os.path.join(OUT_DIR, "l3", site, stamp)
            os.makedirs(out, exist_ok=True)
            done = os.path.join(out, "manifest.json")
            if os.path.exists(os.path.join(out, f"{pname}.png")):
                newest = stamp
                continue
            tmp = os.path.join(out, "_prod")
            if not fetch(L3_BUCKET, key, tmp):
                continue
            try:
                data, lat, lon, where = read_l3(tmp)
                b = render(data, lat, lon, spec,
                           os.path.join(out, f"{pname}.png"))
            except Exception as e:
                log(f"{site} {pname} {stamp}: {e}")
                b = None
            finally:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
            if not b:
                continue
            # Merged rather than replaced, since each product is written
            # separately and they share a frame.
            man = {}
            if os.path.exists(done):
                try:
                    import json
                    man = json.load(open(done))
                except Exception:
                    man = {}
            man.update({"site": site, "level": 3, "time": stamp,
                        "bounds": b, "site_latlon": where,
                        "built_at": datetime.now(timezone.utc).isoformat()})
            man.setdefault("fields", {})[pname] = {
                "label": spec["label"], "unit": spec["unit"],
                "min": spec["range"][0], "max": spec["range"][1]}
            write_json(done, man)
            newest = stamp
            log(f"{site} {stamp}: {pname}")
        prune(os.path.join(OUT_DIR, "l3", site))
    return newest


def write_index(level, sites):
    """One file the page reads to know which sites have frames."""
    root = os.path.join(OUT_DIR, f"l{level}")
    index = {"level": level, "sites": {},
             "updated": datetime.now(timezone.utc).isoformat()}
    for site in sites:
        d = os.path.join(root, site)
        if not os.path.isdir(d):
            continue
        frames = sorted(x for x in os.listdir(d)
                        if os.path.isdir(os.path.join(d, x)) and x[0].isdigit())
        frames = [f for f in frames
                  if os.path.exists(os.path.join(d, f, "manifest.json"))]
        if frames:
            index["sites"][site] = {
                "frames": frames,
                "path": f"l{level}/{site}/{{frame}}/manifest.json",
            }
    write_json(os.path.join(OUT_DIR, f"latest_l{level}.json"), index)
    return index


def check(sites):
    """What is available, without downloading or rendering anything."""
    print(f"sites: {', '.join(sites)}\n")
    ok = True
    for site in sites:
        keys = latest_l2_keys(site, count=3)
        if keys:
            newest = key_stamp(keys[-1])
            print(f"  {site}  L2  {len(keys)} recent, newest {newest}")
            print(f"        {keys[-1]}")
        else:
            print(f"  {site}  L2  nothing found")
            ok = False
        l3 = latest_l3_keys(site, "N0Q", count=1)
        print(f"  {site}  L3  {l3[-1] if l3 else 'nothing found'}")
        if not l3:
            ok = False
    print()
    try:
        _metpy()
        print("  MetPy is installed")
    except RuntimeError as e:
        print(f"  {e}")
        ok = False
    return 0 if ok else 1


def main(argv):
    level3 = "--l3" in argv
    sites = [a.upper() for a in argv
             if not a.startswith("-") and len(a) == 4] or SITES

    if "--check" in argv:
        return check(sites)

    os.makedirs(OUT_DIR, exist_ok=True)
    t0 = time.time()
    frames = int(os.environ.get("GWCFC_RADAR_FRAMES", "1"))
    for site in sites:
        try:
            if level3:
                build_site_l3(site, frames=frames)
            else:
                build_site_l2(site, frames=frames)
        except Exception as e:
            log(f"{site}: failed: {e}")
    idx = write_index(3 if level3 else 2, sites)
    log(f"{len(idx['sites'])} sites in {time.time() - t0:.0f}s")
    return 0 if idx["sites"] else 1


if __name__ == "__main__":
    # Its own lock, so a slow radar run and the hourly model build do not wait
    # on each other. They touch different directories entirely.
    with Lock(os.path.expanduser("~/.gwcfc-radar.lock")):
        sys.exit(main(sys.argv[1:]))
