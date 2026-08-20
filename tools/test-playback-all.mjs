#!/usr/bin/env node
/*
 * Playback across every pathway that draws a picture, because "it loops"
 * was previously only ever true for some of them:
 *
 *   - single-site Level 3 (every NEXRAD and every terminal radar, reached
 *     through the Unidata bucket) only ever fetched the NEWEST file, so it
 *     was one still frame with a dead play button
 *   - satellite animated by mutating TIME on a single WMS layer, so every
 *     frame was a fresh network round trip and playback visibly stalled
 *
 * The earlier satellite test passed while the feature was broken because it
 * set `playing = true` and called the RAF tick directly, proving the loop
 * arithmetic worked while never touching the part that was actually wrong.
 * These check the machinery a person actually drives: the buttons, the
 * frame list, and which layer is really visible.
 *
 *     node tools/test-playback-all.mjs
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

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'],
});

async function boot(context) {
  const page = await (context || browser).newPage();
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
  await page.waitForTimeout(4200);
  await page.evaluate(() => { if (typeof closeTutorial === 'function') closeTutorial(); });
  return { page, errors };
}

const { page, errors } = await boot();

console.log('\n1. the animation bar has both one-frame step buttons');
{
  const r = await page.evaluate(() => {
    const bar = document.getElementById('animbar');
    const kids = [...bar.children].map(c => c.id).filter(Boolean);
    return {
      order: kids,
      backIdx: kids.indexOf('step-back-btn'),
      playBackIdx: kids.indexOf('play-back-btn'),
      zoomIdx: kids.indexOf('zoom-wrap'),
      fwdIdx: kids.indexOf('step-fwd-btn'),
      timeIdx: kids.indexOf('anim-time-display'),
      playIdx: kids.indexOf('play-btn'),
    };
  });
  ok('both step buttons exist', r.backIdx >= 0 && r.fwdIdx >= 0, JSON.stringify(r.order));
  ok('step-back sits between Play Backwards and the zoom control',
     r.playBackIdx < r.backIdx && r.backIdx < r.zoomIdx, JSON.stringify(r));
  ok('step-forward sits between the timestamp and Play Forward',
     r.timeIdx < r.fwdIdx && r.fwdIdx < r.playIdx, JSON.stringify(r));
}

console.log('\n2. the step buttons actually move one frame, both directions');
{
  const r = await page.evaluate(() => {
    // Drive the national mosaic, which is the pathway available offline.
    activeLayers.satellite = false;
    activeLayers.nexrad = true;
    _prOn = false;
    _l2LoopReset();
    currentFrame = 5;
    document.getElementById('step-fwd-btn').click();
    const afterFwd = currentFrame;
    document.getElementById('step-back-btn').click();
    const afterBack = currentFrame;
    return { afterFwd, afterBack, total: radarFrames.length };
  });
  ok('forward one frame advances exactly one', r.afterFwd === 6, JSON.stringify(r));
  ok('back one frame returns exactly one', r.afterBack === 5, JSON.stringify(r));
}

console.log('\n3. the step buttons follow the same readiness gate as play');
{
  const r = await page.evaluate(() => {
    activeLayers.satellite = false; activeLayers.nexrad = false;
    radarFrames = []; _refStation = null; currentProduct = 'ref';
    _prOn = false; _l2LoopReset(); goesFrames = [];
    _refreshPlayButtonsEnabled();
    const off = {
      play: document.getElementById('play-btn').disabled,
      fwd: document.getElementById('step-fwd-btn').disabled,
      back: document.getElementById('step-back-btn').disabled,
    };
    activeLayers.satellite = true;
    goesFrames = _buildGoesFrames();
    _refreshPlayButtonsEnabled();
    const on = {
      play: document.getElementById('play-btn').disabled,
      fwd: document.getElementById('step-fwd-btn').disabled,
      back: document.getElementById('step-back-btn').disabled,
    };
    return { off, on };
  });
  ok('with no frames anywhere, step and play are all disabled together',
     r.off.play && r.off.fwd && r.off.back, JSON.stringify(r.off));
  ok('once satellite has frames, step and play all enable together',
     !r.on.play && !r.on.fwd && !r.on.back, JSON.stringify(r.on));
}

console.log('\n4. satellite: one preloaded layer per frame, swapped by opacity');
{
  const r = await page.evaluate(() => {
    _disableRadar();
    activeLayers.satellite = true;
    loadGoesLayer();
    const built = _goesPool.filter(Boolean).length;
    const distinct = new Set(_goesPool.filter(Boolean)).size;
    const visibleAtStart = _goesPool.findIndex(l => l && l.options.opacity > 0);
    showGoesFrame(3);
    const visibleAfterScrub = _goesPool.findIndex(l => l && l.options.opacity > 0);
    const onlyOneVisible = _goesPool.filter(l => l && l.options.opacity > 0).length;
    return { frames: goesFrames.length, built, distinct, visibleAtStart,
             visibleAfterScrub, onlyOneVisible, poolMax: GOES_POOL_MAX };
  });
  ok('a layer is preloaded for each frame, not one layer reused',
     r.built === r.frames && r.distinct === r.frames, JSON.stringify(r));
  ok('the newest frame is the one showing at first',
     r.visibleAtStart === r.frames - 1, JSON.stringify(r));
  ok('scrubbing changes which preloaded layer is visible',
     r.visibleAfterScrub === 3, JSON.stringify(r));
  ok('exactly one frame is visible at a time', r.onlyOneVisible === 1, JSON.stringify(r));
}

console.log('\n5. satellite: the play button drives it through real frames');
{
  const r = await page.evaluate(async () => {
    _disableRadar();
    activeLayers.satellite = true;
    if (!goesFrames.length) loadGoesLayer();
    goesCurrentFrame = goesFrames.length - 1;
    const start = goesCurrentFrame;
    const btn = document.getElementById('play-btn');
    const wasDisabled = btn.disabled;
    btn.click();                       // the real control, not a forced flag
    const nowPlaying = playing;
    await new Promise(r2 => setTimeout(r2, 1400));   // real RAF, real clock
    const moved = goesCurrentFrame;
    btn.click();                       // stop
    return { wasDisabled, nowPlaying, start, moved, stopped: !playing,
             visible: _goesPool.findIndex(l => l && l.options.opacity > 0) };
  });
  ok('the play button is enabled for satellite', r.wasDisabled === false, JSON.stringify(r));
  ok('clicking it starts playback', r.nowPlaying === true, JSON.stringify(r));
  ok('frames genuinely advance on the real clock', r.moved !== r.start, JSON.stringify(r));
  ok('the visible pooled layer tracks the current frame',
     r.visible === r.moved, JSON.stringify(r));
  ok('clicking again stops it', r.stopped === true, JSON.stringify(r));
}

console.log('\n6. the Level 3 bucket lists a whole loop, not just the newest file');
{
  const r = await page.evaluate(() => ({
    hasList: typeof _l3BucketList === 'function',
    hasBuild: typeof _l3BucketLoopBuild === 'function',
    hasKeyTime: typeof _l3BucketKeyTime === 'function',
    loopMax: typeof L3_LOOP_MAX !== 'undefined' ? L3_LOOP_MAX : null,
    // The key carries its own timestamp, which is what orders and labels frames.
    parsed: _l3BucketKeyTime('TLX_N0Q_2024_05_20_18_42_07'),
    expected: Date.UTC(2024, 4, 20, 18, 42, 7),
    badKey: _l3BucketKeyTime('nonsense'),
  }));
  ok('the loop builder and list helpers exist',
     r.hasList && r.hasBuild && r.hasKeyTime, JSON.stringify(r));
  ok('it asks for more than one frame', r.loopMax > 1, String(r.loopMax));
  ok('a bucket key parses to its real UTC time', r.parsed === r.expected, JSON.stringify(r));
  ok('an unparseable key reports NaN rather than a wrong time',
     Number.isNaN(r.badKey), String(r.badKey));
}

console.log('\n7. the bucket loop feeds the same machinery play/step/scrub already use');
{
  const r = await page.evaluate(() => {
    // Stand up a finished two-frame bucket loop the way _l3BucketLoopBuild
    // leaves one, and confirm every shared control now claims it.
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const bounds = [[30, -100], [40, -90]];
    activeLayers.satellite = false;
    activeLayers.nexrad = false;
    _prOn = false;
    _l3Overlay = L.imageOverlay(png, bounds).addTo(map);
    _l2Loop = { frames: [{ url: png, bounds, time: Date.now() - 300000 },
                         { url: png, bounds, time: Date.now() }],
                idx: 1, station: 'KTLX', product: 'n0q', building: false, token: 1 };
    const active = _l2LoopActive();
    const ready = _animationReady();
    _refreshPlayButtonsEnabled();
    const playDisabled = document.getElementById('play-btn').disabled;
    const stepDisabled = document.getElementById('step-fwd-btn').disabled;
    stepFrame(-1);
    const afterStep = _l2Loop.idx;
    seekFrame(1);
    const afterSeek = _l2Loop.idx;
    return { active, ready, playDisabled, stepDisabled, afterStep, afterSeek };
  });
  ok('a bucket-built loop counts as an active single-site loop', r.active === true, JSON.stringify(r));
  ok('it makes the animation ready', r.ready === true, JSON.stringify(r));
  ok('the play and step buttons enable for it',
     !r.playDisabled && !r.stepDisabled, JSON.stringify(r));
  ok('stepping moves through its frames', r.afterStep === 0, JSON.stringify(r));
  ok('the timeline scrub lands on the frame asked for', r.afterSeek === 1, JSON.stringify(r));
}

console.log('\n8. the loop holds still: one box per site+product, not one per frame');
{
  // The wobble had a precise cause. result.bounds is the extent of the gates
  // that held DATA in that one sweep, not the radar's coverage, so a quiet
  // scan reported a small box and a stormy one a large box. Each frame was
  // drawn into its own box and setBounds was called per frame, so the picture
  // shifted and resized as it played, drifting off centre and back.
  const r = await page.evaluate(() => {
    const site = _meshSiteLatLon('ktlx');
    const quiet  = { bounds: [site.lon - 0.4, site.lat - 0.4,
                              site.lon + 0.4, site.lat + 0.4],
                     meshData: new Float32Array(9), metadata: {} };
    const stormy = { bounds: [site.lon - 4.2, site.lat - 3.9,
                              site.lon + 3.8, site.lat + 4.1],
                     meshData: new Float32Array(9), metadata: {} };
    const lopsided = { bounds: [site.lon, site.lat, site.lon + 3, site.lat + 3],
                       meshData: new Float32Array(9), metadata: {} };
    const mid = b => ({ lon: (b[0] + b[2]) / 2, lat: (b[1] + b[3]) / 2 });
    const boxes = [quiet, stormy, lopsided].map(f => _meshStableBox(f, 'ktlx'));
    const centres = boxes.map(mid);
    return {
      site,
      centres,
      // Every box, whatever the sweep held, must sit on the antenna.
      allCentred: centres.every(c => Math.abs(c.lon - site.lon) < 1e-6
                                  && Math.abs(c.lat - site.lat) < 1e-6),
      // A box must still contain the data that produced it.
      containsOwn: [quiet, stormy, lopsided].every((f, i) =>
        boxes[i][0] <= f.bounds[0] && boxes[i][1] <= f.bounds[1]
        && boxes[i][2] >= f.bounds[2] && boxes[i][3] >= f.bounds[3]),
      unknownSiteStillStable: !!_meshStableBox(quiet, 'not-a-radar'),
    };
  });
  ok('every sweep, quiet or stormy or one-sided, yields a box on the antenna',
     r.allCentred, JSON.stringify(r.centres));
  ok('each box still contains the data it was built from', r.containsOwn, JSON.stringify(r));
  ok('an unknown station still yields a usable box rather than nothing',
     r.unknownSiteStillStable, String(r.unknownSiteStillStable));

  const held = await page.evaluate(() => {
    // Two frames of genuinely different extent, rendered the way the loop
    // renders them: through one shared box. Their images must agree on
    // geography exactly, so nothing moves when the loop steps between them.
    const site = _meshSiteLatLon('ktlx');
    const mk = (spread, v) => ({
      meshData: Float32Array.from([
        site.lon - spread, site.lat - spread, site.lon + spread, site.lat - spread,
        site.lon + spread, site.lat + spread, site.lon - spread, site.lat + spread, v,
      ]),
      bounds: [site.lon - spread, site.lat - spread, site.lon + spread, site.lat + spread],
      metadata: {},
    });
    _meshBox = null;                      // start clean, as a fresh site does
    _renderMesh(mk(3, 40), 'n0b', 'KTLX');  // live frame establishes the box
    const box = _meshBox && _meshBox.bounds.slice();
    const a = _meshToImage(mk(3, 40), 'n0b', _meshBox.bounds);
    const b = _meshToImage(mk(1, 40), 'n0b', _meshBox.bounds);   // much smaller sweep
    return {
      box,
      sameGeography: JSON.stringify(a.leafletBounds) === JSON.stringify(b.leafletBounds),
      boundsA: a.leafletBounds, boundsB: b.leafletBounds,
    };
  });
  ok('a small sweep and a large one render into identical geography',
     held.sameGeography, JSON.stringify(held));
}

console.log('\n9. the first picture costs fewer round trips and fewer bytes');
{
  const r = await page.evaluate(() => ({
    direct: L2_DIRECT_CAP,
    loop: L2_LOOP_CAP,
    // History frames are watched in motion and skipped if unreadable, so they
    // are read far more cheaply than the live frame.
    loopIsCheaper: L2_LOOP_CAP < L2_DIRECT_CAP,
    capIsSane: L2_DIRECT_CAP >= 1.5 * 1024 * 1024 && L2_DIRECT_CAP <= 5.5 * 1024 * 1024,
    hasListCache: typeof _s3ListCached === 'function' && typeof _s3VolumeList === 'function',
    assembleTakesCap: /function _assembleVolume\(station, vol, cap\)/.test(_assembleVolume.toString())
      || _assembleVolume.length === 3,
  }));
  ok('history frames are read more cheaply than the live frame',
     r.loopIsCheaper, JSON.stringify(r));
  ok('the live cap stays within a sane range', r.capIsSane, String(r.direct));
  ok('the station listing is shared rather than fetched per caller',
     r.hasListCache, String(r.hasListCache));
  ok('volume assembly accepts a per-call byte cap', r.assembleTakesCap, String(r.assembleTakesCap));

  const cached = await page.evaluate(async () => {
    let calls = 0;
    const realFetch = window.fetch;
    window.fetch = (...a) => { calls++; return Promise.reject(new Error('offline')); };
    try {
      // Two callers, one listing: the live load and the loop build that
      // follows it moments later used to fetch this same large listing twice.
      const key = 'vols:TESTSITE';
      let made = 0;
      const mk = () => { made++; return Promise.resolve(['0001', '0002']); };
      const a = await _s3ListCached(key, mk);
      const b = await _s3ListCached(key, mk);
      return { made, sameAnswer: JSON.stringify(a) === JSON.stringify(b) };
    } finally { window.fetch = realFetch; }
  });
  ok('a second caller reuses the cached listing instead of refetching',
     cached.made === 1 && cached.sameAnswer, JSON.stringify(cached));

  const notPoisoned = await page.evaluate(async () => {
    const key = 'vols:FAILSITE';
    let made = 0;
    const bad = () => { made++; return Promise.reject(new Error('listing failed')); };
    await _s3ListCached(key, bad).catch(() => {});
    await new Promise(r2 => setTimeout(r2, 20));
    await _s3ListCached(key, bad).catch(() => {});
    return { made };
  });
  ok('a failed listing is not remembered as the answer',
     notPoisoned.made === 2, JSON.stringify(notPoisoned));
}

console.log('\n10. nothing threw along the way');
ok('no uncaught errors', errors.length === 0, errors.slice(0, 5).join(' | '));
await page.close();

console.log("\n11. iOS keeps the satellite pool bounded, with real eviction");
{
  const iosCtx = await browser.newContext({ userAgent: IPHONE_UA });
  const { page: ip, errors: iErr } = await boot(iosCtx);
  const r = await ip.evaluate(() => {
    _disableRadar();
    activeLayers.satellite = true;
    loadGoesLayer();
    const counts = [];
    [11, 8, 4, 0, 11].forEach(i => { showGoesFrame(i); counts.push(_goesPool.filter(Boolean).length); });
    return { isIOS: _isIOS, poolMax: GOES_POOL_MAX, frames: goesFrames.length, counts };
  });
  ok('the page detected iOS', r.isIOS === true, String(r.isIOS));
  ok('iOS uses a smaller pool cap than the frame count',
     r.poolMax < r.frames, JSON.stringify(r));
  ok('scrubbing the whole range never grows the pool past its cap',
     r.counts.every(c => c <= r.poolMax + 1), JSON.stringify(r.counts));
  ok('nothing threw on iOS', iErr.length === 0, iErr.slice(0, 3).join(' | '));
  await ip.close();
  await iosCtx.close();
}

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
