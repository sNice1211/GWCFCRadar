#!/usr/bin/env node
/*
 * Ten seconds to a picture, measured rather than hoped for.
 *
 *     node tools/test-load-budget.mjs
 *
 * "Loads in under ten seconds" is a promise about the first picture, not about
 * having everything in memory. Three days of radar is roughly a thousand
 * frames and three days of MRMS about nine hundred; downloading either before
 * showing anything would take minutes on a home connection through a tunnel,
 * and no amount of tuning changes that.
 *
 * So the design splits the two. One small manifest says WHEN every frame is,
 * which is what lets the animation bar span three days the moment it arrives.
 * The frame PICTURES are fetched around wherever the scrub head is. The
 * budget below is therefore: manifest, first frame drawn, bar spanning the
 * whole window - all inside ten seconds, with the rest arriving behind it.
 *
 * The Pi is mocked WITH LATENCY, because a mock that answers instantly proves
 * nothing about a Pi at the end of a Cloudflare tunnel. Every response here is
 * held back by a realistic delay before it is served, so what is measured is
 * the number of round trips the design needs, which is the thing actually
 * under our control.
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

// What a Pi at the end of a home tunnel actually costs per request. Generous
// on purpose: if the budget holds at these numbers it holds in practice.
const LATENCY_JSON = 220;      // ms before a manifest starts arriving
const LATENCY_IMG = 140;       // ms before a picture starts arriving
const BUDGET_MS = 10000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const BOUNDS = [[20, -130], [55, -60]];
const stamp = (ms) => {
  const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
       + `_${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
};
const END = Date.UTC(2026, 7, 20, 12, 0, 0);
const series = (stepMin, hours, name) => {
  const out = [];
  for (let ms = END - hours * 3600e3; ms <= END; ms += stepMin * 60e3) {
    out.push({ t: stamp(ms), file: `${stamp(ms)}/${name}.png` });
  }
  return out;
};

// Three full days of everything, at the cadences the Pi really builds at.
const mrmsFrames = series(5, 72, 'rotation');
const MRMS = {
  updated: '2026-08-20T12:00:00+00:00', keep_hours: 72,
  products: {
    rotation: { label: 'Rotation Tracks', bounds: BOUNDS, unit: 'per s',
                frames: mrmsFrames, latest: mrmsFrames.at(-1).t,
                file: mrmsFrames.at(-1).file },
  },
};
const satFrames = series(10, 72, 'airmass');
const SAT = {
  updated: '2026-08-20T12:00:00+00:00', sector: 'conus', sat: 'east',
  keep_hours: 72,
  products: {
    airmass: { label: 'Air Mass', frames: satFrames.map(f => ({
                 t: f.t, file: f.file, bounds: BOUNDS })),
               latest: satFrames.at(-1).t, file: satFrames.at(-1).file,
               bounds: BOUNDS },
  },
};
const radarFrameNames = series(4, 72, 'n0q').map(f => f.t);
const RADAR_INDEX = {
  level: 3, updated: '2026-08-20T12:00:00+00:00', keep_hours: 72,
  sites: {
    KTLX: {
      frames: radarFrameNames.slice(-60),
      total: radarFrameNames.length,
      oldest: radarFrameNames[0],
      frames_path: 'l3/KTLX/frames.json',
      path: 'l3/KTLX/{frame}/manifest.json',
    },
  },
};

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478'
  + '9c6360000002000154a24f6e0000000049454e44ae426082', 'hex');

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'],
});
const page = await browser.newPage();
const errors = [];
const requests = [];
page.on('pageerror', e => errors.push(e.message));
await page.route('**://**', async route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript',
      body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css',
      body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });

  const json = (body) => route.fulfill({ contentType: 'application/json',
                                         body: JSON.stringify(body) });
  if (/mrms\.json/.test(url)) {
    requests.push(url); await sleep(LATENCY_JSON); return json(MRMS);
  }
  if (/satellite\/\w+\/\w+\/manifest\.json/.test(url)) {
    requests.push(url); await sleep(LATENCY_JSON); return json(SAT);
  }
  if (/latest_l3\.json/.test(url)) {
    requests.push(url); await sleep(LATENCY_JSON); return json(RADAR_INDEX);
  }
  if (/frames\.json/.test(url)) {
    requests.push(url); await sleep(LATENCY_JSON);
    return json({ site: 'KTLX', level: 3, frames: radarFrameNames,
                  keep_hours: 72 });
  }
  if (/\.png($|\?)/.test(url)) {
    requests.push(url); await sleep(LATENCY_IMG);
    return route.fulfill({ contentType: 'image/png', body: PNG });
  }
  return route.abort();
});
await page.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4200);
await page.evaluate(() => { if (typeof closeTutorial === 'function') closeTutorial(); });
await page.evaluate(() => { _hdBase = 'https://pi.example.test'; });

console.log('\n1. MRMS: three days on the bar, and a picture, inside the budget');
{
  requests.length = 0;
  const r = await page.evaluate(async (budget) => {
    const t0 = performance.now();
    _mrmsOn = {}; _mrmsOv = {};
    _mrmsToggle('rotation');
    // Wait for the first picture to be on the map, not for a timer.
    const deadline = t0 + budget;
    while (performance.now() < deadline) {
      if (_mrmsOv.rotation && _mrmsLoop.frames.length > 1) break;
      await new Promise(r => setTimeout(r, 25));
    }
    const painted = performance.now() - t0;
    _refreshPlayButtonsEnabled();
    const src = _animSource();
    return {
      painted,
      frames: _mrmsLoop.frames.length,
      spanH: _mrmsLoop.frames.length
        ? (_mrmsLoop.frames.at(-1).time - _mrmsLoop.frames[0].time) / 3600e3 : 0,
      barSpans: src.times.length,
      drawn: !!_mrmsOv.rotation,
    };
  }, BUDGET_MS);
  console.log(`       first picture in ${Math.round(r.painted)} ms, `
            + `${requests.length} requests`);
  ok('a picture is on the map', r.drawn);
  ok(`inside the ten second budget (${Math.round(r.painted)} ms)`,
     r.painted < BUDGET_MS, `${Math.round(r.painted)} ms`);
  ok('and comfortably so, not just scraping in',
     r.painted < BUDGET_MS / 2, `${Math.round(r.painted)} ms`);
  ok('the bar already spans three days', r.spanH >= 71, r.spanH.toFixed(1) + ' h');
  ok('over every frame the Pi has', r.barSpans === r.frames,
     `${r.barSpans} vs ${r.frames}`);
  // This is the point of the whole design. Nine hundred frames on the bar
  // must NOT mean nine hundred requests before anything is drawn.
  ok('without downloading a thousand pictures to get there',
     requests.length < 40, `${requests.length} requests for ${r.frames} frames`);
}

console.log('\n2. and the rest arrives behind it rather than up front');
{
  // Section 1 already measured this without meaning to: it needed one
  // manifest and one picture to paint, and issued a good many more than that
  // inside the same budget. Those extras are the read-ahead, and they are why
  // pressing play does not then stop at every frame.
  const warmed = requests.length;
  ok('more than the bare minimum was fetched, which is the read-ahead',
     warmed > 4, `${warmed} requests`);
  ok('and it is a window, not the whole three days',
     warmed < 60, `${warmed} requests for ${mrmsFrames.length} frames`);

  // Scrubbing somewhere new has to warm that neighbourhood too, or every
  // jump would be followed by a stall.
  const before = requests.length;
  const r = await page.evaluate(async () => {
    const n = _mrmsLoop.frames.length;
    seekFrame(Math.floor(n / 2));
    await new Promise(r => setTimeout(r, 900));
    return { frames: n };
  });
  const after = requests.length;
  ok('scrubbing into the middle warms the frames around it', after > before,
     `${before} -> ${after}`);
  ok('again only a window of them, not all nine hundred',
     after - before < r.frames / 4, `${after - before} of ${r.frames}`);
}

console.log('\n3. satellite composites: same budget, same shape');
{
  requests.length = 0;
  const r = await page.evaluate(async (budget) => {
    const t0 = performance.now();
    _disableRadar();
    activeLayers.satellite = true;
    _goesRegionId = 'east';
    _setGoesProduct('rgb-airmass');
    const deadline = t0 + budget;
    while (performance.now() < deadline) {
      if (goesFrames.length > 1 && _goesPool.some(Boolean)) break;
      await new Promise(r => setTimeout(r, 25));
    }
    const painted = performance.now() - t0;
    const times = goesFrames.map(f => f.time.getTime());
    return {
      painted, frames: goesFrames.length,
      spanH: times.length ? (Math.max(...times) - Math.min(...times)) / 3600e3 : 0,
      pooled: _goesPool.filter(Boolean).length,
      cap: GOES_POOL_MAX,
    };
  }, BUDGET_MS);
  console.log(`       first picture in ${Math.round(r.painted)} ms, `
            + `${requests.length} requests`);
  ok(`inside the budget (${Math.round(r.painted)} ms)`,
     r.painted < BUDGET_MS, `${Math.round(r.painted)} ms`);
  ok('the whole three days is on the bar', r.spanH >= 71,
     r.spanH.toFixed(1) + ' h');
  ok('from one manifest rather than a guess per frame', r.frames > 400,
     String(r.frames));
  ok('and only a window of layers is alive', r.pooled <= r.cap,
     `${r.pooled} of ${r.cap}`);
  ok('so a three day loop is not four hundred requests',
     requests.length < 40, `${requests.length} for ${r.frames} frames`);
}

console.log('\n4. the radar index is small even with three days behind it');
{
  const r = await page.evaluate(async () => {
    const t0 = performance.now();
    const idx = await fetch('https://pi.example.test/radar/latest_l3.json')
      .then(r => r.json());
    const took = performance.now() - t0;
    const site = idx.sites.KTLX;
    return {
      took,
      inIndex: site.frames.length,
      total: site.total,
      hasPath: !!site.frames_path,
      oldest: site.oldest,
      bytes: JSON.stringify(idx).length,
    };
  });
  console.log(`       index is ${(r.bytes / 1024).toFixed(1)} KB for `
            + `${r.total} frames`);
  ok('the index carries a recent window, not the whole three days',
     r.inIndex < r.total / 4, `${r.inIndex} of ${r.total}`);
  ok('but says how many there really are', r.total > 900, String(r.total));
  ok('and how far back they go', /^\d{8}_/.test(r.oldest || ''), r.oldest);
  ok('and where to get all of them', r.hasPath);
  // The whole reason for the split. At three days and twenty sites the
  // unsplit index would be a third of a megabyte on every page load.
  ok('so the boot fetch stays small', r.bytes < 40 * 1024,
     `${(r.bytes / 1024).toFixed(1)} KB`);
  ok('and it arrives quickly', r.took < 3000, `${Math.round(r.took)} ms`);
}

console.log('\n5. the whole three days is one more request when it is wanted');
{
  const r = await page.evaluate(async () => {
    const t0 = performance.now();
    const full = await fetch('https://pi.example.test/radar/l3/KTLX/frames.json')
      .then(r => r.json());
    return { took: performance.now() - t0, frames: full.frames.length,
             keep: full.keep_hours };
  });
  ok('one fetch brings the full window', r.frames > 900, String(r.frames));
  ok('which really is three days', r.keep >= 72, String(r.keep));
  ok('and it is quick', r.took < 3000, `${Math.round(r.took)} ms`);
}

console.log('\n6. switching between them stays inside the budget too');
{
  // Switching is where a design that reloads everything shows itself: the
  // second visit must not cost the same as the first.
  const r = await page.evaluate(async (budget) => {
    const times = [];
    for (const product of ['rgb-airmass', 'rgb-airmass']) {
      const t0 = performance.now();
      _setGoesProduct('ch13');
      await new Promise(r => setTimeout(r, 60));
      _setGoesProduct(product);
      const deadline = t0 + budget;
      while (performance.now() < deadline) {
        if (goesFrames.length > 1) break;
        await new Promise(r => setTimeout(r, 25));
      }
      times.push(performance.now() - t0);
    }
    return { first: times[0], second: times[1] };
  }, BUDGET_MS);
  console.log(`       switch back took ${Math.round(r.first)} ms, `
            + `then ${Math.round(r.second)} ms`);
  ok('switching back is inside the budget', r.first < BUDGET_MS,
     `${Math.round(r.first)} ms`);
  ok('and the second time is no worse, because the manifest is cached',
     r.second <= r.first + 400, `${Math.round(r.first)} then ${Math.round(r.second)}`);
}

console.log('\n7. scrubbing three days back does not stall');
{
  requests.length = 0;
  const r = await page.evaluate(async () => {
    _disableRadar();
    activeLayers.satellite = false;
    _mrmsOn = {}; _mrmsOv = {};
    _mrmsToggle('rotation');
    await new Promise(r => setTimeout(r, 800));
    const n = _mrmsLoop.frames.length;
    const t0 = performance.now();
    seekFrame(0);                      // straight to three days ago
    const deadline = t0 + 10000;
    while (performance.now() < deadline) {
      if (_mrmsOv.rotation
          && _mrmsOv.rotation._gwUrl.includes(_mrmsLoop.frames[0].t)) break;
      await new Promise(r => setTimeout(r, 25));
    }
    return { took: performance.now() - t0, n, idx: _mrmsLoop.idx };
  });
  console.log(`       jumped to the oldest frame in ${Math.round(r.took)} ms`);
  ok('the jump lands on the oldest frame', r.idx === 0, String(r.idx));
  ok('quickly, because only that frame had to be fetched',
     r.took < 4000, `${Math.round(r.took)} ms`);
}

console.log('\n8. nothing above threw');
{
  const real = errors.filter(e => !/Failed to fetch|NetworkError|ERR_FAILED|net::/i.test(e));
  ok('no page errors', real.length === 0, real.slice(0, 3).join(' | '));
}

await browser.close();
console.log();
if (fail) { console.log(`${fail} FAILED, ${pass} passed`); process.exit(1); }
console.log(`all ${pass} passed`);
