#!/bin/bash
# Re-list NOAA's MRMS bucket into tools/mrms-catalogue.txt.
set -euo pipefail
cd "$(dirname "$0")/.."
B=https://noaa-mrms-pds.s3.amazonaws.com
tok=""; tmp=$(mktemp)
for _ in $(seq 1 20); do
  u="$B/?list-type=2&delimiter=/&prefix=CONUS/&max-keys=1000"
  [ -n "$tok" ] && u="$u&continuation-token=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' "$tok")"
  x=$(curl -sS --max-time 60 "$u")
  echo "$x" | grep -o "<Prefix>[^<]*</Prefix>" | sed 's/<[^>]*>//g' >> "$tmp"
  tok=$(echo "$x" | grep -o "<NextContinuationToken>[^<]*</NextContinuationToken>" | sed 's/<[^>]*>//g')
  [ -z "$tok" ] && break
done
sed -i 's|^CONUS/||; s|/$||' "$tmp"
head -n 12 tools/mrms-catalogue.txt | grep '^#' > tools/mrms-catalogue.txt.new
sort -u "$tmp" | grep -v '^$' >> tools/mrms-catalogue.txt.new
mv tools/mrms-catalogue.txt.new tools/mrms-catalogue.txt
rm -f "$tmp"
echo "listed $(grep -vc '^#' tools/mrms-catalogue.txt) products"
