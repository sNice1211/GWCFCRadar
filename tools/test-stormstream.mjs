#!/usr/bin/env node
/*
 * StormStream Mode + Custom Graphics: the auto-cycling livestream/monitor
 * mode and its overlay-graphics library, entirely offline against synthetic
 * NWS-shaped alert features (no live network needed for any of this logic).
 *
 *     node tools/test-stormstream.mjs
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
await page.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4500);

const TOR_EMERG = {
  type: 'Feature',
  properties: {
    id: 'tor-emerg-1', event: 'Tornado Warning', severity: 'Extreme',
    headline: 'Tornado Emergency for downtown',
    description: 'TORNADO EMERGENCY. TORNADO...OBSERVED. 2.50 in hail and 70 mph wind gusts.',
    sent: new Date(Date.now() - 5 * 60000).toISOString(),
    effective: new Date(Date.now() - 5 * 60000).toISOString(),
    expires: new Date(Date.now() + 25 * 60000).toISOString(),
    areaDesc: 'Oklahoma County, OK', geocode: { UGC: ['OKC109'] },
  },
  geometry: { type: 'Polygon', coordinates: [[[-97.6, 35.4], [-97.4, 35.4], [-97.4, 35.6], [-97.6, 35.6], [-97.6, 35.4]]] },
};
const SVR = {
  type: 'Feature',
  properties: {
    id: 'svr-1', event: 'Severe Thunderstorm Warning', severity: 'Severe',
    headline: 'Severe Thunderstorm Warning', description: '60 mph wind gusts and quarter size hail.',
    sent: new Date(Date.now() - 2 * 60000).toISOString(),
    effective: new Date(Date.now() - 2 * 60000).toISOString(),
    expires: new Date(Date.now() + 30 * 60000).toISOString(),
    areaDesc: 'Travis County, TX', geocode: { UGC: ['TXC453'] },
  },
  geometry: { type: 'Polygon', coordinates: [[[-98.0, 30.1], [-97.6, 30.1], [-97.6, 30.5], [-98.0, 30.5], [-98.0, 30.1]]] },
};
const FAR_AWAY = {
  type: 'Feature',
  properties: {
    id: 'far-1', event: 'Flood Advisory', severity: 'Minor',
    sent: new Date().toISOString(), effective: new Date().toISOString(),
    expires: new Date(Date.now() + 60 * 60000).toISOString(),
    areaDesc: 'Cook County, IL', geocode: { UGC: ['ILC031'] },
  },
  geometry: { type: 'Polygon', coordinates: [[[-88.0, 41.7], [-87.5, 41.7], [-87.5, 42.1], [-88.0, 42.1], [-88.0, 41.7]]] },
};

console.log('\n1. coverage-area matching');
{
  const r = await page.evaluate(([torEmerg, svr, farAway]) => {
    _ssCfg = { coverage: 'us' };
    const usAll = [torEmerg, svr, farAway].every(f => _ssInCoverage(f));

    _ssCfg = { coverage: 'states', states: ['OK'] };
    const statesOnlyOK = _ssInCoverage(torEmerg) && !_ssInCoverage(svr) && !_ssInCoverage(farAway);

    _ssCfg = { coverage: 'poly', polygon: [
      { lat: 35.3, lng: -97.7 }, { lat: 35.7, lng: -97.7 }, { lat: 35.7, lng: -97.3 }, { lat: 35.3, lng: -97.3 },
    ] };
    const polyOnlyTor = _ssInCoverage(torEmerg) && !_ssInCoverage(svr);

    return { usAll, statesOnlyOK, polyOnlyTor };
  }, [TOR_EMERG, SVR, FAR_AWAY]);
  ok('"whole US" coverage accepts everything', r.usAll, JSON.stringify(r));
  ok('"states" coverage matches by UGC state prefix', r.statesOnlyOK, JSON.stringify(r));
  ok('"hand-drawn region" coverage matches by polygon intersection', r.polyOnlyTor, JSON.stringify(r));
}

console.log('\n2. priority scoring favors emergencies');
{
  const r = await page.evaluate(([torEmerg, svr, farAway]) => ({
    tor: _ssPriority(torEmerg), svr: _ssPriority(svr), far: _ssPriority(farAway),
  }), [TOR_EMERG, SVR, FAR_AWAY]);
  ok('a Tornado Emergency outranks a plain Severe Thunderstorm Warning',
     r.tor > r.svr, JSON.stringify(r));
  ok('a Severe Thunderstorm Warning outranks a Flood Advisory',
     r.svr > r.far, JSON.stringify(r));
}

console.log('\n3. tag parsing pulls hail/wind/tornado flags out of raw NWS text');
{
  const r = await page.evaluate((torEmerg) => _ssParseTags(torEmerg.properties.description), TOR_EMERG);
  ok('hail size parsed', r.hailSize === '2.50', JSON.stringify(r));
  ok('wind gust parsed', r.windGust === '70', JSON.stringify(r));
  ok('tornado tag parsed as OBSERVED', r.tornadoTag === 'OBSERVED', JSON.stringify(r));
  ok('emergency flag detected', r.isEmergency === true, JSON.stringify(r));
}

console.log('\n4. the cycling engine: HUD renders, map flies, idle state shows all-clear');
{
  const withAlerts = await page.evaluate(([torEmerg, svr]) => {
    _lastAlertFeatures = [torEmerg, svr];
    _ssCfg = { coverage: 'us', stepSec: 15, enabled: true, firstRunSeen: true };
    _ssStart();
    const hud = document.getElementById('stormstream-hud');
    return { hudExists: !!hud, hudText: hud ? hud.textContent : '', on: _ssOn };
  }, [TOR_EMERG, SVR]);
  ok('StormStream is running and the HUD exists', withAlerts.on && withAlerts.hudExists, JSON.stringify(withAlerts));
  ok('the HUD shows an alert title, not the idle message',
     /Warning/.test(withAlerts.hudText) && !/All Clear/.test(withAlerts.hudText), withAlerts.hudText);

  const skip = await page.evaluate(() => {
    const before = document.getElementById('stormstream-hud').textContent;
    _ssManualNext();
    const after = document.getElementById('stormstream-hud').textContent;
    return { before, after };
  });
  ok('manual skip changes which alert is shown', skip.before !== skip.after, JSON.stringify(skip));

  const back = await page.evaluate(() => {
    _ssManualPrev();
    return document.getElementById('stormstream-hud').textContent;
  });
  ok('manual previous returns to the earlier alert', back === skip.before, JSON.stringify({ back, expect: skip.before }));

  const idle = await page.evaluate(() => {
    _lastAlertFeatures = [];
    _ssTick();
    return document.getElementById('stormstream-hud').textContent;
  });
  ok('with nothing active it shows an all-clear message', /All Clear/.test(idle), idle);

  await page.evaluate(() => { _ssStop(); _lastAlertFeatures = []; });
  const stopped = await page.evaluate(() => ({ on: _ssOn, hud: !!document.getElementById('stormstream-hud') }));
  ok('stopping removes the HUD entirely', !stopped.on && !stopped.hud, JSON.stringify(stopped));
}

console.log('\n5. privacy warning appears when location sharing is on');
{
  const r = await page.evaluate(([torEmerg]) => {
    _locFollow = true;
    _lastAlertFeatures = [torEmerg];
    _ssCfg = { coverage: 'us', stepSec: 15, enabled: true, firstRunSeen: true };
    _ssStart();
    const warned = !!document.getElementById('ss-privacy-warn');
    _ssStop();
    _locFollow = false;
    return { warned };
  }, [TOR_EMERG]);
  ok('turning on StormStream with location sharing active shows a warning banner', r.warned, JSON.stringify(r));
}

console.log('\n6. Custom Graphics: upload, list, set active, delete');
{
  const uploaded = await page.evaluate(async () => {
    // A 1x1 red PNG, base64-decoded into a real Blob - exercises the exact
    // same path a file-picker upload would.
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'image/png' });
    await _sgAddGraphicFromBlob(blob, 'Test Bug', 'image/png');
    const all = await _sgAll();
    return { count: all.length, name: all[0] && all[0].name, hasBlob: all[0] && all[0].blob instanceof Blob };
  });
  ok('a graphic uploads into the IndexedDB library', uploaded.count === 1 && uploaded.hasBlob, JSON.stringify(uploaded));
  ok('its name is kept', uploaded.name === 'Test Bug', JSON.stringify(uploaded));

  const active = await page.evaluate(async ([torEmerg]) => {
    const all = await _sgAll();
    _ssCfg = { coverage: 'us', stepSec: 15, enabled: true, firstRunSeen: true, activeGraphicId: all[0].id };
    _lastAlertFeatures = [torEmerg];
    _ssStart();
    await new Promise(r => setTimeout(r, 100));
    const img = document.getElementById('sg-active-graphic');
    const shown = !!img && img.style.width !== '';
    _ssStop();
    const goneAfterStop = !document.getElementById('sg-active-graphic');
    return { shown, goneAfterStop };
  }, [TOR_EMERG]);
  ok('the active graphic renders on screen while StormStream runs', active.shown, JSON.stringify(active));
  ok('it disappears when StormStream stops', active.goneAfterStop, JSON.stringify(active));

  const deleted = await page.evaluate(async () => {
    const all = await _sgAll();
    await _sgDelete(all[0].id);
    const after = await _sgAll();
    return { before: all.length, after: after.length };
  });
  ok('deleting a graphic removes it from the library',
     deleted.before === 1 && deleted.after === 0, JSON.stringify(deleted));
}

console.log('\n7. Settings UI reflects the coverage-mode picker');
{
  const r = await page.evaluate(() => {
    lqmOpenSettings();
    _ssUiCoverage('radius');
    const radiusShown = document.getElementById('lqm-ss-radius-row').style.display !== 'none';
    const statesShown = document.getElementById('lqm-ss-states-row').style.display !== 'none';
    _ssUiCoverage('states');
    const statesShown2 = document.getElementById('lqm-ss-states-row').style.display !== 'none';
    const radiusShown2 = document.getElementById('lqm-ss-radius-row').style.display !== 'none';
    lqmCloseSettings();
    return { radiusShown, statesShown, statesShown2, radiusShown2 };
  });
  ok('picking "radius" shows the radius row and hides states',
     r.radiusShown && !r.statesShown, JSON.stringify(r));
  ok('picking "states" shows the states row and hides radius',
     r.statesShown2 && !r.radiusShown2, JSON.stringify(r));
}

console.log('\n8. nothing threw along the way');
ok('no uncaught errors', errors.length === 0, errors.slice(0, 5).join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
