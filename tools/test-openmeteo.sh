#!/usr/bin/env bash
# Reproduces exactly what the radar asks Open-Meteo for, and reports what comes
# back. Run it from a machine with normal internet access, such as the Pi:
#
#     bash tools/test-openmeteo.sh
#
# It answers the questions that cannot be answered from the code alone:
#   how many coordinates a single request will actually accept,
#   whether every model the menu offers really serves the product asked of it,
#   and what the service says when it refuses.
#
# Send the whole output back.

set -u
UA='Mozilla/5.0 (GWCFC Radar API check)'
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

VAR=temperature_2m
DAYS=7

# A block of coordinates over the United States, the same shape the app samples.
coords() {                       # coords N -> "lat,lat,..." "lon,lon,..."
  local n="$1" lats="" lons="" i lat lon
  for ((i=0; i<n; i++)); do
    lat=$(awk -v i="$i" 'BEGIN{printf "%.3f", 30 + (i%11)*1.5}')
    lon=$(awk -v i="$i" 'BEGIN{printf "%.3f", -105 + int(i/11)*1.8}')
    lats="${lats:+$lats,}$lat"; lons="${lons:+$lons,}$lon"
  done
  printf '%s\n%s\n' "$lats" "$lons"
}

echo "1. How many coordinates does one request accept?"
echo "   (the app currently sends 25 per request; it used to send 100)"
echo
for N in 5 15 25 50 100 200; do
  mapfile -t C < <(coords "$N")
  url="https://api.open-meteo.com/v1/forecast?latitude=${C[0]}&longitude=${C[1]}&hourly=$VAR&models=gfs_seamless&forecast_days=$DAYS&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch"
  code=$(curl -s -A "$UA" -o "$TMP/r.json" -w '%{http_code}' --max-time 60 "$url")
  if [ "$code" = "200" ]; then
    got=$(python3 -c "
import json,sys
d=json.load(open('$TMP/r.json'))
d=d if isinstance(d,list) else [d]
print(len(d), sum(1 for x in d if x.get('hourly',{}).get('$VAR')))
" 2>/dev/null || echo "? ?")
    printf '   %3d coords -> HTTP 200   entries/with-data: %s\n' "$N" "$got"
  else
    why=$(python3 -c "
import json;print(json.load(open('$TMP/r.json')).get('reason','')[:110])
" 2>/dev/null || head -c 110 "$TMP/r.json")
    printf '   %3d coords -> HTTP %s   %s\n' "$N" "$code" "$why"
  fi
done

echo
echo "2. Does every model in the menu serve every product?"
echo
for M in gfs_seamless gem_seamless ukmo_seamless meteofrance_arpege_world \
         jma_seamless ecmwf_aifs025_single cma_grapes_global bom_access_global; do
  line="   $(printf '%-26s' "$M")"
  for V in temperature_2m precipitation wind_gusts_10m; do
    url="https://api.open-meteo.com/v1/forecast?latitude=35.5,36.0&longitude=-98.0,-97.5&hourly=$V&models=$M&forecast_days=$DAYS"
    code=$(curl -s -A "$UA" -o "$TMP/m.json" -w '%{http_code}' --max-time 45 "$url")
    if [ "$code" = "200" ]; then
      ok=$(python3 -c "
import json
d=json.load(open('$TMP/m.json')); d=d if isinstance(d,list) else [d]
h=(d[0].get('hourly') or {}).get('$V') or []
vals=[v for v in h if v is not None]
print('data' if vals else 'EMPTY')
" 2>/dev/null || echo '?')
      line="$line ${V%%_*}:$ok"
    else
      line="$line ${V%%_*}:HTTP$code"
    fi
  done
  echo "$line"
done

echo
echo "3. Ensemble endpoint, as the app calls it"
url="https://ensemble-api.open-meteo.com/v1/ensemble?latitude=35.5,36.0&longitude=-98.0,-97.5&hourly=$VAR&models=gfs_seamless&forecast_days=4"
code=$(curl -s -A "$UA" -o "$TMP/e.json" -w '%{http_code}' --max-time 60 "$url")
echo "   HTTP $code"
[ "$code" = "200" ] && python3 -c "
import json
d=json.load(open('$TMP/e.json')); d=d if isinstance(d,list) else [d]
h=d[0].get('hourly') or {}
mem=[k for k in h if k.startswith('$VAR')]
print('   members returned:', len(mem))
print('   first hour     :', (h.get('time') or ['?'])[0])
" 2>/dev/null

echo
echo "4. What the allowance looks like right now"
url="https://api.open-meteo.com/v1/forecast?latitude=35.5&longitude=-98.0&hourly=$VAR&forecast_days=1"
curl -s -A "$UA" -D "$TMP/h.txt" -o "$TMP/h.json" --max-time 30 "$url"
# Captured first rather than piped: in a pipeline the exit status is sed's, so
# the "|| echo" fallback never fired and this section printed nothing at all
# when no headers were present, which is exactly the case worth reporting.
hdrs=$(grep -iE '^(x-ratelimit|retry-after|ratelimit)' "$TMP/h.txt" || true)
if [ -n "$hdrs" ]; then
  printf '%s\n' "$hdrs" | sed 's/^/   /'
else
  echo "   no rate-limit headers published"
fi

# The single most useful line in this whole script: whether the allowance is
# spent right now. Everything above reports HTTP 429 when it is, which looks
# like every model being broken rather than one quota being empty.
if grep -qi 'daily api request limit' "$TMP/h.json" 2>/dev/null; then
  echo "   DAILY ALLOWANCE IS SPENT. It resets at 00:00 UTC."
  echo "   Sections 1 and 2 above cannot be answered until then; re-run after the reset."
else
  echo "   Allowance has room: a single-point request succeeded."
fi

echo
echo "Done. Send all of this back."
