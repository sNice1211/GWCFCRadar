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
// KTLX carries three kept frames, oldest to newest, exactly the shape
// pi/radar_pipeline.py's age-based retention produces - this is what makes
// scene 1d a real test of scrubbing rather than always landing on the one
// frame every other scene expects.
const FRAME_OLD = '20260817_0150';
const FRAME_MID = '20260817_0155';
const INDEX_L3 = JSON.stringify({
  level: 3,
  updated: new Date().toISOString(),
  sites: {
    KTLX: { frames: [FRAME_OLD, FRAME_MID, FRAME], path: 'l3/KTLX/{frame}/manifest.json' },
    KFWS: { frames: [FRAME], path: 'l3/KFWS/{frame}/manifest.json' },
    TTPA: { frames: [FRAME], path: 'l3/TTPA/{frame}/manifest.json' },
  },
});
// A terminal radar's frame: the TDWR dialect, and no dual-pol at all.
const TDWR_MANIFEST = JSON.stringify({
  site: 'TTPA', level: 3, time: FRAME,
  bounds: [[26.8, -83.5], [28.8, -81.5]],
  site_latlon: [27.86, -82.52],
  built_at: new Date().toISOString(),
  fields: Object.fromEntries(
    ['tz0', 'tv0', 'tz1', 'tv1', 'tzl', 'ncr']
      .map(f => [f, { label: f, unit: '', min: 0, max: 1 }])),
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
// A model chart with a known value painted into it, generated in the browser
// by scene 1b out of the page's own ramp tables, then served back by the
// route below. Starts as the blank PNG until the scene fills it in.
let modelPng = null;

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
      // The cyclone spaghetti: one OPER file holding a mean and two members.
      if (url.includes('/cyclones/')) {
        if (url.includes('latest.json'))
          return route.fulfill({ contentType: 'application/json',
            body: JSON.stringify({ run: '20260817_00',
                                   path: '20260817_00/cyc.json' }) });
        if (url.includes('cyc.json'))
          return route.fulfill({ contentType: 'application/json',
            body: JSON.stringify({ run: '20260817_00', genesis: {},
              tracks: { gencast_oper: { variant: 'OPER',
                                        path: 'tracks_oper.json' } } }) });
        if (url.includes('tracks_oper.json'))
          return route.fulfill({ contentType: 'application/json',
            body: JSON.stringify({ tracks: {
              '01c|mean': [{ lat: 20, lon: -60 }, { lat: 24, lon: -66 }],
              '01c|1':    [{ lat: 20, lon: -60 }, { lat: 26, lon: -63 }],
              '01c|2':    [{ lat: 20, lon: -60 }, { lat: 22, lon: -69 }],
            } }) });
        return route.fulfill({ status: 404, body: 'nope' });
      }
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
      // The models half of the Pi, enough for the Inspector scene: one model,
      // one field, one hour. The ACAO header is what pi/serve.py really
      // sends, and it is what lets the page read the image's pixels back.
      if (url.includes('models/latest.json'))
        return route.fulfill({ contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify({ updated: new Date().toISOString(), models: {
            gfs: { label: 'GFS', res: '0.25 deg', run: '20260817_00',
                   path: 'gfs/conus/20260817_00/manifest.json' } } }) });
      if (url.includes('models/gfs/conus/20260817_00/manifest.json'))
        return route.fulfill({ contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify({ model: 'gfs', label: 'GFS', res: '0.25 deg',
            run: '20260817_00', bounds: [[25, -110], [45, -85]], hours: [0],
            fields: { t2m: { hours: [0], min: -5, max: 35,
                             scale: { lo: -40, hi: 45, ramp: 'temp' },
                             pattern: 't2m_f{fhr:03d}.png' } } }) });
      if (url.includes('t2m_f000.png'))
        return route.fulfill({ contentType: 'image/png',
          headers: { 'access-control-allow-origin': '*' },
          body: modelPng || PNG });
      if (url.includes('/l3/TTPA/') && url.includes('manifest.json'))
        return route.fulfill({ contentType: 'application/json', body: TDWR_MANIFEST });
      if (url.includes('manifest.json')) {
        // Stamped with whichever frame was actually asked for, so scrubbing
        // to an older frame is provably drawing that frame and not silently
        // reusing the newest one's manifest.
        const m = url.match(/\/l3\/[A-Z]+\/([0-9_]+)\/manifest\.json/);
        const body = JSON.parse(MANIFEST);
        if (m) body.time = m[1];
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
      }
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
  ok('the index lists the built radars, terminal included',
     st.sites.join(',') === 'KTLX,KFWS,TTPA', st.sites.join(','));
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

  // A pill the Pi does not build is no longer a refusal: it is decoded in the
  // browser from the Level 3 bucket. Offline, as here, that cannot land, and
  // what matters is that it tried and said why rather than telling anyone to
  // go and edit a config file on the Pi.
  await page.evaluate(() => { window.__toasts.length = 0;
                              _nexradSiteMarkers['kdyx'].label.fire('click'); });
  await page.waitForTimeout(1200);
  const other = await page.evaluate(() => ({ toasts: window.__toasts,
                                             stuck: _prBucketSite }));
  ok('any other pill is decoded here instead of being refused',
     other.toasts.some(t => /^KDYX N0B:/.test(t)) &&
     !other.toasts.some(t => /is not one of the radars/.test(t)),
     other.toasts.join(' | '));
  // Back to null, which is "the Pi's own pictures", the state before the click.
  ok('and a site that could not be read does not stay selected',
     other.stuck === null, String(other.stuck));

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

  // A terminal radar. Its frame holds tz0, not n0q, and per AtticRadar's
  // tables tz0 IS base reflectivity, so the pill draws it without a single
  // word of complaint, and the terminal wears the built ring like any radar.
  await page.evaluate(() => { window.__toasts.length = 0;
                              _nexradSiteMarkers['ttpa'].label.fire('click'); });
  await page.waitForTimeout(1200);
  const tdwr = await page.evaluate(() => ({
    site: _prSite,
    url: _prLayers[0] && _prLayers[0]._url,
    toasts: window.__toasts,
    ring: document.getElementById('nxlbl-ttpa').classList.contains('pi-built'),
  }));
  ok('a terminal pill draws its own dialect',
     /\/l3\/TTPA\/20260817_0200\/tz0\.png$/.test(tdwr.url || ''), tdwr.url);
  ok('silently, because tz0 IS reflectivity',
     tdwr.toasts.length === 0, tdwr.toasts.join(' | '));
  ok('and the terminal wears the green ring', tdwr.ring, String(tdwr.ring));

  // The severe overlays. These used to be two fixed pills on the overlay row;
  // MRMS now carries the whole 2D catalogue, so it has its own sub-bubble
  // built from whatever the Pi says it actually has, and the products are
  // toggled from there. The two old pill names still work as shortcuts, and
  // open that menu rather than drawing anything themselves.
  await page.evaluate(() => { window.__toasts.length = 0;
                              _mrmsToggle('rotation');
                              _mrmsToggle('mesh'); });
  await page.waitForTimeout(800);
  const sev = await page.evaluate(() => ({
    rot: _mrmsOv.rotation && _mrmsOv.rotation._url,
    hail: _mrmsOv.mesh && _mrmsOv.mesh._url,
    on: [!!_mrmsOn.rotation, !!_mrmsOn.mesh],
    toasts: window.__toasts,
  }));
  ok('rotation tracks draw from the Pi',
     /\/radar\/mrms\/rotation\.png/.test(sev.rot || ''), sev.rot);
  ok('hail swaths draw from the Pi',
     /\/radar\/mrms\/mesh\.png/.test(sev.hail || ''), sev.hail);
  ok('both products register as on', sev.on.every(Boolean), sev.on.join(','));
  ok('with no complaints', sev.toasts.length === 0, sev.toasts.join(' | '));

  // The retired pill names still lead somewhere useful instead of dying.
  const shortcut = await page.evaluate(() => {
    toggleOverlayPill('rotation');
    return document.getElementById('sub-bubbles').dataset.mode;
  });
  ok('the old rotation pill name now opens the MRMS menu',
     shortcut === 'mrms', String(shortcut));

  await page.evaluate(() => { _mrmsToggle('rotation'); _mrmsToggle('mesh'); });
  await page.waitForTimeout(400);
  const off = await page.evaluate(() => ({
    gone: !_mrmsOv.rotation && !_mrmsOv.mesh,
    timer: _mrmsTimer === null,
  }));
  ok('toggling off removes both images and stops the refresh',
     off.gone && off.timer, JSON.stringify(off));

  // The cyclone spaghetti wears name tags now: every line ends in a pill
  // saying which member it is, and tapping a tag dims everything else.
  await page.evaluate(() => _cycEnable());
  await page.waitForTimeout(800);
  const cyc = await page.evaluate(() => ({
    groups: Object.keys(_cycGroups).length,
    labels: Object.values(_cycGroups)
      .flatMap(g => g.tags.map(t => t.getElement().textContent.trim())).sort(),
  }));
  ok('every track line carries a name tag', cyc.groups === 3, String(cyc.groups));
  ok('and the tags say storm and member, shortly',
     cyc.labels.join(',') === '01C M1,01C M2,01C MEAN', cyc.labels.join(','));

  const focus = await page.evaluate(() => {
    const key = 'gencast_oper|01c|1';
    _cycGroups[key].tags[0].fire('click');
    const others = Object.entries(_cycGroups).filter(([k]) => k !== key);
    const dimmed = others.every(([, g]) =>
      g.lines.every(l => l.options.opacity === 0.05));
    const lifted = _cycGroups[key].lines.every(l => l.options.opacity === 1);
    _cycGroups[key].tags[0].fire('click');   // tap again restores
    const restored = others.every(([, g]) =>
      g.lines.every(l => l.options.opacity === g.baseOpacity));
    return { dimmed, lifted, restored };
  });
  ok('tapping a tag dims every other line', focus.dimmed, JSON.stringify(focus));
  ok('and brightens its own', focus.lifted, JSON.stringify(focus));
  ok('tapping again restores the tangle', focus.restored, JSON.stringify(focus));

  ok('nothing threw along the way', errors.length === 0, errors.join(' | '));
  await page.close();
}

console.log('\n1b. the Inspector reads a Pi model chart into a number');
{
  const { page, errors } = await boot('up');

  // Paint the chart the way the Pi would: 20 C on the temperature scale
  // lands on entry 180 of the 256-color temp ramp. The page's own tables
  // pick the color, so the scene cannot drift from the code it tests.
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 8; c.height = 8;
    const col = _hdInspLut('temp')[180];
    const ctx = c.getContext('2d');
    ctx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
    ctx.fillRect(0, 0, 8, 8);
    return c.toDataURL('image/png');
  });
  modelPng = Buffer.from(dataUrl.split(',')[1], 'base64');

  await page.evaluate(() => _hdEnable());
  const up = await page.waitForFunction(() => {
    const img = typeof _hdLayer !== 'undefined' && _hdLayer
      && _hdLayer.getElement && _hdLayer.getElement();
    return !!(img && img.complete && img.naturalWidth);
  }, { timeout: 20000 }).then(() => true).catch(() => false);
  ok('the model chart draws from the fake Pi', up, 'overlay never loaded');

  // Park the crosshair inside the chart and switch the Inspector on.
  await page.evaluate(() => { map.setView([35, -97], 5); toggleInspector(); });
  const rows = await page.waitForFunction(() =>
    typeof _inspLastRows !== 'undefined'
    && _inspLastRows.some(r => r.label === 'Temperature')
    && JSON.stringify(_inspLastRows), { timeout: 15000 })
    .then(h => JSON.parse(String(h))).catch(() => []);
  const t = rows.find ? rows.find(r => r.label === 'Temperature') : null;
  ok('the Inspector shows a row for the model field',
     !!t, JSON.stringify(rows));
  ok('and the pixel color reads back as the number it was painted from',
     t && t.value === '≈20.0' && t.unit === '°C', t && (t.value + ' ' + t.unit));

  ok('nothing threw along the way', errors.length === 0, errors.join(' | '));
  await page.close();
}

console.log('\n1c. a value filter means the Pi paint steps aside for raw data');
{
  // A filter runs on numbers, and a pre-painted PNG has none left. With a
  // reflectivity filter saved, opening the Pi radar must NOT paste the Pi's
  // picture: it must go for the raw feed instead (which fails offline here,
  // loudly and honestly), and clearing the filter must bring the Pi's own
  // pictures straight back.
  const { page } = await boot('up');
  await page.evaluate(() => {
    _fxFilter = { ref: { on: true, min: 40, max: 80 } }; _fxSave();
  });
  await page.evaluate(() => toggleRadarSub());
  await page.evaluate(() => toggleRadarPiSub('l3'));
  await page.waitForTimeout(2500);
  const st = await page.evaluate(() => ({
    layers: _prLayers.length, rerouted: _fxRerouted,
    tried: window.__toasts.some(t => /N0B/.test(t)),
  }));
  ok('no pre-painted picture is pasted while the filter is on',
     st.layers === 0, String(st.layers));
  ok('the raw decode was attempted instead',
     st.rerouted === true && st.tried, JSON.stringify(st));
  const back = await page.evaluate(async () => {
    _fxFilter = {}; _fxSave();
    _radarFxApply();
    await new Promise(r => setTimeout(r, 1500));
    return { layers: _prLayers.length, rerouted: _fxRerouted };
  });
  ok('clearing the filter hands the screen back to the Pi pictures',
     back.layers === 1 && back.rerouted === false, JSON.stringify(back));
  await page.close();
}

console.log('\n1d. scrubbing through the Pi\'s own frame history');
{
  const { page } = await boot('up');
  await page.evaluate(() => toggleRadarSub());
  await page.evaluate(() => toggleRadarPiSub('l3'));
  await page.waitForTimeout(1500);

  const initial = await page.evaluate(() => ({
    frames: _prLoop.frames.slice(),
    idx: _prLoop.idx,
    active: _prLoopActive(),
    ready: _animationReady(),
    url: _prLayers[0] && _prLayers[0]._url,
  }));
  ok('every kept frame is offered, oldest to newest',
     JSON.stringify(initial.frames) === JSON.stringify([FRAME_OLD, FRAME_MID, FRAME]),
     initial.frames.join(','));
  ok('opens on the newest frame', initial.idx === 2, String(initial.idx));
  ok('the loop is what the shared play controls see',
     initial.active === true && initial.ready === true, JSON.stringify(initial));
  ok('drawn from the newest frame', (initial.url || '').includes(FRAME),
     initial.url);

  // seekFrame is what the timeline slider's oninput calls.
  await page.evaluate(() => seekFrame(0));
  await page.waitForTimeout(500);
  const scrubbed = await page.evaluate(() => ({
    idx: _prLoop.idx,
    url: _prLayers[0] && _prLayers[0]._url,
    time: document.getElementById('anim-time').textContent,
  }));
  ok('seekFrame(0) moves to the oldest kept frame',
     scrubbed.idx === 0 && (scrubbed.url || '').includes(FRAME_OLD),
     JSON.stringify(scrubbed));
  ok('the readout marks it as not live',
     /\(past\)/.test(scrubbed.time), scrubbed.time);

  // stepFrame is what the animation tick and the step buttons call - it must
  // move this same loop rather than falling through to the national mosaic,
  // which is what happened before this loop existed at all.
  await page.evaluate(() => stepFrame(1));
  await page.waitForTimeout(500);
  const stepped = await page.evaluate(() => ({
    idx: _prLoop.idx, url: _prLayers[0] && _prLayers[0]._url,
  }));
  ok('stepFrame advances exactly one frame within the Pi loop',
     stepped.idx === 1 && (stepped.url || '').includes(FRAME_MID),
     JSON.stringify(stepped));

  // The Pi answers with a new frame while the view is scrubbed into history:
  // the position must hold, not jump to the new newest out from under
  // someone looking at an hour-old cell.
  const held = await page.evaluate(() => {
    _prIndex.sites.KTLX.frames.push('20260817_0205');
    _prLoopBuild(_prIndex.sites.KTLX, 'l3', false);
    return { count: _prLoop.frames.length, stamp: _prLoop.frames[_prLoop.idx] };
  });
  ok('a new frame arriving does not yank a scrubbed view back to live',
     held.count === 4 && held.stamp === FRAME_MID, JSON.stringify(held));

  // But the same arrival DOES advance a view that was already live -
  // "watching live" should keep meaning that after every refresh.
  const followed = await page.evaluate(() => {
    _prLoopBuild(_prIndex.sites.KTLX, 'l3', true);   // followLive, as the
    return _prLoop.frames[_prLoop.idx];              // 5-minute timer passes
  });                                                  // when it was live
  ok('a view that was live follows the newest frame forward',
     followed === '20260817_0205', followed);

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
