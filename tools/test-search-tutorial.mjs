#!/usr/bin/env node
/*
 * The search offers only things the app has, and the tutorial describes only
 * things the app has.
 *
 *     node tools/test-search-tutorial.mjs
 *
 * Both drift the same way, and both drift silently. A search entry naming a
 * layer that was removed looks exactly like one that works until somebody
 * picks it; a sentence in a tutorial describing a panel that moved reads
 * perfectly well and sends the reader to an empty corner of the screen.
 *
 * So neither is checked against a list written beside it. Both are checked
 * against the app itself: the overlays the app really draws, the radar
 * products it really has, the settings tabs it really builds, and the
 * functions it really defines.
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

const html = readFileSync(join(ROOT, 'index.html'), 'utf8');

console.log('\n1. the source');
ok('no em dash anywhere in the page', !html.includes('\u2014'));
// The old catalogue was thirty-seven hand-typed entries, twenty-two of which
// called a function whose buttons no longer exist anywhere in the interface.
ok('the catalogue is derived, not hand-typed',
   /function _srchBuildCatalog\(\)/.test(html));
ok('and it is built on first use, since it reads markup further down the page',
   /function _srchCatalog\(\)/.test(html) && /_srchCat = _srchBuildCatalog\(\)/.test(html));
ok('nothing in it calls the retired tab switcher',
   !/action:\s*\(\)\s*=>\s*switchTab\(/.test(html));
// Comments stripped first: the note explaining what the indices used to be
// names them, and matching that would fail the test for saying so.
const code = html.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
ok('the quick-access row picks by name rather than by array index',
   !/RADAR_CATALOG\[\d+\]/.test(code));

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'],
});
const ctx = await browser.newContext();
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

console.log('\n2. the retired navigation really is retired');
{
  const r = await page.evaluate(() => ({
    buttons: document.querySelectorAll('[onclick*="switchTab"]').length,
    currentTab: typeof currentTab !== 'undefined' ? String(currentTab) : '(none)',
  }));
  // This is the fact the old catalogue was wrong about. Stated here so that if
  // the tabs ever come back, this test says so rather than quietly passing.
  ok('there are no tab buttons left in the interface', r.buttons === 0, r.buttons);
  ok('and the app is not on one of the old tabs',
     !['regular', 'tropical', 'severe', 'ice'].includes(r.currentTab), r.currentTab);
}

console.log('\n3. every search entry points at something real');
{
  const r = await page.evaluate(() => {
    const cat = _srchCatalog();
    return {
      total: cat.length,
      byType: cat.reduce((a, c) => (a[c.type] = (a[c.type] || 0) + 1, a), {}),
      noAction: cat.filter(c => typeof c.action !== 'function').map(c => c.label),
      noLabel: cat.filter(c => !c.label || !String(c.label).trim()).length,
      noKw: cat.filter(c => !Array.isArray(c.kw) || !c.kw.length).map(c => c.label),
      dupes: (() => {
        const seen = new Set(), out = [];
        cat.forEach(c => { if (seen.has(c.label)) out.push(c.label); seen.add(c.label); });
        return out;
      })(),
    };
  });
  ok('there is a real catalogue', r.total >= 40, String(r.total));
  ok('every entry has an action to run', r.noAction.length === 0, r.noAction.join(' '));
  ok('every entry has a label', r.noLabel === 0, String(r.noLabel));
  ok('every entry has keywords to match on', r.noKw.length === 0, r.noKw.join(' '));
  ok('no entry appears twice', r.dupes.length === 0, r.dupes.join(' '));
  console.log('       ' + Object.entries(r.byType).map(([k, v]) => `${k} ${v}`).join(', '));
}

console.log('\n4. the entries match what the app actually has');
{
  const r = await page.evaluate(() => {
    const cat = _srchCatalog();
    const labels = cat.map(c => c.label);

    // Overlays: one search entry per pill the app draws, no more and no less.
    const pills = [...document.querySelectorAll('#overlay-pills-row .ov-pill[data-ovid]')]
      .map(p => p.querySelector('.ov-rowname').textContent.trim());
    const ovLabels = cat.filter(c => c.type === 'OVERLAY').map(c => c.label);

    // Radar: one per product in the product table.
    const prod = Object.keys(PR_PRODUCTS || {});
    const radarLabels = cat.filter(c => c.type === 'RADAR').map(c => c.label);

    // Settings: one per tab the rail actually builds.
    lqmOpenSettings(); _lqmSetBuildRail();
    const tabs = [...document.querySelectorAll('#lqm-set-rail .lqm-set-tab')]
      .map(t => t.textContent.trim());
    const setLabels = cat.filter(c => c.type === 'SETTING')
      .map(c => c.label.replace(/^Settings: /, ''));
    if (typeof lqmCloseSettings === 'function') lqmCloseSettings();

    return {
      pills, ovLabels,
      ovMissing: pills.filter(p => !ovLabels.includes(p)),
      ovExtra: ovLabels.filter(l => !pills.includes(l)),
      prodCount: prod.length, radarCount: radarLabels.length,
      radarMissing: prod.filter(k => !radarLabels.some(l =>
        l === 'Radar: ' + ((PR_PRODUCTS[k] || {}).label || k))),
      tabs, setLabels,
      labels,
    };
  });
  ok('every overlay in the list is searchable',
     r.ovMissing.length === 0, r.ovMissing.join(' '));
  ok('and nothing is searchable that is not in the list',
     r.ovExtra.length === 0, r.ovExtra.join(' '));
  console.log(`       (${r.pills.length} overlays, all matched)`);
  ok('every radar product is searchable',
     r.radarMissing.length === 0, r.radarMissing.join(' '));
  console.log(`       (${r.prodCount} radar products, ${r.radarCount} entries)`);
  ok('the settings tabs are searchable', r.setLabels.length > 0, r.setLabels.join(' '));
  // The About card was removed, so it must not be offered.
  ok('About is not offered, because it no longer exists',
     !r.labels.some(l => /About/i.test(l)), r.labels.filter(l => /About/i.test(l)).join(' '));
}

console.log('\n5. picking an entry does the thing');
{
  const r = await page.evaluate(async () => {
    const cat = _srchCatalog();
    const out = {};

    // An overlay entry should flip that overlay's pill.
    const ov = cat.find(c => c.type === 'OVERLAY' && c.label === 'Lightning Strikes');
    const pill = document.querySelector('.ov-pill[data-ovid="lightning"]');
    const before = pill.classList.contains('active');
    ov.action();
    await new Promise(r2 => setTimeout(r2, 200));
    out.overlayFlipped = pill.classList.contains('active') !== before;
    ov.action();                              // put it back
    await new Promise(r2 => setTimeout(r2, 200));

    // A radar entry should change the selected product, not just a tab.
    const rad = cat.find(c => c.label === 'Radar: Velocity');
    const prodBefore = typeof _prProduct !== 'undefined' ? _prProduct : null;
    rad.action();
    await new Promise(r2 => setTimeout(r2, 250));
    out.radarProduct = typeof _prProduct !== 'undefined' ? _prProduct : null;
    out.radarChanged = out.radarProduct === 'velocity' || out.radarProduct !== prodBefore;

    // A settings entry should open Settings on that tab.
    const setEntry = cat.find(c => c.type === 'SETTING');
    setEntry.action();
    await new Promise(r2 => setTimeout(r2, 200));
    const shown = [...document.querySelectorAll('#lqm-set-content .lqm-settings-group')]
      .filter(g => !g.hidden).length;
    out.settingsOpened = shown > 0;
    if (typeof lqmCloseSettings === 'function') lqmCloseSettings();

    // And a map switch should really toggle its layer setting.
    const mapEntry = cat.find(c => c.type === 'MAP' && c.label === 'County Borders');
    const wasOn = _mbOn.county;
    mapEntry.action();
    await new Promise(r2 => setTimeout(r2, 300));
    out.mapToggled = _mbOn.county !== wasOn;
    if (_mbOn.county !== wasOn) mapEntry.action();

    return out;
  });
  ok('an overlay entry turns that overlay on', r.overlayFlipped);
  ok('a radar entry selects that radar product', r.radarChanged,
     'product is now ' + r.radarProduct);
  ok('a settings entry opens Settings on a tab', r.settingsOpened);
  ok('a map entry flips that map layer', r.mapToggled);
}

console.log('\n6. typing finds the thing');
{
  const r = await page.evaluate(() => {
    const hit = (q) => {
      const s = q.toLowerCase();
      return _srchCatalog().filter(c =>
        c.label.toLowerCase().includes(s) || c.kw.some(k => k.includes(s)))
        .map(c => c.label);
    };
    return {
      velocity: hit('velocity'), lightning: hit('lightning'),
      hail: hit('hail'), desk: hit('warning'), eas: hit('eas'),
      county: hit('county'), metar: hit('metar'), ice: hit('ice mode'),
    };
  });
  ok('"velocity" finds the velocity product', r.velocity.some(l => /Velocity/.test(l)), r.velocity.join(' | '));
  ok('"lightning" finds the lightning overlay', r.lightning.some(l => /Lightning/.test(l)), r.lightning.join(' | '));
  ok('"hail" finds something', r.hail.length > 0, r.hail.join(' | '));
  ok('"warning" finds the Alert Desk', r.desk.some(l => /Alert Desk/.test(l)), r.desk.join(' | '));
  ok('"eas" finds the EAS panel', r.eas.some(l => /EAS/.test(l)), r.eas.join(' | '));
  ok('"county" finds the county borders switch', r.county.some(l => /County/.test(l)), r.county.join(' | '));
  // The two that should now find nothing, because neither exists.
  ok('"metar" finds nothing, because that overlay was removed',
     r.metar.length === 0, r.metar.join(' | '));
  ok('"ice mode" finds nothing, because that tab was retired',
     r.ice.length === 0, r.ice.join(' | '));
}

console.log('\n7. the tutorial describes the app as it is');
{
  const r = await page.evaluate(() => {
    // Prose only. #tut-modal-body contains a <script> in the markup (it has
    // for a long time, and it is harmless because a script does not render),
    // but textContent hands back its source, so reading it raw means the
    // tutorial appears to say whatever that script's comments say.
    const body = document.getElementById('tut-modal-body');
    let text = '';
    if (body) {
      const clone = body.cloneNode(true);
      clone.querySelectorAll('script, style').forEach(n => n.remove());
      text = clone.textContent;
    }
    const pills = [...document.querySelectorAll('#overlay-pills-row .ov-pill[data-ovid]')]
      .map(p => p.querySelector('.ov-rowname').textContent.trim());
    lqmOpenSettings(); _lqmSetBuildRail();
    const tabs = [...document.querySelectorAll('#lqm-set-rail .lqm-set-tab')]
      .map(t => t.textContent.trim());
    if (typeof lqmCloseSettings === 'function') lqmCloseSettings();
    // Every "Settings -> X" the tutorial promises, against the tabs that exist.
    const promised = [...text.matchAll(/Settings\s*(?:→|->)\s*([A-Za-z &]+?)(?:\s*(?:→|->)|[.,])/g)]
      .map(m => m[1].trim());
    return {
      length: text.length,
      pills, tabs, promised,
      badTab: promised.filter(p => !tabs.includes(p)),
      mentionsMetar: /METAR/i.test(text),
      mentionsUnitsTime: /Units\s*&\s*Time/i.test(text),
      // Overlay names the tutorial puts in bold, against the real list.
      scriptChars: body ? body.textContent.length - text.length : 0,
      boldOverlays: [...(body ? body.querySelectorAll('strong') : [])]
        .map(e => e.textContent.trim())
        .filter(t => /Particles|Forecasts|Stations|Outlook|Weather|Reports|Alerts/.test(t)),
    };
  });
  ok('the tutorial has real content', r.length > 5000, String(r.length));
  console.log(`       (${r.length} characters of prose, ${r.scriptChars} of embedded script skipped)`);
  ok('it no longer sends people to a METAR overlay that was removed',
     !r.mentionsMetar);
  ok('it names the Units tab as it is actually called now', !r.mentionsUnitsTime);
  ok('every Settings route it promises leads to a tab that exists',
     r.badTab.length === 0, 'promised: ' + r.promised.join(', ') + ' | tabs: ' + r.tabs.join(', '));
  const strays = r.boldOverlays.filter(t =>
    /Stations|Particles/.test(t) && !r.pills.some(p => p.includes(t) || t.includes(p)));
  ok('the overlays it names in bold are overlays the app has',
     strays.length === 0, strays.join(' | '));
}

console.log('\n8. the credits do not claim a use that was removed');
{
  const r = await page.evaluate(() => {
    if (typeof openCredits === 'function') openCredits();
    const el = document.getElementById('credits-modal-overlay')
            || document.querySelector('[id*="credits"]');
    const text = el ? el.textContent : '';
    return { has: text.length > 200, metar: /METAR/i.test(text) };
  });
  ok('the credits modal has content', r.has);
  ok('and it does not list METAR stations as something the app does',
     !r.metar);
}

console.log('\n9. nothing threw');
ok('no uncaught page errors', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
