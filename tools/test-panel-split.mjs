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
  cones: [{
    id: 'c1', speed: 12, curve: 0, dots: 3, offset: 0,
    style: { outline: '#101010', outlineOpacity: 0.9, fill: '#cc2200',
             fillOpacity: 0.25, line: '#ffe066',
             dotFill: '#ffe066', dotStroke: '#ffb347' },
    cats: { 2: 'cat3' },   // the portal's own vocabulary: cat1..cat5, td, s
    start: [22.0, -66.0], end: [27.0, -74.0],
    ring: [[21, -65], [23, -67], [25.5, -71], [28, -75], [26, -76],
           [23.5, -72], [21.5, -67.5]],
    center: [[22, -66], [23.2, -68], [24.4, -70], [25.6, -72], [26.8, -74]],
  }],
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
let fsForbidden = false;

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
    if (fsForbidden) return route.fulfill({ status: 403,
      headers: { 'access-control-allow-origin': '*' },
      body: '{"error":{"code":403,"status":"PERMISSION_DENIED"}}' });
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
  // 2 area polygons + 2 area labels + 1 storm dot + 1 storm label, plus the
  // cone's ring + centre line + 2 dots + 1 category icon + 1 tag, plus the
  // in-force alert's polygon + chip (the alerts overlay is off) = 14.
  ok('areas, labels, the storm marker, the cone and the desk alert are all '
     + 'drawn', s.layers === 14, String(s.layers));
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
  // The forecast cone, drawn exactly as composed: the ring in the
  // forecaster's own colours, the dashed centre line, three time dots plus
  // one category icon where point 2 was marked C3.
  const cone = await page.evaluate(() => {
    const ring = _gwcfcLayers.find(l => l.setStyle
      && l.options.fillColor === '#cc2200');
    const line = _gwcfcLayers.find(l => l.options
      && l.options.dashArray === '6 5');
    const dots = _gwcfcLayers.filter(l => l.setRadius
      && l.options.fillColor === '#ffe066');
    const icons = _gwcfcLayers.filter(l => l.getIcon && !l.setRadius
      && l.getElement && l.getElement()
      && !l.getElement().querySelector('.gwo-label')).length;
    return {
      ring: !!ring, outline: ring && ring.options.color,
      fillOp: ring && ring.options.fillOpacity,
      line: !!line, lineCol: line && line.options.color,
      dots: dots.length, icons,
      tag: [...document.querySelectorAll('.gwo-label')]
        .some(e => /Forecast Cone/.test(e.textContent)),
    };
  });
  ok('the published cone ring draws in the forecaster\'s own colours',
     cone.ring && cone.outline === '#101010' && cone.fillOp === 0.25,
     JSON.stringify(cone));
  ok('with the dashed centre line down its middle',
     cone.line && cone.lineCol === '#ffe066', JSON.stringify(cone));
  // dots: 3 spread dots minus the one displaced by the category = 2 circles,
  // and the category icon marker stands at point 2.
  ok('the time dots and the marked category both stand on the line',
     cone.dots === 2 && cone.icons >= 1,
     `dots ${cone.dots}, icons ${cone.icons}`);
  ok('and the cone wears the office tag', cone.tag);
  // With the alerts overlay OFF, the outlook carries the desk's in-force
  // alert itself: one tornado-red polygon lives in the outlook layers.
  const tor = await page.evaluate(() =>
    _gwcfcLayers.filter(l => l.setStyle
      && l.options.color === '#ff0000').length);
  ok('the outlook also draws the in-force desk alert while the alerts '
     + 'overlay is off', tor === 1, String(tor));
  const chips = await page.evaluate(() =>
    document.querySelectorAll('.gwo-chip').length);
  ok('every published thing wears the GWCFC office chip: two areas, a '
     + 'storm, a cone and an alert makes five', chips === 5, String(chips));
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
  // The hand-over: with BOTH overlays on, the alerts layer owns the warning
  // and the outlook does not paint a second copy underneath it.
  await page.evaluate(() => toggleOverlayPill('gwcfc-outlook'));
  await page.waitForTimeout(600);
  const both = await page.evaluate(() => ({
    inOutlook: _gwcfcLayers.filter(l => l.setStyle
      && l.options.color === '#ff0000').length,
    inAlerts: _gwaLayers.filter(l => l.setStyle
      && l.options.color === '#ff0000').length,
  }));
  ok('with both overlays on, the alerts layer owns the warning and the '
     + 'outlook does not double it',
     both.inAlerts === 1 && both.inOutlook === 0, JSON.stringify(both));
  // And the hand-back: turning the alerts overlay OFF while the outlook is
  // up must give the warning back to the outlook, not drop it off the map.
  await page.evaluate(() => toggleOverlayPill('gwcfc-alerts'));
  await page.waitForTimeout(600);
  const back = await page.evaluate(() => ({
    inOutlook: _gwcfcLayers.filter(l => l.setStyle
      && l.options.color === '#ff0000').length,
    inAlerts: _gwaLayers.length,
  }));
  ok('turning the alerts overlay off hands the warning back to the outlook',
     back.inOutlook === 1 && back.inAlerts === 0, JSON.stringify(back));
  await page.evaluate(() => toggleOverlayPill('gwcfc-alerts'));
  await page.waitForTimeout(600);
  await page.evaluate(() => toggleOverlayPill('gwcfc-outlook'));
  await page.waitForTimeout(300);
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
  ok('a plain 404 is read as not published, not as blocked',
     await page.evaluate(() => _gwcfcBlocked === false));
  await page.evaluate(() => toggleOverlayPill('gwcfc-outlook'));
  fsMissing = false;

  // A 403 is a different statement entirely: the security rules refuse the
  // read. This is the state the whole feature shipped into, because the
  // deployed rules had no outlooks block at all, and it must be NAMED
  // rather than shrugged off as "nothing published".
  fsForbidden = true;
  await page.evaluate(() => { _gwcfcDocCache = { at: 0, doc: null }; });
  await page.evaluate(() => toggleOverlayPill('gwcfc-outlook'));
  await page.waitForTimeout(500);
  ok('a 403 is recognised as the rules blocking the read',
     await page.evaluate(() => _gwcfcBlocked === true));
  await page.evaluate(() => toggleOverlayPill('gwcfc-outlook'));
  fsForbidden = false;
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
  // The rules file that has to be pasted in the Firebase console must carry
  // everything both apps depend on: outlooks was the block whose absence
  // silently refused every publish, and piEndpoint is what the Pi's address
  // discovery needs, so a paste of this file must never break either.
  const rules = readFileSync(join(ROOT, 'firebase', 'firestore.rules'), 'utf8');
  ok('the rules file has the outlooks block', /match \/outlooks\//.test(rules));
  ok('anyone may read the published outlook',
     /match \/outlooks\/[\s\S]{0,200}allow read: if true/.test(rules));
  ok('but writing it takes a forecaster account',
     /isForecasterAccount/.test(rules)
     && /allow create, update: if isForecasterAccount/.test(rules));
  ok('the piEndpoint block the Pi depends on is in the same file',
     /match \/piEndpoint\//.test(rules));
  ok('every collection the apps write is covered by a rule',
     ['users', 'chat', 'guests', 'cloudcam', 'discordLinks', 'asturioSync',
      'outlooks', 'piEndpoint', 'chatBridge', 'modelCache', 'sharedAlerts',
      'omBudget']
       .every(c => rules.includes('match /' + c + '/')));
  const pasteFile = readFileSync(join(ROOT, 'firebase', 'FIRESTORE_RULES.txt'),
                                 'utf8');
  ok('the paste file carries the complete rules text between its markers',
     pasteFile.includes(rules.trimEnd()));
  ok('the paste file keeps its how-to-publish instructions',
     /HOW TO PUBLISH THEM/.test(pasteFile)
       && /COPY FROM HERE/.test(pasteFile) && /TO HERE/.test(pasteFile));
  ok('the portal names the real causes when the database refuses a publish',
     /rules[\s\S]{0,120}have not been updated/.test(
       readFileSync(join(ROOT, 'forecasting-portal.html'), 'utf8')));
  // The sign-in system's hard-won lessons, pinned so they cannot quietly
  // regress: the Firebase scripts must load one after another with retries
  // (parallel loading ran them in download order and a wrong order left the
  // page half-started), readiness must mean auth AND the database are up (a
  // latched app object used to report ready forever and the sign-in button
  // crashed on undefined), and a browser that has held a real account must
  // never be signed in anonymously (that replaces the saved session, which
  // the user experienced as being randomly logged out).
  ok('the Firebase scripts load in order with retries',
     /s\.onload=function\(\)\{i\+\+;loadNext\(0\);\}/.test(html)
       && /s\.onerror=function\(\)/.test(html)
       && /loadNext\(tries\+1\)/.test(html));
  ok('firebase readiness means auth and the database are both up',
     /if \(_fbAuth && _fbDb\) return true;/.test(html));
  ok('a browser that held a real account is never signed in anonymously',
     /gwcfc_had_account/.test(html)
       && /if \(_fbAuth && !hadAccount\)/.test(html));
  ok('the sign-in button says so when the system has not loaded',
     (html.match(/has not finished loading/g) || []).length >= 2);
  ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

await browser.close();
console.log(`\n${fail ? '' : 'all '}${pass} passed`
  + (fail ? `, ${fail} FAILED` : ''));
process.exit(fail ? 1 : 0);
