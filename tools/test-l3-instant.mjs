#!/usr/bin/env node
/*
 * Single-site radar answers in under 50 ms once the picture is in hand.
 *
 *     npm i playwright && node tools/test-l3-instant.mjs
 *
 * 50 ms is not a network number. Nothing crosses the internet in 50 ms and
 * comes back with a Level 2 volume; the volume alone is megabytes. So the
 * target is only meaningful for a station and product whose picture the page
 * ALREADY has, and the job is to make that case actually instant instead of
 * secretly redoing all the work.
 *
 * It was redoing all the work. The volume was cached, which saved the
 * download, but the two expensive steps ran again every time: the worker
 * parsing megabytes of sweeps into a value mesh, and _meshToImage drawing a
 * couple of million polygons and encoding a PNG. Clicking back to a station
 * you had looked at ten seconds earlier paid for both again.
 *
 * So the numbers here are measured with the decode stubbed at a deliberately
 * slow fixed cost. That is not cheating: it is how you tell whether the fast
 * path is fast because it SKIPPED the work, rather than because the work
 * happened to be quick on this machine. If the cached click were still
 * decoding, the stub's cost would show up in the measurement.
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

// A map stub that records what is added and removed, so "is the picture on
// screen" is a fact this test can read rather than a screenshot to squint at.
const LEAFLET_STUB = `(() => {
  window.__layers = [];
  const overlay = (url, bounds) => ({ __url: url, __bounds: bounds,
    addTo(m) { window.__layers.push(this); return this; },
    once() { return this; }, on() { return this; }, setUrl() { return this; },
    setOpacity() { return this; }, remove() { return this; } });
  const chain = () => new Proxy(function(){}, {
    get: (t, k) => {
      if (k === 'imageOverlay') return overlay;
      if (k === 'getCenter')  return () => ({ lat: 35.3, lng: -97.3 });
      if (k === 'getZoom')    return () => 7;
      if (k === 'hasLayer')   return (l) => window.__layers.includes(l);
      if (k === 'removeLayer') return (l) => {
        const i = window.__layers.indexOf(l);
        if (i >= 0) window.__layers.splice(i, 1);
      };
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

// Stand-ins for the three costs of a cold load, each announcing itself so the
// test can count how many times each was actually paid.
//
// NOTE, and this one has bitten this repo twice: these are top-level `let`
// bindings in a classic script, so they are NOT properties of window. Setting
// window._meshToImage would create a second name nothing reads, and every
// check below would pass while the page went on calling the real one. A bare
// assignment resolves up the scope chain to the real binding.
const FETCH_MS = 900, DECODE_MS = 700, DRAW_MS = 400;
await page.evaluate(({ f, d, r }) => {
  window.__cost = { fetch: 0, decode: 0, draw: 0 };
  const nap = (ms) => new Promise(res => setTimeout(res, ms));

  _fetchVolumeDirect = async (station) => {
    window.__cost.fetch++;
    await nap(f);
    return new ArrayBuffer(1024);
  };
  _workerProcess = async (buf, layer) => {
    window.__cost.decode++;
    await nap(d);
    return { meshData: new Float32Array(8), bounds: [-100, 33, -95, 38],
             metadata: { timeIso: new Date().toISOString(),
                         availableElevations: [1, 2, 3], elevationNumber: 1 } };
  };
  // Drawing is synchronous in the real page, so the stub is too: a busy loop
  // is the honest stand-in for millions of fill calls. If the cached path
  // touched this, the measurement below could not come out under 50 ms.
  _meshToImage = (result, product, forceBounds) => {
    window.__cost.draw++;
    const until = Date.now() + r;
    while (Date.now() < until) { /* burn, exactly as the real one does */ }
    return { url: 'data:image/png;base64,iVBORw0KGgo=', canvas: null,
             bounds: forceBounds || result.bounds,
             leafletBounds: [[33, -100], [38, -95]],
             timeIso: result.metadata.timeIso };
  };
  _l2LoopBuild = async () => {};        // the history is not what is timed
  _meshStableBox = (res) => res.bounds;
}, { f: FETCH_MS, d: DECODE_MS, r: DRAW_MS });

console.log('\n1. the picture cache exists and is bounded');
ok('no uncaught errors while starting', errors.length === 0, errors[0]);
const has = await page.evaluate(() => ({
  put: typeof _l3PicPut === 'function',
  get: typeof _l3PicGet === 'function',
  attach: typeof _l3Attach === 'function',
  warm: typeof _rsWarmSite === 'function',
  max: typeof L3_PIC_MAX === 'number' ? L3_PIC_MAX : null,
  fresh: typeof L3_PIC_FRESH_MS === 'number' ? L3_PIC_FRESH_MS : null,
}));
ok('there is a finished-picture cache', has.put && has.get && has.attach);
ok('with a warm path for single-site data', has.warm);
ok('bounded by count, so it cannot grow without limit',
   has.max > 0 && has.max <= 12, has.max);
ok('and a freshness window of about one volume',
   has.fresh >= 60000 && has.fresh <= 360000, has.fresh);

console.log('\n2. the first load pays for everything, as it must');
{
  const r = await page.evaluate(async () => {
    window.__cost = { fetch: 0, decode: 0, draw: 0 };
    _l3Pic.clear();
    _l2VolCache = { station: null, at: 0, buf: null };
    const t0 = performance.now();
    await loadL3Data('ref', 'ktlx');
    return { ms: Math.round(performance.now() - t0),
             cost: window.__cost, layers: window.__layers.length,
             station: _l3Station, product: _l3Product };
  });
  ok('the radar is on the map', r.layers === 1, r.layers);
  ok('it is the station and product asked for',
     r.station === 'ktlx' && r.product === 'ref', r.station + '/' + r.product);
  ok('it fetched, decoded and drew exactly once each',
     r.cost.fetch === 1 && r.cost.decode === 1 && r.cost.draw === 1,
     JSON.stringify(r.cost));
  ok(`a cold load costs ${r.ms} ms, which is the network and nothing to be done`,
     r.ms >= FETCH_MS, r.ms + ' ms');
}

console.log('\n3. going back to it answers in under 50 ms');
{
  const r = await page.evaluate(async () => {
    // Move away first, so this is a real switch back rather than a no-op.
    await loadL3Data('vel', 'ktlx');
    window.__cost = { fetch: 0, decode: 0, draw: 0 };
    const before = window.__layers.length;
    const t0 = performance.now();
    await loadL3Data('ref', 'ktlx');
    const ms = performance.now() - t0;
    return { ms: Math.round(ms * 100) / 100, cost: window.__cost,
             before, layers: window.__layers.length,
             product: _l3Product, station: _l3Station };
  });
  // The measurement that the whole change is for.
  ok(`it answered in ${r.ms} ms, under fifty`, r.ms < 50, r.ms + ' ms');
  ok('nothing was decoded again', r.cost.decode === 0, JSON.stringify(r.cost));
  ok('nothing was drawn again', r.cost.draw === 0, JSON.stringify(r.cost));
  ok('nothing was fetched again', r.cost.fetch === 0, JSON.stringify(r.cost));
  ok('the right product is showing', r.product === 'ref', r.product);
  // One overlay in, one overlay out. A leak here is the iOS crash again.
  ok('and exactly one radar layer is on the map, not two',
     r.layers === 1, r.layers);
}

console.log('\n4. the map is never blank during a cold switch');
{
  const r = await page.evaluate(async () => {
    _l3Pic.clear();
    _l2VolCache = { station: null, at: 0, buf: null };
    let blankSamples = 0, samples = 0;
    const poll = setInterval(() => {
      samples++;
      if (window.__layers.length === 0) blankSamples++;
    }, 20);
    await loadL3Data('ref', 'kfws');
    clearInterval(poll);
    return { blankSamples, samples, layers: window.__layers.length };
  });
  ok('the previous radar stayed up for the whole switch',
     r.blankSamples === 0, r.blankSamples + ' blank of ' + r.samples);
  ok('and the new one replaced it', r.layers === 1, r.layers);
}

console.log('\n5. hovering a station decodes it before the click');
{
  const r = await page.evaluate(async () => {
    _l3Pic.clear();
    _l2VolCache = { station: null, at: 0, buf: null };
    _radarSource = 'l2';
    _l3Product = 'ref';
    _rsWarmSite('kama');
    // Give the warm time to finish its stubbed fetch and decode.
    for (let i = 0; i < 200; i++) {
      if (_l3PicGet('kama', 'ref', _l2Tilt)) break;
      await new Promise(res => setTimeout(res, 25));
    }
    const warmed = !!_l3PicGet('kama', 'ref', _l2Tilt);
    const drawnByWarm = window.__layers.length;
    window.__cost = { fetch: 0, decode: 0, draw: 0 };
    const t0 = performance.now();
    await loadL3Data('ref', 'kama');
    return { warmed, drawnByWarm, ms: Math.round((performance.now() - t0) * 100) / 100,
             cost: window.__cost, station: _l3Station };
  });
  ok('the hover put a finished picture in the cache', r.warmed);
  // A guess must never move the screen. The station under the pointer is not
  // the station that was asked for.
  ok('and drew nothing, because a hover is not a choice',
     r.drawnByWarm === 1, r.drawnByWarm);
  ok(`so the click that follows took ${r.ms} ms`, r.ms < 50, r.ms + ' ms');
  ok('paying for none of the work again',
     r.cost.decode === 0 && r.cost.draw === 0, JSON.stringify(r.cost));
  ok('and it is the hovered station that is showing', r.station === 'kama');
}

console.log('\n6. a stale picture shows at once, then corrects itself');
{
  const r = await page.evaluate(async () => {
    // Age the cached entry past one volume without waiting three minutes.
    const key = _l3PicKey('kama', 'ref', _l2Tilt);
    const e = _l3Pic.get(key);
    e.at = Date.now() - (L3_PIC_FRESH_MS + 1000);
    await loadL3Data('vel', 'kama');
    window.__cost = { fetch: 0, decode: 0, draw: 0 };
    const t0 = performance.now();
    await loadL3Data('ref', 'kama');
    const ms = Math.round((performance.now() - t0) * 100) / 100;
    const costAtPaint = JSON.parse(JSON.stringify(window.__cost));
    // The refresh runs behind the picture already on screen.
    for (let i = 0; i < 200; i++) {
      if (window.__cost.decode > 0) break;
      await new Promise(res => setTimeout(res, 25));
    }
    return { ms, costAtPaint, after: window.__cost, layers: window.__layers.length };
  });
  ok(`the old picture went up in ${r.ms} ms rather than making you wait`,
     r.ms < 50, r.ms + ' ms');
  ok('with nothing decoded to show it',
     r.costAtPaint.decode === 0, JSON.stringify(r.costAtPaint));
  ok('and a fresh one was fetched behind it',
     r.after.decode >= 1, JSON.stringify(r.after));
  ok('still one layer on the map after the swap', r.layers === 1, r.layers);
}

console.log('\n7. the cache is dropped when the colours change');
{
  // Every cached picture was painted under the old palette, so all of them
  // are wrong the moment it changes. Not clearing them would make a colour
  // change look like it had not applied until you clicked away and back.
  //
  // The one exception is deliberate: the picture ON SCREEN is repainted from
  // its mesh straight away, and that repaint is banked like any other. So the
  // correct end state is one entry, the fresh one, not zero.
  const r = await page.evaluate(async () => {
    _l3Pic.clear();
    for (const s of ['ktlx', 'kfws', 'kama']) {
      _l2VolCache = { station: null, at: 0, buf: null };
      await loadL3Data('ref', s);
    }
    const before = _l3Pic.size;
    const shown = _l3Station;
    window.__cost = { fetch: 0, decode: 0, draw: 0 };
    _radarFxApply();
    return { before, after: _l3Pic.size, shown,
             stillThere: !!_l3PicGet(shown, 'ref', _l2Tilt),
             cost: window.__cost };
  });
  ok('three stations were cached', r.before === 3, r.before);
  ok('a palette change drops the stale ones', r.after === 1, r.after);
  ok('the one on screen was repainted rather than dropped', r.stillThere);
  ok('and repainting it downloaded nothing',
     r.cost.fetch === 0, JSON.stringify(r.cost));
}

console.log('\n8. the cache cannot grow without limit');
{
  const r = await page.evaluate(async () => {
    _l3Pic.clear();
    const sites = ['ktlx', 'kfws', 'kama', 'klbb', 'kmaf', 'kict', 'kgld',
                   'kbmx', 'kdyx', 'kewx'];
    for (const s of sites) {
      _l2VolCache = { station: null, at: 0, buf: null };
      await loadL3Data('ref', s);
    }
    return { size: _l3Pic.size, max: L3_PIC_MAX,
             newestKept: !!_l3PicGet('kewx', 'ref', _l2Tilt),
             oldestDropped: !_l3PicGet('ktlx', 'ref', _l2Tilt) };
  });
  ok('ten stations do not make ten entries', r.size <= r.max,
     r.size + ' of ' + r.max);
  ok('the most recent is the one kept', r.newestKept);
  ok('and the least recent is the one dropped', r.oldestDropped);
}

console.log('\n9. nothing threw along the way');
ok('no uncaught errors at all', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
