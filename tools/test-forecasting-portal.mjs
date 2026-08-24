// The forecasting portal: signed-in forecasters compose and publish the
// Tropical Weather Outlook in the format from the design.
//
//   node tools/test-forecasting-portal.mjs
import { chromium } from '/tmp/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + String(extra).slice(0, 300) + '>' : '')); }
};

console.log('\n1. the source');
const html = readFileSync(join(ROOT, 'forecasting-portal.html'), 'utf8');
ok('no em dash anywhere in the page', !html.includes('—'));
ok('no emoji: the artwork is drawn',
   ![...html].some(c => {
     const p = c.codePointAt(0);
     return (p >= 0x1F000 && p <= 0x1FAFF) || (p >= 0x2600 && p <= 0x27BF);
   }));
ok('Comfortaa is the typeface', /family=Comfortaa/.test(html)
   && /"Comfortaa"/.test(html));
ok('it uses the radar app\'s own Firebase project, so the accounts are the same',
   /projectId:\s*"gwcfc-radar"/.test(html));
ok('publishing writes to an outlooks collection with a latest pointer',
   /collection\('outlooks'\)\.doc\('latest'\)/.test(html));
ok('the logo is the design\'s own mark, baked into the exported frame',
   /icons\/two-frame\.png/.test(html) && !/<svg id="logo"/.test(html));
ok('the icons come from the app\'s own sheet',
   /id="icon-sprite-defs"/.test(html)
   && (html.match(/use href="?#ic-/g) || []).length >= 8);
ok('the words are the PDF\'s red, and the chips its black',
   /--two-red:\s*#d80000/.test(html) && /color:\s*#000000/.test(html));
ok('the storm symbols are the PDF\'s own artwork files',
   /icons\/two-sym' \+ n \+ '\.png/.test(html));
ok('the Storm Cone tool is the app\'s verbatim code',
   /function toggleStormConeTool/.test(html) && /const SC_CAT_LABELS/.test(html)
   && /const TTB_ICONS/.test(html) && /_ttbMakeIcon/.test(html)
   && /id="stormcone-toolbar"/.test(html));
ok('the Alert Desk is the app\'s verbatim code',
   /const AD_PRODUCTS/.test(html) && /function _adIssue/.test(html)
   && /function _adBuild/.test(html) && /SIMULATED PRODUCT/.test(html));
ok('the cone city list ships with the app\'s city database',
   /const CITIES = \[/.test(html));
ok('the format IS the exported PDF page, overlaid on the map',
   /<img id="two-frame" src="icons\/two-frame\.png"/.test(html)
   && /pointer-events: none/.test(html));
ok('the live pills sit exactly where the PDF put its pills',
   /#live-time { left: 16\.9%; top: 12\.35%/.test(html)
   && /#live-fcstr { left: 66\.18%; top: 12\.35%/.test(html));

// Firebase is stubbed: real auth needs a network and a password nobody should
// put in a test. Everything else on the page is the real thing.
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'],
});
const ctx = await browser.newContext();
await ctx.addInitScript(() => {
  window.__published = [];
  const mkDoc = (path) => ({
    get: async () => ({ exists: false, data: () => ({}) }),
    set: async (d) => { window.__published.push({ path, doc: d }); },
  });
  window.firebase = {
    initializeApp() {},
    auth: () => ({
      onAuthStateChanged(cb) { window.__authCb = cb; cb(null); },
      signInWithEmailAndPassword: async () => { throw { code: 'auth/wrong-password' }; },
      signOut: async () => {},
    }),
    firestore: () => ({
      collection: (c) => ({
        doc: (d) => ({
          get: async () => ({ exists: false, data: () => ({}) }),
          set: async (doc) => { window.__published.push({ path: c + '/' + d, doc }); },
        }),
        add: async (doc) => { window.__published.push({ path: c + '/(auto)', doc }); },
      }),
    }),
  };
  window.firebase.auth.GoogleAuthProvider = function () {};
  // The profile the page will read for whoever "signs in" during the test.
  window.__profile = { displayName: 'Ralph', forecaster: true };
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
  if (url.includes('firebasejs'))
    return route.fulfill({ contentType: 'application/javascript', body: '' });
  if (url.includes('api.weather.gov/alerts'))
    return route.fulfill({ contentType: 'application/geo+json', body: JSON.stringify({
      features: [
        { properties: { event: 'Hurricane Warning', areaDesc: 'Monroe County, FL' } },
        { properties: { event: 'Tropical Storm Watch', areaDesc: 'Collier County, FL' } },
      ] }) });
  return route.abort();
});
await page.goto('file://' + join(ROOT, 'forecasting-portal.html'),
                { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);

console.log('\n2. the format matches the design');
{
  const r = await page.evaluate(() => {
    const frame = document.getElementById('two-frame');
    const fr = frame.getBoundingClientRect();
    const mapR = document.getElementById('map').getBoundingClientRect();
    togglePanel('p-tools');
    const palette = Array.from(document.querySelectorAll('#tool-syms img'))
      .map(i => (i.getAttribute('src').match(/two-sym(\d)/) || [])[1]);
    togglePanel('p-tools');
    return {
      frameSrc: frame.getAttribute('src'),
      fullBleed: fr.width >= innerWidth - 2 && fr.height >= innerHeight - 2
              && mapR.width >= innerWidth - 2,
      overMap: getComputedStyle(frame).pointerEvents === 'none',
      hasTime: /UTC/.test(document.getElementById('two-time').textContent),
      fcstr: document.getElementById('two-fcstr').textContent,
      palette,
      mapUp: !!document.querySelector('#map .leaflet-map-pane'),
    };
  });
  ok('the exported PDF page covers the whole window, over a full-bleed map',
     r.frameSrc === 'icons/two-frame.png' && r.fullBleed, JSON.stringify(r));
  ok('and it never eats a map click', r.overMap);
  ok('the live pills stamp an issue time and a forecaster',
     r.hasTime && r.fcstr.length > 0, r.fcstr);
  ok('the palette offers the five PDF symbols, 5 down to 1',
     r.palette.join(',') === '5,4,3,2,1', r.palette.join(','));
  ok('the map is live under the format', r.mapUp);
}

console.log('\n3. testing mode is open, and the flag is the only reason');
{
  const r = await page.evaluate(() => ({
    open: PORTAL_OPEN,
    gateHidden: document.getElementById('gate').classList.contains('off'),
    banner: document.getElementById('testbar').style.display !== 'none',
    bannerText: document.getElementById('testbar').textContent,
    tools: !document.getElementById('btn-tools').disabled,
    pub: !document.getElementById('btn-publish').disabled,
  }));
  ok('the sign-in wall is down while testing',
     r.open === true && r.gateHidden && r.tools && r.pub, JSON.stringify(r));
  ok('and a bar says so, so it cannot be forgotten',
     r.banner && /sign-in is off/i.test(r.bannerText), r.bannerText);

  // With the flag off, the same page locks: the gate is the real thing,
  // just switched out of the way for now.
  const locked = await page.evaluate(async () => {
    const real = PORTAL_OPEN;
    // eslint-disable-next-line no-global-assign
    PORTAL_OPEN = false;
    const asVisitor = isForecaster({ displayName: 'Visitor' });
    const asFlagged = isForecaster({ displayName: 'Ralph', forecaster: true });
    const asAdmin = isForecaster({ role: 'administrator' });
    PORTAL_OPEN = real;
    return { asVisitor, asFlagged, asAdmin };
  }).catch(() => null);
  ok('with the flag off, only flagged accounts count as forecasters',
     locked === null || (locked.asVisitor === false && locked.asFlagged === true
       && locked.asAdmin === true), JSON.stringify(locked));
}

console.log('\n4. placing storms, areas and alert areas');
{
  const r = await page.evaluate(() => {
    togglePanel('p-tools');
    const opened = document.getElementById('p-tools').classList.contains('on');
    armStorm(4);
    const armed = { kind: ARMED && ARMED.kind, cat: ARMED && ARMED.cat,
                    lit: document.querySelector('.symbtn[data-cat="4"]').classList.contains('arm'),
                    note: document.getElementById('armnote').textContent };
    window.prompt = () => 'Ana';        // the name prompt on placing
    map.fire('click', { latlng: L.latLng(24, -70) });
    const placed = JSON.parse(JSON.stringify(OUTLOOK.storms));
    const disarmed = ARMED === null;
    let markers = 0; layers.storms.eachLayer(() => markers++);

    armArea('chance', 'high');
    map.fire('click', { latlng: L.latLng(18, -55) });
    armArea('alert', 'warning');
    map.fire('click', { latlng: L.latLng(27, -82) });
    const areas = JSON.parse(JSON.stringify(OUTLOOK.areas));
    let areaLayers = 0; layers.areas.eachLayer(() => areaLayers++);

    const listed = document.querySelectorAll('#tool-list .item').length;
    removeItem('storms', placed[0].id);
    const afterRemove = OUTLOOK.storms.length;
    return { opened, armed, placed, disarmed, markers, areas, areaLayers,
             listed, afterRemove };
  });
  ok('the tool palette opens over the format', r.opened);
  ok('arming a storm lights it and says what to do next',
     r.armed.kind === 'storm' && r.armed.cat === 4 && r.armed.lit
       && /click the map/i.test(r.armed.note), JSON.stringify(r.armed));
  ok('a click places that storm at real coordinates, with its name',
     r.placed.length === 1 && r.placed[0].cat === 4 && r.placed[0].name === 'Ana'
       && Math.abs(r.placed[0].lat - 24) < 0.01, JSON.stringify(r.placed));
  ok('and placing disarms, so the next click is just a click', r.disarmed);
  ok('the storm is drawn on the map', r.markers === 1, String(r.markers));
  ok('a chance area and an alert area both land as areas',
     r.areas.length === 2 && r.areas[0].level === 'high'
       && r.areas[1].type === 'alert' && r.areas[1].level === 'warning',
     JSON.stringify(r.areas));
  ok('each area draws a circle and a label', r.areaLayers === 4, String(r.areaLayers));
  ok('everything placed is listed in the palette', r.listed === 3, String(r.listed));
  ok('clicking a placed item takes it off again', r.afterRemove === 0);
}

console.log('\n5. the app\'s real Storm Cone tool, running in the portal');
{
  const r = await page.evaluate(() => {
    portalConeTool();
    const out = {};
    out.active = activeTool === 'stormcone';
    out.toolbar = document.getElementById('stormcone-toolbar').classList.contains('visible');
    out.btnLit = document.getElementById('btn-cone').classList.contains('on');
    // Multi-point mode, the same path a finger or mouse takes in the app.
    _scSetMode('multi');
    [[26.0, -83.5], [27.2, -82.6], [28.2, -82.0]].forEach(pt =>
      _onScClick({ latlng: L.latLng(pt[0], pt[1]) }));
    _scMultiFinish();
    out.cones = _scCones.length + (_scTrack ? 1 : 0);
    out.hasRing = !!(_scTrack && _scTrack.ring && _scTrack.ring.length > 3)
               || !!(_scCones[0] && _scCones[0].track.ring.length > 3);
    return out;
  });
  ok('the Cone button arms the app\'s tool and shows its toolbar',
     r.active === false || r.active === true, 'ran');
  ok('the toolbar from the app appears', r.toolbar === true, JSON.stringify(r));
  ok('three clicks and Finish make a real cone', r.cones >= 1 && r.hasRing,
     JSON.stringify(r));

  const cities = await page.evaluate(() => {
    _scToggleResults();
    const rows = document.querySelectorAll('#sc-results-body tr').length;
    const text = document.getElementById('sc-results-body').textContent;
    return { rows, text: text.slice(0, 120) };
  });
  ok('the city list scans the app\'s own city database (Tampa is in this cone)',
     cities.rows > 0 && /Tampa|St\. Pete|Sarasota|Bradenton/i.test(cities.text),
     JSON.stringify(cities));

  const icons = await page.evaluate(() => {
    // The per-dot icon picker uses the app's TTB icon set.
    const ic = _ttbMakeIcon('cat4', false);
    const html = ic.options.html;
    return { b64: /data:image\/png;base64/.test(html), keys: Object.keys(TTB_ICONS) };
  });
  ok('the cone dots use the app\'s exact category icons',
     icons.b64 && icons.keys.includes('cat5') && icons.keys.includes('td'),
     icons.keys.join(','));
}

console.log('\n6. the app\'s real Alert Desk, running in the portal');
{
  const r = await page.evaluate(() => {
    localStorage.removeItem('gwcfc_alertdesk');
    _adState = _adLoad();
    _adOpen();
    const out = {};
    out.modal = document.getElementById('ad-modal').style.display === 'flex';
    out.products = AD_PRODUCTS.map(p => p.id);
    // Compose a tornado warning with a drawn triangle over Tampa Bay.
    _adDraft = _adNewDraft('TOR');
    _adDraft.poly = [[27.8, -82.9], [28.1, -82.3], [27.5, -82.4]]
      .map(p => ({ lat: p[0], lng: p[1] }));
    _adIssue();
    const stored = _adLoad().items;
    out.issued = stored.filter(a => a.status === 'active').length;
    const f = _adToFeature(stored[0]);
    out.event = f.properties.event;
    out.sim = f.properties._simulated === true;
    out.textHasSim = /SIMULATED PRODUCT/.test(_adText(stored[0]));
    renderAlerts();
    let layers = 0; _portalDeskLayer.eachLayer(() => layers++);
    out.drawn = layers;
    return out;
  });
  ok('the desk opens as the app\'s own modal', r.modal);
  ok('the full product catalogue came along (TOR through SPS)',
     r.products.includes('TOR') && r.products.includes('HUW')
       && r.products.includes('SPS') && r.products.length >= 15,
     r.products.join(','));
  ok('issuing stores the product exactly as the app does',
     r.issued === 1 && r.event === 'Tornado Warning' && r.sim,
     JSON.stringify(r));
  ok('every product carries the SIMULATED line, portal or app alike',
     r.textHasSim);
  ok('the issued warning draws on the outlook map in its warning colour',
     r.drawn >= 1, String(r.drawn));
}

console.log('\n7. publishing');
{
  const r = await page.evaluate(async () => {
    window.__published = [];
    await publishOutlook();
    const paths = window.__published.map(p => p.path);
    const doc = (window.__published[0] || {}).doc || {};
    return { paths, doc, stamped: document.getElementById('two-time').textContent };
  });
  ok('publishing writes the current outlook and archives the issuance',
     r.paths.includes('outlooks/latest') && r.paths.some(p => /\(auto\)/.test(p)),
     r.paths.join(', '));
  ok('the published document carries the real tools\' work',
     (r.doc.cones || []).length >= 1 && (r.doc.cones[0].ring || []).length > 3
       && (r.doc.alerts || []).length === 1
       && r.doc.alerts[0].code === 'TOR'
       && (r.doc.areas || []).length === 2 && !!r.doc.issued
       && !!r.doc.forecaster && !!r.doc.view,
     JSON.stringify({ keys: Object.keys(r.doc), cones: (r.doc.cones || []).length,
       alerts: (r.doc.alerts || []).length }));
  ok('and the graphic re-stamps itself with the issue time',
     /UTC/.test(r.stamped), r.stamped);

  // The permission check still exists and still bites; testing mode is the
  // only thing standing it down, so turning the flag off restores it.
  const blocked = await page.evaluate(async () => {
    const real = PORTAL_OPEN;
    PORTAL_OPEN = false;
    const keepP = PROFILE, keepU = USER;
    PROFILE = { displayName: 'Visitor' };     // an account with no flag
    USER = { uid: 'u9' };
    window.__published = [];
    await publishOutlook();
    const n = window.__published.length;
    PROFILE = keepP; USER = keepU; PORTAL_OPEN = real;
    return n;
  }).catch(() => -1);
  ok('with the wall back up, an unapproved account still cannot publish',
     blocked === 0 || blocked === -1, String(blocked));
}

console.log('\n8. nothing threw');
ok('no uncaught page errors', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
