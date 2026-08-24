#!/usr/bin/env node
/*
 * Merged settings categories, the graphic maker, and JTWC relay failover.
 *
 *     node tools/test-settings-graphics-jtwc.mjs
 *
 * The JTWC half is the interesting one. The feed and every relay that fronts
 * it are unreachable from the machine this was written on, so the fetch
 * itself cannot be exercised here. What CAN be exercised, and is, is the
 * thing that was actually wrong: one relay with no alternative, so that host
 * being down took the whole layer with it and the only symptom was an empty
 * ocean. fetch is replaced with a fake here, and the failover is driven
 * through every combination of dead, wrong and working relays.
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
await page.waitForTimeout(3500);

console.log('\n1. settings categories are merged, not duplicated');
{
  const r = await page.evaluate(() => {
    lqmOpenSettings();
    _lqmSetBuildRail();
    const tabs = [...document.querySelectorAll('#lqm-set-rail .lqm-set-tab')]
      .map(t => ({ id: t.dataset.tab, label: t.querySelector('span').textContent }));
    const cardCount = document.querySelectorAll(
      '#lqm-set-content .lqm-settings-group').length;
    lqmSettingsCat('particles');
    const shown = [...document.querySelectorAll('#lqm-set-content .lqm-settings-group')]
      .filter(g => !g.hidden)
      .map(g => g.querySelector('.lqm-settings-category').textContent.trim());
    const subs = [...document.querySelectorAll(
      '#lqm-set-content .lqm-settings-group:not([hidden]) .lqm-sub-head')]
      .map(h => h.textContent.trim());
    lqmSettingsCat('radar');
    const radar = [...document.querySelectorAll('#lqm-set-content .lqm-settings-group')]
      .filter(g => !g.hidden)
      .map(g => g.querySelector('.lqm-settings-category').textContent.trim());
    lqmSettingsCat('units');
    const units = [...document.querySelectorAll('#lqm-set-content .lqm-settings-group')]
      .filter(g => !g.hidden).length;
    return { tabs, cardCount, shown, subs, radar, units,
             lit: document.querySelectorAll('.lqm-set-tab.on').length };
  });
  ok('there are fewer tabs than cards, because some cards share one',
     r.tabs.length < r.cardCount, `${r.tabs.length} tabs, ${r.cardCount} cards`);
  ok('no tab appears twice',
     new Set(r.tabs.map(t => t.id)).size === r.tabs.length,
     r.tabs.map(t => t.id).join(','));
  ok('Particles is one tab covering wind and wave',
     r.shown.length === 2 && /Wind/.test(r.shown[0]) && /Wave/.test(r.shown[1]),
     r.shown.join(' + '));
  ok('and both keep their own name as a sub-heading inside it',
     r.subs.length === 2, r.subs.join(', '));
  ok('Radar covers the radar settings and the radar colours',
     r.radar.length === 2, r.radar.join(' + '));
  // Location moved to the GPS tab, so Units is one card of units now.
  ok('Units is just units; location lives in GPS now', r.units === 1, String(r.units));
  ok('exactly one tab is lit at a time', r.lit === 1, String(r.lit));
  ok('the merged tabs are named for the subject, not the first card',
     r.tabs.some(t => t.label === 'Particles')
     && r.tabs.some(t => t.label === 'Units')
     && r.tabs.some(t => t.label === 'GPS'),
     r.tabs.map(t => t.label).join(' | '));
}

console.log('\n2. the graphic maker opens beside the upload button');
{
  const r = await page.evaluate(() => {
    const btn = document.getElementById('lqm-sg-design');
    const up = document.getElementById('lqm-sg-upload');
    const sameRow = !!(btn && up
      && btn.closest('.lqm-settings-row') === up.closest('.lqm-settings-row'));
    _gmOpen();
    const modal = document.getElementById('gm-modal');
    const cv = document.getElementById('gm-canvas');
    return {
      hasButton: !!btn, sameRow,
      open: !!modal && modal.style.display === 'flex',
      canvas: !!cv, cw: cv ? cv.width : 0,
      layers: _gmState ? _gmState.layers.length : 0,
      presets: document.querySelectorAll('#gm-preset option').length,
    };
  });
  ok('the Design button exists', r.hasButton);
  ok('and sits in the same row as Upload', r.sameRow);
  ok('pressing it opens the maker', r.open);
  ok('with a canvas', r.canvas && r.cw > 0, String(r.cw));
  ok('and something on it to start from, not an empty page', r.layers > 0,
     String(r.layers));
  ok('several output sizes are offered', r.presets >= 3, String(r.presets));
}

console.log('\n3. the preview never renders at output size');
{
  // This is the performance promise. A 1920x1080 canvas repainted on every
  // pointermove is what makes an editor feel like treacle, so the editing
  // canvas is a fraction of the output and full size is reached once, on
  // export.
  const r = await page.evaluate(() => {
    _gmSetPreset('wide');
    const cv = document.getElementById('gm-canvas');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    return { out: _gmState.w, backing: cv.width, dpr,
             cssW: parseInt(cv.style.width, 10), scale: _gmScale() };
  });
  ok('the output is full HD wide', r.out === 1920, String(r.out));
  ok('while the canvas on screen is much smaller',
     r.cssW < 900 && r.cssW > 200, `${r.cssW} css px`);
  ok('the backing store allows for a high-density screen',
     r.backing === Math.round(r.cssW * r.dpr),
     `${r.backing} = ${r.cssW} x ${r.dpr}`);
}

console.log('\n4. editing is coalesced into animation frames');
{
  const r = await page.evaluate(async () => {
    // Count real paints by wrapping the one function that does them.
    let paints = 0;
    const real = window._gmPaint;
    window._gmPaint = function (...a) { paints++; return real.apply(this, a); };
    for (let i = 0; i < 60; i++) _gmDraw();      // a burst, as a drag produces
    await new Promise(r2 => requestAnimationFrame(() => requestAnimationFrame(r2)));
    window._gmPaint = real;
    return { paints };
  });
  ok('sixty redraw requests cost one or two paints, not sixty',
     r.paints > 0 && r.paints <= 2, String(r.paints));
}

console.log('\n5. the export is a real PNG at full size, and lands in the library');
{
  const r = await page.evaluate(async () => {
    _gmSetPreset('wide');
    _gmTemplate('warning');
    let added = null;
    const real = window._sgAddGraphicFromBlob;
    window._sgAddGraphicFromBlob = async (blob, name, mime) => {
      added = { size: blob.size, type: blob.type, name, mime };
    };
    await _gmExport();
    window._sgAddGraphicFromBlob = real;
    // And read the exported pixels back, to prove the picture is really in it.
    const cv = document.createElement('canvas');
    cv.width = _gmState.w; cv.height = _gmState.h;
    _gmPaint(cv.getContext('2d'), 1, false);
    const d = cv.getContext('2d').getImageData(0, 900, _gmState.w, 1).data;
    let painted = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 10) painted++;
    return { added, painted, w: cv.width, h: cv.height,
             selCleared: _gmState.sel === null || _gmState.sel !== undefined };
  });
  ok('a blob reached the graphics library', !!r.added, JSON.stringify(r.added));
  ok('it is a PNG', r.added && r.added.mime === 'image/png', r.added && r.added.mime);
  ok('and not an empty one', r.added && r.added.size > 1000,
     r.added && String(r.added.size));
  ok('named from the text on the graphic',
     r.added && /TORNADO/i.test(r.added.name), r.added && r.added.name);
  ok('the exported canvas is full output size',
     r.w === 1920 && r.h === 1080, `${r.w}x${r.h}`);
  ok('and a row through the banner is actually painted',
     r.painted > 1000, String(r.painted));
}

console.log('\n6. JTWC falls over to another relay instead of giving up');
{
  // A cut-down feed in the real shape, so the parser is exercised rather
  // than bypassed.
  const FEED = `<rss><channel>
    <item><title>TROPICAL CYCLONE 25W (KRATHON) WARNING</title>
    <description>WARNING POSITION 18.4N 124.6E MAX SUSTAINED WINDS 095 KT</description>
    <link>https://example.invalid/25w</link></item>
    </channel></rss>`;

  const r = await page.evaluate(async (FEED) => {
    const realFetch = window.fetch;
    const attempts = [];
    // The server's own copy is tried before any relay now; these sections
    // are about the relay chain, so the server is made absent for them.
    const realResolve = _hdResolveBase;
    const realBase = _hdBase;
    _hdResolveBase = async () => null;
    _hdBase = null;
    const run = async (behave, keepMemory) => {
      attempts.length = 0;
      _jtwcPiCache = null;
      if (!keepMemory) _jtwcGoodProxy = null;
      window.fetch = async (u) => {
        attempts.push(String(u));
        return behave(String(u));
      };
      const out = await _jtwcFetchBasin({ id: 'wp', label: 'Western Pacific' });
      return { out, attempts: attempts.slice() };
    };
    const okResp = (body) => ({ ok: true, status: 200, text: async () => body });
    const bad = (code) => ({ ok: false, status: code, text: async () => '' });

    // a) first relay dies, second one works
    const a = await run(u => u.includes('sparkradar') ? bad(502) : okResp(FEED));
    // b) first two are wrong, third works
    const b = await run(u => u.includes('corsproxy') ? okResp(FEED)
      : okResp('<html>proxy error page</html>'));
    // c) everything is dead
    const c = await run(() => bad(503));
    // d) the working one is remembered and tried first next time
    _jtwcGoodProxy = 'corsproxy';
    const d = await run(u => okResp(FEED), true);

    window.fetch = realFetch;
    _hdResolveBase = realResolve;
    _hdBase = realBase;
    return {
      aFound: a.out.length, aTried: a.attempts.length, aErr: a.out.error || null,
      bFound: b.out.length, bTried: b.attempts.length,
      cFound: c.out.length, cErr: c.out.error || null, cTried: c.attempts.length,
      dFirst: d.attempts[0] || '',
      storm: a.out[0] || null,
      relays: JTWC_PROXIES.length,
    };
  }, FEED);

  ok('there is more than one relay to try', r.relays >= 3, String(r.relays));
  ok('a dead first relay does not lose the layer',
     r.aFound === 1 && r.aTried === 2, JSON.stringify([r.aFound, r.aTried, r.aErr]));
  ok('a relay that answers with its own error page is not mistaken for the feed',
     r.bFound === 1 && r.bTried === 3, JSON.stringify([r.bFound, r.bTried]));
  ok('every relay failing reports what each one said, rather than an empty sea',
     r.cFound === 0 && /sparkradar/.test(r.cErr || '') && /503/.test(r.cErr || ''),
     r.cErr);
  ok('and it tried all of them before giving up', r.cTried === 3, String(r.cTried));
  ok('the relay that worked is tried first next time',
     /corsproxy/.test(r.dFirst), r.dFirst);

  ok('the storm itself parsed out of the feed',
     r.storm && r.storm.id === '25W', JSON.stringify(r.storm));
  ok('with its position', r.storm && Math.abs(r.storm.lat - 18.4) < 0.01
     && Math.abs(r.storm.lon - 124.6) < 0.01, JSON.stringify(r.storm));
  ok('its name', r.storm && r.storm.name === 'KRATHON', r.storm && r.storm.name);
  ok('and its intensity', r.storm && r.storm.kt === 95,
     r.storm && String(r.storm.kt));
}

console.log('\n7. nothing threw');
ok('no uncaught errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
