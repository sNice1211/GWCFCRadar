#!/usr/bin/env node
/*
 * The Forecaster Desk: issuing GWCFC products from inside the radar app.
 *
 *     npm i playwright && node tools/test-forecaster-desk.mjs
 *
 * The thing worth testing here is not that a panel opens. It is the gate and
 * the shape of what goes out:
 *
 *   - a regular person must not even see the button, and must not be able to
 *     reach the desk by calling into it
 *   - a signed-in account that nobody has marked as a forecaster must be
 *     turned away too, because a self-chosen signup "role" word is not a
 *     grant. That is the exact mistake the database rules exist to refuse,
 *     and the button must agree with the rules rather than argue with them
 *   - what publishing writes has to be the shape the portal writes and the
 *     radar reads: three documents, the shapes packed in the v string
 *     (Firestore refuses nested coordinate arrays raw), the desk merged
 *     rather than overwritten so one forecaster cannot wipe another's alerts
 *
 * Firebase is stubbed rather than reached. The point is what the page ASKS
 * the database for; whether Google's servers are up is not under test, and a
 * real sign-in from a test is not something to build.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
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

const LEAFLET_STUB = `(() => {
  const chain = () => new Proxy(function(){}, {
    get: (t, k) => {
      if (k === 'getCenter')  return () => ({ lat: 35.3, lng: -97.3 });
      if (k === 'getZoom')    return () => 7;
      if (k === 'hasLayer')   return () => false;
      if (k === 'getPane')    return () => document.createElement('div');
      if (k === 'createPane') return () => document.createElement('div');
      if (k === 'getBounds')  return () => ({ getWest:()=>-100, getEast:()=>-95,
        getNorth:()=>38, getSouth:()=>33, contains:()=>true, pad(){return this;},
        getCenter:()=>({ lat:35, lng:-97 }) });
      if (k === 'then') return undefined;
      return chain();
    },
    apply: () => chain(), construct: () => chain(),
  });
  Object.defineProperty(window, 'L',
    { value: chain(), writable: true, configurable: true });
})();`;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = '/opt/pw-browsers';
  try {
    for (const d of readdirSync(root)) {
      if (!d.startsWith('chromium-')) continue;
      const p = join(root, d, 'chrome-linux', 'chrome');
      if (existsSync(p)) return p;
    }
  } catch { /* let Playwright try its own */ }
  return undefined;
}

const browser = await chromium.launch({ executablePath: chromePath() });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));

await page.addInitScript(LEAFLET_STUB);
await page.route('**://**', r =>
  r.request().url().startsWith('file://') ? r.continue() : r.abort());
await page.goto('file://' + join(ROOT, 'index.html'),
                { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);

// A stand-in for the account layer: one signed-in user, one profile, and a
// recorder for every Firestore write the desk makes.
//
// Every assignment below is deliberately BARE (_currentUser = ..., not
// window._currentUser = ...). The page declares its auth state with let at
// the top of a classic script, and a top-level let is a lexical binding, not
// a property of window: writing window._currentUser makes a second, unrelated
// name that the page never reads. A bare assignment resolves up the scope
// chain to the real one. This cost a full run of false passes to notice.
await page.evaluate(() => {
  window.__writes = [];
  const rec = (path, method) => (data, opts) => {
    window.__writes.push({ path, method, data, opts: opts || null });
    return Promise.resolve();
  };
  window.__setAccount = (user, profile) => {
    _currentUser = user;
    _fdProfile = null;
    _fdProfileFor = null;
    window.__profile = profile;
  };
  window._fbInit = () => true;
  _fbAuth = { currentUser: null };
  _fbDb = {
    collection: (c) => ({
      doc: (d) => ({
        get: () => Promise.resolve({
          exists: !!window.__profile,
          data: () => window.__profile || {},
        }),
        set: rec(c + '/' + d, 'set'),
      }),
      add: rec(c + '/*', 'add'),
      get: () => Promise.resolve({ docs: [] }),
    }),
  };
  // Nothing is published in this run, so the seed has nothing to bring back.
  window._gwcfcDocFresh = () => Promise.resolve(null);
  window.__toasts = [];
  const realToast = window.showToast;
  window.showToast = (m, ms) => { window.__toasts.push(String(m)); };
  window.__authOpened = 0;
  window.openAuthModal = () => { window.__authOpened++; };
});

console.log('\n1. the page boots with the desk in it');
ok('no uncaught errors while starting', errors.length === 0, errors[0]);
// The desk moved out of the tool rail on the right of the map and into
// Settings, under its own heading. That rail is for things you do TO the map:
// draw, measure, drop a cone. Issuing an official product is not one of
// those, and a hidden button between the pencil and the ruler was easy to
// miss and easy to hit by accident.
ok('the way in lives in Settings now',
   await page.evaluate(() =>
     !!document.querySelector('#lqm-settings-overlay #fd-settings-group')
     && !!document.querySelector('#fd-settings-group #fd-settings-btn')));
ok('and no longer in the map tool rail',
   await page.evaluate(() => !document.getElementById('tool-forecaster')));
ok('the whole section is hidden before anybody signs in',
   await page.evaluate(() =>
     document.getElementById('fd-settings-group').style.display === 'none'));

console.log('\n1b. the Settings rail does not advertise it either');
{
  const r = await page.evaluate(() => {
    window.__setAccount(null, null);
    const rail = document.getElementById('lqm-set-rail');
    if (rail) delete rail.dataset.built;
    _lqmSetBuildRail();
    const tabs = [...document.querySelectorAll('#lqm-set-rail .lqm-set-tab')]
      .map(t => t.textContent.trim());
    return { tabs, gated: document.getElementById('fd-settings-group').dataset.gated };
  });
  // Hiding the section but leaving its tab would announce the feature to
  // exactly the people who cannot use it, which is the thing the whole
  // absent-not-disabled rule is for.
  ok('the section is marked as gated', r.gated === 'forecaster', r.gated);
  ok('and no Forecaster Desk tab is offered to a stranger',
     !r.tabs.some(t => /Forecaster/i.test(t)), r.tabs.join(' | '));
}

console.log('\n1c. and the rail gains the tab once the gate opens');
{
  const r = await page.evaluate(async () => {
    window.__setAccount({ uid: 'u9', email: 'fc9@example.com', isAnonymous: false },
                        { displayName: 'Fern', forecaster: true });
    await _fdSyncButton();
    const tabs = [...document.querySelectorAll('#lqm-set-rail .lqm-set-tab')]
      .map(t => t.textContent.trim());
    return { tabs, shown: document.getElementById('fd-settings-group').style.display };
  });
  // The rail is built once, on the first open, and signing in happens long
  // after that. Without a rebuild the section would exist with no way in.
  ok('the section is revealed', r.shown !== 'none', r.shown);
  ok('and the rail rebuilt itself to reach it',
     r.tabs.some(t => /Forecaster/i.test(t)), r.tabs.join(' | '));
}

console.log('\n2. a signed-out visitor cannot get in');
{
  const r = await page.evaluate(async () => {
    window.__setAccount(null, null);
    window.__toasts = []; window.__authOpened = 0;
    await _fdOpen();
    return { opened: !!document.getElementById('fd-modal'),
             auth: window.__authOpened, toasts: window.__toasts.slice() };
  });
  ok('the desk does not open', !r.opened, JSON.stringify(r));
  ok('it offers the sign-in instead of a dead end', r.auth === 1, String(r.auth));
  ok('and says why in words', /forecaster account/i.test(r.toasts.join(' ')),
     r.toasts.join(' | '));
}

console.log('\n3. an anonymous session is not an account');
{
  const r = await page.evaluate(async () => {
    window.__setAccount({ uid: 'anon1', isAnonymous: true }, null);
    window.__toasts = []; window.__authOpened = 0;
    await _fdOpen();
    return { opened: !!document.getElementById('fd-modal'), auth: window.__authOpened };
  });
  ok('the desk stays shut for a guest', !r.opened, JSON.stringify(r));
  ok('and it is treated as signed out, not as signed in', r.auth === 1);
}

console.log('\n4. signed in is not the same as approved');
{
  // The signup form lets people pick a "role" word for themselves. This is
  // the account that picks the most impressive one available.
  const r = await page.evaluate(async () => {
    window.__setAccount({ uid: 'u2', email: 'someone@example.com',
                          isAnonymous: false },
                        { displayName: 'Someone', role: 'meteorologist',
                          staffRole: '' });
    window.__toasts = [];
    await _fdOpen();
    await _fdSyncButton();
    return { opened: !!document.getElementById('fd-modal'),
             btn: document.getElementById('fd-settings-group').style.display,
             toasts: window.__toasts.slice(),
             may: _fdIsForecaster(window.__profile) };
  });
  ok('a self-chosen role word does not grant issuing', r.may === false);
  ok('the desk refuses to open', !r.opened, JSON.stringify(r));
  ok('the whole section stays hidden for them', r.btn === 'none', r.btn);
  ok('and the refusal names who can grant it',
     /owner|Manage Members/i.test(r.toasts.join(' ')), r.toasts.join(' | '));
}

console.log('\n5. the owner-granted flag is what opens it');
{
  const r = await page.evaluate(async () => {
    window.__setAccount({ uid: 'u3', email: 'fc@example.com',
                          isAnonymous: false },
                        { displayName: 'Fern', forecaster: true });
    await _fdSyncButton();
    await _fdOpen();
    const el = document.getElementById('fd-modal');
    return { btn: document.getElementById('fd-settings-group').style.display,
             open: !!el && el.style.display === 'flex',
             active: _fdActive,
             body: (document.getElementById('fd-body') || {}).textContent || '' };
  });
  ok('the section appears for a granted account', r.btn !== 'none', r.btn);
  ok('the desk opens', r.open, JSON.stringify({ open: r.open, active: r.active }));
  ok('it offers storm marks', /Storm marks/.test(r.body));
  ok('it offers development chances', /Development chance/.test(r.body));
  ok('it offers alert areas', /Alert areas/.test(r.body));
  ok('it offers whole counties, zones and provinces',
     /Counties/.test(r.body) && /Forecast zones/.test(r.body)
     && /States \/ Provinces/.test(r.body), r.body.slice(0, 200));
  ok('and it offers the cone and the alert desk',
     /Storm Cone/.test(r.body) && /Alert Desk/.test(r.body));
}

console.log('\n5b. staff roles count too, matching the database rules');
{
  const r = await page.evaluate(() => ({
    mod:  _fdIsForecaster({ staffRole: 'moderator' }),
    admin: _fdIsForecaster({ staffRole: 'administrator' }),
    lead: _fdIsForecaster({ staffRole: 'leadership' }),
    helper: _fdIsForecaster({ staffRole: 'helper' }),
    none: _fdIsForecaster({}),
    nothing: _fdIsForecaster(null),
  }));
  ok('moderator, administrator and leadership may issue',
     r.mod && r.admin && r.lead, JSON.stringify(r));
  ok('a lesser staff role may not', r.helper === false);
  ok('a plain account may not', r.none === false && r.nothing === false);
}

console.log('\n6. composing puts real shapes on the outlook');
{
  const r = await page.evaluate(() => {
    _fdOutlook = { storms: [], areas: [] };
    // A storm mark, placed the way a map click places one.
    _fdArmStorm(3);
    const armed = !!_fdArmed && _fdArmed.cat === 3;
    window.prompt = () => 'Test Storm';
    _fdMapClick({ latlng: { lat: 25, lng: -70 } });
    // An area clicked out by hand.
    _fdAreaStart('alert', 'warning');
    [[35, -98], [35, -97], [34, -97]].forEach(p =>
      _fdAreaClick({ latlng: { lat: p[0], lng: p[1] } }));
    _fdAreaFinish();
    return { armed, storms: _fdOutlook.storms, areas: _fdOutlook.areas,
             stillArmed: !!_fdArmed, zone: !!_fdZone };
  });
  ok('arming a storm mark takes', r.armed);
  ok('the click places it with its category and name',
     r.storms.length === 1 && r.storms[0].cat === 3
     && r.storms[0].name === 'Test Storm', JSON.stringify(r.storms));
  ok('and disarms afterwards, so the next click is not a second storm',
     r.stillArmed === false);
  ok('an area closes with its points and its level',
     r.areas.length === 1 && r.areas[0].type === 'alert'
     && r.areas[0].level === 'warning' && r.areas[0].poly.length === 3,
     JSON.stringify(r.areas));
  ok('and the drawing state is cleared when it closes', r.zone === false);
}

console.log('\n6b. an area with fewer than three corners is not an area');
{
  const r = await page.evaluate(() => {
    const before = _fdOutlook.areas.length;
    _fdAreaStart('chance', 'high');
    _fdAreaClick({ latlng: { lat: 20, lng: -60 } });
    _fdAreaFinish();
    return { before, after: _fdOutlook.areas.length, zone: !!_fdZone };
  });
  ok('it is refused rather than published as a line',
     r.after === r.before, JSON.stringify(r));
  ok('and the tool is cancelled, not left half armed', r.zone === false);
}

console.log('\n7. what issuing actually writes');
{
  const r = await page.evaluate(async () => {
    window.__writes = [];
    await _fdPublish();
    return { writes: window.__writes.map(w => ({ path: w.path, method: w.method,
               keys: Object.keys(w.data || {}), opts: w.opts })),
             raw: window.__writes };
  });
  const latest = r.raw.find(w => w.path === 'outlooks/latest');
  const archive = r.raw.find(w => w.path === 'outlooks/*');
  const desk = r.raw.find(w => w.path === 'outlooks/desk');
  ok('the current outlook is written', !!latest, JSON.stringify(r.writes));
  ok('an archive copy is added beside it', !!archive);
  ok('and the shared alert desk is written', !!desk);
  ok('the desk write MERGES, so it cannot wipe another forecaster',
     !!desk && desk.opts && desk.opts.merge === true,
     JSON.stringify(desk && desk.opts));
  ok('it is filed under this account, not over everybody',
     !!desk && Object.keys(desk.data)[0] === 'u3',
     JSON.stringify(desk && Object.keys(desk.data)));
  ok('the outlook carries who issued it and when',
     !!latest && latest.data.forecaster === 'Fern'
     && /^\d{4}-\d\d-\d\dT/.test(latest.data.issued || ''),
     JSON.stringify(latest && { f: latest.data.forecaster, i: latest.data.issued }));

  // The shapes have to be a STRING. Firestore refuses nested arrays, and a
  // zone outline is a list of coordinate pairs, which is exactly that. This
  // is the bug that broke publishing from the portal once already.
  ok('the shapes ride as one JSON string, not as nested arrays',
     !!latest && typeof latest.data.v === 'string',
     typeof (latest && latest.data.v));
  const unpacked = latest ? JSON.parse(latest.data.v) : {};
  ok('and it unpacks to what was composed',
     (unpacked.storms || []).length === 1 && (unpacked.areas || []).length === 1,
     JSON.stringify({ s: (unpacked.storms || []).length,
                      a: (unpacked.areas || []).length }));
  ok('with no nested array left anywhere at the top level of the document',
     !!latest && !Object.values(latest.data).some(Array.isArray),
     JSON.stringify(Object.keys(latest ? latest.data : {})));
  ok('the reader is told where to look',
     !!unpacked.view && typeof unpacked.view.zoom === 'number',
     JSON.stringify(unpacked.view));
}

console.log('\n8. an empty outlook is not issued');
{
  const r = await page.evaluate(async () => {
    _fdOutlook = { storms: [], areas: [] };
    window._fdSerializeCones = () => [];
    window._fdSerializeDesk = () => [];
    window.__writes = [];
    await _fdPublish();
    return { writes: window.__writes.length,
             status: (document.getElementById('fd-status') || {}).textContent || '' };
  });
  ok('nothing is written', r.writes === 0, String(r.writes));
  ok('and it says so rather than looking like it worked',
     /nothing/i.test(r.status), r.status);
}

console.log('\n9. an account that lost the grant cannot issue by holding the panel open');
{
  const r = await page.evaluate(async () => {
    _fdOutlook = { storms: [{ id: 'x', cat: 1, lat: 20, lon: -60, name: '' }],
                   areas: [] };
    // The panel is already open from before. The grant is taken away now.
    window.__setAccount({ uid: 'u3', email: 'fc@example.com',
                          isAnonymous: false },
                        { displayName: 'Fern', forecaster: false });
    window.__writes = [];
    await _fdPublish();
    return { writes: window.__writes.length,
             status: (document.getElementById('fd-status') || {}).textContent || '' };
  });
  ok('the rights are re-checked at the moment of issuing, not at open time',
     r.writes === 0, String(r.writes));
  ok('and it says the account is not approved',
     /not approved/i.test(r.status), r.status);
}

console.log('\n10. the handoff from the portal carries no secret in the URL');
{
  const portal = readFileSync(join(ROOT, 'forecasting-portal.html'), 'utf8');
  ok('the portal has a button that hands over',
     /id="btn-radar"/.test(portal) && /function openOnRadar/.test(portal));
  ok('it goes to the radar with a plain hash and nothing else',
     /index\.html#forecaster-desk/.test(portal));
  const fn = portal.slice(portal.indexOf('function openOnRadar'),
                          portal.indexOf('async function portalSignOut'));
  ok('no token, uid or email is put in the address',
     !/token|uid=|email=|\?/.test(fn.replace(/\/\/.*$/gm, '')), fn.slice(0, 200));
  ok('and it refuses to hand over an account that may not issue',
     /isForecaster\(PROFILE\)/.test(fn));
  ok('the button is disabled along with the other forecaster controls',
     /'btn-tools', 'btn-cone', 'btn-radar', 'btn-publish'/.test(portal));
}

console.log('\n11. the radar answers that hash');
{
  const r = await page.evaluate(() => ({
    accepts: typeof _fdCheckHash === 'function',
    src: String(_fdCheckHash),
  }));
  ok('there is a handler for it', r.accepts);
  ok('it recognises the portal\'s hash', /forecaster-desk/.test(r.src));
  ok('it takes the hash back out so a reload does not re-fire it',
     /replaceState/.test(r.src));
  ok('and it waits for the saved account before deciding nobody is signed in',
     /currentUser/.test(r.src) && /await/.test(r.src), r.src.slice(0, 120));
}

console.log('\n12. nothing threw along the way');
ok('no uncaught errors at all', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
