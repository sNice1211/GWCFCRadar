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
echo "built and syntax checked"
