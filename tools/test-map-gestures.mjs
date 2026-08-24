#!/usr/bin/env node
/*
 * Double tapping the map, and where the Alert Desk lives.
 *
 *     node tools/test-map-gestures.mjs
 *
 * The double tap is the interesting half. It used to be wired to the
 * browser's own dblclick event, which a touch screen does not reliably
 * produce, so the feature was invisible on exactly the device it was built
 * for. The gesture is measured here now, and this drives it as a real
 * sequence of pointer events rather than asking the page whether it thinks
 * it is listening.
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
// The whole point of the rewrite: no longer waiting on an event a touch
// screen may never send.
ok('the touch path does not depend on the browser firing dblclick',
   /pointerup/.test(html) && /CM_TAP_MS/.test(html));
ok('the mouse keeps its zoom unless the setting says otherwise',
   /lqm_dbltapmenu/.test(html) && /doubleClickZoom/.test(html));

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'],
});
const ctx = await browser.newContext({ hasTouch: true });
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

// Fires one touch-style tap at a point on the map, exactly as a finger does:
// a pointerup carrying pointerType 'touch'.
await page.evaluate(() => {
  window.__tap = (x, y) => {
    const c = map.getContainer();
    const r = c.getBoundingClientRect();
    c.dispatchEvent(new PointerEvent('pointerup', {
      pointerType: 'touch', bubbles: true, cancelable: true,
      clientX: r.left + x, clientY: r.top + y,
    }));
  };
  window.__menuOpen = () =>
    !!(document.getElementById('map-ctx-menu')
       && document.getElementById('map-ctx-menu').classList.contains('open'));
  window.__closeMenu = () => { if (typeof _cmClose === 'function') _cmClose(); };
});

console.log('\n2. a double tap opens the menu');
{
  const r = await page.evaluate(async () => {
    __closeMenu();
    const before = __menuOpen();
    __tap(300, 300);
    const afterOne = __menuOpen();
    await new Promise(r2 => setTimeout(r2, 90));
    __tap(304, 297);
    const afterTwo = __menuOpen();
    const el = document.getElementById('map-ctx-menu');
    return {
      before, afterOne, afterTwo,
      hasCoords: /\d+\.\d{4}/.test((el && el.textContent) || ''),
      items: el ? el.querySelectorAll('.cm-item').length : 0,
    };
  });
  ok('nothing is open to start with', r.before === false);
  ok('one tap does not open it', r.afterOne === false);
  ok('two taps in quick succession do', r.afterTwo === true);
  ok('it carries the coordinates of the spot tapped', r.hasCoords);
  ok('and the full menu, not a stub', r.items >= 6, r.items);
}

console.log('\n3. two taps that are not a double tap');
{
  const r = await page.evaluate(async () => {
    __closeMenu();
    // Too slow to be one gesture.
    __tap(200, 200);
    await new Promise(r2 => setTimeout(r2, 600));
    __tap(200, 200);
    const slow = __menuOpen();

    __closeMenu();
    // Fast enough, but a long way apart: two separate taps, not a double.
    __tap(150, 150);
    await new Promise(r2 => setTimeout(r2, 60));
    __tap(320, 150);
    const far = __menuOpen();

    __closeMenu();
    // The classic failure this replaces: a third tap should not re-open it
    // off the back of the second.
    __tap(250, 250);
    await new Promise(r2 => setTimeout(r2, 60));
    __tap(250, 250);
    const opened = __menuOpen();
    __closeMenu();
    await new Promise(r2 => setTimeout(r2, 60));
    __tap(250, 250);
    const third = __menuOpen();
    __closeMenu();
    return { slow, far, opened, third };
  });
  ok('two taps 600ms apart are two taps, not a double', r.slow === false);
  ok('two quick taps far apart are two taps too', r.far === false);
  ok('a real double tap still opened in this run', r.opened === true);
  ok('and the tap after it does not re-open on its own', r.third === false);
}

console.log('\n4. the mouse keeps double click to zoom, unless asked');
{
  const r = await page.evaluate(async () => {
    __closeMenu();
    try { localStorage.removeItem('lqm_dbltapmenu'); } catch (e) {}
    if (window._cmSyncDblZoom) window._cmSyncDblZoom();
    const zoomOnByDefault = map.doubleClickZoom.enabled();
    // A mouse double click, through Leaflet's own event. Leaflet's own
    // doubleClickZoom handler reads originalEvent.shiftKey, so the event has
    // to carry one to be fired at all.
    const dbl = () => map.fire('dblclick', {
      latlng: L.latLng(30, -90), containerPoint: L.point(10, 10),
      originalEvent: { shiftKey: false, clientX: 10, clientY: 10,
                       preventDefault() {}, stopPropagation() {} },
    });
    dbl();
    const openedByMouse = __menuOpen();

    lqmToggleSetting('dbltapmenu', true);
    const zoomOffNow = map.doubleClickZoom.enabled();
    dbl();
    const openedAfterOptIn = __menuOpen();
    const stored = localStorage.getItem('lqm_dbltapmenu');

    lqmToggleSetting('dbltapmenu', false);
    const zoomBack = map.doubleClickZoom.enabled();
    __closeMenu();
    return { zoomOnByDefault, openedByMouse, zoomOffNow, openedAfterOptIn, stored, zoomBack };
  });
  ok('double click zoom is on by default', r.zoomOnByDefault === true);
  ok('a mouse double click does not open the menu by default', r.openedByMouse === false);
  ok('turning the setting on gives up double click to zoom', r.zoomOffNow === false);
  ok('and a mouse double click then opens the menu', r.openedAfterOptIn === true);
  ok('the choice is remembered', r.stored === 'true', r.stored);
  ok('turning it back off returns the zoom', r.zoomBack === true);
}

console.log('\n5. a tap on something on top of the map is that thing\'s tap');
{
  const r = await page.evaluate(async () => {
    __closeMenu();
    const c = map.getContainer();
    const fake = document.createElement('div');
    fake.className = 'leaflet-marker-icon';
    fake.style.cssText = 'position:absolute;left:60px;top:60px;width:30px;height:30px;';
    c.appendChild(fake);
    const rect = c.getBoundingClientRect();
    const hit = () => fake.dispatchEvent(new PointerEvent('pointerup', {
      pointerType: 'touch', bubbles: true, cancelable: true,
      clientX: rect.left + 70, clientY: rect.top + 70,
    }));
    hit();
    await new Promise(r2 => setTimeout(r2, 60));
    hit();
    const opened = __menuOpen();
    fake.remove();
    __closeMenu();
    return { opened };
  });
  ok('double tapping a marker does not open the map menu', r.opened === false);
}

console.log('\n6. the Alert Desk sits with Alerts now');
{
  const r = await page.evaluate(() => {
    const groups = Array.from(document.querySelectorAll('#lqm-set-content .lqm-settings-group'));
    const nameOf = g => {
      const h = g.querySelector('.lqm-settings-category');
      return h ? h.textContent.trim() : '';
    };
    const deskIn = groups.filter(g => /_adUiOpen\(\)/.test(g.innerHTML)).map(nameOf);
    const includeIn = groups.filter(g => /lqm-ss-includemine/.test(g.innerHTML)).map(nameOf);
    return { deskIn, includeIn };
  });
  ok('the Write an Alert button is in the Alerts card',
     r.deskIn.length === 1 && r.deskIn[0] === 'Alerts', r.deskIn.join(', '));
  ok('it is not in StormStream any more', !r.deskIn.includes('StormStream Mode'));
  // The toggle for whether StormStream cycles them is a StormStream setting,
  // so it stays where it is.
  ok('the StormStream toggle for them stays with StormStream',
     r.includeIn.length === 1 && r.includeIn[0] === 'StormStream Mode', r.includeIn.join(', '));
}

console.log('\n7. nothing threw');
ok('no uncaught page errors', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
