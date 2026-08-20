#!/usr/bin/env node
/*
 * The Export tool: downloads whatever radar/satellite/model picture is
 * currently on screen, as a single PNG or as every frame of its loop
 * (stitched into a video where the browser can record one, or as a
 * numbered PNG sequence where it can't).
 *
 *     node tools/test-export-tool.mjs
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
const page = await browser.newPage({ acceptDownloads: true });
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
await page.evaluate(() => { if (typeof closeTutorial === 'function') closeTutorial(); });

console.log('\n1. panel open/close and source detection');
{
  const r = await page.evaluate(() => {
    const closedStart = !document.getElementById('export-panel').classList.contains('open');
    _expToggle();
    const opened = document.getElementById('export-panel').classList.contains('open');
    const noneStatus = document.getElementById('export-status').textContent;
    activeLayers.nexrad = false; activeLayers.satellite = false;
    const src = _expActiveSource();
    _expToggle();
    const closedEnd = !document.getElementById('export-panel').classList.contains('open');
    return { closedStart, opened, noneStatus, src, closedEnd };
  });
  ok('starts closed', r.closedStart, String(r.closedStart));
  ok('toggling opens it', r.opened, String(r.opened));
  ok('with nothing active the status says so', /Nothing to export/i.test(r.noneStatus), r.noneStatus);
  ok('_expActiveSource returns null with nothing on', r.src === null, JSON.stringify(r.src));
  ok('toggling again closes it', r.closedEnd, String(r.closedEnd));
}

console.log('\n2. source detection picks the right pathway');
{
  const r = await page.evaluate(() => {
    activeLayers.nexrad = true; activeLayers.satellite = false;
    radarFrames = [{ time: 1 }, { time: 2 }, { time: 3 }];
    const nexrad = _expActiveSource();

    activeLayers.nexrad = false; activeLayers.satellite = true;
    goesFrames = [{ timeStr: 'a' }, { timeStr: 'b' }];
    const satellite = _expActiveSource();

    activeLayers.satellite = false;
    _prSite = 'KTLX'; _prOn = true; _prBucketSite = null;
    _prLoop = { frames: ['s1', 's2', 's3', 's4'], idx: 0, site: 'KTLX', lvl: 'l3', cache: new Map() };
    const pi = _expActiveSource();

    activeLayers.nexrad = false; _prOn = false;
    const none = _expActiveSource();
    return { nexrad, satellite, pi, none };
  });
  ok('nexrad detected with 3 frames', r.nexrad && r.nexrad.kind === 'nexrad' && r.nexrad.count === 3, JSON.stringify(r.nexrad));
  ok('satellite detected with 2 frames', r.satellite && r.satellite.kind === 'satellite' && r.satellite.count === 2, JSON.stringify(r.satellite));
  ok('Pi loop detected with 4 frames', r.pi && r.pi.kind === 'pi' && r.pi.count === 4, JSON.stringify(r.pi));
  ok('nothing active once every source is off', r.none === null, JSON.stringify(r.none));
}

console.log('\n3. the WMS frame URL is built correctly from the current view');
{
  const r = await page.evaluate(() => {
    map.setView([35, -97], 6);
    const url = _expWmsFrameUrl('https://example.test/wms', 'conus_ch13', '2024-01-01T00:00:00Z');
    const u = new URL(url);
    const p = u.searchParams;
    return {
      base: u.origin + u.pathname,
      service: p.get('SERVICE'), request: p.get('REQUEST'), layers: p.get('LAYERS'),
      srs: p.get('SRS'), time: p.get('TIME'),
      bboxParts: (p.get('BBOX') || '').split(',').map(Number),
      width: Number(p.get('WIDTH')), height: Number(p.get('HEIGHT')),
    };
  });
  ok('base URL and WMS params are correct',
     r.base === 'https://example.test/wms' && r.service === 'WMS' && r.request === 'GetMap'
     && r.layers === 'conus_ch13' && r.srs === 'EPSG:3857' && r.time === '2024-01-01T00:00:00Z',
     JSON.stringify(r));
  ok('the bbox is four finite numbers with min < max on both axes',
     r.bboxParts.length === 4 && r.bboxParts.every(Number.isFinite)
     && r.bboxParts[0] < r.bboxParts[2] && r.bboxParts[1] < r.bboxParts[3],
     JSON.stringify(r.bboxParts));
  ok('width/height reflect the real map size, not zero', r.width > 0 && r.height > 0, JSON.stringify(r));
}

console.log('\n4. PNG export downloads the currently-shown frame');
{
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  await page.evaluate((b64) => {
    // A real 1x1 PNG as a data: URL stands in for _prOverlay's frame - the
    // export path reloads whatever _prOverlay.getElement().src is with its
    // own crossOrigin img, so any valid image URL exercises the same code.
    const img = document.createElement('img');
    img.src = 'data:image/png;base64,' + b64;
    _prOverlay = { getElement: () => img };
    // _prLoopActive() requires more than one frame - a single-frame "loop"
    // isn't a loop, so this needs 2+ to be recognized as an active source.
    _prLoop = { frames: ['s1', 's2'], idx: 0, site: 'KTLX', lvl: 'l3', cache: new Map() };
    _prSite = 'KTLX'; _prOn = true; _prBucketSite = null;
    activeLayers.nexrad = false; activeLayers.satellite = false;
  }, b64);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.evaluate(() => _expDownloadPng()),
  ]);
  const filename = download.suggestedFilename();
  ok('a PNG downloads with a gwcfc-pi-*.png filename',
     /^gwcfc-pi-\d+\.png$/.test(filename), filename);
}

console.log('\n5. the image-sequence fallback (no MediaRecorder) downloads every frame');
{
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  await page.evaluate((b64) => {
    window.__origCanRecord = _expCanRecordVideo;
    _expCanRecordVideo = () => false;   // force the fallback path deterministically
    const img = document.createElement('img');
    img.src = 'data:image/png;base64,' + b64;
    _prOverlay = { getElement: () => img };
    _prLoop = { frames: ['s1', 's2', 's3'], idx: 0, site: 'KTLX', lvl: 'l3', cache: new Map() };
    _prSite = 'KTLX'; _prOn = true; _prBucketSite = null;
  }, b64);

  const downloads = [];
  page.on('download', d => downloads.push(d.suggestedFilename()));
  await page.evaluate(() => _expDownloadVideo());
  await page.waitForTimeout(1000);
  page.removeAllListeners('download');
  await page.evaluate(() => { _expCanRecordVideo = window.__origCanRecord; });

  ok('one PNG per frame downloads, numbered in order',
     downloads.length === 3
     && /frame-001\.png$/.test(downloads[0])
     && /frame-002\.png$/.test(downloads[1])
     && /frame-003\.png$/.test(downloads[2]),
     JSON.stringify(downloads));
}

console.log('\n6. the status line and video-button label react to what\'s available');
{
  const r = await page.evaluate(() => {
    activeLayers.nexrad = false; activeLayers.satellite = false; _prOn = false;
    _expRefreshStatus();
    const empty = {
      status: document.getElementById('export-status').textContent,
      pngDisabled: document.getElementById('export-png-btn').disabled,
      videoDisabled: document.getElementById('export-video-btn').disabled,
    };
    activeLayers.nexrad = true;
    radarFrames = [{ time: 1 }];   // only one frame - video should stay disabled
    _expRefreshStatus();
    const oneFrame = {
      status: document.getElementById('export-status').textContent,
      pngDisabled: document.getElementById('export-png-btn').disabled,
      videoDisabled: document.getElementById('export-video-btn').disabled,
    };
    radarFrames = [{ time: 1 }, { time: 2 }];
    _expRefreshStatus();
    const twoFrames = { videoDisabled: document.getElementById('export-video-btn').disabled };
    activeLayers.nexrad = false;
    return { empty, oneFrame, twoFrames };
  });
  ok('nothing active disables both buttons',
     r.empty.pngDisabled && r.empty.videoDisabled, JSON.stringify(r.empty));
  ok('one frame enables PNG but not the loop download',
     !r.oneFrame.pngDisabled && r.oneFrame.videoDisabled, JSON.stringify(r.oneFrame));
  ok('two or more frames enables the loop download', !r.twoFrames.videoDisabled, JSON.stringify(r.twoFrames));
}

console.log('\n7. nothing threw along the way');
ok('no uncaught errors', errors.length === 0, errors.slice(0, 5).join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
