#!/usr/bin/env python3
"""
Sounding images, built on the Pi the same way the radar and model pictures are.

    ~/wxenv/bin/python ~/GWCFCRadar/pi/sounding_pipeline.py            # one pass
    ~/wxenv/bin/python ~/GWCFCRadar/pi/sounding_pipeline.py --site OUN # one site
    ~/wxenv/bin/python ~/GWCFCRadar/pi/sounding_pipeline.py --check    # fetch only
    ~/wxenv/bin/python ~/GWCFCRadar/pi/sounding_pipeline.py --render-test

The /sounding door answers one point at a time, on demand, and only while
serve.py is up and current. This is the other half: a timer walks a list of
real upper-air sites, SounderPy fetches the full RAP analysis profile for
each, SHARPpy computes the parameter suite, and the whole thing is RENDERED
here - a skew-T with parcel shading, a hodograph coloured by height, wind
barbs, and the parameter panel - into a PNG the page can simply show.

Fetch, do the sums, write a PNG and a manifest beside it. Exactly the shape
of radar_pipeline and gfs_pipeline, on purpose: static files survive
everything that takes a live endpoint down. An old serve.py that has never
heard of /sounding still serves these, because serving files is all it does.

What gets written
-----------------
    ~/wxdata/soundings/manifest.json
    ~/wxdata/soundings/<SITE>/<YYYYmmdd_HHMMSS>/skewt.png
    ~/wxdata/soundings/<SITE>/<YYYYmmdd_HHMMSS>/sounding.json

sounding.json is byte-for-byte the same shape as a /sounding answer, so the
page feeds it through the exact reader it already has. The stamp folder is
the VALID time of the analysis, not the build time, so a frame list doubles
as a time series the slider can walk.

The site list is the real upper-air network. These are the places balloons
actually launch from, which means the names mean something to anyone who
reads soundings, and the spacing is the spacing forecasters already accept
as "the sounding for my area".
"""

import argparse
import json
import os
import shutil
import sys
import time
from datetime import datetime, timedelta, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import sounding_service  # noqa: E402  (fetch_profile, sharppy_params)

OUT_DIR = os.path.expanduser("~/wxdata/soundings")
STATE = os.path.join(OUT_DIR, "state.json")

# How much history each site keeps. A sounding an hour is the RAP's own
# cadence, so 24 hours is 24 frames a site: enough to scrub a day's
# destabilisation, small enough that sixty sites cost about a third of a
# gigabyte, on a card that has already run out once.
KEEP_HOURS = float(os.environ.get("GWCFC_SND_KEEP_HOURS", "24"))

# The pass budget, same idea as MRMS. Every site wants rebuilding every hour
# and a SounderPy fetch is a real network round trip, so one pass must not be
# allowed to eat the machine. The cursor makes the budget fair: each pass
# starts where the last one stopped, so nothing is starved, only staggered.
PASS_MAX = int(os.environ.get("GWCFC_SND_PASS_MAX", "16"))
PASS_SECS = float(os.environ.get("GWCFC_SND_PASS_SECS", "600"))

DISK_FLOOR_MB = float(os.environ.get("GWCFC_DISK_FLOOR_MB", "1500"))

# The upper-air network, CONUS and the near abroad. id, name, lat, lon.
# Coordinates are the launch sites themselves.
SITES = [
    ("OUN", "Norman OK",          35.18, -97.44),
    ("FWD", "Fort Worth TX",      32.83, -97.30),
    ("AMA", "Amarillo TX",        35.23, -101.71),
    ("MAF", "Midland TX",         31.94, -102.19),
    ("DRT", "Del Rio TX",         29.37, -100.92),
    ("CRP", "Corpus Christi TX",  27.77, -97.50),
    ("BRO", "Brownsville TX",     25.92, -97.42),
    ("LCH", "Lake Charles LA",    30.12, -93.22),
    ("SIL", "Slidell LA",         30.34, -89.83),
    ("SHV", "Shreveport LA",      32.45, -93.84),
    ("LZK", "Little Rock AR",     34.84, -92.26),
    ("SGF", "Springfield MO",     37.24, -93.40),
    ("TOP", "Topeka KS",          39.07, -95.62),
    ("DDC", "Dodge City KS",      37.76, -99.97),
    ("LBF", "North Platte NE",    41.13, -100.68),
    ("OAX", "Omaha NE",           41.32, -96.37),
    ("ABR", "Aberdeen SD",        45.45, -98.41),
    ("UNR", "Rapid City SD",      44.07, -103.21),
    ("BIS", "Bismarck ND",        46.77, -100.75),
    ("INL", "Intl Falls MN",      48.56, -93.40),
    ("MPX", "Minneapolis MN",     44.85, -93.56),
    ("GRB", "Green Bay WI",       44.48, -88.13),
    ("DVN", "Davenport IA",       41.61, -90.58),
    ("ILX", "Lincoln IL",         40.15, -89.34),
    ("DTX", "Detroit MI",         42.70, -83.47),
    ("APX", "Gaylord MI",         44.91, -84.72),
    ("ILN", "Wilmington OH",      39.42, -83.82),
    ("PIT", "Pittsburgh PA",      40.53, -80.23),
    ("BUF", "Buffalo NY",         42.94, -78.72),
    ("ALY", "Albany NY",          42.69, -73.83),
    ("OKX", "Upton NY",           40.87, -72.86),
    ("GYX", "Gray ME",            43.89, -70.25),
    ("CAR", "Caribou ME",         46.87, -68.01),
    ("IAD", "Sterling VA",        38.98, -77.49),
    ("WAL", "Wallops Is VA",      37.94, -75.46),
    ("RNK", "Blacksburg VA",      37.20, -80.41),
    ("GSO", "Greensboro NC",      36.10, -79.94),
    ("MHX", "Newport NC",         34.78, -76.88),
    ("CHS", "Charleston SC",      32.90, -80.03),
    ("FFC", "Atlanta GA",         33.36, -84.57),
    ("JAX", "Jacksonville FL",    30.48, -81.70),
    ("TLH", "Tallahassee FL",     30.45, -84.30),
    ("TBW", "Tampa FL",           27.70, -82.40),
    ("MFL", "Miami FL",           25.75, -80.38),
    ("BMX", "Birmingham AL",      33.16, -86.76),
    ("JAN", "Jackson MS",         32.32, -90.08),
    ("BNA", "Nashville TN",       36.25, -86.57),
    ("MRX", "Morristown TN",      36.17, -83.40),
    ("ABQ", "Albuquerque NM",     35.04, -106.62),
    ("EPZ", "Santa Teresa NM",    31.87, -106.70),
    ("TWC", "Tucson AZ",          32.23, -110.96),
    ("FGZ", "Flagstaff AZ",       35.23, -111.82),
    ("VEF", "Las Vegas NV",       36.05, -115.18),
    ("NKX", "San Diego CA",       32.85, -117.12),
    ("VBG", "Vandenberg CA",      34.75, -120.57),
    ("OAK", "Oakland CA",         37.73, -122.21),
    ("REV", "Reno NV",            39.57, -119.80),
    ("MFR", "Medford OR",         42.36, -122.86),
    ("SLE", "Salem OR",           44.92, -123.00),
    ("UIL", "Quillayute WA",      47.95, -124.55),
    ("OTX", "Spokane WA",         47.68, -117.63),
    ("BOI", "Boise ID",           43.57, -116.21),
    ("TFX", "Great Falls MT",     47.46, -111.38),
    ("GGW", "Glasgow MT",         48.21, -106.62),
    ("RIW", "Riverton WY",        43.06, -108.48),
    ("DNR", "Denver CO",          39.77, -104.87),
    ("GJT", "Grand Junction CO",  39.11, -108.53),
    ("SLC", "Salt Lake City UT",  40.77, -111.95),
]


def log(m):
    print(f"{datetime.now():%H:%M:%S} {m}", flush=True)


def free_mb(path):
    try:
        st = os.statvfs(path)
        return st.f_bavail * st.f_frsize / 1048576.0
    except OSError:
        return 1e9


def _load_state():
    try:
        with open(STATE) as fh:
            return json.load(fh) or {}
    except Exception:
        return {}


def _save_state(state):
    try:
        tmp = STATE + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(state, fh)
        os.replace(tmp, STATE)
    except Exception as e:
        log(f"could not save state: {e}")


def wanted_valid(now=None):
    """The analysis hour a pass should be building: the hour just gone.

    The current hour's RAP has not published yet, and asking for it is the
    commonest way to get an empty answer that reads as a broken address.
    """
    now = now or datetime.now(timezone.utc)
    t = (now - timedelta(hours=1)).replace(minute=0, second=0, microsecond=0)
    return t


# ── The picture ────────────────────────────────────────────────────────────
#
# One PNG per site per hour: skew-T with both traces and the surface parcel
# shaded, wind barbs at sensible spacing, a hodograph coloured by height, and
# the SHARPpy numbers laid out where a forecaster expects them. Dark, because
# the site is dark and a white rectangle in a dark app reads as a glitch.
#
# matplotlib and MetPy do the projection sums. The import lives inside the
# function so that --check works on a Pi where matplotlib has not finished
# installing yet: fetching and rendering are separate questions.

_BG = "#10151c"
_FG = "#dbe4ee"
_GRID = "#2a3442"


def render_skewt(body, out_png):
    """One finished sounding image from one /sounding-shaped answer."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import numpy as np
    from matplotlib import gridspec
    from metpy.plots import Hodograph, SkewT
    from metpy.units import units

    prof = body["profile"]
    p = np.asarray(prof["p"], dtype=float)
    T = np.asarray(prof["T"], dtype=float)
    Td = np.asarray(prof["Td"], dtype=float)
    u = np.asarray(prof["u"], dtype=float)
    v = np.asarray(prof["v"], dtype=float)
    z = np.asarray(prof.get("z") or [], dtype=float)

    # Strictly decreasing pressure, which the parcel maths needs and real
    # model output does not always deliver: a repeated level is a zero-depth
    # layer, and MetPy divides by that depth.
    keep = [0]
    for i in range(1, len(p)):
        if p[i] < p[keep[-1]] - 0.1:
            keep.append(i)
    p, T, Td, u, v = p[keep], T[keep], Td[keep], u[keep], v[keep]
    if len(z) == len(prof["p"]):
        z = z[keep]
    else:
        z = np.array([])

    pq = p * units.hPa
    Tq = T * units.degC
    Tdq = Td * units.degC
    uq = u * units.knots
    vq = v * units.knots

    plt.rcParams.update({
        "figure.facecolor": _BG, "axes.facecolor": _BG,
        "axes.edgecolor": _GRID, "axes.labelcolor": _FG,
        "text.color": _FG, "xtick.color": _FG, "ytick.color": _FG,
        "font.size": 9.5, "font.family": "DejaVu Sans",
    })

    fig = plt.figure(figsize=(9.6, 11.6), dpi=110)
    gs = gridspec.GridSpec(2, 1, height_ratios=[3.1, 1.0], hspace=0.14,
                           left=0.07, right=0.985, top=0.94, bottom=0.02)
    skew = SkewT(fig, rotation=45, subplot=gs[0])
    skew.ax.set_facecolor(_BG)

    # The reference lines first, faint, so the data reads over them.
    try:
        skew.plot_dry_adiabats(alpha=0.18, colors="#c96", linewidths=0.7)
        skew.plot_moist_adiabats(alpha=0.16, colors="#6a9", linewidths=0.7)
        skew.plot_mixing_lines(alpha=0.14, colors="#69c", linewidths=0.7)
    except Exception:
        pass
    skew.ax.grid(True, color=_GRID, linewidth=0.6, alpha=0.6)

    skew.plot(pq, Tq, color="#ff5a4e", linewidth=2.2)
    skew.plot(pq, Tdq, color="#37d67a", linewidth=2.2)

    # The surface parcel, drawn and shaded. CIN dark blue below the LFC, CAPE
    # warm above it: the two areas ARE the numbers in the panel below, and
    # seeing them is what a skew-T is for.
    try:
        import metpy.calc as mpcalc
        parcel = mpcalc.parcel_profile(pq, Tq[0], Tdq[0]).to("degC")
        skew.plot(pq, parcel, color="#ffd45e", linewidth=1.4,
                  linestyle="--", alpha=0.95)
        try:
            skew.shade_cin(pq, Tq, parcel, Tdq, alpha=0.25, color="#3573c9")
        except Exception:
            pass
        try:
            skew.shade_cape(pq, Tq, parcel, alpha=0.22, color="#ff7a45")
        except Exception:
            pass
    except Exception:
        pass

    # Barbs, thinned to roughly every 25 hPa so they stay readable.
    try:
        idx = [0]
        for i in range(1, len(p)):
            if p[idx[-1]] - p[i] >= 25:
                idx.append(i)
        skew.plot_barbs(pq[idx], uq[idx], vq[idx], color=_FG, length=6,
                        linewidth=0.8)
    except Exception:
        pass

    skew.ax.set_ylim(1050, 100)
    skew.ax.set_xlim(-40, 45)
    skew.ax.set_xlabel("Temperature (C)")
    skew.ax.set_ylabel("Pressure (hPa)")

    # The hodograph, coloured by height above the ground, because the shape
    # low down is the part that says whether a storm can rotate.
    try:
        hax = fig.add_axes([0.655, 0.615, 0.315, 0.30])
        hax.set_facecolor(_BG)
        h = Hodograph(hax, component_range=80)
        h.add_grid(increment=20, color=_GRID, linewidth=0.6)
        if z.size:
            agl = z - z[0]
            inside = agl <= 12000
            h.plot_colormapped(uq[inside], vq[inside],
                               (agl[inside]) * units.meter, cmap="viridis")
        else:
            h.plot(uq, vq, color="#7fc4ff", linewidth=1.6)
        hax.set_xticklabels([])
        hax.set_yticklabels([])
        for s in hax.spines.values():
            s.set_color(_GRID)
        hax.set_title("Hodograph (0-12 km AGL)", fontsize=8.5, color=_FG)
    except Exception:
        pass

    # The numbers. SHARPpy's when it ran; a plain note when it did not,
    # because a profile with no derived parameters is still worth showing.
    pax = fig.add_subplot(gs[1])
    pax.set_facecolor(_BG)
    pax.axis("off")
    params = body.get("params")

    def fmt(v, unit=""):
        return "--" if v is None else f"{v:g}{unit}"

    if params and "error" not in params:
        sb = params.get("sb") or {}
        ml = params.get("ml") or {}
        mu = params.get("mu") or {}
        w = params.get("wind") or {}
        c = params.get("composite") or {}
        rows = [
            ("PARCEL", "CAPE", "CIN", "LCL m", "LFC m", "EL m"),
            ("SB", fmt(sb.get("cape")), fmt(sb.get("cin")),
             fmt(sb.get("lcl")), fmt(sb.get("lfc")), fmt(sb.get("el"))),
            ("ML", fmt(ml.get("cape")), fmt(ml.get("cin")),
             fmt(ml.get("lcl")), fmt(ml.get("lfc")), fmt(ml.get("el"))),
            ("MU", fmt(mu.get("cape")), fmt(mu.get("cin")),
             fmt(mu.get("lcl")), fmt(mu.get("lfc")), fmt(mu.get("el"))),
        ]
        for r, row in enumerate(rows):
            for cix, cell in enumerate(row):
                pax.text(0.01 + cix * 0.088, 0.92 - r * 0.22, str(cell),
                         fontsize=9, family="monospace",
                         color="#8fa3ba" if r == 0 else _FG,
                         transform=pax.transAxes)
        right = [
            ("SRH 1km", fmt(w.get("srh1"))), ("SRH 3km", fmt(w.get("srh3"))),
            ("Eff SRH", fmt(w.get("esrh"))), ("Shear 6km", fmt(w.get("shear6"), " kt")),
            ("EBWD", fmt(w.get("ebwd"), " kt")), ("PWAT", fmt(c.get("pwat"), " in")),
            ("STP(cin)", fmt(c.get("stp_cin"))), ("SCP", fmt(c.get("scp"))),
            ("SHIP", fmt(c.get("ship"))), ("DCAPE", fmt(c.get("dcape"))),
            ("LR 0-3", fmt(c.get("lapse03"), " C/km")),
            ("LR 3-6", fmt(c.get("lapse36"), " C/km")),
        ]
        for i2, (k2, v2) in enumerate(right):
            col, row2 = divmod(i2, 6)
            pax.text(0.58 + col * 0.22, 0.92 - row2 * 0.155,
                     f"{k2:<9} {v2}", fontsize=8.6, family="monospace",
                     color=_FG, transform=pax.transAxes)
        engine_line = "parameters: SHARPpy (SPC's own parameter code)"
    else:
        pax.text(0.01, 0.8, "SHARPpy was not available for this build, so no "
                 "derived parameters are printed.\nThe profile above is still "
                 "the full SounderPy fetch.", fontsize=9, color=_FG,
                 transform=pax.transAxes)
        engine_line = "parameters: none (SHARPpy unavailable)"

    fig.suptitle(
        f"{body.get('site_name') or body.get('site') or ''} "
        f"({body.get('site_id') or ''})  ·  {body.get('label') or ''}"
        f"  ·  valid {body.get('valid') or ''}",
        fontsize=12, color=_FG, y=0.985)
    fig.text(0.01, 0.002,
             f"fetch: SounderPy · {engine_line} · "
             f"built {datetime.now(timezone.utc):%Y-%m-%d %H:%MZ} on the Pi",
             fontsize=7.5, color="#8fa3ba")

    tmp = out_png + ".tmp.png"
    fig.savefig(tmp, facecolor=_BG)
    plt.close(fig)
    os.replace(tmp, out_png)
    return True


# ── One site, end to end ───────────────────────────────────────────────────

def build_site(site_id, name, lat, lon, valid):
    """Fetch, analyse, render and write one site for one valid hour."""
    when = valid.strftime("%Y%m%d%H")
    body = sounding_service.fetch_profile("rap", lat, lon, when=when)
    body["params"] = sounding_service.sharppy_params(body)
    body["engine"] = {
        "fetch": body.get("upstream", "").split("/")[0] or "NOAA",
        "params": "SHARPpy" if (body["params"] and "error" not in body["params"])
                  else None,
    }
    body["site_id"] = site_id
    body["site_name"] = name
    body["built"] = datetime.now(timezone.utc).isoformat()
    body["cached"] = False

    stamp = valid.strftime("%Y%m%d_%H%M%S")
    fdir = os.path.join(OUT_DIR, site_id, stamp)
    os.makedirs(fdir, exist_ok=True)
    render_skewt(body, os.path.join(fdir, "skewt.png"))
    tmp = os.path.join(fdir, "sounding.json.tmp")
    with open(tmp, "w") as fh:
        json.dump(body, fh)
    os.replace(tmp, os.path.join(fdir, "sounding.json"))
    return stamp


def _frames_for(site_id):
    """The frames really on disk for one site, oldest first.

    Read back off the disk rather than trusted from the manifest, so a frame
    that was pruned or half written can never be advertised.
    """
    d = os.path.join(OUT_DIR, site_id)
    if not os.path.isdir(d):
        return []
    out = []
    for f in sorted(os.listdir(d)):
        full = os.path.join(d, f)
        if (os.path.isdir(full)
                and os.path.exists(os.path.join(full, "skewt.png"))
                and os.path.exists(os.path.join(full, "sounding.json"))):
            out.append(f)
    return out


def prune(now=None):
    now = now or datetime.now(timezone.utc)
    keep = KEEP_HOURS
    if free_mb(OUT_DIR) < DISK_FLOOR_MB:
        keep = min(keep, 6.0)
    cutoff = now - timedelta(hours=keep)
    for site_id, _n, _la, _lo in SITES:
        d = os.path.join(OUT_DIR, site_id)
        if not os.path.isdir(d):
            continue
        for f in os.listdir(d):
            try:
                t = datetime.strptime(f, "%Y%m%d_%H%M%S").replace(
                    tzinfo=timezone.utc)
            except ValueError:
                continue
            if t < cutoff:
                shutil.rmtree(os.path.join(d, f), ignore_errors=True)


def write_manifest(now=None):
    now = now or datetime.now(timezone.utc)
    sites = {}
    for site_id, name, lat, lon in SITES:
        frames = _frames_for(site_id)
        if not frames:
            continue
        newest = frames[-1]
        sites[site_id] = {
            "name": name, "lat": lat, "lon": lon,
            "dir": f"{site_id}/{newest}",
            "valid": datetime.strptime(newest, "%Y%m%d_%H%M%S")
                     .strftime("%Y-%m-%dT%H:%M:%SZ"),
            "frames": frames,
        }
    man = {"updated": now.isoformat(), "source": "rap",
           "engine": {"fetch": "SounderPy", "params": "SHARPpy"},
           "sites": sites}
    tmp = os.path.join(OUT_DIR, "manifest.json.tmp")
    with open(tmp, "w") as fh:
        json.dump(man, fh)
    os.replace(tmp, os.path.join(OUT_DIR, "manifest.json"))
    return len(sites)


def run_pass(only=None, now=None):
    now = now or datetime.now(timezone.utc)
    os.makedirs(OUT_DIR, exist_ok=True)
    valid = wanted_valid(now)
    stamp = valid.strftime("%Y%m%d_%H%M%S")
    state = _load_state()

    names = [s for s in SITES if not only or s[0] in only]
    start = int((state.get("__cursor__") or {}).get("at", 0)) % max(1, len(names))
    names = names[start:] + names[:start]
    t0 = time.time()
    built = failed = 0
    stopped_at = start

    for i, (site_id, name, lat, lon) in enumerate(names):
        if built >= PASS_MAX or (time.time() - t0) > PASS_SECS:
            stopped_at = (start + i) % len(names)
            log(f"soundings: pass budget reached after {built}, resuming at "
                f"{site_id} next time")
            break
        if free_mb(OUT_DIR) < DISK_FLOOR_MB / 2:
            log(f"soundings: only {free_mb(OUT_DIR):.0f} MB free, stopping")
            stopped_at = (start + i) % len(names)
            break
        # Already built for this hour: the folder is the record, no state
        # bookkeeping to disagree with the disk.
        if os.path.exists(os.path.join(OUT_DIR, site_id, stamp, "skewt.png")):
            continue
        st = state.get(site_id) or {}
        fails = int(st.get("fails", 0))
        # A site that keeps failing backs off rather than burning the pass
        # budget every fifteen minutes on an answer that is not coming.
        #
        # Except when it was asked for by name. --site NAME is the documented
        # way to debug ONE site, and it used to obey the backoff, so the exact
        # sites worth debugging (the ones that have failed three times) were
        # the ones it silently refused to try. It printed "0 built, 0 failed"
        # and looked like the pipeline had nothing to do. Naming a site is a
        # deliberate act and outranks a rule meant for the automatic pass.
        if only:
            pass
        elif fails >= 3 and st.get("last_try"):
            try:
                last = datetime.fromisoformat(st["last_try"])
                if (now - last) < timedelta(minutes=45 * min(fails, 6)):
                    continue
            except ValueError:
                pass
        try:
            t1 = time.time()
            build_site(site_id, name, lat, lon, valid)
            built += 1
            state[site_id] = {"fails": 0, "last_try": now.isoformat()}
            log(f"  snd {site_id}: built in {time.time() - t1:.0f}s")
        except Exception as e:
            failed += 1
            state[site_id] = {"fails": fails + 1, "last_try": now.isoformat()}
            # Not truncated any more, and this is not tidiness.
            #
            # The wrapper wraps the real error at the END of its sentence:
            # "SounderPy could not fetch a RAP analysis for 35.2, -97.4 at
            # 2026-08-27 14Z: list index out of range". At 160 characters the
            # cut landed just before the colon, so what reached the log was
            # only the polite half. It read as an upstream data outage. I
            # concluded "upstream" twice, and was wrong both times.
            #
            # One site's error is one line. Sixty-eight of them is still less
            # than a screen, and the last few words are the whole diagnosis.
            log(f"  snd {site_id}: {str(e)}")
    else:
        stopped_at = 0

    state["__cursor__"] = {"at": stopped_at}
    _save_state(state)
    prune(now)
    n = write_manifest(now)
    log(f"soundings: {built} built, {failed} failed, {n} site(s) in the "
        f"manifest, {time.time() - t0:.0f}s")
    # Every site failing is a different problem from a quiet pass, and the
    # page cannot tell them apart from an empty manifest alone.
    if n:
        write_status(ok=True, sites=n, built=built, failed=failed, reason="")
    elif failed:
        write_status(ok=False, sites=0, built=0, failed=failed,
                     reason=f"all {failed} sites failed to build. The upstream "
                            "model source may be down, or SounderPy may not be "
                            "able to reach it.",
                     fix="~/wxenv/bin/python ~/GWCFCRadar/pi/sounding_pipeline.py --check")
    else:
        write_status(ok=True, sites=0, built=0, failed=0,
                     reason="no sites built yet. The first pass takes a few "
                            "minutes per site.")
    return 0


def render_test():
    """A full render from a synthetic profile, no network at all.

    This is the proof the drawing code works, runnable anywhere: a classic
    loaded-gun sounding, rendered exactly as a real one would be.
    """
    n = 60
    p = [1000 - i * 15 for i in range(n)]
    T = [28 - i * 1.05 for i in range(n)]
    Td = [21 - (i * 1.7 if i < 12 else 20 + (i - 12) * 0.9) for i in range(n)]
    u = [-(10 + i * 0.9) * 0.5 for i in range(n)]
    v = [(8 + i * 0.8) for i in range(n)]
    z = [110 + i * 145 for i in range(n)]
    body = {
        "profile": {"p": p, "T": T, "Td": Td, "u": u, "v": v, "z": z},
        "params": None, "site_id": "TEST", "site_name": "Render Test",
        "label": "synthetic profile", "valid": "----",
    }
    body["params"] = sounding_service.sharppy_params(
        {"profile": body["profile"]})
    out = os.path.join(OUT_DIR, "render-test.png")
    os.makedirs(OUT_DIR, exist_ok=True)
    render_skewt(body, out)
    size = os.path.getsize(out)
    log(f"rendered {out} ({size / 1024:.0f} KB)")
    return 0 if size > 20000 else 1


def check():
    """Fetch one real profile and say exactly what happened. No rendering."""
    site_id, name, lat, lon = SITES[0]
    valid = wanted_valid()
    print(f"fetching {name} ({site_id}) for {valid:%Y-%m-%d %H}Z ...")
    try:
        body = sounding_service.fetch_profile(
            "rap", lat, lon, when=valid.strftime("%Y%m%d%H"))
        print(f"  ok: {body.get('levels')} levels via {body.get('upstream')}")
    except Exception as e:
        print(f"  FAILED: {e}")
        return 1
    params = sounding_service.sharppy_params(body)
    if params and "error" not in params:
        sb = (params.get("sb") or {})
        print(f"  SHARPpy: SBCAPE {sb.get('cape')} CIN {sb.get('cin')}")
    else:
        print(f"  SHARPpy: unavailable "
              f"({(params or {}).get('error', 'not installed')})")
    try:
        import matplotlib  # noqa: F401
        import metpy  # noqa: F401
        print("  matplotlib and MetPy import, so rendering will work")
    except Exception as e:
        print(f"  rendering will NOT work yet: {e}")
        return 1
    return 0


# What a build needs, asked once and up front.
#
# Without this, a missing matplotlib fails every one of sixty-eight sites
# separately, each caught by the per-site handler, each counted as a failure
# and backed off - so a single missing package looks like the whole upper-air
# network being unreachable, and the log is sixty-eight copies of the same
# import error. Asked once, it is one sentence and one command.
def missing_deps():
    out = []
    for mod, why in (("numpy", "the arithmetic"),
                     ("matplotlib", "draws the sounding image"),
                     ("metpy", "does the skew-T projection and the parcel")):
        try:
            __import__(mod)
        except Exception as e:
            out.append((mod, why, f"{e.__class__.__name__}: {e}"))
    # SounderPy is asked for THE WAY THE APP ASKS, and only that way.
    #
    # A plain import of it fails on this Pi by design: it goes in with
    # --no-deps, so cartopy and pyart are absent and it reaches for both while
    # loading, along with a county map layer MetPy only defines when cartopy
    # is real. sounding_service stands in for all three. Asking plainly here
    # reported "sounderpy is not installed" about a package that was installed
    # and working, and then printed the install command for it, which
    # succeeded and changed nothing, so it said the same thing next time.
    #
    # doctor.sh and install.sh were both fixed for this. This one was missed,
    # and it is the one that actually stops a sounding being built.
    try:
        import sounding_service
        sounding_service.import_sounderpy()
    except Exception as e:
        out.append(("sounderpy", "fetches the profile",
                    f"{e.__class__.__name__}: {e}"))
    return out


# What the last pass did, written where the PAGE can read it. A pass that
# cannot run leaves no manifest, and "the Pi has not built any site soundings
# yet" is equally true of a missing package and a first run.
def write_status(**fields):
    try:
        os.makedirs(OUT_DIR, exist_ok=True)
        fields["at"] = datetime.now(timezone.utc).isoformat()
        tmp = os.path.join(OUT_DIR, "status.json.tmp")
        with open(tmp, "w") as fh:
            json.dump(fields, fh)
        os.replace(tmp, os.path.join(OUT_DIR, "status.json"))
    except Exception:
        pass


def _install_cmds(gone):
    """The commands that would actually work, which are not the obvious ones.

    SounderPy has to go in with --no-deps, because it lists two plotting
    libraries this machine never uses and both are long C++ builds on ARM.
    Printing the plain command would send whoever reads it down exactly the
    install that already failed once.
    """
    plain = [m for m, _w, _e in gone if m != "sounderpy"]
    cmds = []
    if plain:
        cmds.append("~/wxenv/bin/pip install " + " ".join(plain))
    if any(m == "sounderpy" for m, _w, _e in gone):
        cmds.append("~/wxenv/bin/pip install --no-deps sounderpy")
    return cmds


def _say_missing(gone):
    for mod, why, err in gone:
        log(f"soundings: {mod} is not installed, and it {why} ({err})")
    log("soundings: install with")
    for c in _install_cmds(gone):
        log("  " + c)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", action="append", help="one site id, repeatable")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--render-test", action="store_true")
    a = ap.parse_args(argv)
    if a.check:
        return check()

    # --render-test draws a profile this file makes up, on purpose: it exists
    # to tell "cannot draw" apart from "cannot fetch", which is the first
    # question worth asking when no sounding appears. Requiring the fetching
    # library before it would run makes it answer the very question it was
    # written to answer, and refuse to run for the other reason.
    if a.render_test:
        gone = [d for d in missing_deps() if d[0] != "sounderpy"]
        if gone:
            _say_missing(gone)
            return 1
        return render_test()

    gone = missing_deps()
    # SHARPpy is deliberately not in that list: without it the parameters go
    # missing and the sounding is still a sounding. The four above are the
    # ones without which there is no picture at all.
    if gone:
        _say_missing(gone)
        write_status(ok=False, reason="missing " + ", ".join(
            m for m, _w, _e in gone),
            fix=" ; ".join(_install_cmds(gone)), sites=0)
        return 1

    if a.render_test:
        return render_test()
    return run_pass(only=[s.upper() for s in a.site] if a.site else None)


if __name__ == "__main__":
    sys.exit(main())
