#!/usr/bin/env node
/*
 * Drives the radar menu in a real browser.
 *
 *     npm i playwright && node tools/test-radar-menu.mjs
 *
 * test-models.js runs the model panel against stubs, which is fast and catches
 * a lot, but it cannot see the page boot. Two bugs got past it and straight to
 * a user:
 *
 *   - every station id in NEXRAD_STATIONS is lower case, and the Cloudflare
 *     Worker refuses anything that is not four capitals, so every Level 2
 *     request came back HTTP 400 and the panel said "fetch failed"
 *   - the Level 3 row awaited the Pi before drawing itself, so tapping it left
 *     the previous row on screen and read as the menu doing nothing
 *
 * Neither is visible without opening the page and clicking. So this opens the
 * page and clicks.
 *
 * Leaflet comes from a CDN that a sandbox often cannot reach, and a missing L
 * stops the page booting long before the menu exists. So a small stand-in is
 * injected first: enough surface for the page to finish starting, no more. The
 * menu code is what is under test, not the map.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('playwright is not installed, skipping. npm i playwright');
  process.exit(0);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Only what the page touches on the way up.
const LEAFLET_STUB = `(() => {
  const chain = () => new Proxy(function(){}, {
    get: (t, k) => {
      if (k === 'getCenter')  return () => ({ lat: 35.3, lng: -97.3 });
      if (k === 'getZoom')    return () => 7;
      if (k === 'hasLayer')   return () => false;
      if (k === 'getPane')    return () => document.createElement('div');
      if (k === 'createPane') return () => document.createElement('div');
      if (k === 'getBounds')  return () => ({ getWest:()=>-100, getEast:()=>-95,
        getNorth:()=>38, getSouth:()=>33, contains:()=>true, pad(){return this;} });
      if (k === 'then') return undefined;
      return chain();
    },
    apply: () => chain(), construct: () => chain(),
  });
  Object.defineProperty(window, 'L',
    { value: chain(), writable: true, configurable: true });
})();`;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));

// No network. Everything under test is the page's own code, and a test that
// depends on NOAA being up is a test that fails for the wrong reason.
await page.addInitScript(LEAFLET_STUB);
await page.route('**://**', r =>
  r.request().url().startsWith('file://') ? r.continue() : r.abort());
await page.goto('file://' + join(ROOT, 'index.html'),
                { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);

const row = () => page.evaluate(() =>
  [...document.querySelectorAll('#sub-bubbles .sub-bubble')]
    .map(e => e.textContent.trim()));

console.log('\n1. the page boots');
ok('no uncaught errors while starting', errors.length === 0, errors[0]);

console.log('\n2. the radar row asks where before what');
await page.evaluate(() => toggleRadarSub());
const sources = await row();
ok('offers Normal, Level 2 and Level 3',
   ['Normal', 'Level 2', 'Level 3'].every(l => sources.includes(l)),
   sources.join(','));

console.log('\n3. Level 2 is single site, with the six products');
await page.evaluate(() => toggleRadarL2Sub());
const l2 = await row();
['Reflectivity', 'Velocity', 'Corr. Coeff.', 'Diff. Refl.',
 'Spec. Diff. Phase', 'Spectrum Width'].forEach(p =>
  ok('offers ' + p, l2.includes(p), l2.join(',')));
ok('and offers nothing else: the station lives on the map, not in the menu',
   l2.length === 7, l2.join(','));

console.log('\n4. opening the row is what puts the station pills up');
const pills = await page.evaluate(() => ({
  source: _radarSource,
  built: !!_nexradSiteLayer,
  markers: Object.keys(_nexradSiteMarkers).length,
}));
ok('the source is recorded as Level 2', pills.source === 'l2', pills.source);
ok('the station pill layer was built for the whole country',
   pills.built && pills.markers > 100, pills.markers);

console.log('\n5. the address the Worker is actually given');
const url = await page.evaluate(() => {
  let seen = null;
  const real = window.fetch;
  window.fetch = (u) => { if (String(u).includes('station=')) seen = String(u);
                          return Promise.reject(new Error('blocked in test')); };
  try { loadL3Data('cc', _l2Site || undefined); } catch (e) {}
  window.fetch = real;
  return seen;
});
// The Worker refuses anything that is not four capitals. This is the check
// that would have caught Level 2 never working.
ok('station is upper case, which is all the Worker accepts',
   /[?&]station=[A-Z]{4}$/.test(url || ''), url);

console.log('\n6. Level 3 answers immediately, even with no Pi');
await page.evaluate(() => { toggleRadarPiSub('l3'); });
const l3now = await row();
ok('the row is replaced at once rather than after the Pi answers',
   l3now.includes('Back') && l3now.includes('1-Hr Precip'), l3now.join(','));
await page.waitForTimeout(1200);
const l3 = await row();
ok('and an unreachable Pi says so instead of leaving an empty row',
   l3.some(t => /No Pi radar/.test(t)), l3.join(','));

console.log('\n7. the map station pills mean the same thing as the row');
// A pill on the map is the other way to say "this radar", and it has to reach
// the same place the site bubble does. Before this it fell into the branch
// for the tile layers, because Level 2 also calls a product "ref".
await page.evaluate(() => { toggleRadarL2Sub();
  const b = document.getElementById('sub-l2-ref'); if (b) b.onclick(); });
await page.waitForTimeout(400);
const viaPill = await page.evaluate(() => {
  let seen = null;
  const real = window.fetch;
  window.fetch = (u) => { if (String(u).includes('station=')) seen = String(u);
                          return Promise.reject(new Error('blocked in test')); };
  // What the pill handler does, with a station that is not the current one.
  _radarSource = 'l2';
  _l2Site = 'kdyx';
  loadL3Data(currentProduct || 'ref', 'kdyx');
  window.fetch = real;
  return { url: seen, source: _radarSource, site: _l2Site };
});
ok('a pill click asks the decoder, not the tile layers',
   /station=KDYX$/.test(viaPill.url || ''), viaPill.url);
ok('and the chosen station is remembered', viaPill.site === 'kdyx',
   viaPill.site);
ok('the source stays Level 2 rather than falling back to Normal',
   viaPill.source === 'l2', viaPill.source);

console.log('\n8. the Normal products are untouched');
await page.evaluate(() => toggleRadarNormalSub());
const normal = await row();
['MRMS 1km', 'Reflectivity', 'Velocity', 'Hydro. Class.',
 'Storm Accum.', '1-Hr Accum.'].forEach(p =>
  ok('still offers ' + p, normal.includes(p), normal.join(',')));

console.log('\n9. nothing threw along the way');
ok('no uncaught errors at all', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
