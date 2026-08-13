#!/usr/bin/env bash
# Verifies every weather-model service the radar uses.
#
# Run this from a machine with normal internet access, such as the Pi:
#     bash tools/verify-model-sources.sh
#
# Each service gets a real GetMap request for a real layer, and is judged on
# what comes back rather than on whether the host answers at all: a WMS that is
# up but rejecting the request returns an XML ServiceException with HTTP 200,
# which a plain reachability check reports as success.
#
# PASS means an actual image came back and that model works.

set -u
UA='Mozilla/5.0 (GWCFC Radar model check)'
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

check() {
  local name="$1" url="$2"
  local out="$TMP/out.bin"
  local code
  code=$(curl -s -A "$UA" -o "$out" -w '%{http_code}' --max-time 45 "$url" 2>/dev/null)
  local kind; kind=$(file -b --mime-type "$out" 2>/dev/null || echo unknown)
  local size; size=$(wc -c < "$out" 2>/dev/null || echo 0)

  if [ "$code" != "200" ]; then
    printf '  FAIL  %-22s HTTP %s\n' "$name" "$code"; fail=$((fail+1)); return
  fi
  case "$kind" in
    image/*)
      if [ "$size" -lt 400 ]; then
        printf '  WARN  %-22s image but only %s bytes, probably blank\n' "$name" "$size"
        pass=$((pass+1))
      else
        printf '  PASS  %-22s %s, %s bytes\n' "$name" "$kind" "$size"
        pass=$((pass+1))
      fi
      ;;
    *)
      # A ServiceException is the useful case: the service is alive and telling
      # us exactly what it dislikes about the request.
      local why
      why=$(tr -d '\n' < "$out" | grep -oE '<ServiceException[^>]*>[^<]{0,120}' | head -1)
      printf '  FAIL  %-22s %s %s\n' "$name" "$kind" "${why:-$(head -c 90 "$out" | tr -d '\n')}"
      fail=$((fail+1))
      ;;
  esac
}

BBOX='-105,30,-85,45'          # CRS:84 order: west,south,east,north
SIZE='WIDTH=400&HEIGHT=300'
COMMON="service=WMS&version=1.3.0&request=GetMap&CRS=CRS:84&BBOX=$BBOX&$SIZE&FORMAT=image/png&TRANSPARENT=true&STYLES="

echo "Model services used by the radar"
echo "--------------------------------"

check "HRRR reflectivity" \
  "https://mesonet.agron.iastate.edu/cgi-bin/wms/hrrr/refd.cgi?${COMMON}&LAYERS=refd_0000"

check "NDFD temperature" \
  "https://mesonet.agron.iastate.edu/cgi-bin/wms/us/ndfd.cgi?${COMMON}&LAYERS=ndfd_temp"

check "GeoMet (HRDPS)" \
  "https://geo.weather.gc.ca/geomet?${COMMON}&LAYERS=HRDPS.CONTINENTAL_TT"

check "DWD ICON" \
  "https://maps.dwd.de/geoserver/dwd/wms?${COMMON}&LAYERS=dwd:ICON_EU_SINGLE_LEVEL_ELEMENT_TT_2M"

check "ECMWF eccharts" \
  "https://eccharts.ecmwf.int/wms/?${COMMON}&LAYERS=temperature"

echo
echo "Reference feeds the radar also relies on"
echo "---------------------------------------"
for pair in \
  "NWS alerts|https://api.weather.gov/alerts/active?limit=1" \
  "SPC storm reports|https://www.spc.noaa.gov/climo/reports/today_torn.csv" ; do
  n="${pair%%|*}"; u="${pair#*|}"
  c=$(curl -s -A "$UA" -o /dev/null -w '%{http_code}' --max-time 30 "$u")
  if [ "$c" = "200" ]; then printf '  PASS  %-22s HTTP 200\n' "$n"; pass=$((pass+1))
  else printf '  FAIL  %-22s HTTP %s\n' "$n" "$c"; fail=$((fail+1)); fi
done

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ] || echo "Send the FAIL lines back and the failing models can be dropped too."
