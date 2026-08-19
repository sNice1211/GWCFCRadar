#!/usr/bin/env node
/*
 * The radar, against the real live feeds, in a real browser.
 *
 *     node tools/test-live-radar.mjs
 *
 * Every other suite here fakes the network, which is right for testing the
 * page's own logic and useless for the question that actually matters: does a
 * pill on the map draw real weather right now. This one lets the two public S3
 * buckets through and nothing else, then drives the page the way a finger
 * does, and passes only when a picture lands on the map.
 *
 * Needs outbound access to the Unidata buckets, so it is a checked-in tool
 * rather than part of the offline suites. It skips rather than fails when the
 * buckets cannot be reached.
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

// The buckets, and nothing else. Map tiles and fonts are noise here.
//
// Bucket requests are fetched by node and handed back to the page rather than
// let out of the browser directly. On a machine whose outbound access goes
// through a proxy the browser knows nothing about, that is the difference
// between testing the radar and testing the sandbox; node already has the
// proxy and its certificate, so the page sees the real live bytes either way.
await page.route('**://**', async route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('s3.amazonaws.com')) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'GWCFC live radar test' } });
      const body = Buffer.from(await r.arrayBuffer());
      return route.fulfill({
        status: r.status,
        contentType: r.headers.get('content-type') || 'application/octet-stream',
        headers: { 'access-control-allow-origin': '*' },
        body,
      });
    } catch (e) {
      return route.abort();
    }
  }
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
await page.waitForTimeout(4000);

// A bucket that cannot be reached is a skip, not a failure: this tool exists
// to test the radar, not the network it is being run on.
const reachable = await page.evaluate(async () => {
  try {
    const r = await fetch('https://unidata-nexrad-level3.s3.amazonaws.com/'
                        + '?list-type=2&max-keys=1');
    return r.ok;
  } catch { return false; }
});
if (!reachable) {
  console.log('the Unidata buckets are not reachable from here, skipping.');
  await browser.close();
  process.exit(0);
}

// Waits for a drawn picture rather than a fixed delay: a live fetch and decode
// takes as long as it takes.
// Bare name, not window._l3Overlay: a top level let lives in the global
// lexical scope and never becomes a property of window, so reading it off
// window returns undefined forever and every check quietly fails.
const waitForDraw = (ms = 90000) => page.waitForFunction(
  () => typeof _l3Overlay !== 'undefined' && _l3Overlay != null,
  { timeout: ms }).then(() => true).catch(() => false);
const clearDraw = () => page.evaluate(() => {
  try { _disableL3(); } catch (e) {}
  _prBucketSite = null;
});
// An overlay existing is not a picture: the canvas can be fully transparent
// and the overlay still "draws". Counting painted pixels is what actually
// proves a product rendered - a blank Level 3 canvas hid behind the weaker
// check for a while.
const opaque = () => page.evaluate(() => {
  if (typeof _l3Canvas === 'undefined' || !_l3Canvas) return -1;
  const d = _l3Canvas.getContext('2d').getImageData(0, 0, 1000, 1000).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 10) n++;
  return n;
});

console.log('\n1. Level 2, decoded here, for a terminal radar');
{
  // TTPA: Tampa's airport radar. Live chunks, parsed by the worker in this page.
  await page.evaluate(() => { toggleRadarSub(); toggleRadarL2Sub(); });
  await page.evaluate(() => loadL3Data('ref', 'ttpa'));
  const drew = await waitForDraw();
  const st = await page.evaluate(() => ({
    station: _l3Station,
    url: _l3Overlay && String(_l3Overlay._url || '').slice(0, 30),
    tilts: _l2TiltList.length,
  }));
  ok('a terminal radar draws reflectivity from the live feed', drew, JSON.stringify(st));
  ok('and it is a decoded picture, not a fetched image',
     drew && /^data:image/.test(st.url || ''), st.url);
  ok('with real painted pixels on the canvas', await opaque() > 0,
     String(await opaque()));
  ok('the station it decoded is the terminal', st.station === 'ttpa', st.station);
  ok('and the volume carried its elevations', st.tilts > 1, String(st.tilts));
  await clearDraw();

  // Velocity off the same volume, which is the other half of what a terminal
  // radar is for.
  await page.evaluate(() => loadL3Data('vel', 'ttpa'));
  ok('and velocity draws too', await waitForDraw(), 'no overlay');
  await clearDraw();
}

console.log('\n1c. the single-site raw playback loop builds from live volumes');
{
  // A busy NEXRAD, which keeps several recent volumes in the streaming
  // bucket. Draw it, then wait for the loop to decode the older ones behind
  // the live frame.
  await page.evaluate(() => loadL3Data('ref', 'ktlx'));
  const drew = await waitForDraw();
  ok('the live frame draws', drew, 'no overlay');
  const built = await page.waitForFunction(
    () => typeof _l2Loop !== 'undefined' && _l2Loop.frames.length > 1,
    { timeout: 90000 }).then(() => true).catch(() => false);
  const st = await page.evaluate(() => ({
    frames: _l2Loop.frames.length,
    active: _l2LoopActive(),
    ready: _animationReady(),
    ordered: _l2Loop.frames.every((f, i, a) => i === 0 || a[i - 1].time <= f.time),
    distinct: new Set(_l2Loop.frames.map(f => f.url)).size,
  }));
  ok('the loop builds more than one frame from raw volumes', built,
     JSON.stringify(st));
  ok('every frame is a distinct decoded picture',
     st.distinct === st.frames && st.frames > 1, JSON.stringify(st));
  ok('frames are ordered oldest to newest', st.ordered, JSON.stringify(st));
  ok('and the play controls come alive', st.active && st.ready,
     JSON.stringify(st));
  // Scrubbing swaps the one overlay to an older frame's image.
  const scrub = await page.evaluate(() => {
    const before = _l3Overlay._url;
    seekFrame(0);
    return { changed: _l3Overlay._url !== before, idx: _l2Loop.idx };
  });
  ok('scrubbing to the oldest frame swaps the picture',
     scrub.changed && scrub.idx === 0, JSON.stringify(scrub));
  await clearDraw();
}

console.log('\n2. Level 2 for a second terminal, on the other side of the country');
{
  await page.evaluate(() => loadL3Data('ref', 'tphx'));
  ok('Phoenix terminal draws as well', await waitForDraw(), 'no overlay');
  await clearDraw();
}

console.log('\n2b. the menu offers what the site actually measures');
{
  // With a terminal selected, the row must hold its three real products and
  // none of the dual-pol it has no hardware for. A finger selects a site by
  // its pill, which records it in _l2Site; scene 2 loaded Phoenix directly,
  // so record it here the way the pill would have.
  await page.evaluate(() => { _l2Site = 'tphx'; toggleRadarL2Sub(); });
  const tRow = await page.evaluate(() =>
    [...document.querySelectorAll('#sub-bubbles .sub-bubble')]
      .map(e => e.textContent.trim()));
  ok('a terminal offers reflectivity, velocity and spectrum width',
     ['Reflectivity', 'Velocity', 'Spectrum Width'].every(l =>
       tRow.some(t => t.startsWith(l))), tRow.join(','));
  ok('and none of the dual-pol it cannot measure',
     !tRow.some(t => /Corr\. Coeff\.|Diff\. Refl\.|Spec\. Diff\. Phase/.test(t)),
     tRow.join(','));

  // Clicking a terminal pill while a dual-pol product is up must fall back to
  // reflectivity rather than asking for the impossible.
  const fell = await page.evaluate(() => {
    currentProduct = 'cc';
    _nexradSiteMarkers['ttpa'].label.fire('click');
    return currentProduct;
  });
  ok('a dual-pol product falls back to reflectivity on a terminal',
     fell === 'ref', String(fell));
  await page.waitForFunction(
    () => typeof _l3Overlay !== 'undefined' && _l3Overlay != null,
    { timeout: 90000 }).catch(() => {});
  await clearDraw();

  // And a NEXRAD gets the full six back.
  await page.evaluate(() => { _l2Site = 'ktlx'; toggleRadarL2Sub(); });
  const kRow = await page.evaluate(() =>
    [...document.querySelectorAll('#sub-bubbles .sub-bubble')]
      .map(e => e.textContent.trim()));
  ok('a NEXRAD offers all six products again',
     ['Corr. Coeff.', 'Diff. Refl.', 'Spec. Diff. Phase'].every(l =>
       kRow.some(t => t.startsWith(l))), kRow.join(','));
}

console.log('\n3. Level 3 from the bucket, for radars the Pi does not build');
{
  // A plain NEXRAD nobody configured: this is the whole point of the fallback.
  await page.evaluate(() => {
    _radarSource = 'l3';
    _prProduct = 'reflectivity';
    _prTilt = 1;
    return _l3BucketShow('KABR');
  });
  const drew = await waitForDraw();
  const st = await page.evaluate(() => ({ site: _prBucketSite,
                                          on: _prOn }));
  ok('an unconfigured NEXRAD draws its Level 3 reflectivity', drew,
     JSON.stringify(st));
  ok('with real painted pixels, not an invisible overlay',
     await opaque() > 0, String(await opaque()));
  ok('and the page knows it is browser decoded', st.site === 'KABR', st.site);
  await clearDraw();

  // The same path for a terminal, in the terminals' own dialect.
  await page.evaluate(() => { _prTilt = 1; return _l3BucketShow('TMCO'); });
  ok('a terminal draws its Level 3 in the TDWR dialect', await waitForDraw(),
     'no overlay');
  ok('and its pixels are painted too', await opaque() > 0,
     String(await opaque()));
  await clearDraw();

  // TJUA: the one WSR-88D whose id starts with T, which the code used to read
  // as a terminal and hand terminal product codes it does not publish. Puerto
  // Rico's radar was missing from Level 3 for the sake of one initial.
  await page.evaluate(() => { _prProduct = 'reflectivity'; _prTilt = 1;
                              return _l3BucketShow('TJUA'); });
  ok('San Juan draws, being a NEXRAD despite its T', await waitForDraw(),
     'no overlay');
  const jua = await page.evaluate(() => _l3BucketCode('TJUA', 'reflectivity', 1));
  ok('and it is asked for a NEXRAD product code, not a terminal one',
     jua === 'N0B', String(jua));
  await clearDraw();

  // Velocity, and a second tilt, both of which have their own product code.
  await page.evaluate(() => { _prProduct = 'velocity'; _prTilt = 2;
                              return _l3BucketShow('KTLX'); });
  ok('velocity at tilt 2 draws from its own product code',
     await waitForDraw(), 'no overlay');
  ok('velocity paints pixels too', await opaque() > 0, String(await opaque()));
  // Knots at both levels: after normalization no Level 3 velocity should
  // read like m/s AND the mesh should carry plausible knot speeds.
  const velMax = await page.evaluate(() => {
    let m = 0;
    for (let i = 8; i < _lastMeshData.length; i += 9) {
      const v = _lastMeshData[i];
      if (v === v && Math.abs(v) > m) m = Math.abs(v);
    }
    return +m.toFixed(1);
  });
  ok('and its speeds are in knots (fastest gate under 250 kt)',
     velMax > 0 && velMax < 250, String(velMax));
  await clearDraw();

  // Echo tops, the newest product with a raw feed: EET decodes here and the
  // topped flag comes off, so every height is a real kilofeet number.
  await page.evaluate(() => { _prProduct = 'echotops'; _prTilt = 1;
                              return _l3BucketShow('KTLX'); });
  ok('echo tops draw from the EET feed', await waitForDraw(), 'no overlay');
  ok('echo tops paint pixels', await opaque() > 0, String(await opaque()));
  const etMax = await page.evaluate(() => {
    let m = -1;
    for (let i = 8; i < _lastMeshData.length; i += 9) {
      const v = _lastMeshData[i];
      if (v === v && v > m) m = v;
    }
    return m;
  });
  ok('and every height is an honest kilofeet value (under 80)',
     etMax >= 0 && etMax < 80, String(etMax));
  await clearDraw();

  // And a product the terminals genuinely do not publish must say so rather
  // than draw something else or fail silently.
  const said = await page.evaluate(async () => {
    const seen = [];
    const real = window.showToast;
    window.showToast = m => seen.push(String(m));
    _prProduct = 'corrcoeff';
    _prTilt = 1;
    await _l3BucketShow('TMCO');
    window.showToast = real;
    return seen;
  });
  ok('a product a terminal does not carry is explained, not faked',
     said.some(t => /not published/i.test(t)), said.join(' | '));
  await clearDraw();
}

console.log('\n3b. the value filter and custom colors, on live data');
{
  // Real weather from the live bucket, then the user's rules over it: a
  // filter floor must strictly shrink the painted area, an impossible floor
  // must empty it, and a one-color palette must paint exactly that color.
  await page.evaluate(() => { _prProduct = 'reflectivity'; _prTilt = 1;
                              return _l3BucketShow('KABR'); });
  ok('live reflectivity is up for the rules to work on', await waitForDraw(),
     'no overlay');
  const r = await page.evaluate(() => {
    const count = () => {
      const d = _l3Canvas.getContext('2d').getImageData(0, 0, 1000, 1000).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 10) n++;
      return n;
    };
    const all = count();
    _fxFilter = { ref: { on: true, min: 20, max: 80 } }; _fxSave();
    _radarFxApply();
    const strong = count();
    _fxFilter = { ref: { on: true, min: 79, max: 80 } }; _fxSave();
    _radarFxApply();
    const none = count();
    _fxFilter = {}; _fxColors = { ref: { on: true,
      stops: ['#ff0000', '#ff0000', '#ff0000', '#ff0000', '#ff0000'] } };
    _fxSave(); _radarFxApply();
    // find one painted pixel and read its color
    const d = _l3Canvas.getContext('2d').getImageData(0, 0, 1000, 1000).data;
    let px = null;
    for (let i = 3; i < d.length; i += 4) {
      if (d[i] > 10) { px = [d[i - 3], d[i - 2], d[i - 1]]; break; }
    }
    _fxColors = {}; _fxSave(); _radarFxApply();
    const back = count();
    return { all, strong, none, px, back };
  });
  ok('a 20 dBZ floor strictly shrinks the live picture',
     r.strong < r.all && r.all > 0, r.strong + ' of ' + r.all);
  ok('an impossible floor empties it', r.none === 0, String(r.none));
  ok('a one-color palette paints exactly that color on live echoes',
     r.px && r.px[0] === 255 && r.px[1] === 0 && r.px[2] === 0,
     JSON.stringify(r.px));
  ok('clearing the rules restores the whole picture', r.back === r.all,
     r.back + ' vs ' + r.all);
  await clearDraw();
}

console.log('\n4. nothing threw along the way');
ok('no uncaught errors', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
