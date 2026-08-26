#!/usr/bin/env node
/*
 * The panel split, the past-storm filter, the tag stems, and the two GWCFC
 * overlays, driven through the real page.
 *
 *     node tools/test-panel-split.mjs
 *
 * Five claims, each of which a person asked for by name. AI Cyclones is a
 * panel of its own with its own sub-bubble, so opening it does not mean
 * scrolling past the spaghetti. The spaghetti shows only storms that exist
 * NOW unless the Past storms chip says otherwise, because a-decks persist
 * all season and June's dead storms would otherwise haunt August. Every
 * name tag is pinned to its line by a stem with a knob on the endpoint,
 * so a name in a forty-line bundle is a fact rather than a guess. And two
 * overlay pills read the document the Forecasting Portal publishes:
 * GWCFC Outlook draws the areas and storms, GWCFC Alerts draws the desk's
 * warnings, both in the portal's own colours.
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
const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

// ── fixtures ────────────────────────────────────────────────────────────────
const P = (tau, lat, lon, vmax, mslp) => ({ tau, lat, lon, vmax, mslp });
const mkStorm = (id, name, lat, lon) => ({
  id, atcf: id.toUpperCase().replace(/(\d{4})$/, '$1'), name,
  basin: 'al', cy: 9, year: 2026, cycle: '2026082600', tier: 'full',
  generated: '2026-08-26T01:00:00Z',
  aids: { OFCL: [P(0, lat, lon, 65, null), P(12, lat + 1, lon - 2, 70, null)],
          AVNO: [P(0, lat, lon, 65, 985), P(12, lat + 1.1, lon - 2.1, 70, 980)] },
  aid_meta: {
    OFCL: { kind: 'official', label: 'NHC official', n_points: 2,
            has_track: true, has_intensity: true, tau_max: 12 },
    AVNO: { kind: 'dynamical', label: 'GFS', n_points: 2,
            has_track: true, has_intensity: true, tau_max: 12 } },
  official: 'OFCL',
  best_track: [{ dtg: '2026082600', lat, lon, vmax: 65, mslp: 985 }],
  consensus_membership: [], withheld_note: 'x', qc: {},
});
const LIVE = { ...mkStorm('al092026', 'GABRIELLE', 21.8, -65.1), active: true };
const DEAD = { ...mkStorm('al042026', 'DEXTER', 35.0, -50.0), active: false };
const INDEX = {
  updated: '2026-08-26T01:05:00Z', source: 'ATCF a-decks',
  storms: [
    { id: 'al092026', atcf: 'AL092026', name: 'GABRIELLE', basin: 'al',
      path: 'al092026.json', cycle: '2026082600', tier: 'full', active: true,
      lat: 21.8, lon: -65.1, vmax: 65, mslp: 985, n_aids: 2, n_tracks: 2 },
    { id: 'al042026', atcf: 'AL042026', name: 'DEXTER', basin: 'al',
      path: 'al042026.json', cycle: '2026081200', tier: 'full', active: false,
      lat: 35.0, lon: -50.0, vmax: 40, mslp: 1000, n_aids: 2, n_tracks: 2 },
  ],
};

// The Firestore document the portal publishes, in REST typed encoding.
const fsv = v => {
  if (v === null) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(fsv) } };
  const fields = {};
  Object.entries(v).forEach(([k, x]) => { fields[k] = fsv(x); });
  return { mapValue: { fields } };
};
const NOW = Date.now();
const OUTLOOK = {
  issued: '2026-08-26T02:00:00Z', forecaster: 'Ralph', uid: 'x',
  view: { lat: 25, lon: -70, zoom: 5 },
  storms: [{ id: 's1', cat: 3, lat: 22.0, lon: -66.0, name: 'GABRIELLE' }],
  areas: [
    { id: 'a1', type: 'chance', level: 'high', round: false,
      poly: [[20, -60], [24, -60], [24, -55], [20, -55]] },
    { id: 'a2', type: 'alert', level: 'warning', round: true,
      poly: [[26, -70], [29, -70], [29, -66], [26, -66]] },
  ],
  cones: [],
  alerts: [
    { uid: 'w1', code: 'TOR', areaDesc: 'Test County, FL',
      geometry: { type: 'Polygon',
        coordinates: [[[-82, 28], [-81, 28], [-81, 29], [-82, 29], [-82, 28]]] },
      issued: NOW - 5 * 60000, expires: NOW + 25 * 60000, status: 'active' },
    { uid: 'w2', code: 'SVR', areaDesc: 'Old County, GA',
      geometry: { type: 'Polygon',
        coordinates: [[[-84, 32], [-83, 32], [-83, 33], [-84, 33], [-84, 32]]] },
      issued: NOW - 90 * 60000, expires: NOW - 30 * 60000, status: 'active' },
    { uid: 'w3', code: 'FFW', areaDesc: 'Cancelled County',
      geometry: { type: 'Polygon',
        coordinates: [[[-86, 30], [-85, 30], [-85, 31], [-86, 31], [-86, 30]]] },
      issued: NOW - 5 * 60000, expires: NOW + 60 * 60000, status: 'cancelled' },
  ],
};
let fsDoc = { name: 'projects/x/databases/(default)/documents/outlooks/latest',
              fields: fsv(OUTLOOK).mapValue.fields };
let fsMissing = false;

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const json = (route, obj) => route.fulfill({ contentType: 'application/json',
  body: JSON.stringify(obj), headers: { 'Access-Control-Allow-Origin': '*' } });

await page.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript',
      body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css',
      body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  if (url.includes('/spaghetti/latest.json')) return json(route, INDEX);
  if (url.includes('/spaghetti/al092026.json')) return json(route, LIVE);
  if (url.includes('/spaghetti/al042026.json')) return json(route, DEAD);
  if (url.includes('firestore.googleapis.com')
      && url.includes('outlooks/latest')) {
    if (fsMissing) return route.fulfill({ status: 404, body: '{}' });
    return json(route, fsDoc);
  }
  return route.abort();
});

await page.goto('file://' + join(ROOT, 'index.html'),
                { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4200);
await page.evaluate(() => { if (typeof closeTutorial === 'function') closeTutorial(); });
await page.evaluate(() => { _hdBase = 'https://example.invalid/wx'; });

console.log('\n1. AI Cyclones is a panel of its own');
{
  const s = await page.evaluate(() => ({
    panel: !!document.getElementById('ai-cyclones-panel'),
    outside: !document.querySelector('#spaghetti-models-panel #cyc-lab-btn'),
    inside: !!document.querySelector('#ai-cyclones-panel #cyc-lab-btn')
         && !!document.querySelector('#ai-cyclones-panel #cyc-ens-centres-btn'),
    credits: !!document.querySelector('#ai-cyclones-panel #cyc-credits'),
    drag: !!document.getElementById('ai-cyclones-drag'),
    bubble: MODELS_SUB_BUBBLES.some(b => b.id === 'ai-cyclones'),
    reg: !!_MODELS_PANELS['ai-cyclones'],
  }));
  ok('the panel exists, draggable, with the cyclones card inside',
     s.panel && s.inside && s.drag);
  ok('and the spaghetti panel no longer carries those controls', s.outside);
  ok('the credit block moved with it', s.credits);
  ok('it has its own Models sub-bubble', s.bubble && s.reg);
  const flow = await page.evaluate(() => {
    openAiCyclonesPanel();
    const opened = _aiCyclonesPanelIsOpen();
    const parent = _spaghettiModelsPanelIsOpen();
    closeAiCyclonesPanel();
    return { opened, parent, closed: !_aiCyclonesPanelIsOpen() };
  });
  ok('its open and close work without touching the spaghetti panel',
     flow.opened && flow.closed && !flow.parent);
}

console.log('\n2. only current storms draw, until the chip says otherwise');
{
  await page.evaluate(() => _spagToggle());
  await page.waitForTimeout(500);
  let s = await page.evaluate(() => ({
    tags: [...document.querySelectorAll('.spag-tag')].map(e => e.textContent),
    status: document.getElementById('spag-status').textContent,
    chip: !!document.querySelector('#spag-groups [data-group="past"]'),
  }));
  ok('there is a Past storms chip, off by default', s.chip
     && await page.evaluate(() => _spagGroupsOn.past === false));
  ok('the live storm draws', /GABRIELLE/.test(s.status), s.status);
  ok('the dead one does not', !/DEXTER/.test(s.status), s.status);
  await page.evaluate(() => _spagGroupToggle('past'));
  await page.waitForTimeout(500);
  s = await page.evaluate(() => ({
    status: document.getElementById('spag-status').textContent }));
  ok('turning the chip on brings the past storm back',
     /DEXTER/.test(s.status) && /GABRIELLE/.test(s.status), s.status);
  await page.evaluate(() => _spagGroupToggle('past'));
  await page.waitForTimeout(400);
  ok('and off hides it again', !/DEXTER/.test(await page.evaluate(() =>
     document.getElementById('spag-status').textContent)));
  ok('a dead storm cannot lend its name to an ensemble track',
     await page.evaluate(() => _spagNearestStorm(35.0, -50.0) === null));
  ok('while a live one still can',
     await page.evaluate(() => (_spagNearestStorm(21.9, -65.0) || {}).name)
     === 'GABRIELLE');
}

console.log('\n3. every name tag is pinned to its line by a stem');
{
  const s = await page.evaluate(() => {
    const wraps = [...document.querySelectorAll('.tag-stemwrap')];
    return {
      n: wraps.length,
      tags: document.querySelectorAll('.spag-tag').length,
      allStemmed: wraps.every(w => w.querySelector('.tag-stem')),
      knob: wraps.length ? getComputedStyle(
        wraps[0].querySelector('.tag-stem'), '::before').borderRadius : '',
      angled: wraps.length ? getComputedStyle(
        wraps[0].querySelector('.tag-stem')).transform : '',
    };
  });
  ok('every tag sits in a stem wrap', s.n > 0 && s.n === s.tags,
     `${s.n} wraps, ${s.tags} tags`);
  ok('each wrap carries a stem', s.allStemmed);
  ok('the stem is angled, not a floating label',
     s.angled && s.angled !== 'none', s.angled);
  ok('with a round knob sitting on the line end', /50%/.test(s.knob), s.knob);
}

console.log('\n4. the GWCFC Outlook overlay draws what the portal published');
{
  const has = await page.evaluate(() => ({
    pill: !!document.getElementById('op-gwcfc-outlook'),
    routed: true,
  }));
  ok('the Overlays menu has the pill', has.pill);
  await page.evaluate(() => toggleOverlayPill('gwcfc-outlook'));
  await page.waitForTimeout(600);
  const s = await page.evaluate(() => {
    const polys = _gwcfcLayers.filter(l => l.setStyle && l.options);
    return {
      on: _gwcfcOn,
      layers: _gwcfcLayers.length,
      colors: polys.map(l => l.options.color),
      labels: [...document.querySelectorAll('.gwo-label')]
        .map(e => e.textContent),
      pillActive: document.getElementById('op-gwcfc-outlook')
        .classList.contains('active'),
      roundedPts: (polys.find(l => l.options.color === '#d81616')
        || { getLatLngs: () => [[]] }).getLatLngs()[0].length,
    };
  });
  ok('the overlay is on and the pill lights', s.on && s.pillActive);
  // 2 area polygons + 2 area labels + 1 storm dot + 1 storm label = 6.
  ok('areas, labels and the storm marker are all drawn', s.layers === 6,
     String(s.layers));
  ok('the high-chance area wears the portal\'s red',
     s.colors.includes('#ee1111'), s.colors.join(','));
  ok('the warning area wears the portal\'s warning red',
     s.colors.includes('#d81616'), s.colors.join(','));
  ok('the rounded area really is rounded: Chaikin turns 4 corners into 32',
     s.roundedPts === 32, String(s.roundedPts));
  ok('the labels say what each area is',
     s.labels.includes('High') && s.labels.includes('Warning'),
     s.labels.join(','));
  ok('the storm marker is labelled by name',
     s.labels.some(l => /GABRIELLE/.test(l)), s.labels.join(','));
  const chips = await page.evaluate(() =>
    document.querySelectorAll('.gwo-chip').length);
  ok('every outlook label wears the GWCFC office chip: two areas and a '
     + 'storm makes three', chips === 3, String(chips));
  await page.evaluate(() => toggleOverlayPill('gwcfc-outlook'));
  await page.waitForTimeout(300);
  ok('toggling off removes every piece',
     await page.evaluate(() => _gwcfcLayers.length === 0 && !_gwcfcOn));
}

console.log('\n5. the GWCFC Alerts overlay draws the desk\'s live products');
{
  ok('the Overlays menu has the alerts pill',
     await page.evaluate(() => !!document.getElementById('op-gwcfc-alerts')));
  await page.evaluate(() => toggleOverlayPill('gwcfc-alerts'));
  await page.waitForTimeout(600);
  const s = await page.evaluate(() => {
    const polys = _gwaLayers.filter(l => l.setStyle);
    return {
      on: _gwaOn,
      nPolys: polys.length,
      colors: polys.map(l => l.options.color),
      dashed: polys.some(l => l.options.dashArray),
      popup: polys[0] && polys[0].getPopup()
        ? polys[0].getPopup().getContent() : '',
      chips: [...document.querySelectorAll('.gwo-chip')]
        .map(e => e.textContent),
      chipBg: document.querySelector('.gwo-chip')
        ? getComputedStyle(document.querySelector('.gwo-chip'))
            .backgroundColor : '',
    };
  });
  ok('the overlay is on', s.on);
  ok('exactly the one alert still in force draws: the expired SVR and the '
     + 'cancelled FFW stay off the map', s.nPolys === 1, String(s.nPolys));
  ok('the Tornado Warning wears tornado red', s.colors[0] === '#ff0000',
     s.colors.join(','));
  ok('tapping it says what, where and until when',
     /Tornado Warning/.test(s.popup) && /Test County/.test(s.popup)
     && /Until/.test(s.popup), s.popup.slice(0, 200));
  // The office tag, which must never be confusable with the practice
  // desk's simulation costume: the desk's products are dashed with amber
  // SIM chips; a published GWCFC product is solid with a teal GWCFC chip
  // and a banner that names the office.
  ok('the popup opens with the GWCFC office banner',
     /GWCFC FORECAST OFFICE PRODUCT/.test(s.popup), s.popup.slice(0, 120));
  ok('and never calls itself simulated',
     !/SIMULATED/i.test(s.popup));
  ok('the polygon is solid, not the desk\'s simulation dashes', !s.dashed);
  ok('a GWCFC chip rides the polygon on the map itself',
     s.chips.includes('GWCFC'), s.chips.join(','));
  ok('and the chip is the office teal, not the SIM amber',
     s.chipBg === 'rgb(77, 208, 225)', s.chipBg);
  await page.evaluate(() => toggleOverlayPill('gwcfc-alerts'));
  await page.waitForTimeout(200);
  ok('off means off',
     await page.evaluate(() => _gwaLayers.length === 0 && !_gwaOn));
}

console.log('\n6. an unpublished outlook says so instead of looking broken');
{
  fsMissing = true;
  await page.evaluate(() => { _gwcfcDocCache = { at: 0, doc: null }; });
  await page.evaluate(() => toggleOverlayPill('gwcfc-outlook'));
  await page.waitForTimeout(500);
  ok('nothing draws and nothing crashes',
     await page.evaluate(() => _gwcfcOn && _gwcfcLayers.length === 0));
  await page.evaluate(() => toggleOverlayPill('gwcfc-outlook'));
  fsMissing = false;
}

console.log('\n7. house rules');
{
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  ok('no em dash in the page', !html.includes(String.fromCharCode(0x2014)));
  ok('both overlays have plain-language descriptions',
     /'gwcfc-outlook':\s+"Our own outlook/.test(html)
     && /'gwcfc-alerts':\s+"Warnings, watches/.test(html));
  ok('the portal colour tables are mirrored, not reinvented',
     /extreme:.*#ff44ff/.test(html) && /'Tornado Warning': '#ff0000'/.test(html));
  ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

await browser.close();
console.log(`\n${fail ? '' : 'all '}${pass} passed`
  + (fail ? `, ${fail} FAILED` : ''));
process.exit(fail ? 1 : 0);
