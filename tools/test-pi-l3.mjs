#!/usr/bin/env node
/*
 * The whole Level 3 journey against a fake Pi, in a real browser with real
 * Leaflet. Serves the answers the Pi would give (index, manifest, png) from
 * intercepted routes, then drives the menu and the map pills the way a person
 * does, and checks the picture actually lands on the map.
 *
 *     node tools/test-pi-l3.mjs
 *
 * Three scenes:
 *   1. healthy Pi   - open Level 3, product row fills, overlay draws, a pill
 *                     click on a built site redraws, a pill click on any other
 *                     site explains itself
 *   2. unreachable  - every Pi fetch fails; the toast must blame the address,
 *                     not claim the Pi has built nothing
 *   3. empty index  - the Pi answers but has no sites; that one IS "no radar
 *                     built yet"
 *
 * The stale-site case is baked into scene 1: localStorage starts with the
 * lower-case 'ktlx' that pages saved before the case fix, and the draw must
 * heal it to 'KTLX' rather than drawing nothing.
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

const PI = 'https://fake-pi.test';
const FRAME = '20260817_0200';
const INDEX_L3 = JSON.stringify({
  level: 3,
  updated: new Date().toISOString(),
  sites: {
    KTLX: { frames: [FRAME], path: 'l3/KTLX/{frame}/manifest.json' },
    KFWS: { frames: [FRAME], path: 'l3/KFWS/{frame}/manifest.json' },
  },
});
const MANIFEST = JSON.stringify({
  site: 'KTLX', level: 3, time: FRAME,
  bounds: [[33.8, -99.8], [36.9, -95.2]],
  site_latlon: [35.33, -97.28],
  built_at: new Date().toISOString(),
  fields: Object.fromEntries(
    ['n0q','n0u','n0c','n0x','n0k','n0h','ohp','stp','dvl','eet','ncr',
     'n1q','n2q','n3q','n1u','n2u','n3u']
      .map(f => [f, { label: f, unit: '', min: 0, max: 1 }])),
});
// The smallest valid PNG there is: 1x1, transparent.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAC' +
  'hwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

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

// One page per scene, so localStorage and module state start clean each time.
// piMode: 'up' serves everything, 'down' fails every Pi fetch, 'empty' serves
// an index with no sites in it.
async function boot(piMode) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    // What a real user's browser holds: the level they picked, and the site
    // saved lower case by the page as it was before the case fix.
    localStorage.setItem('gwcfc_pr_level', 'l3');
    localStorage.setItem('gwcfc_pr_site', 'ktlx');
  });
  await page.route('**://**', route => {
    const url = route.request().url();
    if (url.startsWith('file://')) return route.continue();
    if (url.includes('leaflet') && url.endsWith('.js'))
      return route.fulfill({ contentType: 'application/javascript',
        body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
    if (url.includes('leaflet') && url.endsWith('.css'))
      return route.fulfill({ contentType: 'text/css',
        body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
    if (url.startsWith('https://firestore.googleapis.com/'))
      return route.fulfill({ contentType: 'application/json',
        body: JSON.stringify({ fields: { url: { stringValue: PI } } }) });
    if (url.startsWith(PI)) {
      if (piMode === 'down') return route.abort();
      // What Cloudflare's edge really says when the tunnel process is dead:
      // it answers, with an error, and the Pi never saw the request.
      if (piMode === 'edge530')
        return route.fulfill({ status: 530, body: 'tunnel down' });
      if (url.includes('latest_l3.json'))
        return route.fulfill({ contentType: 'application/json',
          body: piMode === 'empty'
            ? JSON.stringify({ level: 3, sites: {} }) : INDEX_L3 });
      if (url.includes('latest_l2.json'))
        return route.fulfill({ status: 404, body: 'not built' });
      if (url.includes('mrms/mrms.json'))
        return route.fulfill({ contentType: 'application/json',
          body: JSON.stringify({ updated: '2026-08-17T02:10:00Z', products: {
            rotation: { file: 'rotation.png', label: 'Rotation Tracks',
                        bounds: [[20, -130], [55, -60]] },
            mesh:     { file: 'mesh.png', label: 'Hail Swaths',
                        bounds: [[20, -130], [55, -60]] },
          } }) });
      if (url.includes('manifest.json'))
        return route.fulfill({ contentType: 'application/json', body: MANIFEST });
      if (url.endsWith('.png'))
        return route.fulfill({ contentType: 'image/png', body: PNG });
      return route.fulfill({ status: 404, body: 'nope' });
    }
    return route.abort();
  });
  await page.goto('file://' + join(ROOT, 'index.html'),
                  { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  // Toasts are the page's way of explaining itself; keep every one.
  await page.evaluate(() => {
    window.__toasts = [];
    const real = window.showToast;
    window.showToast = (msg, ms) => { window.__toasts.push(String(msg));
                                      try { real(msg, ms); } catch (e) {} };
  });
  return { page, errors };
}

const row = p => p.evaluate(() =>
  [...document.querySelectorAll('#sub-bubbles .sub-bubble')]
    .map(e => e.textContent.trim()));

console.log('\n1. a healthy Pi, seen from the page');
{
  const { page, errors } = await boot('up');
  ok('the page boots with real Leaflet', errors.length === 0, errors[0]);

  await page.evaluate(() => toggleRadarSub());
  await page.evaluate(() => toggleRadarPiSub('l3'));
  await page.waitForTimeout(1500);

  const st = await page.evaluate(() => ({
    on: _prOn,
    sites: Object.keys((_prIndex && _prIndex.sites) || {}),
    site: _prSite,
    layers: _prLayers.length,
    url: _prLayers[0] && _prLayers[0]._url,
    toasts: window.__toasts,
  }));
  ok('the layer is on', st.on === true, String(st.on));
  ok('the index lists both built radars',
     st.sites.join(',') === 'KTLX,KFWS', st.sites.join(','));
  ok('the stale lower-case saved site healed to the real name',
     st.site === 'KTLX', st.site);
  ok('one overlay is on the map', st.layers === 1, String(st.layers));
  ok('and it is the reflectivity png of the newest frame',
     /\/radar\/l3\/KTLX\/20260817_0200\/n0q\.png$/.test(st.url || ''), st.url);
  ok('no complaint was toasted',
     !st.toasts.some(t => /no radar built|not one of the radars|could not reach/i.test(t)),
     st.toasts.join(' | '));

  const labels = await row(page);
  // startsWith, not equals: the active product's label carries its tilt
  // chips ("Reflectivity1234"), which is the feature, not a failure.
  ok('the product row filled in',
     ['Reflectivity', '1-Hr Precip', 'Echo Tops'].every(l =>
       labels.some(t => t.startsWith(l))),
     labels.join(','));
  ok('and does not claim there is no Pi radar',
     !labels.some(t => /No Pi radar/.test(t)), labels.join(','));

  // The map pill for the other built site: a real Leaflet event, the same
  // path a finger takes.
  await page.evaluate(() => { window.__toasts.length = 0;
                              _nexradSiteMarkers['kfws'].label.fire('click'); });
  await page.waitForTimeout(1200);
  const pill = await page.evaluate(() => ({
    site: _prSite, layers: _prLayers.length,
    url: _prLayers[0] && _prLayers[0]._url, toasts: window.__toasts }));
  ok('clicking a built site pill moves the map to it',
     pill.site === 'KFWS', pill.site);
  ok('one overlay again, for the new site',
     pill.layers === 1 && /KFWS/.test(pill.url || ''), pill.url);
  ok('without complaining', pill.toasts.length === 0, pill.toasts.join(' | '));

  // And a pill the Pi does not build: the answer is an explanation.
  await page.evaluate(() => { window.__toasts.length = 0;
                              _nexradSiteMarkers['kdyx'].label.fire('click'); });
  await page.waitForTimeout(400);
  const other = await page.evaluate(() => window.__toasts);
  ok('any other pill explains how to add that radar',
     other.some(t => /KDYX is not one of the radars/.test(t)), other.join(' | '));

  // The pills themselves say which radars will answer.
  const built = await page.evaluate(() => ({
    ktlx: document.getElementById('nxlbl-ktlx').classList.contains('pi-built'),
    kfws: document.getElementById('nxlbl-kfws').classList.contains('pi-built'),
    kdyx: document.getElementById('nxlbl-kdyx').classList.contains('pi-built'),
  }));
  ok('the built radars wear the green ring', built.ktlx && built.kfws,
     JSON.stringify(built));
  ok('and the rest do not', !built.kdyx, JSON.stringify(built));

  // Tilts: Level 3 publishes every antenna cut as its own product, and the
  // chips on the active bubble switch between them. Chip 2 must redraw from
  // the tilt-2 file, and the choice must survive a site change.
  const chips = await page.evaluate(() =>
    [...document.querySelectorAll('#sub-bubbles .tilt-chip')].map(c => c.textContent));
  ok('four tilt chips ride the active product bubble',
     chips.join(',') === '1,2,3,4', chips.join(','));
  await page.evaluate(() => {
    document.querySelectorAll('#sub-bubbles .tilt-chip')[1].onclick(new Event('x'));
  });
  await page.waitForTimeout(900);
  const tilt = await page.evaluate(() => ({
    tilt: _prTilt,
    url: _prLayers[0] && _prLayers[0]._url,
  }));
  ok('chip 2 redraws from the tilt 2 file',
     tilt.tilt === 2 && /n1q\.png$/.test(tilt.url || ''), JSON.stringify(tilt));
  await page.evaluate(() => {
    document.querySelectorAll('#sub-bubbles .tilt-chip')[0].onclick(new Event('x'));
  });
  await page.waitForTimeout(900);

  // The severe overlays: two pills, each drawing one national image from the
  // Pi's MRMS build, on and off through the same dispatcher as every pill.
  await page.evaluate(() => { window.__toasts.length = 0;
                              toggleOverlayPill('rotation');
                              toggleOverlayPill('hail'); });
  await page.waitForTimeout(800);
  const sev = await page.evaluate(() => ({
    rot: _mrmsOv.rotation && _mrmsOv.rotation._url,
    hail: _mrmsOv.mesh && _mrmsOv.mesh._url,
    pills: [document.getElementById('op-rotation').classList.contains('active'),
            document.getElementById('op-hail').classList.contains('active')],
    toasts: window.__toasts,
  }));
  ok('rotation tracks draw from the Pi',
     /\/radar\/mrms\/rotation\.png/.test(sev.rot || ''), sev.rot);
  ok('hail swaths draw from the Pi',
     /\/radar\/mrms\/mesh\.png/.test(sev.hail || ''), sev.hail);
  ok('both pills light up', sev.pills.every(Boolean), sev.pills.join(','));
  ok('with no complaints', sev.toasts.length === 0, sev.toasts.join(' | '));

  await page.evaluate(() => { toggleOverlayPill('rotation');
                              toggleOverlayPill('hail'); });
  await page.waitForTimeout(400);
  const off = await page.evaluate(() => ({
    gone: !_mrmsOv.rotation && !_mrmsOv.mesh,
    timer: _mrmsTimer === null,
  }));
  ok('toggling off removes both images and stops the refresh',
     off.gone && off.timer, JSON.stringify(off));

  ok('nothing threw along the way', errors.length === 0, errors.join(' | '));
  await page.close();
}

console.log('\n2. a Pi that cannot be reached');
{
  const { page } = await boot('down');
  await page.evaluate(() => toggleRadarSub());
  await page.evaluate(() => toggleRadarPiSub('l3'));
  await page.waitForTimeout(1500);
  const st = await page.evaluate(() => ({ toasts: window.__toasts,
    layers: _prLayers.length }));
  ok('the toast blames the address, not the radar builds',
     st.toasts.some(t => /could not reach/i.test(t)), st.toasts.join(' | '));
  ok('and does not pretend the Pi has built nothing',
     !st.toasts.some(t => /no radar built/i.test(t)), st.toasts.join(' | '));
  ok('nothing is drawn', st.layers === 0, String(st.layers));

  // Clicking a pill while unreachable used to say the radar was not one the
  // Pi builds, for every single pill, which read as no data existing at all.
  await page.evaluate(() => { window.__toasts.length = 0;
                              _nexradSiteMarkers['ktlx'].label.fire('click'); });
  await page.waitForTimeout(1200);
  const clicked = await page.evaluate(() => window.__toasts);
  ok('a pill click retries and repeats the real reason',
     clicked.some(t => /could not reach/i.test(t)), clicked.join(' | '));
  ok('and never claims the radar is unbuilt',
     !clicked.some(t => /not one of the radars/i.test(t)), clicked.join(' | '));
  await page.close();
}

console.log('\n2b. the tunnel edge answering for a dead tunnel');
{
  const { page } = await boot('edge530');
  await page.evaluate(() => toggleRadarSub());
  await page.evaluate(() => toggleRadarPiSub('l3'));
  await page.waitForTimeout(1500);
  const st = await page.evaluate(() => ({ toasts: window.__toasts,
    layers: _prLayers.length }));
  ok('a 530 from the edge reads as unreachable too',
     st.toasts.some(t => /could not reach/i.test(t)), st.toasts.join(' | '));
  ok('nothing is drawn', st.layers === 0, String(st.layers));
  await page.close();
}

console.log('\n3. a Pi that answers with nothing built');
{
  const { page } = await boot('empty');
  await page.evaluate(() => toggleRadarSub());
  await page.evaluate(() => toggleRadarPiSub('l3'));
  await page.waitForTimeout(1500);
  const st = await page.evaluate(() => ({ toasts: window.__toasts,
    layers: _prLayers.length }));
  ok('this one IS "no radar built yet"',
     st.toasts.some(t => /no radar built/i.test(t)), st.toasts.join(' | '));
  ok('nothing is drawn', st.layers === 0, String(st.layers));
  await page.close();
}

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
