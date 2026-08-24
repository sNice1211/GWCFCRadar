#!/usr/bin/env bash
# nwr_setup.sh - one-paste setup for the NWRchive recorder on the homelab.
#
#   curl -fsSL https://raw.githubusercontent.com/ralphhtml/GWCFCRadar/main/pi/nwr_setup.sh | bash
#
# Does everything: installs dependencies, downloads the archiver and indexer,
# discovers the stations, creates and starts the two background services, and
# links the archive into ~/wxdata so serve.py publishes it. Safe to run again:
# it updates the scripts and restarts the services without touching recordings.
#
# Pick different stations by setting NWR_STATIONS first, e.g.:
#   NWR_STATIONS=KIH21,KEC50,KHB34 bash nwr_setup.sh
# or record everything on air:
#   NWR_STATIONS=all bash nwr_setup.sh
set -euo pipefail

RAW="https://raw.githubusercontent.com/ralphhtml/GWCFCRadar/main/pi"
DIR="$HOME/nwrchiver"
CONF="$HOME/stations.json"
ROOT="/mnt/nwr_archive"
STATIONS="${NWR_STATIONS:-KIH21,KEC50}"

say() { printf '\n>>> %s\n' "$*"; }

say "Installing ffmpeg (sudo may ask for your password)"
sudo apt-get install -y ffmpeg >/dev/null

say "Installing python pieces (numpy required, whisper transcription optional)"
PIP="pip3"; command -v pip3 >/dev/null || PIP="pip"
$PIP install numpy --break-system-packages >/dev/null 2>&1 \
  || $PIP install numpy >/dev/null
TRANSCRIBE_FLAG=""
if ! $PIP install faster-whisper --break-system-packages >/dev/null 2>&1; then
  if ! $PIP install faster-whisper >/dev/null 2>&1; then
    TRANSCRIBE_FLAG="--no-transcribe"
    say "Transcription engine would not install; recording tone-only (still catches every SAME alert)"
  fi
fi

say "Downloading the archiver and indexer into $DIR"
mkdir -p "$DIR"
curl -fsSL "$RAW/nwr_archiver.py" -o "$DIR/nwr_archiver.py"
curl -fsSL "$RAW/nwr_index.py"    -o "$DIR/nwr_index.py"

say "Making the storage folder $ROOT"
sudo mkdir -p "$ROOT"
sudo chown "$USER" "$ROOT"

if [ ! -s "$CONF" ]; then
  say "Asking the relays what is on air (stations: $STATIONS)"
  if [ "$STATIONS" = "all" ]; then
    python3 "$DIR/nwr_archiver.py" --discover --config "$CONF"
  else
    python3 "$DIR/nwr_archiver.py" --discover --config "$CONF" --only "$STATIONS"
  fi
else
  say "Keeping your existing $CONF (delete it and re-run to re-discover)"
fi

say "Creating the two background services"
sudo tee /etc/systemd/system/gwcfc-nwr.service >/dev/null <<UNIT
[Unit]
Description=NWR audio archiver
After=network-online.target
[Service]
ExecStart=/usr/bin/python3 $DIR/nwr_archiver.py --config $CONF $TRANSCRIBE_FLAG
Restart=always
RestartSec=10
User=$USER
[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/gwcfc-nwr-index.service >/dev/null <<UNIT
[Unit]
Description=NWR archive indexer
After=network-online.target
[Service]
ExecStart=/usr/bin/python3 $DIR/nwr_index.py --root $ROOT --stations $CONF --loop 300
Restart=always
RestartSec=10
User=$USER
[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable gwcfc-nwr gwcfc-nwr-index >/dev/null
sudo systemctl restart gwcfc-nwr gwcfc-nwr-index

say "Publishing the archive through serve.py"
mkdir -p "$HOME/wxdata"
ln -sfn "$ROOT" "$HOME/wxdata/nwr"
python3 "$DIR/nwr_index.py" --root "$ROOT" --stations "$CONF" || true

say "Done. Checking:"
systemctl is-active gwcfc-nwr       && echo "  archiver: running"
systemctl is-active gwcfc-nwr-index && echo "  indexer:  running"
echo
echo "In about 5 minutes, check recordings exist:   ls $ROOT/rolling/*/"
echo "Watch it live:                                journalctl -u gwcfc-nwr -f"
echo "Then open the site once as:"
echo "  nwrchive.html?base=https://YOUR-PI-PUBLIC-ADDRESS/nwr"
