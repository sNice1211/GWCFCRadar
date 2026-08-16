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
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import quote

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

# Where the data actually is, which is not where it used to be.
#
# The obvious addresses are both dead ends. noaa-nexrad-level2 holds the whole
# archive but refuses an anonymous listing, so there is no way to ask it what
# the newest volume is called. unidata-nexrad-level3 does allow listing, but it
# stopped being written to in 2022, so what it hands back is a real radar image
# from six years ago. That is worse than an error: it looked like it worked.
#
# So Level 2 comes from the chunks bucket, which is the live feed and is
# listable, and Level 3 comes from the Weather Service's own file server.
L2_CHUNKS = "https://unidata-nexrad-level2-chunks.s3.amazonaws.com"
L3_TGFTP = "https://tgftp.nws.noaa.gov/SL.us008001/DF.of/DC.radar"

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
    # The dual polarity moments ride in the same volume, so reading them costs
    # no extra download at all: the file is already on disk when these run.
    "cc":  {"moment": "RHO", "range": (0.2, 1.05), "ramp": "viridis",
            "label": "Correlation Coeff", "unit": ""},
    "zdr": {"moment": "ZDR", "range": (-4, 8), "ramp": "spread",
            "label": "Differential Refl", "unit": "dB"},
    "sw":  {"moment": "SW", "range": (0, 15), "ramp": "heat",
            "label": "Spectrum Width", "unit": "m/s"},
}

# Level 3 products. "dir" is the Weather Service's own name for the product on
# their file server, which is not the three letter code everyone else uses:
# p94r0 is what they call N0Q, and there is no pattern to learn, only a list.
#
# Every entry past the first two is fetched on the same terms as a model
# address: the build logs and skips a product whose directory is not there,
# and --check prints per-product status, so a wrong guess costs one line of
# output rather than the run. MetPy reads all of them.
L3_PRODUCTS = {
    "n0q": {"code": "N0Q", "dir": "DS.p94r0", "range": (-10, 75),
            "ramp": "radar", "label": "Base Reflectivity", "unit": "dBZ"},
    "n0u": {"code": "N0U", "dir": "DS.p99v0", "range": (-40, 40),
            "ramp": "velocity", "label": "Base Velocity", "unit": "kt"},
    # The dual polarity set, which is what tells rain from hail from debris.
    "n0c": {"code": "N0C", "dir": "DS.161c0", "range": (0.2, 1.05),
            "ramp": "viridis", "label": "Correlation Coeff", "unit": ""},
    "n0x": {"code": "N0X", "dir": "DS.159x0", "range": (-4, 8),
            "ramp": "spread", "label": "Differential Refl", "unit": "dB"},
    "n0k": {"code": "N0K", "dir": "DS.163k0", "range": (-2, 7),
            "ramp": "moisture", "label": "Specific Diff Phase", "unit": "deg/km"},
    "n0h": {"code": "N0H", "dir": "DS.165h0", "range": (0, 160),
            "ramp": "viridis", "label": "Hydrometeor Class", "unit": ""},
    # What the storm has dropped and how much it holds.
    "ohp": {"code": "N1P", "dir": "DS.78ohp", "range": (0, 75),
            "ramp": "precip", "label": "1 Hour Precip", "unit": "mm"},
    "stp": {"code": "NTP", "dir": "DS.80stp", "range": (0, 200),
            "ramp": "precip", "label": "Storm Total Precip", "unit": "mm"},
    "dvl": {"code": "DVL", "dir": "DS.134il", "range": (0, 80),
            "ramp": "heat", "label": "Vertically Integrated Liquid",
            "unit": "kg/m2"},
    "eet": {"code": "EET", "dir": "DS.135eet", "range": (0, 21),
            "ramp": "viridis", "label": "Echo Tops", "unit": "km"},
    # The whole column's strongest echo, not just the lowest sweep.
    "ncr": {"code": "NCR", "dir": "DS.p37cr", "range": (-10, 75),
            "ramp": "radar", "label": "Composite Reflectivity", "unit": "dBZ"},
}

EARTH_R = 6371000.0


# ── Finding files ───────────────────────────────────────────────────────────

NS = "{http://s3.amazonaws.com/doc/2006-03-01/}"


def s3_list(bucket, prefix, delimiter=None, pages=8, limit=1000):
    """
    What is in a public S3 bucket under a prefix, in order.

    Plain HTTPS against the bucket's own listing, so there is no account, no
    key and no SDK.

    It follows the continuation token to the end rather than taking the first
    page, and that is the whole point. S3 returns keys in alphabetical order
    from the start of the prefix, so one page of a big prefix is the OLDEST
    keys, not the newest. Asking for one page and taking the last entry is how
    this ended up serving radar from 2020 while looking entirely healthy.

    With a delimiter it returns folder names instead of keys, which is one
    small request rather than thousands.
    """
    out, token = [], None
    tag = f"{NS}CommonPrefixes" if delimiter else f"{NS}Contents"
    field = f"{NS}Prefix" if delimiter else f"{NS}Key"
    for _ in range(pages):
        url = f"{bucket}/?list-type=2&prefix={prefix}&max-keys={limit}"
        if delimiter:
            url += f"&delimiter={delimiter}"
        if token:
            url += f"&continuation-token={quote(token, safe='')}"
        try:
            r = HTTP.get(url, timeout=30)
            if r.status_code != 200:
                # Said out loud, because a silent empty list is indistinguishable
                # from "there is no weather", and that cost a day.
                log(f"  listing {prefix or '/'}: HTTP {r.status_code}")
                return []
            root = ET.fromstring(r.text)
        except Exception as e:
            log(f"  listing {prefix or '/'} failed: {e}")
            return []
        out += [t.findtext(field) for t in root.iter(tag) if t.findtext(field)]
        if root.findtext(f"{NS}IsTruncated") != "true":
            break
        token = root.findtext(f"{NS}NextContinuationToken")
        if not token:
            break
    return sorted(out)


def _chunk_time(key):
    """The time out of a chunk key, which carries it: .../20260816-023410-001-S"""
    base = key.rsplit("/", 1)[-1]
    bits = base.split("-")
    return f"{bits[0]}_{bits[1]}" if len(bits) >= 2 and bits[0].isdigit() else ""


def _vol_time(site, vol):
    """When one volume started, from the name of its first chunk.

    One request that asks for a single key, so this is cheap enough to do
    repeatedly while hunting for the newest volume.
    """
    keys = s3_list(L2_CHUNKS, f"{site}/{vol}/", limit=1, pages=1)
    return _chunk_time(keys[0]) if keys else ""


def _newest_index(site, vols):
    """
    Where the newest volume sits in the number-sorted list.

    The volume number counts up and rolls over at 999, and the bucket keeps
    about two days, so after a rollover the numbers present are the tail of the
    old cycle and the head of the new one. Sorted by number that reads as: the
    new run first, low numbers, ending at the newest volume there is, and then
    a jump backwards to the old run, high numbers, ending just before the
    rollover.

    So there is exactly one place where time goes backwards, and everything in
    the first block is newer than everything in the second. That makes it a
    binary search rather than a scan: about ten small requests instead of six
    hundred. Checking only the two ends, which is what this did before, finds
    the newest only when there has been no rollover, which is why KTLX was live
    and KLOT was nine hours stale on the same run.
    """
    first, last = _vol_time(site, vols[0]), _vol_time(site, vols[-1])
    if not first or not last or first <= last:
        return len(vols) - 1          # no rollover, so the highest is newest

    # The first block holds every volume at or after first, and the second
    # block holds none, so "is this one at least as new as vols[0]" is true
    # then false exactly once and can be searched for.
    lo, hi = 0, len(vols) - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        t = _vol_time(site, vols[mid])
        if t and t >= first:
            lo = mid
        else:
            hi = mid - 1
    return lo


def latest_l2_volumes(site, count=1):
    """
    The newest Level 2 volumes for one site, as (stamp, [chunk keys]).

    The live feed publishes a volume in pieces as the antenna goes round, so
    the newest one is usually still being written. Its neighbours in number are
    its neighbours in time, so once the newest is located the ones before it
    are simply the entries before it in the list.
    """
    vols = [p.rstrip("/").rsplit("/", 1)[-1]
            for p in s3_list(L2_CHUNKS, f"{site}/", delimiter="/")]
    vols = sorted((v for v in vols if v.isdigit()), key=int)
    if not vols:
        return []

    at = _newest_index(site, vols)
    # A few more than asked for, so a volume that has only just started can be
    # passed over for the complete one before it. Walking backwards from the
    # newest, and wrapping round the list, since the entry before number 1 is
    # number 999.
    want = [vols[(at - i) % len(vols)] for i in range(count + 3)]

    found = []
    for vol in want:
        keys = s3_list(L2_CHUNKS, f"{site}/{vol}/")
        if not keys or len(keys) < 8:
            # Too few chunks means the antenna is still part way round and
            # there is no whole bottom sweep in there yet.
            continue
        found.append((_chunk_time(keys[0]), keys))
        if len(found) >= count:
            break
    found.sort(key=lambda t: t[0])
    return found[-count:]


def fetch_chunks(keys, path):
    """
    One volume, rebuilt from its pieces.

    The chunks are the file cut into parts in order, not separate files, so
    joining them back together in key order gives exactly the Archive II volume
    the archive would have held. The first chunk carries the AR2V header.
    """
    total = 0
    with open(path, "wb") as f:
        for k in keys:
            try:
                r = HTTP.get(f"{L2_CHUNKS}/{k}", timeout=60)
            except Exception as e:
                log(f"  {k}: {e}")
                return False
            if r.status_code != 200:
                log(f"  {k}: HTTP {r.status_code}")
                return False
            f.write(r.content)
            total += len(r.content)
    return total > 10000


def fetch_l3(site, spec, path):
    """
    The newest Level 3 product for one site, and when it was made.

    The Weather Service keeps the current one at a fixed address called
    sn.last, so there is nothing to list and nothing to sort: the newest file
    is always at the same URL. Which also means the name carries no time, so
    the time comes from the header the server sends with it.
    """
    url = f"{L3_TGFTP}/{spec['dir']}/SI.{site.lower()}/sn.last"
    try:
        r = HTTP.get(url, timeout=60)
    except Exception as e:
        log(f"  {site} {spec['code']}: {e}")
        return None
    if r.status_code != 200 or len(r.content) < 200:
        log(f"  {site} {spec['code']}: HTTP {r.status_code},"
            f" {len(r.content)} bytes")
        return None
    with open(path, "wb") as f:
        f.write(r.content)

    stamp = datetime.now(timezone.utc)
    when = r.headers.get("Last-Modified")
    if when:
        try:
            stamp = parsedate_to_datetime(when).astimezone(timezone.utc)
        except (TypeError, ValueError):
            pass
    return stamp.strftime("%Y%m%d_%H%M%S")


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

    key = moment.encode()
    hdr = sweep[0][4][key][0]
    az = np.array([ray[0].az_angle for ray in sweep])
    el = float(sweep[0][0].el_angle)

    # MetPy reports first_gate and gate_width in KILOMETRES, and gate_latlon
    # works in metres, the way read_l3 already feeds it. Without the thousand
    # the whole sweep lands within a few hundred metres of the antenna and the
    # picture is a dot, which is exactly "L2 does not work while L3 does": L3
    # multiplied and L2 did not.
    rng = (np.arange(hdr.num_gates) * hdr.gate_width + hdr.first_gate) * 1000.0

    # Rays in one sweep can carry different gate counts, so a plain np.array
    # over them makes a ragged object array that will not render. Pad every ray
    # to the widest with NaN, which the renderer already treats as no data.
    rows = [np.asarray(ray[4][key][1], dtype=np.float32)
            for ray in sweep if key in ray[4]]
    width = max(len(r) for r in rows)
    data = np.full((len(rows), width), np.nan, dtype=np.float32)
    for i, r in enumerate(rows):
        # MetPy returns a masked array where the radar saw nothing; the mask
        # has to become NaN or the fill value paints as a real echo.
        r = np.ma.filled(np.ma.masked_invalid(r), np.nan)
        data[i, :len(r)] = r

    # rng is one gate axis; if a ray was shorter its extra columns are NaN and
    # simply do not draw. az and data share the ray axis, so they line up.
    rng = rng[:width]

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


# ── Building ────────────────────────────────────────────────────────────────

def build_site_l2(site, frames=1):
    """Fetch and render the newest Level 2 volumes for one site."""
    vols = latest_l2_volumes(site, count=frames)
    if not vols:
        log(f"{site}: nothing in the live feed")
        return None

    built = []
    for stamp, keys in vols:
        out = os.path.join(OUT_DIR, "l2", site, stamp)
        if os.path.exists(os.path.join(out, "manifest.json")):
            built.append(stamp)
            continue
        os.makedirs(out, exist_ok=True)
        tmp = os.path.join(out, "_volume")
        if not fetch_chunks(keys, tmp):
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


def build_site_l3(site, products=tuple(L3_PRODUCTS), frames=1):
    """The same for Level 3, which is one file per product rather than one
    volume holding all of them."""
    newest = None
    # One stamp for the whole pass, taken from the first product fetched.
    #
    # Each product's sn.last is written when that product was made, and they
    # are made minutes apart, so asking each one for its own time scattered
    # them into separate frame folders holding one field each. The page reads
    # the newest folder and takes what is in it, so half the products were
    # invisible depending on which happened to be newest. They came off the
    # same volume, so they belong in the same frame.
    frame = None
    for pname in products:
        spec = L3_PRODUCTS[pname]
        # Only ever the current one. There is no listing to walk back through,
        # which is the trade for the file being live: past frames accumulate
        # here run by run rather than being fetched all at once.
        tmp = os.path.join(OUT_DIR, "l3", site, "_prod")
        os.makedirs(os.path.dirname(tmp), exist_ok=True)
        stamp = fetch_l3(site, spec, tmp)
        if stamp:
            frame = frame or stamp
            stamp = frame
            out = os.path.join(OUT_DIR, "l3", site, stamp)
            os.makedirs(out, exist_ok=True)
            done = os.path.join(out, "manifest.json")
            if os.path.exists(os.path.join(out, f"{pname}.png")):
                newest = stamp
                os.unlink(tmp)
                continue
            os.replace(tmp, os.path.join(out, "_prod"))
            tmp = os.path.join(out, "_prod")
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


def _age(stamp, now):
    """How old a frame is, in words, because that is the thing worth knowing.

    A timestamp printed on its own reads as fine whatever it says, which is how
    a 2020 file sat there looking current.
    """
    try:
        t = datetime.strptime(stamp, "%Y%m%d_%H%M%S").replace(
            tzinfo=timezone.utc)
    except ValueError:
        return "?"
    mins = (now - t).total_seconds() / 60.0
    if mins < 60:
        return f"{mins:.0f} min old"
    if mins < 60 * 48:
        return f"{mins / 60:.1f} hours old  <-- stale"
    return f"{mins / 1440:.0f} DAYS old  <-- not live"


def check(sites):
    """What is available, without downloading or rendering anything."""
    print(f"sites: {', '.join(sites)}\n")
    ok = True
    now = datetime.now(timezone.utc)
    for site in sites:
        vols = latest_l2_volumes(site, count=1)
        if vols:
            stamp, keys = vols[-1]
            print(f"  {site}  L2  {stamp}  {len(keys)} chunks  {_age(stamp, now)}")
        else:
            print(f"  {site}  L2  nothing found")
            ok = False
        # A HEAD per product rather than a GET, so --check stays a check, and
        # per product because most of these directories were added on the
        # strength of documentation rather than a listing: this line of output
        # is what confirms or disproves each one.
        good, bad = [], []
        for pname, spec in L3_PRODUCTS.items():
            url = f"{L3_TGFTP}/{spec['dir']}/SI.{site.lower()}/sn.last"
            try:
                r = HTTP.head(url, timeout=30, allow_redirects=True)
                (good if r.status_code == 200 else bad).append(
                    pname if r.status_code == 200 else f"{pname}({r.status_code})")
            except Exception:
                bad.append(f"{pname}(net)")
        print(f"  {site}  L3  {len(good)}/{len(L3_PRODUCTS)} products: "
              f"{', '.join(good) or 'none'}")
        if bad:
            print(f"        missing: {', '.join(bad)}")
        if not good:
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

    # Asked once, up front. Without this the missing reader shows up as five
    # identical per-site failures with the real reason buried in each of them,
    # and systemd reports "the control process exited with an error code",
    # which says nothing at all about what to install.
    try:
        _metpy()
    except RuntimeError as e:
        log(str(e))
        return 1

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
    # --check reads and downloads nothing, so it must not queue behind a
    # build. Being told "another run is already going" by a status command is
    # exactly backwards: a running build is the moment you most want to look.
    if "--check" in sys.argv:
        sys.exit(main(sys.argv[1:]))
    # Its own lock, so a slow radar run and the hourly model build do not wait
    # on each other. They touch different directories entirely.
    with Lock(os.path.expanduser("~/.gwcfc-radar.lock")):
        sys.exit(main(sys.argv[1:]))
