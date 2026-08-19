#!/usr/bin/env node
/*
 * NWR (NOAA Weather Radio) stations: turn the layer on, click a station,
 * see whether its popup actually opens - in a real browser with real
 * Leaflet, against mocked versions of the handful of external services
 * this feature depends on (transmitter coordinates, three separate
 * Icecast stream directories, and the CORS proxies some of those need).
 *
 *     node tools/test-nwr.mjs
 *
 * This exists because the feature had no coverage at all: a report that
 * "clicking a station does nothing" could mean the data never loaded, the
 * marker never got a popup bound, or something else on the map is eating
 * the click before Leaflet sees it, and nothing here would have said which.
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

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'],
});

// One station, KEC77, with a transmitter position and a single live GWES
// stream - the plain case every click has to work for before the tabbed
// multi-source case is worth testing at all.
const TX = JSON.stringify({ transmitters: {
  KEC77: { LAT: '38.9', LON: '-77.0', STATUS: 'NORMAL', FREQ: '162.400',
           PWR: '1000', WFO: 'LWX', SITENAME: 'Washington DC',
           STATE: 'DC', COUNTY: ['District of Columbia'], SAME: ['011001'] },
} });
const GWES = JSON.stringify({ icestats: { source: [
  { listenurl: 'http://relay.example/KEC77', listeners: 3, server_name: 'KEC77 - Washington DC' },
] } });
const EMPTY_ICE = JSON.stringify({ icestats: { source: [] } });

async function boot(mode) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // A returning visitor, not a first-time one: the auto-opening tutorial
  // must not be what is standing between a real user and their stations.
  await page.addInitScript(() => {
    localStorage.setItem('gwcfc_tutorial_seen', '1');
  });
  await page.route('**://**', route => {
    const url = route.request().url();
    if (url.startsWith('file://')) return route.continue();
    if (url.includes('leaflet') && url.endsWith('.js'))
      return route.fulfill({ contentType: 'application/javascript',
        body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
    if (url.includes('leaflet') && url.endsWith('.css'))
      return route.fulfill({ contentType: 'text/css',
        body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
    if (url.startsWith('https://firestore.googleapis.com/'))
      return route.fulfill({ status: 404, body: 'no pi' });
    if (mode === 'down')
      return route.abort();
    if (url.startsWith('https://transmitters.weatherradio.org'))
      return route.fulfill({ contentType: 'application/json', body: TX });
    if (url.startsWith('https://icestats.weatherradio.org'))
      return route.fulfill({ contentType: 'application/json', body: GWES });
    if (url.startsWith('https://wxradio.org/status-json.xsl'))
      return route.fulfill({ contentType: 'application/json', body: EMPTY_ICE });
    if (url.includes('weatherusa.net'))
      return route.fulfill({ status: 404, body: 'no wxusa' });
    // Every CORS-proxy fallback: never reached when the direct fetch above
    // already answered, so seeing one hit here would itself be a finding.
    if (/corsproxy\.io|allorigins\.win|freeboard\.io|codetabs\.com/.test(url))
      return route.fulfill({ status: 502, body: 'proxy should not be needed' });
    return route.abort();
  });
  await page.goto('file://' + join(ROOT, 'index.html'),
                  { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  return { page, errors };
}

console.log('\n1. turning the layer on plots the station');
{
  const { page, errors } = await boot('up');
  await page.evaluate(() => toggleOverlayPill('radio'));
  await page.waitForTimeout(2000);

  const st = await page.evaluate(() => ({
    on: activeLayers.radio,
    hasLayer: !!_nwrLayer && map.hasLayer(_nwrLayer),
    markerCount: _nwrLayer ? Object.keys(_nwrLayer._layers).length : 0,
  }));
  ok('the radio layer switched on', st.on === true, String(st.on));
  ok('the station layer is on the map', st.hasLayer === true, String(st.hasLayer));
  ok('exactly the one mocked station plotted', st.markerCount === 1, String(st.markerCount));

  console.log('\n2. clicking that station opens its popup');
  const before = await page.evaluate(() =>
    !!document.querySelector('.leaflet-popup'));
  ok('no popup is open yet', before === false, String(before));

  // The same path a finger takes: fire a real Leaflet click on the marker,
  // not a direct call to whatever opens the popup, so a click genuinely
  // failing to reach the marker (an overlapping pane, a pointer-events
  // rule, a swallowed event) would show up here exactly as it would for a
  // real person.
  await page.evaluate(() => {
    const marker = Object.values(_nwrLayer._layers)[0];
    marker.fire('click');
  });
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => {
    const p = document.querySelector('.leaflet-popup');
    return {
      open: !!p,
      callsign: p ? p.querySelector('.nwr-callsign')?.textContent : null,
      hasPlayBtn: p ? !!p.querySelector('.nwr-btn-play') : false,
    };
  });
  ok('the popup opens on a real Leaflet click', after.open === true, String(after.open));
  ok('and it is the station that was clicked',
     after.callsign === 'KEC77', String(after.callsign));
  ok('with a play button for its stream', after.hasPlayBtn === true, String(after.hasPlayBtn));

  console.log('\n3. the marker sits somewhere a click can actually land');
  // A popup can be provably bindable (scene 2) while the icon itself is
  // rendered behind another pane or with pointer-events disabled, which
  // reads identically to "broken" for a real finger but not for a script
  // that calls .fire('click') directly. This checks the DOM element a
  // click would really hit.
  const geom = await page.evaluate(() => {
    const marker = Object.values(_nwrLayer._layers)[0];
    const el = marker.getElement();
    if (!el) return { found: false };
    const cs = getComputedStyle(el);
    const pane = el.closest('.leaflet-pane');
    const paneZ = pane ? getComputedStyle(pane).zIndex : null;
    const r = el.getBoundingClientRect();
    const topEl = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const topPane = topEl ? topEl.closest('.leaflet-pane') : null;
    return {
      found: true,
      pointerEvents: cs.pointerEvents,
      visible: cs.display !== 'none' && cs.visibility !== 'hidden',
      paneName: pane ? pane.className : null,
      paneZ,
      hitsMarker: !!(topEl && el.contains(topEl)),
      topElTag: topEl ? topEl.tagName : null,
      topElId: topEl ? topEl.id : null,
      topElClass: topEl ? topEl.className : null,
      topPaneName: topPane ? topPane.className : null,
      topPaneZ: topPane ? getComputedStyle(topPane).zIndex : null,
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
    };
  });
  ok('the marker has a real DOM element', geom.found === true, JSON.stringify(geom));
  ok('pointer-events are not disabled on it',
     geom.pointerEvents !== 'none', geom.pointerEvents);
  ok('it is actually visible', geom.visible === true, String(geom.visible));
  ok('nothing else is sitting on top of it and eating the click',
     geom.hitsMarker === true, JSON.stringify(geom));

  ok('nothing threw along the way', errors.length === 0, errors.join(' | '));
  await page.close();
}

console.log('\n3b. the SAME check with alerts loaded, the way it ships by default');
{
  // alertsPane draws through one shared <canvas>, and unlike every other
  // overlay's ordinary SVG pane - where a click only ever lands on an
  // actual drawn shape - a <canvas> element captures every pointer event
  // across its FULL rectangle (the whole map viewport) the instant one
  // shape has ever been drawn on it, whether or not anything is under the
  // cursor. Alerts ship on by default and sort first in the overlay list,
  // so this is not a corner case: it is what a fresh page actually does.
  const { page } = await boot('up');
  await page.evaluate(() => {
    const ren = _alertsCanvas();
    L.polygon([[30, -100], [45, -100], [45, -60], [30, -60]],
      { pane: 'alertsPane', renderer: ren, color: '#f00' }).addTo(map);
  });
  await page.evaluate(() => toggleOverlayPill('radio'));
  await page.waitForTimeout(2000);

  const before = await page.evaluate(() =>
    !!document.querySelector('.leaflet-popup'));
  await page.evaluate(() => {
    const marker = Object.values(_nwrLayer._layers)[0];
    marker.fire('click');
  });
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({
    open: !!document.querySelector('.leaflet-popup'),
  }));
  ok('no popup before the click', before === false, String(before));
  ok('the popup still opens with an alert polygon loaded',
     after.open === true, String(after.open));

  const geom = await page.evaluate(() => {
    const marker = Object.values(_nwrLayer._layers)[0];
    const el = marker.getElement();
    const r = el.getBoundingClientRect();
    const topEl = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      hitsMarker: !!(topEl && el.contains(topEl)),
      topElTag: topEl ? topEl.tagName : null,
      alertsZ: getComputedStyle(map.getPane('alertsPane')).zIndex,
      radioMarkerZ: getComputedStyle(map.getPane('ovp-radio-m')).zIndex,
    };
  });
  ok('a real click still lands on the marker, not the alerts canvas',
     geom.hitsMarker === true, JSON.stringify(geom));
  ok('the alerts pane sits below the radio marker pane',
     Number(geom.alertsZ) < Number(geom.radioMarkerZ), JSON.stringify(geom));

  await page.close();
}

console.log('\n4. every external source unreachable still says so honestly');
{
  const { page } = await boot('down');
  await page.evaluate(() => toggleOverlayPill('radio'));
  await page.waitForTimeout(2000);
  const st = await page.evaluate(() => ({
    hasLayer: !!_nwrLayer,
    markerCount: _nwrLayer ? Object.keys(_nwrLayer._layers).length : 0,
  }));
  ok('no layer is left half-built when every source fails',
     !st.hasLayer || st.markerCount === 0, JSON.stringify(st));
  await page.close();
}

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
