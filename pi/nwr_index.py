#!/usr/bin/env python3
"""
nwr_index.py

Writes the JSON tables of contents that the NWRchive website reads.

nwr_archiver.py fills an archive tree; a static website cannot list folders
over HTTP, so this walks the tree and writes small JSON indexes next to it:

    <root>/index.json                 station list, per-day chunk/alert counts
    <root>/meta/<ID>/<DATE>.json      one day of one station:
                                        {"chunks": ["000000", ...],
                                         "highlights": [{"t","reason",
                                                         "keywords","transcript"}]}

Serve <root> over HTTP (with CORS open) and point nwrchive.html at it.

Usage:
    python3 nwr_index.py                                   # one pass
    python3 nwr_index.py --root /mnt/nwr_archive
    python3 nwr_index.py --stations /path/to/stations.json # nicer names
    python3 nwr_index.py --loop 300                        # re-index forever

Run it from cron or a systemd timer every few minutes; a pass is cheap
(directory listings and reading only highlight metadata, never audio).
"""

import argparse
import json
import os
import re
import time
from datetime import datetime, timezone

DEFAULT_ROOT = "/mnt/nwr_archive"

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_RE = re.compile(r"^(\d{6})\.opus$")

US_STATES = {
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI",
    "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN",
    "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH",
    "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA",
    "WV", "WI", "WY", "PR", "VI", "GU", "AS", "MP",
}

FREQ_RE = re.compile(r"\b(162\.\d{3})\b")


def log(msg):
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def parse_state(name):
    """The LAST two-letter state token in a station name wins.

    Relay names run like "KIH21 Sebring FL 162.475" or "WXR - Sebring, FL -
    KIH21"; scanning from the end avoids callsign fragments and city words
    that happen to collide with state codes.
    """
    tokens = re.findall(r"[A-Za-z]{2}", name or "")
    for tok in reversed(tokens):
        if tok.upper() in US_STATES and tok.isupper():
            return tok.upper()
    return None


def parse_freq(name):
    m = FREQ_RE.search(name or "")
    return m.group(1) if m else None


def list_days(station_dir):
    """{date: sorted [HHMMSS]} for one station under rolling/ or highlights/."""
    out = {}
    if not os.path.isdir(station_dir):
        return out
    for date_str in os.listdir(station_dir):
        if not DATE_RE.match(date_str):
            continue
        day_dir = os.path.join(station_dir, date_str)
        if not os.path.isdir(day_dir):
            continue
        times = []
        for fname in os.listdir(day_dir):
            m = TIME_RE.match(fname)
            if m:
                times.append(m.group(1))
        if times:
            out[date_str] = sorted(times)
    return out


def read_highlight_meta(hl_dir, t):
    """The archiver writes <HHMMSS>.json beside every highlight .opus."""
    path = os.path.join(hl_dir, f"{t}.json")
    try:
        with open(path) as f:
            meta = json.load(f)
        return {
            "t": t,
            "reason": "same_tone" if meta.get("reason") == "same_tone" else "keyword",
            "keywords": meta.get("matched_keywords") or [],
            "transcript": (meta.get("transcript") or "").strip(),
        }
    except (OSError, json.JSONDecodeError, ValueError):
        return {"t": t, "reason": "keyword", "keywords": [], "transcript": ""}


def load_station_names(path):
    """id -> name from the archiver's stations.json, when offered."""
    if not path:
        return {}
    try:
        with open(path) as f:
            return {s["id"]: s.get("name", s["id"]) for s in json.load(f)
                    if isinstance(s, dict) and "id" in s}
    except (OSError, json.JSONDecodeError, ValueError, TypeError) as e:
        log(f"could not read stations file {path}: {e}")
        return {}


def write_json_atomic(path, obj):
    """A reader must never see a half-written index, so write-then-rename."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, separators=(",", ":"))
    os.replace(tmp, path)


def build(root, stations_path=None):
    rolling_root = os.path.join(root, "rolling")
    hl_root = os.path.join(root, "highlights")
    meta_root = os.path.join(root, "meta")
    names = load_station_names(stations_path)

    station_ids = set()
    for base in (rolling_root, hl_root):
        if os.path.isdir(base):
            station_ids.update(n for n in os.listdir(base)
                               if os.path.isdir(os.path.join(base, n)))

    index_stations = []
    day_files = 0
    for sid in sorted(station_ids):
        rolling = list_days(os.path.join(rolling_root, sid))
        highlights = list_days(os.path.join(hl_root, sid))
        name = names.get(sid, sid)

        dates = {}
        for date_str in sorted(set(rolling) | set(highlights)):
            chunks = rolling.get(date_str, [])
            hl_times = highlights.get(date_str, [])
            dates[date_str] = {"chunks": len(chunks), "highlights": len(hl_times)}

            hl_dir = os.path.join(hl_root, sid, date_str)
            day = {
                "chunks": chunks,
                "highlights": [read_highlight_meta(hl_dir, t) for t in hl_times],
            }
            write_json_atomic(os.path.join(meta_root, sid, f"{date_str}.json"), day)
            day_files += 1

        index_stations.append({
            "id": sid,
            "name": name,
            "state": parse_state(name),
            "freq": parse_freq(name),
            "dates": dates,
        })

    index = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "stations": index_stations,
    }
    write_json_atomic(os.path.join(root, "index.json"), index)
    log(f"indexed {len(index_stations)} stations, wrote {day_files} day files")
    return index


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=DEFAULT_ROOT,
                    help="archive root written by nwr_archiver.py")
    ap.add_argument("--stations", default=None,
                    help="the archiver's stations.json, for display names")
    ap.add_argument("--loop", type=int, default=0, metavar="SECONDS",
                    help="re-index forever on this interval instead of once")
    args = ap.parse_args()

    if not os.path.isdir(args.root):
        raise SystemExit(f"archive root does not exist: {args.root}")

    if args.loop > 0:
        while True:
            try:
                build(args.root, args.stations)
            except Exception as e:
                log(f"index pass failed: {e}")
            time.sleep(args.loop)
    else:
        build(args.root, args.stations)


if __name__ == "__main__":
    main()
