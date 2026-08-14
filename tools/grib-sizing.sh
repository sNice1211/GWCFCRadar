#!/usr/bin/env bash
# Measures what it would actually cost to decode model data on this machine.
#
#     bash tools/grib-sizing.sh
#
# The question this answers is "can the Pi do what Pivotal Weather does", and
# the honest answer depends on numbers that vary by connection and by hardware,
# so it measures them here rather than quoting figures from elsewhere.
#
# The important trick it demonstrates: a full GFS file is around half a
# gigabyte per forecast hour, and downloading those would be hopeless. But
# NOAA publishes a .idx index next to every file listing the byte offset of
# every field in it, so a single variable can be pulled with an HTTP range
# request. That turns 500 MB into a couple of megabytes, and it is the whole
# reason this is feasible on a Pi at all.
#
# Send the output back.

set -u
UA='Mozilla/5.0 (GWCFC Radar sizing)'
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# Variables a map chart actually needs. Names as they appear in the .idx.
WANT='TMP:2 m|APCP|UGRD:10 m|VGRD:10 m|PRMSL|CAPE:surface|REFC|DPT:2 m'

# Most recent GFS run that is certain to be published (runs appear about
# 3.5 to 5 hours after their nominal time, so step well back).
now=$(date -u +%s)
run=$(( (now - 6*3600) / 21600 * 21600 ))
DATE=$(date -u -d "@$run" +%Y%m%d 2>/dev/null || date -u -r "$run" +%Y%m%d)
HH=$(date -u -d "@$run" +%H 2>/dev/null || date -u -r "$run" +%H)

BASE="https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod/gfs.${DATE}/${HH}/atmos"
FILE="gfs.t${HH}z.pgrb2.0p25.f012"

echo "======================================================================"
echo "Model data sizing on this machine"
echo "GFS run ${DATE} ${HH}Z, forecast hour 012"
echo "======================================================================"
echo

echo "1. The index file, which is what makes this cheap"
t0=$(date +%s.%N)
code=$(curl -s -A "$UA" -o "$TMP/idx" -w '%{http_code}' --max-time 60 "$BASE/$FILE.idx")
t1=$(date +%s.%N)
if [ "$code" != "200" ]; then
  echo "   FAILED (HTTP $code). Cannot reach NOMADS from here."
  echo "   Everything below needs it, so stopping."
  exit 1
fi
lines=$(wc -l < "$TMP/idx")
idxsz=$(wc -c < "$TMP/idx")
printf '   HTTP 200, %s bytes, %s fields listed, %.1fs\n' "$idxsz" "$lines" "$(echo "$t1-$t0"|bc)"
echo "   (the full file has $lines fields; we want about 8 of them)"
echo

echo "2. Byte ranges for just the fields a chart needs"
# Each idx line: num:startbyte:date:var:level:fcst. The field ends where the
# next field starts, so the range needs the following line too.
awk -F: -v want="$WANT" '
  BEGIN { n=split(want, W, "|") }
  { start[NR]=$2; line[NR]=$0 }
  END {
    for (i=1; i<=NR; i++) {
      for (j=1; j<=n; j++) {
        # Take each variable once. GFS carries the same field under several
        # time-aggregations, so a plain substring match pulled TMP:2 m three
        # times and inflated the download by well over half.
        if (index(line[i], W[j]) && !taken[W[j]]) {
          taken[W[j]] = 1
          e = (i<NR) ? start[i+1]-1 : ""
          printf "%s-%s %s\n", start[i], e, W[j]
          break
        }
      }
    }
  }' "$TMP/idx" > "$TMP/ranges"
nr=$(wc -l < "$TMP/ranges")
echo "   matched $nr fields"
sed 's/^/     /' "$TMP/ranges" | head -12
echo

echo "3. Downloading only those ranges"
total=0; t0=$(date +%s.%N)
i=0
while read -r range label; do
  i=$((i+1))
  curl -s -A "$UA" -r "$range" -o "$TMP/part.$i" --max-time 90 "$BASE/$FILE" || true
  sz=$(wc -c < "$TMP/part.$i" 2>/dev/null || echo 0)
  total=$((total + sz))
done < "$TMP/ranges"
t1=$(date +%s.%N)
cat "$TMP"/part.* > "$TMP/subset.grib2" 2>/dev/null || true
dl=$(echo "$t1-$t0"|bc)
printf '   %s fields, %.2f MB total, %.1fs\n' "$i" "$(echo "scale=2;$total/1048576"|bc)" "$dl"

echo
echo "3b. The same fields, cropped to CONUS by the server"
# The ranges above pull each field for the whole globe: 1440x721 points, when a
# CONUS chart needs about 4% of that. NOMADS can crop before sending, which is
# the difference between a gigabyte a day and a few tens of megabytes. This is
# what the pipeline should use; the byte-range trick above is the fallback for
# models that publish no filter endpoint.
FILT="https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl"
Q="file=${FILE}&dir=%2Fgfs.${DATE}%2F${HH}%2Fatmos"
Q="$Q&var_TMP=on&var_APCP=on&var_UGRD=on&var_VGRD=on&var_PRMSL=on&var_CAPE=on&var_REFC=on&var_DPT=on"
Q="$Q&lev_2_m_above_ground=on&lev_10_m_above_ground=on&lev_mean_sea_level=on&lev_surface=on&lev_entire_atmosphere=on"
Q="$Q&subregion=&leftlon=-130&rightlon=-60&toplat=55&bottomlat=20"
t0=$(date +%s.%N)
code=$(curl -s -A "$UA" -o "$TMP/conus.grib2" -w '%{http_code}' --max-time 120 "$FILT?$Q")
t1=$(date +%s.%N)
csz=$(wc -c < "$TMP/conus.grib2" 2>/dev/null || echo 0)
if [ "$code" = "200" ] && [ "$csz" -gt 5000 ]; then
  ct=$(echo "$t1-$t0"|bc)
  printf '   HTTP 200, %.2f MB, %.1fs\n' "$(echo "scale=2;$csz/1048576"|bc)" "$ct"
  printf '   vs the global slices above: %.1fx smaller\n' "$(echo "scale=1;$total/($csz+1)"|bc)"
  echo
  echo "   Per run and per day on THIS approach:"
  cper=$(echo "scale=3;$csz/1048576"|bc)
  printf '     download : %s MB per step, %.1f MB per run, %.1f MB per day\n' \
    "$cper" "$(echo "scale=1;$cper*40"|bc)" "$(echo "scale=1;$cper*40*4"|bc)"
  printf '     time     : %.1fs per step, about %.1f min per run\n' \
    "$ct" "$(echo "scale=2;$ct*40/60"|bc)"
else
  echo "   HTTP $code, $csz bytes. Filter endpoint did not answer as expected;"
  echo "   the byte-range approach above still works, just heavier."
  head -c 200 "$TMP/conus.grib2" 2>/dev/null | tr -d '\0'; echo
fi

echo
echo "4. For contrast, the size of the whole file"
full=$(curl -s -A "$UA" -I --max-time 45 "$BASE/$FILE" | awk 'BEGIN{IGNORECASE=1}/^content-length:/{gsub(/\r/,"");print $2}')
if [ -n "${full:-}" ]; then
  printf '   full file: %.0f MB   subset: %.2f MB   ratio: %.0fx smaller\n' \
    "$(echo "scale=2;$full/1048576"|bc)" \
    "$(echo "scale=2;$total/1048576"|bc)" \
    "$(echo "scale=0;$full/($total+1)"|bc)"
else
  echo "   (server did not report a length)"
fi

echo
echo "5. Can this machine decode it, and how fast?"
have=""
command -v wgrib2  >/dev/null 2>&1 && have="$have wgrib2"
command -v grib_ls >/dev/null 2>&1 && have="$have eccodes"
python3 -c "import cfgrib" 2>/dev/null && have="$have cfgrib"
python3 -c "import pygrib" 2>/dev/null && have="$have pygrib"
if [ -z "$have" ]; then
  echo "   No GRIB decoder installed yet. To add one:"
  echo "     sudo apt install wgrib2          # simplest, fastest"
  echo "     sudo apt install libeccodes-tools # or ECMWF's, more capable"
  echo "   Re-run this afterwards for a real decode timing."
else
  echo "   found:$have"
  if command -v wgrib2 >/dev/null 2>&1; then
    t0=$(date +%s.%N)
    wgrib2 "$TMP/subset.grib2" -inv /dev/null 2>/dev/null
    t1=$(date +%s.%N)
    printf '   scan of %s fields: %.2fs\n' "$i" "$(echo "$t1-$t0"|bc)"
    t0=$(date +%s.%N)
    wgrib2 "$TMP/subset.grib2" -match 'TMP:2 m' -csv "$TMP/out.csv" >/dev/null 2>&1
    t1=$(date +%s.%N)
    rows=$(wc -l < "$TMP/out.csv" 2>/dev/null || echo 0)
    printf '   full decode of one field to values: %.2fs (%s points)\n' "$(echo "$t1-$t0"|bc)" "$rows"
  fi
fi

echo
echo "6. What that means per day"
echo "   GFS runs 4x/day. A 5-day chart at 3-hourly steps is 40 forecast hours."
perstep=$(echo "scale=3;$total/1048576"|bc)
perrun=$(echo "scale=1;$perstep*40"|bc)
perday=$(echo "scale=1;$perrun*4"|bc)
printf '   download : %s MB per step, %s MB per run, %s MB per day\n' "$perstep" "$perrun" "$perday"
if [ -n "${dl:-}" ]; then
  printf '   time     : %.0fs per step at the speed measured above, so about %.0f min per run\n' \
    "$dl" "$(echo "scale=2;$dl*40/60"|bc)"
fi
echo
echo "   But raw GRIB is NOT what gets kept. It is decoded to a plain grid,"
echo "   saved small, and deleted. A 512x320 CONUS grid quantised to 8 bits"
echo "   and PNG-compressed is roughly 60 KB per field:"
echo "     8 fields x 40 steps        = 320 files ~ 19 MB per run"
echo "     4 runs/day                 = ~77 MB per day"
echo "     keeping 48 hours of runs   = ~155 MB on disk, steady state"
echo
echo "======================================================================"
echo "Done. Send this back."
echo "======================================================================"
