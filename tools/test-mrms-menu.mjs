#!/usr/bin/env node
/*
 * The MRMS menu, now that it is two levels deep.
 *
 *     node tools/test-mrms-menu.mjs
 *
 * MRMS carried two products for a long time and now carries thirty-eight.
 * Thirty-eight rows behind one button is a list to scroll rather than a menu
 * to use, so it nests: the first level is the groups, and opening one shows
 * only that group's products.
 *
 * Nesting is easy to get half right. The ways it goes wrong are all about
 * where you end up: a Back that jumps two levels instead of one, a group that
 * shows a product belonging to a different group, a product toggled inside a
 * group that does not register anywhere the top level can see. So these walk
 * the menu the way a person does - open, descend, toggle, go back - and check
 * what is on screen at each step.
 *
 * The Pi is mocked, because the menu is built from whatever the Pi says it
 * really has rather than from a list in the page.
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

// Shaped the way pi/radar_pipeline.py writes a manifest, with members of
// every group so the sorting has something to get wrong.
const P = (label) => ({ label, file: 'x.png', bounds: [[20, -130], [55, -60]],
                        built: '2026-08-20T12:00:00+00:00' });
const MANIFEST = {
  updated: '2026-08-20T12:00:00+00:00',
  products: {
    rotation: P('Rotation Tracks'), rotation120: P('Rotation Tracks 2h'),
    mesh: P('Hail (MESH)'), posh: P('Hail Probability'), shi: P('Severe Hail Index'),
    composite: P('Composite Reflectivity'), lowalt: P('Low Altitude Reflectivity'),
    echotop18: P('Echo Top 18 dBZ'), vil: P('VIL'),
    preciprate: P('Precip Rate'), preciptype: P('Precip Type'), qpe01: P('QPE 1h'),
    ltgdensity: P('Lightning Density'), ltgprob30: P('Lightning Probability'),
    sfctemp: P('Surface Temperature'), wetbulb: P('Wet Bulb'), h0c: P('Freezing Level'),
  },
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
  if (/mrms\.json/.test(url))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(MANIFEST) });
  if (/\.png($|\?)/.test(url))
    return route.fulfill({ contentType: 'image/png', body: Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478'
      + '9c6360000002000154a24f6e0000000049454e44ae426082', 'hex') });
  return route.abort();
});
await page.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4200);
await page.evaluate(() => { if (typeof closeTutorial === 'function') closeTutorial(); });
await page.evaluate(() => { _hdBase = 'https://pi.example.test'; });

const read = () => page.evaluate(() => {
  const w = document.getElementById('sub-bubbles');
  return {
    mode: w.dataset.mode,
    group: w.dataset.mrmsIn,
    labels: [...w.querySelectorAll('.sub-bubble .sb-label')].map(e => e.textContent),
    groups: [...w.querySelectorAll('[data-mrms-group]')].map(e => e.dataset.mrmsGroup),
    products: [...w.querySelectorAll('[data-mrms-id]')].map(e => e.dataset.mrmsId),
    counts: [...w.querySelectorAll('.sb-count')].map(e => e.textContent),
    heading: (w.querySelector('.sub-bubble-group-label') || {}).textContent,
    backs: [...w.querySelectorAll('.sub-bubble .sb-label')]
      .filter(e => e.textContent === 'Back').length,
    active: [...w.querySelectorAll('.sub-bubble.active')]
      .map(e => e.dataset.mrmsId || e.dataset.mrmsGroup),
  };
});

console.log('\n1. the top level is the groups, not thirty-eight products');
{
  await page.evaluate(() => toggleMrmsSub());
  await page.waitForTimeout(500);
  const r = await read();
  ok('the menu is in MRMS mode', r.mode === 'mrms', String(r.mode));
  ok('it shows groups', r.groups.length >= 5, JSON.stringify(r.groups));
  ok('and no individual product at this level',
     r.products.length === 0, JSON.stringify(r.products));
  ok('the groups are the ones the catalogue defines',
     ['severe', 'refl', 'precip', 'ltg', 'winter'].every(g => r.groups.includes(g)),
     JSON.stringify(r.groups));
  ok('there is exactly one Back', r.backs === 1, String(r.backs));
  ok('each group says how many products it holds',
     r.counts.length === r.groups.length && r.counts.every(c => /\d/.test(c)),
     JSON.stringify(r.counts));
}

console.log('\n2. opening a group shows that group, and only that group');
{
  await page.evaluate(() => {
    document.querySelector('[data-mrms-group="severe"]').click();
  });
  await page.waitForTimeout(200);
  const r = await read();
  ok('the menu descends into the group', r.mode === 'mrms-group' && r.group === 'severe',
     JSON.stringify([r.mode, r.group]));
  ok('the group is named at the top', /severe/i.test(r.heading || ''), r.heading);
  ok('its own products are listed',
     ['rotation', 'rotation120', 'mesh', 'posh', 'shi'].every(k => r.products.includes(k)),
     JSON.stringify(r.products));
  ok('and nothing from another group leaked in',
     !r.products.some(k => ['composite', 'qpe01', 'ltgdensity', 'h0c'].includes(k)),
     JSON.stringify(r.products));
  ok('the group buttons are gone from this level',
     r.groups.length === 0, JSON.stringify(r.groups));
  ok('there is still exactly one Back', r.backs === 1, String(r.backs));
  // The container used to be tagged with the same attribute the buttons use,
  // so a lookup for a group button found the container instead and clicking
  // it did nothing. That only showed up on the second visit, which is exactly
  // the kind of bug worth pinning.
  const collide = await page.evaluate(() =>
    document.getElementById('sub-bubbles').hasAttribute('data-mrms-group'));
  ok('the container does not answer to a group button lookup', collide === false);
}

console.log('\n3. every group opens, and between them they hold everything');
{
  const seen = [];
  for (const g of ['severe', 'refl', 'precip', 'ltg', 'winter']) {
    await page.evaluate(() => toggleMrmsSub());
    await page.waitForTimeout(220);
    await page.evaluate((gid) => {
      document.querySelector(`[data-mrms-group="${gid}"]`).click();
    }, g);
    await page.waitForTimeout(120);
    const r = await read();
    seen.push({ g, products: r.products });
  }
  const all = seen.flatMap(x => x.products);
  ok('every group has something in it',
     seen.every(x => x.products.length > 0),
     JSON.stringify(seen.map(x => [x.g, x.products.length])));
  ok('no product appears in two groups',
     all.length === new Set(all).size,
     JSON.stringify(all.filter((v, i) => all.indexOf(v) !== i)));
  ok('and between them they cover every product the Pi advertises',
     Object.keys(MANIFEST.products).every(k => all.includes(k)),
     JSON.stringify(Object.keys(MANIFEST.products).filter(k => !all.includes(k))));
}

console.log('\n4. toggling inside a group draws it, and the top level knows');
{
  await page.evaluate(() => toggleMrmsSub());
  await page.waitForTimeout(220);
  await page.evaluate(() => document.querySelector('[data-mrms-group="severe"]').click());
  await page.waitForTimeout(120);
  const on = await page.evaluate(async () => {
    document.querySelector('[data-mrms-id="mesh"]').click();
    document.querySelector('[data-mrms-id="rotation"]').click();
    await new Promise(r => setTimeout(r, 500));
    return {
      state: [!!_mrmsOn.mesh, !!_mrmsOn.rotation],
      drawn: [!!_mrmsOv.mesh, !!_mrmsOv.rotation],
      lit: [...document.querySelectorAll('.sub-bubble.active')].map(e => e.dataset.mrmsId),
    };
  });
  ok('both register as on', on.state.every(Boolean), JSON.stringify(on.state));
  ok('and both are actually drawn on the map', on.drawn.every(Boolean),
     JSON.stringify(on.drawn));
  ok('their rows light up', ['mesh', 'rotation'].every(k => on.lit.includes(k)),
     JSON.stringify(on.lit));

  // Back to the group list: the group must now show two of five as on.
  await page.evaluate(() => document.querySelector('.sub-bubble').click());
  await page.waitForTimeout(400);
  const r = await read();
  ok('going back returns to the group list, not out of MRMS entirely',
     r.mode === 'mrms' && r.groups.length >= 5, JSON.stringify([r.mode, r.groups]));
  ok('the group with two drawn is marked active',
     r.active.includes('severe'), JSON.stringify(r.active));
  ok('and a group with nothing drawn is not',
     !r.active.includes('winter'), JSON.stringify(r.active));
  ok('the count says how many of the group are on',
     r.counts.some(c => /^2\/\d/.test(c)), JSON.stringify(r.counts));
}

console.log('\n5. Back from the group list leaves MRMS, one level at a time');
{
  await page.evaluate(() => document.querySelector('.sub-bubble').click());
  await page.waitForTimeout(300);
  const r = await read();
  ok('the second Back leaves MRMS behind',
     r.mode !== 'mrms' && r.mode !== 'mrms-group', String(r.mode));
  ok('and nothing MRMS is left drawn in the menu',
     r.groups.length === 0 && r.products.length === 0, JSON.stringify(r));
  // The layers themselves stay on, which is the point: leaving the menu is
  // not turning the product off.
  const still = await page.evaluate(() => [!!_mrmsOv.mesh, !!_mrmsOv.rotation]);
  ok('but the products stay drawn on the map', still.every(Boolean),
     JSON.stringify(still));
}

console.log('\n6. turning them off again cleans up');
{
  const r = await page.evaluate(async () => {
    _mrmsToggle('mesh'); _mrmsToggle('rotation');
    await new Promise(r => setTimeout(r, 300));
    return { ov: [!!_mrmsOv.mesh, !!_mrmsOv.rotation], timer: _mrmsTimer, any: _mrmsAnyOn() };
  });
  ok('both images are removed', r.ov.every(x => !x), JSON.stringify(r.ov));
  ok('nothing is left on', r.any === false);
  ok('and the refresh timer stops rather than polling for nothing',
     r.timer === null, String(r.timer));
}

console.log('\n7. a Pi with nothing built says so instead of showing empty groups');
{
  await page.route('**mrms.json**', route =>
    route.fulfill({ contentType: 'application/json', body: '{"products":{}}' }));
  const r = await page.evaluate(async () => {
    _mrmsManifest = null;
    await toggleMrmsSub();
    await new Promise(r => setTimeout(r, 400));
    const w = document.getElementById('sub-bubbles');
    return {
      groups: w.querySelectorAll('[data-mrms-group]').length,
      text: w.textContent,
    };
  });
  ok('no groups are drawn', r.groups === 0, String(r.groups));
  ok('and it says why', /no mrms built/i.test(r.text), r.text.slice(0, 80));
}

console.log('\n8. nothing above threw');
{
  const real = errors.filter(e => !/Failed to fetch|NetworkError|ERR_FAILED|net::/i.test(e));
  ok('no page errors', real.length === 0, real.slice(0, 3).join(' | '));
}

await browser.close();
console.log();
if (fail) { console.log(`${fail} FAILED, ${pass} passed`); process.exit(1); }
console.log(`all ${pass} passed`);
