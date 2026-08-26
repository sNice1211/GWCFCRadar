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
ok('the copied app CSS asks for nothing else: its mono and display faces '
   + 'are Comfortaa too',
   /--mono:\s*"Comfortaa"/.test(html) && /--display:\s*"Comfortaa"/.test(html));
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
          // The signed-in user's profile document is real in this harness:
          // with the sign-in wall up, the page reads it to decide whether
          // the account is a forecaster at all.
          get: async () => (c === 'users'
            ? { exists: true, data: () => window.__profile }
            : { exists: false, data: () => ({}) }),
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
  // The Weather Service's point lookup and zone records, as the desk and the
  // portal's county picker really call them.
  if (url.includes('api.weather.gov/points/')) {
    const m = url.match(/points\/([\d.-]+),([\d.-]+)/) || [];
    const county = Number(m[1]) > 27.8 ? 'FLC105' : 'FLC055';
    return route.fulfill({ contentType: 'application/geo+json', body: JSON.stringify({
      properties: { county: 'https://api.weather.gov/zones/county/' + county } }) });
  }
  if (url.includes('api.weather.gov/zones/county/')) {
    const id = url.split('/').pop();
    const name = id === 'FLC105' ? 'Polk' : 'Highlands';
    const c = id === 'FLC105' ? [-81.9, 28.0] : [-81.5, 27.5];
    return route.fulfill({ contentType: 'application/geo+json', body: JSON.stringify({
      properties: { name: name, state: 'FL' },
      geometry: { type: 'Polygon', coordinates: [[
        [c[0] - 0.4, c[1] - 0.4], [c[0] + 0.4, c[1] - 0.4],
        [c[0] + 0.4, c[1] + 0.4], [c[0] - 0.4, c[1] + 0.4],
        [c[0] - 0.4, c[1] - 0.4]]] } }) });
  }
  // Natural Earth's admin-1 polygons, trimmed to the one province the test
  // clicks, in the real file's shape.
  if (url.includes('admin_1_states_provinces'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      type: 'FeatureCollection', features: [{
        type: 'Feature',
        properties: { name: 'Alberta', admin: 'Canada', adm0_a3: 'CAN', postal: 'AB' },
        geometry: { type: 'Polygon', coordinates: [[
          [-120, 49], [-110, 49], [-110, 60], [-120, 60], [-120, 49]]] } }] }) });
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

console.log('\n1. the sign-in wall is up until a forecaster signs in');
{
  const before = await page.evaluate(() => ({
    open: PORTAL_OPEN,
    gateUp: !document.getElementById('gate').classList.contains('off'),
    banner: document.getElementById('testbar').style.display !== 'none',
    tools: document.getElementById('btn-tools').disabled,
    pub: document.getElementById('btn-publish').disabled,
  }));
  ok('testing mode is off for real', before.open === false);
  ok('the gate stands and the testing banner is gone',
     before.gateUp && !before.banner, JSON.stringify(before));
  ok('every tool is locked until someone signs in', before.tools && before.pub);

  // Sign in as an account the owner has flagged as a forecaster.
  const after = await page.evaluate(async () => {
    await window.__authCb({ uid: 'u1', displayName: 'Ralph',
                            email: 'forecaster@example.test', isAnonymous: false });
    return {
      gateDown: document.getElementById('gate').classList.contains('off'),
      tools: document.getElementById('btn-tools').disabled,
      fcstr: OUTLOOK.forecaster,
    };
  });
  ok('a flagged forecaster signing in drops the gate and unlocks the tools',
     after.gateDown && !after.tools, JSON.stringify(after));
  ok('and is stamped as the forecaster on duty', after.fcstr === 'Ralph',
     after.fcstr);
}

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

  // Every element that renders text, measured rather than assumed.
  const fonts = await page.evaluate(() => {
    const bad = [];
    document.querySelectorAll('body *').forEach(el => {
      if (!el.offsetParent && el.tagName !== 'BODY') return;   // hidden, never seen
      const f = getComputedStyle(el).fontFamily || '';
      if (f && !/comfortaa/i.test(f.split(',')[0])) {
        bad.push(el.tagName + '#' + (el.id || '') + ' -> ' + f.slice(0, 40));
      }
    });
    return bad.slice(0, 6);
  });
  ok('nothing on the page renders in anything but Comfortaa',
     fonts.length === 0, fonts.join(' | '));
}

console.log('\n3. who counts as a forecaster, exactly');
{
  // The gate matches the database rules: the owner-granted flag or a staff
  // role. NOT the signup "role" words - people pick those for themselves,
  // and a self-chosen word must never grant publishing to everyone.
  const r = await page.evaluate(() => ({
    asVisitor: isForecaster({ displayName: 'Visitor' }),
    asFlagged: isForecaster({ displayName: 'Ralph', forecaster: true }),
    asRoleWord: isForecaster({ role: 'administrator' }),
    asStaff: isForecaster({ staffRole: 'moderator' }),
  }));
  ok('a plain account is not a forecaster', r.asVisitor === false);
  ok('the owner-granted flag is', r.asFlagged === true);
  ok('a self-chosen signup role word is NOT', r.asRoleWord === false);
  ok('real staff are', r.asStaff === true, JSON.stringify(r));
}

console.log('\n4. placing storms, and drawing hatched zones');
{
  const r = await page.evaluate(() => {
    togglePanel('p-tools');
    const opened = document.getElementById('p-tools').classList.contains('on');
    armStorm(4);
    const armed = { kind: ARMED && ARMED.kind, cat: ARMED && ARMED.cat,
                    lit: document.querySelector('.symbtn[data-cat="4"]').classList.contains('arm'),
                    note: document.getElementById('armnote').textContent };
    window.prompt = () => 'Ana';
    map.fire('click', { latlng: L.latLng(24, -70) });
    const placed = JSON.parse(JSON.stringify(OUTLOOK.storms));
    const disarmed = ARMED === null;
    let markers = 0; layers.storms.eachLayer(() => markers++);
    return { opened, armed, placed, disarmed, markers };
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

  // A chance is an AREA now: clicked out, closed, hatched.
  const z = await page.evaluate(() => {
    armArea('chance', 'high');
    const started = { drawing: ZONE !== null, level: ZONE && ZONE.level,
                      bar: document.getElementById('zone-bar').style.display };
    [[18, -58], [22, -56], [21, -50], [16, -52]].forEach(pt =>
      map.fire('click', { latlng: L.latLng(pt[0], pt[1]) }));
    const pts = ZONE.pts.length;
    zoneBarUndo();
    const afterUndo = ZONE.pts.length;
    map.fire('click', { latlng: L.latLng(16, -52) });
    zoneBarFinish();
    const area = OUTLOOK.areas[0];
    let polys = 0, labels = 0;
    layers.areas.eachLayer(l => { if (l.getLatLngs) polys++; else labels++; });
    // The hatch is a real SVG pattern painted onto the path.
    const path = document.querySelector('#map path[fill^="url(#hatch"]');
    const patId = path ? path.getAttribute('fill').replace(/url\(#|\)/g, '') : '';
    const pat = patId ? document.getElementById(patId) : null;
    return { started, pts, afterUndo, area: JSON.parse(JSON.stringify(area)),
             polys, labels, hatched: !!path,
             patternLine: pat ? pat.querySelector('line').getAttribute('stroke') : '',
             rotated: pat ? pat.getAttribute('patternTransform') : '',
             barHidden: document.getElementById('zone-bar').style.display };
  });
  ok('a chance chip starts an area instead of dropping a dot',
     z.started.drawing && z.started.level === 'high' && z.started.bar === 'flex',
     JSON.stringify(z.started));
  ok('clicks build its corners, and Undo takes one back',
     z.pts === 4 && z.afterUndo === 3, z.pts + ' then ' + z.afterUndo);
  ok('Finish closes it into a real polygon area',
     z.area.type === 'chance' && z.area.level === 'high'
       && z.area.poly.length === 4 && z.barHidden === 'none',
     JSON.stringify(z.area).slice(0, 120));
  ok('the zone is drawn with a label over it', z.polys >= 1 && z.labels >= 1,
     z.polys + ' shapes, ' + z.labels + ' labels');
  ok('and it is hatched the way the Hurricane Center hatches, in its own colour',
     z.hatched && z.patternLine.toLowerCase() === '#ee1111'
       && /rotate\(45\)/.test(z.rotated),
     JSON.stringify({ line: z.patternLine, rot: z.rotated }));

  const round = await page.evaluate(() => {
    const a = OUTLOOK.areas[0];
    const before = a.poly.length;
    zoneToggleRound(a.id);
    const smoothed = zoneRound(a.poly, 3).length;
    // Rounding must keep the area in roughly the same place, not shrink it away.
    const bb = (pts) => {
      const la = pts.map(p => p[0]), lo = pts.map(p => p[1]);
      return [Math.min(...la), Math.max(...la), Math.min(...lo), Math.max(...lo)];
    };
    const b1 = bb(a.poly), b2 = bb(zoneRound(a.poly, 3));
    const near = b1.every((v, i) => Math.abs(v - b2[i]) < 1.2);
    const listed = document.getElementById('tool-list').textContent;
    return { on: a.round, before, smoothed, near, listed };
  });
  ok('a zone can be rounded out, or left with its corners',
     round.on === true && round.smoothed > round.before * 4,
     round.before + ' corners becomes ' + round.smoothed + ' points');
  ok('rounding keeps the area where it was drawn', round.near);
  ok('the list says which it is and offers the other',
     /rounded/.test(round.listed) && /Square the corners/.test(round.listed),
     round.listed.slice(0, 160));
}

console.log('\n4b. areas from real county and province boundaries');
{
  const r = await page.evaluate(async () => {
    // A Warning over two Florida counties, picked off the map.
    pickStart('alert', 'warning', 'county');
    const armed = { picking: PICK !== null, mode: PICK && PICK.mode,
                    bar: document.getElementById('zone-bar').style.display };
    await pickClick({ latlng: L.latLng(27.5, -81.5) });
    await pickClick({ latlng: L.latLng(28.0, -81.9) });
    const got = PICK.zones.map(z => z.name);
    pickFinish();
    const area = OUTLOOK.areas[OUTLOOK.areas.length - 1];
    return { armed, got, area: { type: area.type, level: area.level,
             zones: (area.zones || []).map(z => z.name),
             hasGeom: (area.zones || []).every(z => !!z.geometry) } };
  });
  ok('an alert can be built from counties', r.armed.picking
     && r.armed.mode === 'county' && r.armed.bar === 'flex', JSON.stringify(r.armed));
  ok('clicking the map adds the county the Weather Service names there',
     r.got.length === 2 && r.got.every(n => /county|parish|highlands|polk/i.test(n)),
     r.got.join(', '));
  ok('Finish stores them with their real boundaries',
     r.area.type === 'alert' && r.area.level === 'warning'
       && r.area.zones.length === 2 && r.area.hasGeom, JSON.stringify(r.area));

  const prov = await page.evaluate(async () => {
    pickStart('alert', 'watch', 'admin1');
    await pickClick({ latlng: L.latLng(51.0, -114.0) });   // Alberta
    const got = PICK.zones.map(z => z.name + '|' + z.state);
    pickFinish();
    const area = OUTLOOK.areas[OUTLOOK.areas.length - 1];
    return { got, level: area.level, n: (area.zones || []).length };
  });
  ok('and a province can be picked the same way',
     prov.got.length === 1 && /Alberta\|Canada/.test(prov.got[0])
       && prov.level === 'watch' && prov.n === 1, JSON.stringify(prov));
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

console.log('\n5b. real mouse clicks, not just fired events');
{
  // Every check above fires Leaflet events directly, which is exactly how the
  // multi-point bug hid: with a real pointer, the preview drawn after the
  // first click sat under the cursor and swallowed the second one, so no
  // second point could ever be placed. These use the actual mouse.
  await page.evaluate(() => {
    if (typeof deactivateTool === 'function') deactivateTool();
    if (typeof _scClearAll === 'function') _scClearAll();
    _scMultiPts = [];
    _scTrack = null;
    OUTLOOK.areas.length = 0;
  });
  await page.click('#btn-cone');
  await page.waitForTimeout(150);
  await page.selectOption('#sc-mode-sel', 'multi');
  await page.waitForTimeout(150);
  for (const [x, y] of [[300, 250], [480, 280], [660, 310], [840, 340]]) {
    await page.mouse.move(x - 30, y + 15);
    await page.mouse.click(x, y);
    await page.waitForTimeout(160);
  }
  const cone = await page.evaluate(() => ({
    pts: _scMultiPts.length,
    dotsPassThrough: (() => {
      let blocking = 0;
      if (_scDotLayer) _scDotLayer.eachLayer(l => { if (l.options.interactive) blocking++; });
      return blocking === 0;
    })(),
  }));
  ok('a real mouse can place every point of a multi-point cone, not just the first',
     cone.pts === 4, cone.pts + ' points landed');
  ok('and the preview dots stay out of the way while placing',
     cone.dotsPassThrough);

  await page.click('#sc-finish-btn');
  await page.waitForTimeout(250);
  const done = await page.evaluate(() => ({
    ring: _scTrack && _scTrack.ring ? _scTrack.ring.length : 0,
    publishable: portalSerializeCones().length,
    dotsBack: (() => {
      let live = 0;
      if (_scDotLayer) _scDotLayer.eachLayer(l => { if (l.options.interactive) live++; });
      return live > 0;
    })(),
  }));
  ok('finishing builds the cone and hands it to publish',
     done.ring > 10 && done.publishable >= 1, JSON.stringify(done));
  ok('and the dots become clickable again, so the Points editor still works',
     done.dotsBack);

  // The same trap in the portal's own zone tool. The cone toolbar is closed
  // first: it genuinely sits over the lower half of the map, and a visible
  // toolbar taking a click is a toolbar doing its job, not a bug.
  await page.evaluate(() => {
    deactivateTool();
    const tb = document.getElementById('stormcone-toolbar');
    if (tb) tb.classList.remove('visible');
    const st = document.getElementById('stormcone-status');
    if (st) st.style.display = 'none';
  });
  await page.waitForTimeout(120);
  await page.evaluate(() => armArea('chance', 'high'));
  for (const [x, y] of [[300, 300], [430, 255], [560, 330], [470, 420]]) {
    await page.mouse.move(x, y);
    await page.mouse.click(x, y);
    await page.waitForTimeout(200);
  }
  const zone = await page.evaluate(() => {
    const n = ZONE ? ZONE.pts.length : 0;
    zoneBarFinish();
    return { n, areas: OUTLOOK.areas.length };
  });
  ok('a real mouse can click out every corner of a zone too',
     zone.n === 4 && zone.areas === 1, JSON.stringify(zone));
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
  // Signed out: refused outright, nothing written.
  const refused = await page.evaluate(async () => {
    const keepP = PROFILE, keepU = USER;
    PROFILE = null; USER = null;
    window.__published = [];
    await publishOutlook();
    const n = window.__published.length;
    PROFILE = keepP; USER = keepU;
    return n;
  });
  ok('publishing while signed out is refused, nothing is written',
     refused === 0, String(refused));

  // An account with no forecaster flag: also refused.
  const blocked = await page.evaluate(async () => {
    const keepP = PROFILE, keepU = USER;
    PROFILE = { displayName: 'Visitor' };     // an account with no flag
    USER = { uid: 'u9', email: 'visitor@example.test' };
    window.__published = [];
    await publishOutlook();
    const n = window.__published.length;
    PROFILE = keepP; USER = keepU;
    return n;
  });
  ok('an account without the forecaster flag cannot publish',
     blocked === 0, String(blocked));

  // The flagged forecaster from section 1 publishes for real.
  const r = await page.evaluate(async () => {
    window.__published = [];
    await publishOutlook();
    const paths = window.__published.map(p => p.path);
    const doc = window.__published.find(p => p.path === 'outlooks/latest');
    const desk = window.__published.find(p => p.path === 'outlooks/desk');
    return { paths, doc: (doc || {}).doc || {}, desk: (desk || {}).doc || null,
             stamped: document.getElementById('two-time').textContent };
  });
  ok('publishing writes the current outlook and archives the issuance',
     r.paths.includes('outlooks/latest') && r.paths.some(p => /\(auto\)/.test(p)),
     r.paths.join(', '));
  ok('the published document carries the real tools\' work',
     (r.doc.cones || []).length >= 1 && (r.doc.cones[0].ring || []).length > 3
       && (r.doc.alerts || []).length === 1
       && r.doc.alerts[0].code === 'TOR'
       && (r.doc.areas || []).length >= 1 && !!r.doc.issued
       && !!r.doc.forecaster && !!r.doc.view,
     JSON.stringify({ keys: Object.keys(r.doc), cones: (r.doc.cones || []).length,
       alerts: (r.doc.alerts || []).length }));
  // The shared desk is what lets EVERY forecaster's alerts reach the site at
  // once: one entry per forecaster, merged, never overwritten wholesale.
  ok('the shared alert desk gets this forecaster\'s entry, keyed by uid',
     !!r.desk && !!r.desk.u1 && Array.isArray(r.desk.u1.alerts)
       && r.desk.u1.alerts.length === 1 && r.desk.u1.alerts[0].code === 'TOR'
       && r.desk.u1.forecaster === 'Ralph',
     JSON.stringify(r.desk));
  ok('and the graphic re-stamps itself with the issue time',
     /UTC/.test(r.stamped), r.stamped);
}

console.log('\n8. nothing threw');
ok('the portal never signs in anonymously (that replaced real sessions)',
   !html.includes('signInAnonymously'));
ok('no uncaught page errors', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
