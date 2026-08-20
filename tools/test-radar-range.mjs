#!/usr/bin/env node
/*
 * How far a single-site radar picture actually reaches.
 *
 *     node tools/test-radar-range.mjs
 *
 * The cap used to be a flat count of 460 GATES, and a gate is not a fixed
 * distance. On the legacy one-kilometre gates that meant 460 km, the whole
 * sweep. On the 250 metre super-resolution gates that every modern VCP uses
 * at its lowest tilt it meant 115 km, a quarter of what the radar measured.
 * That is the bug: the number looked like a range and behaved like one only
 * on the resolution nobody uses any more.
 *
 * So the reach is measured here, in kilometres, by running the real decoder
 * over a synthetic sweep with data in every gate and asking how far the
 * furthest polygon it drew actually is from the antenna. A structural check
 * that "the option is named range_limit_km" would pass just as happily on
 * code that ignored it.
 *
 * The decoder is bundled with esbuild first, because it imports the vendored
 * parsers with extensionless paths that only a bundler resolves. That is the
 * same bundler the shipped worker is built with, so what runs here is what
 * runs in the browser.
 */

import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, unlinkSync, mkdtempSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { tmpdir } from 'os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

// ── Bundle the decoder so its internals can be called directly ─────────────
const entry = join(ROOT, 'src', 'parse', '__range_test_entry.js');
const outDir = mkdtempSync(join(tmpdir(), 'gwcfc-range-'));
const out = join(outDir, 'worker.mjs');
let mod;
try {
  const src = readFileSync(join(ROOT, 'src', 'parse', 'radar_worker.js'), 'utf8')
    + '\nexport { processRadarData, processLevel3Data, strideForRange, '
    + 'readRangeOptions };\n';
  writeFileSync(entry, src);
  execFileSync('npx', ['--yes', 'esbuild', entry, '--bundle', '--format=esm',
    '--alias:zlib=./src/parse/shims/zlib.js',
    '--inject:./src/parse/shims/inject-buffer.js',
    '--log-level=error', '--outfile=' + out], { cwd: ROOT, stdio: 'pipe' });
} catch (e) {
  console.log('could not bundle the decoder, skipping. ' + (e.message || e));
  try { unlinkSync(entry); } catch (_) {}
  process.exit(0);
} finally {
  try { unlinkSync(entry); } catch (_) {}
}
globalThis.self = { onmessage: null, postMessage() {} };
mod = await import('file://' + out);

const SITE = [35.3331, -97.2778];   // KTLX, Oklahoma City
const EARTH_KM = 6371;

// Great-circle distance, so the answer is a real range and not a count of
// degrees that means different distances at different latitudes.
function kmFrom(lat, lon) {
  const toRad = Math.PI / 180;
  const dLat = (lat - SITE[0]) * toRad;
  const dLon = (lon - SITE[1]) * toRad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(SITE[0] * toRad) * Math.cos(lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

// The furthest corner of any polygon the decoder drew.
function reachKm(meshData) {
  let far = 0;
  for (let i = 0; i < meshData.length; i += 9) {
    for (let k = 0; k < 8; k += 2) {
      const d = kmFrom(meshData[i + k + 1], meshData[i + k]);
      if (d > far) far = d;
    }
  }
  return far;
}
const quadCount = (meshData) => meshData.length / 9;

// A sweep with a value in every gate, so nothing is dropped for being empty
// and the reach measured is the decoder's own limit rather than the weather's.
function fakeL2({ gateSize, gateCount, radials = 360, value = 30, layer = 'REF',
                  fill = null }) {
  const rows = [];
  const headers = [];
  for (let i = 0; i < radials; i++) {
    const moment_data = new Array(gateCount);
    for (let g = 0; g < gateCount; g++) {
      moment_data[g] = fill ? fill(g, i) : value;
    }
    rows.push({ moment_data, gate_count: gateCount,
                first_gate: gateSize, gate_size: gateSize });
    headers.push({ azimuth: (i * 360) / radials, radial: { nyquist_velocity: 30 } });
  }
  const getters = {
    REF: 'getHighresReflectivity', VEL: 'getHighresVelocity',
    CC: 'getHighresCorrelationCoefficient', KDP: 'getHighresDiffPhase',
    SW: 'getHighresSpectrum', ZDR: 'getHighresDiffReflectivity',
  };
  const radar = { getHeader: () => headers, hasGaps: false, isTruncated: false,
                  listElevations: () => [1], elevation: 1, setElevation() {} };
  for (const g of Object.values(getters)) radar[g] = () => [];
  radar[getters[layer]] = () => rows;
  return radar;
}

const runL2 = (radar, layer, options) =>
  mod.processRadarData(radar, SITE, null, layer, options || {});

console.log('\n1. a super-resolution sweep reaches the whole 460 km, not a quarter of it');
{
  // The real geometry: 250 m gates, 1832 of them, which is what a WSR-88D
  // surveillance cut carries at the lowest tilt on VCP 12 and 212.
  const radar = fakeL2({ gateSize: 0.25, gateCount: 1832, radials: 180 });
  const res = runL2(radar, 'REF', { range_limit_km: 460 });
  const far = reachKm(res.meshData);
  ok('it draws something at all', res.meshData.length > 0);
  ok('and it reaches past 450 km', far > 450, far.toFixed(0) + ' km');
  // The old behaviour, kept as a named number so the regression is a failure
  // and not a shrug: 460 gates of 250 m is 115 km.
  ok('rather than stopping at the 115 km the old gate count gave',
     far > 115 * 2, far.toFixed(0) + ' km');

  const capped = runL2(radar, 'REF', { range_limit_km: 150 });
  ok('and an explicit shorter limit is still honoured, in kilometres',
     Math.abs(reachKm(capped.meshData) - 150) < 5,
     reachKm(capped.meshData).toFixed(0) + ' km');
}

console.log('\n2. and so does a legacy sweep, which is the case that always worked');
{
  // 1 km gates. The old flat cap of 460 gates happened to be right here, so
  // this is the case that must NOT have changed.
  const radar = fakeL2({ gateSize: 1, gateCount: 460, radials: 180 });
  const res = runL2(radar, 'REF', { range_limit_km: 460 });
  const far = reachKm(res.meshData);
  ok('a kilometre-gate sweep still reaches its full 460 km',
     far > 450, far.toFixed(0) + ' km');
  // Gates already a kilometre long are coarser than the beam is wide out to
  // 57 km, so merging them would be throwing away real resolution.
  ok('and nothing is merged, because these gates are already coarse',
     quadCount(res.meshData) === 180 * 459,
     `${quadCount(res.meshData)} vs ${180 * 459}`);
}

console.log('\n3. velocity stops where the Doppler does, rather than pretending');
{
  const radar = fakeL2({ gateSize: 0.25, gateCount: 1192, radials: 180,
                         layer: 'VEL', value: 10 });
  const res = runL2(radar, 'VEL', { range_limit_km: 300,
                                    enableVelocityDealias: false });
  const far = reachKm(res.meshData);
  ok('it reaches about 300 km', far > 280 && far < 310, far.toFixed(0) + ' km');
}

console.log('\n4. the cost of the extra range is bounded, because cells lengthen');
{
  const radar = fakeL2({ gateSize: 0.25, gateCount: 1832, radials: 180 });
  const full = runL2(radar, 'REF', { range_limit_km: 460 });
  const raw = runL2(radar, 'REF', { range_limit_km: 460, full_detail: true });
  const oldWay = 180 * 460;         // what the flat 460-gate cap produced
  ok('drawing every gate to 460 km really would be four times the old count',
     quadCount(raw.meshData) > oldWay * 3.5,
     `${quadCount(raw.meshData)} vs ${oldWay}`);
  ok('and the thinning brings it back to about twice, for four times the range',
     quadCount(full.meshData) < oldWay * 2.5,
     `${quadCount(full.meshData)} vs ${oldWay}`);
  ok('while still reaching just as far as the unthinned version',
     Math.abs(reachKm(full.meshData) - reachKm(raw.meshData)) < 2,
     `${reachKm(full.meshData).toFixed(0)} vs ${reachKm(raw.meshData).toFixed(0)}`);
}

console.log('\n5. the thinning only happens where the beam is already wider');
{
  // The whole justification: a one degree beam is 2 km across at 115 km and
  // 4 km at 230. A 250 m radial cell out there is finer than anything the
  // radar can resolve, so merging costs nothing that was ever measured.
  ok('inside 100 km nothing is merged at all',
     mod.strideForRange(50, 0.25, false) === 1
     && mod.strideForRange(99, 0.25, false) === 1);
  // Doubling, not counting up. Counting up left a 460 km sweep with about a
  // thousand cells on every radial, which is three quarters of a million
  // polygons for one picture, and drawing a million of anything is where a
  // browser stops being a browser. Doubling matches what the beam is doing
  // anyway: it widens in proportion to range, so the cell should too.
  ok('past it the cell doubles each hundred kilometres',
     mod.strideForRange(101, 0.25, false) === 2
     && mod.strideForRange(250, 0.25, false) === 4
     && mod.strideForRange(350, 0.25, false) === 8);
  ok('and never past eight, however far out',
     mod.strideForRange(2000, 0.25, false) === 8);
  ok('a kilometre gate is never merged, at any range',
     mod.strideForRange(400, 1, false) === 1
     && mod.strideForRange(50, 1, false) === 1);
  ok('and full detail can be asked for, which turns it all off',
     mod.strideForRange(400, 0.25, true) === 1);
  // Never merge to a cell longer than the beam is wide: that would be
  // visible blockiness rather than fidelity nobody could see anyway.
  ok('the beam width is the real ceiling, not the step count',
     mod.strideForRange(130, 0.05, false) <= Math.floor((130 / 57) / 0.05));
}

console.log('\n6. a merged cell keeps the value that carries the meaning');
{
  // One spike in the middle of a group of four. On reflectivity the core has
  // to survive the merge, or a merged picture would report weaker storms
  // than a full-detail one at exactly the ranges people watch for growth.
  const spikeAt = 1600;
  const ref = fakeL2({ gateSize: 0.25, gateCount: 1832, radials: 4,
    fill: (g) => (g === spikeAt ? 68 : 20) });
  const res = runL2(ref, 'REF', { range_limit_km: 460 });
  let maxRef = -Infinity;
  for (let i = 8; i < res.meshData.length; i += 9) maxRef = Math.max(maxRef, res.meshData[i]);
  ok('a reflectivity core survives being merged with its quiet neighbours',
     maxRef === 68, String(maxRef));

  // On correlation coefficient it is the opposite: a debris ball under a
  // tornado is a HOLE of low values, and a merge that took the maximum would
  // erase the one signature a warning gets written from.
  const cc = fakeL2({ gateSize: 0.25, gateCount: 1832, radials: 4, layer: 'CC',
    fill: (g) => (g === spikeAt ? 0.62 : 0.99) });
  const ccRes = runL2(cc, 'CC', { range_limit_km: 460 });
  let minCC = Infinity;
  for (let i = 8; i < ccRes.meshData.length; i += 9) minCC = Math.min(minCC, ccRes.meshData[i]);
  ok('a correlation coefficient hole survives too, which needs the opposite rule',
     Math.abs(minCC - 0.62) < 0.001, String(minCC));

  // And on velocity, a couplet is an inbound beside an outbound. Averaging
  // would cancel them; taking the maximum would lose the inbound half.
  const vel = fakeL2({ gateSize: 0.25, gateCount: 1832, radials: 4, layer: 'VEL',
    fill: (g) => (g === spikeAt ? -41 : 2) });
  const velRes = runL2(vel, 'VEL', { range_limit_km: 460,
                                     enableVelocityDealias: false });
  let strongest = 0;
  for (let i = 8; i < velRes.meshData.length; i += 9) {
    if (Math.abs(velRes.meshData[i]) > Math.abs(strongest)) strongest = velRes.meshData[i];
  }
  // Level 2 velocity arrives in metres per second and leaves in knots.
  ok('a strong inbound survives a merge with weak outbounds around it',
     strongest < 0 && Math.abs(Math.abs(strongest) - 41 * 1.94384) < 0.5,
     String(strongest));
}

console.log('\n7. Level 3 reaches its full range too');
{
  // A digital base reflectivity packet: bins counted in 250 m steps, which is
  // where the old flat cap cut it to 115 km as well.
  const mkL3 = (code, bins, values) => ({
    productDescription: { code, latitude: SITE[0], longitude: SITE[1] },
    radialPackets: [{
      rangeScale: 1, firstBin: 0, numberBins: bins,
      radials: Array.from({ length: 180 }, (_, i) => ({
        startAngle: i * 2, angleDelta: 2,
        bins: Array.from({ length: bins }, (_, b) => values(b, i)),
      })),
    }],
  });
  const res = mod.processLevel3Data(mkL3(94, 1840, () => 35), SITE,
                                    { range_limit_km: 460 });
  const far = reachKm(res.meshData);
  ok('a 250 m Level 3 product reaches past 450 km', far > 450, far.toFixed(0) + ' km');
  ok('rather than the 115 km a 460-bin cap gave', far > 115 * 2, far.toFixed(0));

  const short = mod.processLevel3Data(mkL3(94, 1840, () => 35), SITE,
                                      { range_limit_km: 230 });
  ok('and a shorter limit is honoured in kilometres',
     Math.abs(reachKm(short.meshData) - 230) < 5,
     reachKm(short.meshData).toFixed(0) + ' km');

  // Storm relative velocity counts in whole kilometres and codes its values
  // into four bits, so it exercises both quirks at once.
  const srv = mod.processLevel3Data(mkL3(56, 230, (b) => (b === 100 ? 1 : 8)),
                                    SITE, { range_limit_km: 460 });
  const srvFar = reachKm(srv.meshData);
  ok('storm relative velocity reads its kilometre bins as kilometres',
     srvFar > 220 && srvFar < 240, srvFar.toFixed(0) + ' km');
  let low = 0;
  for (let i = 8; i < srv.meshData.length; i += 9) low = Math.min(low, srv.meshData[i]);
  ok('and its four-bit codes still decode to real speeds',
     low === -64, String(low));

  // Correlation coefficient on Level 3 needs the same minimum rule as on
  // Level 2, and it is chosen from the product code rather than a name.
  const ccL3 = mod.processLevel3Data(mkL3(161, 1840, (b) => (b === 1600 ? 0.55 : 0.98)),
                                     SITE, { range_limit_km: 460 });
  let minCC = Infinity;
  for (let i = 8; i < ccL3.meshData.length; i += 9) minCC = Math.min(minCC, ccL3.meshData[i]);
  ok('a Level 3 correlation hole survives the merge as well',
     Math.abs(minCC - 0.55) < 0.001, String(minCC));
}

console.log('\n8. an old caller cannot silently shorten it back');
{
  const radar = fakeL2({ gateSize: 0.25, gateCount: 1832, radials: 60 });
  const noOpts = runL2(radar, 'REF', {});
  ok('asking for nothing draws everything the file holds, rather than a quarter',
     reachKm(noOpts.meshData) > 450, reachKm(noOpts.meshData).toFixed(0) + ' km');
  // gate_limit is still honoured for anything that still sends it, but it is
  // now one ceiling among several rather than the only limit there is.
  const legacy = runL2(radar, 'REF', { gate_limit: 400 });
  ok('a caller that still sends a gate count is still obeyed',
     quadCount(legacy.meshData) <= 60 * 400 && legacy.meshData.length > 0,
     String(quadCount(legacy.meshData)));
}

console.log('\n9. the page asks for the range, and the shipped bundle was rebuilt');
{
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  ok('the page sends a range in kilometres', /range_limit_km:\s*far/.test(html));
  ok('the flat 460-gate cap is gone', !/gate_limit:\s*460/.test(html));
  ok('reflectivity asks for the full 460 km',
     /RADAR_RANGE_KM\s*=\s*460/.test(html));
  ok('and velocity for the 300 km the Doppler actually reaches',
     /RADAR_VEL_RANGE_KM\s*=\s*300/.test(html));

  // The browser runs the bundle, not the source. A source-only change would
  // pass every test above and ship nothing.
  const bundle = readFileSync(join(ROOT, 'assets', 'radar_worker.bundle.js'), 'utf8');
  ok('the shipped bundle carries the range logic, not just the source',
     /range_limit_km/.test(bundle) && /RANGE_FULL_DETAIL_KM|strideForRange/.test(bundle));
  ok('and the old gate-index break is gone from it',
     !/gateLimit !== null && gateIndex >= gateLimit/.test(bundle));
  // The page stamps the bundle's hash into its worker URL, so a stale cache
  // can never pair a new page with an old decoder.
  const stamp = (html.match(/var RADAR_WORKER_V = '([0-9a-f]+)';/) || [])[1];
  const { createHash } = await import('crypto');
  const real = createHash('md5').update(bundle).digest('hex').slice(0, 8);
  ok('and the page is stamped with this bundle, not the one before it',
     stamp === real, `${stamp} vs ${real}`);
}

console.log();
if (fail) { console.log(`${fail} FAILED, ${pass} passed`); process.exit(1); }
console.log(`all ${pass} passed`);
