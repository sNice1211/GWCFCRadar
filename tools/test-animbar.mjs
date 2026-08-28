#!/usr/bin/env node
/*
 * The animation bar, and how far back playback reaches.
 *
 *     node tools/test-animbar.mjs
 *
 * Two things are checked here, and they are the same bug seen from two sides.
 *
 * The bar only ever knew about two of the things that can animate: the
 * national mosaic and satellite. Everything else - a Level 2 single-site
 * loop, the Level 3 bucket loop, the Pi's own product loop, velocity,
 * dual-pol - moved the slider without ever rewriting the times underneath it.
 * So a loop could be playing perfectly while the bar underneath showed one
 * leftover timestamp from a layer switched off minutes ago, and an empty bar
 * could sit there with a fully painted track that read as a complete loop.
 * That is a bar that looks broken while the playback behind it is fine.
 *
 * The other side is reach: every loop was capped at a length chosen when the
 * worry was memory, and the caps had stopped matching what the sources and
 * the frame pools can actually carry.
 *
 * These drive the real functions on the real page. Nothing here asserts on a
 * mock of the bar: the assertions read the actual slider, the actual labels
 * and the actual buttons after the actual code has run.
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

console.log('\n1. one function answers what is playing, whatever it is');
{
  const r = await page.evaluate(() => {
    const out = {};
    const idle = () => {
      activeLayers.satellite = false; activeLayers.nexrad = false;
      currentProduct = 'ref'; _refStation = null; _refSiteFrames = [];
      radarFrames = []; goesFrames = []; velFrames = []; _dpFrames = [];
      _prOn = false; _l2LoopReset();
    };

    idle();
    out.nothing = _animSource().id;

    idle();
    activeLayers.satellite = true;
    goesFrames = _buildGoesFrames();
    out.sat = _animSource().id;
    out.satCount = _animSource().times.length;

    idle();
    currentProduct = 'vel';
    velFrames = [{ iso: 'a', time: 1000 }, { iso: 'b', time: 1300 }];
    velCurrentFrame = 1;
    out.vel = _animSource().id;
    out.velIdx = _animSource().idx;

    idle();
    currentProduct = 'cc';
    _dpFrames = [{ iso: 'a', time: 1000 }, { iso: 'b', time: 1300 }];
    out.dp = _animSource().id;

    idle();
    radarFrames = [{ time: 1000 }, { time: 1300 }, { time: 1600 }];
    currentFrame = 2;
    out.radar = _animSource().id;

    idle();
    return out;
  });
  ok('nothing playing reports nothing, not a guess', r.nothing === null, JSON.stringify(r));
  ok('satellite is recognised', r.sat === 'sat', JSON.stringify(r));
  ok('velocity is recognised, which the bar never used to know about',
     r.vel === 'vel', JSON.stringify(r));
  ok('and it reports the frame velocity is actually on', r.velIdx === 1, JSON.stringify(r));
  ok('dual-pol is recognised, which the bar never used to know about',
     r.dp === 'dp', JSON.stringify(r));
  ok('the mosaic is still recognised', r.radar === 'radar', JSON.stringify(r));
}

console.log('\n2. a Level 2 or Level 3 loop writes its OWN times on the bar');
{
  const r = await page.evaluate(() => {
    // First put real mosaic times on the bar, so a stale label would be
    // visible rather than merely absent.
    activeLayers.satellite = false; activeLayers.nexrad = true;
    _prOn = false; _l2LoopReset();
    const base = Date.UTC(2026, 7, 20, 6, 0, 0);
    radarFrames = [];
    for (let i = 0; i < 12; i++) radarFrames.push({ time: (base + i * 300000) / 1000 });
    currentFrame = 11;
    _refreshPlayButtonsEnabled();
    const before = document.getElementById('timeline-labels').textContent;

    // Now stand up a single-site loop at a completely different time of day.
    const t0 = Date.UTC(2026, 7, 20, 18, 0, 0);
    _l2Loop.frames = [];
    for (let i = 0; i < 6; i++)
      _l2Loop.frames.push({ url: 'data:,', bounds: null, time: t0 + i * 300000 });
    _l2Loop.idx = 5;
    _l2Loop.station = 'KTLX';
    _l2Loop.product = 'ref';
    // _l2LoopActive() also wants the overlay on the map, which is what the
    // real draw does before ever building a loop.
    _l3Overlay = L.imageOverlay('data:,', [[30, -100], [40, -90]]).addTo(map);
    const active = _l2LoopActive();
    _l2LoopSyncTimeline();
    const tl = document.getElementById('timeline');
    const after = document.getElementById('timeline-labels').textContent;
    return { active, before, after, max: +tl.max, value: +tl.value,
             srcId: _animSource().id };
  });
  ok('the loop is the live source once it has frames', r.active && r.srcId === 'l2',
     JSON.stringify(r));
  ok('the slider is sized to the loop', r.max === 5 && r.value === 5, JSON.stringify(r));
  ok('the labels changed when the source changed', r.before !== r.after,
     `before=${r.before} after=${r.after}`);
  ok('and they are the LOOP times, not the mosaic times left behind',
     r.after.includes('18') && !r.after.includes('06'),
     `after=${r.after} (mosaic was ${r.before})`);
}

console.log('\n3. an empty bar looks empty instead of looking like a full loop');
{
  const r = await page.evaluate(() => {
    // Leave a painted track and real labels behind first.
    _l2LoopReset();
    try { map.removeLayer(_l3Overlay); } catch (e) {}
    _l3Overlay = null;
    activeLayers.nexrad = true;
    radarFrames = [];
    for (let i = 0; i < 12; i++) radarFrames.push({ time: 1755000000 + i * 300 });
    currentFrame = 11;
    _refreshPlayButtonsEnabled();
    const painted = document.getElementById('timeline').style.background;

    // Now take everything away, which is the state the bar looked broken in.
    activeLayers.satellite = false; activeLayers.nexrad = false;
    currentProduct = 'ref'; _refStation = null; _refSiteFrames = [];
    radarFrames = []; goesFrames = []; velFrames = []; _dpFrames = [];
    _prOn = false; _l2LoopReset();
    _refreshPlayButtonsEnabled();

    const tl = document.getElementById('timeline');
    return {
      painted,
      background: tl.style.background,
      disabled: tl.disabled,
      max: +tl.max,
      labels: document.getElementById('timeline-labels').textContent,
      playDisabled: document.getElementById('play-btn').disabled,
      stepDisabled: document.getElementById('step-fwd-btn').disabled,
      title: document.getElementById('play-btn').title,
    };
  });
  ok('a real loop does paint the track', !!r.painted, JSON.stringify(r.painted));
  ok('an empty bar clears that paint instead of keeping it', r.background === '',
     JSON.stringify(r));
  ok('the slider is disabled rather than scrubbable over nothing', r.disabled === true);
  ok('and it is not left sized to a loop that is gone', r.max === 0, String(r.max));
  ok('the labels say so in words', /no loop/i.test(r.labels), r.labels);
  ok('every play and step button is off', r.playDisabled && r.stepDisabled);
  ok('and the reason given is "nothing to play", not "still loading"',
     /nothing to play/i.test(r.title), r.title);
}

console.log('\n4. a single frame is not a loop');
{
  const r = await page.evaluate(() => {
    activeLayers.satellite = false; activeLayers.nexrad = true;
    currentProduct = 'ref'; _refStation = null;
    _prOn = false; _l2LoopReset();
    goesFrames = [];
    radarFrames = [{ time: 1755000000 }];
    currentFrame = 0;
    _radarFramesReady = 1;
    _refreshPlayButtonsEnabled();
    return {
      loopable: _animLoopable(),
      disabled: document.getElementById('play-btn').disabled,
      sliderOff: document.getElementById('timeline').disabled,
      labels: document.getElementById('timeline-labels').textContent,
    };
  });
  ok('one frame does not count as loopable', r.loopable === false, JSON.stringify(r));
  ok('so the play button stays off', r.disabled === true);
  ok('and the slider does not pretend to scrub', r.sliderOff === true);
  ok('and the bar does not print one lonely time under an empty slider',
     /no loop/i.test(r.labels), r.labels);
}

console.log('\n5. the bar and the step buttons never disagree about which list is live');
{
  // If _animSource and stepFrame ever picked different sources, the labels
  // would describe one loop while the buttons walked another.
  const r = await page.evaluate(() => {
    const out = [];
    const idle = () => {
      activeLayers.satellite = false; activeLayers.nexrad = false;
      currentProduct = 'ref'; _refStation = null; _refSiteFrames = [];
      radarFrames = []; goesFrames = []; velFrames = []; _dpFrames = [];
      _prOn = false; _l2LoopReset();
    };

    // Satellite wins over a loaded mosaic, in both.
    idle();
    radarFrames = [{ time: 1 }, { time: 2 }];
    activeLayers.satellite = true;
    goesFrames = _buildGoesFrames();
    goesCurrentFrame = 3;
    const satBefore = goesCurrentFrame, radarBefore = currentFrame;
    stepFrame(1);
    out.push({ who: 'sat', src: _animSource().id,
               satMoved: goesCurrentFrame !== satBefore,
               radarMoved: currentFrame !== radarBefore });

    // Velocity wins over a loaded mosaic, in both.
    idle();
    radarFrames = [{ time: 1 }, { time: 2 }];
    currentProduct = 'vel';
    velFrames = [{ iso: 'a', time: 1 }, { iso: 'b', time: 2 }, { iso: 'c', time: 3 }];
    velCurrentFrame = 0;
    const vB = velCurrentFrame, rB = currentFrame;
    try { stepFrame(1); } catch (e) { /* showVelFrame needs a pool; index still moves */ }
    out.push({ who: 'vel', src: _animSource().id,
               velMoved: velCurrentFrame !== vB, radarMoved: currentFrame !== rB });

    idle();
    return out;
  });
  const sat = r.find(x => x.who === 'sat');
  const vel = r.find(x => x.who === 'vel');
  ok('with satellite up, the bar reads satellite and the step moves satellite',
     sat.src === 'sat' && sat.satMoved && !sat.radarMoved, JSON.stringify(sat));
  ok('with velocity up, the bar reads velocity and the step moves velocity',
     vel.src === 'vel' && vel.velMoved && !vel.radarMoved, JSON.stringify(vel));
}

console.log('\n6. playback reaches further back than it used to');
{
  const r = await page.evaluate(() => ({
    satFrames: _buildGoesFrames().length,
    satStepMin: SAT_FRAME_MIN,
    l2: L2_LOOP_MAX,
    l3: L3_LOOP_MAX,
    mosaicAt12h: (function () {
      const was = _loopLenMin;
      _loopLenMin = 720;
      const n = _loopFrameCount();
      _loopLenMin = was;
      return n;
    })(),
  }));
  const satHours = (r.satFrames * r.satStepMin) / 60;
  ok('satellite reaches hours back, not the old two', satHours >= 4,
     `${r.satFrames} frames x ${r.satStepMin} min = ${satHours} h`);
  ok('the Level 2 loop holds far more than the old five frames', r.l2 >= 12, String(r.l2));
  ok('the Level 3 bucket loop, whose files are tiny, holds more still',
     r.l3 >= r.l2 && r.l3 >= 24, `l2=${r.l2} l3=${r.l3}`);
  ok('a twelve hour mosaic is really twelve hours, not silently truncated',
     r.mosaicAt12h === 144, String(r.mosaicAt12h));
}
{
  const opt = await page.evaluate(() =>
    [...document.querySelectorAll('#lqm-set-looplen option')].map(o => o.value));
  ok('the Loop Length menu offers the twelve hour setting',
     opt.includes('720'), JSON.stringify(opt));
}

console.log('\n7. the longer mosaic loop does not become an unbounded pile of layers');
{
  // "Preload every frame" was safe at 72 frames and is not at 144. This is
  // the same growth that once killed the tab on iOS, one scale further up.
  const r = await page.evaluate(() => {
    const was = radarFrames;
    radarFrames = [];
    for (let i = 0; i < 144; i++) radarFrames.push({ time: 1755000000 + i * 300 });
    const mid = _poolWindow(70);
    const start = _poolWindow(0);
    const end = _poolWindow(143);
    radarFrames = was;
    return {
      mid: mid.e - mid.s + 1,
      start: start.e - start.s + 1,
      end: end.e - end.s + 1,
      midCovers: mid.s <= 70 && mid.e >= 70,
      startCovers: start.s <= 0 && start.e >= 0,
      endCovers: end.s <= 143 && end.e >= 143,
    };
  });
  ok('the preload window is bounded even at 144 frames', r.mid < 144 && r.mid <= 48,
     JSON.stringify(r));
  ok('it is the same size wherever you are in the loop',
     r.mid === r.start && r.start === r.end, JSON.stringify(r));
  ok('and it always contains the frame being shown',
     r.midCovers && r.startCovers && r.endCovers, JSON.stringify(r));
}

console.log('\n8. a phone gets a shorter reach than a computer, on purpose');
{
  const ctx = await browser.newContext({
    userAgent: IPHONE_UA, viewport: { width: 390, height: 844 },
    isMobile: true, hasTouch: true, deviceScaleFactor: 3,
  });
  const { page: ph } = await boot(ctx);
  const r = await ph.evaluate(() => ({
    ios: _isIOS,
    sat: _buildGoesFrames().length,
    l2: L2_LOOP_MAX,
    l3: L3_LOOP_MAX,
    pool: (function () {
      const was = radarFrames;
      radarFrames = [];
      for (let i = 0; i < 144; i++) radarFrames.push({ time: i });
      const w = _poolWindow(70);
      radarFrames = was;
      return w.e - w.s + 1;
    })(),
  }));
  // What a computer on this same machine gets, so the comparison is a real
  // one. This used to be a hardcoded 24, which was the fixed iOS constant of
  // the day; the reach follows the device's memory now, so the claim worth
  // holding is that a phone gets LESS than a computer, not that it gets some
  // particular number.
  const desk = await page.evaluate(() => ({ l3: L3_LOOP_MAX, l2: L2_LOOP_MAX }));
  ok('the phone is recognised as one', r.ios === true, JSON.stringify(r));
  ok('it still gets a real loop, not a stub', r.sat >= 12 && r.l3 >= 12, JSON.stringify(r));
  ok('but a smaller one than a computer gets',
     r.sat <= 36 && r.l2 <= 12 && r.l3 < desk.l3,
     JSON.stringify({ phone: r.l3, computer: desk.l3, sat: r.sat, l2: r.l2 }));
  // And it is still a long loop by the standard of what it replaced: the old
  // fixed cap here was 24 frames, about two hours of scans.
  ok('and it reaches much further back than the old fixed 24 frames',
     r.l3 > 24, String(r.l3));
  ok('and its tile pool stays tight', r.pool <= 8, String(r.pool));
  await ctx.close();
}

console.log('\n9. nothing above threw');
{
  const real = errors.filter(e => !/Failed to fetch|NetworkError|ERR_FAILED|net::/i.test(e));
  ok('no page errors', real.length === 0, real.slice(0, 3).join(' | '));
}

await browser.close();
console.log();
if (fail) { console.log(`${fail} FAILED, ${pass} passed`); process.exit(1); }
console.log(`all ${pass} passed`);
