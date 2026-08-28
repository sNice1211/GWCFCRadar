#!/usr/bin/env node
/*
 * Two reported bugs, both measured rather than eyeballed.
 *
 *     npm i playwright && node tools/test-zoom-and-ai.mjs
 *
 * 1. THE TRACKPAD BARELY ZOOMED.
 *
 * Not a matter of taste, arithmetic. The map is built with zoomSnap: 0 so it
 * can sit between whole levels. Leaflet's own wheel handler computes its step
 * from a saturating curve and then, when zoomSnap is nonzero, rounds it UP to
 * the nearest snap. That rounding is what normally makes a wheel usable: any
 * flick clears a whole level because ceil() drags it to 1. With snap off there
 * is no rounding, and the raw curve is brutal at the small end, which is
 * exactly where a trackpad lives: a stream of two to four pixel deltas, chopped
 * into 40 ms buckets, each bucket run through the curve on its own.
 *
 * So the test scrolls a measured distance and checks how far the map actually
 * moved. A gesture of about a screen's worth of scrolling has to cover real
 * ground, and twice the scroll has to zoom about twice as far, because a hand
 * cannot predict a curve.
 *
 * 2. THE ASSISTANT SAID THERE WERE NO SEVERE THUNDERSTORM WARNINGS.
 *
 * There were. Four separate faults, and the worst is the last: on any failure
 * the fetch returned null, and the prompt rendered null as "none", so a
 * timeout was handed to the model as the positive fact that nothing was
 * active. That is how you get a confident, specific, completely wrong answer.
 * These checks feed the builder known payloads, including a failing one, and
 * read what it actually says.
 */

import { readdirSync, existsSync } from 'fs';
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

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  try {
    for (const d of readdirSync('/opt/pw-browsers')) {
      if (!d.startsWith('chromium-')) continue;
      const p = join('/opt/pw-browsers', d, 'chrome-linux', 'chrome');
      if (existsSync(p)) return p;
    }
  } catch { /* let Playwright try its own */ }
  return undefined;
}

// A map stub that models zoom for real: a number, a limit, and an anchor.
// Enough to measure what the wheel handler asks for, which is the thing under
// test. The real Leaflet is not needed to check arithmetic.
const LEAFLET_STUB = `(() => {
  window.__zoom = 5;
  window.__anchors = [];
  const el = () => document.getElementById('map') || document.body;
  const fakeMap = {
    _z: 5,
    getZoom() { return window.__zoom; },
    setZoom(z) { window.__zoom = z; },
    setZoomAround(pt, z) { window.__anchors.push(pt); window.__zoom = z; },
    _limitZoom(z) { return Math.max(2, Math.min(18, z)); },
    getContainer() { return el(); },
    mouseEventToContainerPoint(e) { return { x: e.clientX, y: e.clientY }; },
    scrollWheelZoom: { disable(){}, enable(){}, enabled(){ return false; } },
    getCenter() { return { lat: 35.3, lng: -97.3 }; },
    hasLayer() { return false; },
    getPane() { return document.createElement('div'); },
    createPane() { return document.createElement('div'); },
    // The page binds map events right after initMap. Without these the stub
    // throws on every one of them, which is noise from the stub and not a
    // fault in the page, and it would drown the check that matters.
    on(){ return this; }, off(){ return this; }, once(){ return this; },
    fire(){ return this; }, addLayer(){ return this; }, removeLayer(){ return this; },
    invalidateSize(){ return this; },
    getBounds() { return { getWest:()=>-100, getEast:()=>-95, getNorth:()=>38,
      getSouth:()=>33, contains:()=>true, pad(){ return this; } }; },
    getSize() { return { x: 400, y: 400 }; },
    project() { return { x: 0, y: 0 }; },
    latLngToContainerPoint() { return { x: 200, y: 200 }; },
    containerPointToLatLng() { return { lat: 35.3, lng: -97.3 }; },
    flyTo(){ return this; }, panTo(){ return this; }, setView(){ return this; },
    dragging: { enable(){}, disable(){}, enabled(){ return true; } },
    touchZoom: { enable(){}, disable(){}, enabled(){ return true; } },
    doubleClickZoom: { enable(){}, disable(){}, enabled(){ return true; } },
    attributionControl: { setPrefix(){}, getContainer(){ return document.createElement('div'); } },
  };
  const chain = () => new Proxy(function(){}, {
    get: (t, k) => {
      if (k === 'map') return () => fakeMap;
      if (k === 'then') return undefined;
      return chain();
    },
    apply: () => chain(), construct: () => chain(),
  });
  Object.defineProperty(window, 'L', { value: chain(), writable: true, configurable: true });
  window.__fakeMap = fakeMap;
})();`;

const browser = await chromium.launch({ executablePath: chromePath() });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.addInitScript(LEAFLET_STUB);
await page.route('**://**', (r) =>
  r.request().url().startsWith('file://') ? r.continue() : r.abort());
await page.goto('file://' + join(ROOT, 'index.html'),
                { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);

console.log('\n1. the wheel is handled here, not by Leaflet');
ok('no uncaught errors while starting', errors.length === 0, errors[0]);
const cfg = await page.evaluate(() => ({
  wire: typeof _wireWheelZoom === 'function',
  perZoom: typeof WZ_PX_PER_ZOOM === 'number' ? WZ_PX_PER_ZOOM : null,
  pinch: typeof WZ_PX_PER_ZOOM_PINCH === 'number' ? WZ_PX_PER_ZOOM_PINCH : null,
  maxStep: typeof WZ_MAX_STEP === 'number' ? WZ_MAX_STEP : null,
}));
ok('there is a wheel zoom handler', cfg.wire);
ok('with a sane scroll-to-zoom scale',
   cfg.perZoom >= 40 && cfg.perZoom <= 300, cfg.perZoom);
ok('a pinch covers more ground than a scroll',
   cfg.pinch > 0 && cfg.pinch < cfg.perZoom, cfg.pinch + ' vs ' + cfg.perZoom);
ok('and one event cannot cross the whole scale',
   cfg.maxStep > 0 && cfg.maxStep <= 4, cfg.maxStep);

// Drive the handler directly on a fresh container, so this measures the
// handler and not whatever else the page has bound to the real map div.
const setup = async () => page.evaluate(() => {
  const old = document.getElementById('__wztest');
  if (old) old.remove();
  const d = document.createElement('div');
  d.id = '__wztest';
  d.style.cssText = 'width:400px;height:400px;';
  document.body.appendChild(d);
  window.__fakeMap.getContainer = () => d;
  window.__zoom = 5;
  window.__anchors = [];
  _wireWheelZoom(window.__fakeMap);
  return true;
});

// Send a burst of trackpad-sized events, the way a real two-finger scroll
// arrives: many small pixel deltas rather than one big notch.
const scroll = async (totalPx, perEvent, opts = {}) => page.evaluate(
  ({ totalPx, perEvent, ctrl, mode }) => {
    const d = document.getElementById('__wztest');
    const n = Math.round(Math.abs(totalPx) / perEvent);
    const sign = totalPx < 0 ? -1 : 1;
    for (let i = 0; i < n; i++) {
      d.dispatchEvent(new WheelEvent('wheel', {
        deltaY: sign * perEvent, deltaMode: mode || 0,
        ctrlKey: !!ctrl, clientX: 200, clientY: 200,
        bubbles: true, cancelable: true,
      }));
    }
    return new Promise(res => requestAnimationFrame(() =>
      requestAnimationFrame(() => res(window.__zoom))));
  }, { totalPx, perEvent, ctrl: opts.ctrl, mode: opts.mode });

console.log('\n2. a trackpad gesture actually zooms');
{
  await setup();
  // 360 px of two-finger scroll, in 4 px steps. This is the gesture that used
  // to move the map by a rounding error.
  const z = await scroll(-360, 4);
  const moved = z - 5;
  ok(`360 px of trackpad scroll moved ${moved.toFixed(2)} levels`,
     moved >= 2, moved.toFixed(3));
  ok('and it zoomed IN, since the scroll was upward', moved > 0, moved);
}

console.log('\n3. twice the scroll is about twice the zoom');
{
  await setup();
  const a = (await scroll(-120, 4)) - 5;
  await setup();
  const b = (await scroll(-240, 4)) - 5;
  const ratio = b / a;
  // Linear, not a saturating curve. A hand can predict a straight line.
  ok(`${a.toFixed(2)} then ${b.toFixed(2)} levels, a ratio of ${ratio.toFixed(2)}`,
     ratio > 1.8 && ratio < 2.2, ratio.toFixed(3));
}

console.log('\n4. scrolling the other way zooms out, by the same amount');
{
  await setup();
  const inZ = (await scroll(-240, 4)) - 5;
  await setup();
  const outZ = 5 - (await scroll(240, 4));
  ok('down zooms out', outZ > 0, outZ);
  ok('and in and out are symmetric',
     Math.abs(inZ - outZ) < 0.01, inZ + ' vs ' + outZ);
}

console.log('\n5. a mouse wheel notch is still about one level');
{
  await setup();
  // One notch, as Chrome sends it: a single 100 px event.
  const z = await scroll(-100, 100);
  const moved = z - 5;
  ok(`one notch moved ${moved.toFixed(2)} levels`,
     moved >= 0.6 && moved <= 1.6, moved.toFixed(3));
}

console.log('\n6. a trackpad pinch is quicker than a scroll');
{
  await setup();
  const plain = (await scroll(-120, 4)) - 5;
  await setup();
  const pinch = (await scroll(-120, 4, { ctrl: true })) - 5;
  ok(`the same travel pinched moved ${pinch.toFixed(2)} against ${plain.toFixed(2)}`,
     pinch > plain, pinch + ' vs ' + plain);
}

console.log('\n7. the point under the cursor is what it zooms toward');
{
  await setup();
  await scroll(-120, 4);
  const anchors = await page.evaluate(() => window.__anchors.length);
  ok('it zooms around the cursor rather than the centre', anchors > 0, anchors);
}

console.log('\n8. line-mode and page-mode wheels are understood');
{
  await setup();
  const lines = (await scroll(-9, 3, { mode: 1 })) - 5;   // Firefox sends lines
  ok(`three line-mode notches moved ${lines.toFixed(2)} levels`,
     lines > 0.2, lines.toFixed(3));
}

console.log('\n9. the alert reader tells a failure apart from an empty sky');
{
  const r = await page.evaluate(async () => {
    _alertsLive = { at: 0, ok: false, features: [] };
    const realFetch = window.fetch;
    // A feed that does not answer. This is the case that used to be reported
    // to the model as "none", which is how it confidently said there were no
    // severe thunderstorm warnings anywhere in the country.
    window.fetch = () => Promise.reject(new Error('offline'));
    const failed = await _aiFetchAllAlerts();
    window.fetch = realFetch;
    return { failed };
  });
  ok('a dead feed says FEED ERROR', /FEED ERROR/.test(r.failed), r.failed);
  ok('and says so in words, not by returning nothing',
     /UNKNOWN/i.test(r.failed), r.failed);
  ok('and never claims there are none',
     !/^No active/i.test(r.failed) && !/there are no/i.test(r.failed), r.failed);
}

console.log('\n10. a real feed is counted in full, warnings listed first');
{
  const r = await page.evaluate(async () => {
    // 300 alerts: 2 tornado warnings, 5 severe thunderstorm warnings, and a
    // long tail of marine statements. Under the old code the tail alone
    // would have filled the 100-alert window and the warnings could vanish.
    const feats = [];
    const mk = (event, area) => ({ properties: {
      event, areaDesc: area, expires: new Date(Date.now() + 2400000).toISOString() } });
    for (let i = 0; i < 293; i++) feats.push(mk('Small Craft Advisory', 'Zone ' + i));
    feats.push(mk('Severe Thunderstorm Warning', 'Polk County, FL'));
    feats.push(mk('Severe Thunderstorm Warning', 'Osceola County, FL'));
    feats.push(mk('Severe Thunderstorm Warning', 'Orange County, FL'));
    feats.push(mk('Severe Thunderstorm Warning', 'Lake County, FL'));
    feats.push(mk('Severe Thunderstorm Warning', 'Brevard County, FL'));
    feats.push(mk('Tornado Warning', 'Hardee County, FL'));
    feats.push(mk('Tornado Warning', 'DeSoto County, FL'));
    _alertsLive = { at: Date.now(), ok: true, features: feats };
    const text = await _aiFetchAllAlerts();
    return { text,
      tornadoFirst: text.indexOf('Tornado Warning -') <
                    text.indexOf('Severe Thunderstorm Warning -') };
  });
  ok('the total is the real total, not a page of it',
     /Total active alerts: 300/.test(r.text), r.text.slice(0, 90));
  ok('severe thunderstorm warnings are counted',
     /5x Severe Thunderstorm Warning/.test(r.text), r.text.slice(0, 200));
  ok('and are listed individually, not summarised away',
     (r.text.match(/• Severe Thunderstorm Warning/g) || []).length === 5,
     (r.text.match(/• Severe Thunderstorm Warning/g) || []).length);
  ok('tornado warnings come before them, most dangerous first', r.tornadoFirst);
  // The whole point: the tail must not be able to crowd the warnings out.
  ok('the 293 advisories did not bury the 7 warnings',
     /WARNINGS AND WATCHES IN FORCE \(7 total/.test(r.text), r.text.slice(0, 300));
}

console.log('\n11. an empty feed is reported as empty, and reads differently');
{
  const r = await page.evaluate(async () => {
    _alertsLive = { at: Date.now(), ok: true, features: [] };
    return await _aiFetchAllAlerts();
  });
  ok('zero alerts says the read succeeded', /read successfully/i.test(r), r);
  ok('and is not confusable with a failure', !/FEED ERROR/.test(r), r);
}

console.log('\n12. the prompt refuses to turn a failure into an absence');
{
  const p = await page.evaluate(async () => {
    _alertsLive = { at: 0, ok: false, features: [] };
    const realFetch = window.fetch;
    window.fetch = () => Promise.reject(new Error('offline'));
    const text = await _aiBuildContext(false);
    window.fetch = realFetch;
    return text;
  });
  ok('the prompt names the failure rule', /FEED ERROR/.test(p));
  ok('and states it explicitly, so the model cannot guess wrong',
     /Never turn a failed read into/i.test(p));
  ok('it no longer renders a missing feed as the word none',
     !/=== ACTIVE NWS ALERTS \(nationwide\) ===\s*\nnone/.test(p));
  ok('and tells the model to quote the counts, not the capped list',
     /Counts:/.test(p) && /capped/.test(p));
}

console.log('\n13. the assistant can reach the features it talks about');
{
  const r = await page.evaluate(async () => {
    const src = String(_aiExecuteAction);
    const prompt = await _aiBuildContext(false);
    return {
      // Every action named in the prompt must exist in the executor, or the
      // assistant reports success and nothing happens.
      advertised: ['openLevel2', 'openComposite', 'setOpacity', 'playback',
                   'openSounding', 'openPanel']
        .filter(a => prompt.includes(a) && src.includes("'" + a + "'")),
      dualPol: /correlation coefficient/i.test(prompt),
      noStaleClaim: !/Dual-pol \(ZDR\/KDP\/CC\) is NOT available/.test(prompt),
      liveState: /WHAT THE APP IS SHOWING RIGHT NOW/.test(prompt),
      radarSource: /Radar source:/.test(prompt),
    };
  });
  ok('every new action in the prompt is implemented',
     r.advertised.length === 6, r.advertised.join(','));
  ok('the dual-pol products are offered, since Level 2 has them', r.dualPol);
  ok('and the old line claiming they do not exist is gone', r.noStaleClaim);
  ok('the prompt carries the live app state', r.liveState && r.radarSource);
}

console.log('\n14. the panel actions name functions that exist');
{
  const r = await page.evaluate(() => {
    const names = ['toggleAlertsPanel', 'toggleEASPanel', 'openRunModelsPanel',
                   'openSpaghettiModelsPanel', 'openAiCyclonesPanel',
                   'lqmToggleSettingsPanel', '_expToggle', '_ssStart',
                   'openSounding', 'togglePlay', 'lqmSetRadarOpacity'];
    return names.filter(n => typeof window[n] !== 'function');
  });
  // An action pointing at a function that does not exist is worse than no
  // action: it reports success and does nothing at all.
  ok('none of them are missing', r.length === 0, r.join(','));
}

console.log('\n15. nothing threw along the way');
ok('no uncaught errors at all', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
