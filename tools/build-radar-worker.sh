#!/usr/bin/env bash
# Builds assets/radar_worker.bundle.js from src/parse/radar_worker.js, which
# is SparkRadar's worker over SparkRadar's vendored parsers.
#
#     bash tools/build-radar-worker.sh
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d src/parse/node_modules ] || (cd src/parse && npm i --silent)
npx --yes esbuild src/parse/radar_worker.js \
  --bundle --format=iife \
  --alias:zlib=./src/parse/shims/zlib.js \
  --inject:./src/parse/shims/inject-buffer.js \
  --outfile=assets/radar_worker.bundle.js
node --check assets/radar_worker.bundle.js
# Stamp the page with this build's hash, so the worker URL changes whenever
# the bundle does and a cached page can never load a decoder it was not built
# with. See RADAR_WORKER_V in index.html.
HASH=$(md5sum assets/radar_worker.bundle.js | cut -c1-8)
sed -i "s/var RADAR_WORKER_V = '[0-9a-f]*';/var RADAR_WORKER_V = '$HASH';/" index.html
grep -q "var RADAR_WORKER_V = '$HASH';" index.html
echo "built, syntax checked, page stamped v=$HASH"
