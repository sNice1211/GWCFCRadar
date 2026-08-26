#!/usr/bin/env python3
"""Real spaghetti model guidance, from the source forecasters actually use.

    python3 pi/spaghetti_pipeline.py             # build every active storm
    python3 pi/spaghetti_pipeline.py --check     # is the source up, no work
    python3 pi/spaghetti_pipeline.py --storm al09

The panel used to trace a pressure minimum across a coarse grid of a metered
ensemble API: three models, forty-eight hours, and a daily allowance that ran
out in a handful of opens. This replaces all of it with the ATCF a-deck, which
is not an approximation of model guidance, it IS the guidance: the file the
National Hurricane Center's own forecasters plot. Every aid in it, GFS, the
HAFS pair, CMC, NAVGEM, UKMET, COAMPS-TC, the GEFS mean and all 31 GEFS
members, the consensus aids and the official forecast itself, with real
forecast hours, real intensities, real pressures.

    a-deck (guidance)   https://ftp.nhc.noaa.gov/atcf/aid_public/a{bb}{nn}{yyyy}.dat.gz
    b-deck (best track) https://ftp.nhc.noaa.gov/atcf/btk/b{bb}{nn}{yyyy}.dat

NHC covers the AL/EP/CP basins. WP/IO/SH decks come from UCAR's open mirror,
best effort: raw ensembles only there, which is a property of the JTWC decks
themselves and not of our ingest.

THE FORMAT LIES, AND THE PARSER KNOWS WHERE. All of this is inherited from
Triple-A Tropics (see CREDIT below), whose notes are calibrated against the
real live decks rather than the format document:

  * 0 means MISSING for VMAX and MSLP, not zero. Nearly a third of live rows
    carry it, entire aid families never populate MSLP at all.
  * Position 0N/0W is a sentinel, not the Gulf of Guinea. It is syntactically
    perfect, survives naive parsing, and then poisons every motion
    calculation. Resolved to None at parse time so it cannot leak.
  * -99 and -999 are two MORE missing sentinels, independent of the zero.
  * The primary key is (basin, cy, dtg, tech, tau, RAD): the 34/50/64 kt wind
    radii rows legitimately share (dtg, tech, tau), so deduplicating on the
    triple silently discards genuine records, and counting radii rows as
    track points triples every trace.
  * Rows are variable width, 18 to 46 comma separated fields. Indexing a
    fixed high column crashes on most of the data.
  * TAU can be negative: CARQ carries past positions for model bogusing.
    Those are not forecasts and are excluded.
  * Longitudes cross into the E hemisphere and the antimeridian is encoded
    1800E. Assuming W flips the track round the world.
  * The public a-deck WITHHOLDS every ECMWF derived aid. That is deliberate
    upstream filtering, not absence: consensus aids like TVCN were computed
    from members we cannot see, so they are plottable but not independently
    reproducible, and the page says so rather than implying a verification
    nobody performed.

An ensemble MEAN is also not a CONSENSUS: AEMN is one model averaged with
itself, TVCN is several independent models agreeing. The aid catalog keeps
the two apart so the panel cannot claim agreement the data does not show.

CREDIT

The ATCF parsing, QC rules, sentinel handling, aid catalog and the honesty
blocks are adapted, with permission, from Andrew Austin-Adler's Triple-A
Tropics (github.com/WeathermanAAA/Triple-A-Tropics), whose guidance package
solved this exact problem and documented every trap against the live decks.
The output shape and the serving side are ours.

Output, served by serve.py like everything else:

    ~/wxdata/spaghetti/latest.json        which storms, one line each
    ~/wxdata/spaghetti/{stormid}.json     the full guidance document

Stdlib + requests only. No scipy, no eccodes: the decks are plain text.
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import math
import os
import re
import sys
import time
from collections import Counter, defaultdict

try:
    import requests
except ImportError:                                       # pragma: no cover
    requests = None

OUT_DIR = os.path.expanduser("~/wxdata/spaghetti")

NHC_ADECK = "https://ftp.nhc.noaa.gov/atcf/aid_public/a{basin}{cy:02d}{year}.dat.gz"
NHC_BDECK = "https://ftp.nhc.noaa.gov/atcf/btk/b{basin}{cy:02d}{year}.dat"
NHC_LISTING = "https://ftp.nhc.noaa.gov/atcf/aid_public/"
UCAR_ADECK = ("https://hurricanes.ral.ucar.edu/repository/data/"
              "adecks_open/a{basin}{cy:02d}{year}.dat")
UCAR_BDECK = ("https://hurricanes.ral.ucar.edu/repository/data/"
              "bdecks_open/{year}/b{basin}{cy:02d}{year}.dat")
UCAR_LISTING = "https://hurricanes.ral.ucar.edu/repository/data/adecks_open/"

NHC_BASINS = frozenset({"al", "ep", "cp"})
JTWC_BASINS = frozenset({"wp", "io", "sh"})

#: Withheld from the public a-deck (every ECMWF derived aid plus UKM natives).
#: Named so an absence can be explained; never waited on.
WITHHELD_TECHS = ("EMX", "EMXI", "EMX2", "EEMN", "EMNI", "SHPE", "DSPE",
                  "LGME", "EAIO", "EAMN", "UKM", "UKMI", "UEMN", "FSSE",
                  "GFEX")

#: Published consensus aids whose nominal member list includes withheld aids.
CONSENSUS_MEMBERS = {
    "TVCN": ("AVNI", "EGRI", "HWFI", "EMXI", "CTCI", "EMNI"),
    "TVCE": ("AVNI", "EGRI", "HWFI", "EMXI", "CTCI", "EMNI"),
    "IVCN": ("DSHP", "LGEM", "HWFI", "CTCI", "EMXI"),
    "RVCN": ("AVNI", "HWFI", "EMXI", "CTCI", "EMNI"),
    "HCCA": ("AVNO", "AVNI", "EMX", "EMXI", "HWFI", "CTCI"),
}

NON_FORECAST_TECHS = frozenset({"CARQ", "WRNG"})
RADII_THRESHOLDS = (34, 50, 64)

#: What an aid IS. kind decides colour and grouping in the panel; an ensemble
#: mean deliberately never lands in "consensus" (one model averaged with
#: itself is not several models agreeing).
AID_KINDS = {
    "OFCL": "official", "OFCI": "official",
    "TVCN": "consensus", "TVCE": "consensus", "TVCX": "consensus",
    "IVCN": "consensus", "RVCN": "consensus", "HCCA": "consensus",
    "NNIC": "consensus",
    "AEMN": "ensemble_mean", "AEMI": "ensemble_mean", "AEM2": "ensemble_mean",
    "GDMN": "ensemble_mean", "GDMI": "ensemble_mean",
    "CEMN": "ensemble_mean", "CEMI": "ensemble_mean",
    "OCD5": "skill_baseline", "CLP5": "skill_baseline",
    "SHF5": "skill_baseline", "TCLP": "skill_baseline",
    "XTRP": "skill_baseline", "DRCL": "skill_baseline",
    "DSHP": "statistical", "SHIP": "statistical", "LGEM": "statistical",
    "AVNO": "dynamical", "AVNI": "dynamical", "AVN2": "dynamical",
    "HWRF": "dynamical", "HWFI": "dynamical",
    "HMON": "dynamical", "HMNI": "dynamical",
    "HFSA": "dynamical", "HFAI": "dynamical",
    "HFSB": "dynamical", "HFBI": "dynamical",
    "CMC": "dynamical", "CMCI": "dynamical",
    "NVGM": "dynamical", "NVGI": "dynamical",
    "CTCX": "dynamical", "CTCI": "dynamical",
    "UKX": "dynamical", "UKXI": "dynamical", "UKX2": "dynamical",
    "EGRR": "dynamical", "EGRI": "dynamical",
}

LABELS = {
    "OFCL": "NHC official", "OFCI": "NHC official (interp)",
    "TVCN": "Track consensus", "TVCE": "Track consensus (east)",
    "IVCN": "Intensity consensus", "RVCN": "Track consensus (regional)",
    "HCCA": "HFIP corrected consensus", "NNIC": "Neural net consensus",
    "AEMN": "GEFS mean", "AEMI": "GEFS mean (interp)",
    "AEM2": "GEFS mean (2-cycle)", "GDMN": "GEFS mean (GFDL)",
    "GDMI": "GEFS mean (GFDL interp)", "CEMN": "CMC ens mean",
    "CEMI": "CMC ens mean (interp)", "AC00": "GEFS control",
    "AVNO": "GFS", "AVNI": "GFS (interp)", "AVN2": "GFS (2-cycle)",
    "HWRF": "HWRF", "HWFI": "HWRF (interp)",
    "HMON": "HMON", "HMNI": "HMON (interp)",
    "HFSA": "HAFS-A", "HFAI": "HAFS-A (interp)",
    "HFSB": "HAFS-B", "HFBI": "HAFS-B (interp)",
    "CMC": "CMC/GEM", "CMCI": "CMC/GEM (interp)",
    "NVGM": "NAVGEM", "NVGI": "NAVGEM (interp)",
    "CTCX": "COAMPS-TC", "CTCI": "COAMPS-TC (interp)",
    "UKX": "UKMET", "UKXI": "UKMET (interp)", "UKX2": "UKMET (2-cycle)",
    "EGRR": "UKMET (native)", "EGRI": "UKMET (native interp)",
    "DSHP": "DSHIPS intensity", "SHIP": "SHIPS intensity",
    "LGEM": "LGEM intensity",
    "OCD5": "OCD5 no-skill baseline", "CLP5": "CLIPER5 baseline",
    "SHF5": "SHIFOR5 baseline",
}

REQUEST_TIMEOUT = 45
RETRIES = 3
_DTG_RE = re.compile(r"^\d{10}$")


def log(msg):
    print(f"[spag] {msg}", flush=True)


# ── ATCF field parsing: each sentinel resolved HERE so it cannot leak ────────
def int_or_none(raw):
    """An ATCF integer cell. 0, -99 and -999 are all MISSING, not values."""
    raw = (raw or "").strip()
    if not raw:
        return None
    try:
        v = int(float(raw))
    except (TypeError, ValueError):
        return None
    if v in (0, -99, -999):
        return None
    return v


def parse_latlon(lat_raw, lon_raw):
    """('218N', '0651W') -> (21.8, -65.1); E stays positive; 0N/0W -> None.

    The 0N/0W sentinel is the most dangerous value in the format: it is
    syntactically valid, lands at null island, and 9,561 live rows carry it.
    The antimeridian is encoded 1800E, so E is a real hemisphere here.
    """
    def one(raw, pos, neg):
        raw = (raw or "").strip().upper()
        if not raw or raw[-1] not in (pos, neg):
            return None
        try:
            val = int(raw[:-1]) / 10.0
        except ValueError:
            return None
        return -val if raw[-1] == neg else val

    lat = one(lat_raw, "N", "S")
    lon = one(lon_raw, "E", "W")
    if lat is None or lon is None:
        return None
    if lat == 0.0 and lon == 0.0:
        return None
    return lat, lon


def parse_dtg(raw):
    raw = (raw or "").strip()
    if not _DTG_RE.match(raw):
        return None
    try:
        return dt.datetime.strptime(raw, "%Y%m%d%H").replace(
            tzinfo=dt.timezone.utc)
    except ValueError:
        return None


def is_gefs_member(tech):
    if tech == "AC00":
        return True
    return (len(tech) == 4 and tech.startswith("AP") and tech[2:].isdigit()
            and 1 <= int(tech[2:]) <= 30)


def classify(tech, basin=None):
    """The aid's kind. JTWC basins never return consensus: those decks have
    never carried one, so an id that looks like consensus there is a
    misclassification, and repeating it would fabricate model agreement."""
    tech = (tech or "").strip().upper()
    kind = AID_KINDS.get(tech)
    if kind is None:
        kind = "ensemble_member" if is_gefs_member(tech) else "other"
    if kind == "consensus" and (basin or "").lower() in JTWC_BASINS:
        kind = "other"
    return kind


def label(tech):
    tech = (tech or "").strip().upper()
    if tech in LABELS:
        return LABELS[tech]
    if is_gefs_member(tech):
        return f"GEFS p{tech[2:]}"
    return tech


# ── Deck parsing ─────────────────────────────────────────────────────────────
def parse_deck(text, keep_non_forecast=False):
    """One a-deck or b-deck -> (rows, qc dict). Same layout for both.

    Rows are dicts, not objects: they go straight into JSON. Radii rows keep
    their rad so consumers can take only the primary row per (tech, tau).
    """
    rows = []
    qc = Counter()
    names = {}                      # dtg -> storm name, from column 27
    prev = None
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        qc["seen"] += 1
        if line == prev:            # rare byte-identical adjacent duplicates
            qc["exact_dup"] += 1
            continue
        prev = line
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 11:
            qc["malformed"] += 1
            continue
        d = parse_dtg(parts[2])
        if d is None:
            qc["bad_dtg"] += 1
            continue
        tech = parts[4].upper()
        try:
            cy = int(parts[1])
            tau = int(parts[5])
        except ValueError:
            qc["malformed"] += 1
            continue
        if not keep_non_forecast and (tech in NON_FORECAST_TECHS or tau < 0):
            qc["non_forecast"] += 1
            continue
        pos = parse_latlon(parts[6], parts[7])
        if pos is None:
            qc["no_position"] += 1
        rad = None
        if len(parts) > 11:
            try:
                r = int(parts[11])
                rad = r if r in RADII_THRESHOLDS else None
            except ValueError:
                rad = None
        # Column 27 is the storm name where the row is wide enough to carry
        # it, which the b-deck reliably is. Letters only: the column holds
        # sentinels like GENESIS001 and INVEST too, both of which are honest,
        # but a bare number is not a name.
        if len(parts) > 27 and parts[27]:
            nm = parts[27].strip().upper()
            if nm and nm not in ("UNKNOWN",) and not nm.isdigit():
                names[d] = nm
        rows.append({
            "basin": parts[0].lower(), "cy": cy, "dtg": d, "tech": tech,
            "tau": tau, "rad": rad,
            "lat": pos[0] if pos else None, "lon": pos[1] if pos else None,
            "vmax": int_or_none(parts[8]) if len(parts) > 8 else None,
            "mslp": int_or_none(parts[9]) if len(parts) > 9 else None,
        })
        qc["kept"] += 1
    qc["name"] = names[max(names)] if names else None
    return rows, dict(qc)


def traces(rows):
    """{TECH: [{tau, lat, lon, vmax, mslp}, ...]} for ONE cycle's rows.

    Only the primary radii row contributes (rad None or 34): the 50 and 64 kt
    rows repeat the same position, so counting them triples every trace.
    """
    by_tech = defaultdict(dict)
    for r in rows:
        if r["rad"] not in (None, 34):
            continue
        by_tech[r["tech"]].setdefault(r["tau"], {
            "tau": r["tau"], "lat": r["lat"], "lon": r["lon"],
            "vmax": r["vmax"], "mslp": r["mslp"],
        })
    return {tech: [pts[t] for t in sorted(pts)]
            for tech, pts in by_tech.items()}


def consensus_membership(present, basin):
    """Members of each published consensus aid in THREE states: present,
    absent, and WITHHELD. Withheld carries the honesty: the member was
    produced, the public feed does not ship it, so the consensus cannot be
    independently recomputed here. Empty for JTWC basins, which have no
    consensus aids to describe."""
    if (basin or "").lower() in JTWC_BASINS:
        return []
    have = {t.upper() for t in present}
    withheld = set(WITHHELD_TECHS)
    out = []
    for tech, members in CONSENSUS_MEMBERS.items():
        if tech not in have:
            continue
        states = [{"tech": m,
                   "state": ("present" if m in have
                             else "withheld" if m in withheld else "absent")}
                  for m in members]
        out.append({
            "tech": tech, "label": label(tech), "members": states,
            "reproducible": not any(s["state"] == "withheld" for s in states),
        })
    return out


# ── Fetching ─────────────────────────────────────────────────────────────────
def http_get(url, timeout=REQUEST_TIMEOUT):
    last = None
    for attempt in range(RETRIES):
        try:
            r = requests.get(url, timeout=timeout,
                             headers={"User-Agent": "gwcfc-radar/spaghetti"})
            if r.status_code == 404:
                return None
            r.raise_for_status()
            return r.content
        except requests.RequestException as e:
            last = e
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"{url}: {last}")


def fetch_deck(basin, cy, year, kind="a"):
    """One deck's text, or None where it does not exist.

    AL/EP/CP from NHC (the sole authorized publisher), with UCAR as a
    fallback when NHC itself is down; WP/IO/SH only exist on UCAR. Gzip is
    sniffed from the bytes rather than trusted from the extension, because
    NHC ships the a-deck gzipped and UCAR ships it plain.
    """
    b = basin.lower()
    if b in JTWC_BASINS:
        urls = [(UCAR_ADECK if kind == "a" else UCAR_BDECK)
                .format(basin=b, cy=cy, year=year)]
    else:
        urls = [(NHC_ADECK if kind == "a" else NHC_BDECK)
                .format(basin=b, cy=cy, year=year),
                (UCAR_ADECK if kind == "a" else UCAR_BDECK)
                .format(basin=b, cy=cy, year=year)]
    raw = None
    for i, url in enumerate(urls):
        try:
            raw = http_get(url)
        except RuntimeError as e:
            if i == len(urls) - 1:
                raise
            log(f"  {url.split('/')[2]} failed ({e}), trying the mirror")
            continue
        if raw is not None:
            break
    if raw is None:
        return None
    if raw[:2] == b"\x1f\x8b":
        try:
            raw = gzip.decompress(raw)
        except (OSError, EOFError):
            pass
    return raw.decode("utf-8", errors="replace")


def discover_storms(year):
    """[(basin, cy)] for every a-deck currently published.

    Invests (cy >= 90) are real and carry guidance, so they stay. Test decks
    (cy 80-89) are GSTEST fixtures with physically absurd values and are
    excluded. NHC's directory listing covers AL/EP/CP; UCAR's adds WP/IO/SH
    and is best effort, a failure there never sinks the run.
    """
    found = set()
    body = http_get(NHC_LISTING)
    if body:
        for m in re.finditer(r"a([a-z]{2})(\d{2})(\d{4})\.dat\.gz",
                             body.decode("utf-8", "replace")):
            b, cy, yr = m.group(1), int(m.group(2)), int(m.group(3))
            if yr == year and not (80 <= cy <= 89) and b in NHC_BASINS:
                found.add((b, cy))
    try:
        body = http_get(UCAR_LISTING)
        if body:
            for m in re.finditer(r"a([a-z]{2})(\d{2})(\d{4})\.dat",
                                 body.decode("utf-8", "replace")):
                b, cy, yr = m.group(1), int(m.group(2)), int(m.group(3))
                if yr == year and not (80 <= cy <= 89) and b in JTWC_BASINS:
                    found.add((b, cy))
    except RuntimeError as e:
        log(f"  JTWC mirror listing failed, NHC basins only: {e}")
    return sorted(found)


# ── The per-storm document ───────────────────────────────────────────────────
def build_document(adeck_text, bdeck_text, basin, cy, year):
    """The published guidance document for one storm. Pure, no I/O."""
    rows, qc = parse_deck(adeck_text)
    if not rows:
        return None
    cycle = max(r["dtg"] for r in rows)
    cyc_rows = [r for r in rows if r["dtg"] == cycle]
    tr = traces(cyc_rows)

    best, name = [], None
    if bdeck_text:
        brows, bqc = parse_deck(bdeck_text)
        name = bqc.get("name")
        for r in sorted(brows, key=lambda r: r["dtg"]):
            if r["rad"] not in (None, 34) or r["lat"] is None:
                continue
            best.append({"dtg": r["dtg"].strftime("%Y%m%d%H"),
                         "lat": r["lat"], "lon": r["lon"],
                         "vmax": r["vmax"], "mslp": r["mslp"]})

    present = sorted(tr)
    meta = {}
    for tech in present:
        pts = tr[tech]
        n_pos = sum(1 for p in pts if p["lat"] is not None)
        meta[tech] = {
            "kind": classify(tech, basin),
            "label": label(tech),
            "n_points": len(pts),
            "has_track": n_pos >= 2,
            "has_intensity": any(p["vmax"] is not None for p in pts),
            "tau_max": max((p["tau"] for p in pts), default=None),
        }

    # Is this storm happening NOW? A-decks persist for the whole season, so
    # June's dead storms still have files in August and would fan stale
    # guidance across a quiet map. Alive means the best track has a fix
    # within the last two days; with no best track at all (a brand new
    # invest), a fresh guidance cycle stands in.
    now = dt.datetime.now(dt.timezone.utc)
    if best:
        last_fix = dt.datetime.strptime(best[-1]["dtg"], "%Y%m%d%H").replace(
            tzinfo=dt.timezone.utc)
        active = (now - last_fix) <= dt.timedelta(hours=48)
    else:
        active = (now - cycle) <= dt.timedelta(hours=30)

    sid = f"{basin}{cy:02d}{year}"
    return {
        "active": active,
        "id": sid,
        "atcf": f"{basin.upper()}{cy:02d}{year}",
        "name": name,
        "basin": basin, "cy": cy, "year": year,
        "cycle": cycle.strftime("%Y%m%d%H"),
        "source": ("UCAR adecks_open (JTWC, best effort)"
                   if basin in JTWC_BASINS
                   else "NHC public a-deck (ftp.nhc.noaa.gov)"),
        "tier": "ensemble_only" if basin in JTWC_BASINS else "full",
        "generated": dt.datetime.now(dt.timezone.utc)
                       .strftime("%Y-%m-%dT%H:%M:%SZ"),
        "aids": tr,
        "aid_meta": meta,
        "official": "OFCL" if "OFCL" in tr else None,
        "best_track": best,
        "consensus_membership": consensus_membership(present, basin),
        "withheld_note": (
            None if basin in JTWC_BASINS else
            "NHC's public a-deck withholds every ECMWF derived aid, so no "
            "ECMWF line can be drawn here in real time, and consensus aids "
            "that nominally include one were computed upstream from members "
            "this feed cannot see."),
        "qc": qc,
    }


def write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, separators=(",", ":"))
    os.replace(tmp, path)


def build(year, only=None):
    os.makedirs(OUT_DIR, exist_ok=True)
    targets = only or discover_storms(year)
    log(f"{len(targets)} storm(s) published for {year}")
    index = []
    for basin, cy in targets:
        try:
            a = fetch_deck(basin, cy, year, "a")
            if not a:
                continue
            b = fetch_deck(basin, cy, year, "b")
            doc = build_document(a, b, basin, cy, year)
        except Exception as e:                 # one storm must not sink the run
            log(f"  {basin}{cy:02d}: FAILED {e}")
            continue
        if not doc or not doc["aids"]:
            continue
        write_json(os.path.join(OUT_DIR, f"{doc['id']}.json"), doc)
        last = doc["best_track"][-1] if doc["best_track"] else {}
        n_tracks = sum(1 for m in doc["aid_meta"].values() if m["has_track"])
        index.append({
            "id": doc["id"], "atcf": doc["atcf"], "name": doc["name"],
            "basin": basin, "path": f"{doc['id']}.json",
            "cycle": doc["cycle"], "tier": doc["tier"],
            "active": doc["active"],
            "lat": last.get("lat"), "lon": last.get("lon"),
            "vmax": last.get("vmax"), "mslp": last.get("mslp"),
            "n_aids": len(doc["aids"]), "n_tracks": n_tracks,
        })
        log(f"  {doc['id']} ({doc['name'] or 'unnamed'}): "
            f"{len(doc['aids'])} aids, {n_tracks} with tracks, "
            f"cycle {doc['cycle']}")
    # An empty index is honest when the tropics are quiet; overwriting a good
    # one because the SOURCE failed is not. discover_storms raising has
    # already aborted us; here every storm individually failing keeps the old
    # index rather than publishing an empty lie.
    if targets and not index:
        log("storms exist but nothing built; keeping the previous index")
        return 1
    write_json(os.path.join(OUT_DIR, "latest.json"), {
        "updated": dt.datetime.now(dt.timezone.utc)
                     .strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "ATCF a-decks: NHC aid_public + UCAR adecks_open",
        "storms": index,
    })
    log(f"{len(index)} storm(s) -> {OUT_DIR}/latest.json")
    return 0


def check(year):
    """Is the source reachable and what does it hold. No building."""
    try:
        storms = discover_storms(year)
    except Exception as e:
        log(f"source unreachable: {e}")
        return 1
    log(f"{len(storms)} deck(s) for {year}: "
        + (", ".join(f"{b}{c:02d}" for b, c in storms) or "none (quiet)"))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int,
                    default=dt.datetime.now(dt.timezone.utc).year)
    ap.add_argument("--storm", action="append",
                    help="basin+number, e.g. al09 (repeatable)")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args(argv)
    if requests is None:
        log("requests is not installed")
        return 1
    if args.check:
        return check(args.year)
    only = None
    if args.storm:
        only = [(s.strip().lower()[:2], int(s.strip()[2:]))
                for s in args.storm]
    return build(args.year, only)


if __name__ == "__main__":
    sys.exit(main())
