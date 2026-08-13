#!/usr/bin/env bash
# Asks every candidate WMS provider what model layers it offers, so the radar's
# model list can be built from what actually exists rather than from guesswork.
#
# Run it somewhere with normal internet access, such as the Pi:
#     bash tools/discover-model-layers.sh          # summary
#     bash tools/discover-model-layers.sh --all    # every layer name
#
# These are the providers that already run the pipeline Tropical Tidbits and
# Pivotal Weather run: GRIB in, rendered raster out. Using their WMS is the same
# idea as those sites, with the agency doing the rendering, which is what makes
# it possible from a static site with no backend at all.
#
# Send the output back and the working layers can be wired into the model menu.

set -u
UA='Mozilla/5.0 (GWCFC Radar layer discovery)'
ALL=0; [ "${1:-}" = "--all" ] && ALL=1
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

probe() {
  local name="$1" url="$2" filter="$3"
  echo
  echo "=============================================================="
  echo "$name"
  echo "$url"
  echo "=============================================================="

  local cap="$TMP/cap.xml" code
  code=$(curl -s -A "$UA" -o "$cap" -w '%{http_code}' --max-time 90 \
         "${url}?service=WMS&version=1.3.0&request=GetCapabilities")
  if [ "$code" != "200" ]; then
    echo "  UNREACHABLE (HTTP $code)"
    return
  fi

  local total
  # Layer names live in <Name> inside <Layer>. Good enough across servers, and
  # avoids needing an XML parser on a Pi.
  total=$(grep -oE '<Name>[^<]+</Name>' "$cap" | sed -E 's/<\/?Name>//g' | sort -u | wc -l)
  echo "  reachable, $total layer names published"

  if [ "$ALL" -eq 1 ]; then
    grep -oE '<Name>[^<]+</Name>' "$cap" | sed -E 's/<\/?Name>//g' | sort -u | sed 's/^/    /'
  else
    echo "  layers matching: $filter"
    grep -oE '<Name>[^<]+</Name>' "$cap" | sed -E 's/<\/?Name>//g' | sort -u \
      | grep -iE "$filter" | head -25 | sed 's/^/    /'
    local n
    n=$(grep -oE '<Name>[^<]+</Name>' "$cap" | sed -E 's/<\/?Name>//g' | sort -u | grep -icE "$filter")
    [ "$n" -gt 25 ] && echo "    ... and $((n - 25)) more matches"
  fi
}

echo "Candidate model-chart providers"
echo "Each renders GRIB server-side and serves the result as map layers."

# Environment Canada. HRDPS, RDPS, GDPS and the ensembles, many variables.
probe "GeoMet (Environment Canada)" \
      "https://geo.weather.gc.ca/geomet" \
      "HRDPS|RDPS|GDPS|REPS|GEPS"

# NOAA nowCOAST. GFS, HRRR, NBM, NDFD rendered by NWS itself.
probe "NOAA nowCOAST" \
      "https://nowcoast.noaa.gov/geoserver/ows" \
      "gfs|hrrr|nbm|ndfd|model"

# DWD. ICON global and ICON-EU, single and pressure levels.
probe "DWD GeoServer" \
      "https://maps.dwd.de/geoserver/dwd/wms" \
      "ICON|GFS|model"

# Iowa State. Already used for NEXRAD, GOES and NDFD here.
probe "Iowa State IEM (NDFD)" \
      "https://mesonet.agron.iastate.edu/cgi-bin/wms/us/ndfd.cgi" \
      "."

probe "Iowa State IEM (HRRR)" \
      "https://mesonet.agron.iastate.edu/cgi-bin/wms/hrrr/refd.cgi" \
      "."

echo
echo "=============================================================="
echo "Done. Send this output back."
echo "Anything marked UNREACHABLE is dropped; the rest can be wired"
echo "into the model menu as real map charts."
echo "=============================================================="
