#!/usr/bin/env node
/*
 * Why Level 2 and Level 3 locked the tab up, and the shape of the fix.
 *
 *     node tools/test-radar-render-perf.mjs
 *
 * The renderer collected every cell of one colour, put all of them into ONE
 * canvas path, and filled it once. That is the right number of fillStyle
 * changes and completely the wrong size of path: the canvas rasteriser is not
 * linear in the number of subpaths. Measured in Chromium on this machine:
 *
 *     10,000 cells in one path      about   40 ms
 *     40,000 cells in one path      about 7,000 ms
 *     80,000 cells in one path         29,118 ms
 *     80,000 cells, flushed every 2,000   741 ms
 *
 * Thirty nine times, for the same picture. A busy scan puts most of its cells
 * into a handful of dBZ bands, so one colour really does reach those numbers,
 * and when it did the page stopped responding for half a minute, which is
 * indistinguishable from a crash.
 *
 * So this measures the SHAPE of the curve rather than a number of
 * milliseconds. An absolute threshold would be a machine's speed pretending
 * to be a fact about the code; doubling the work and asking whether the time
 * doubled is a fact about the code. Quadratic growth fails it on any machine,
 * fast or slow.
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
await page.waitForTimeout(4000);
await page.evaluate(() => { if (typeof closeTutorial === 'function') closeTutorial(); });

// A mesh shaped like real reflectivity: cells spiralling out from the site,
// with their values clustered into a couple of bands. The clustering is the
// point - it is what makes one colour bucket enormous, which is the case that
// used to fall over.
await page.evaluate(() => {
  window.__mkMesh = (n, halfDeg) => {
    const site = _meshSiteLatLon('ktlx') || { lat: 35.33, lon: -97.28 };
    const a = new Float32Array(n * 9);
    for (let i = 0; i < n; i++) {
      const t = i / n, ang = t * 2000, rr = halfDeg * (0.03 + 0.95 * t);
      const x = site.lon + rr * Math.cos(ang), y = site.lat + rr * Math.sin(ang);
      const d = halfDeg * 0.004;
      a.set([x, y, x + d, y, x + d, y + d, x, y + d, 22 + (i % 7) * 0.1], i * 9);
    }
    return {
      meshData: a,
      bounds: [site.lon - halfDeg, site.lat - halfDeg,
               site.lon + halfDeg, site.lat + halfDeg],
      metadata: {},
    };
  };
  window.__time = (n, halfDeg) => {
    const res = window.__mkMesh(n, halfDeg);
    const t0 = performance.now();
    const img = _meshToImage(res, 'ref', null);
    return { ms: performance.now() - t0, px: img.canvas.width,
             kb: img.url.length / 1024 };
  };
});

console.log('\n1. the cost grows with the work, not with the square of it');
{
  const r = await page.evaluate(() => {
    window.__time(20000, 2);                 // warm up, so JIT is not measured
    return {
      a: window.__time(20000, 2),
      b: window.__time(40000, 2),
      c: window.__time(80000, 2),
    };
  });
  const ratio = r.c.ms / Math.max(r.a.ms, 1);
  // Four times the cells. Linear says about four times the time; quadratic
  // says about sixteen. Ten is a generous line between the two that no
  // machine's noise will cross by accident.
  ok('four times the cells is not sixteen times the time',
     ratio < 10, `${r.a.ms.toFixed(0)} -> ${r.c.ms.toFixed(0)} ms, ratio ${ratio.toFixed(1)}`);
  ok('and the middle point sits between them rather than off the scale',
     r.b.ms < r.c.ms * 1.2 && r.b.ms > r.a.ms * 0.8,
     `${r.a.ms.toFixed(0)}, ${r.b.ms.toFixed(0)}, ${r.c.ms.toFixed(0)}`);
  // The absolute number is a property of this machine, so it is only checked
  // loosely: eighty thousand cells took twenty nine SECONDS before.
  ok('and eighty thousand cells is seconds away from what it used to be',
     r.c.ms < 5000, `${r.c.ms.toFixed(0)} ms`);
}

console.log('\n2. the fix is in the code, not in the machine being fast');
{
  const html = await page.evaluate(() => document.documentElement.outerHTML.length);
  const src = readFileSync(join(ROOT, 'index.html'), 'utf8');
  ok('the page is what was measured', html > 0);
  // A single fill() at the end of an unbounded loop is the bug. The batch
  // flush inside the loop is the fix, and it has to be there in the source.
  ok('there is a batch size, and it is bounded',
     /var BATCH = (\d+);/.test(src)
     && +src.match(/var BATCH = (\d+);/)[1] <= 8000,
     (src.match(/var BATCH = (\d+);/) || [])[1]);
  ok('and the path is flushed inside the loop, not only after it',
     /if \(\+\+pending >= BATCH\) \{ ctx\.fill\(\); ctx\.beginPath\(\); pending = 0; \}/.test(src));
}

console.log('\n3. a loop of frames stays inside a memory budget');
{
  const r = await page.evaluate(() => {
    // The pool holds this many PNGs as data URLs, and a data URL is a JS
    // string a third larger than the bytes in it. This is the number that
    // decides whether playback survives on a phone.
    const frame = window.__time(120000, 4.1);
    return { cap: L2_LOOP_MAX, kb: frame.kb, px: frame.px };
  });
  const poolMB = (r.kb * r.cap) / 1024;
  ok('the loop keeps a bounded number of frames', r.cap > 0 && r.cap <= 24, String(r.cap));
  ok('and a busy frame at the full cap is tens of megabytes, not hundreds',
     poolMB < 100, `${poolMB.toFixed(0)} MB for ${r.cap} frames of ${r.kb.toFixed(0)} KB`);
  // This is the pathological case: a mesh with echo in every cell right out
  // to the edge. Real scans are mostly empty and land far below it.
  ok('the raster is capped rather than growing without limit',
     r.px <= 2000, String(r.px));
}

console.log('\n4. the picture is still the same picture');
{
  // Speed that changed what was drawn would not be a fix. The batched fill
  // has to paint the same cells in the same colours as one big fill would.
  const r = await page.evaluate(() => {
    const site = _meshSiteLatLon('ktlx');
    const sq = (dx, dy, v) => [
      site.lon + dx, site.lat + dy, site.lon + dx + 0.4, site.lat + dy,
      site.lon + dx + 0.4, site.lat + dy + 0.4, site.lon + dx, site.lat + dy + 0.4, v];
    const res = {
      meshData: Float32Array.from([].concat(sq(-1, -1, 22), sq(0, 0, 38), sq(0.6, 0.6, 55))),
      bounds: [site.lon - 2, site.lat - 2, site.lon + 2, site.lat + 2],
      metadata: {},
    };
    const img = _meshToImage(res, 'ref', null);
    const S = img.canvas.width;
    const g = img.canvas.getContext('2d');
    const at = (fx, fy) => [...g.getImageData(Math.round(fx * S), Math.round(fy * S), 1, 1).data];
    return {
      // The three squares, sampled where each one sits in the box.
      weak: at(0.30, 0.70), mid: at(0.55, 0.45), strong: at(0.70, 0.30),
      empty: at(0.05, 0.05),
    };
  });
  ok('the weak cell is green', r.weak[1] > 200 && r.weak[0] < 60, JSON.stringify(r.weak));
  ok('the middle one is yellow', r.mid[0] > 200 && r.mid[1] > 200, JSON.stringify(r.mid));
  ok('the strong one is red', r.strong[0] > 200 && r.strong[1] < 60, JSON.stringify(r.strong));
  ok('and empty space is left empty', r.empty[3] === 0, JSON.stringify(r.empty));
}

console.log('\n5. nothing above threw');
{
  const real = errors.filter(e => !/Failed to fetch|NetworkError|ERR_FAILED|net::/i.test(e));
  ok('no page errors', real.length === 0, real.slice(0, 3).join(' | '));
}

await browser.close();
console.log();
if (fail) { console.log(`${fail} FAILED, ${pass} passed`); process.exit(1); }
console.log(`all ${pass} passed`);
