#!/usr/bin/env node
/*
 * The right-click map menu, driven in a real browser with real Leaflet and
 * no network.
 *
 *     node tools/test-map-menu.mjs
 *
 * Right-click on the bare map opens a small menu about that exact spot:
 * copy the coordinates, jump to the nearest radar with its products open,
 * open the nearest forecast dot, list the alerts covering the point, park
 * the Inspector there, ring it with a radius, zoom in. While a drawing tool
 * is active, right-click keeps its old job (cancel the tool) and the menu
 * must stay out of the way.
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
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript',
      body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css',
      body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  return route.abort();
});
await page.goto('file://' + join(ROOT, 'index.html'),
                { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);

// A right-click, the way Leaflet delivers one.
const rclick = (lat, lng) => page.evaluate(([lat, lng]) =>
  map.fire('contextmenu', { latlng: L.latLng(lat, lng),
    originalEvent: { clientX: 400, clientY: 300, preventDefault() {},
                     stopPropagation() {} } }), [lat, lng]);
const menuOpen = () => page.evaluate(() => {
  const el = document.getElementById('map-ctx-menu');
  return !!(el && el.classList.contains('open'));
});
const menuText = () => page.evaluate(() =>
  document.getElementById('map-ctx-menu')?.textContent || '');

console.log('\n1. right-click on the bare map opens the menu');
{
  ok('the page boots clean', errors.length === 0, errors[0]);
  // Near Oklahoma City: nearest radar must come out KTLX.
  await rclick(35.3, -97.3);
  ok('the menu opens', await menuOpen(), 'not open');
  const t = await menuText();
  ok('titled with the exact coordinates', /35\.3000, -97\.3000/.test(t), t);
  ok('offers copy, radar, forecast, alerts, inspect, radius, zoom',
     /Copy coordinates/.test(t) && /Radar: KTLX/.test(t)
     && /Forecast: /.test(t) && /Alerts here \(0\)/.test(t)
     && /Inspect values here/.test(t) && /50 mi radius here/.test(t)
     && /Zoom in here/.test(t), t);
}

console.log('\n2. copy coordinates');
{
  const copied = await page.evaluate(() => { _cmCopyCoords(); return _cmLastCopied; });
  ok('the exact spot lands on the clipboard', copied === '35.3000, -97.3000',
     String(copied));
  ok('and the menu closed itself', !(await menuOpen()), 'still open');
}

console.log('\n3. jump to the nearest radar with products open');
{
  const r = await page.evaluate(async () => {
    window.__radarCall = null;
    window.loadL3Data = async (p, s) => { window.__radarCall = { p, s }; };
    map.fire('contextmenu', { latlng: L.latLng(35.3, -97.3),
      originalEvent: { clientX: 400, clientY: 300, preventDefault() {} } });
    _cmGoRadar();
    await new Promise(res => setTimeout(res, 1500));
    return {
      call: window.__radarCall,
      center: map.getCenter(),
      row: [...document.querySelectorAll('#sub-bubbles .sub-bubble')]
        .map(e => e.textContent.trim()).join(','),
    };
  });
  ok('the nearest site is asked for its raw Level 2',
     r.call && r.call.s === 'ktlx', JSON.stringify(r.call));
  ok('the map flew to the radar',
     Math.abs(r.center.lat - 35.33) < 0.2 && Math.abs(r.center.lng + 97.28) < 0.2,
     JSON.stringify(r.center));
  ok('and the radar product row is on screen',
     /Reflectivity/.test(r.row) && /Velocity/.test(r.row), r.row);
}

console.log('\n4. jump to the nearest forecast dot');
{
  const r = await page.evaluate(async () => {
    window.__fcCity = null;
    window.openForecastModal = (c) => { window.__fcCity = c; };
    activeLayers.forecasts = false;
    map.fire('contextmenu', { latlng: L.latLng(35.47, -97.52),
      originalEvent: { clientX: 400, clientY: 300, preventDefault() {} } });
    _cmGoForecast();
    await new Promise(res => setTimeout(res, 1200));
    return { city: window.__fcCity && window.__fcCity.name,
             dotsOn: !!activeLayers.forecasts,
             dist: window.__fcCity
               ? map.distance(L.latLng(35.47, -97.52),
                              L.latLng(window.__fcCity.lat, window.__fcCity.lon)) / 1609
               : null };
  });
  ok('the nearest city\'s forecast opens', !!r.city && r.dist < 25,
     r.city + ' at ' + (r.dist && r.dist.toFixed(1)) + ' mi');
  ok('the forecast dots layer switches on to show it', r.dotsOn,
     String(r.dotsOn));
}

console.log('\n5. alerts at the point');
{
  const r = await page.evaluate(() => {
    // One warning covering the point, one far away: only the first counts.
    _lastAlertFeatures = [
      { id: 'a1', properties: { id: 'a1', event: 'Tornado Warning',
                                expires: new Date(Date.now() + 3600000).toISOString() },
        geometry: { type: 'Polygon',
          coordinates: [[[-98, 35], [-96, 35], [-96, 36], [-98, 36], [-98, 35]]] } },
      { id: 'a2', properties: { id: 'a2', event: 'Flood Warning' },
        geometry: { type: 'Polygon',
          coordinates: [[[-80, 25], [-79, 25], [-79, 26], [-80, 26], [-80, 25]]] } },
    ];
    map.fire('contextmenu', { latlng: L.latLng(35.3, -97.3),
      originalEvent: { clientX: 400, clientY: 300, preventDefault() {} } });
    const label = document.getElementById('map-ctx-menu').textContent;
    window.__focused = null;
    window._focusAlertById = (id) => { window.__focused = id; };
    _cmShowAlerts();
    const pop = document.querySelector('.leaflet-popup-content');
    const popText = pop ? pop.textContent : '';
    _cmFocusAlert(0);
    return { label, popText, focused: window.__focused };
  });
  ok('the menu counts the alerts covering the spot',
     /Alerts here \(1\)/.test(r.label), r.label);
  ok('the popup lists the warning by name, not the far one',
     /Tornado Warning/.test(r.popText) && !/Flood Warning/.test(r.popText),
     r.popText);
  ok('tapping a row focuses that alert on the map', r.focused === 'a1',
     String(r.focused));
}

console.log('\n6. inspector, radius, and zoom');
{
  const r = await page.evaluate(async () => {
    map.fire('contextmenu', { latlng: L.latLng(34.0, -95.0),
      originalEvent: { clientX: 400, clientY: 300, preventDefault() {} } });
    _cmInspectHere();
    const insp = _inspEnabled;
    if (_inspEnabled) toggleInspector();

    map.fire('contextmenu', { latlng: L.latLng(34.5, -95.5),
      originalEvent: { clientX: 400, clientY: 300, preventDefault() {} } });
    _cmRadiusHere();
    const rad = _radii.length && { lat: _radii[0].lat, lng: _radii[0].lng,
                                   miles: _radii[0].miles };

    const zBefore = map.getZoom();
    map.fire('contextmenu', { latlng: L.latLng(34.5, -95.5),
      originalEvent: { clientX: 400, clientY: 300, preventDefault() {} } });
    _cmZoomHere();
    await new Promise(res => setTimeout(res, 1500));
    return { insp, rad, zBefore, zAfter: map.getZoom() };
  });
  ok('Inspect here switches the Inspector on', r.insp === true, String(r.insp));
  ok('Radius here drops a 50 mile circle at the point',
     r.rad && r.rad.miles === 50 && Math.abs(r.rad.lat - 34.5) < 0.001,
     JSON.stringify(r.rad));
  ok('Zoom in here zooms in', r.zAfter > r.zBefore,
     r.zBefore + ' -> ' + r.zAfter);
}

console.log('\n7. the menu respects the tools and knows when to leave');
{
  const r = await page.evaluate(() => {
    toggleStormConeTool();       // a tool now owns right-click
    map.fire('contextmenu', { latlng: L.latLng(35, -97),
      originalEvent: { clientX: 400, clientY: 300, preventDefault() {} } });
    const during = document.getElementById('map-ctx-menu')
      .classList.contains('open');
    deactivateTool();
    map.fire('contextmenu', { latlng: L.latLng(35, -97),
      originalEvent: { clientX: 400, clientY: 300, preventDefault() {} } });
    const after = document.getElementById('map-ctx-menu')
      .classList.contains('open');
    map.fire('movestart');
    const afterMove = document.getElementById('map-ctx-menu')
      .classList.contains('open');
    return { during, after, afterMove };
  });
  ok('no menu while a drawing tool is active', r.during === false,
     String(r.during));
  ok('the menu is back once the tool is gone', r.after === true,
     String(r.after));
  ok('panning the map closes it', r.afterMove === false, String(r.afterMove));
}

console.log('\n8. no webhook secrets in the page, ever again');
{
  // The spam attack started with a Discord webhook URL sitting in this very
  // file: to Discord the URL is the whole credential. This check fails the
  // suite the moment anyone pastes one back in.
  const src = readFileSync(join(ROOT, 'index.html'), 'utf8');
  ok('index.html contains no Discord webhook URL',
     !/discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d/.test(src),
     'a webhook URL is in the page source');

  // And the feedback form posts through the Pi relay instead.
  const r = await page.evaluate(async () => {
    window.__relayHits = [];
    const real = window.fetch;
    window.fetch = async (u, opts) => {
      if (String(u).includes('/relay/')) {
        window.__relayHits.push({ url: String(u), body: JSON.parse(opts.body) });
        return new Response('{"ok":true}', { status: 200 });
      }
      return real(u, opts);
    };
    _hdBase = 'https://fake-pi.test';
    document.getElementById('feedback-text').value = 'test note';
    document.getElementById('feedback-contact').value = 'me@example.com';
    await _fbSubmit();
    window.fetch = real;
    return { hits: window.__relayHits,
             status: document.getElementById('feedback-status').textContent };
  });
  ok('feedback posts to the Pi relay, not to Discord',
     r.hits.length === 1 && r.hits[0].url === 'https://fake-pi.test/relay/feedback',
     JSON.stringify(r.hits.map(h => h.url)));
  ok('with the embed the relay expects',
     r.hits[0] && r.hits[0].body.embeds
     && r.hits[0].body.embeds[0].description === 'test note',
     JSON.stringify(r.hits[0] && r.hits[0].body));
  ok('and tells the sender it worked', /been sent/i.test(r.status), r.status);
}

console.log('\n8b. set as recenter, and set as load spot');
{
  const r = await page.evaluate(() => {
    localStorage.removeItem('gwcfc_load_spot');
    _recenterLat = null; _recenterLng = null;
    // Open the menu and confirm both new items are offered.
    map.fire('contextmenu', { latlng: L.latLng(41.5, -81.7),
      originalEvent: { clientX: 400, clientY: 300, preventDefault() {} } });
    const text = document.getElementById('map-ctx-menu').textContent;

    // Recenter: drops the session anchor at the exact point.
    map.fire('contextmenu', { latlng: L.latLng(41.5, -81.7),
      originalEvent: { clientX: 400, clientY: 300, preventDefault() {} } });
    _cmSetRecenter();
    const anchor = { lat: _recenterLat, lng: _recenterLng };

    // Load spot: saved to this device at whatever zoom the map is at. The
    // headless map has no real container size, so it clamps zoom on its own;
    // the test records the map's actual zoom rather than assuming a value.
    const zoomAtSave = map.getZoom();
    map.fire('contextmenu', { latlng: L.latLng(25.8, -80.2),
      originalEvent: { clientX: 400, clientY: 300, preventDefault() {} } });
    _cmSetLoadSpot();
    const saved = JSON.parse(localStorage.getItem('gwcfc_load_spot') || 'null');
    return { text, anchor, saved, zoomAtSave };
  });
  ok('the menu offers both new items',
     /Set as recenter/.test(r.text) && /Set as load spot/.test(r.text), r.text);
  ok('set as recenter drops the anchor at the point',
     Math.abs(r.anchor.lat - 41.5) < 0.001 && Math.abs(r.anchor.lng + 81.7) < 0.001,
     JSON.stringify(r.anchor));
  ok('set as load spot saves the point and current zoom to this device',
     r.saved && Math.abs(r.saved.lat - 25.8) < 0.001 && r.saved.zoom === r.zoomAtSave,
     JSON.stringify(r.saved) + ' vs zoom ' + r.zoomAtSave);

  // On the next load, _applyLoadSpot must hand the saved values to setView.
  // Spying on setView avoids the headless map's own clamping muddying the
  // check: what matters is the code asks for the saved spot.
  const asked = await page.evaluate(() => {
    const spot = JSON.parse(localStorage.getItem('gwcfc_load_spot'));
    let call = null;
    const real = map.setView;
    map.setView = function (ll, z) { call = { lat: ll[0] ?? ll.lat, lng: ll[1] ?? ll.lng, z }; return real.apply(this, arguments); };
    _applyLoadSpot();
    map.setView = real;
    return { call, spot };
  });
  ok('the map is told to open at the saved load spot',
     asked.call && Math.abs(asked.call.lat - 25.8) < 0.001
     && Math.abs(asked.call.lng + 80.2) < 0.001 && asked.call.z === asked.spot.zoom,
     JSON.stringify(asked.call));
}

console.log('\n8c. the mosaic loop length control');
{
  const r = await page.evaluate(() => {
    // Frame count scales with the chosen reach, at the 5-minute cadence.
    _loopLenMin = 60;  const c1 = _loopFrameCount();
    _loopLenMin = 180; const c3 = _loopFrameCount();
    _loopLenMin = 360; const c6 = _loopFrameCount();
    // The generator makes exactly that many, oldest-first, 5 min apart.
    const f = _generateL3Frames(c3);
    const gap = f.length > 1 ? (f[1].time - f[0].time) : 0;
    // The setter persists the choice.
    lqmSetLoopLength('360');
    const saved = localStorage.getItem('gwcfc_loop_len');
    _loopLenMin = 60;
    return { c1, c3, c6, made: f.length, gap, saved };
  });
  ok('one hour is 12 frames', r.c1 === 12, String(r.c1));
  ok('three hours is 36 frames', r.c3 === 36, String(r.c3));
  ok('six hours is 72 frames', r.c6 === 72, String(r.c6));
  ok('the generator makes exactly that many, 5 minutes apart',
     r.made === 36 && r.gap === 300, r.made + ' gap ' + r.gap);
  ok('choosing a length is remembered', r.saved === '360', r.saved);
}

console.log('\n9. nothing threw along the way');
ok('no uncaught errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
