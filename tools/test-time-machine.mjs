#!/usr/bin/env node
/*
 * The radar time machine, and the speed of playback.
 *
 *     node tools/test-time-machine.mjs
 *
 * Three numbers were measured against the live bucket before any of this was
 * written, and they are what the code below exists to hold in place.
 *
 * THE SWAP. A frame held as a data: URL took 3.837 ms to put on the map,
 * because the browser re-parses the base64 and re-decodes the PNG every
 * single time. The same picture behind a blob: URL took 0.003 ms. Playback is
 * nothing but swaps, so this one number is the difference between a loop and
 * a slideshow, and it is the one that has to stay under a millisecond.
 *
 * THE LISTING. The old reader asked S3 for one hour at a time, in series:
 * nine requests, 2419 ms, 104 keys. One request for a whole day came back in
 * 283 ms with 229 keys. The hour prefix was never a smaller answer, only a
 * smaller question asked more times.
 *
 * THE DEPTH. Bisected against the live bucket: 2022-02-15 is empty and
 * 2022-03-15 has a full day, so the archive floor is inside that month. Every
 * probe from there to today returns 200 to 600 scans a day.
 *
 * Nothing here touches the network. Every bucket reply is built in this file
 * to the shape the real one has, at the 229-scans-a-day cadence a NEXRAD
 * really keeps, so the test says the same thing on a plane as it does in an
 * office and cannot spend somebody's S3 bill to tell them their loop is fast.
 */

import { readFileSync, existsSync } from 'fs';
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

// One day of a real listing, rebuilt rather than shipped: 229 scans at the
// cadence a NEXRAD really runs, so the shapes the code sorts and slices are
// the shapes it will meet.
function fakeDayXml(sid, code, day, count) {
  let keys = '';
  for (let i = 0; i < count; i++) {
    const mins = Math.round(i * (1440 / count));
    const hh = String(Math.floor(mins / 60)).padStart(2, '0');
    const mm = String(mins % 60).padStart(2, '0');
    keys += `<Contents><Key>${sid}_${code}_${day}_${hh}_${mm}_11</Key></Contents>`;
  }
  return `<?xml version="1.0"?><ListBucketResult>${keys}</ListBucketResult>`;
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));

// Every bucket request is answered here, and counted, because "how many
// requests did that take" is half of what this file is about.
let s3Requests = [];
let emptyDays = new Set();
await page.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript',
      body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css',
      body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  if (url.includes('unidata-nexrad-level3')) {
    s3Requests.push(url);
    const m = /prefix=([A-Z0-9]+)_([A-Z0-9]+)_(\d{4}_\d{2}_\d{2})_/.exec(url);
    if (m) {
      const day = m[3];
      const n = emptyDays.has(day) ? 0 : 229;
      return route.fulfill({ contentType: 'application/xml',
                             body: fakeDayXml(m[1], m[2], day, n) });
    }
    return route.fulfill({ contentType: 'application/xml',
                           body: '<?xml version="1.0"?><ListBucketResult/>' });
  }
  return route.abort();
});
await page.addInitScript(() => {
  try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {}
});
await page.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);

console.log('\n1. a frame is held so that showing it is free');
{
  const r = await page.evaluate(async () => {
    // A real PNG, small but genuine, so this measures the mechanism rather
    // than a string swap.
    const cv = document.createElement('canvas');
    cv.width = cv.height = 256;
    const ctx = cv.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 256, 256);
    g.addColorStop(0, '#0f0'); g.addColorStop(1, '#f00');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 256);
    const dataUrl = cv.toDataURL('image/png');

    const a = _pbBlob(dataUrl);
    const b = _pbBlob(dataUrl);
    const out = { isBlob: a.startsWith('blob:'), distinct: a !== b };

    // The swap itself, alternating so nothing can be skipped as a no-op.
    const ov = L.imageOverlay(a, [[35, -98], [36, -97]]);
    ov.addTo(map);
    const time = (urls) => {
      for (let i = 0; i < 5; i++) ov.setUrl(urls[i % urls.length]);   // warm
      const t = performance.now();
      for (let i = 0; i < 40; i++) ov.setUrl(urls[i % urls.length]);
      return (performance.now() - t) / 40;
    };
    out.msBlob = time([a, b]);
    out.msData = time([dataUrl, dataUrl + '#2']);
    map.removeLayer(ov);

    // And the accounting, because a blob URL pins its bytes until revoked.
    out.tracked = _pbBlobs.has(a) && _pbBlobs.has(b);
    _pbFree(a);
    out.freed = !_pbBlobs.has(a);
    _pbFreeFrames([{ url: b }]);
    out.freedByFrames = !_pbBlobs.has(b);
    return out;
  });
  ok('a frame becomes a blob URL', r.isBlob && r.distinct, JSON.stringify(r));
  // THE number. Measured at 0.003 ms against 3.837 ms for the data URL the
  // loop used to hold, so a whole millisecond is a wide margin, not a
  // squeaked-past one.
  ok(`showing a held frame takes ${r.msBlob.toFixed(4)} ms, under one`,
     r.msBlob < 1, r.msBlob.toFixed(4) + ' ms');
  ok('which is faster than the data URL it replaced',
     r.msBlob < r.msData, `${r.msBlob.toFixed(4)} vs ${r.msData.toFixed(4)}`);
  ok('every blob is tracked so none can leak', r.tracked);
  ok('and handing one back revokes it', r.freed && r.freedByFrames);
}

console.log('\n2. the listing reads whole days, in parallel, once each');
{
  s3Requests = [];
  const r = await page.evaluate(async () => {
    const t0 = performance.now();
    const keys = await _arcDayKeys('KTLX', 'N0B', Date.UTC(2025, 5, 15));
    const ms1 = performance.now() - t0;
    const t1 = performance.now();
    const again = await _arcDayKeys('KTLX', 'N0B', Date.UTC(2025, 5, 15));
    const ms2 = performance.now() - t1;
    return { n: keys.length, first: keys[0], last: keys[keys.length - 1],
             ms1, ms2, sameCount: again.length };
  });
  ok('a whole day comes back from one request',
     r.n === 229 && s3Requests.length === 1,
     `${r.n} keys in ${s3Requests.length} requests`);
  ok('oldest first, so the timeline reads left to right',
     r.first < r.last, `${r.first} .. ${r.last}`);
  ok('the site keeps its terminal T and loses its NEXRAD K',
     /^TLX_/.test(r.first), r.first);
  const before = s3Requests.length;
  ok('a day already read is not asked for again',
     r.sameCount === 229 && s3Requests.length === before,
     `${s3Requests.length} requests total`);

  // The old walk was one request per HOUR, in series. This is the check that
  // it cannot come back.
  s3Requests = [];
  const rr = await page.evaluate(async () => {
    const end = Date.UTC(2025, 5, 20, 12);
    const keys = await _arcRange('KTLX', 'N0B', end - 3 * 86400000, end);
    return { n: keys.length };
  });
  ok('three days is three requests, not seventy-two',
     s3Requests.length === 4 && rr.n > 600,
     `${s3Requests.length} requests, ${rr.n} keys`);
  ok('and every one of them asks for a day, never an hour',
     s3Requests.every(u => /prefix=[A-Z0-9]+_[A-Z0-9]+_\d{4}_\d{2}_\d{2}_(&|$)/.test(u)),
     s3Requests[0]);
}

console.log('\n3. a day with nothing in it is a fact, not a retry');
{
  // Measured on the real bucket: KTLX and KOUN published nothing at all on
  // 2026-07-14 while KFWS and KGRK had full days. A radar down for
  // maintenance is normal, and asking again every time somebody scrubs past
  // it is how one quiet day becomes a hundred requests.
  emptyDays = new Set(['2025_07_14']);
  s3Requests = [];
  const r = await page.evaluate(async () => {
    const a = await _arcDayKeys('KTLX', 'N0B', Date.UTC(2025, 6, 14));
    const b = await _arcDayKeys('KTLX', 'N0B', Date.UTC(2025, 6, 14));
    return { a: a.length, b: b.length };
  });
  ok('an empty day answers empty', r.a === 0 && r.b === 0, JSON.stringify(r));
  ok('and is remembered, so scrubbing past it costs one request',
     s3Requests.length === 1, `${s3Requests.length} requests`);
  emptyDays = new Set();
}

console.log('\n4. how many frames this device should hold');
{
  const r = await page.evaluate(() => ({
    budget: _pbFrameBudget(),
    exposed: L3_LOOP_MAX,
    perFrameMB: PB_FRAME_MB,
    devMem: navigator.deviceMemory || null,
    pool: _pbPoolSize(),
    cores: navigator.hardwareConcurrency,
  }));
  // The old number was 40 on a desktop and 24 on iOS, chosen once and fixed.
  // The point of a budget is that a desktop gets the history its memory can
  // actually hold.
  ok(`this device budgets ${r.budget} frames, more than the old fixed 40`,
     r.budget > 40, String(r.budget));
  ok('and the exposed cap follows the budget rather than a constant',
     r.exposed === r.budget, `${r.exposed} vs ${r.budget}`);
  // 0.75 MB was measured on a real full-detail reflectivity frame.
  ok('the budget is memory divided by a measured frame size',
     r.perFrameMB === 0.75, String(r.perFrameMB));
  ok('the frames it allows fit in a sane amount of memory',
     r.budget * r.perFrameMB <= 400, (r.budget * r.perFrameMB).toFixed(0) + ' MB');
  // The interactive decoder has one slot and kills its own predecessor, which
  // is right for the live frame and fatal for a loop.
  ok('loop decoding gets its own workers, and not more than the cores',
     r.pool >= 1 && r.pool <= Math.max(1, r.cores - 2), String(r.pool));
}

console.log('\n5. travelling to a moment');
{
  const r = await page.evaluate(async () => {
    const out = {};
    out.floor = TM_FLOOR;
    out.floorIso = new Date(TM_FLOOR).toISOString().slice(0, 10);

    // The nearest scan to a moment, which is not the same as the last scan
    // before it: asked for 15:00 with scans at 14:58 and 15:02, the right
    // answer is 15:02.
    const url = await _l3BucketNewest('KTLX', 'N0B', Date.UTC(2025, 5, 15, 15, 0));
    out.url = url;
    out.picked = (/_(\d{2})_(\d{2})_\d{2}$/.exec(url || '') || []).slice(1).join(':');

    // The picker itself, with a radar chosen: with none, it rightly says to
    // pick one first rather than offering to travel nowhere.
    _prBucketSite = 'KTLX';
    _tmOpen();
    const m = document.getElementById('tm-modal');
    out.open = m.classList.contains('open');
    out.min = m.querySelector('#tm-date').min;
    out.max = m.querySelector('#tm-date').max;
    out.quickJumps = m.querySelectorAll('.tm-chip').length;
    out.note = m.querySelector('.tm-note').textContent;
    _tmClose();
    out.closed = !m.classList.contains('open');
    // And with no radar picked it says so instead of offering the journey.
    _prBucketSite = null;
    _tmOpen();
    out.noSiteNote = m.querySelector('.tm-note').textContent;
    _tmClose();
    return out;
  });
  ok('the archive floor is the month the bucket really starts',
     r.floorIso === '2022-03-01', r.floorIso);
  ok('a moment in the past resolves to a real scan', !!r.url, String(r.url));
  ok('and to the NEAREST one, not merely an earlier one',
     r.picked === '15:00' || r.picked === '14:59' || r.picked === '15:01',
     r.picked);
  ok('the picker opens, and cannot ask for a date the archive lacks',
     r.open && r.min === '2022-03-01', JSON.stringify({ o: r.open, m: r.min }));
  ok('nor for a date in the future',
     r.max === new Date().toISOString().slice(0, 10), r.max);
  ok('with quick jumps, which is how anyone actually travels',
     r.quickJumps >= 8, String(r.quickJumps));
  ok('and it says how far back it reaches, and which radar',
     /2022-03-01/.test(r.note) && /KTLX/.test(r.note), r.note.slice(0, 90));
  ok('with no radar picked it says to pick one, rather than offering nothing',
     /Pick a radar site/.test(r.noSiteNote), r.noSiteNote.slice(0, 60));
  ok('Escape closes it', r.closed);
}

console.log('\n6. a past picture never passes for a live one');
{
  const r = await page.evaluate(async () => {
    _prBucketSite = 'KTLX';
    _tmAt = Date.UTC(2023, 4, 20, 21, 30);
    _tmSyncBadge();
    const b = document.getElementById('tm-badge');
    const out = { shown: !!b, text: b ? b.textContent : '',
                  onScreen: b ? b.getBoundingClientRect().height > 0 : false };
    _tmAt = null;
    _tmSyncBadge();
    out.goneWhenLive = !document.getElementById('tm-badge');
    _prBucketSite = null;
    return out;
  });
  // Without this, a radar from three years ago looks exactly like a radar
  // from three minutes ago, which is the one way this feature could mislead.
  ok('a standing mark says the picture is not now',
     r.shown && r.onScreen && /PAST/.test(r.text), JSON.stringify(r));
  ok('naming the moment being shown', /2023-05-20 21:30/.test(r.text), r.text);
  ok('with the way back on it', /BACK TO LIVE/.test(r.text), r.text);
  ok('and it goes when the radar is live again', r.goneWhenLive);

  // It first sat at a fixed 8px and printed straight through the update bar's
  // text. The bar is dismissible, so where it ends is a question rather than
  // a constant, and the badge measures it.
  const place = await page.evaluate(() => {
    _prBucketSite = 'KTLX';
    _tmAt = Date.UTC(2023, 4, 20, 21, 30);
    _tmSyncBadge();
    const ub = document.getElementById('update-bar');
    const badge = document.getElementById('tm-badge');
    const out = {};
    if (ub && ub.getBoundingClientRect().height > 0) {
      out.clearsBar = badge.getBoundingClientRect().top
                    >= ub.getBoundingClientRect().bottom;
      out.barShown = true;
      // And with the bar dismissed it climbs back up.
      ub.style.display = 'none';
      _tmPlaceBadge();
      out.risesWhenBarGoes = badge.getBoundingClientRect().top < 20;
      ub.style.display = '';
    } else {
      out.barShown = false;
      out.clearsBar = true; out.risesWhenBarGoes = true;
    }
    _tmAt = null; _tmSyncBadge(); _prBucketSite = null;
    return out;
  });
  ok('it sits clear of the update bar rather than through it',
     place.clearsBar, JSON.stringify(place));
  ok('and moves back up when that bar is dismissed',
     place.risesWhenBarGoes, JSON.stringify(place));
}

console.log('\n7. warming, and knowing when not to');
{
  s3Requests = [];
  const r = await page.evaluate(async () => {
    _prProduct = 'reflectivity'; _prTilt = 1;
    _arcMem.clear(); _arcWarmAt = 0;
    _arcWarm('KTLX');
    await new Promise(res => setTimeout(res, 350));
    const afterOne = performance.now();
    // A click straight after should find the listing already in hand.
    const t = performance.now();
    const keys = await _arcDayKeys('KTLX', 'N0B', Date.now());
    return { warmed: keys.length, msAfterWarm: performance.now() - t };
  });
  ok('warming a site reads its listing', s3Requests.length >= 1,
     `${s3Requests.length} requests`);
  ok('and the click that follows finds it already there',
     r.msAfterWarm < 5, r.msAfterWarm.toFixed(2) + ' ms');

  // Somebody on a metered connection did not ask for this.
  const saved = await page.evaluate(async () => {
    const real = Object.getOwnPropertyDescriptor(navigator, 'connection');
    Object.defineProperty(navigator, 'connection',
      { value: { saveData: true, effectiveType: '4g' }, configurable: true });
    _arcMem.clear();
    const before = window.__s3count || 0;
    _arcWarm('KFWS');
    _arcWarmAt = 0;
    _arcWarmVisible();
    await new Promise(res => setTimeout(res, 250));
    const budget = _pbFrameBudget();
    if (real) Object.defineProperty(navigator, 'connection', real);
    else delete navigator.connection;
    return { budget };
  });
  ok('save-data turns warming off entirely',
     !s3Requests.some(u => /KFWS|FWS_/.test(u)),
     s3Requests.filter(u => /FWS/.test(u)).join(' '));
  ok('and shrinks the loop to something a phone plan can afford',
     saved.budget <= 12, String(saved.budget));
}

console.log('\n8. the loop that gets built');
{
  const r = await page.evaluate(async () => {
    // Drive the builder with a stubbed decoder, because what is under test
    // here is the SHAPE of the build: parallel, blob-held, token-guarded.
    // The decoder itself has its own tests.
    const realDecode = window._pbDecode;
    const realMesh = window._meshToImage;
    const realNorm = window._l3MeshNormalize;
    let peak = 0, live = 0;
    window._l3MeshNormalize = () => {};
    window._pbDecode = async () => {
      live++; peak = Math.max(peak, live);
      await new Promise(res => setTimeout(res, 25));
      live--;
      return { meshData: {}, metadata: {} };
    };
    const cv = document.createElement('canvas');
    cv.width = cv.height = 8;
    const png = cv.toDataURL('image/png');
    window._meshToImage = () => ({ url: png, leafletBounds: [[35, -98], [36, -97]] });

    _l2LoopReset();
    const blobsBefore = _pbBlobs.size;
    await _l3BucketLoopBuild('KTLX', 'N0B',
      { url: png, leafletBounds: [[35, -98], [36, -97]] }, null);
    const out = {
      peakParallel: peak,
      frames: _l2Loop.frames.length,
      allBlob: _l2Loop.frames.every(f => f.url.startsWith('blob:')),
      sorted: _l2Loop.frames.every((f, i, a) => !i || a[i - 1].time <= f.time),
      grew: _pbBlobs.size > blobsBefore,
    };
    _l2LoopReset();
    out.freedOnReset = _pbBlobs.size <= blobsBefore;
    window._pbDecode = realDecode;
    window._meshToImage = realMesh;
    window._l3MeshNormalize = realNorm;
    return out;
  });
  // The old builder was a for-loop with an await inside: strictly one at a
  // time, measured at 1850 ms of decode per frame.
  ok(`frames decode ${r.peakParallel} at a time, not one`,
     r.peakParallel > 1, String(r.peakParallel));
  // Depth is section 9's subject: what matters here is that a real loop came
  // out of the build at all, rather than one frame and a dead play button.
  ok('a real loop comes out of it, not a single frame',
     r.frames > 12, String(r.frames));
  ok('every frame is held as a blob, including the live one', r.allBlob);
  ok('and they are in time order for the timeline', r.sorted);
  ok('resetting the loop hands every blob back',
     r.grew && r.freedOnReset, JSON.stringify(r));
}

console.log('\n9. depth arrives when it is reached for, not up front');
{
  const r = await page.evaluate(async () => {
    // Measured before this existed: building straight to the device budget
    // took 112 seconds and 76 MB, because every frame is a real file and a
    // real decode. The first build is a few hours deep instead, and the rest
    // of the archive is reached by asking.
    const realDecode = window._pbDecode;
    const realMesh = window._meshToImage;
    const realNorm = window._l3MeshNormalize;
    window._l3MeshNormalize = () => {};
    window._pbDecode = async () => ({ meshData: {}, metadata: {} });
    const cv = document.createElement('canvas');
    cv.width = cv.height = 8;
    const png = cv.toDataURL('image/png');
    window._meshToImage = () => ({ url: png, leafletBounds: [[35, -98], [36, -97]] });

    _l2LoopReset();
    await _l3BucketLoopBuild('KTLX', 'N0B',
      { url: png, leafletBounds: [[35, -98], [36, -97]] }, null);
    const out = { initial: _l2Loop.frames.length, budget: _pbFrameBudget(),
                  cap: PB_INITIAL_FRAMES };

    const oldestBefore = _l2Loop.frames[0].time;
    out.added = await _pbExtendBack(24);
    out.after = _l2Loop.frames.length;
    out.reachesFurtherBack = _l2Loop.frames[0].time < oldestBefore;
    out.stillSorted = _l2Loop.frames.every((f, i, a) => !i || a[i - 1].time <= f.time);

    // It must stop at what the device can hold, however hard it is asked.
    let guard = 0;
    while (_l2Loop.frames.length < out.budget && guard++ < 40) {
      const n = await _pbExtendBack(200);
      if (!n) break;
    }
    out.capped = _l2Loop.frames.length <= out.budget;
    out.grewToBudget = _l2Loop.frames.length;

    _l2LoopReset();
    window._pbDecode = realDecode;
    window._meshToImage = realMesh;
    window._l3MeshNormalize = realNorm;
    return out;
  });
  ok(`the first build is ${r.initial} frames, not the whole ${r.budget}`,
     r.initial <= r.cap + 1 && r.initial < r.budget, JSON.stringify(r));
  ok('reaching back adds frames', r.added > 0 && r.after > r.initial,
     JSON.stringify(r));
  ok('and they really are older ones', r.reachesFurtherBack);
  ok('the timeline stays in order as it grows', r.stillSorted);
  // A loop that grew without limit would be the iOS crash by a slower road.
  ok('and it never grows past what the device can hold',
     r.capped, `${r.grewToBudget} against a budget of ${r.budget}`);

  // Reaching the left-hand end is what asks for more.
  const t = await page.evaluate(() => {
    const calls = [];
    const real = window._pbExtendBack;
    window._pbExtendBack = async (n) => { calls.push(n); return 0; };
    _l2Loop.frames = [1, 2, 3, 4, 5, 6, 7, 8].map(t => ({ url: 'blob:x', time: t }));
    _pbMaybeExtend(7); const far = calls.length;
    _pbMaybeExtend(1); const near = calls.length;
    _l2Loop.frames = [];
    window._pbExtendBack = real;
    return { far, near };
  });
  ok('scrubbing near the start asks for more, scrubbing elsewhere does not',
     t.far === 0 && t.near === 1, JSON.stringify(t));
}

console.log('\n10. nothing threw along the way');
{
  const real = errors.filter(e => !/Failed to fetch|NetworkError|ERR_FAILED|net::/i.test(e));
  ok('no page errors', real.length === 0, real.slice(0, 3).join(' | '));
}

console.log('\n11. house rules');
{
  const src = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const me = readFileSync(join(ROOT, 'tools', 'test-time-machine.mjs'), 'utf8');
  const EM = String.fromCharCode(0x2014);
  ok('no em dash in the new work, this file included',
     !me.includes(EM));
  // The hour-at-a-time walk is what made a loop take two and a half seconds
  // to even find out what it was going to draw.
  ok('the hour-prefix walk is really gone',
     !/prefix=\$\{sid\}_\$\{code\}[\s\S]{0,200}getUTCHours/.test(src));
}

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
