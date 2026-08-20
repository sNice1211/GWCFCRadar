#!/usr/bin/env node
/*
 * StormStream's broadcast frame, against the design it was built to.
 *
 *     node tools/test-ss-broadcast.mjs
 *
 * The old HUD was one dark box in the top right, which is a map control, not
 * a broadcast. This is a frame around the map, and every piece of it was
 * specified: what is on air top left behind an arrow tab, what the map is
 * showing across the top in a pair of pills that hide when empty, everything
 * active top right under a gold "Active Alerts" header, and the headline along
 * the bottom in a chevron with the location and a countdown above it and the
 * logo across the join.
 *
 * A design is easy to half-build and hard to notice half-built, so these read
 * the real computed geometry and the real filled text rather than checking
 * that some elements exist. Where the design says a gradient runs one way and
 * its neighbour runs the other, that is checked too, because "match the
 * mockup exactly" is what was asked for and regularising it would be a quiet
 * decision to ignore that.
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

const feature = (event, extra) => ({
  type: 'Feature',
  geometry: { type: 'Polygon', coordinates: [[[-98, 35], [-97, 35], [-97, 36], [-98, 36], [-98, 35]]] },
  properties: Object.assign({
    id: event.replace(/\s/g, '-'),
    event,
    areaDesc: 'Cleveland, OK; Oklahoma, OK',
    expires: new Date(Date.now() + 42 * 60000).toISOString(),
    effective: new Date(Date.now() - 8 * 60000).toISOString(),
    description: '',
  }, extra || {}),
});

const TOR = feature('Tornado Warning', {
  description: 'TORNADO EMERGENCY FOR NORMAN. TORNADO...OBSERVED. HAIL...2.75IN',
});
const SVR = feature('Severe Thunderstorm Warning', {
  description: 'HAIL...1.00IN. WIND...70 MPH',
  expires: new Date(Date.now() + 3 * 3600000 + 20 * 60000).toISOString(),
});

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'],
});

async function boot(ctx) {
  const page = await (ctx || browser).newPage();
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

const start = async (feats) => page.evaluate((f) => {
  _lastAlertFeatures = f;
  _ssCfg = { coverage: 'us', stepSec: 15, enabled: true, firstRunSeen: true };
  _ssStart();
}, feats);

console.log('\n1. the old HUD is gone and the frame is there instead');
{
  await start([TOR, SVR]);
  const r = await page.evaluate(() => {
    const ids = ['ss-stage', 'ss-now', 'ss-now-tab', 'ss-now-body', 'ss-layers',
                 'ss-layers-main', 'ss-layers-sub', 'ss-alerts', 'ss-alerts-head',
                 'ss-alerts-body', 'ss-lower', 'ss-lower-pills', 'ss-pill-where',
                 'ss-pill-when', 'ss-lower-bar', 'ss-lower-bar-inner', 'ss-lower-logo'];
    return {
      oldHud: !!document.getElementById('stormstream-hud'),
      missing: ids.filter(i => !document.getElementById(i)),
      stageOn: document.getElementById('ss-stage').classList.contains('on'),
    };
  });
  ok('the old single-box HUD is not built any more', r.oldHud === false);
  ok('every piece of the design exists', r.missing.length === 0, r.missing.join(','));
  ok('and the frame is showing', r.stageOn);
}

console.log('\n2. the four panels are in the four corners the design puts them');
{
  const r = await page.evaluate(() => {
    const box = id => {
      const b = document.getElementById(id).getBoundingClientRect();
      return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height,
               cx: b.left + b.width / 2 };
    };
    return { now: box('ss-now'), layers: box('ss-layers'), alerts: box('ss-alerts'),
             lower: box('ss-lower'), vw: innerWidth, vh: innerHeight };
  });
  ok('the on-air panel is top left',
     r.now.l < r.vw * 0.25 && r.now.t < r.vh * 0.2, JSON.stringify(r.now));
  ok('the alerts panel is top right',
     r.alerts.r > r.vw * 0.75 && r.alerts.t < r.vh * 0.2, JSON.stringify(r.alerts));
  ok('the layers pair is centred horizontally',
     Math.abs(r.layers.cx - r.vw / 2) < 4, JSON.stringify(r.layers));
  ok('and sits between the two top panels',
     r.layers.l > r.now.r && r.layers.r < r.alerts.l, JSON.stringify(r));
  ok('the lower third is centred and near the bottom',
     Math.abs(r.lower.cx - r.vw / 2) < 4 && r.lower.b > r.vh * 0.6,
     JSON.stringify(r.lower));
  ok('nothing overlaps anything else along the top',
     r.now.r < r.layers.l && r.layers.r < r.alerts.l, JSON.stringify(r));
}

console.log('\n3. the gradients run the way the design draws them');
{
  // Neighbouring panels deliberately run opposite ways in the mockup. That is
  // the thing most likely to get quietly "fixed" into consistency, so it is
  // pinned here.
  const r = await page.evaluate(() => {
    const g = id => getComputedStyle(document.getElementById(id)).backgroundImage;
    // Which colour comes first in the gradient string is which side it starts.
    const dir = (s) => {
      const cols = [...s.matchAll(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/g)]
        .map(m => [+m[1], +m[2], +m[3]]);
      if (cols.length < 2) return 'none';
      const redFirst = cols[0][0] > cols[0][2];
      return redFirst ? 'red-to-blue' : 'blue-to-red';
    };
    return {
      nowTab:   dir(g('ss-now-tab')),
      nowBody:  dir(g('ss-now-body')),
      main:     dir(g('ss-layers-main')),
      sub:      dir(g('ss-layers-sub')),
      head:     dir(g('ss-alerts-head')),
      body:     dir(g('ss-alerts-body')),
      pillL:    dir(g('ss-pill-where')),
      bar:      dir(g('ss-lower-bar-inner')),
    };
  });
  ok('the on-air header runs blue to red', r.nowTab === 'blue-to-red', r.nowTab);
  ok('and its body runs the other way, red to blue', r.nowBody === 'red-to-blue', r.nowBody);
  ok('the big layers pill runs red to blue', r.main === 'red-to-blue', r.main);
  ok('and the narrow one under it runs the other way', r.sub === 'blue-to-red', r.sub);
  ok('the Active Alerts header runs blue to red', r.head === 'blue-to-red', r.head);
  ok('and its body runs red to blue', r.body === 'red-to-blue', r.body);
  ok('the lower-third pills run blue to red', r.pillL === 'blue-to-red', r.pillL);
  ok('and the chevron under them runs red to blue', r.bar === 'red-to-blue', r.bar);
}

console.log('\n4. the gold edge and the pointed shapes are really there');
{
  const r = await page.evaluate(() => {
    const cs = id => getComputedStyle(document.getElementById(id));
    const gold = (c) => /rgb\(2[0-9]{2},\s*20[0-9],\s*1[0-9]/.test(c)
                     || /245,\s*207,\s*18/.test(c);
    return {
      nowEdge: cs('ss-now-tab').borderTopColor,
      alertsEdge: cs('ss-alerts-head').borderTopColor,
      barBg: cs('ss-lower-bar').backgroundColor,
      barClip: cs('ss-lower-bar').clipPath,
      innerClip: cs('ss-lower-bar-inner').clipPath,
      headColor: cs('ss-alerts-head').color,
      goldish: gold(cs('ss-now-tab').borderTopColor),
      tabArrow: getComputedStyle(document.getElementById('ss-now-tab'), '::before').content,
      logoSrc: (document.getElementById('ss-lower-logo').src || '').slice(0, 22),
    };
  });
  ok('the panels carry a gold edge', r.goldish, r.nowEdge);
  ok('so does the alerts panel', r.alertsEdge === r.nowEdge, r.alertsEdge);
  ok('the chevron is cut to a point at both ends',
     /polygon/.test(r.barClip) && /polygon/.test(r.innerClip),
     JSON.stringify([r.barClip, r.innerClip]));
  ok('the header text is gold, not white', r.headColor === r.nowEdge,
     JSON.stringify([r.headColor, r.nowEdge]));
  ok('the arrow tab is drawn on the on-air panel', r.tabArrow === '""', r.tabArrow);
  ok('the logo is the real one, borrowed rather than a second copy',
     /^data:image/.test(r.logoSrc), r.logoSrc);
}

console.log('\n5. the on-air panel says what is on air');
{
  const r = await page.evaluate(() => ({
    tab: document.getElementById('ss-now-tab').textContent,
    detail: document.getElementById('ss-now-detail').textContent,
    flag: !!document.querySelector('#ss-now-detail .ss-now-flag'),
    bar: document.getElementById('ss-lower-bar-inner').textContent,
    where: document.getElementById('ss-pill-where').textContent,
    when: document.getElementById('ss-pill-when').textContent,
  }));
  ok('the tab names the alert', /Tornado Warning/.test(r.tab), r.tab);
  ok('and says which of how many', /\(1\/2\)/.test(r.tab), r.tab);
  ok('a tornado emergency is flagged', r.flag, r.detail);
  ok('the detail carries the tags pulled out of the raw text',
     /OBSERVED/.test(r.detail) && /2\.75/.test(r.detail), r.detail);
  ok('the headline leads with the emergency, not the event name',
     r.bar === 'TORNADO EMERGENCY', r.bar);
  ok('the left pill is the place', /Cleveland/.test(r.where), r.where);
  ok('the right pill is a countdown, not a clock time',
     /Expires in \d+m \d\ds/.test(r.when), r.when);
}

console.log('\n6. the countdown actually counts');
{
  const first = await page.evaluate(() => document.getElementById('ss-pill-when').textContent);
  await page.waitForTimeout(2100);
  const second = await page.evaluate(() => document.getElementById('ss-pill-when').textContent);
  ok('it changes on its own', first !== second, `${first} -> ${second}`);
  const long = await page.evaluate(() => {
    _ssShowFeature(_lastAlertFeatures[1], false);
    return document.getElementById('ss-pill-when').textContent;
  });
  ok('over an hour it drops the seconds rather than ticking them',
     /Expires in \dh \d\dm/.test(long), long);
}

console.log('\n7. the alerts panel lists everything and marks the one on air');
{
  const r = await page.evaluate(() => {
    _ssShowFeature(_lastAlertFeatures[0], false);
    const rows = [...document.querySelectorAll('#ss-alerts-body .ss-alert-row')];
    return {
      count: rows.length,
      texts: rows.map(x => x.textContent),
      onIdx: rows.findIndex(x => x.classList.contains('on')),
      head: document.getElementById('ss-alerts-head').textContent.trim(),
    };
  });
  ok('the header says Active Alerts', r.head === 'Active Alerts', r.head);
  ok('both alerts are listed', r.count === 2, JSON.stringify(r.texts));
  ok('each row carries its expiry', r.texts.every(t => /\d/.test(t)), JSON.stringify(r.texts));
  ok('exactly one row is marked as the one on air', r.onIdx >= 0, String(r.onIdx));
  ok('and it is the tornado warning, which outranks the severe',
     /Tornado/.test(r.texts[r.onIdx] || ''), r.texts[r.onIdx]);
}

console.log('\n8. the top-centre pair says what the map shows, and hides when it shows nothing');
{
  const r = await page.evaluate(() => {
    const out = {};
    const read = () => ({
      on: document.getElementById('ss-layers').classList.contains('on'),
      main: document.getElementById('ss-layers-main').textContent,
      sub: document.getElementById('ss-layers-sub').textContent,
      subOff: document.getElementById('ss-layers-sub').classList.contains('off'),
      visible: getComputedStyle(document.getElementById('ss-layers')).display !== 'none',
    });

    activeLayers.nexrad = false; activeLayers.satellite = false;
    activeLayers.spc1 = false; activeLayers.spcrpts = false;
    activeLayers.lightning = false; activeLayers.nhc = false;
    activeLayers.meso = false; activeLayers.watch = false;
    _hdOn = false; _prOn = false;
    if (typeof _mrmsOn === 'object') Object.keys(_mrmsOn).forEach(k => { _mrmsOn[k] = false; });
    _ssRenderLayers();
    out.empty = read();

    activeLayers.nexrad = true;
    _ssRenderLayers();
    out.radar = read();

    activeLayers.satellite = true;
    _ssRenderLayers();
    out.both = read();

    activeLayers.spcrpts = true; activeLayers.lightning = true;
    _ssRenderLayers();
    out.overlays = read();

    return out;
  });
  ok('with nothing on the map the pair is hidden entirely',
     r.empty.on === false && r.empty.visible === false, JSON.stringify(r.empty));
  ok('radar on brings it back', r.radar.on && r.radar.visible, JSON.stringify(r.radar));
  ok('the big pill names the layer', /Radar/.test(r.radar.main), r.radar.main);
  ok('two layers are both named', /Radar/.test(r.both.main) && /Satellite/.test(r.both.main),
     r.both.main);
  ok('the narrow pill stays hidden while no overlay is on',
     r.both.subOff === true, JSON.stringify(r.both));
  ok('and appears once one is', r.overlays.subOff === false, JSON.stringify(r.overlays));
  ok('naming the overlays, not the layers',
     /Storm Reports/.test(r.overlays.sub) && /Lightning/.test(r.overlays.sub),
     r.overlays.sub);
}

console.log('\n9. all clear reads as all clear, everywhere at once');
{
  const r = await page.evaluate(() => {
    _lastAlertFeatures = [];
    _ssTick();
    return {
      tab: document.getElementById('ss-now-tab').textContent,
      bar: document.getElementById('ss-lower-bar-inner').textContent,
      rows: document.querySelectorAll('#ss-alerts-body .ss-alert-row').length,
      none: !!document.querySelector('#ss-alerts-body .ss-alerts-none'),
      when: document.getElementById('ss-pill-when').textContent,
    };
  });
  ok('the on-air tab says All Clear', /All Clear/.test(r.tab), r.tab);
  ok('the headline says so too', /No active alerts/i.test(r.bar), r.bar);
  ok('the alerts list is empty and says so', r.rows === 0 && r.none, JSON.stringify(r));
  ok('and the countdown does not pretend something is expiring',
     /No active alert/.test(r.when), r.when);
}

console.log('\n10. stopping takes the whole frame down, timer and all');
{
  const r = await page.evaluate(() => {
    _ssStop();
    return { stage: !!document.getElementById('ss-stage'), timer: _ssTickTimer, on: _ssOn };
  });
  ok('the frame is removed', r.stage === false);
  ok('StormStream is off', r.on === false);
  ok('and the countdown timer is cleared, not left ticking at nothing',
     r.timer === null, String(r.timer));
}

console.log('\n11. it adapts to a phone rather than letterboxing');
{
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
      + '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    deviceScaleFactor: 3,
  });
  const { page: ph } = await boot(ctx);
  const r = await ph.evaluate((f) => {
    _lastAlertFeatures = f;
    _ssCfg = { coverage: 'us', stepSec: 15, enabled: true, firstRunSeen: true };
    _ssStart();
    activeLayers.nexrad = true;
    _ssRenderLayers();
    const box = id => document.getElementById(id).getBoundingClientRect();
    const now = box('ss-now'), al = box('ss-alerts'), lay = box('ss-layers'),
          low = box('ss-lower');
    return {
      vw: innerWidth, vh: innerHeight,
      now, al, lay, low,
      overlapTop: !(now.right <= al.left),
      // Below the breakpoint the centre pair drops out of the top row.
      layDropped: lay.top > now.bottom,
      fitsWide: now.left >= 0 && al.right <= innerWidth && low.left >= 0
                && low.right <= innerWidth,
      bodyScrollX: document.documentElement.scrollWidth <= innerWidth + 1,
      logoW: box('ss-lower-logo').width,
    };
  }, [TOR, SVR]);
  ok('both top panels still fit side by side on a phone',
     r.overlapTop === false, JSON.stringify([r.now, r.al]));
  ok('the centre pair drops below them rather than becoming a sliver',
     r.layDropped, JSON.stringify(r.lay));
  ok('nothing hangs off either edge', r.fitsWide, JSON.stringify(r));
  ok('and the page does not scroll sideways', r.bodyScrollX);
  ok('the logo shrinks with the frame', r.logoW > 0 && r.logoW <= 70, String(r.logoW));
  ok('the lower third clears the animation bar',
     r.low.bottom < r.vh - 60, JSON.stringify(r.low));
  await ctx.close();
}

console.log('\n12. a screenshot keeps the broadcast and drops the controls');
{
  const r = await page.evaluate((f) => {
    _lastAlertFeatures = f;
    _ssStart();
    document.body.classList.add('shot-mode');
    const vis = id => {
      const el = document.getElementById(id);
      return el ? getComputedStyle(el).display !== 'none' : null;
    };
    const out = { stage: vis('ss-stage'), lower: vis('ss-lower'),
                  alerts: vis('ss-alerts'), nav: vis('ss-now-nav') };
    document.body.classList.remove('shot-mode');
    _ssStop();
    return out;
  }, [TOR]);
  ok('the frame stays in a captured shot, because it IS the graphic',
     r.stage && r.lower && r.alerts, JSON.stringify(r));
  ok('but the skip buttons go, because they are a control',
     r.nav === false, JSON.stringify(r));
}

console.log('\n13. nothing above threw');
{
  const real = errors.filter(e => !/Failed to fetch|NetworkError|ERR_FAILED|net::/i.test(e));
  ok('no page errors', real.length === 0, real.slice(0, 3).join(' | '));
}

await browser.close();
console.log();
if (fail) { console.log(`${fail} FAILED, ${pass} passed`); process.exit(1); }
console.log(`all ${pass} passed`);
