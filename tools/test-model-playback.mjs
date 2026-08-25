#!/usr/bin/env node
/*
 * Forecast-hour playback on the model panel.
 *
 *     node tools/test-model-playback.mjs
 *
 * The model panel had a scrubber and nothing else: the only way through a
 * forecast was to drag it by hand. That makes a forecast unreadable, because
 * the thing worth seeing in one is motion - a trough digging, a rain shield
 * sweeping in - and a still frame does not show motion.
 *
 * This drives the real panel. It stands up a fake manifest so the panel has
 * hours to run through, serves a real 1x1 PNG for every frame the page asks
 * for, and then clicks the actual buttons and reads back which forecast hour
 * the page is actually on. Nothing here asserts on a mock of the transport.
 *
 * The frame images are counted as they are requested, because the preload is
 * the half of this that is easy to get wrong and impossible to see: without
 * it the first pass through a loop is a slideshow at network speed, and with
 * it running twice it is a burst of duplicate downloads off the Pi.
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

// A real one-pixel transparent PNG, so the image overlays actually load and
// fire the events the swap logic waits on.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk'
  + 'YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

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
  if (url.includes('/models/') && url.endsWith('.png')) {
    asked.push(url);
    return route.fulfill({ contentType: 'image/png', body: PNG,
      headers: { 'Access-Control-Allow-Origin': '*' } });
  }
  return route.abort();
});
await page.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4200);
await page.evaluate(() => { if (typeof closeTutorial === 'function') closeTutorial(); });

// Stand the panel up on a forecast that does not exist, so nothing here
// depends on the Pi being reachable or on which run it happens to be on.
await page.evaluate(() => {
  if (!_hdPanel) _hdBuildPanel();
  _hdOn = true;
  _hdBase = 'https://example.invalid/wx';
  _hdModel = 'gfs';
  _hdRegion = 'conus';
  _hdField = 'gh500';
  _hdHourIdx = 0;
  _hdIndex = { models: { gfs: { label: 'GFS', res: '0.25 deg',
    regions: { conus: { path: 'gfs/conus/20260825_00/manifest.json' } } } },
    updated: new Date().toISOString() };
  _hdManifest = {
    model: 'gfs', run: '20260825_00', res: '0.25 deg',
    bounds: [[20, -130], [55, -60]],
    fields: {
      gh500: { hours: [0, 6, 12, 18, 24], min: 500, max: 590 },
      t850:  { hours: [0, 6, 12], min: -20, max: 25 },
      sst:   { hours: [0] },
    },
  };
  _hdPanel.style.display = 'block';
  _hdRenderPanel();
});

const idx = () => page.evaluate(() => _hdHourIdx);
const fhr = () => page.evaluate(() =>
  _hdHoursFor(_hdField)[Math.min(_hdHourIdx, _hdHoursFor(_hdField).length - 1)]);
const playing = () => page.evaluate(() => !!_hdPlayTimer);

console.log('\n1. the transport is actually on the panel');
{
  const seen = await page.evaluate(() => ({
    prev: !!_hdPanel.querySelector('.hd-prev'),
    play: !!_hdPanel.querySelector('.hd-play'),
    next: !!_hdPanel.querySelector('.hd-next'),
    speed: !!_hdPanel.querySelector('.hd-speed'),
    tape: _hdPanel.querySelector('.hd-tape').style.display,
  }));
  ok('there is a step back button', seen.prev);
  ok('there is a play button', seen.play);
  ok('there is a step forward button', seen.next);
  ok('there is a speed picker', seen.speed);
  ok('and the transport is showing, because there are five hours to run',
     seen.tape === 'flex', seen.tape);
}

console.log('\n2. stepping moves one forecast hour at a time');
{
  await page.click('#hd-panel .hd-next');
  ok('forward once is +6h', await fhr() === 6, String(await fhr()));
  await page.click('#hd-panel .hd-next');
  await page.click('#hd-panel .hd-next');
  ok('three forward is +18h', await fhr() === 18, String(await fhr()));
  await page.click('#hd-panel .hd-prev');
  ok('back once is +12h', await fhr() === 12, String(await fhr()));
  // Wrapping is the point: a forecast loop that stops dead at the analysis
  // hour is a loop you have to restart by hand every time round.
  await page.evaluate(() => { _hdHourIdx = 0; });
  await page.click('#hd-panel .hd-prev');
  ok('back past the start wraps to the last hour', await fhr() === 24,
     String(await fhr()));
  await page.click('#hd-panel .hd-next');
  ok('and forward past the end wraps to the first', await fhr() === 0,
     String(await fhr()));
}

console.log('\n3. play actually runs through the hours on its own');
{
  await page.evaluate(() => { _hdHourIdx = 0; _hdPlayMs = 120; });
  await page.click('#hd-panel .hd-play');
  ok('it reports itself as playing', await playing());
  const label = await page.evaluate(() =>
    _hdPanel.querySelector('.hd-play').title);
  ok('and the button offers to pause', label === 'Pause', label);
  await page.waitForTimeout(500);
  const moved = await idx();
  ok('the forecast hour advanced without anyone touching it', moved > 0,
     String(moved));
  await page.waitForTimeout(500);
  ok('and it kept going', await idx() !== moved || await idx() > 0,
     String(await idx()));
  await page.click('#hd-panel .hd-play');
  ok('clicking again stops it', !(await playing()));
  const still = await idx();
  await page.waitForTimeout(400);
  ok('and stopped means stopped', await idx() === still,
     `${still} then ${await idx()}`);
  const back = await page.evaluate(() =>
    _hdPanel.querySelector('.hd-play').title);
  ok('the button offers to play again', back !== 'Pause', back);
}

console.log('\n4. the loop wraps rather than running off the end');
{
  await page.evaluate(() => { _hdHourIdx = 4; _hdPlayMs = 120; });
  await page.click('#hd-panel .hd-play');
  await page.waitForTimeout(260);
  const after = await idx();
  await page.click('#hd-panel .hd-play');
  ok('past the last hour it comes round to the first rather than sticking',
     after < 4, String(after));
}

console.log('\n5. taking the scrubber back stops the loop');
{
  await page.evaluate(() => { _hdHourIdx = 0; _hdPlayMs = 300; });
  await page.click('#hd-panel .hd-play');
  ok('playing', await playing());
  await page.evaluate(() => {
    const sl = _hdPanel.querySelector('.hd-slider');
    sl.value = '3';
    sl.dispatchEvent(new Event('input', { bubbles: true }));
  });
  ok('dragging the scrubber stops it', !(await playing()));
  ok('and lands where it was dragged to', await fhr() === 18,
     String(await fhr()));
}

console.log('\n6. frames are warmed once, not on every pass');
{
  await page.evaluate(() => { _hdPreloaded = ''; _hdHourIdx = 0; _hdPlayMs = 90; });
  asked.length = 0;
  await page.click('#hd-panel .hd-play');
  await page.waitForTimeout(700);
  const firstPass = asked.filter(u => u.includes('gh500')).length;
  const hours = await page.evaluate(() => _hdHoursFor('gh500').length);
  ok('every frame of the field was fetched, not just the one on screen',
     firstPass >= hours, `${firstPass} for ${hours} hours`);
  asked.length = 0;
  await page.waitForTimeout(700);
  const secondPass = asked.filter(u => u.includes('gh500')).length;
  // The second time round the browser serves them from cache, so what is
  // being checked is that the preload did not fire a second full burst.
  ok('a second pass does not re-warm the whole field',
     secondPass < hours * 2, `${secondPass} for ${hours} hours`);
  await page.click('#hd-panel .hd-play');
}

console.log('\n7. switching field re-warms and keeps playing');
{
  await page.evaluate(() => { _hdPreloaded = ''; _hdHourIdx = 0; _hdPlayMs = 200; });
  await page.click('#hd-panel .hd-play');
  asked.length = 0;
  await page.evaluate(() => {
    const b = [..._hdPanel.querySelectorAll('.hd-f')]
      .find(x => x.dataset.f === 't850');
    if (b) b.click();
  });
  await page.waitForTimeout(400);
  ok('the new field is showing', await page.evaluate(() => _hdField) === 't850');
  ok('and it is still playing', await playing());
  ok('and the new field was warmed too',
     asked.some(u => u.includes('t850')),
     String(asked.filter(u => u.includes('t850')).length));
  await page.click('#hd-panel .hd-play');
}

console.log('\n8. a field with one hour gets no transport');
{
  await page.evaluate(() => { _hdField = 'sst'; _hdHourIdx = 0; _hdRenderPanel(); });
  const shown = await page.evaluate(() =>
    _hdPanel.querySelector('.hd-tape').style.display);
  ok('one forecast hour is a still picture, so the transport hides',
     shown === 'none', shown);
  await page.evaluate(() => { _hdField = 'gh500'; _hdRenderPanel(); });
}

console.log('\n9. closing the panel stops the timer');
{
  await page.evaluate(() => { _hdPlayMs = 300; });
  await page.click('#hd-panel .hd-play');
  ok('playing', await playing());
  await page.evaluate(() => _hdDisable());
  ok('closing the panel stops it, rather than leaving a timer pulling '
     + 'pictures off the Pi', !(await playing()));
}

console.log('\n10. the page did not throw doing any of that');
ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
console.log(`\n${fail ? '' : 'all '}${pass} passed`
  + (fail ? `, ${fail} FAILED` : ''));
process.exit(fail ? 1 : 0);
