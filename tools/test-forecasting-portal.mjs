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
  const r = await page.evaluate(() => ({
    title: document.getElementById('two-title').textContent.trim(),
    hasTime: /UTC/.test(document.getElementById('two-time').textContent),
    fcstr: document.getElementById('two-fcstr').textContent,
    syms: document.querySelectorAll('#legend-syms svg').length,
    symNums: Array.from(document.querySelectorAll('#legend-syms text')).map(t => t.textContent),
    chances: Array.from(document.querySelectorAll('#legend-chances .chip')).map(c => c.textContent),
    alerts: Array.from(document.querySelectorAll('#legend-alerts .chip')).map(c => c.textContent),
    mapUp: !!document.querySelector('#map .leaflet-map-pane'),
    gold: getComputedStyle(document.querySelector('#two-title')).borderTopColor,
  }));
  ok('the title banner carries the center\'s name',
     /guta weather\/climate forecasting center/i.test(r.title), r.title);
  ok('the header stamps an issue time and a forecaster slot',
     r.hasTime && r.fcstr.length > 0, r.fcstr);
  ok('five storm symbols, numbered 5 down to 1',
     r.syms === 5 && r.symNums.join(',') === '5,4,3,2,1', r.symNums.join(','));
  ok('the four disturbance chances are in the key',
     r.chances.join(',') === 'Extreme,High,Medium,Low', r.chances.join(','));
  ok('the three alert levels are in the key',
     r.alerts.join(',') === 'Emer.,Warning,Watch', r.alerts.join(','));
  ok('the map is live under the format', r.mapUp);
  ok('everything wears the gold outline',
     /232,\s*184,\s*0/.test(r.gold), r.gold);
}

console.log('\n3. the gate: only approved forecasters get the tools');
{
  const out = await page.evaluate(() => ({
    gateUp: !document.getElementById('gate').classList.contains('off'),
    toolsOff: document.getElementById('btn-tools').disabled,
    pubOff: document.getElementById('btn-publish').disabled,
  }));
  ok('signed out, the gate is up and the tools are dead',
     out.gateUp && out.toolsOff && out.pubOff, JSON.stringify(out));

  const plain = await page.evaluate(async () => {
    // A real account with no forecaster flag.
    _fbDb.collection = () => ({ doc: () => ({
      get: async () => ({ exists: true, data: () => ({ displayName: 'Visitor' }) }) }) });
    await onUser({ uid: 'u2', email: 'someone@example.com' });
    return { msg: document.getElementById('gate-msg').textContent,
             gateUp: !document.getElementById('gate').classList.contains('off'),
             toolsOff: document.getElementById('btn-tools').disabled };
  });
  ok('a signed-in account without the flag is told why, and stays locked out',
     plain.gateUp && plain.toolsOff && /not approved/i.test(plain.msg), plain.msg);

  const good = await page.evaluate(async () => {
    _fbDb.collection = (c) => ({
      doc: (d) => ({
        get: async () => ({ exists: true,
          data: () => ({ displayName: 'Ralph', forecaster: true }) }),
        set: async (doc) => { window.__published.push({ path: c + '/' + d, doc }); },
      }),
      add: async (doc) => { window.__published.push({ path: c + '/(auto)', doc }); },
    });
    await onUser({ uid: 'u1', email: 'ralph@example.com', displayName: 'Ralph' });
    return { gateUp: !document.getElementById('gate').classList.contains('off'),
             tools: !document.getElementById('btn-tools').disabled,
             fcstr: document.getElementById('two-fcstr').textContent,
             who: document.getElementById('whoami').textContent };
  });
  ok('an approved forecaster gets in, and the graphic signs itself with them',
     !good.gateUp && good.tools && /Ralph/.test(good.fcstr) && /Ralph/.test(good.who),
     JSON.stringify(good));
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

console.log('\n5. the storm cone');
{
  const r = await page.evaluate(() => {
    togglePanel('p-cone');
    document.getElementById('cone-name').value = 'Invest 94L';
    document.getElementById('cone-cat').value = '3';
    document.getElementById('cone-wide').value = '400';
    coneArm();
    const arming = CONE !== null;
    [[14, -45], [17, -52], [20, -60], [24, -70]].forEach(p =>
      map.fire('click', { latlng: L.latLng(p[0], p[1]) }));
    const pts = CONE.pts.length;
    const poly = conePolygon(CONE);
    // The cone must be tighter at the first point than at the last, which is
    // the whole idea of a cone rather than a corridor.
    const w0 = Math.abs(poly[0][0] - poly[poly.length - 1][0]);
    const wN = Math.abs(poly[pts - 1][0] - poly[pts][0]);
    coneUndo();
    const afterUndo = CONE.pts.length;
    coneFinish();
    const finished = CONE === null && OUTLOOK.cones.length === 1;
    const named = OUTLOOK.cones[0].name;
    let coneLayers = 0; layers.cones.eachLayer(() => coneLayers++);
    const listed = document.querySelectorAll('#cone-list .item').length;
    return { arming, pts, w0, wN, afterUndo, finished, named, coneLayers, listed };
  });
  ok('the cone tool takes track points off the map',
     r.arming && r.pts === 4, String(r.pts));
  ok('the cone opens out with time instead of staying a corridor',
     r.wN > r.w0 * 1.5, 'start ' + r.w0.toFixed(2) + ' end ' + r.wN.toFixed(2));
  ok('a mis-click can be undone', r.afterUndo === 3, String(r.afterUndo));
  ok('finishing locks it onto the outlook, named',
     r.finished && r.named === 'Invest 94L', r.named);
  ok('the cone and its track line are drawn', r.coneLayers === 2, String(r.coneLayers));
  ok('and it is listed in the cone menu', r.listed === 1, String(r.listed));
}

console.log('\n6. the alert desk, both halves');
{
  const r = await page.evaluate(async () => {
    togglePanel('p-desk');
    const tabs = document.querySelectorAll('#p-desk .tab').length;
    await deskLoadLive();
    const live = document.querySelectorAll('#desk-live-list .item').length;
    const liveText = document.getElementById('desk-live-list').textContent;
    deskTab('issue');
    const issueShown = document.getElementById('desk-issue').style.display !== 'none';
    document.getElementById('al-level').value = 'warning';
    document.getElementById('al-head').value = 'Hurricane Warning, Big Bend';
    document.getElementById('al-area').value = 'Taylor to Wakulla counties';
    document.getElementById('al-text').value = 'Life threatening surge expected.';
    deskIssue();
    return { tabs, live, liveText, issueShown,
             issued: JSON.parse(JSON.stringify(OUTLOOK.alerts)),
             listed: document.querySelectorAll('#desk-issued .item').length,
             cleared: document.getElementById('al-head').value };
  });
  ok('the desk has both halves in one menu', r.tabs === 2, String(r.tabs));
  ok('the live half shows what the Weather Service has out right now',
     r.live === 2 && /Hurricane Warning/.test(r.liveText), r.liveText.slice(0, 80));
  ok('the issue half is a form for GWCFC\'s own alerts', r.issueShown);
  ok('issuing one keeps it with the outlook',
     r.issued.length === 1 && r.issued[0].level === 'warning'
       && /Big Bend/.test(r.issued[0].headline), JSON.stringify(r.issued));
  ok('it is listed and the form clears for the next one',
     r.listed === 1 && r.cleared === '');
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
  ok('the published document carries everything on the graphic',
     (r.doc.cones || []).length === 1 && (r.doc.alerts || []).length === 1
       && (r.doc.areas || []).length === 2 && !!r.doc.issued
       && r.doc.forecaster === 'Ralph' && !!r.doc.view,
     JSON.stringify(Object.keys(r.doc)));
  ok('and the graphic re-stamps itself with the issue time',
     /UTC/.test(r.stamped), r.stamped);

  const blocked = await page.evaluate(async () => {
    const keep = PROFILE;
    PROFILE = { displayName: 'Visitor' };     // flag revoked mid-session
    window.__published = [];
    await publishOutlook();
    const n = window.__published.length;
    PROFILE = keep;
    return n;
  });
  ok('an unapproved account cannot publish even by calling it directly',
     blocked === 0, String(blocked));
}

console.log('\n8. nothing threw');
ok('no uncaught page errors', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
