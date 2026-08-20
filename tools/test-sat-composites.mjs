#!/usr/bin/env node
/*
 * The GOES RGB composites, from the menu through to the map.
 *
 *     node tools/test-sat-composites.mjs
 *
 * Every satellite product before these was one ABI band served ready-made by
 * a WMS. A composite is not a band: it is arithmetic across three or four of
 * them, no WMS serves one, and so pi/satellite_pipeline.py builds them and
 * writes a PNG per scan. That means the page now has two completely different
 * kinds of satellite frame, and almost everything that can go wrong here is
 * one of them being treated as the other: a picture asked for as tiles, a
 * sector offered that the Pi does not build, a manifest landing after the
 * user has moved on and repainting the map with the wrong product.
 *
 * The Pi is mocked, because there is no Pi here. What is not mocked is the
 * page: these drive the real menu, the real frame builder and the real layer
 * pool, and read what actually ended up on the map.
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

// A manifest shaped exactly the way build_sector() writes one: frames oldest
// first, each with its own rectangle, because the mesoscale boxes move.
const STAMPS = ['20260820_120000', '20260820_121000', '20260820_122000',
                '20260820_123000', '20260820_124000'];
const manifest = (sector) => ({
  updated: '2026-08-20T12:41:00+00:00',
  sector,
  keep_hours: 12,
  products: {
    airmass: {
      label: 'Air Mass',
      latest: STAMPS[STAMPS.length - 1],
      file: `${STAMPS[STAMPS.length - 1]}/airmass.png`,
      bounds: [[24, -125], [50, -66]],
      frames: STAMPS.map((t, i) => ({
        t, file: `${t}/airmass.png`,
        // Each frame's box nudged, so a test can tell whether the per-frame
        // rectangle was used or the newest one was reused for all of them.
        bounds: [[24 + i * 0.1, -125 + i * 0.1], [50 + i * 0.1, -66 + i * 0.1]],
      })),
    },
    truecolor: {
      label: 'True Colour',
      latest: STAMPS[STAMPS.length - 1],
      file: `${STAMPS[STAMPS.length - 1]}/truecolor.png`,
      bounds: [[24, -125], [50, -66]],
      frames: STAMPS.map(t => ({ t, file: `${t}/truecolor.png`,
                                 bounds: [[24, -125], [50, -66]] })),
    },
  },
});

const PI = 'https://pi.example.test';
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'],
});

const page = await browser.newPage();
const errors = [];
const asked = [];
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
  const m = /\/satellite\/(east|west)\/(\w+)\/manifest\.json/.exec(url);
  if (m) {
    asked.push(`${m[1]}/${m[2]}`);
    // Only CONUS and the mesoscale boxes are built here; Full Disk is on
    // demand only on the Pi and is genuinely absent most of the time.
    if (m[2] === 'fulldisk')
      return route.fulfill({ status: 404, body: 'not built' });
    return route.fulfill({ contentType: 'application/json',
                           body: JSON.stringify(manifest(m[2])) });
  }
  if (/\.png($|\?)/.test(url))
    return route.fulfill({ contentType: 'image/png', body: Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478'
      + '9c6360000002000154a24f6e0000000049454e44ae426082', 'hex') });
  return route.abort();
});
await page.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4200);
await page.evaluate(() => { if (typeof closeTutorial === 'function') closeTutorial(); });
// Point the page at the mock Pi, the same way a real resolve would.
await page.evaluate(pi => { _hdBase = pi; }, PI);

console.log('\n1. the composites are in the menu, under their own heading');
{
  const r = await page.evaluate(() => {
    toggleSatelliteSub();
    const grid = document.getElementById('sat-product-grid');
    const heads = [...grid.querySelectorAll('.sub-bubble-group-label')]
      .map(h => h.textContent);
    const rgb = GOES_PRODUCTS.filter(p => p.group === 'rgb');
    return {
      heads,
      count: rgb.length,
      allPi: rgb.every(p => p.src === 'pi' && !!p.recipe),
      described: rgb.filter(p => !LAYER_DESCRIPTIONS[p.id]).map(p => p.id),
      inGrid: rgb.filter(p => !grid.querySelector(`[data-product-id="${p.id}"]`)).map(p => p.id),
      bandsUntouched: GOES_PRODUCTS.filter(p => p.ch && p.src === 'pi').length,
    };
  });
  ok('there is a Composites heading', r.heads.includes('Composites'), JSON.stringify(r.heads));
  ok('and a real set of them under it, not one token entry', r.count >= 7, String(r.count));
  ok('every one is marked as coming from the Pi, with a recipe named', r.allPi);
  ok('every one has an info description', r.described.length === 0, r.described.join(','));
  ok('every one is actually drawn in the menu', r.inGrid.length === 0, r.inGrid.join(','));
  ok('and no plain band was turned into a Pi product by accident',
     r.bandsUntouched === 0, String(r.bandsUntouched));
}

console.log('\n2. choosing one reads the Pi, not the WMS');
{
  asked.length = 0;
  const r = await page.evaluate(async () => {
    _disableRadar();
    activeLayers.satellite = true;
    _goesRegionId = 'east';
    _setGoesProduct('rgb-airmass');
    await new Promise(r => setTimeout(r, 700));
    return {
      isPi: _goesIsPi(),
      frames: goesFrames.length,
      firstUrl: goesFrames[0] && goesFrames[0].url,
      lastUrl: goesFrames[goesFrames.length - 1] && goesFrames[goesFrames.length - 1].url,
      hasTimeStr: goesFrames.every(f => !!f.timeStr),
      srcId: _animSource().id,
    };
  });
  ok('the page knows this product is a Pi one', r.isPi === true);
  ok('it asked the Pi for the right satellite and sector',
     asked.includes('east/conus'), JSON.stringify(asked));
  ok('every frame in the manifest became a frame on the bar',
     r.frames === 5, String(r.frames));
  ok('the frames point at the Pi, one folder per scan',
     /\/satellite\/east\/conus\/20260820_120000\/airmass\.png$/.test(r.firstUrl || ''),
     r.firstUrl);
  ok('oldest first, so the timeline reads left to right',
     /20260820_124000/.test(r.lastUrl || ''), r.lastUrl);
  ok('and the animation bar sees them as the live source', r.srcId === 'sat');
}

console.log('\n3. a composite frame goes on the map as a picture, not as tiles');
{
  const r = await page.evaluate(() => {
    showGoesFrame(2);
    const l = _goesPool[2];
    const proto = l && l.constructor && l.constructor.name;
    return {
      exists: !!l,
      isOverlay: !!(l && typeof l.setUrl === 'function' && !l.createTile),
      proto,
      // The third frame's own rectangle, not the newest frame's.
      bounds: l && l.getBounds && [
        +l.getBounds().getSouth().toFixed(2), +l.getBounds().getWest().toFixed(2),
      ],
      visible: _goesPool.filter(x => x && x.options.opacity > 0).length,
      visibleIdx: _goesPool.findIndex(x => x && x.options.opacity > 0),
    };
  });
  ok('a layer exists for the frame', r.exists, r.proto);
  ok('it is an image overlay, not a tile layer', r.isOverlay, r.proto);
  ok('it uses that frame\'s OWN rectangle, because the meso boxes move',
     r.bounds && Math.abs(r.bounds[0] - 24.2) < 0.01, JSON.stringify(r.bounds));
  ok('exactly one frame is visible', r.visible === 1, String(r.visible));
  ok('and it is the one asked for', r.visibleIdx === 2, String(r.visibleIdx));
}

console.log('\n4. playback works the same as it does for a band');
{
  const r = await page.evaluate(() => {
    const before = goesCurrentFrame;
    document.getElementById('step-back-btn').click();
    const back = goesCurrentFrame;
    document.getElementById('step-fwd-btn').click();
    const fwd = goesCurrentFrame;
    return {
      before, back, fwd,
      playEnabled: !document.getElementById('play-btn').disabled,
      labels: document.getElementById('timeline-labels').textContent,
      sliderMax: +document.getElementById('timeline').max,
    };
  });
  ok('step back moves one frame', r.back === r.before - 1, JSON.stringify(r));
  ok('step forward moves back', r.fwd === r.before, JSON.stringify(r));
  ok('play is enabled, because five frames is a loop', r.playEnabled);
  ok('the slider is sized to the composite\'s own frames', r.sliderMax === 4,
     String(r.sliderMax));
  ok('and the labels are the composite\'s own times', /12/.test(r.labels), r.labels);
}

console.log('\n5. only sectors the Pi actually builds are offered');
{
  const r = await page.evaluate(() => {
    _setGoesProduct('rgb-airmass');
    toggleSatelliteSub();
    const forRgb = [...document.querySelectorAll('.sat-region-btn')]
      .map(b => b.dataset.regionId);
    _setGoesProduct('ch13');
    toggleSatelliteSub();
    const forBand = [...document.querySelectorAll('.sat-region-btn')]
      .map(b => b.dataset.regionId);
    return { forRgb, forBand };
  });
  ok('a composite does not offer Alaska, Hawaii or the Caribbean',
     !r.forRgb.some(id => ['alaska', 'hawaii', 'caribbean'].includes(id)),
     JSON.stringify(r.forRgb));
  ok('it does offer both CONUS sectors and both mesoscale pairs',
     ['east', 'west', 'emeso1', 'wmeso2'].every(id => r.forRgb.includes(id)),
     JSON.stringify(r.forRgb));
  ok('a plain band still offers everything it used to',
     ['alaska', 'hawaii', 'caribbean'].every(id => r.forBand.includes(id)),
     JSON.stringify(r.forBand));
}

console.log('\n6. switching to a composite from a sector it cannot do lands somewhere real');
{
  const r = await page.evaluate(async () => {
    _setGoesProduct('ch13');
    _setGoesRegion('alaska');
    const wasAlaska = _goesRegionId;
    _setGoesProduct('rgb-dust');
    const after = _goesRegionId;
    await new Promise(r => setTimeout(r, 500));
    return { wasAlaska, after, target: _goesPiTarget() };
  });
  ok('it was on Alaska', r.wasAlaska === 'alaska');
  ok('and falls back to Auto rather than showing nothing with no reason',
     r.after === 'auto', r.after);
  ok('Auto resolves to a real satellite and sector',
     r.target && ['east', 'west'].includes(r.target.sat) && r.target.sector === 'conus',
     JSON.stringify(r.target));
}

console.log('\n7. a product the Pi has not built says so instead of going blank');
{
  const r = await page.evaluate(async () => {
    activeLayers.satellite = true;
    _goesRegionId = 'east';
    // The mock manifest carries airmass and truecolor only.
    _setGoesProduct('rgb-firetemp');
    await new Promise(r => setTimeout(r, 700));
    return {
      frames: goesFrames.length,
      note: document.getElementById('anim-time').textContent,
      playOff: document.getElementById('play-btn').disabled,
      labels: document.getElementById('timeline-labels').textContent,
    };
  });
  ok('no frames are invented', r.frames === 0, String(r.frames));
  ok('the bar says it is not built yet', /not built/i.test(r.note), r.note);
  ok('play is off rather than dead-looking', r.playOff === true);
  ok('and the timeline says there is no loop', /no loop/i.test(r.labels), r.labels);
}

console.log('\n8. a sector with no manifest at all is handled the same way');
{
  const r = await page.evaluate(async () => {
    _setGoesProduct('rgb-airmass');
    _setGoesRegion('efulldisk');       // the mock answers 404 for Full Disk
    await new Promise(r => setTimeout(r, 700));
    return { frames: goesFrames.length,
             labels: document.getElementById('timeline-labels').textContent };
  });
  ok('a 404 manifest is no frames, not a crash', r.frames === 0, String(r.frames));
  ok('and the bar reports no loop', /no loop/i.test(r.labels), r.labels);
}

console.log('\n9. a slow manifest cannot repaint the map after the user moved on');
{
  const r = await page.evaluate(async () => {
    _setGoesRegion('east');
    _setGoesProduct('rgb-airmass');
    // Start a load, then immediately switch away, the way a fast tap does.
    const p = _goesLoadPiFrames();
    _setGoesProduct('ch13');
    await p;
    await new Promise(r => setTimeout(r, 400));
    return { isPi: _goesIsPi(), anyPiFrame: goesFrames.some(f => !!f.url) };
  });
  ok('the page is back on a plain band', r.isPi === false);
  ok('and no composite frame was pasted over it', r.anyPiFrame === false);
}

console.log('\n10. nothing above threw');
{
  const real = errors.filter(e => !/Failed to fetch|NetworkError|ERR_FAILED|net::/i.test(e));
  ok('no page errors', real.length === 0, real.slice(0, 3).join(' | '));
}

await browser.close();
console.log();
if (fail) { console.log(`${fail} FAILED, ${pass} passed`); process.exit(1); }
console.log(`all ${pass} passed`);
