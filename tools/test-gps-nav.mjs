#!/usr/bin/env node
/*
 * The GPS settings tab and the weather-colored navigation behind it.
 *
 *     node tools/test-gps-nav.mjs
 *
 * Location moved out of Units into a tab of its own, and gained a maps-app
 * style navigator: destinations in any order, several routes with an ETA
 * each, and the chosen route painted by the weather alerts it drives
 * through on the Alert Desk's five-step scale - the ordinary road color
 * where nothing is happening, then yellow, orange, red, magenta.
 *
 * OSRM and Nominatim are stubbed: what is under test is the panel, the
 * grading and the painting, not whether two public services are up.
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

console.log('\n1. the source: Location left Units, GPS arrived');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
ok('no em dash anywhere in the page', !html.includes('\u2014'));
ok('the Units tab is called Units now, nothing about location',
   /data-merge-label="Units"/.test(html) && !/data-merge-label="Units & Location"/.test(html));
ok('there is no Location card in the units merge any more',
   !/<div class="lqm-settings-group" data-merge="units"[^>]*>\s*<div class="lqm-settings-category">[^<]*<use href=#ic-pin>/.test(html)
   && !/ic-pin><\/use><\/svg> Location</.test(html));
ok('a GPS card of its own exists', /data-cat="gps"/.test(html)
   && /<use href=#ic-pin><\/use><\/svg> GPS</.test(html));
ok('with a real Show My Location toggle at last',
   /id="lqm-set-location"/.test(html));
ok('the tutorial promises the tabs that exist',
   !/Units &amp; Location/.test(html) && /<strong>GPS<\/strong> tab/.test(html));

// A straight west-to-east route at 28N, and an alternative that dips south.
const line = (lat) => Array.from({ length: 21 },
  (_, i) => [-81 + i * 0.05, lat]);
const OSRM = {
  code: 'Ok',
  routes: [
    { distance: 100000, duration: 3600, geometry: { coordinates: line(28.0) } },
    { distance: 120000, duration: 4500, geometry: { coordinates: line(27.5) } },
  ],
};
const NOMINATIM = [
  { display_name: 'Orlando, Orange County, Florida, United States',
    lat: '28.54', lon: '-81.38' },
  { display_name: 'Orlando, Somewhere Else', lat: '10.0', lon: '10.0' },
];

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'],
});
const ctx = await browser.newContext();
await ctx.addInitScript(() => {
  try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {}
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));

const osrmAsked = [];
// The fake sky for the conditions service: 'clear' answers dry everywhere,
// 'storm' puts a violent downpour over the eastern half of whatever list of
// spots the page asks about.
let wxMode = 'clear';
await page.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript',
      body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css',
      body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  if (url.includes('router.project-osrm.org/route/v1/driving/')) {
    osrmAsked.push(decodeURIComponent(url));
    return route.fulfill({ contentType: 'application/json',
      body: JSON.stringify(OSRM) });
  }
  if (url.includes('nominatim.openstreetmap.org/search'))
    return route.fulfill({ contentType: 'application/json',
      body: JSON.stringify(NOMINATIM) });
  if (url.includes('api.open-meteo.com/v1/forecast')) {
    const lats = ((url.match(/latitude=([0-9.,-]+)/) || [, ''])[1] || '')
      .split(',').filter(Boolean);
    const n = lats.length;
    const one = (stormy) => ({ current: stormy
      ? { precipitation: 25, weather_code: 95, wind_gusts_10m: 40 }
      : { precipitation: 0, weather_code: 0, wind_gusts_10m: 10 } });
    const arr = lats.map((_, i) => one(wxMode === 'storm' && i >= Math.floor(n / 2)));
    return route.fulfill({ contentType: 'application/json',
      body: JSON.stringify(n === 1 ? arr[0] : arr) });
  }
  return route.abort();
});
await page.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);

console.log('\n2. the settings rail');
{
  const r = await page.evaluate(() => {
    lqmOpenSettings();
    _lqmSetBuildRail();
    const tabs = Array.from(document.querySelectorAll('#lqm-set-rail .lqm-set-tab'))
      .map(t => ({ id: t.dataset.tab, label: t.textContent.trim() }));
    const gps = tabs.find(t => t.label === 'GPS');
    if (gps) lqmSettingsCat(gps.id);
    const card = document.querySelector('[data-cat="' + (gps ? gps.id : '') + '"]');
    const visible = card ? !card.hidden : false;
    const hasControls = ['lqm-set-location', 'lqm-set-follow', 'lqm-set-gpshud',
                         'lqm-set-breadcrumb']
      .every(id => !!document.getElementById(id));
    if (typeof lqmCloseSettings === 'function') lqmCloseSettings();
    return { tabs, gps: !!gps, visible, hasControls,
             units: tabs.some(t => t.label === 'Units'),
             oldUnits: tabs.some(t => /Units\s*&\s*Location/.test(t.label)) };
  });
  ok('the rail has a GPS tab', r.gps, JSON.stringify(r.tabs));
  ok('and a Units tab, with the old combined name gone',
     r.units && !r.oldUnits, JSON.stringify(r.tabs.map(t => t.label)));
  ok('eleven tabs in all', r.tabs.length === 11,
     r.tabs.length + ': ' + r.tabs.map(t => t.label).join(', '));
  ok('clicking GPS shows its card', r.visible);
  ok('every location control lives there', r.hasControls);
}

console.log('\n3. reading the weather at a point');
{
  const r = await page.evaluate(() => {
    // Two alert polygons: a severe box mid-route at 28N, an extreme box
    // farther north that no test route enters.
    _lastAlertFeatures = [
      { type: 'Feature', properties: { severity: 'Severe', event: 'Tornado Warning' },
        geometry: { type: 'Polygon', coordinates: [[
          [-80.6, 27.9], [-80.4, 27.9], [-80.4, 28.1], [-80.6, 28.1], [-80.6, 27.9]]] } },
      { type: 'Feature', properties: { severity: 'Extreme', event: 'Tornado Emergency' },
        geometry: { type: 'Polygon', coordinates: [[
          [-80.6, 29.9], [-80.4, 29.9], [-80.4, 30.1], [-80.6, 30.1], [-80.6, 29.9]]] } },
    ];
    return {
      inSevere: _navSeverity(28.0, -80.5),
      inExtreme: _navSeverity(30.0, -80.5),
      outside: _navSeverity(28.0, -79.0),
      colors: NAV_COLORS,
    };
  });
  ok('inside the severe polygon reads High', r.inSevere === 3, String(r.inSevere));
  ok('inside the extreme polygon reads Extreme', r.inExtreme === 4, String(r.inExtreme));
  ok('open road reads None', r.outside === 0, String(r.outside));
  ok('the scale is the one asked for: base, yellow, orange, red, magenta',
     r.colors.length === 5
     && r.colors[1].toLowerCase() === '#ffd400'
     && r.colors[2].toLowerCase() === '#ff8c00'
     && /^#ff/i.test(r.colors[3])
     && /^#e0|^#f0|^#c0|^#d0/i.test(r.colors[4]),
     r.colors.join());
}

console.log('\n4. destinations and routes');
{
  const r = await page.evaluate(async () => {
    _navOpen();
    const panelShown = document.getElementById('nav-panel').style.display !== 'none';
    const settingsClosed = !document.getElementById('lqm-settings-overlay')
      .classList.contains('lqm-panel-open');
    const emptyMsg = document.getElementById('nav-stops').textContent;

    // A place searched, offered, picked.
    document.getElementById('nav-search').value = 'Orlando';
    await _navSearch();
    const sugRows = document.querySelectorAll('#nav-suggest .nav-sug').length;
    _navPick(0);
    const firstStop = _navStops[0];

    // A second stop typed straight in, the routing then fires.
    _navStops.push({ name: 'Cocoa Beach', lat: 28.0, lon: -80.0 });
    _navRenderStops();
    await _navRoute();
    const routeRows = Array.from(document.querySelectorAll('#nav-routes .nav-route'))
      .map(el => el.textContent.trim());
    return {
      panelShown, settingsClosed, emptyMsg, sugRows,
      firstStop,
      nRoutes: _navRoutes.length,
      worsts: _navRoutes.map(rt => rt.worst),
      routeRows,
      note: document.getElementById('nav-note').textContent,
      selPainted: !!_navLayer,
    };
  });
  ok('opening navigation closes Settings and shows the panel',
     r.panelShown && r.settingsClosed);
  ok('with an honest empty state', /starting point/i.test(r.emptyMsg), r.emptyMsg);
  ok('a search offers the geocoder\'s answers', r.sugRows === 2, String(r.sugRows));
  ok('picking one keeps the sayable part of the name',
     r.firstStop && r.firstStop.name === 'Orlando, Orange County'
       && Math.abs(r.firstStop.lat - 28.54) < 0.01,
     JSON.stringify(r.firstStop));
  ok('two stops produce both offered routes', r.nRoutes === 2, String(r.nRoutes));
  ok('each with a time, a distance and an arrival clock',
     r.routeRows.length === 2 && r.routeRows.every(t => /min|hr/.test(t) && /mi|km/.test(t) && /AM|PM/.test(t)),
     r.routeRows.join(' | '));
  ok('the route through the warning is graded High, the southern one clear',
     r.worsts[0] === 3 && r.worsts[1] === 0, r.worsts.join());
  ok('and the list says which, in words', /HIGH/.test(r.routeRows[0]),
     r.routeRows[0]);
  ok('the note explains the chosen route\'s weather', /high/i.test(r.note), r.note);
  ok('something is actually drawn on the map', r.selPainted);
}

console.log('\n5. the paint on the map');
{
  const r = await page.evaluate(() => {
    // Walk what was drawn: polylines by color.
    const colors = {};
    _navLayer.eachLayer(l => {
      if (l instanceof L.Polyline && l.options && l.options.color) {
        colors[l.options.color] = (colors[l.options.color] || 0) + 1;
      }
    });
    const sel = _navRoutes[_navSel];
    return {
      colors,
      segLvls: sel.segs.map(sg => sg.lvl),
      segsJoinUp: sel.segs.every(sg => sg.latlngs.length >= 2),
    };
  });
  ok('the chosen route carries the red stretch through the warning',
     (r.colors['#ff2a2a'] || 0) >= 1, JSON.stringify(r.colors));
  ok('and ordinary road color everywhere else, not yellow',
     (r.colors['#3a4148'] || 0) >= 1 && !r.colors['#ffd400'], JSON.stringify(r.colors));
  ok('a pale casing underneath so the route reads as one road',
     (r.colors['#dfe6ee'] || 0) === 1, JSON.stringify(r.colors));
  ok('the alternative waits in grey', (r.colors['#8593a1'] || 0) === 1,
     JSON.stringify(r.colors));
  ok('the graded segments are real lines, clear then warned then clear',
     r.segLvls.includes(3) && r.segLvls[0] === 0 && r.segsJoinUp,
     r.segLvls.join());
}

console.log('\n5b. real conditions color the road even with no alert out');
{
  // A violent downpour over the eastern half of the route, and not one
  // alert polygon anywhere. The road must color anyway: the car gets wet
  // whether or not a warning was issued.
  wxMode = 'storm';
  const r = await page.evaluate(async () => {
    _lastAlertFeatures = [];
    _navWxCache.clear();
    await _navRoute();
    const sel = _navRoutes[_navSel];
    return {
      worsts: _navRoutes.map(rt => rt.worst),
      segLvls: sel.segs.map(sg => sg.lvl),
      timer: !!_navTrackTimer,
      note: document.getElementById('nav-note').textContent,
    };
  });
  ok('a downpour with no warning still grades the route Extreme',
     r.worsts[0] === 4, r.worsts.join());
  ok('the dry start stays base color, the wet half is painted',
     r.segLvls[0] === 0 && r.segLvls.includes(4), r.segLvls.join());
  ok('the tracking timer is running while routes are shown', r.timer);
  ok('and the note says the colors are re-read on their own',
     /rechecked/i.test(r.note), r.note);

  // The sky clears. The tracking pass, run by hand here, must lower the
  // colors in place without waiting for a new route request.
  wxMode = 'clear';
  const reg = await page.evaluate(async () => {
    const before = _navRoutes[0].worst;
    _navWxCache.clear();
    await _navRegrade();
    return { before, after: _navRoutes[0].worst };
  });
  ok('the tracking pass re-reads the sky in place',
     reg.before === 4 && reg.after === 0, JSON.stringify(reg));

  // Back to the alert scenario the later sections expect.
  await page.evaluate(async () => {
    _navWxCache.clear();
    _lastAlertFeatures = [
      { type: 'Feature', properties: { severity: 'Severe', event: 'Tornado Warning' },
        geometry: { type: 'Polygon', coordinates: [[
          [-80.6, 27.9], [-80.4, 27.9], [-80.4, 28.1], [-80.6, 28.1], [-80.6, 27.9]]] } },
    ];
    await _navRoute();
  });
}

console.log('\n5c. reporting what the road is like');
{
  const r = await page.evaluate(() => {
    localStorage.removeItem('gwcfc_navreports');
    const btns = Array.from(document.querySelectorAll('#nav-report-bar .nav-rep'))
      .map(b => b.dataset.rep);
    _navArmReport('police');
    const armed = {
      placing: _navPlacing,
      lit: document.querySelector('.nav-rep[data-rep="police"]').classList.contains('arm'),
      hint: document.getElementById('nav-report-hint').textContent,
      cursor: document.getElementById('map').style.cursor,
    };
    map.fire('click', { latlng: L.latLng(28.2, -80.7) });
    const placed = JSON.parse(localStorage.getItem('gwcfc_navreports') || '[]');
    let pins = 0; _navReportLayer.eachLayer(() => pins++);
    const disarmed = _navPlacing === null
      && document.getElementById('nav-report-hint').style.display === 'none'
      && document.getElementById('map').style.cursor === '';

    // Armed and thought better of it.
    _navArmReport('good');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    const escWorked = _navPlacing === null;

    // A stale report planted straight into storage must not come back.
    const a = JSON.parse(localStorage.getItem('gwcfc_navreports'));
    a.push({ id: 'old1', type: 'police', lat: 28, lon: -80,
             at: Date.now() - 5 * 3600000, note: '' });
    localStorage.setItem('gwcfc_navreports', JSON.stringify(a));
    _navDrawReports();
    const afterTrim = JSON.parse(localStorage.getItem('gwcfc_navreports'));

    _navReportNote(placed[0].id, 'unmarked car');
    const noted = JSON.parse(localStorage.getItem('gwcfc_navreports'))[0].note;
    _navDeleteReport(placed[0].id);
    let pinsAfter = 0; _navReportLayer.eachLayer(() => pinsAfter++);
    const emptied = JSON.parse(localStorage.getItem('gwcfc_navreports')).length;
    return { btns, armed, placed, pins, disarmed, escWorked,
             afterTrim, noted, pinsAfter, emptied };
  });
  ok('six things can be reported, police, bad weather and good news included',
     r.btns.length === 6 && ['police', 'weather', 'good'].every(t => r.btns.includes(t)),
     r.btns.join());
  ok('arming one says what to do next and changes the cursor',
     r.armed.placing === 'police' && r.armed.lit
       && /tap the map/i.test(r.armed.hint) && r.armed.cursor === 'crosshair',
     JSON.stringify(r.armed).slice(0, 200));
  ok('a tap places it, stores it, and draws the pin',
     r.placed.length === 1 && r.placed[0].type === 'police'
       && Math.abs(r.placed[0].lat - 28.2) < 0.01 && r.pins === 1,
     JSON.stringify(r.placed));
  ok('and placing disarms, so the next tap is just a tap', r.disarmed);
  ok('Escape cancels an armed report', r.escWorked);
  ok('a five-hour-old report ages out instead of misleading anyone',
     r.afterTrim.every(x => x.id !== 'old1'), JSON.stringify(r.afterTrim));
  ok('a note can be added after the fact', r.noted === 'unmarked car', r.noted);
  ok('removing a report clears pin and record alike',
     r.pinsAfter === 0 && r.emptied === 0, `${r.pinsAfter} pins, ${r.emptied} records`);
}

console.log('\n6. choosing, rearranging, removing');
{
  const asked0 = osrmAsked.length;
  const r = await page.evaluate(async () => {
    _navSelect(1);
    const noteAfter = document.getElementById('nav-note').textContent;
    const selRow = document.querySelector('#nav-routes .nav-route.sel');
    const stopsBefore = _navStops.map(s => s.name);
    _navMoveStop(0, 1);
    await new Promise(res => setTimeout(res, 300));
    const stopsAfter = _navStops.map(s => s.name);
    _navRemoveStop(1);
    await new Promise(res => setTimeout(res, 300));
    return {
      noteAfter,
      selIdx: selRow ? selRow.dataset.route : null,
      stopsBefore, stopsAfter,
      left: _navStops.length,
      routesAfterRemove: _navRoutes.length,
    };
  });
  ok('choosing the clear route says so', /clear/i.test(r.noteAfter), r.noteAfter);
  ok('and the list marks it chosen', r.selIdx === '1', String(r.selIdx));
  ok('stops can swap order', r.stopsBefore[0] === r.stopsAfter[1]
     && r.stopsBefore[1] === r.stopsAfter[0],
     r.stopsBefore.join('>') + ' vs ' + r.stopsAfter.join('>'));
  const reasked = osrmAsked.slice(asked0);
  ok('every rearrangement asks for fresh routes in the new order',
     reasked.length >= 1 && /-80,28.*-81\.38,28\.54|(-80),(28);.*/.test(reasked[0]),
     reasked[0]);
  ok('removing a stop leaves one, and no stale routes on offer',
     r.left === 1 && r.routesAfterRemove === 0,
     `${r.left} stops, ${r.routesAfterRemove} routes`);
}

console.log('\n7. closed means gone');
{
  const r = await page.evaluate(() => {
    _navClose();
    let pins = 0;
    if (_navReportLayer) _navReportLayer.eachLayer(() => pins++);
    // One report left behind on purpose, to see that closing spares it.
    _navPlacing = 'hazard';
    _navPlaceReport(28.3, -80.9);
    let pinsAfter = 0; _navReportLayer.eachLayer(() => pinsAfter++);
    const kept = pinsAfter;
    localStorage.removeItem('gwcfc_navreports');
    return {
      hidden: document.getElementById('nav-panel').style.display === 'none',
      layerGone: !_navLayer,
      timerGone: !_navTrackTimer,
      kept,
    };
  });
  ok('the panel hides', r.hidden);
  ok('and the routes leave the map with it', r.layerGone);
  ok('the tracking timer stops with the panel', r.timerGone);
  ok('but reports outlive the panel that filed them', r.kept === 1, String(r.kept));
}

console.log('\n8. nothing threw');
ok('no uncaught page errors', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
