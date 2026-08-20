#!/usr/bin/env node
/*
 * Confirms satellite imagery animates through the same play/pause button
 * and RAF loop as radar, rather than only ever showing one still frame.
 * The animation-readiness check and the RAF tick both already had a
 * satellite branch in the code; this locks that behavior in with a real
 * test, since none existed for it before.
 *
 *     node tools/test-satellite-loop.mjs
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

console.log('\n1. satellite counts as animation-ready once it has frames');
{
  const r = await page.evaluate(() => {
    // Boot already marks the national mosaic "ready" from its own offline
    // fallback even with no network - neutralize every other path
    // _animationReady() checks so only the satellite branch is on trial.
    activeLayers.satellite = false; goesFrames = [];
    radarFrames = []; _refStation = null; currentProduct = 'ref';
    const off = _animationReady();
    activeLayers.satellite = true;
    goesFrames = _buildGoesFrames();
    const on = _animationReady();
    return { off, on, frameCount: goesFrames.length };
  });
  ok('not ready with satellite off (and nothing else providing frames)', r.off === false, JSON.stringify(r));
  ok('ready once satellite is on with real frames', r.on === true && r.frameCount > 1, JSON.stringify(r));
}

console.log('\n2. the play button actually advances through satellite frames');
{
  const r = await page.evaluate(() => {
    activeLayers.satellite = true;
    goesFrames = _buildGoesFrames();
    goesCurrentFrame = goesFrames.length - 1;
    const start = goesCurrentFrame;

    playing = true;
    _rafLastTs = 0;   // a stale value here would make the first few ticks no-ops
    let ts = 1000;
    const seen = new Set([start]);
    for (let i = 0; i < 6; i++) {
      ts += 700; // comfortably past the RAF tick's own interval threshold
      _rafTick(ts);
      seen.add(goesCurrentFrame);
    }
    playing = false;
    if (_rafPlayId) cancelAnimationFrame(_rafPlayId);

    return { start, end: goesCurrentFrame, distinctFramesSeen: seen.size, total: goesFrames.length };
  });
  ok('cycling through the frames actually changes which one is showing',
     r.start !== r.end, JSON.stringify(r));
  ok('more than one distinct frame was visited, not stuck repeating the same index',
     r.distinctFramesSeen > 1, JSON.stringify(r));
}

console.log('\n3. play-backward also cycles satellite frames, the other direction');
{
  const r = await page.evaluate(() => {
    activeLayers.satellite = true;
    goesFrames = _buildGoesFrames();
    goesCurrentFrame = 0;
    playingBack = true;
    _rafLastTs = 0;
    _rafTick(1000);
    const afterOne = goesCurrentFrame;
    playingBack = false;
    if (_rafPlayId) cancelAnimationFrame(_rafPlayId);
    return { afterOne, total: goesFrames.length };
  });
  // Starting at 0 and stepping backward wraps to the last frame.
  ok('backward playback wraps from the first frame to the last',
     r.afterOne === r.total - 1, JSON.stringify(r));
}

console.log('\n4. turning satellite off stops it from being animation-ready again');
{
  const r = await page.evaluate(() => {
    activeLayers.satellite = false;
    radarFrames = []; _refStation = null; currentProduct = 'ref';
    return _animationReady();
  });
  ok('not ready once satellite is switched off (and nothing else provides frames)', r === false, String(r));
}

console.log('\n5. nothing threw along the way');
ok('no uncaught errors', errors.length === 0, errors.slice(0, 5).join(' | '));

console.log('\n6. the region row only offers sectors the server actually advertises');
{
  // A sector named right but not published looks identical to a broken one:
  // an empty picture. So the row asks the WMS what it serves. This stands up
  // a capabilities document that advertises meso1 but NOT meso2, and checks
  // that exactly the unadvertised pair disappears - and that nothing is
  // hidden before the answer arrives.
  const capPage = await browser.newPage();
  const capErrors = [];
  capPage.on('pageerror', e => capErrors.push(e.message));
  await capPage.route('**://**', route => {
    const url = route.request().url();
    if (url.startsWith('file://')) return route.continue();
    if (url.includes('leaflet') && url.endsWith('.js'))
      return route.fulfill({ contentType: 'application/javascript',
        body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
    if (url.includes('leaflet') && url.endsWith('.css'))
      return route.fulfill({ contentType: 'text/css',
        body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
    if (url.includes('GetCapabilities')) {
      const named = ['conus_ch13', 'fulldisk_ch13', 'alaska_ch13',
                     'hawaii_ch13', 'puertorico_ch13', 'meso1_ch13'];
      return route.fulfill({ contentType: 'text/xml',
        body: '<WMT_MS_Capabilities>'
            + named.map(n => `<Layer><Name>${n}</Name></Layer>`).join('')
            + '</WMT_MS_Capabilities>' });
    }
    return route.abort();
  });
  await capPage.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
  await capPage.waitForTimeout(4000);
  const r = await capPage.evaluate(async () => {
    if (typeof closeTutorial === 'function') closeTutorial();
    toggleSatelliteSub();
    const before = [...document.querySelectorAll('.sat-region-btn')].map(b => b.dataset.regionId);
    await new Promise(res => setTimeout(res, 1200));
    const after = [...document.querySelectorAll('.sat-region-btn')].map(b => b.dataset.regionId);
    return { before, after, declared: GOES_REGIONS.length };
  });
  ok('the mesoscale sectors are declared as regions',
     r.declared === 12 && r.before.includes('emeso1') && r.before.includes('wmeso2'),
     JSON.stringify(r.before));
  ok('every region is offered before the server has answered (fails open)',
     r.before.length === r.declared, JSON.stringify(r.before));
  ok('sectors the server does advertise survive the check',
     r.after.includes('emeso1') && r.after.includes('wmeso1')
     && r.after.includes('east') && r.after.includes('auto'), JSON.stringify(r.after));
  ok('sectors it does not advertise are dropped',
     !r.after.includes('emeso2') && !r.after.includes('wmeso2'), JSON.stringify(r.after));
  ok('nothing threw during the capability check', capErrors.length === 0, capErrors.join(' | '));
  await capPage.close();
}

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
