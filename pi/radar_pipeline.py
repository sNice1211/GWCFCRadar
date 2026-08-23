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

import json
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import quote

import numpy as np
from PIL import Image

# Everything shared with the model pipeline is imported rather than copied: the
# colour ramps, the regridder, the atomic write, the lock. A radar sweep is
# polar and a model field is Lambert, but "scattered points onto a lat/lon
# mesh" is the same problem, and it is already solved next door.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gfs_pipeline import (HTTP, LUTS, MAX_EDGE_PX, Lock, band_alpha,
                          bounds_from, disk_ok, free_mb, hours_for_disk, log,
                          lut_for, regrid_to_latlon, write_json)  # noqa: E402

OUT_DIR = os.path.expanduser("~/wxdata/radar")

# Where the data actually is, which is not where it used to be.
#
# noaa-nexrad-level2 holds the whole archive but refuses an anonymous
# listing, so there is no way to ask it what the newest volume is called.
# unidata-nexrad-level3 once looked dead too, but that verdict was wrong in
# an instructive way: it was probed with the retired N0Q product code, and
# the bucket answers emptiness for a product that no longer exists. Probed
# with the codes actually being written, TDWR's TZ0 among them, it is alive
# and fresh to the minute. NEXRAD Level 3 still comes from tgftp, which is
# proven for all eleven products; the terminals come from the bucket.
#
# So Level 2 comes from the chunks bucket, which is the live feed and is
# listable, NEXRAD Level 3 from the Weather Service's own file server, and
# TDWR Level 3 from the Unidata bucket.
L2_CHUNKS = "https://unidata-nexrad-level2-chunks.s3.amazonaws.com"
L3_TGFTP = "https://tgftp.nws.noaa.gov/SL.us008001/DF.of/DC.radar"

# Which radars to build. Kept short on purpose: every site is another volume
# to fetch and decode, and a Pi doing ten of them every five minutes is busy.
# Override on the command line, or set GWCFC_RADAR_SITES.
SITES = (os.environ.get("GWCFC_RADAR_SITES", "").split()
         or ["KTLX", "KFWS", "KLOT", "KATX", "KMLB", "TTPA", "TDFW"])

# Every terminal radar the map shows a pill for. They all join the Level 3
# build: their products are six small files each, fetched in parallel below,
# so the whole country's terminals cost about a minute of wall clock. They do
# NOT join Level 2 here: the browser decodes terminal Level 2 live on its
# own, and 46 more volume decodes every five minutes would bury the Pi.
TDWR_SITES = [
    "TADW", "TATL", "TBNA", "TBOS", "TBWI", "TCLT", "TCMH", "TCVG", "TDAL",
    "TDAY", "TDCA", "TDEN", "TDFW", "TDTW", "TEWR", "TFLL", "THOU", "TIAD",
    "TIAH", "TICH", "TIDS", "TJFK", "TLAS", "TLVE", "TMCI", "TMCO",
    "TMDW", "TMEM", "TMIA", "TMKE", "TMSP", "TMSY", "TOKC", "TORD", "TPBI",
    "TPHL", "TPHX", "TPIT", "TRDU", "TSDF", "TSJU", "TSLC", "TSTL", "TTPA",
    "TTUL",
]

# How far back to keep past volumes, which is what the animation scrubs
# through. Age rather than a frame count: a count assumes perfect five-minute
# cadence, and a Pi that fell behind or a site that briefly stopped answering
# would then report a "day" of history that was actually much less. Pruning by
# wall-clock age keeps whatever genuinely happened in the window, however
# unevenly spaced, and self-corrects once building resumes.
# How far back playback reaches. Three days, because that is what was asked
# for and because the frames are small: a Level 3 picture is tens of
# kilobytes, so 72 hours of one site is measured in tens of megabytes rather
# than gigabytes.
#
# The ceiling matters more than the window on a Pi. A site scanning every four
# minutes produces about 1,080 frames in three days, and there are hundreds of
# sites; the count cap is what stops a busy severe-weather day filling the
# card while the age cap is still happy.
KEEP_HOURS = float(os.environ.get("GWCFC_RADAR_KEEP_HOURS", "72"))
MAX_FRAMES = int(os.environ.get("GWCFC_RADAR_MAX_FRAMES", "1200"))

# MRMS is national rather than per-site, so one frame covers the whole country
# and there are thirty-eight products of them. Same window, its own ceiling.
MRMS_KEEP_HOURS = float(os.environ.get("GWCFC_MRMS_KEEP_HOURS", "72"))
MRMS_MAX_FRAMES = int(os.environ.get("GWCFC_MRMS_MAX_FRAMES", "900"))

# Level 2 products, as MetPy names the moments inside the file.
L2_PRODUCTS = {
    "ref": {"moment": "REF", "range": (-10, 75), "ramp": "radar",
            "label": "Reflectivity", "unit": "dBZ"},
    "vel": {"moment": "VEL", "range": (-40, 40), "ramp": "velocity",
            "label": "Velocity", "unit": "m/s"},
    # The dual polarity moments ride in the same volume, so reading them costs
    # no extra download at all: the file is already on disk when these run.
    # 0.45 rather than 0.2 at the bottom, and 1.0 rather than 1.05 at the top.
    # Correlation coefficient asks whether everything in a gate is the same
    # kind of thing, and essentially all precipitation answers between 0.95
    # and 1.00. Spread over 0.2 to 1.05 the ramp spent nearly all of itself on
    # values the weather never takes and painted every storm one flat colour;
    # this puts the useful part of viridis where the data actually is, while
    # still keeping room below 0.8 for the debris and biological targets that
    # are the whole reason to look at CC.
    "cc":  {"moment": "RHO", "range": (0.45, 1.0), "ramp": "viridis",
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
    # DS.135eet 404'd on all five sites, which settles it: the digital
    # enhanced product is not published there. The legacy echo tops is, under
    # the same pNN style as composite reflectivity, and it reports in
    # thousands of feet.
    "eet": {"code": "NET", "dir": "DS.p41et", "range": (0, 70),
            "ramp": "viridis", "label": "Echo Tops", "unit": "kft"},
    # The whole column's strongest echo, not just the lowest sweep.
    "ncr": {"code": "NCR", "dir": "DS.p37cr", "range": (-10, 75),
            "ramp": "radar", "label": "Composite Reflectivity", "unit": "dBZ"},
    # The higher sweeps of the two base products. The antenna scans the same
    # circle at rising angles, and the Weather Service publishes every cut as
    # its own product: r0 to r3 and v0 to v3 are tilts 1 to 4. Last in this
    # dict on purpose, so the frame stamp stays pinned to n0q above and a
    # site missing a higher cut costs only that cut.
    "n1q": {"code": "N1Q", "dir": "DS.p94r1", "range": (-10, 75),
            "ramp": "radar", "label": "Reflectivity Tilt 2", "unit": "dBZ"},
    "n2q": {"code": "N2Q", "dir": "DS.p94r2", "range": (-10, 75),
            "ramp": "radar", "label": "Reflectivity Tilt 3", "unit": "dBZ"},
    "n3q": {"code": "N3Q", "dir": "DS.p94r3", "range": (-10, 75),
            "ramp": "radar", "label": "Reflectivity Tilt 4", "unit": "dBZ"},
    "n1u": {"code": "N1U", "dir": "DS.p99v1", "range": (-40, 40),
            "ramp": "velocity", "label": "Velocity Tilt 2", "unit": "kt"},
    "n2u": {"code": "N2U", "dir": "DS.p99v2", "range": (-40, 40),
            "ramp": "velocity", "label": "Velocity Tilt 3", "unit": "kt"},
    "n3u": {"code": "N3U", "dir": "DS.p99v3", "range": (-40, 40),
            "ramp": "velocity", "label": "Velocity Tilt 4", "unit": "kt"},
    # The dual-pol moments above (n0c/n0x/n0k/n0h) are only listed at tilt 1.
    # Reflectivity and velocity both publish their higher tilts by
    # incrementing the trailing digit in the same "dir" (p94r0 -> p94r1 ->
    # p94r2, p99v0 -> p99v1 -> p99v2), and the RPG assigns that trailing
    # elevation-cut digit the same way across every digital product family,
    # not just these two - so tilt 2 of each dual-pol moment is added here
    # on that same pattern rather than a separate live-checked guess. Same
    # deal as everything past n3u: skipped, not fatal, if a site's build
    # ever disagrees with it.
    "n1c": {"code": "N1C", "dir": "DS.161c1", "range": (0.2, 1.05),
            "ramp": "viridis", "label": "Corr. Coeff. Tilt 2", "unit": ""},
    "n1x": {"code": "N1X", "dir": "DS.159x1", "range": (-4, 8),
            "ramp": "spread", "label": "Diff. Refl. Tilt 2", "unit": "dB"},
    "n1k": {"code": "N1K", "dir": "DS.163k1", "range": (-2, 7),
            "ramp": "moisture", "label": "Spec. Diff. Phase Tilt 2", "unit": "deg/km"},
    "n1h": {"code": "N1H", "dir": "DS.165h1", "range": (0, 160),
            "ramp": "viridis", "label": "Hydro. Class. Tilt 2", "unit": ""},
    # Storm-relative velocity: the base velocity field re-centered on the
    # storm's own motion, which is what actually shows a mesocyclone couplet
    # instead of the whole field just sliding with the environmental wind.
    # WSR-88D product number 56; "s" suffix chosen the same way "r" marks the
    # reflectivity family and "v" marks ground-relative velocity above. Lower
    # confidence than the tilt-2 entries just above (not a same-file pattern
    # extension, so genuinely worth checking against a live site).
    "n0s": {"code": "N0S", "dir": "DS.p56s0", "range": (-40, 40),
            "ramp": "velocity", "label": "Storm Rel. Velocity", "unit": "kt"},
    "n1s": {"code": "N1S", "dir": "DS.p56s1", "range": (-40, 40),
            "ramp": "velocity", "label": "Storm Rel. Velocity Tilt 2", "unit": "kt"},
}

# ── TDWR Level 3, the terminal radars' own dialect ──────────────────────────
# The airport radars (T sites) publish the same kinds of products under their
# own names, which AtticRadar's tables document: TZ0 and TZ1 are the base
# reflectivity tilts, TV0 and TV1 the velocity tilts, TZL the long range
# reflectivity, NCR the same composite NEXRAD has. No dual-pol products at
# all: the terminals carry no such hardware, so none are listed rather than
# listed and forever missing.
#
# They also publish through a different door: the Unidata Level 3 bucket,
# keyed by the site's three letter id and the product, with the time in the
# key itself. TTPA's newest base reflectivity is the last key under
# TPA_TZ0_<today>_. Verified live: fresh to the minute.
TDWR_L3_PRODUCTS = {
    "tz0": {"code": "TZ0", "range": (-10, 75), "ramp": "radar",
            "label": "Base Reflectivity", "unit": "dBZ"},
    "tv0": {"code": "TV0", "range": (-40, 40), "ramp": "velocity",
            "label": "Base Velocity", "unit": "kt"},
    "tz1": {"code": "TZ1", "range": (-10, 75), "ramp": "radar",
            "label": "Reflectivity Tilt 2", "unit": "dBZ"},
    "tv1": {"code": "TV1", "range": (-40, 40), "ramp": "velocity",
            "label": "Velocity Tilt 2", "unit": "kt"},
    "tzl": {"code": "TZL", "range": (-10, 75), "ramp": "radar",
            "label": "Long Range Reflectivity", "unit": "dBZ"},
    "ncr": {"code": "NCR", "range": (-10, 75), "ramp": "radar",
            "label": "Composite Reflectivity", "unit": "dBZ"},
}

L3_BUCKET = "https://unidata-nexrad-level3.s3.amazonaws.com"


# Every terminal radar's id starts with T, and exactly one WSR-88D's does
# too: TJUA, the NEXRAD at San Juan. Judged by the letter alone it was asked
# for terminal products it does not publish and answered nothing, which is the
# whole of Puerto Rico missing for the sake of one initial.
NEXRAD_T_SITES = ("TJUA",)


def is_tdwr(site):
    """A terminal radar, rather than a WSR-88D whose id merely starts with T."""
    sid = str(site).upper()
    return sid.startswith("T") and sid not in NEXRAD_T_SITES

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
        # One retry on a transport error before giving up. A single aborted
        # connection while probing for a rollover made KMLB assume there was
        # none and serve a volume 2.8 hours old, so a moment of network is
        # worth more than it looks here.
        root = None
        for attempt in (0, 1):
            try:
                r = HTTP.get(url, timeout=30)
                if r.status_code != 200:
                    # Said out loud, because a silent empty list is
                    # indistinguishable from "there is no weather".
                    log(f"  listing {prefix or '/'}: HTTP {r.status_code}")
                    return []
                root = ET.fromstring(r.text)
                break
            except Exception as e:
                if attempt:
                    log(f"  listing {prefix or '/'} failed: {e}")
                    return []
                time.sleep(1.5)
        if root is None:
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
    # A failed probe must not be read as an answer. Assuming "no rollover"
    # because a request dropped is how one aborted connection served a site
    # 2.8 hours stale, so a neighbour stands in when an end will not speak.
    first = _vol_time(site, vols[0]) or (
        _vol_time(site, vols[1]) if len(vols) > 1 else "")
    last = _vol_time(site, vols[-1]) or (
        _vol_time(site, vols[-2]) if len(vols) > 1 else "")
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


def fetch_l3_tdwr(site, spec, path):
    """
    The newest TDWR product from the Unidata bucket.

    No sn.last here: the bucket holds every file of the day and S3 lists keys
    in order, so the newest is the LAST key under today's prefix. The key
    carries its own time, TPA_TZ0_2026_08_17_19_40_31, so the stamp is read
    straight off the name rather than off a header.
    """
    sid = str(site).upper()[1:]      # TTPA -> TPA, the bucket's spelling
    for back in (0, 1):              # today, then yesterday around midnight
        day = datetime.now(timezone.utc) - timedelta(days=back)
        keys = s3_list(L3_BUCKET, f"{sid}_{spec['code']}_{day:%Y_%m_%d}_")
        if not keys:
            continue
        key = keys[-1]
        try:
            r = HTTP.get(f"{L3_BUCKET}/{key}", timeout=60)
        except Exception as e:
            log(f"  {site} {spec['code']}: {e}")
            return None
        if r.status_code != 200 or len(r.content) < 200:
            log(f"  {site} {spec['code']}: HTTP {r.status_code},"
                f" {len(r.content)} bytes")
            return None
        with open(path, "wb") as f:
            f.write(r.content)
        p = key.split("_")           # SID, CODE, Y, M, D, h, m, s
        if len(p) >= 8:
            return f"{p[2]}{p[3]}{p[4]}_{p[5]}{p[6]}{p[7]}"
        return datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    log(f"  {site} {spec['code']}: nothing in the bucket for two days")
    return None


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
    """
    One Level 3 product, whichever of the two shapes it arrives in.

    Most products are radial, a sweep of azimuths like Level 2. Echo tops and
    composite reflectivity are raster: a square grid of cells centred on the
    radar, no azimuths anywhere in them. Assuming everything was radial is why
    exactly those two products "were never made": the reader threw KeyError on
    start_az, the build logged and skipped them, and the manifest never
    carried what the check had proved the server was publishing.
    """
    _, Level3File = _metpy()
    f = Level3File(path)
    sym = f.sym_block[0][0]
    data = np.array(f.map_data(sym["data"]), dtype=np.float32)
    site_lat, site_lon = float(f.lat), float(f.lon)

    if "start_az" in sym:
        az = np.array(sym["start_az"]) + 90.0
        rng = np.linspace(0, f.max_range * 1000.0, data.shape[-1])
        lat, lon = gate_latlon(site_lat, site_lon, az, rng)
        return data, lat, lon, (site_lat, site_lon)

    # Raster. The radar sits at the centre of the grid and the whole square
    # spans the product's range both ways, so the cell size falls out of the
    # shape: 464 km across 464 cells for composite, the same span across 116
    # for echo tops. Rows run north to south.
    rows, cols = data.shape
    cell_km = 464.0 / rows
    x = (np.arange(cols) + 0.5 - cols / 2.0) * cell_km * 1000.0
    y = (rows / 2.0 - np.arange(rows) - 0.5) * cell_km * 1000.0
    lat = site_lat + np.degrees(y / EARTH_R)[:, None] * np.ones((1, cols))
    lon = site_lon + np.degrees(
        x / (EARTH_R * np.cos(np.radians(site_lat))))[None, :] * np.ones((rows, 1))
    return data, lat, lon, (site_lat, site_lon)


# ── Rendering ───────────────────────────────────────────────────────────────

def _fill_ray_gaps(arr, passes=3):
    """
    Close the thin gaps a sweep leaves between its rays.

    A sweep is 360 rays from one point, so the further out you go the wider
    apart they are: at the edge of a terminal radar's 90 km reach, neighbouring
    rays are over a kilometre apart while the picture's cells are 150 metres.
    Rendered honestly that leaves nine empty cells between every pair of rays,
    which reads as speckle and is why a sharper picture can look worse.

    So a cell with measured neighbours on two sides takes their average. That is
    not inventing weather: the beam physically swept the space between those
    rays, and this is the same interpolation every radar display does. A cell
    with only one neighbour is left alone, so an isolated echo stays the size
    it was measured rather than smearing outwards.
    """
    out = arr
    for _ in range(passes):
        holes = ~np.isfinite(out)
        if not holes.any():
            break
        tot = np.zeros(out.shape, dtype=np.float32)
        cnt = np.zeros(out.shape, dtype=np.int8)
        for shift, axis in ((1, 0), (-1, 0), (1, 1), (-1, 1)):
            nb = np.roll(out, shift, axis=axis)
            ok = np.isfinite(nb)
            tot[ok] += nb[ok]
            cnt[ok] += 1
        fill = holes & (cnt >= 2)
        if not fill.any():
            break
        out = out.copy()
        out[fill] = tot[fill] / cnt[fill]
    return out


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

    # How fine this data actually is, measured rather than guessed: the typical
    # step between neighbouring samples along the range axis, which is the gate
    # spacing for a sweep and the cell size for a raster. Asking the regridder
    # for that many cells across the picture is what keeps a terminal radar
    # sharp. Left to count points instead, a TDWR sweep came out around 435
    # cells wide where its 150 metre gates support nearly 1200, and a radar
    # meant to be read zoomed in over an airport looked soft at every zoom.
    step = None
    if lat.ndim == 2 and lat.shape[1] > 1:
        dlat = np.diff(lat, axis=1)
        dlon = np.diff(lon, axis=1) * np.cos(np.radians(np.nanmean(lat)))
        with np.errstate(all="ignore"):
            s = float(np.nanmedian(np.hypot(dlat, dlon)))
        if np.isfinite(s) and s > 0:
            span = max(box["toplat"] - box["bottomlat"],
                       abs(box["rightlon"] - box["leftlon"]))
            step = int(min(1600, max(64, round(span / s))))

    got = regrid_to_latlon(data.ravel(),
                           lat.ravel().astype(np.float32),
                           (lon.ravel() % 360.0).astype(np.float32),
                           box, max_edge=min(MAX_EDGE_PX, 1200), edge=step)
    if got is None:
        return None
    arr, lats, lons = got
    arr = _fill_ray_gaps(arr)

    lo, hi = spec["range"]
    norm = (arr - lo) / float(hi - lo)
    bad = ~np.isfinite(norm)
    idx = np.clip(np.nan_to_num(norm) * 255.0, 0, 255).astype(np.uint8)

    rgb = lut_for(spec["ramp"], lo, hi)[idx]
    alpha = np.full(idx.shape, 210, dtype=np.uint8)
    alpha[bad] = 0
    # The floor used to be a raw index of 18, which on the -10 to 75 dBZ scale
    # is minus four: nine dBZ of clear-air return was being painted in the
    # colour of the five dBZ band, which is the haze that made every map look
    # washed out. It comes off the band table now.
    band_alpha(spec["ramp"], idx, alpha, lo, hi)
    if spec["ramp"] == "precip":
        alpha[idx < 4] = 0

    Image.fromarray(np.dstack([rgb, alpha]), mode="RGBA").save(
        out_path, optimize=True)
    return bounds_from(lats, lons)


# ── Housekeeping ────────────────────────────────────────────────────────────

def prune(site_dir, hours=KEEP_HOURS, cap=None):
    """Drop frames past the retention window, and past the count ceiling.

    A frame's own directory name IS its timestamp (%Y%m%d_%H%M%S), so no
    extra bookkeeping is needed to know its age. A name that fails to parse
    is left alone rather than guessed about and deleted.

    The count ceiling exists because the window alone is not a budget. Three
    days is a fine thing to ask for and a site scanning every four minutes
    still produces about eleven hundred frames inside it; a busy day with many
    sites is where the card actually fills, and dropping the oldest frames is
    a far better failure than running out of space mid-write.
    """
    if not os.path.isdir(site_dir):
        return
    cap = MAX_FRAMES if cap is None else cap
    # Three days if the card can hold three days. This is where the promise
    # meets the disk, and the disk wins: an SD card that runs out takes apt,
    # git and the virtual environment down with it, and none of the errors it
    # then produces point anywhere near the frames that filled it.
    hours = hours_for_disk(site_dir, hours)
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    import shutil
    kept = []
    for d in sorted(os.listdir(site_dir)):
        full = os.path.join(site_dir, d)
        if not (os.path.isdir(full) and d and d[0].isdigit()):
            continue
        try:
            stamp = datetime.strptime(d, "%Y%m%d_%H%M%S").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if stamp < cutoff:
            shutil.rmtree(full, ignore_errors=True)
        else:
            kept.append(full)
    if cap and len(kept) > cap:
        for full in kept[:len(kept) - cap]:
            shutil.rmtree(full, ignore_errors=True)


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


def build_site_l3(site, products=None, frames=1):
    """The same for Level 3, which is one file per product rather than one
    volume holding all of them. A terminal radar builds its own dialect of
    products from its own source; everything downstream is shared."""
    specs = TDWR_L3_PRODUCTS if is_tdwr(site) else L3_PRODUCTS
    fetch = fetch_l3_tdwr if is_tdwr(site) else fetch_l3
    products = products or tuple(specs)
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
        spec = specs[pname]
        # Only ever the current one. There is no listing to walk back through,
        # which is the trade for the file being live: past frames accumulate
        # here run by run rather than being fetched all at once.
        tmp = os.path.join(OUT_DIR, "l3", site, "_prod")
        os.makedirs(os.path.dirname(tmp), exist_ok=True)
        stamp = fetch(site, spec, tmp)
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
                "min": spec["range"][0], "max": spec["range"][1],
                "ramp": spec["ramp"]}
            write_json(done, man)
            newest = stamp
            log(f"{site} {stamp}: {pname}")
        prune(os.path.join(OUT_DIR, "l3", site))
    return newest


# How many frames the shared index carries per site. The index answers "which
# sites have anything", and every page load fetches it, so it has to stay
# small. Three days of one site is about eleven hundred frame names, and at
# twenty sites that is a third of a megabyte before a single picture is drawn.
#
# So the index carries a recent window - enough to start playing immediately -
# and points at a per-site file holding the whole three days, which is fetched
# only for the site actually being looked at. Boot stays cheap and the long
# loop is still there for the one site that wants it.
INDEX_FRAMES = int(os.environ.get("GWCFC_INDEX_FRAMES", "60"))


def write_index(level, sites):
    """One small file the page reads to know which sites have frames.

    Plus a frames.json per site holding the full retention window, so a site
    can be scrubbed across three days without every other site's history
    riding along in the boot request.
    """
    root = os.path.join(OUT_DIR, f"l{level}")
    index = {"level": level, "sites": {},
             "updated": datetime.now(timezone.utc).isoformat(),
             "keep_hours": KEEP_HOURS}
    for site in sites:
        d = os.path.join(root, site)
        if not os.path.isdir(d):
            continue
        frames = sorted(x for x in os.listdir(d)
                        if os.path.isdir(os.path.join(d, x)) and x[0].isdigit())
        frames = [f for f in frames
                  if os.path.exists(os.path.join(d, f, "manifest.json"))]
        if not frames:
            continue
        # The whole window, beside the site's own frames, for the page to
        # fetch when that site is opened.
        write_json(os.path.join(d, "frames.json"),
                   {"site": site, "level": level, "frames": frames,
                    "keep_hours": KEEP_HOURS,
                    "updated": datetime.now(timezone.utc).isoformat()})
        index["sites"][site] = {
            "frames": frames[-INDEX_FRAMES:],
            "total": len(frames),
            "oldest": frames[0],
            "frames_path": f"l{level}/{site}/frames.json",
            "path": f"l{level}/{site}/{{frame}}/manifest.json",
        }
    write_json(os.path.join(OUT_DIR, f"latest_l{level}.json"), index)
    return index


# ── MRMS national severe products ───────────────────────────────────────────
# Rotation tracks and hail swaths, the two derived products people pay other
# apps for, straight from NOAA's own MRMS feed. One small gzipped GRIB each,
# published every two minutes, covering the whole CONUS at 1 km: where storms
# have rotated over the last hour, and the largest hail they have produced.
MRMS_BASE = "https://mrms.ncep.noaa.gov/data/2D"
# FLASH is MRMS rainfall run through hydrologic models, and NOAA publishes it
# in its own tree rather than beside the 2D mosaics. A product says which one
# it lives in; everything without a "base" is a 2D mosaic.
FLASH_BASE = "https://mrms.ncep.noaa.gov/data/FLASH"
# The three-dimensional reflectivity stack, and the dual-pol mosaics that
# come with it, are published per altitude in their own tree rather than
# beside the flat 2D mosaics.
REFL3D_BASE = "https://mrms.ncep.noaa.gov/data/3DRefl"

# What one pass of MRMS is allowed to cost.
#
# The catalogue is seventy products and about half of them want rebuilding
# every five minutes, which is the same five minutes the radar frames are
# built in. Without a ceiling one busy pass would spend the entire window
# downloading mosaics and the radar loop would have a hole in it, which is
# far worse than a mosaic being five minutes stale: a stale mosaic is still a
# picture, a missing radar frame is a gap in the animation that never fills.
#
# These two were set when the catalogue was about seventy entries and were
# never revisited as it grew. At fourteen a pass the catalogue could not come
# round: a hundred and thirty products need ten passes, so nearly an hour
# passed before the last of them had been built even once, and until then the
# menu simply did not list them. That, rather than anything in the browser, is
# why the row looked like it held twenty or thirty products.
#
# The ceiling still exists because the radar frames share this timer and
# matter more than any single mosaic, but it is a ceiling on a busy pass now
# rather than a cap that the ordinary case runs into every time.
# Half the timer window, and not a second more.
#
# This was raised to 210 to get more of the catalogue built per pass, which
# was treating the symptom: products were not building because a missing
# "floor" key was killing the pass outright, not because there was too little
# time. With that fixed the extra sixty seconds buys nothing and costs the
# thing that matters, since the radar frames are built on this same five
# minute timer and a pass that runs 210 seconds leaves them ninety.
MRMS_PASS_SECS = float(os.environ.get("GWCFC_MRMS_PASS_SECS", "150"))
MRMS_PASS_MAX = int(os.environ.get("GWCFC_MRMS_PASS_MAX", "30"))
# ── The MRMS catalogue ──────────────────────────────────────────────────────
# Every entry is one national grid published at a fixed address, so adding a
# product is a dict entry and nothing else: build_mrms below reads, shrinks,
# colours and writes whatever is listed here. A path that turns out to be
# wrong costs one logged line and is skipped, exactly like the Level 3 list,
# which is what makes it safe to carry a broad catalogue rather than only the
# handful anyone has hand-checked.
#
# "every" is the wanted cadence in minutes. The radar timer fires every five,
# so 5 means every pass and 60 means roughly hourly; _mrms_due below turns
# that into an actual decision, and backs a product off on its own when it
# keeps failing or keeps costing too much time.
#
# "signed" marks the products where a negative value is real data rather than
# MRMS's missing/no-coverage marker. Temperature is the obvious one, and
# treating -3 C as "no coverage" would erase half a winter map.
MRMS_PRODUCTS = {
    # ── Rotation: where a mesocyclone travelled. The floor hides the weak
    # shear speckle covering every map, so what stays drawn is worth looking
    # at. Mid level is the classic; low level is nearer the ground and so
    # nearer the question everyone is actually asking.
    "rotation": {"path": "RotationTrackML60min", "label": "Rotation Tracks 60m",
                 "unit": "s^-1", "range": (0.002, 0.014), "ramp": "heat",
                 "floor": 0.003, "every": 5},
    "rotation30": {"path": "RotationTrackML30min", "label": "Rotation Tracks 30m",
                   "unit": "s^-1", "range": (0.002, 0.014), "ramp": "heat",
                   "floor": 0.003, "every": 5},
    "rotation120": {"path": "RotationTrackML120min", "label": "Rotation Tracks 2h",
                    "unit": "s^-1", "range": (0.002, 0.014), "ramp": "heat",
                    "floor": 0.003, "every": 15},
    "rotation1440": {"path": "RotationTrackML1440min", "label": "Rotation Tracks 24h",
                     "unit": "s^-1", "range": (0.002, 0.014), "ramp": "heat",
                     "floor": 0.003, "every": 60},
    "rotationll60": {"path": "RotationTrack60min", "label": "Low-Level Rotation 60m",
                     "unit": "s^-1", "range": (0.002, 0.014), "ramp": "heat",
                     "floor": 0.003, "every": 5},
    "rotationll30": {"path": "RotationTrack30min", "label": "Low-Level Rotation 30m",
                     "unit": "s^-1", "range": (0.002, 0.014), "ramp": "heat",
                     "floor": 0.003, "every": 5},
    # ── Hail. MESH is the algorithm's largest hail, in millimetres; 6 mm is
    # under pea size, the smallest worth drawing at all.
    "mesh":     {"path": "MESH_Max_60min", "label": "Hail Swaths 60m",
                 "unit": "mm", "range": (0, 100), "ramp": "radar",
                 "floor": 6.0, "every": 5},
    "meshnow":  {"path": "MESH", "label": "Hail (current)",
                 "unit": "mm", "range": (0, 100), "ramp": "radar",
                 "floor": 6.0, "every": 5},
    "mesh30":   {"path": "MESH_Max_30min", "label": "Hail Swaths 30m",
                 "unit": "mm", "range": (0, 100), "ramp": "radar",
                 "floor": 6.0, "every": 5},
    "mesh120":  {"path": "MESH_Max_120min", "label": "Hail Swaths 2h",
                 "unit": "mm", "range": (0, 100), "ramp": "radar",
                 "floor": 6.0, "every": 15},
    "mesh1440": {"path": "MESH_Max_1440min", "label": "Hail Swaths 24h",
                 "unit": "mm", "range": (0, 100), "ramp": "radar",
                 "floor": 6.0, "every": 60},
    "posh":     {"path": "POSH", "label": "Prob. of Severe Hail",
                 "unit": "%", "range": (0, 100), "ramp": "heat",
                 "floor": 5.0, "every": 5},
    "shi":      {"path": "SHI", "label": "Severe Hail Index",
                 "unit": "", "range": (0, 200), "ramp": "heat",
                 "floor": 5.0, "every": 5},
    # Rotation tracks are a maximum held over a window, which is what makes
    # them a track. The instantaneous shear is a different question and the
    # one you watch while a storm is happening: this is what is rotating NOW
    # rather than what rotated at some point in the last hour.
    "azshear02": {"path": "MergedAzShear_0-2kmAGL",
                  "label": "AzShear 0-2 km (live)", "unit": "s^-1",
                  "range": (0.002, 0.014), "ramp": "heat",
                  "floor": 0.003, "every": 5},
    "azshear36": {"path": "MergedAzShear_3-6kmAGL",
                  "label": "AzShear 3-6 km (live)", "unit": "s^-1",
                  "range": (0.002, 0.014), "ramp": "heat",
                  "floor": 0.003, "every": 5},
    "rotation240": {"path": "RotationTrackML240min",
                    "label": "Rotation Tracks 4h", "unit": "s^-1",
                    "range": (0.002, 0.014), "ramp": "heat",
                    "floor": 0.003, "every": 30},
    "rotation360": {"path": "RotationTrackML360min",
                    "label": "Rotation Tracks 6h", "unit": "s^-1",
                    "range": (0.002, 0.014), "ramp": "heat",
                    "floor": 0.003, "every": 30},
    "rotationll120": {"path": "RotationTrack120min",
                      "label": "Low Level Rotation 2h", "unit": "s^-1",
                      "range": (0.002, 0.014), "ramp": "heat",
                      "floor": 0.003, "every": 15},
    "rotationll240": {"path": "RotationTrack240min",
                      "label": "Low Level Rotation 4h", "unit": "s^-1",
                      "range": (0.002, 0.014), "ramp": "heat",
                      "floor": 0.003, "every": 30},
    "rotationll1440": {"path": "RotationTrack1440min",
                       "label": "Low Level Rotation 24h", "unit": "s^-1",
                       "range": (0.002, 0.014), "ramp": "heat",
                       "floor": 0.003, "every": 60},
    "mesh240":  {"path": "MESH_Max_240min", "label": "Hail Swaths 4h",
                 "unit": "mm", "range": (0, 100), "ramp": "radar",
                 "floor": 6.0, "every": 30},
    "mesh360":  {"path": "MESH_Max_360min", "label": "Hail Swaths 6h",
                 "unit": "mm", "range": (0, 100), "ramp": "radar",
                 "floor": 6.0, "every": 30},
    # How much liquid is held up per kilometre of depth rather than in the
    # whole column. Density is the better hail signal of the two, because a
    # tall storm and a dense one both give a large VIL and only one of them
    # is throwing hail.
    "vildensity": {"path": "VIL_Density", "label": "VIL Density",
                   "unit": "g/m3", "range": (0, 8), "ramp": "heat",
                   "floor": 0.3, "every": 5},
    # How high a strong echo reaches above the freezing level. Hail grows in
    # the part of a storm that is both cold and full of water, so 50 dBZ
    # standing well above the minus twenty line is one of the cleanest hail
    # signatures the mosaic carries.
    "h50above0": {"path": "H50_Above_0C", "label": "50 dBZ above 0 C",
                  "unit": "km", "range": (0, 10), "ramp": "heat",
                  "floor": 0.2, "every": 5},
    "h50abovem20": {"path": "H50_Above_-20C", "label": "50 dBZ above -20 C",
                    "unit": "km", "range": (0, 8), "ramp": "heat",
                    "floor": 0.2, "every": 5},
    "h60above0": {"path": "H60_Above_0C", "label": "60 dBZ above 0 C",
                  "unit": "km", "range": (0, 8), "ramp": "heat",
                  "floor": 0.2, "every": 5},
    "h60abovem20": {"path": "H60_Above_-20C", "label": "60 dBZ above -20 C",
                    "unit": "km", "range": (0, 6), "ramp": "heat",
                    "floor": 0.2, "every": 5},
    # ── The national radar picture, merged from every site.
    "composite": {"path": "MergedReflectivityQCComposite",
                  "label": "Composite Reflectivity", "unit": "dBZ",
                  "range": (-10, 75), "ramp": "radar", "floor": 5.0, "every": 5},
    "lowalt":    {"path": "MergedReflectivityAtLowestAltitude",
                  "label": "Reflectivity, Lowest Altitude", "unit": "dBZ",
                  "range": (-10, 75), "ramp": "radar", "floor": 5.0, "every": 5},
    "baseqc":    {"path": "MergedBaseReflectivityQC",
                  "label": "Base Reflectivity (QC)", "unit": "dBZ",
                  "range": (-10, 75), "ramp": "radar", "floor": 5.0, "every": 5},
    "hsr":       {"path": "SeamlessHSR", "label": "Hybrid Scan Reflectivity",
                  "unit": "dBZ", "range": (-10, 75), "ramp": "radar",
                  "floor": 5.0, "every": 5},
    # Reflectivity at the temperatures that matter rather than at a height.
    # A forecaster does not ask "what is the echo at four kilometres", they
    # ask "how much of this storm is above freezing", because that is where
    # ice grows. The 0 C grid is also the top of the melting layer by
    # definition, so it is the seamless composite to read the bright band
    # against rather than through.
    "refl0c":   {"path": "Reflectivity_0C",
                 "label": "Reflectivity at 0 C (Melting Top)", "unit": "dBZ",
                 "range": (-10, 75), "ramp": "radar", "floor": 5.0, "every": 5},
    "reflm10c": {"path": "Reflectivity_-10C",
                 "label": "Reflectivity at -10 C", "unit": "dBZ",
                 "range": (-10, 75), "ramp": "radar", "floor": 5.0, "every": 5},
    "reflm20c": {"path": "Reflectivity_-20C",
                 "label": "Reflectivity at -20 C", "unit": "dBZ",
                 "range": (-10, 75), "ramp": "radar", "floor": 5.0, "every": 5},
    # Composites over a slab rather than the whole column. The low one is the
    # closest thing the mosaic has to what a single radar's lowest tilt sees,
    # without that radar's cone of silence overhead.
    "lowcomposite": {"path": "LowLevelCompositeReflectivity",
                     "label": "Low Level Composite", "unit": "dBZ",
                     "range": (-10, 75), "ramp": "radar", "floor": 5.0,
                     "every": 5},
    "layerlow":   {"path": "LayerCompositeReflectivity_Low",
                   "label": "Layer Composite, Low", "unit": "dBZ",
                   "range": (-10, 75), "ramp": "radar", "floor": 5.0, "every": 5},
    "layerhigh":  {"path": "LayerCompositeReflectivity_High",
                   "label": "Layer Composite, High", "unit": "dBZ",
                   "range": (-10, 75), "ramp": "radar", "floor": 5.0, "every": 15},
    "layersuper": {"path": "LayerCompositeReflectivity_Super",
                   "label": "Layer Composite, Highest", "unit": "dBZ",
                   "range": (-10, 75), "ramp": "radar", "floor": 5.0, "every": 15},
    # Where the hybrid scan is actually reading from. Useful for the same
    # reason a legend is: it says how much of what you are looking at is a
    # beam a hundred metres up and how much is one three kilometres up.
    "hsrheight": {"path": "SeamlessHSRHeight", "label": "Hybrid Scan Height",
                  "unit": "km", "range": (0, 12), "ramp": "viridis",
                  "floor": 0.05, "every": 15},
    # ── How tall the storms are, and how much they hold aloft.
    "echotop18": {"path": "EchoTop_18", "label": "Echo Top 18 dBZ",
                  "unit": "km", "range": (0, 20), "ramp": "viridis",
                  "floor": 0.5, "every": 5},
    "echotop30": {"path": "EchoTop_30", "label": "Echo Top 30 dBZ",
                  "unit": "km", "range": (0, 20), "ramp": "viridis",
                  "floor": 0.5, "every": 15},
    "echotop50": {"path": "EchoTop_50", "label": "Echo Top 50 dBZ",
                  "unit": "km", "range": (0, 20), "ramp": "viridis",
                  "floor": 0.5, "every": 5},
    "echotop60": {"path": "EchoTop_60", "label": "Echo Top 60 dBZ",
                  "unit": "km", "range": (0, 20), "ramp": "viridis",
                  "floor": 0.5, "every": 15},
    "vil":       {"path": "VIL", "label": "Vertically Integrated Liquid",
                  "unit": "kg/m2", "range": (0, 80), "ramp": "heat",
                  "floor": 0.5, "every": 5},
    "vii":       {"path": "VII", "label": "Vertically Integrated Ice",
                  "unit": "kg/m2", "range": (0, 50), "ramp": "heat",
                  "floor": 0.5, "every": 5},
    # ── What is falling, and how hard.
    "preciprate": {"path": "PrecipRate", "label": "Precip Rate",
                   "unit": "mm/hr", "range": (0, 50), "ramp": "precip",
                   "floor": 0.2, "every": 5},
    "preciptype": {"path": "PrecipFlag", "label": "Precip Type",
                   "unit": "", "range": (0, 10), "ramp": "viridis",
                   "floor": 0.5, "every": 5},
    # ── Rainfall totals. Slow moving by nature, so slow lanes.
    "qpe01": {"path": "RadarOnly_QPE_01H", "label": "Rainfall 1 hr",
              "unit": "mm", "range": (0, 50), "ramp": "precip",
              "floor": 0.3, "every": 15},
    "qpe03": {"path": "RadarOnly_QPE_03H", "label": "Rainfall 3 hr",
              "unit": "mm", "range": (0, 100), "ramp": "precip",
              "floor": 0.5, "every": 30},
    "qpe06": {"path": "RadarOnly_QPE_06H", "label": "Rainfall 6 hr",
              "unit": "mm", "range": (0, 150), "ramp": "precip",
              "floor": 0.5, "every": 30},
    "qpe12": {"path": "RadarOnly_QPE_12H", "label": "Rainfall 12 hr",
              "unit": "mm", "range": (0, 200), "ramp": "precip",
              "floor": 0.5, "every": 60},
    "qpe24": {"path": "RadarOnly_QPE_24H", "label": "Rainfall 24 hr",
              "unit": "mm", "range": (0, 250), "ramp": "precip",
              "floor": 0.5, "every": 60},
    "qpe72": {"path": "RadarOnly_QPE_72H", "label": "Rainfall 72 hr",
              "unit": "mm", "range": (0, 400), "ramp": "precip",
              "floor": 0.5, "every": 60},
    "qpe48": {"path": "RadarOnly_QPE_48H", "label": "Rainfall 48 hr",
              "unit": "mm", "range": (0, 350), "ramp": "precip",
              "floor": 0.5, "every": 60},
    "qpe12z": {"path": "RadarOnly_QPE_Since12Z",
               "label": "Rainfall since 12Z", "unit": "mm",
               "range": (0, 200), "ramp": "precip", "floor": 0.5, "every": 30},
    # Radar alone measures rain by inference; gauges measure it by catching
    # it. The multi-sensor products are the radar field pulled toward what the
    # gauges actually caught, which is the number a flood warning is written
    # from. Pass 2 is the later, better corrected one.
    "qpemulti01": {"path": "MultiSensor_QPE_01H_Pass2",
                   "label": "Rainfall 1 hr (gauge corrected)", "unit": "mm",
                   "range": (0, 50), "ramp": "precip", "floor": 0.3, "every": 15},
    "qpemulti03": {"path": "MultiSensor_QPE_03H_Pass2",
                   "label": "Rainfall 3 hr (gauge corrected)", "unit": "mm",
                   "range": (0, 100), "ramp": "precip", "floor": 0.5, "every": 30},
    "qpemulti06": {"path": "MultiSensor_QPE_06H_Pass2",
                   "label": "Rainfall 6 hr (gauge corrected)", "unit": "mm",
                   "range": (0, 150), "ramp": "precip", "floor": 0.5, "every": 30},
    "qpemulti12": {"path": "MultiSensor_QPE_12H_Pass2",
                   "label": "Rainfall 12 hr (gauge corrected)", "unit": "mm",
                   "range": (0, 200), "ramp": "precip", "floor": 0.5, "every": 60},
    "qpemulti24": {"path": "MultiSensor_QPE_24H_Pass2",
                   "label": "Rainfall 24 hr (gauge corrected)", "unit": "mm",
                   "range": (0, 250), "ramp": "precip", "floor": 0.5, "every": 60},
    "qpemulti72": {"path": "MultiSensor_QPE_72H_Pass2",
                   "label": "Rainfall 72 hr (gauge corrected)", "unit": "mm",
                   "range": (0, 400), "ramp": "precip", "floor": 0.5, "every": 60},
    # How unusual the rain is, rather than how much of it there was. Two
    # inches is a wet afternoon in Louisiana and a once in a decade event in
    # Arizona, and the recurrence interval is what tells those apart.
    "qpeari01": {"path": "QPE_ARI01H", "base": FLASH_BASE, "label": "1 hr rain, ARI",
                 "unit": "yr", "range": (0, 100), "ramp": "heat",
                 "floor": 1.0, "every": 15},
    "qpeari03": {"path": "QPE_ARI03H", "base": FLASH_BASE, "label": "3 hr rain, ARI",
                 "unit": "yr", "range": (0, 100), "ramp": "heat",
                 "floor": 1.0, "every": 30},
    "qpeari06": {"path": "QPE_ARI06H", "base": FLASH_BASE, "label": "6 hr rain, ARI",
                 "unit": "yr", "range": (0, 100), "ramp": "heat",
                 "floor": 1.0, "every": 30},
    "qpeari12": {"path": "QPE_ARI12H", "base": FLASH_BASE, "label": "12 hr rain, ARI",
                 "unit": "yr", "range": (0, 100), "ramp": "heat",
                 "floor": 1.0, "every": 60},
    "qpeari24": {"path": "QPE_ARI24H", "base": FLASH_BASE, "label": "24 hr rain, ARI",
                 "unit": "yr", "range": (0, 100), "ramp": "heat",
                 "floor": 1.0, "every": 60},
    # ── Lightning.
    "ltgprob30": {"path": "LightningProbabilityNext30minGrid",
                  "label": "Lightning Prob. 30 min", "unit": "%",
                  "range": (0, 100), "ramp": "heat", "floor": 5.0, "every": 5},
    "ltgprob60": {"path": "LightningProbabilityNext60minGrid",
                  "label": "Lightning Prob. 60 min", "unit": "%",
                  "range": (0, 100), "ramp": "heat", "floor": 5.0, "every": 5},
    "ltgdensity": {"path": "NLDN_CG_030min_AvgDensity",
                   "label": "Lightning Density 30 min", "unit": "fl/km2/min",
                   "range": (0, 10), "ramp": "heat", "floor": 0.05, "every": 5},
    "ltgdensity1": {"path": "NLDN_CG_001min_AvgDensity",
                    "label": "Lightning Density 1 min", "unit": "fl/km2/min",
                    "range": (0, 5), "ramp": "heat", "floor": 0.02, "every": 5},
    # A lightning jump is a sudden rise in flash rate, and it tends to come
    # before a storm turns severe rather than after. That makes it one of the
    # few genuinely leading signals in the whole mosaic.
    "ltgdensity5": {"path": "NLDN_CG_005min_AvgDensity",
                    "label": "Lightning Density 5 min", "unit": "fl/km2/min",
                    "range": (0, 8), "ramp": "heat", "floor": 0.02, "every": 5},
    "ltgdensity15": {"path": "NLDN_CG_015min_AvgDensity",
                     "label": "Lightning Density 15 min", "unit": "fl/km2/min",
                     "range": (0, 10), "ramp": "heat", "floor": 0.03, "every": 5},
    "ltgjump": {"path": "LtgJumpGrid", "label": "Lightning Jump",
                "unit": "", "range": (0, 10), "ramp": "heat",
                "floor": 0.5, "every": 5},
    # ── Winter and the melting layer: where rain becomes snow, and the
    # temperatures that decide it. These are the signed ones.
    "brightband": {"path": "BrightBandTopHeight", "label": "Melting Layer Top",
                   "unit": "m", "range": (0, 5000), "ramp": "viridis",
                   "floor": 1.0, "every": 15},
    # The bottom of the melting layer matters as much as the top: rain
    # reaching the ground rather than snow depends on how far below the layer
    # the ground is, and the top alone does not say that.
    # ── Flooding, which radar only answers half of ─────────────────────
    #
    # Rainfall is not flooding. An inch on dry sand does nothing and an inch
    # on saturated clay above a small catchment is a wall of water, so the
    # question a flood warning turns on is what the ground DOES with the rain
    # rather than how much of it fell.
    #
    # FLASH runs three hydrologic models on the MRMS rainfall and publishes
    # the answers: CREST and SAC route water through soil and channels and
    # can say how saturated the ground already is, and Hydrophobic assumes
    # none of it soaks in at all, which is the worst case and the fastest to
    # believe on burn scars and pavement.
    #
    # Unit streamflow is streamflow divided by catchment area, and it is the
    # one to compare between places: raw streamflow is always largest on the
    # biggest river whether or not anything unusual is happening.
    #
    # These live under a different NOAA directory from the 2D mosaics, which
    # is what the "base" key is for.
    "crestflow": {"path": "CREST_MAXSTREAMFLOW", "base": FLASH_BASE,
                  "label": "CREST Streamflow", "unit": "m3/s",
                  "range": (0, 500), "ramp": "precip", "floor": 1.0, "every": 15},
    "crestunit": {"path": "CREST_MAXUNITSTREAMFLOW", "base": FLASH_BASE,
                  "label": "CREST Unit Streamflow", "unit": "m3/s/km2",
                  "range": (0, 5), "ramp": "heat", "floor": 0.05, "every": 15},
    "crestsoil": {"path": "CREST_MAXSOILSAT", "base": FLASH_BASE,
                  "label": "CREST Soil Saturation", "unit": "%",
                  "range": (0, 100), "ramp": "moisture", "floor": 1.0,
                  "every": 30},
    "sacflow":   {"path": "SAC_MAXSTREAMFLOW", "base": FLASH_BASE,
                  "label": "SAC Streamflow", "unit": "m3/s",
                  "range": (0, 500), "ramp": "precip", "floor": 1.0, "every": 15},
    "sacunit":   {"path": "SAC_MAXUNITSTREAMFLOW", "base": FLASH_BASE,
                  "label": "SAC Unit Streamflow", "unit": "m3/s/km2",
                  "range": (0, 5), "ramp": "heat", "floor": 0.05, "every": 15},
    "sacsoil":   {"path": "SAC_MAXSOILSAT", "base": FLASH_BASE,
                  "label": "SAC Soil Saturation", "unit": "%",
                  "range": (0, 100), "ramp": "moisture", "floor": 1.0,
                  "every": 30},
    "hpflow":    {"path": "HP_MAXSTREAMFLOW", "base": FLASH_BASE,
                  "label": "Hydrophobic Streamflow", "unit": "m3/s",
                  "range": (0, 500), "ramp": "precip", "floor": 1.0, "every": 15},
    "hpunit":    {"path": "HP_MAXUNITSTREAMFLOW", "base": FLASH_BASE,
                  "label": "Hydrophobic Unit Streamflow", "unit": "m3/s/km2",
                  "range": (0, 5), "ramp": "heat", "floor": 0.05, "every": 15},
    "brightbandbot": {"path": "BrightBandBottomHeight",
                      "label": "Melting Layer Bottom", "unit": "m",
                      "range": (0, 5000), "ramp": "viridis",
                      "floor": 1.0, "every": 15},
    "sfctemp": {"path": "Model_SurfaceTemp", "label": "Surface Temp (model)",
                "unit": "C", "range": (-40, 45), "ramp": "temp",
                "floor": -1e9, "signed": True, "every": 15},
    "wetbulb": {"path": "Model_WetBulbTemp", "label": "Wet Bulb Temp (model)",
                "unit": "C", "range": (-40, 45), "ramp": "temp",
                "floor": -1e9, "signed": True, "every": 15},
    "h0c": {"path": "Model_0degC_Height", "label": "Freezing Level",
            "unit": "m", "range": (0, 5000), "ramp": "viridis",
            "floor": 1.0, "every": 15},
    # ── Added after enumerating NOAA's own MRMS bucket (noaa-mrms-pds) and
    # diffing it against this table. Everything below is a product MRMS
    # genuinely publishes and this pipeline was not asking for.
    #
    # The NCEP web server drops the elevation suffix the bucket carries, so
    # RotationTrackML60min_00.50 in the bucket is RotationTrackML60min here;
    # the three-dimensional stacks keep theirs because the suffix is the only
    # thing telling one altitude from another. A path that turns out wrong
    # costs one logged line and a skip, and --check names it.

    # Reflectivity by altitude. The mosaic is really a stack of them and only
    # the composite was ever being read, which is the whole column flattened
    # to its strongest echo. These are the slices behind it: watching a core
    # sit at 6 km and then descend is what a composite cannot show you.
    "refl3d05": {"path": "MergedReflectivityQC_00.50", "base": REFL3D_BASE,
                 "range": (-10, 75), "ramp": "radar", "unit": "dBZ",
                 "label": "Reflectivity 0.5 km", "every": 10},
    "refl3d1": {"path": "MergedReflectivityQC_01.00", "base": REFL3D_BASE,
                "range": (-10, 75), "ramp": "radar", "unit": "dBZ",
                "label": "Reflectivity 1 km", "every": 10},
    "refl3d2": {"path": "MergedReflectivityQC_02.00", "base": REFL3D_BASE,
                "range": (-10, 75), "ramp": "radar", "unit": "dBZ",
                "label": "Reflectivity 2 km", "every": 10},
    "refl3d3": {"path": "MergedReflectivityQC_03.00", "base": REFL3D_BASE,
                "range": (-10, 75), "ramp": "radar", "unit": "dBZ",
                "label": "Reflectivity 3 km", "every": 10},
    "refl3d4": {"path": "MergedReflectivityQC_04.00", "base": REFL3D_BASE,
                "range": (-10, 75), "ramp": "radar", "unit": "dBZ",
                "label": "Reflectivity 4 km", "every": 15},
    "refl3d6": {"path": "MergedReflectivityQC_06.00", "base": REFL3D_BASE,
                "range": (-10, 75), "ramp": "radar", "unit": "dBZ",
                "label": "Reflectivity 6 km", "every": 15},
    "refl3d8": {"path": "MergedReflectivityQC_08.00", "base": REFL3D_BASE,
                "range": (-10, 75), "ramp": "radar", "unit": "dBZ",
                "label": "Reflectivity 8 km", "every": 15},
    "refl3d10": {"path": "MergedReflectivityQC_10.00", "base": REFL3D_BASE,
                 "range": (-10, 75), "ramp": "radar", "unit": "dBZ",
                 "label": "Reflectivity 10 km", "every": 30},
    "refl3d12": {"path": "MergedReflectivityQC_12.00", "base": REFL3D_BASE,
                 "range": (-10, 75), "ramp": "radar", "unit": "dBZ",
                 "label": "Reflectivity 12 km", "every": 30},

    # National dual-pol. Nothing here had either of these before, at any
    # altitude: differential reflectivity tells big flat drops from small
    # round ones, and correlation tells rain from debris and hail.
    "zdr3d05": {"path": "MergedZdr_00.50", "base": REFL3D_BASE,
                "range": (-2, 6), "ramp": "spread", "unit": "dB",
                "label": "Differential Refl 0.5 km", "signed": True, "every": 10},
    "zdr3d2": {"path": "MergedZdr_02.00", "base": REFL3D_BASE,
               "range": (-2, 6), "ramp": "spread", "unit": "dB",
               "label": "Differential Refl 2 km", "signed": True, "every": 15},
    "zdr3d4": {"path": "MergedZdr_04.00", "base": REFL3D_BASE,
               "range": (-2, 6), "ramp": "spread", "unit": "dB",
               "label": "Differential Refl 4 km", "signed": True, "every": 30},
    "rhohv3d05": {"path": "MergedRhoHV_00.50", "base": REFL3D_BASE,
                  "range": (0.5, 1.05), "ramp": "viridis", "unit": "",
                  "label": "Correlation 0.5 km", "every": 10},
    "rhohv3d2": {"path": "MergedRhoHV_02.00", "base": REFL3D_BASE,
                 "range": (0.5, 1.05), "ramp": "viridis", "unit": "",
                 "label": "Correlation 2 km", "every": 15},
    "rhohv3d4": {"path": "MergedRhoHV_04.00", "base": REFL3D_BASE,
                 "range": (0.5, 1.05), "ramp": "viridis", "unit": "",
                 "label": "Correlation 4 km", "every": 30},

    # The two isotherm slices that were missing. Reflectivity at the level
    # where the air is a given temperature is how hail growth is judged:
    # 50 dBZ at -20 C is a very different storm from 50 dBZ at the ground.
    "reflm5c": {"path": "Reflectivity_-5C", "range": (-10, 75), "ramp": "radar",
                "unit": "dBZ", "label": "Reflectivity at -5C", "every": 10},
    "reflm15c": {"path": "Reflectivity_-15C", "range": (-10, 75), "ramp": "radar",
                 "unit": "dBZ", "label": "Reflectivity at -15C", "every": 10},
    "refllowest": {"path": "ReflectivityAtLowestAltitude", "range": (-10, 75),
                   "ramp": "radar", "unit": "dBZ",
                   "label": "Reflectivity Lowest Altitude", "every": 5},

    # An hour of maxima, which is the cheapest way to see where a line has
    # already been rather than only where it is now.
    "brefmax1h": {"path": "BREF_1HR_MAX", "range": (-10, 75), "ramp": "radar",
                  "unit": "dBZ", "label": "Base Refl 1h Max", "every": 10},
    "crefmax1h": {"path": "CREF_1HR_MAX", "range": (-10, 75), "ramp": "radar",
                  "unit": "dBZ", "label": "Composite Refl 1h Max", "every": 10},

    # Heights rather than intensities: how high the composite echo came from.
    "heightcomposite": {"path": "HeightCompositeReflectivity", "range": (0, 18),
                        "ramp": "viridis", "unit": "km",
                        "label": "Height of Composite Refl", "every": 10},
    "heightlowcomposite": {"path": "HeightLowLevelCompositeReflectivity",
                           "range": (0, 6), "ramp": "viridis", "unit": "km",
                           "label": "Height of Low-Level Composite", "every": 10},

    # The Level 3 style national grids, which are a different algorithm from
    # the mosaic versions above and worth being able to compare against.
    "hreet": {"path": "LVL3_HREET", "range": (0, 70), "ramp": "viridis",
              "unit": "kft", "label": "High Res Echo Tops", "every": 10},
    "hiresvil": {"path": "LVL3_HighResVIL", "range": (0, 80), "ramp": "heat",
                 "unit": "kg/m2", "label": "High Res VIL", "every": 10},
    "vilmax120": {"path": "VIL_Max_120min", "range": (0, 80), "ramp": "heat",
                  "unit": "kg/m2", "label": "VIL 2h Max", "every": 15},
    "vilmax1440": {"path": "VIL_Max_1440min", "range": (0, 80), "ramp": "heat",
                   "unit": "kg/m2", "label": "VIL 24h Max", "every": 60},

    # Warm rain, which falls hard without ever making ice and so without ever
    # looking impressive on reflectivity. It is a common flash flood setup.
    "warmrain": {"path": "WarmRainProbability", "range": (0, 100),
                 "ramp": "viridis", "unit": "%",
                 "label": "Warm Rain Probability", "every": 10},

    # How much to believe the mosaic where you are standing: beam blockage,
    # distance from the nearest radar, gauge agreement.
    "rqi": {"path": "RadarQualityIndex", "range": (0, 1), "ramp": "viridis",
            "unit": "", "label": "Radar Quality Index", "every": 30},
    "raqi01": {"path": "RadarAccumulationQualityIndex_01H", "range": (0, 1),
               "ramp": "viridis", "unit": "",
               "label": "Accum Quality 1 hr", "every": 30},
    "raqi24": {"path": "RadarAccumulationQualityIndex_24H", "range": (0, 1),
               "ramp": "viridis", "unit": "",
               "label": "Accum Quality 24 hr", "every": 60},

    # Rainfall against the threshold that actually issues a flood warning.
    # Above 1.0 is rain exceeding the guidance, which is the number a
    # forecaster is watching rather than the raw total.
    "ffg01": {"path": "QPE_FFG01H", "base": FLASH_BASE, "range": (0, 2),
              "ramp": "precip", "unit": "ratio",
              "label": "Rain vs Flood Guidance 1 hr", "every": 10},
    "ffg03": {"path": "QPE_FFG03H", "base": FLASH_BASE, "range": (0, 2),
              "ramp": "precip", "unit": "ratio",
              "label": "Rain vs Flood Guidance 3 hr", "every": 15},
    "ffg06": {"path": "QPE_FFG06H", "base": FLASH_BASE, "range": (0, 2),
              "ramp": "precip", "unit": "ratio",
              "label": "Rain vs Flood Guidance 6 hr", "every": 15},
    "ffgmax": {"path": "QPE_FFGMAX", "base": FLASH_BASE, "range": (0, 2),
               "ramp": "precip", "unit": "ratio",
               "label": "Rain vs Flood Guidance Max", "every": 10},
    "ari30m": {"path": "QPE_ARI30M", "base": FLASH_BASE, "range": (0, 100),
               "ramp": "precip", "unit": "yr",
               "label": "Recurrence Interval 30 min", "every": 10},
    "arimax": {"path": "QPE_ARIMAX", "base": FLASH_BASE, "range": (0, 100),
               "ramp": "precip", "unit": "yr",
               "label": "Recurrence Interval Max", "every": 10},

    # 15 minute radar rainfall, the shortest accumulation MRMS publishes.
    "qpe15m": {"path": "RadarOnly_QPE_15M", "range": (0, 25), "ramp": "precip",
               "unit": "mm", "label": "Radar Rainfall 15 min", "every": 5},

    # Lightning jump: a sudden climb in flash rate, which often runs a few
    # minutes ahead of a storm turning severe.
    "ltgjumpmax": {"path": "LtgJumpGrid_Max_005min", "range": (0, 10),
                   "ramp": "heat", "unit": "sigma",
                   "label": "Lightning Jump 5m Max", "every": 5},

    # What kind of precipitation the algorithm thinks it is, before the
    # gauges get a say, and the first-pass multi-sensor totals.
    "synthprecipid": {"path": "SyntheticPrecipRateID", "range": (0, 10),
                      "ramp": "viridis", "unit": "class",
                      "label": "Synthetic Precip Type", "every": 10},
    "qpemultip1_01": {"path": "MultiSensor_QPE_01H_Pass1", "range": (0, 50),
                      "ramp": "precip", "unit": "mm",
                      "label": "Multi-Sensor 1 hr (pass 1)", "every": 15},
    "qpemultip1_24": {"path": "MultiSensor_QPE_24H_Pass1", "range": (0, 200),
                      "ramp": "precip", "unit": "mm",
                      "label": "Multi-Sensor 24 hr (pass 1)", "every": 60},
    "gaugeinfl01": {"path": "GaugeInflIndex_01H_Pass2", "range": (0, 1),
                    "ramp": "viridis", "unit": "",
                    "label": "Gauge Influence 1 hr", "every": 30},
    "gaugeinfl24": {"path": "GaugeInflIndex_24H_Pass2", "range": (0, 1),
                    "ramp": "viridis", "unit": "",
                    "label": "Gauge Influence 24 hr", "every": 60},


}


def _mrms_read(url):
    """One MRMS grib: (array, south, north, west, east), or None."""
    import gzip
    import tempfile

    import eccodes

    r = HTTP.get(url, timeout=90)
    if r.status_code != 200 or len(r.content) < 500:
        log(f"  mrms: HTTP {r.status_code} for {url.rsplit('/', 1)[-1]}")
        return None
    raw = gzip.decompress(r.content)
    with tempfile.NamedTemporaryFile(suffix=".grib2", delete=False) as tf:
        tf.write(raw)
        tmp = tf.name
    del raw
    try:
        with open(tmp, "rb") as fh:
            gid = eccodes.codes_grib_new_from_file(fh)
            if gid is None:
                return None
            try:
                ni = int(eccodes.codes_get(gid, "Ni"))
                nj = int(eccodes.codes_get(gid, "Nj"))
                lat1 = float(eccodes.codes_get(
                    gid, "latitudeOfFirstGridPointInDegrees"))
                lat2 = float(eccodes.codes_get(
                    gid, "latitudeOfLastGridPointInDegrees"))
                lon1 = float(eccodes.codes_get(
                    gid, "longitudeOfFirstGridPointInDegrees"))
                lon2 = float(eccodes.codes_get(
                    gid, "longitudeOfLastGridPointInDegrees"))
                vals = eccodes.codes_get_values(gid)
            finally:
                eccodes.codes_release(gid)
        # float32 immediately: the full CONUS grid is 24.5 million points and
        # the float64 eccodes hands over is 200MB this board will miss.
        arr = np.asarray(vals, dtype=np.float32).reshape(nj, ni)
        del vals
        lon1, lon2 = ((lon1 + 180) % 360) - 180, ((lon2 + 180) % 360) - 180
        south, north = min(lat1, lat2), max(lat1, lat2)
        # First grid row is the north edge, which is also image row 0.
        if lat1 < lat2:
            arr = arr[::-1]
        return arr, south, north, lon1, lon2
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def _mrms_state_path():
    return os.path.join(OUT_DIR, "mrms", "state.json")


def _mrms_load_state():
    try:
        with open(_mrms_state_path(), "r") as fh:
            s = json.load(fh)
        return s if isinstance(s, dict) else {}
    except Exception:
        return {}


def _mrms_due(name, spec, state, now):
    """Whether this product should be fetched on this pass.

    The catalogue is large and the timer fires every five minutes, so pulling
    everything every time would be most of a gigabyte an hour for grids that
    mostly change slowly. Each product carries a wanted cadence, and this adds
    the adaptive half on top: a product that keeps failing backs itself off
    rather than being retried into the ground every pass, and one that costs a
    lot of wall clock is stretched out so it cannot crowd the radar build it
    shares a timer with. Both recover on their own once the product does.
    """
    st = state.get(name) or {}
    want = float(spec.get("every", 5))
    # A run of failures pushes the retry out, doubling each time, to an hour.
    fails = int(st.get("fails", 0))
    if fails:
        want = max(want, min(60.0, 5.0 * (2 ** min(fails, 4))))
    # A product that took a long while last time is asked for less often. The
    # radar frames share this timer and matter more than any single mosaic.
    secs = float(st.get("secs", 0) or 0)
    if secs > 20:
        want = max(want, 15.0)
    if secs > 45:
        want = max(want, 30.0)
    last = st.get("last")
    if not last:
        return True
    try:
        prev = datetime.fromisoformat(last)
    except ValueError:
        return True
    if prev.tzinfo is None:
        prev = prev.replace(tzinfo=timezone.utc)
    return (now - prev).total_seconds() >= want * 60.0


def _mrms_walk_order(order, state):
    """The order this pass walks the catalogue in.

    Two rules, and they are the whole of the pipeline's fairness.

    First, start where the last pass stopped. A budget that runs out half way
    through, walked from the top every time, means the second half of the
    catalogue is never built at all: those products would not exist rather
    than being slow.

    Second, anything never yet built goes to the front. The menu is drawn from
    the manifest and the manifest only carries what has been built, so a
    product waiting its turn does not exist as far as the page is concerned.
    With a rotating cursor and a per-pass ceiling a catalogue this size takes
    most of an hour to come round once, and for that hour the menu looks
    broken rather than busy. Refreshing something already on screen is worth
    less than putting something on screen for the first time. In the steady
    state this set is empty and the rotation is exactly as it was.

    "built" rather than "last": the failure path also stamps "last", so keying
    off that meant one failed attempt promoted a product out of the never-built
    set and back into the slow rotation, with the failure backoff then
    stretching its next try to an hour. A product that failed once early could
    take most of a day to appear, which from the outside is indistinguishable
    from it not being in the catalogue.

    Pulled out of build_mrms so it can be read, and tested, on its own.
    """
    if not order:
        return []
    start = int((state.get("__cursor__") or {}).get("at", 0)) % len(order)
    names = order[start:] + order[:start]
    never = [n for n in names if not (state.get(n) or {}).get("built")]
    if not never:
        return names
    seen = set(never)
    return never + [n for n in names if n not in seen]


def build_mrms():
    """Every due product into OUT_DIR/mrms, plus the manifest the page reads.

    Products not due on this pass keep their previous entry in the manifest,
    so the page still sees the picture already on disk rather than the layer
    vanishing between builds.
    """
    out = os.path.join(OUT_DIR, "mrms")
    os.makedirs(out, exist_ok=True)
    now = datetime.now(timezone.utc)
    state = _mrms_load_state()
    # Carry forward what was built before, so a slow-lane product stays
    # available on the passes it is not rebuilt.
    prev_man = {}
    try:
        with open(os.path.join(out, "mrms.json"), "r") as fh:
            prev_man = (json.load(fh) or {}).get("products") or {}
    except Exception:
        prev_man = {}
    man = {"updated": now.isoformat(), "products": dict(prev_man)}
    built = 0

    # A budget for the pass, and a rotating start so it is fair.
    #
    # The catalogue is seventy products now, and about half of them want
    # rebuilding every five minutes, which is the same five minutes the radar
    # frames are built in. Without a ceiling one busy pass would spend the
    # whole window downloading mosaics and the radar loop would simply have a
    # hole in it, which is far worse than a mosaic being five minutes stale.
    #
    # The cursor is what makes the ceiling fair. Walking the catalogue from
    # the top every time means a budget that runs out half way through leaves
    # the second half never built at all: the products at the end would not
    # exist rather than being slow. Starting where the last pass stopped means
    # everything comes round.
    order = list(MRMS_PRODUCTS)
    names = _mrms_walk_order(order, state)

    pass_started = time.time()
    # Only used if the loop body never runs at all. Every path that ends the
    # pass early sets it from the catalogue's own order, and finishing the
    # whole catalogue sets it to zero in the for/else below.
    stopped_at = 0

    for i, name in enumerate(names):
        spec = MRMS_PRODUCTS[name]
        if built >= MRMS_PASS_MAX or (time.time() - pass_started) > MRMS_PASS_SECS:
            # Off the catalogue's own order, not off the walk position.
            # `names` has been rotated once and then reordered again to put
            # never-built products first, so (start + i) had stopped pointing
            # at `name` some time ago: the cursor named an unrelated product
            # and the rotation quietly skipped whole runs of the catalogue,
            # which is the opposite of the fairness it exists for.
            stopped_at = order.index(name)
            log(f"mrms: pass budget reached after {built} products, "
                f"resuming at {name} next time")
            break
        if not _mrms_due(name, spec, state, now):
            continue
        if not disk_ok(out):
            log(f"mrms: only {free_mb(out):.0f} MB free, skipping the rest of "
                "this pass. Frames will be pruned harder until there is room.")
            stopped_at = order.index(name)
            break
        base = spec.get("base", MRMS_BASE)
        url = f"{base}/{spec['path']}/MRMS_{spec['path']}.latest.grib2.gz"
        t0 = time.time()
        # One product, one guard, and it covers the whole of building it.
        #
        # This used to wrap the download alone, which is only the failure that
        # was thought of in advance. Everything after it - a catalogue entry
        # missing a key, a grid whose shape the reshape cannot take, a palette
        # name with no table, a disk that fills between the check and the save
        # - threw straight out of build_mrms and ended the pass, so one bad
        # product took every product after it down with it. A pipeline that
        # builds a hundred and twenty-nine independent things should lose one
        # of them at a time.
        failed = None
        try:
            got = _mrms_read(url)
            if not got:
                raise RuntimeError("no grid came back")
            arr, south, north, west, east = got
            # MRMS writes -1 and -3 for missing and out of coverage. On a product
            # where negative readings are real - temperature above all - that
            # would erase half the map, so those opt out.
            if spec.get("signed"):
                arr[arr < -900] = np.nan
            else:
                arr[arr < 0] = np.nan
            # Halve the grid by taking each 2x2 block's maximum, not by slicing.
            # A rotation track is a filament one or two cells wide, and plain
            # slicing deletes every filament that falls on a dropped row; these
            # are both maximum-over-time products, so the block maximum is the
            # honest way to shrink them.
            nj, ni = arr.shape
            with np.errstate(all="ignore"):
                import warnings
                with warnings.catch_warnings():
                    # A 2x2 block that is entirely out of coverage is all NaN, and
                    # nanmax warning about each one would flood the log for what
                    # is the ordinary state of most of the grid.
                    warnings.simplefilter("ignore", RuntimeWarning)
                    arr = np.nanmax(
                        arr[:nj - nj % 2, :ni - ni % 2]
                        .reshape(nj // 2, 2, ni // 2, 2), axis=(1, 3))
            lo, hi = spec["range"]
            norm = (arr - lo) / float(hi - lo)
            # A product's own floor is optional, and forty-three of them do not
            # carry one. spec["floor"] raised KeyError on the first of those, and
            # nothing in this loop caught it, so the exception left build_mrms
            # entirely and took every remaining product in the pass with it. A
            # third of the catalogue could not be built at all, and the symptom
            # was a menu that was simply short rather than an error anywhere.
            #
            # No floor means no extra floor: keep every real reading and let the
            # palette's own first band decide what gets painted, which is what
            # band_alpha below is for.
            floor = spec.get("floor")
            keep = np.isfinite(arr)
            if floor is not None:
                keep &= (arr >= floor)
            idx = np.clip(np.nan_to_num(norm) * 255.0, 0, 255).astype(np.uint8)
            rgb = lut_for(spec["ramp"], lo, hi)[idx]
            alpha = np.where(keep, 205, 0).astype(np.uint8)
            # MRMS already declares a floor per product, which is the one to keep
            # where it is stricter. This adds the palette's own: a reading below
            # the first band has no colour of its own and would be painted in the
            # first band's, which is how a whole state ends up washed pale blue.
            band_alpha(spec["ramp"], idx, alpha, lo, hi)
            del arr, norm, keep, idx
            # One folder per scan, named for the time it was built, exactly the
            # way the radar frames and the satellite composites are. MRMS used to
            # overwrite a single PNG per product, which meant the page could only
            # ever show "now": an overwritten file is not a loop, and there is no
            # way to animate one frame.
            fdir = now.strftime("%Y%m%d_%H%M%S")
            fout = os.path.join(out, fdir)
            os.makedirs(fout, exist_ok=True)
            path = os.path.join(fout, f"{name}.png")
            Image.fromarray(np.dstack([rgb, alpha]), mode="RGBA").save(
                path, optimize=True)
            del rgb, alpha
            man["products"][name] = {
                "file": f"{fdir}/{name}.png", "label": spec["label"],
                "unit": spec["unit"], "min": lo, "max": hi,
                "bounds": [[south, west], [north, east]],
                "built": now.isoformat(),
            }
            built += 1
            secs = round(time.time() - t0, 1)
            state[name] = {"last": now.isoformat(), "built": now.isoformat(),
                           "fails": 0, "secs": secs}
            log(f"  mrms {name}: built in {secs}s")
        except Exception as e:
            failed = e
        if failed is not None:
            log(f"  mrms {name}: {failed}")
            st = state.get(name) or {}
            st["fails"] = int(st.get("fails", 0)) + 1
            st["last"] = now.isoformat()
            st["secs"] = round(time.time() - t0, 1)
            state[name] = st
            continue
    else:
        # The loop finished without hitting the budget, so the whole
        # catalogue was considered and the next pass starts from the top.
        stopped_at = 0
    state["__cursor__"] = {"at": stopped_at}
    _mrms_prune(out)

    # The frame list is read back off the disk rather than appended to as
    # frames are written, so a frame that was pruned, or one that failed to
    # save, can never be advertised to the page as something it can load.
    for name, meta in list(man["products"].items()):
        frames = _mrms_frames(out, name)
        if not frames:
            # Nothing of this product survives, so stop offering it rather
            # than pointing the page at a file that is gone.
            man["products"].pop(name, None)
            continue
        meta["frames"] = frames
        meta["latest"] = frames[-1]["t"]
        meta["file"] = frames[-1]["file"]
    man["keep_hours"] = MRMS_KEEP_HOURS

    # Written even when it is empty. The guard here used to skip the write in
    # that case, which sounds protective and is not: this manifest is rebuilt
    # from what is actually on disk, so empty means nothing survived, and
    # leaving the previous one in place points the page at files that were
    # pruned an hour ago. A menu of layers that all 404 is worse than an
    # honest empty one.
    write_json(os.path.join(out, "mrms.json"), man)
    try:
        write_json(_mrms_state_path(), state)
    except Exception as e:
        log(f"  mrms: could not write state: {e}")
    total = sum(len(p.get("frames") or []) for p in man["products"].values())
    log(f"  mrms: {built} built this pass, {len(man['products'])} available, "
        f"{total} frames on disk")
    return built


def _mrms_frames(out, name):
    """Every frame of one MRMS product still on disk, oldest first."""
    frames = []
    if not os.path.isdir(out):
        return frames
    for d in sorted(os.listdir(out)):
        if not d[:1].isdigit():
            continue
        if os.path.exists(os.path.join(out, d, f"{name}.png")):
            frames.append({"t": d, "file": f"{d}/{name}.png"})
    return frames


def _mrms_prune(out, hours=None):
    """Drop MRMS frame folders past the retention window.

    Thirty-eight products across three days is a great many small files, so
    this also enforces a ceiling on how many frames any one product keeps.
    The cadence tiers mean a five-minute product would otherwise hold eight
    hundred and sixty four frames while an hourly one holds seventy two, and
    the fast ones are where the card actually fills.
    """
    if not os.path.isdir(out):
        return
    import shutil
    hours = MRMS_KEEP_HOURS if hours is None else hours
    hours = hours_for_disk(out, hours)
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    dirs = []
    for d in sorted(os.listdir(out)):
        full = os.path.join(out, d)
        if not (os.path.isdir(full) and d[:1].isdigit()):
            continue
        try:
            when = datetime.strptime(d, "%Y%m%d_%H%M%S").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if when < cutoff:
            shutil.rmtree(full, ignore_errors=True)
        else:
            dirs.append(full)
    # Then the ceiling, oldest first, whatever their age.
    if len(dirs) > MRMS_MAX_FRAMES:
        for full in dirs[:len(dirs) - MRMS_MAX_FRAMES]:
            shutil.rmtree(full, ignore_errors=True)


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
    any_missing = False
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
        specs = TDWR_L3_PRODUCTS if is_tdwr(site) else L3_PRODUCTS
        for pname, spec in specs.items():
            try:
                if is_tdwr(site):
                    # The bucket has no sn.last; existence is a listing with
                    # at least one key under today's prefix.
                    sid = site.upper()[1:]
                    day = datetime.now(timezone.utc)
                    keys = s3_list(L3_BUCKET,
                                   f"{sid}_{spec['code']}_{day:%Y_%m_%d}_",
                                   pages=1, limit=1)
                    (good if keys else bad).append(
                        pname if keys else f"{pname}(empty)")
                else:
                    url = f"{L3_TGFTP}/{spec['dir']}/SI.{site.lower()}/sn.last"
                    r = HTTP.head(url, timeout=30, allow_redirects=True)
                    (good if r.status_code == 200 else bad).append(
                        pname if r.status_code == 200 else f"{pname}({r.status_code})")
            except Exception:
                bad.append(f"{pname}(net)")
        print(f"  {site}  L3  {len(good)}/{len(specs)} products: "
              f"{', '.join(good) or 'none'}")
        if bad:
            any_missing = True
            print(f"        missing: {', '.join(bad)}")
        if not good:
            ok = False
    # When a directory guess is wrong, stop guessing and ask the server for
    # its real list. One request, printed once, and the next fix is a rename
    # backed by evidence instead of another guess.
    if any_missing:
        try:
            r = HTTP.get(f"{L3_TGFTP}/", timeout=30)
            names = sorted(set(re.findall(r"DS\.[a-z0-9]+", r.text)))
            if names:
                print("  the server's own product directories, for the record:")
                for i in range(0, len(names), 8):
                    print("    " + "  ".join(names[i:i + 8]))
        except Exception as e:
            print(f"  could not list the product directories: {e}")
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

    # Level 3 covers every terminal on the map, not just the configured
    # sites, unless sites were named on the command line and meant exactly.
    explicit = any(not a.startswith("-") and len(a) == 4 for a in argv)
    if level3 and not explicit:
        sites = sites + [t for t in TDWR_SITES if t not in sites]

    if level3:
        # Six small fetches per site, forty-odd sites: the network waits are
        # the whole cost, so they overlap. Decode and render inside each
        # worker are numpy and PIL, which release the interpreter lock, so
        # the threads genuinely help rather than queueing on it.
        from concurrent.futures import ThreadPoolExecutor
        def one(site):
            try:
                build_site_l3(site, frames=frames)
            except Exception as e:
                log(f"{site}: failed: {e}")
        with ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(one, sites))
    else:
        for site in sites:
            try:
                build_site_l2(site, frames=frames)
            except Exception as e:
                log(f"{site}: failed: {e}")
    idx = write_index(3 if level3 else 2, sites)
    # National severe products ride the Level 2 pass, so they refresh on the
    # same five minute cadence without another unit or timer existing.
    if not level3:
        try:
            build_mrms()
        except Exception as e:
            log(f"mrms: failed: {e}")
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
