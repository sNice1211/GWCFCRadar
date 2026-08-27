#!/usr/bin/env python3
"""
nwr_archiver.py

Continuous multi-station NOAA Weather Radio (or similar) audio archiver.

Pipeline:
  1. Ingest each station's live audio stream (Icecast/HTTP or local capture device).
  2. Segment into fixed-length WAV chunks.
  3. Scan each chunk for a SAME (Specific Area Message Encoding) alert tone burst
     by measuring how much of each window's energy sits at the two AFSK
     mark/space frequencies.
  4. If a SAME burst is found, OR if a keyword pass on a transcript matches an
     alert keyword, file the chunk into the permanent "highlights" archive
     (with transcript + metadata JSON).
  5. Everything (alert or not) also gets written to a "rolling" archive that is
     pruned by a retention window (default 90 days).

Dependencies (install with pip):
    pip install faster-whisper numpy --break-system-packages
System dependency:
    ffmpeg (for stream capture, segmenting, and opus encoding)

Usage:
    # Ask the NWR relays what is on air and write the config for you:
    python3 nwr_archiver.py --discover --config stations.json
    python3 nwr_archiver.py --discover --config stations.json --only KIH21,KEC50

    # Then run it:
    python3 nwr_archiver.py --config stations.json
    python3 nwr_archiver.py --config stations.json --no-transcribe   # tone-only
    python3 nwr_archiver.py --cleanup-only --config stations.json

Config file format (stations.json), which --discover writes for you:
[
  {"id": "KIH21", "name": "Sebring FL", "url": "https://stream.weatherradio.org/KIH21"},
  {"id": "KEC50", "name": "Miami FL",   "url": "https://stream.weatherradio.org/KEC50"}
]
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import wave
from datetime import datetime, timedelta, timezone

import numpy as np

# ----------------------------------------------------------------------------
# Configuration
# ----------------------------------------------------------------------------

# Overridable so the installer can point this at the home directory without
# editing the file; the default keeps working for a dedicated mount.
ARCHIVE_ROOT = os.environ.get("NWR_ARCHIVE_ROOT", "/mnt/nwr_archive")
ROLLING_DIR = os.path.join(ARCHIVE_ROOT, "rolling")
HIGHLIGHTS_DIR = os.path.join(ARCHIVE_ROOT, "highlights")
ROLLING_RETENTION_DAYS = 90

CHUNK_SECONDS = 120                        # length of each captured chunk
SAMPLE_RATE = 16000                        # mono 16k is plenty for voice + SAME tones

OPUS_BITRATE = "16k"                       # rolling archive bitrate
OPUS_BITRATE_HIGHLIGHT = "24k"             # keep highlights a bit higher quality

# SAME header uses AFSK: mark = 2083.3 Hz, space = 1562.5 Hz, 520.83 baud.
SAME_MARK_HZ = 2083.3
SAME_SPACE_HZ = 1562.5
SAME_MIN_BURST_SECONDS = 1.0               # a real SAME preamble burst runs ~1s+
SAME_WINDOW_MS = 100

# Detection thresholds are a SHARE of each window's total energy, not an
# absolute power. Absolute thresholds depend entirely on how loud the stream
# happens to be, so one set for a hot feed silently fires on every chunk of a
# quiet one. Measured against synthesised AFSK, a real burst puts about 0.26 of
# window energy on each tone (identically at any volume), while speech, white
# noise and steady single tones all sit below 0.005. These leave a wide margin.
SAME_MIN_SHARE_PER_TONE = 0.08
SAME_MIN_SHARE_COMBINED = 0.25

KEYWORDS = [
    "tornado", "warning", "watch", "severe thunderstorm", "flash flood",
    "tropical storm", "hurricane", "evacuat", "emergency", "storm surge",
]

# Whisper model: "tiny" or "base" is plenty for keyword-spotting and is fast
# enough to run continuously on modest hardware (including a Pi 4, slowly).
WHISPER_MODEL_SIZE = "base.en"

# Transcribing every chunk is what makes this heavy. Off means a chunk is only
# transcribed once a SAME tone has already fired, which a Pi can keep up with.
TRANSCRIBE_EVERY_CHUNK = True

# A chunk is only read once ffmpeg has stopped touching it. Skipping the newest
# file alone is not enough: ffmpeg opens the next one before finishing the last.
CHUNK_SETTLE_SECONDS = 5

CHUNK_NAME_RE = re.compile(r"^chunk_(\d{8})_(\d{6})\.wav$")

# ----------------------------------------------------------------------------
# Setup
# ----------------------------------------------------------------------------

def ensure_dirs():
    os.makedirs(ROLLING_DIR, exist_ok=True)
    os.makedirs(HIGHLIGHTS_DIR, exist_ok=True)


def log(msg):
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def have_ffmpeg():
    return shutil.which("ffmpeg") is not None


# ----------------------------------------------------------------------------
# Stream capture + segmentation (ffmpeg does the heavy lifting)
# ----------------------------------------------------------------------------

def capture_and_segment(station_id, url, work_dir):
    """
    Pulls a live stream and splits it into fixed-length WAV chunks.
    Returns (process, station_work_dir). The caller restarts it if it dies.
    """
    station_work = os.path.join(work_dir, station_id)
    os.makedirs(station_work, exist_ok=True)
    out_pattern = os.path.join(station_work, "chunk_%Y%m%d_%H%M%S.wav")

    cmd = [
        "ffmpeg", "-loglevel", "error", "-y",
        # A live HTTP stream drops occasionally. Without these ffmpeg exits and
        # the whole capture has to be torn down and rebuilt, losing whatever
        # was mid-chunk; with them it heals itself and keeps writing.
        "-reconnect", "1",
        "-reconnect_streamed", "1",
        "-reconnect_delay_max", "30",
        "-i", url,
        "-vn",                                  # ignore any album art or video track
        "-ac", "1", "-ar", str(SAMPLE_RATE),
        # State the sample format rather than trusting the default: the reader
        # below interprets the file as int16 and would produce nonsense values,
        # not an error, if ffmpeg ever chose another width.
        "-c:a", "pcm_s16le",
        "-f", "segment",
        "-segment_time", str(CHUNK_SECONDS),
        "-reset_timestamps", "1",
        "-strftime", "1",
        out_pattern,
    ]
    log(f"[{station_id}] starting capture: {url}")
    # stderr goes to DEVNULL, not PIPE. Nothing ever read that pipe, so on a
    # stream that logs steadily the buffer fills and ffmpeg blocks forever
    # writing to it: capture stops with the process still apparently alive.
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return proc, station_work


# ----------------------------------------------------------------------------
# SAME tone detection
# ----------------------------------------------------------------------------

def tone_energy_shares(frames, sample_rate, freqs):
    """
    For each window (row of `frames`), the share of its total energy sitting at
    each requested frequency. Returns an array shaped (len(freqs), n_windows).

    This is a single-bin DFT, which gives the same magnitude as the Goertzel
    recurrence but as one matrix multiply for every window at once, rather than
    a Python loop over every sample. That is the difference between keeping up
    with the audio and falling behind it on small hardware.
    """
    if frames.size == 0:
        return np.zeros((len(freqs), 0))
    # Remove DC so a stream with an offset does not inflate the totals.
    frames = frames - frames.mean(axis=1, keepdims=True)
    width = frames.shape[1]
    total = (frames ** 2).sum(axis=1) + 1e-12
    t = np.arange(width)
    out = []
    for f in freqs:
        spectrum = frames @ np.exp(-2j * np.pi * f * t / sample_rate)
        # Two-sided energy for a real signal, normalised to the window length.
        energy = 2.0 * (np.abs(spectrum) ** 2) / width
        out.append(energy / total)
    return np.vstack(out)


def read_wav_mono(wav_path):
    """Returns (samples as float64, sample_rate). Raises on an unusable file."""
    with wave.open(wav_path, "rb") as wf:
        if wf.getsampwidth() != 2:
            raise ValueError(f"expected 16-bit audio, got {wf.getsampwidth() * 8}-bit")
        sr = wf.getframerate()
        channels = wf.getnchannels()
        raw = wf.readframes(wf.getnframes())
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float64)
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    return audio, sr


def detect_same_burst(wav_path):
    """
    True when both SAME tones hold a meaningful share of window energy for at
    least SAME_MIN_BURST_SECONDS in a row. Both must be present together: the
    header toggles between them faster than one window, so a burst shows both,
    whereas a single steady tone shows only one.
    """
    try:
        audio, sr = read_wav_mono(wav_path)
    except Exception as e:
        log(f"could not read {os.path.basename(wav_path)}: {e}")
        return False

    window = int(sr * SAME_WINDOW_MS / 1000)
    if window < 16 or len(audio) < window:
        return False

    n_windows = len(audio) // window
    frames = audio[:n_windows * window].reshape(n_windows, window)
    shares = tone_energy_shares(frames, sr, [SAME_MARK_HZ, SAME_SPACE_HZ])

    hit = ((shares[0] >= SAME_MIN_SHARE_PER_TONE) &
           (shares[1] >= SAME_MIN_SHARE_PER_TONE) &
           ((shares[0] + shares[1]) >= SAME_MIN_SHARE_COMBINED))

    needed = max(1, int(SAME_MIN_BURST_SECONDS * 1000 / SAME_WINDOW_MS))
    streak = 0
    for ok in hit:
        streak = streak + 1 if ok else 0
        if streak >= needed:
            return True
    return False


# ----------------------------------------------------------------------------
# Transcription + keyword scan (lazy-loaded so tone-only runs don't need it)
# ----------------------------------------------------------------------------

_whisper_model = None

def get_whisper_model():
    global _whisper_model
    if _whisper_model is None:
        from faster_whisper import WhisperModel
        log(f"loading whisper model: {WHISPER_MODEL_SIZE}")
        _whisper_model = WhisperModel(WHISPER_MODEL_SIZE, device="cpu", compute_type="int8")
    return _whisper_model


def transcribe_and_scan(wav_path):
    model = get_whisper_model()
    segments, _ = model.transcribe(wav_path, beam_size=1)
    text = " ".join(seg.text for seg in segments).strip()
    lower = text.lower()
    matched = [kw for kw in KEYWORDS if kw in lower]
    return text, matched


# ----------------------------------------------------------------------------
# Filing: rolling archive (always) + highlights (on alert)
# ----------------------------------------------------------------------------

def encode_opus(wav_path, out_path, bitrate):
    cmd = [
        "ffmpeg", "-loglevel", "error", "-y",
        "-i", wav_path,
        "-c:a", "libopus", "-b:a", bitrate,
        out_path,
    ]
    subprocess.run(cmd, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def chunk_timestamp(wav_path):
    """
    The moment the audio was RECORDED, taken from the name ffmpeg gave it.

    Using the current time instead would stamp every file with the moment it
    happened to be processed, which is at least one chunk later and further
    behind whenever transcription is slow or a backlog builds. In an archive
    that is the difference between finding an alert and not.
    """
    m = CHUNK_NAME_RE.match(os.path.basename(wav_path))
    if m:
        try:
            return datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S") \
                           .replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    # Fall back to the file's own mtime before ever using "now".
    try:
        return datetime.fromtimestamp(os.path.getmtime(wav_path), tz=timezone.utc)
    except OSError:
        return datetime.now(timezone.utc)


def file_chunk(station_id, wav_path, transcribe_every=TRANSCRIBE_EVERY_CHUNK):
    stamp = chunk_timestamp(wav_path)
    date_dir = stamp.strftime("%Y-%m-%d")
    time_str = stamp.strftime("%H%M%S")

    rolling_station_dir = os.path.join(ROLLING_DIR, station_id, date_dir)
    os.makedirs(rolling_station_dir, exist_ok=True)
    rolling_out = os.path.join(rolling_station_dir, f"{time_str}.opus")
    encode_opus(wav_path, rolling_out, OPUS_BITRATE)

    is_alert = False
    reason = None

    if detect_same_burst(wav_path):
        is_alert = True
        reason = "same_tone"

    text, matched_kw = "", []
    if transcribe_every or is_alert:
        try:
            text, matched_kw = transcribe_and_scan(wav_path)
        except Exception as e:
            log(f"[{station_id}] transcription failed: {e}")

    if matched_kw and not is_alert:
        is_alert = True
        reason = "keyword:" + ",".join(matched_kw)

    if is_alert:
        event_dir = os.path.join(HIGHLIGHTS_DIR, station_id, date_dir)
        os.makedirs(event_dir, exist_ok=True)
        hl_out = os.path.join(event_dir, f"{time_str}.opus")
        encode_opus(wav_path, hl_out, OPUS_BITRATE_HIGHLIGHT)

        meta = {
            "station_id": station_id,
            "timestamp_utc": stamp.isoformat(),
            "reason": reason,
            "transcript": text,
            "matched_keywords": matched_kw,
        }
        with open(os.path.join(event_dir, f"{time_str}.json"), "w") as f:
            json.dump(meta, f, indent=2)

        log(f"[{station_id}] HIGHLIGHT filed ({reason}): {hl_out}")

    return is_alert


# ----------------------------------------------------------------------------
# Retention cleanup for the rolling archive
# ----------------------------------------------------------------------------

def cleanup_rolling(retention_days=ROLLING_RETENTION_DAYS):
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    removed = 0
    if not os.path.isdir(ROLLING_DIR):
        return
    for station_id in os.listdir(ROLLING_DIR):
        station_dir = os.path.join(ROLLING_DIR, station_id)
        if not os.path.isdir(station_dir):
            continue
        for date_str in os.listdir(station_dir):
            date_dir = os.path.join(station_dir, date_str)
            if not os.path.isdir(date_dir):
                continue
            try:
                day = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            except ValueError:
                continue
            if day < cutoff:
                shutil.rmtree(date_dir, ignore_errors=True)
                removed += 1
    log(f"cleanup: removed {removed} day-folders older than {retention_days} days")


# ----------------------------------------------------------------------------
# Per-station worker loop
# ----------------------------------------------------------------------------

def ready_chunks(station_work):
    """
    Chunks ffmpeg has finished with: everything except the newest, and only
    those untouched for CHUNK_SETTLE_SECONDS. Reading a file still being
    written gives a truncated tail, which reads as a missing alert.
    """
    try:
        names = sorted(n for n in os.listdir(station_work) if n.endswith(".wav"))
    except OSError:
        return []
    if len(names) <= 1:
        return []
    now = time.time()
    out = []
    for name in names[:-1]:                     # never the newest
        path = os.path.join(station_work, name)
        try:
            if now - os.path.getmtime(path) >= CHUNK_SETTLE_SECONDS:
                out.append(name)
        except OSError:
            continue
    return out


def run_station(station_id, url, work_dir, transcribe_every=TRANSCRIBE_EVERY_CHUNK):
    proc, station_work = capture_and_segment(station_id, url, work_dir)
    try:
        while True:
            time.sleep(5)
            if proc.poll() is not None:
                log(f"[{station_id}] ffmpeg exited, restarting capture")
                time.sleep(5)                   # do not hammer a dead stream
                proc, station_work = capture_and_segment(station_id, url, work_dir)
                continue

            for fname in ready_chunks(station_work):
                fpath = os.path.join(station_work, fname)
                try:
                    file_chunk(station_id, fpath, transcribe_every)
                except Exception as e:
                    # Deliberately no delete here. Removing a chunk that failed
                    # to process throws away the only copy of audio that may be
                    # exactly the alert worth keeping.
                    log(f"[{station_id}] error processing {fname}, keeping it: {e}")
                    continue
                try:
                    os.remove(fpath)
                except OSError:
                    pass
    except KeyboardInterrupt:
        pass
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=10)
        except Exception:
            pass


# ----------------------------------------------------------------------------
# Station discovery
# ----------------------------------------------------------------------------
# NOAA Weather Radio has no single official audio feed. In practice the streams
# come from volunteer Icecast relays, and each publishes a status document
# listing every mount it is currently serving. Reading those is what turns this
# from "paste in URLs you have to find yourself" into something that fills in
# its own config.
#
# These are the same three sources the GWCFC Radar site uses for its NWR audio,
# and the callsign parsing matches, because each relay names its mounts
# differently:
#   GWES  /CALLSIGN            or /CALLSIGN-alt1
#   WXR   /ST-City-CALLSIGN    or /ST-City-CALLSIGN-alt1
#   WUSA  /NWR/CALLSIGN.mp3    or /NWR/CALLSIGN_2.mp3

DISCOVERY_SOURCES = [
    ("gwes", "https://icestats.weatherradio.org"),
    ("wxr",  "https://wxradio.org/status-json.xsl"),
]

ALT_SUFFIX_RE = re.compile(r"-alt\d*$", re.IGNORECASE)
# What an NWR callsign looks like: four to six characters, starting with a
# letter, and containing at least one digit. KIH21, WXL57, KEC38, WNG645.
#
# Loose on the prefix on purpose, because they are not all K and W. Strict
# about the digit on purpose, because that is the whole job: it is what tells
# a callsign apart from the town in the mount path ("Omaha", "Largo") and from
# the bare letter on an alternate feed ("A").
CALLSIGN_RE = re.compile(r"^(?=[A-Z0-9]*\d)[A-Z][A-Z0-9]{3,5}$", re.IGNORECASE)


def _callsign_from_mount(kind, listenurl):
    tail = listenurl.rstrip("/").split("/")[-1]
    if kind == "wusa" or "/nwr/" in listenurl.lower():
        m = re.search(r"/nwr/([^/.]+)", listenurl, re.IGNORECASE)
        base = m.group(1) if m else tail.rsplit(".", 1)[0]
        return re.sub(r"_\d+$", "", base).upper()
    base = ALT_SUFFIX_RE.sub("", tail)
    base = base.rsplit(".", 1)[0] if base.lower().endswith((".mp3", ".aac", ".ogg")) else base
    if kind == "wxr":
        # ST-City-CALLSIGN, USUALLY. Some mounts carry an alternate feed of
        # the same transmitter and end in a letter: /NE-Omaha-KIH61-A. Taking
        # the LAST piece made that station's id the single letter "A", so an
        # alternate feed of KIH61 was archived under a junk name while KIH61
        # itself, offered by another relay, was rejected as a duplicate of
        # nothing. So the pieces are scanned from the end for one that is
        # actually the shape of a callsign: a letter, then two or three more
        # characters, at least one of them a digit. "A" is not that. "KIH61"
        # is. If nothing matches, the last piece is still the best guess.
        parts = [p for p in base.split("-") if p]
        base = next((p for p in reversed(parts) if CALLSIGN_RE.match(p)),
                    parts[-1] if parts else base)
    return base.upper()


def _icecast_sources(doc):
    src = (doc or {}).get("icestats", {}).get("source")
    if src is None:
        return []
    return src if isinstance(src, list) else [src]


def discover_stations(timeout=25):
    """Returns [{id, name, url}] for every NWR mount the relays are serving."""
    import urllib.request

    found = {}
    for kind, url in DISCOVERY_SOURCES:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "nwr_archiver/1.0"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                doc = json.loads(r.read().decode("utf-8", "replace"))
        except Exception as e:
            log(f"discovery: {kind} unavailable ({e})")
            continue

        n = 0
        for s in _icecast_sources(doc):
            listen = s.get("listenurl")
            if not listen:
                continue
            call = _callsign_from_mount(kind, listen)
            if not call:
                continue
            # First relay to offer a callsign wins, so a station is archived
            # once rather than duplicated across every relay carrying it.
            if call in found:
                continue
            found[call] = {
                "id": call,
                "name": (s.get("server_name") or s.get("server_description") or call).strip(),
                "url": listen,
            }
            n += 1
        log(f"discovery: {kind} offered {n} new stations")

    return [found[k] for k in sorted(found)]


def write_discovered(path, only=None):
    stations = discover_stations()
    if only:
        want = {c.strip().upper() for c in only.split(",") if c.strip()}
        stations = [s for s in stations if s["id"] in want]
        missing = want - {s["id"] for s in stations}
        if missing:
            log(f"discovery: not currently on air, skipped: {', '.join(sorted(missing))}")
    if not stations:
        sys.exit("discovery found no stations. The relays may be down, or the "
                 "callsign filter matched nothing that is on air right now.")
    with open(path, "w") as f:
        json.dump(stations, f, indent=2)
    log(f"wrote {len(stations)} stations to {path}")
    for s in stations[:10]:
        log(f"  {s['id']:10} {s['url']}")
    if len(stations) > 10:
        log(f"  ... and {len(stations) - 10} more")


# ----------------------------------------------------------------------------
# Entry point
# ----------------------------------------------------------------------------

def load_stations(path):
    with open(path) as f:
        stations = json.load(f)
    if not isinstance(stations, list) or not stations:
        raise ValueError("config must be a non-empty JSON list of stations")
    seen = set()
    for i, st in enumerate(stations):
        if not isinstance(st, dict) or "id" not in st or "url" not in st:
            raise ValueError(f"station {i} needs both an 'id' and a 'url'")
        if "example.com" in st["url"]:
            raise ValueError(
                f"station '{st['id']}' still points at the placeholder URL. "
                "Put a real stream URL in the config first."
            )
        if st["id"] in seen:
            raise ValueError(f"duplicate station id: {st['id']}")
        seen.add(st["id"])
    return stations


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, help="path to stations.json")
    parser.add_argument("--cleanup-only", action="store_true",
                        help="run retention cleanup once and exit")
    parser.add_argument("--work-dir", default="/tmp/nwr_work")
    parser.add_argument("--no-transcribe", action="store_true",
                        help="only transcribe chunks where a SAME tone fired")
    parser.add_argument("--discover", action="store_true",
                        help="ask the NWR relays what is on air, write it to --config, and exit")
    parser.add_argument("--only", default=None,
                        help="with --discover, keep only these callsigns, comma separated")
    args = parser.parse_args()

    if args.discover:
        write_discovered(args.config, args.only)
        return

    ensure_dirs()

    if not have_ffmpeg():
        sys.exit("ffmpeg not found on PATH. Install it: sudo apt install ffmpeg")

    if args.cleanup_only:
        cleanup_rolling()
        return

    try:
        stations = load_stations(args.config)
    except (OSError, ValueError, json.JSONDecodeError) as e:
        sys.exit(f"config error: {e}")

    os.makedirs(args.work_dir, exist_ok=True)
    transcribe_every = not args.no_transcribe

    import multiprocessing as mp
    workers = {}
    for st in stations:
        p = mp.Process(target=run_station,
                       args=(st["id"], st["url"], args.work_dir, transcribe_every),
                       daemon=True)
        p.start()
        workers[st["id"]] = (p, st)
        log(f"launched worker for {st['id']}")

    last_cleanup = time.time()
    try:
        while True:
            time.sleep(60)
            # A worker that died takes its station off the air silently, and the
            # gap only shows up as missing audio much later. Bring it back.
            for sid, (p, st) in list(workers.items()):
                if not p.is_alive():
                    log(f"[{sid}] worker died, restarting")
                    np_ = mp.Process(target=run_station,
                                     args=(st["id"], st["url"], args.work_dir, transcribe_every),
                                     daemon=True)
                    np_.start()
                    workers[sid] = (np_, st)
            if time.time() - last_cleanup > 6 * 3600:
                cleanup_rolling()
                last_cleanup = time.time()
    except KeyboardInterrupt:
        for p, _ in workers.values():
            p.terminate()
        for p, _ in workers.values():
            p.join(timeout=10)


if __name__ == "__main__":
    main()
