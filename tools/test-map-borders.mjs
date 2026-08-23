#!/usr/bin/env node
/*
 * Map borders and labels: state, county and province lines, and city names.
 *
 *     node tools/test-map-borders.mjs
 *
 * These four switches shipped a long time ago and did nothing. Two reasons,
 * and this checks both are gone. The handlers hid DOM elements with classes
 * nothing ever created, so there was no layer to toggle; and the settings
 * function is wrapped further down the page by a copy that used to swallow
 * every key it did not recognise, so even the handler that existed could not
 * be reached.
 *
 * The data comes from jsDelivr in the real app. It is stubbed here, because
 * what is under test is the layer, the thinning and the wiring, not whether a
 * CDN is up.
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
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + String(extra).slice(0, 300) + '>' : '')); }
};

console.log('\n1. the source');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
ok('no em dash anywhere in the page', !html.includes('—'));
// The old implementation, gone rather than merely bypassed.
// The old code built the selector as 'border-' + borderType and hid whatever
// it found. Matching the bare words would also hit the comments that explain
// why it is gone, so this looks for the selector being used.
ok('nothing hides classes that were never created',
   !/'border-'\s*\+/.test(html)
   && !/querySelectorAll\('\.city-label/.test(html));
ok('the two cards share one tab, named Map',
   /data-merge="map" data-merge-label="Map"/.test(html));
ok('city names have a switch of their own to size',
   /lqm-set-citylabels/.test(html));

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'],
});
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));

// ── Stubbed sources ───────────────────────────────────────────────────────
// A square of state line across Florida, four "counties" spread far enough
// apart that viewport thinning has something to thin, and five cities whose
// populations span the whole zoom ladder.
const box = (w, s, e, n) => ({
  type: 'Feature', properties: {},
  geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
});
const county = (id, name, w, s, e, n) => {
  const f = box(w, s, e, n);
  f.id = id; f.properties = { STATE: '12', COUNTY: id.slice(2), NAME: name };
  return f;
};
const ADMIN1 = { type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { adm0_a3: 'USA', name: 'Florida line' },
    geometry: { type: 'LineString', coordinates: [[-82, 27], [-80, 27], [-80, 29]] } },
  { type: 'Feature', properties: { adm0_a3: 'USA', name: 'Texas line' },
    geometry: { type: 'LineString', coordinates: [[-100, 30], [-97, 30]] } },
  { type: 'Feature', properties: { adm0_a3: 'CAN', name: 'Ontario line' },
    geometry: { type: 'LineString', coordinates: [[-85, 49], [-80, 49]] } },
  { type: 'Feature', properties: { adm0_a3: 'MEX', name: 'Sonora line' },
    geometry: { type: 'LineString', coordinates: [[-112, 30], [-110, 30]] } },
]};
const COUNTIES = { type: 'FeatureCollection', features: [
  county('12009', 'Brevard', -81.0, 28.0, -80.5, 28.5),
  county('12095', 'Orange',  -81.6, 28.3, -81.1, 28.8),
  county('48201', 'Harris',  -95.8, 29.5, -95.0, 30.1),   // Texas, far from Florida
  county('06037', 'Los Angeles', -118.7, 33.7, -117.6, 34.8),
]};
const PLACES = { type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { name: 'New York',   pop_max: 19000000 }, geometry: { type: 'Point', coordinates: [-74.0, 40.7] } },
  { type: 'Feature', properties: { name: 'Orlando',    pop_max: 1600000 },  geometry: { type: 'Point', coordinates: [-81.4, 28.5] } },
  { type: 'Feature', properties: { name: 'Melbourne',  pop_max: 76000 },    geometry: { type: 'Point', coordinates: [-80.6, 28.1] } },
  { type: 'Feature', properties: { name: 'Cocoa',      pop_max: 17000 },    geometry: { type: 'Point', coordinates: [-80.74, 28.36] } },
  { type: 'Feature', properties: { name: 'Rockledge',  pop_max: 25000 },    geometry: { type: 'Point', coordinates: [-80.72, 28.34] } },
]};

let hits = { admin1: 0, counties: 0, places: 0 };
await page.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript',
      body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css',
      body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  const json = (body, which) => { hits[which]++; return route.fulfill(
    { contentType: 'application/json', body: JSON.stringify(body) }); };
  if (url.includes('admin_1_states_provinces_lines')) return json(ADMIN1, 'admin1');
  if (url.includes('geojson-counties-fips'))          return json(COUNTIES, 'counties');
  if (url.includes('populated_places'))               return json(PLACES, 'places');
  return route.abort();
});
await page.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);

await page.evaluate(() => {
  window.__paneKids = (name) => {
    const p = map.getPane(name);
    return p ? p.children.length : -1;
  };
  window.__settle = () => new Promise(r => setTimeout(r, 400));
});

console.log('\n2. the panes are in the right order');
{
  const r = await page.evaluate(() => {
    _mbPanes();
    const z = (n) => {
      const p = map.getPane(n);
      return p ? Number(getComputedStyle(p).zIndex) : null;
    };
    return {
      borders: z('bordersPane'), radar: z('radarPane'),
      alerts: z('alertsPane'), labels: z('mapLabelsPane'),
      bordersClicks: map.getPane('bordersPane').style.pointerEvents,
      labelClicks: map.getPane('mapLabelsPane').style.pointerEvents,
    };
  });
  ok('borders sit above the radar, so county lines are visible over echoes',
     r.borders > r.radar, r.borders + ' vs ' + r.radar);
  ok('and below the alert polygons, which outrank them',
     r.borders < r.alerts, r.borders + ' vs ' + r.alerts);
  ok('city names sit above everything, so nothing buries a name',
     r.labels > r.alerts, r.labels + ' vs ' + r.alerts);
  ok('neither pane can steal a click',
     r.bordersClicks === 'none' && r.labelClicks === 'none');
}

console.log('\n3. state and province lines');
{
  const r = await page.evaluate(async () => {
    map.setView([28.4, -80.8], 8);
    lqmToggleSetting('stateborders', true);
    await __settle(); await __settle();
    const onAfter = !!(_mbLayers.state && map.hasLayer(_mbLayers.state));
    const stateNames = _mbLayers.state
      ? _mbLayers.state.getLayers().map(l => l.feature.properties.name) : [];

    lqmToggleSetting('provinceborders', true);
    await __settle();
    const provNames = _mbLayers.province
      ? _mbLayers.province.getLayers().map(l => l.feature.properties.name) : [];

    lqmToggleSetting('stateborders', false);
    await __settle();
    const offAfter = !!(_mbLayers.state && map.hasLayer(_mbLayers.state));
    const stored = localStorage.getItem('lqm_stateborders');
    return { onAfter, stateNames, provNames, offAfter, stored };
  });
  ok('turning state borders on puts a layer on the map', r.onAfter === true);
  ok('and it holds the US lines, not every country in the file',
     r.stateNames.length === 2 && r.stateNames.every(n => /Florida|Texas/.test(n)),
     r.stateNames.join(', '));
  ok('province borders bring Canada, separately',
     r.provNames.length === 1 && /Ontario/.test(r.provNames[0]), r.provNames.join(', '));
  ok('turning it off takes it back off', r.offAfter === false);
  ok('the choice is stored in the form the loader reads back',
     r.stored === 'false', r.stored);
}

console.log('\n4. county lines, thinned to what is on screen');
{
  const r = await page.evaluate(async () => {
    map.setView([28.4, -80.8], 8);
    lqmToggleSetting('countyborders', true);
    await __settle(); await __settle();
    const inFlorida = _mbLayers.county
      ? _mbLayers.county.getLayers().map(l => l.feature.properties.NAME).sort() : [];

    // Same layer, a different part of the country.
    map.setView([29.8, -95.4], 8);
    await __settle(); await __settle();
    const inTexas = _mbLayers.county
      ? _mbLayers.county.getLayers().map(l => l.feature.properties.NAME).sort() : [];

    // Zoomed out, county lines are a grey smear that hides the weather.
    map.setView([37.5, -96], 4);
    await __settle(); await __settle();
    const zoomedOut = _mbLayers.county ? _mbLayers.county.getLayers().length : 0;

    map.setView([28.4, -80.8], 8);
    await __settle(); await __settle();
    const backAgain = _mbLayers.county ? _mbLayers.county.getLayers().length : 0;

    lqmToggleSetting('countyborders', false);
    await __settle();
    const afterOff = !!(_mbLayers.county && map.hasLayer(_mbLayers.county));
    return { inFlorida, inTexas, zoomedOut, backAgain, afterOff, loaded: (_mbCountyFeats || []).length };
  });
  ok('every county in the file was read once', r.loaded === 4, r.loaded);
  ok('over Florida only the Florida counties are drawn',
     r.inFlorida.join(',') === 'Brevard,Orange', r.inFlorida.join(','));
  ok('panning to Texas swaps them for the Texas one',
     r.inTexas.join(',') === 'Harris', r.inTexas.join(','));
  ok('zoomed out past the threshold nothing is drawn', r.zoomedOut === 0, r.zoomedOut);
  ok('zooming back in brings them back', r.backAgain === 2, r.backAgain);
  ok('turning it off clears the layer', r.afterOff === false);
}

console.log('\n5. city names');
{
  const r = await page.evaluate(async () => {
    map.setView([28.4, -80.8], 8);
    lqmToggleSetting('citylabels', true);
    await __settle(); await __settle();
    const near = __paneKids('mapLabelsPane');
    const names = Array.from(document.querySelectorAll('.mb-city')).map(e => e.textContent).sort();

    // Zoomed right out, only the biggest places should survive the thinning.
    map.setView([37.5, -96], 4);
    await __settle(); await __settle();
    const wideNames = Array.from(document.querySelectorAll('.mb-city')).map(e => e.textContent);
    const wideCutoff = _mbCityMinPop(4);
    const wideTooSmall = _mbCityFeats
      .filter(c => c.pop < wideCutoff)
      .filter(c => wideNames.includes(c.name))
      .map(c => c.name);

    map.setView([28.4, -80.8], 9);
    await __settle(); await __settle();
    // The slider drives one custom property rather than every label.
    lqmSetCityNameSize(17);
    const size = getComputedStyle(document.querySelector('.mb-city')).fontSize;
    const label = document.getElementById('lqm-citynamesize-val').textContent;

    lqmToggleSetting('citylabels', false);
    await __settle();
    const afterOff = __paneKids('mapLabelsPane');
    return { near, names, wideNames, wideTooSmall, size, label, afterOff };
  });
  ok('names appear over the area being looked at', r.near > 0, r.near);
  ok('and they are the places actually in view',
     r.names.length > 0 && r.names.every(n => /Orlando|Melbourne|Cocoa|Rockledge/.test(n)),
     r.names.join(', '));
  ok('zoomed right out the small places are dropped',
     r.wideNames.length > 0 && r.wideTooSmall.length === 0,
     'kept below the cutoff: ' + r.wideTooSmall.join(', '));
  ok('and the town-sized ones are gone entirely',
     !r.wideNames.some(n => /Melbourne|Cocoa|Rockledge/.test(n)),
     r.wideNames.join(', '));
  ok('the size slider actually changes the text', r.size === '17px', r.size);
  ok('and the readout beside it agrees', r.label === '17px', r.label);
  ok('turning it off clears every name', r.afterOff === 0, r.afterOff);
}

console.log('\n6. each source is fetched once, not once per toggle');
{
  const before = { ...hits };
  await page.evaluate(async () => {
    lqmToggleSetting('countyborders', true);  await __settle();
    lqmToggleSetting('countyborders', false); await __settle();
    lqmToggleSetting('countyborders', true);  await __settle();
    lqmToggleSetting('stateborders', true);   await __settle();
    lqmToggleSetting('stateborders', false);  await __settle();
    lqmToggleSetting('stateborders', true);   await __settle();
    lqmToggleSetting('countyborders', false); await __settle();
    lqmToggleSetting('stateborders', false);  await __settle();
  });
  ok('flipping counties three times refetched nothing',
     hits.counties === before.counties, `${before.counties} -> ${hits.counties}`);
  ok('nor did flipping states', hits.admin1 === before.admin1,
     `${before.admin1} -> ${hits.admin1}`);
  ok('each file was only ever pulled once',
     hits.admin1 === 1 && hits.counties === 1 && hits.places === 1,
     JSON.stringify(hits));
}

console.log('\n7. a source that will not load says so');
{
  const r = await page.evaluate(async () => {
    // Drop the cached copy and make the next fetch fail the way an outage
    // does, so the failure path is the one being measured.
    delete _mbCache[MB_SRC.places];
    _mbCityFeats = null;
    const realFetch = window.fetch;
    let said = '';
    const realToast = window._lqmToast;
    window._lqmToast = (m) => { said = m; };
    window.fetch = () => Promise.reject(new Error('network is down'));
    await _mbSet('cities', true);
    window.fetch = realFetch;
    window._lqmToast = realToast;

    // And it is a retry, not a permanent no: the failed attempt must not be
    // cached as the answer.
    const cachedFailure = !!_mbCache[MB_SRC.places];
    await _mbSet('cities', true);
    await __settle(); await __settle();
    const recovered = document.querySelectorAll('.mb-city').length;
    lqmToggleSetting('citylabels', false);
    return { said, cachedFailure, recovered };
  });
  ok('the failure is reported with its reason, not swallowed',
     /network is down/.test(r.said), r.said);
  ok('the failed attempt is not cached as the answer', r.cachedFailure === false);
  ok('so turning it on again is a real retry', r.recovered > 0, r.recovered);
}

console.log('\n8. the settings tab');
{
  const r = await page.evaluate(() => {
    lqmOpenSettings();
    _lqmSetBuildRail();
    const tabs = Array.from(document.querySelectorAll('#lqm-set-rail .lqm-set-tab'))
      .map(t => ({ id: t.dataset.tab, label: t.textContent.trim() }));
    lqmSettingsCat('map');
    const shown = Array.from(document.querySelectorAll('#lqm-set-content .lqm-settings-group'))
      .filter(g => !g.hidden)
      .map(g => g.querySelector('.lqm-settings-category').textContent.trim());
    if (typeof lqmCloseSettings === 'function') lqmCloseSettings();
    return { tabs, shown, names: tabs.map(t => t.label) };
  });
  ok('there is a tab called Map', r.names.includes('Map'), r.names.join(' | '));
  ok('Display no longer has a tab of its own', !r.names.includes('Display'),
     r.names.join(' | '));
  ok('nor does Map Borders and Labels',
     !r.names.some(n => /Borders/.test(n)), r.names.join(' | '));
  ok('and the Map tab shows both cards, each keeping its own name',
     r.shown.length === 2 && r.shown.includes('Display')
     && r.shown.some(n => /Borders/.test(n)), r.shown.join(' | '));
}

console.log('\n9. nothing threw');
ok('no uncaught page errors', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
