#!/usr/bin/env node
/*
 * StormStream's per-warning rules, the gold broadcast frame, and the
 * reorder arrows.
 *
 *     node tools/test-ss-rules-reorder.mjs
 *
 * Three promises under test:
 *
 *   1. Each warning family can carry its own rule - which radar product
 *      to cut to and which overlays to switch on - written in Settings,
 *      applied when StormStream shows an alert, and undone when the next
 *      alert wants different things or the stream ends. Overlays the
 *      person turned on themselves are never touched.
 *   2. Every reorderable row - overlay pills, the main layer bubbles, and
 *      the product bubbles below them - carries one-tap up/down arrows
 *      that move the row AND save the order, because drag needs a steady
 *      pointer and a phone thumb or a console cursor is not one.
 *   3. The broadcast frame wears gold (#e8b800), not yellow, and every
 *      surface in it is layered with the top-lit sheen gradient.
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
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + String(extra).slice(0, 300) + '>' : '')); }
};

console.log('\n1. the source');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
ok('no em dash anywhere in the page', !html.includes('\u2014'));
ok('the StormStream gold is gold, and the yellow is gone',
   /--ss-gold:\s*#e8b800/.test(html) && !html.includes('#f5cf12'));
ok('the panel wash carries the top-lit sheen',
   /--ss-sheen:/.test(html) && /--ss-rb:\s*var\(--ss-sheen\)/.test(html));
ok('the lower bar frame is a gold gradient, not flat gold',
   /--ss-gold-grad:/.test(html) && /background-image:\s*var\(--ss-gold-grad\)/.test(html));
ok('the coverage-drawing polygon joined the gold',
   !/_ssDrawLayer = L\.polygon\(_ssDrawPts, \{ color: '#ffcc00'/.test(html));
ok('the Per-Warning Setup rows exist in Settings',
   /lqm-ss-rule-type/.test(html) && /lqm-ss-rule-radar/.test(html)
   && /lqm-ss-rule-ovs/.test(html));

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'],
});
const ctx = await browser.newContext();
await ctx.addInitScript(() => {
  try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {}
});
const page = await ctx.newPage();
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
await page.waitForTimeout(3500);

console.log('\n2. writing a rule in Settings');
{
  const r = await page.evaluate(() => {
    lqmOpenSettings();
    const typeSel = document.getElementById('lqm-ss-rule-type');
    const radarSel = document.getElementById('lqm-ss-rule-radar');
    const types = Array.from(typeSel.options).map(o => o.value);
    const radars = Array.from(radarSel.options).map(o => o.value);
    _ssRuleUiPick('tornado');
    const chips = document.querySelectorAll('#lqm-ss-rule-ovs .ss-rule-chip').length;
    radarSel.value = 'velocity'; _ssRuleUiRadar('velocity');
    document.querySelector('.ss-rule-chip[data-ovid="lightning"]').click();
    document.querySelector('.ss-rule-chip[data-ovid="spc-reports"]').click();
    // A second family, to prove rules are kept apart.
    _ssRuleUiPick('flood');
    radarSel.value = 'onehour'; _ssRuleUiRadar('onehour');
    const floodChipsOff = !document.querySelector('#lqm-ss-rule-ovs .ss-rule-chip.on');
    _ssRuleUiPick('tornado');
    const backOn = document.querySelectorAll('#lqm-ss-rule-ovs .ss-rule-chip.on').length;
    lqmCloseSettings();
    const saved = JSON.parse(localStorage.getItem('gwcfc_stormstream') || '{}').rules || {};
    return { types, radars: radars.length, chips, floodChipsOff, backOn, saved };
  });
  ok('every warning family is offered, Everything Else last',
     r.types.length === 7 && r.types[0] === 'tornado' && r.types[6] === 'other',
     r.types.join());
  ok('the radar list holds Auto, Leave as-is, and the real products',
     r.radars >= 10, String(r.radars));
  ok('one overlay chip per overlay pill', r.chips >= 25, String(r.chips));
  ok('each family keeps its own rule',
     r.floodChipsOff && r.backOn === 2, `flood clean: ${r.floodChipsOff}, tornado chips: ${r.backOn}`);
  ok('the rules land in stored config',
     r.saved.tornado && r.saved.tornado.radar === 'velocity'
       && r.saved.tornado.overlays.length === 2
       && r.saved.flood && r.saved.flood.radar === 'onehour',
     JSON.stringify(r.saved));
}

console.log('\n3. the rule drives the map when the alert comes on air');
{
  const r = await page.evaluate(() => {
    const out = {};
    const calls = [];
    const real = window._prSetProduct;
    window._prSetProduct = (k) => calls.push(k);
    const on = (id) => document.querySelector(`.ov-pill[data-ovid="${id}"]`)
      .classList.contains('active');

    // The person already has forecasts on, by their own hand.
    if (!on('forecasts')) toggleOverlayPill('forecasts');
    out.forecastsBefore = on('forecasts');

    _ssApplyRadarForEvent('Tornado Warning');
    out.radar = calls.join(',');
    out.tornadoOn = [on('lightning'), on('spc-reports')];

    // The flood rule wants a different product and no overlays of its own.
    calls.length = 0;
    _ssApplyRadarForEvent('Flash Flood Warning');
    out.floodRadar = calls.join(',');
    out.afterFlood = [on('lightning'), on('spc-reports')];
    out.forecastsAfter = on('forecasts');

    // Back to a tornado, then the stream ends: everything borrowed returns.
    _ssApplyRadarForEvent('Tornado Warning');
    _ssClearRuleOverlays();
    out.afterStop = [on('lightning'), on('spc-reports')];
    out.forecastsAfterStop = on('forecasts');
    window._prSetProduct = real;
    // Tidy the person's own overlay back off for later sections.
    if (on('forecasts')) toggleOverlayPill('forecasts');
    return out;
  });
  ok('the tornado rule pins its radar product', r.radar === 'velocity', r.radar);
  ok('and switches its overlays on', r.tornadoOn.every(Boolean), r.tornadoOn.join());
  ok('the flood rule gets its own product', r.floodRadar === 'onehour', r.floodRadar);
  ok('and takes back the tornado\'s overlays', r.afterFlood.every(v => !v),
     r.afterFlood.join());
  ok('the stream ending returns everything borrowed',
     r.afterStop.every(v => !v), r.afterStop.join());
  ok('but an overlay the person chose is never touched',
     r.forecastsBefore && r.forecastsAfter && r.forecastsAfterStop);
}

console.log('\n4. auto still steps a tornado, and keep means keep');
{
  const r = await page.evaluate(() => {
    const calls = [];
    const real = window._prSetProduct;
    window._prSetProduct = (k) => calls.push(k);
    _ssRuleGet('tornado').radar = 'auto';
    _ssApplyRadarForEvent('Tornado Warning');
    const auto = calls.slice();
    calls.length = 0;
    _ssRuleGet('tornado').radar = 'keep';
    _ssApplyRadarForEvent('Tornado Warning');
    const kept = calls.slice();
    // Restore the velocity rule so nothing later is surprised.
    _ssRuleGet('tornado').radar = 'velocity'; _ssSave();
    _ssRadarStepTimers.forEach(t => clearTimeout(t));
    window._prSetProduct = real;
    return { auto, kept };
  });
  ok('Auto opens on reflectivity, with the stepping timers armed',
     r.auto[0] === 'reflectivity', r.auto.join());
  ok('Leave as-is touches nothing', r.kept.length === 0, r.kept.join());
}

console.log('\n5. one-tap reorder arrows, everywhere rows can be reordered');
{
  const r = await page.evaluate(() => {
    const out = {};
    document.getElementById('overlay-toggle-btn').click();
    const pills = Array.from(document.querySelectorAll('#overlay-pills-row .ov-pill[data-ovid]'));
    out.pillArrows = pills.every(p => p.querySelectorAll('.ov-nudge').length === 2);
    const secondId = pills[1].dataset.ovid;
    pills[1].querySelector('.ov-nudge').click();
    out.pillMoved = document.querySelector('#overlay-pills-row .ov-pill[data-ovid]')
      .dataset.ovid === secondId;
    out.pillSaved = JSON.parse(localStorage.getItem('gwcfc_overlay_order'))[0] === secondId;
    // And back down, so the order is restored and the down arrow is proven.
    document.querySelectorAll('#overlay-pills-row .ov-pill[data-ovid]')[0]
      .querySelectorAll('.ov-nudge')[1].click();
    out.pillBack = document.querySelector('#overlay-pills-row .ov-pill[data-ovid]')
      .dataset.ovid !== secondId;

    const mains = Array.from(document.querySelectorAll('#sub-bubbles .sub-bubble-main'));
    out.mainArrows = mains.length > 1 && mains.every(m => m.querySelectorAll('.sb-nudge').length === 2);
    const secondMain = mains[1].id;
    mains[1].querySelector('.sb-nudge').click();
    out.mainMoved = document.querySelectorAll('#sub-bubbles .sub-bubble-main')[0].id === secondMain;
    out.mainSaved = JSON.parse(localStorage.getItem('gwcfc_bubble_order'))[0]
      === secondMain.replace(/^sub-/, '');
    document.querySelectorAll('#sub-bubbles .sub-bubble-main')[0]
      .querySelectorAll('.sb-nudge')[1].click();
    return out;
  });
  ok('every overlay pill carries both arrows', r.pillArrows);
  ok('up moves the pill up and saves the order', r.pillMoved && r.pillSaved);
  ok('down brings it back', r.pillBack);
  ok('every layer bubble carries both arrows', r.mainArrows);
  ok('and they move and save too', r.mainMoved && r.mainSaved);
}

console.log('\n6. the arrows reach the product bubbles below the top level');
{
  const r = await page.evaluate(async () => {
    toggleRadarSub();
    await new Promise(res => setTimeout(res, 250));
    await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
    const rows = _sbRows();
    const out = { n: rows.length,
      arrows: rows.length > 1 && rows.every(r2 => r2.querySelectorAll('.sb-nudge').length === 2) };
    if (rows.length >= 2) {
      const secondKey = _sbRowKey(rows[1]);
      rows[1].querySelector('.sb-nudge').click();
      out.moved = _sbRowKey(_sbRows()[0]) === secondKey;
      out.saved = (_sbLoadOrder(_sbCtxKey()) || [])[0] === secondKey;
      _sbRows()[0].querySelectorAll('.sb-nudge')[1].click();   // put it back
    }
    const wrap = document.getElementById('sub-bubbles');
    wrap.innerHTML = ''; wrap.style.display = 'none'; wrap.dataset.mode = '';
    return out;
  });
  ok('the product rows grew arrows through the decorator', r.arrows, String(r.n));
  ok('a tap moves the product and saves its menu\'s order', r.moved && r.saved);
}

console.log('\n7. the frame on air is gold and gradient');
{
  const r = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return {
      gold: cs.getPropertyValue('--ss-gold').trim(),
      sheenInWash: cs.getPropertyValue('--ss-rb').includes('180deg')
        && cs.getPropertyValue('--ss-rb').includes('90deg'),
      goldGrad: cs.getPropertyValue('--ss-gold-grad').includes('linear-gradient'),
    };
  });
  ok('the outline color is the gold, #e8b800', r.gold === '#e8b800', r.gold);
  ok('every panel wash is two layers: sheen over the red/blue', r.sheenInWash);
  ok('the gold surfaces are gradients of gold', r.goldGrad);
}

console.log('\n8. nothing threw');
ok('no uncaught page errors', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
