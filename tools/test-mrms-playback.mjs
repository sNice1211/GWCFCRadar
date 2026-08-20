#!/usr/bin/env node
/*
 * MRMS playback, and the clean screen StormStream leaves behind it.
 *
 *     node tools/test-mrms-playback.mjs
 *
 * MRMS drew one picture: whatever the Pi had built most recently. A still
 * cannot be scrubbed or played, so MRMS was the one radar product with no
 * history at all, and the animation bar did not know it existed.
 *
 * The Pi keeps three days of frames now. Three days is roughly nine hundred
 * frames, which is far too many to download before showing anything, so the
 * frame LIST is loaded up front and the frame PICTURES are fetched around
 * wherever the scrub head is. That split is the whole design and it is what
 * these check: that the bar spans the full window immediately, that stepping
 * swaps the image on one overlay rather than building a layer per frame, and
 * that products on different cadences never end up showing different times.
 *
 * Also here: StormStream taking everything off the screen except the map, the
 * frame and the forecast graphic, and no longer using the WX alerts panel.
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

// Three days of frames, the way the Pi writes them: rotation every 5 minutes,
// hail every 5, and a freezing level on the hourly lane. The mismatch is the
// point - products are on different cadences and must still line up in time.
const BOUNDS = [[20, -130], [55, -60]];
const start = Date.UTC(2026, 7, 17, 12, 0, 0);          // 72 h before the end
const stamp = (ms) => {
  const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
       + `_${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
};
const series = (stepMin, name) => {
  const out = [];
  for (let ms = start; ms <= start + 72 * 3600e3; ms += stepMin * 60e3) {
    out.push({ t: stamp(ms), file: `${stamp(ms)}/${name}.png` });
  }
  return out;
};
const rotationFrames = series(5, 'rotation');
const meshFrames = series(5, 'mesh');
const h0cFrames = series(60, 'h0c');
const MANIFEST = {
  updated: '2026-08-20T12:00:00+00:00',
  keep_hours: 72,
  products: {
    rotation: { label: 'Rotation Tracks', bounds: BOUNDS, unit: 'per s',
                frames: rotationFrames, latest: rotationFrames.at(-1).t,
                file: rotationFrames.at(-1).file },
    mesh: { label: 'Hail (MESH)', bounds: BOUNDS, unit: 'mm',
            frames: meshFrames, latest: meshFrames.at(-1).t,
            file: meshFrames.at(-1).file },
    h0c: { label: 'Freezing Level', bounds: BOUNDS, unit: 'm',
           frames: h0cFrames, latest: h0cFrames.at(-1).t,
           file: h0cFrames.at(-1).file },
  },
};

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'],
});
const page = await browser.newPage();
const errors = [];
let imageHits = 0;
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
  if (/mrms\.json/.test(url))
    return route.fulfill({ contentType: 'application/json',
                           body: JSON.stringify(MANIFEST) });
  if (/\.png($|\?)/.test(url)) {
    imageHits++;
    return route.fulfill({ contentType: 'image/png', body: Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478'
      + '9c6360000002000154a24f6e0000000049454e44ae426082', 'hex') });
  }
  return route.abort();
});
await page.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4200);
await page.evaluate(() => { if (typeof closeTutorial === 'function') closeTutorial(); });
await page.evaluate(() => { _hdBase = 'https://pi.example.test'; });

console.log('\n1. turning a product on builds three days of frames, not one');
{
  const r = await page.evaluate(async () => {
    _mrmsOn = {}; _mrmsOv = {};
    _mrmsToggle('rotation');
    await new Promise(r => setTimeout(r, 700));
    const f = _mrmsLoop.frames;
    return {
      n: f.length,
      spanH: f.length ? (f.at(-1).time - f[0].time) / 3600e3 : 0,
      active: _mrmsLoopActive(),
      idx: _mrmsLoop.idx,
      onNewest: _mrmsLoop.idx === f.length - 1,
      drawn: !!_mrmsOv.rotation,
      firstIsOldest: f.length > 1 && f[0].time < f[1].time,
    };
  });
  ok('every frame the Pi has is in the loop', r.n > 800, String(r.n));
  ok('and they really span three days', r.spanH >= 71 && r.spanH <= 73,
     r.spanH.toFixed(1) + ' h');
  ok('so MRMS is a playback source', r.active);
  ok('oldest first, so the timeline reads left to right', r.firstIsOldest);
  ok('it opens on the newest frame', r.onNewest, String(r.idx));
  ok('and that frame is on the map', r.drawn);
}

console.log('\n2. the animation bar knows about it');
{
  const r = await page.evaluate(() => {
    _refreshPlayButtonsEnabled();
    const src = _animSource();
    const tl = document.getElementById('timeline');
    return {
      id: src.id, n: src.times.length, idx: src.idx,
      max: +tl.max, value: +tl.value, disabled: tl.disabled,
      playOff: document.getElementById('play-btn').disabled,
      labels: document.getElementById('timeline-labels').textContent,
    };
  });
  ok('the bar reports MRMS as what is playing', r.id === 'mrms', String(r.id));
  ok('over the whole three days', r.n > 800, String(r.n));
  ok('the slider is sized to it', r.max === r.n - 1, `${r.max} vs ${r.n - 1}`);
  ok('and is scrubbable', r.disabled === false);
  ok('play is enabled', r.playOff === false);
  ok('the labels are real times, not "no loop"',
     !/no loop/i.test(r.labels) && /\d/.test(r.labels), r.labels);
}

console.log('\n3. nine hundred frames does not mean nine hundred layers');
{
  const r = await page.evaluate(() => {
    let layers = 0;
    map.eachLayer(l => { if (l instanceof L.ImageOverlay) layers++; });
    return { layers, keys: Object.keys(_mrmsOv).filter(k => _mrmsOv[k]).length };
  });
  // This is the whole reason the design splits the list from the pictures.
  // One overlay per PRODUCT, swapped in place, not one per frame.
  ok('there is one overlay for the one product that is on',
     r.keys === 1, String(r.keys));
  ok('and not a layer per frame anywhere on the map',
     r.layers <= 3, String(r.layers));
}

console.log('\n4. stepping swaps the picture on that one overlay');
{
  const r = await page.evaluate(async () => {
    const before = { idx: _mrmsLoop.idx, url: _mrmsOv.rotation._gwUrl };
    const layerBefore = _mrmsOv.rotation;
    document.getElementById('step-back-btn').click();
    await new Promise(r => setTimeout(r, 120));
    const after = { idx: _mrmsLoop.idx, url: _mrmsOv.rotation._gwUrl };
    const sameLayer = _mrmsOv.rotation === layerBefore;
    document.getElementById('step-fwd-btn').click();
    await new Promise(r => setTimeout(r, 120));
    return { before, after, sameLayer, back: _mrmsLoop.idx };
  });
  ok('stepping back moves one frame', r.after.idx === r.before.idx - 1,
     JSON.stringify([r.before.idx, r.after.idx]));
  ok('and the picture really changes', r.after.url !== r.before.url,
     JSON.stringify([r.before.url, r.after.url]));
  ok('on the SAME overlay, rather than tearing one down and building another',
     r.sameLayer);
  ok('stepping forward returns', r.back === r.before.idx, String(r.back));
}

console.log('\n5. scrubbing across three days lands where it is asked to');
{
  const r = await page.evaluate(async () => {
    const n = _mrmsLoop.frames.length;
    seekFrame(0);
    await new Promise(r => setTimeout(r, 150));
    const oldest = { idx: _mrmsLoop.idx, url: _mrmsOv.rotation._gwUrl };
    seekFrame(Math.floor(n / 2));
    await new Promise(r => setTimeout(r, 150));
    const mid = { idx: _mrmsLoop.idx, url: _mrmsOv.rotation._gwUrl };
    seekFrame(n - 1);
    await new Promise(r => setTimeout(r, 150));
    const newest = { idx: _mrmsLoop.idx, url: _mrmsOv.rotation._gwUrl };
    return { n, oldest, mid, newest,
             oldestT: _mrmsLoop.frames[0].t,
             newestT: _mrmsLoop.frames.at(-1).t };
  });
  ok('the far end of the scrub is the oldest frame', r.oldest.idx === 0);
  ok('and it draws the oldest picture, three days back',
     r.oldest.url.includes(r.oldestT), r.oldest.url);
  ok('the middle is the middle', r.mid.idx === Math.floor(r.n / 2));
  ok('and all three are different pictures',
     new Set([r.oldest.url, r.mid.url, r.newest.url]).size === 3,
     JSON.stringify([r.oldest.url, r.mid.url, r.newest.url]));
  ok('the live end is the newest frame', r.newest.url.includes(r.newestT),
     r.newest.url);
}

console.log('\n6. two products on different cadences still show the same moment');
{
  const r = await page.evaluate(async () => {
    // Freezing level is hourly; rotation is every five minutes. Asking the
    // hourly one for a five-minute timestamp has to land on something real
    // rather than on nothing, and it must be the NEAREST thing.
    _mrmsToggle('h0c');
    await new Promise(r => setTimeout(r, 700));
    const n = _mrmsLoop.frames.length;
    seekFrame(n - 40);                       // a time with no hourly frame
    await new Promise(r => setTimeout(r, 200));
    const want = _mrmsLoop.frames[_mrmsLoop.idx];
    const rotU = _mrmsOv.rotation._gwUrl, h0cU = _mrmsOv.h0c._gwUrl;
    const grab = (u) => (u.match(/(\d{8}_\d{6})/) || [])[1];
    const ms = (t) => {
      const m = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(t);
      return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    };
    return {
      wantT: want.t,
      rotT: grab(rotU), h0cT: grab(h0cU),
      rotOff: Math.abs(ms(grab(rotU)) - want.time) / 60e3,
      h0cOff: Math.abs(ms(grab(h0cU)) - want.time) / 60e3,
      both: !!_mrmsOv.rotation && !!_mrmsOv.h0c,
    };
  });
  ok('both products are drawn', r.both);
  ok('the five-minute product lands exactly on the wanted time',
     r.rotOff === 0, `${r.rotT} vs ${r.wantT}`);
  ok('the hourly one lands on its nearest frame rather than nothing',
     r.h0cOff <= 30, `${r.h0cT} is ${r.h0cOff} min from ${r.wantT}`);
  ok('and it is a real frame, not an invented address',
     /\d{8}_\d{6}/.test(r.h0cT || ''), String(r.h0cT));
}

console.log('\n7. playing it actually moves');
{
  const r = await page.evaluate(async () => {
    seekFrame(_mrmsLoop.frames.length - 12);
    const before = _mrmsLoop.idx;
    document.getElementById('play-btn').click();
    await new Promise(r => setTimeout(r, 1400));
    const during = _mrmsLoop.idx;
    document.getElementById('play-btn').click();
    await new Promise(r => setTimeout(r, 120));
    return { before, during, stopped: _mrmsLoop.idx,
             playing: typeof playing !== 'undefined' ? playing : null };
  });
  ok('the frame moved on its own after pressing play',
     r.during !== r.before, JSON.stringify(r));
  ok('and pressing it again stops it', r.playing === false, String(r.playing));
}

console.log('\n8. turning it all off leaves nothing behind');
{
  const r = await page.evaluate(async () => {
    _mrmsToggle('rotation'); _mrmsToggle('h0c');
    await new Promise(r => setTimeout(r, 500));
    _refreshPlayButtonsEnabled();
    let overlays = 0;
    map.eachLayer(l => { if (l instanceof L.ImageOverlay) overlays++; });
    return {
      any: _mrmsAnyOn(), loop: _mrmsLoopActive(),
      frames: _mrmsLoop.frames.length,
      overlays,
      src: _animSource().id,
      timer: _mrmsTimer,
    };
  });
  ok('nothing is on', r.any === false);
  ok('the loop is emptied rather than left claiming three days',
     r.loop === false && r.frames === 0, JSON.stringify(r));
  ok('no image overlay is left on the map', r.overlays === 0, String(r.overlays));
  ok('the animation bar stops reporting MRMS', r.src !== 'mrms', String(r.src));
  ok('and the refresh timer is cleared', r.timer === null, String(r.timer));
}

console.log('\n9. on air, everything but the broadcast gets out of the way');
{
  const r = await page.evaluate(() => {
    _lastAlertFeatures = [{
      type: 'Feature',
      geometry: { type: 'Polygon',
                  coordinates: [[[-98, 35], [-97, 35], [-97, 36], [-98, 36], [-98, 35]]] },
      properties: { id: 'x', event: 'Tornado Warning', areaDesc: 'Cleveland, OK',
                    expires: new Date(Date.now() + 1800e3).toISOString(),
                    effective: new Date().toISOString(), description: '' },
    }];
    _ssCfg = { coverage: 'us', stepSec: 15, enabled: true, firstRunSeen: true };
    _ssStart();
    const vis = (sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).display !== 'none' : null;
    };
    return {
      live: document.body.classList.contains('ss-live'),
      stage: vis('#ss-stage'),
      map: vis('#main'),
      animbar: vis('#animbar'),
      sidebar: vis('#sidebar'),
      logo: vis('#logo-wrap'),
      rightMenu: vis('#right-menu'),
      subBubbles: vis('#sub-bubbles'),
      alertsPanel: vis('#alerts-panel'),
      overlayStack: vis('#overlay-panel-stack'),
      topbar: vis('#topbar'),
    };
  });
  ok('the page is marked as on air', r.live);
  ok('the map is still there, because it is the picture', r.map);
  ok('so is the broadcast frame', r.stage);
  const gone = ['animbar', 'sidebar', 'logo', 'rightMenu', 'subBubbles',
                'alertsPanel', 'overlayStack', 'topbar'];
  gone.forEach(k => ok(`${k} is hidden`, r[k] === false, String(r[k])));
}

console.log('\n10. the forecast graphic stays, because it IS the broadcast');
{
  const r = await page.evaluate(() => {
    // Stand a graphic up the way _sgApplyActiveGraphic does.
    const img = document.createElement('img');
    img.id = 'sg-active-graphic';
    img.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
    img.style.cssText = 'position:fixed;left:0;top:0;width:100%;z-index:940;';
    document.body.appendChild(img);
    const shown = getComputedStyle(img).display !== 'none';
    return { shown };
  });
  ok('a forecast graphic is not hidden by the on-air sweep', r.shown);
}

console.log('\n11. and stopping puts the interface back');
{
  const r = await page.evaluate(() => {
    _ssStop();
    const vis = (sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).display !== 'none' : null;
    };
    const g = document.getElementById('sg-active-graphic');
    if (g) g.remove();
    return {
      live: document.body.classList.contains('ss-live'),
      animbar: vis('#animbar'),
      sidebar: vis('#sidebar'),
      stage: !!document.getElementById('ss-stage'),
    };
  });
  ok('the on-air mark is cleared', r.live === false);
  ok('the animation bar comes back', r.animbar === true);
  ok('so do the menus', r.sidebar === true, String(r.sidebar));
  ok('and the frame is taken down', r.stage === false);
}

console.log('\n12. nothing above threw');
{
  const real = errors.filter(e => !/Failed to fetch|NetworkError|ERR_FAILED|net::/i.test(e));
  ok('no page errors', real.length === 0, real.slice(0, 3).join(' | '));
}

await browser.close();
console.log();
if (fail) { console.log(`${fail} FAILED, ${pass} passed`); process.exit(1); }
console.log(`all ${pass} passed`);
