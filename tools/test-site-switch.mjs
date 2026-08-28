#!/usr/bin/env node
/*
 * Clicking a radar station answers fast, and clicking six in a row still does.
 *
 *     npm i playwright && node tools/test-site-switch.mjs
 *
 * Four things made switching stations feel slow, and only one of them was the
 * network being slow:
 *
 *   1. the old picture was removed at the top, so the map was BLANK for the
 *      whole lookup. Nothing was faster if it stayed painted; it just felt
 *      like nothing was happening
 *   2. nothing was cancelled, and every station's lookup goes to the same
 *      host. A browser allows about six connections to one host, so the
 *      seventh click queued behind six answers nobody wanted. That is the
 *      shape of "switching quickly is not flawless": it gets WORSE the
 *      faster you click
 *   3. nothing was remembered, so going back to a station asked again for an
 *      answer that changes once every five minutes
 *   4. all fifteen frames were built at once, so the one frame on screen
 *      competed with fourteen nobody was looking at
 *
 * Measured, not assumed. The lookup is stubbed at a fixed, deliberately nasty
 * latency so the numbers mean the page's behaviour rather than the weather of
 * the day: how long until something is drawn, how many requests are left in
 * flight, and which station wins when six are clicked in a row.
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

const LEAFLET_STUB = `(() => {
  const chain = () => new Proxy(function(){}, {
    get: (t, k) => {
      if (k === 'getCenter')  return () => ({ lat: 35.3, lng: -97.3 });
      if (k === 'getZoom')    return () => 7;
      if (k === 'hasLayer')   return () => false;
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

// A stand-in for the scan-times lookup: always slow, always honest about
// whether it was cancelled. 5 seconds is longer than the draw budget on
// purpose, because the point is what happens while the network is not
// answering yet.
const LOOKUP_MS = 5000;
await page.evaluate((ms) => {
  window.__lookups = [];
  window.__realFetchRef = _fetchRefTimestamps;
  _fetchRefTimestamps = (station, signal) => {
    const rec = { station, at: Date.now(), done: false, aborted: false };
    window.__lookups.push(rec);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        rec.done = true;
        const out = [];
        const now = Date.now();
        for (let i = 11; i >= 0; i--) {
          const d = new Date(now - i * 300000);
          out.push({ iso: d.toISOString().slice(0, 19) + 'Z',
                     time: d.getTime() / 1000, date: d, real: true });
        }
        resolve(out);
      }, ms);
      if (signal) signal.addEventListener('abort', () => {
        clearTimeout(t); rec.aborted = true;
        reject(new DOMException('aborted', 'AbortError'));
      }, { once: true });
    });
  };
  // Count the frames drawn without needing a real map.
  window.__drawn = () => (_refSitePool || []).filter(Boolean).length;
}, LOOKUP_MS);

console.log('\n1. the page starts, and the switch controller is there');
ok('no uncaught errors while starting', errors.length === 0, errors[0]);
const has = await page.evaluate(() => ({
  begin: typeof _rsBegin === 'function',
  warm: typeof _rsWarm === 'function',
  est: typeof _rsEstimatedFrames === 'function',
  budget: typeof RS_DRAW_BUDGET_MS === 'number' ? RS_DRAW_BUDGET_MS : null,
  ttl: typeof RS_CAPS_TTL_MS === 'number' ? RS_CAPS_TTL_MS : null,
}));
ok('there is a switch controller', has.begin && has.warm && has.est);
ok('with a draw budget under two seconds',
   has.budget > 0 && has.budget <= 1500, has.budget);
ok('and a cache that outlives a few clicks', has.ttl >= 30000, has.ttl);

console.log('\n2. something is drawn well inside two seconds, on a slow lookup');
{
  const r = await page.evaluate(async () => {
    const t0 = performance.now();
    _loadSingleSiteRef('ktlx');          // deliberately not awaited
    // Poll for the first frame, the way a person watches the screen.
    for (let i = 0; i < 200; i++) {
      if (window.__drawn() > 0) break;
      await new Promise(r => setTimeout(r, 25));
    }
    return { ms: Math.round(performance.now() - t0),
             drawn: window.__drawn(),
             station: _refStation,
             frames: (_refSiteFrames || []).length,
             estimated: !!((_refSiteFrames || [])[0] || {}).est };
  });
  ok('a frame is on the map', r.drawn > 0, JSON.stringify(r));
  // The whole point of the budget: the lookup takes five seconds here and the
  // picture must not wait for it.
  ok(`and it took ${r.ms} ms, under two seconds`, r.ms < 2000, r.ms + ' ms');
  ok('the station is the one that was clicked', r.station === 'ktlx', r.station);
  ok('drawn from the estimated times, since the real ones are still coming',
     r.estimated === true, JSON.stringify(r.frames));
  // Only the newest frame at first. Fifteen at once is fourteen requests
  // competing with the one being looked at.
  ok('and only the newest frame is built first, not the whole loop',
     r.drawn === 1, r.drawn);
}

console.log('\n3. the real times replace the estimate when they arrive');
{
  const r = await page.evaluate(async () => {
    for (let i = 0; i < 300; i++) {
      if (((_refSiteFrames || [])[0] || {}).real) break;
      await new Promise(r => setTimeout(r, 50));
    }
    // The history is built deliberately a moment AFTER the newest frame, so
    // the one tile that matters is not queued behind eleven that do not.
    // Reading the count the instant the real times land measures the gap
    // rather than the result.
    for (let i = 0; i < 40; i++) {
      if (window.__drawn() > 1) break;
      await new Promise(r => setTimeout(r, 25));
    }
    return { real: !!((_refSiteFrames || [])[0] || {}).real,
             frames: (_refSiteFrames || []).length,
             drawn: window.__drawn() };
  });
  ok('the estimate is replaced by the real scan times', r.real, JSON.stringify(r));
  ok('and the rest of the loop is built behind it', r.drawn > 1, r.drawn);
}

console.log('\n4. six clicks in a row: the last one wins and the rest are cancelled');
{
  const r = await page.evaluate(async () => {
    window.__lookups = [];
    const sites = ['kfws', 'kdyx', 'kama', 'klbb', 'kmaf', 'kict'];
    for (const s of sites) { _loadSingleSiteRef(s); await new Promise(r => setTimeout(r, 40)); }
    await new Promise(r => setTimeout(r, 200));
    const l = window.__lookups;
    return {
      started: l.length,
      aborted: l.filter(x => x.aborted).length,
      live: l.filter(x => !x.aborted && !x.done).length,
      station: _refStation,
      want: sites[sites.length - 1],
    };
  });
  ok('the station shown is the last one clicked', r.station === r.want,
     `${r.station} vs ${r.want}`);
  // This is the one that matters. Without cancellation all six sit there
  // holding connections to the same host, and the next click waits for them.
  ok('exactly one lookup is still in flight, not six',
     r.live === 1, JSON.stringify(r));
  ok('the five superseded ones were cancelled',
     r.aborted === r.started - 1, JSON.stringify(r));
}

console.log('\n5. going back to a station it already knows is instant');
{
  const r = await page.evaluate(async () => {
    // Let the last one settle so its times are cached.
    for (let i = 0; i < 300; i++) {
      if (((_refSiteFrames || [])[0] || {}).real) break;
      await new Promise(r => setTimeout(r, 50));
    }
    const cachedFor = _refStation;
    window.__lookups = [];
    const t0 = performance.now();
    await _loadSingleSiteRef(cachedFor);
    return { ms: Math.round(performance.now() - t0),
             asked: window.__lookups.length,
             real: !!((_refSiteFrames || [])[0] || {}).real };
  });
  ok('it asks the network nothing at all', r.asked === 0, r.asked);
  ok(`and is done in ${r.ms} ms`, r.ms < 300, r.ms + ' ms');
  ok('with the real scan times, not the estimate', r.real);
}

console.log('\n6. hovering a station warms it, so the click is already answered');
{
  const r = await page.evaluate(async () => {
    _rsCaps.clear();
    window.__lookups = [];
    _rsWarm('kgld');
    const started = window.__lookups.length;
    // Warming uses its own timeout and is never cancelled by a click.
    _loadSingleSiteRef('kbmx');
    await new Promise(r => setTimeout(r, 120));
    const warm = window.__lookups.find(x => x.station === 'kgld');
    return { started, warmAborted: !!(warm && warm.aborted) };
  });
  ok('hovering starts the lookup before the click', r.started === 1, r.started);
  ok('and a click elsewhere does not cancel it, since nothing asked for it',
     r.warmAborted === false);
}

console.log('\n7. the previous picture is not taken down before there is a new one');
{
  const src = await page.evaluate(() => String(_loadSingleSiteRef));
  ok('the old pool is kept, not cleared at the top',
     /const oldPool = _refSitePool\.slice\(\)/.test(src));
  ok('it is dropped when the new frame loads',
     /newest\.once\('load', dropOld\)/.test(src));
  ok('and on a timer too, so a dead station cannot leave the wrong radar up',
     /handoverTimer/.test(src) && /RS_HANDOVER_MS/.test(src));
}

console.log('\n8. switching product cancels the volume the last one was fetching');
{
  const r = await page.evaluate(() => {
    const src = String(loadL3Data) + String(_loadL3DataInner);
    return {
      begins: /_rsBegin\(\)/.test(src),
      guards: (src.match(/stale\(\)/g) || []).length,
      signal: /_rsSignal\(signal, 30000\)/.test(src),
      retryCarries: /_loadL3DataInner\(product, station, true, gen, signal\)/.test(src),
    };
  });
  ok('a product switch starts a new generation', r.begins);
  ok('a superseded volume is discarded rather than painted',
     r.guards >= 2, r.guards);
  ok('and the worker fetch is cancelled with it', r.signal);
  ok('the one-back retry stays in the same generation', r.retryCarries);
}

console.log('\n9. nothing threw along the way');
ok('no uncaught errors at all', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
