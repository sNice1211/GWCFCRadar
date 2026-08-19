#!/usr/bin/env python3
"""
Surface observations (METAR), decoded on the Pi.

Every airport and automated station reports the weather at the surface in a
standard code called METAR: temperature, dew point, wind, gust, pressure,
visibility, sky. NOAA/NWS collects these and publishes them; this fetches the
whole national (and nearby) set, decodes the few fields the map needs, and
writes ONE small file the page reads:

    ~/wxdata/obs/latest.json
        { "updated": "...", "count": 1873,
          "cols": ["id","name","lat","lon","tC","dC","wdir","wkt","gkt",
                   "pmb","rh","vis","sky"],
          "obs":  [ ["KOKC","Will Rogers",35.39,-97.6,31,21,180,12,20,
                     1012.3,55,10,"BKN"], ... ] }

The page never talks to NOAA itself: it reads this one file from the Pi,
colors the dots by whichever reading is chosen, and shows the full report on
tap. All the fetching and decoding happens here, which is the whole point.

    python3 pi/obs_pipeline.py            # fetch, decode, write latest.json
    python3 pi/obs_pipeline.py --check    # how many stations are reachable, no write

Served by the same serve.py, which already sends latest.json with the
no-cache header, so a new run is seen without a reload.
"""

import csv
import gzip
import io
import math
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gfs_pipeline import HTTP, Lock, log, write_json  # noqa: E402

OUT_DIR = os.path.expanduser("~/wxdata/obs")

# The complete bulk cache: every station worldwide in one gzipped CSV, with a
# documented header. This is the primary source because it is one request and
# holds everything.
CSV_URL = "https://aviationweather.gov/data/cache/metars.cache.csv.gz"
# The JSON API, used only if the bulk file cannot be read. A wide box over
# North America and the near ocean, which is what this map cares about.
JSON_URL = ("https://aviationweather.gov/api/data/metar"
            "?format=json&hours=2&bbox=0,-180,75,-50")

# The column order the page decodes by name. Change here and in the browser's
# _decodePiObs together.
COLS = ["id", "name", "lat", "lon", "tC", "dC", "wdir", "wkt", "gkt",
        "pmb", "rh", "vis", "sky"]

# Anything older than this is stale enough to mislead, so it is dropped.
MAX_AGE_MIN = 180

# Densest sky layer wins when a station reports several.
SKY_RANK = {"SKC": 0, "CLR": 0, "CAVOK": 0, "NSC": 0, "NCD": 0,
            "FEW": 1, "SCT": 2, "BKN": 3, "OVC": 4, "OVX": 5, "VV": 5}


def _f(v):
    """A float, or None for blank/NaN/junk."""
    if v is None:
        return None
    s = str(v).strip()
    if not s or s.upper() in ("NA", "NAN", "VRB", "M", "MM"):
        return None
    # Visibility arrives as "10+" and pressure sometimes trails a unit.
    s = s.rstrip("+").replace(",", "")
    try:
        return float(s)
    except ValueError:
        # Pull a leading number out of things like "6SM".
        num = ""
        for ch in s:
            if ch.isdigit() or ch in ".-":
                num += ch
            else:
                break
        try:
            return float(num) if num else None
        except ValueError:
            return None


def rh_from(tC, dC):
    """Relative humidity from temperature and dew point (Magnus), 0-100."""
    if tC is None or dC is None:
        return None
    es = lambda t: 6.112 * math.exp((17.62 * t) / (243.12 + t))
    try:
        rh = 100.0 * es(dC) / es(tC)
    except (ValueError, ZeroDivisionError, OverflowError):
        return None
    return int(round(max(0.0, min(100.0, rh))))


def pressure_mb(slp, altim):
    """
    One pressure in millibars, from whichever field is present and sane.

    Sea-level pressure is preferred. The altimeter setting comes in either
    inches of mercury or millibars depending on the source, so it is read by
    its range rather than a promised unit: ~26-32 is inches, ~900-1080 is
    already millibars.
    """
    slp = _f(slp)
    if slp is not None and 800 < slp < 1100:
        return round(slp, 1)
    a = _f(altim)
    if a is None:
        return None
    if 25 < a < 33:                       # inches of mercury
        return round(a * 33.8639, 1)
    if 800 < a < 1100:                    # already millibars
        return round(a, 1)
    return None


def sky_densest(covers):
    """The heaviest cloud layer among the ones reported, as its METAR code."""
    best, best_rank = None, -1
    for c in covers:
        if not c:
            continue
        code = str(c).strip().upper()[:3]
        r = SKY_RANK.get(code, SKY_RANK.get(code[:2], 0))
        if r > best_rank:
            best, best_rank = code, r
    return best


def age_minutes(iso_or_epoch):
    """Minutes since the observation, or None if the time cannot be read."""
    if iso_or_epoch is None:
        return None
    try:
        if isinstance(iso_or_epoch, (int, float)):
            t = datetime.fromtimestamp(float(iso_or_epoch), timezone.utc)
        else:
            s = str(iso_or_epoch).strip().replace("Z", "+00:00")
            t = datetime.fromisoformat(s)
            if t.tzinfo is None:
                t = t.replace(tzinfo=timezone.utc)
    except (ValueError, OSError, OverflowError):
        return None
    return (datetime.now(timezone.utc) - t).total_seconds() / 60.0


# ── Sources ──────────────────────────────────────────────────────────────────

def fetch_csv():
    """Rows from the bulk cache, each a dict of the fields we use."""
    try:
        r = HTTP.get(CSV_URL, timeout=60)
        if r.status_code != 200 or len(r.content) < 200:
            return None
        raw = r.content
    except Exception as e:
        log(f"csv fetch failed: {e}")
        return None

    try:
        text = gzip.decompress(raw).decode("utf-8", errors="ignore")
    except (OSError, EOFError):
        text = raw.decode("utf-8", errors="ignore")   # already decompressed

    lines = text.splitlines()
    # A licence banner and a count sit above the real header; the header is the
    # line that names the station id and latitude.
    hi = next((i for i, ln in enumerate(lines)
               if "station_id" in ln and "latitude" in ln), None)
    if hi is None:
        return None
    header = next(csv.reader([lines[hi]]))
    idx = {name: i for i, name in enumerate(header)}
    # sky_cover repeats once per layer; keep every column that spells it.
    sky_cols = [i for i, name in enumerate(header) if name == "sky_cover"]

    def col(row, name):
        i = idx.get(name)
        return row[i] if i is not None and i < len(row) else None

    rows = []
    for raw_row in csv.reader(lines[hi + 1:]):
        if len(raw_row) < 5:
            continue
        rows.append({
            "id": col(raw_row, "station_id"),
            "name": None,
            "lat": col(raw_row, "latitude"),
            "lon": col(raw_row, "longitude"),
            "tC": col(raw_row, "temp_c"),
            "dC": col(raw_row, "dewpoint_c"),
            "wdir": col(raw_row, "wind_dir_degrees"),
            "wkt": col(raw_row, "wind_speed_kt"),
            "gkt": col(raw_row, "wind_gust_kt"),
            "slp": col(raw_row, "sea_level_pressure_mb"),
            "altim": col(raw_row, "altim_in_hg"),
            "vis": col(raw_row, "visibility_statute_mi"),
            "time": col(raw_row, "observation_time"),
            "sky": sky_densest(raw_row[i] if i < len(raw_row) else None
                               for i in sky_cols),
        })
    return rows


def fetch_json():
    """The JSON API, the fallback shape."""
    try:
        r = HTTP.get(JSON_URL, timeout=60)
        if r.status_code != 200:
            return None
        data = r.json()
    except Exception as e:
        log(f"json fetch failed: {e}")
        return None
    if not isinstance(data, list):
        return None
    rows = []
    for o in data:
        if not isinstance(o, dict):
            continue
        clouds = o.get("clouds") or []
        rows.append({
            "id": o.get("icaoId"),
            "name": o.get("name"),
            "lat": o.get("lat"),
            "lon": o.get("lon"),
            "tC": o.get("temp"),
            "dC": o.get("dewp"),
            "wdir": o.get("wdir"),
            "wkt": o.get("wspd"),
            "gkt": o.get("wgst"),
            "slp": o.get("slp"),
            "altim": o.get("altim"),
            "vis": o.get("visib"),
            "time": o.get("obsTime"),
            "sky": sky_densest(c.get("cover") for c in clouds
                               if isinstance(c, dict)),
        })
    return rows


# ── Build ────────────────────────────────────────────────────────────────────

def normalize(rows):
    """Raw source rows -> the compact `obs` array, dropping the useless ones."""
    out = []
    for r in rows:
        lat, lon = _f(r.get("lat")), _f(r.get("lon"))
        if lat is None or lon is None or not (-90 <= lat <= 90):
            continue
        age = age_minutes(r.get("time"))
        if age is not None and age > MAX_AGE_MIN:
            continue
        tC, dC = _f(r.get("tC")), _f(r.get("dC"))
        # A station with no temperature, wind, or pressure has nothing to plot.
        wkt = _f(r.get("wkt"))
        pmb = pressure_mb(r.get("slp"), r.get("altim"))
        if tC is None and wkt is None and pmb is None:
            continue
        wdir = _f(r.get("wdir"))
        gkt = _f(r.get("gkt"))
        vis = _f(r.get("vis"))
        rid = (r.get("id") or "").strip()
        name = (r.get("name") or "").strip() or rid
        out.append([
            rid, name, round(lat, 3), round(lon, 3),
            round(tC, 1) if tC is not None else None,
            round(dC, 1) if dC is not None else None,
            int(round(wdir)) if wdir is not None else None,
            int(round(wkt)) if wkt is not None else None,
            int(round(gkt)) if gkt is not None else None,
            pmb,
            rh_from(tC, dC),
            round(vis, 1) if vis is not None else None,
            r.get("sky"),
        ])
    return out


def build():
    rows = fetch_csv()
    src = "csv"
    if not rows:
        rows = fetch_json()
        src = "json"
    if not rows:
        log("no source reachable, leaving the last file in place")
        return 1

    obs = normalize(rows)
    if not obs:
        log(f"{src}: parsed 0 usable stations, leaving the last file in place")
        return 1

    os.makedirs(OUT_DIR, exist_ok=True)
    write_json(os.path.join(OUT_DIR, "latest.json"), {
        "updated": datetime.now(timezone.utc).isoformat(),
        "source": "aviationweather.gov",
        "count": len(obs),
        "cols": COLS,
        "obs": obs,
    })
    log(f"{src}: {len(obs)} stations")
    return 0


def check():
    for name, fn in (("csv", fetch_csv), ("json", fetch_json)):
        rows = fn()
        if not rows:
            print(f"  {name:4} unreachable")
            continue
        obs = normalize(rows)
        print(f"  {name:4} {len(rows)} rows -> {len(obs)} usable stations")
        if obs:
            print(f"       e.g. {obs[0]}")
            return 0
    return 1


def main(argv):
    if "--check" in argv:
        return check()
    return build()


if __name__ == "__main__":
    with Lock(os.path.expanduser("~/.gwcfc-obs.lock")):
        sys.exit(main(sys.argv[1:]))
