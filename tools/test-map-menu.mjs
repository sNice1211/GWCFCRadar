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

console.log('\n8d. single-site raw playback dispatch');
{
  // The decode is exercised live elsewhere; here we prove the loop OWNS the
  // timeline and play controls once it has frames, with fake frames so no
  // network is needed. A real image overlay is put on the map so
  // _l2LoopActive() sees what it checks for.
  const r = await page.evaluate(() => {
    const px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    _disableL3();
    _l3Station = 'ktlx'; _l3Product = 'ref';
    _l3Overlay = L.imageOverlay(px, [[33, -99], [37, -95]],
      { pane: 'radarPane' }).addTo(map);
    // Three fake frames, deliberately out of time order to prove the sync
    // sorts them oldest-first.
    const t0 = Date.now();
    _l2Loop = { frames: [
      { url: px + '#c', bounds: [[33,-99],[37,-95]], time: t0 },
      { url: px + '#a', bounds: [[33,-99],[37,-95]], time: t0 - 600000 },
      { url: px + '#b', bounds: [[33,-99],[37,-95]], time: t0 - 300000 },
    ], idx: 0, station: 'ktlx', product: 'ref', building: false, token: 5 };
    _l2LoopSyncTimeline();
    const active = _l2LoopActive();
    const ready = _animationReady();
    const orderedNewestSelected = _l2Loop.idx === 2
      && _l2Loop.frames[0].time < _l2Loop.frames[2].time;
    // Scrub to the oldest and confirm the one overlay swapped its image.
    seekFrame(0);
    const seekUrl = _l3Overlay._url;
    // Step forward one and confirm it advances by one frame.
    stepFrame(1);
    const stepIdx = _l2Loop.idx;
    return { active, ready, orderedNewestSelected, seekUrl, stepIdx,
             tlMax: +document.getElementById('timeline').max };
  });
  ok('the loop reports active and playable once it has frames',
     r.active === true && r.ready === true, JSON.stringify(r));
  ok('frames are sorted oldest-first with the newest selected',
     r.orderedNewestSelected === true, String(r.orderedNewestSelected));
  ok('the timeline is sized to the frame count', r.tlMax === 2, String(r.tlMax));
  ok('scrubbing swaps the single overlay to that frame image',
     /#a$/.test(r.seekUrl), r.seekUrl && r.seekUrl.slice(-20));
  ok('stepping advances exactly one frame', r.stepIdx === 1, String(r.stepIdx));
  // And clearing the radar tears the loop down.
  const cleared = await page.evaluate(() => {
    _disableL3();
    return { frames: _l2Loop.frames.length, active: _l2LoopActive() };
  });
  ok('disabling the radar clears the loop',
     cleared.frames === 0 && cleared.active === false, JSON.stringify(cleared));
}

console.log('\n8e. following a moving tunnel address');
{
  // The page reads the published address every few seconds and re-points the
  // Pi features when it changes. We stub the fetch so no network is needed and
  // prove: a new address is adopted, an unchanged one is a no-op, and a junk
  // value is refused rather than blindly stored.
  const r = await page.evaluate(async () => {
    const start = 'https://old-pi.test';
    _hdSetBase(start);
    // Reassign the global function binding _hdPollAddress resolves against.
    let handedOut = 'https://new-pi.test';
    _hdFetchPublished = async () => handedOut;
    // A published address is no longer believed on its word: it has to answer
    // first, which is what stops a stale one dragging a working site onto a
    // dead address. Nothing is routed in this suite, so the probe is stubbed
    // to say this one is alive. test-pi-address.mjs is where the refusing
    // half is proved.
    _hdAnswers = async (base) => base === handedOut;

    await _hdPollAddress();
    const afterChange = _hdBase;

    // Same address again: nothing should move.
    const changedSame = _hdApplyNewBase('https://new-pi.test');
    const afterSame = _hdBase;

    // A junk value must be refused, leaving the good address in place.
    const changedJunk = _hdApplyNewBase('not-a-url');
    const afterJunk = _hdBase;

    return { afterChange, changedSame, afterSame, changedJunk, afterJunk };
  });
  ok('a new published address is adopted without a reload',
     r.afterChange === 'https://new-pi.test', r.afterChange);
  ok('an unchanged address is a no-op',
     r.changedSame === false && r.afterSame === 'https://new-pi.test',
     JSON.stringify(r));
  ok('a malformed address is refused, keeping the good one',
     r.changedJunk === false && r.afterJunk === 'https://new-pi.test',
     JSON.stringify(r));
}

console.log('\n8h. the performance pass: canvas alerts, warmed connections');
{
  const r = await page.evaluate(async () => {
    // The shared alerts renderer must be one canvas in the alerts pane.
    const ren = _alertsCanvas();
    const isCanvas = ren instanceof L.Canvas;
    const samePane = ren.options.pane === 'alertsPane';
    const sameAgain = _alertsCanvas() === ren;

    // A polygon drawn through it must still be clickable, because the alert
    // popups ride on exactly that.
    let clicked = false;
    const poly = L.polygon([[35, -98], [36, -98], [36, -97], [35, -97]], {
      pane: 'alertsPane', renderer: ren, color: '#f00',
    }).addTo(map).on('click', () => { clicked = true; });
    map.setView([35.5, -97.5], 7);
    await new Promise(res => setTimeout(res, 250));
    poly.fire('click');
    const canvasInPane = !!map.getPane('alertsPane').querySelector('canvas');
    map.removeLayer(poly);

    // The connection warm-ups that shave the first paint.
    const links = [...document.querySelectorAll('link[rel="preconnect"], link[rel="dns-prefetch"]')]
      .map(l => l.href);
    const hasJsdelivr = links.some(h => h.includes('cdn.jsdelivr.net'));
    const hasFirestore = links.some(h => h.includes('firestore.googleapis.com'));

    return { isCanvas, samePane, sameAgain, clicked, canvasInPane, hasJsdelivr, hasFirestore };
  });
  ok('alerts share one canvas renderer in their own pane',
     r.isCanvas && r.samePane && r.sameAgain, JSON.stringify(r));
  ok('a canvas-drawn polygon still answers clicks',
     r.clicked === true && r.canvasInPane === true, JSON.stringify(r));
  ok('the render-blocking CDN and the Pi lookup are preconnected',
     r.hasJsdelivr && r.hasFirestore, JSON.stringify(r));
}

console.log('\n8i. model sounding from the right-click menu');
{
  // The row exists only while a Pi model is on the map, names the model and
  // the hour on screen, and clicking it asks the Pi for exactly that: a
  // column through that run at that hour, not whatever the panel last showed.
  let sndCalls = [];
  let sourcesMode = 'list';
  await page.route('**pi.test/**', route => {
    const url = route.request().url();
    if (url.includes('/sounding/sources')) {
      if (sourcesMode === 'gone') {
        return route.fulfill({ status: 404,
          contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({ contentType: 'application/json',
        body: JSON.stringify({ analysis: [], models: [{
          id: 'model:gfs', key: 'gfs', label: 'GFS', res: '13 km',
          out: 384, step: 3, upper: true }] }) });
    }
    if (url.includes('/sounding?')) {
      sndCalls.push(url);
      // The shape the Pi's model door really answers with: profile as
      // parallel arrays, `levels` as a COUNT. The panel must convert it,
      // which is the bug this body is here to catch.
      return route.fulfill({ contentType: 'application/json',
        body: JSON.stringify({
          profile: {
            p:  [1000, 925, 850, 700, 500, 400, 300, 250, 200, 150],
            T:  [25, 20, 14, 4, -10, -20, -34, -44, -54, -60],
            Td: [18, 14, 8, -4, -24, -34, -50, -60, -70, -75],
            u:  [5, 10, 15, 20, 30, 40, 50, 55, 60, 65],
            v:  [5, 8, 10, 12, 15, 18, 20, 22, 25, 28],
            z:  [110, 780, 1500, 3100, 5800, 7500, 9600, 10900, 12400, 14200],
          },
          source: 'model:gfs', label: 'GFS f012', model: 'GFS',
          valid: '2026-08-28T12:00Z', run: '20260828/00', fhr: 12,
          levels: 10, via: 'model', lat: 35.3, lon: -97.3,
        }) });
    }
    return route.abort();
  });

  // With no Pi model on the map, the row must be absent, not greyed.
  await page.evaluate(() => { _cmClose(); _hdOn = false; });
  await rclick(35.3, -97.3);
  const t0 = await menuText();
  ok('without a Pi model on the map there is no model sounding row',
     !/Model sounding/.test(t0) && /Sounding here/.test(t0), t0);

  // Put the GFS on, at slider stop 2 of hours [0, 6, 12, 18]: hour 12.
  //
  // The base is set FIRST, then the model state: _hdSetBase re-points the Pi
  // features, which includes switching the model layer off, so setting _hdOn
  // before it meant setting it twice and keeping neither. The address watcher
  // from 8e is also re-stubbed to hand out this same base, or its next poll
  // quietly drags _hdBase back to that section's address mid-scenario.
  await page.evaluate(() => {
    _cmClose();
    _hdFetchPublished = async () => 'https://pi.test';
    _hdAnswers = async () => true;
    _hdSetBase('https://pi.test');
    _hdOn = true; _hdModel = 'gfs'; _hdFromPicker = true;
    _hdIndex = { models: { gfs: { label: 'GFS' } } };
    _hdManifest = { fields: { refc: { hours: [0, 6, 12, 18] } } };
    _hdField = 'refc'; _hdHourIdx = 2;
    _sndPiSources = null; _sndPiSourcesPr = null; _sndPiDown = false;
    try { localStorage.removeItem('gwcfc_snd_source'); } catch (e) {}
  });
  await rclick(35.3, -97.3);
  const t1 = await menuText();
  ok('with the GFS up the row appears, naming the model and its hour',
     /Model sounding: GFS/.test(t1) && /F\+012/.test(t1), t1);

  await page.evaluate(() => { _cmModelSoundingHere(); });
  for (let i = 0; i < 120 && !sndCalls.length; i++) await page.waitForTimeout(100);
  ok('clicking it asks the Pi for that model at that hour',
     sndCalls.length > 0 && /source=model%3Agfs/.test(sndCalls[0])
     && /fhr=12/.test(sndCalls[0]), sndCalls[0] || 'no request went out');

  await page.waitForFunction(() => {
    const el = document.getElementById('snd-panel');
    return el && el.classList.contains('open')
      && /forecast hour/.test(el.querySelector('.snd-note').textContent);
  }, { timeout: 20000 }).catch(() => {});
  const r1 = await page.evaluate(() => {
    const el = document.getElementById('snd-panel');
    return {
      src: _sndSource,
      picker: el.querySelector('.snd-src').value,
      hour: el.querySelector('.snd-hour-lbl').textContent,
      note: el.querySelector('.snd-note').textContent,
      saved: localStorage.getItem('gwcfc_snd_source'),
      sliderAt: el._modelHours
        ? el._modelHours[+el.querySelector('.snd-hour').value] : null,
      rows: el._snd ? el._snd.rows.length : 0,
    };
  });
  ok('the panel is pointed at the model source, picker and state agreeing',
     r1.src === 'model:gfs' && r1.picker === 'model:gfs'
     && r1.saved === 'model:gfs', JSON.stringify(r1));
  ok('the slider sits on the forecast hour that was on screen',
     r1.hour === 'F+012' && r1.sliderAt === 12, JSON.stringify(r1));
  ok('the profile was converted and drawn, not thrown away',
     r1.rows === 10, String(r1.rows));
  ok('and the note says which run and which hour this forecast is',
     /GFS run 20260828\/00/.test(r1.note) && /forecast hour 12/.test(r1.note),
     r1.note);

  // An older Pi without /sounding/sources: the map still knows the model, so
  // the click must still target it, with an entry built from the map's own
  // hours rather than silently answering from the default source.
  await page.evaluate(() => {
    document.getElementById('snd-panel').classList.remove('open');
    _sndPiSources = null; _sndPiSourcesPr = null; _sndPiDown = false;
    try { localStorage.removeItem('gwcfc_snd_source'); } catch (e) {}
  });
  sourcesMode = 'gone'; sndCalls = [];
  await rclick(35.3, -97.3);
  await page.evaluate(() => { _cmModelSoundingHere(); });
  for (let i = 0; i < 120 && !sndCalls.length; i++) await page.waitForTimeout(100);
  ok('an older Pi with no source list still gets asked for the model',
     sndCalls.length > 0 && /source=model%3Agfs/.test(sndCalls[0]),
     sndCalls[0] || 'no request went out');
  const r2 = await page.evaluate(() => {
    const s = _sndFind('model:gfs');
    return s ? { label: s.label, out: s.out, step: s.step } : null;
  });
  ok('with a source entry built from the map\'s own hours',
     r2 && r2.label === 'GFS (model)' && r2.out === 18 && r2.step === 6,
     JSON.stringify(r2));

  // Leave the map the way this section found it.
  await page.evaluate(() => {
    document.getElementById('snd-panel').classList.remove('open');
    _hdOn = false; _cmClose();
  });
  await page.unroute('**pi.test/**');
}

console.log('\n8j. timeline tick labels fit the strip instead of overlapping');
{
  // The mobile screenshot bug: floor(8 frames / 5) is a step of ONE, so a
  // short loop got a label per frame, and the crowd ran on out of the strip
  // underneath the time display beside it. The builder now measures the
  // strip and ceil-thins to what fits.
  const r = await page.evaluate(() => {
    const wrap = document.getElementById('timeline-labels');
    const times = [];
    for (let i = 0; i < 8; i++) times.push(new Date(Date.UTC(2026, 7, 28, 13, 20 + i * 5)));

    // A wide strip: never more than five, even for a short loop.
    wrap.style.width = '300px';
    buildTimelineLabels({ times, first: 0 });
    const wide = wrap.querySelectorAll('span').length;

    // A phone-width strip: fewer still, because fewer fit.
    wrap.style.width = '120px';
    buildTimelineLabels({ times, first: 0 });
    const narrow = wrap.querySelectorAll('span').length;

    wrap.style.width = '';
    const cs = getComputedStyle(wrap);
    return { wide, narrow, overflow: cs.overflow, wrapMode: cs.whiteSpace };
  });
  ok('a short loop no longer gets a label per frame',
     r.wide >= 3 && r.wide <= 5, String(r.wide));
  ok('a phone-width strip thins further, to what fits',
     r.narrow >= 2 && r.narrow < r.wide, `${r.narrow} vs ${r.wide}`);
  ok('and the strip clips instead of running under its neighbour',
     r.overflow === 'hidden' && r.wrapMode === 'nowrap', JSON.stringify(r));

  // On a phone the visible time display must be allowed to shrink: its
  // desktop 100px floor plus flex-shrink 0 is what squeezed the timeline.
  await page.setViewportSize({ width: 390, height: 720 });
  await page.waitForTimeout(150);
  const m = await page.evaluate(() => {
    const cs = getComputedStyle(document.getElementById('anim-time-display'));
    return { minW: cs.minWidth, size: cs.fontSize };
  });
  ok('the time display gives up its 100px floor on a phone',
     m.minW === '0px', JSON.stringify(m));
  await page.setViewportSize({ width: 1280, height: 720 });
}

console.log('\n9. nothing threw along the way');
ok('no uncaught errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
