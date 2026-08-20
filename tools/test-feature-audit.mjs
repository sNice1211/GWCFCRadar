#!/usr/bin/env node
/*
 * A sweep across every overlay and every top-level tool, offline, watching
 * for two things the existing per-feature suites don't check for as a
 * matter of course:
 *
 *   1. An uncaught error anywhere while a feature turns on, works, or turns
 *      off - most overlays here (spc-outlook, wpc-outlook, tornado-tracks,
 *      wildfires, traffic-cameras, wfo-offices, ambient-weather, storm-
 *      centers, and a dozen more) have never had a single line of test
 *      coverage before this file.
 *
 *   2. The exact class of bug NWR's stations hit: a <canvas> pane sitting
 *      above a marker pane silently eats every click meant for whatever is
 *      underneath it, map-wide, whether or not anything is actually drawn
 *      at that pixel. That was found by hand for one overlay (alerts).
 *      This checks it for all of them, mechanically, every time.
 *
 *     node tools/test-feature-audit.mjs
 *
 * Entirely offline: every request except Leaflet's own files is aborted, so
 * this exercises the UI code paths and their failure handling rather than
 * live data (that is what the network-backed suites, test-pi-l3.mjs and
 * test-nwr.mjs, are for).
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
const errorsByPhase = {};
let phase = 'boot';
page.on('pageerror', e => {
  (errorsByPhase[phase] = errorsByPhase[phase] || []).push(e.message);
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
  return route.abort();
});
await page.goto('file://' + join(ROOT, 'index.html'),
                { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);

console.log('\n1. every overlay pill: turns on, does not throw, does not');
console.log('   block clicks meant for markers underneath it');
{
  const ids = await page.evaluate(() =>
    [...document.querySelectorAll('.ov-pill[data-ovid]')]
      .map(e => e.dataset.ovid));
  ok('the overlay list itself is not empty', ids.length > 0, String(ids.length));

  // _ovInjectInfoButtons only adds the (i) button when OV_DESCRIPTIONS has
  // an entry for that pill's id - a pill silently missing one (as rotation
  // and hail both did) looks identical to every other pill except for the
  // one thing that would have told a person what it draws.
  const missingInfo = await page.evaluate(() =>
    [...document.querySelectorAll('.ov-pill[data-ovid]')]
      .filter(p => !p.querySelector('.ov-info-btn'))
      .map(p => p.dataset.ovid));
  ok('every overlay pill carries an info button', missingInfo.length === 0,
     missingInfo.join(', '));

  // The one check that generalizes the alerts fix: after every overlay has
  // had a turn being switched on, does any <canvas> pane in the whole
  // stack sit at or above the z-index of any marker pane? A canvas swallows
  // every click across its full rectangle once anything has ever been
  // drawn on it, whatever Leaflet's own internal hit-testing decides
  // afterward - so this is checked once at the end, with everything that
  // ever got turned on left in whatever state it settles into, which is
  // the worst case a real user could actually reach (several overlays on
  // at once, the ordinary way people use this).
  for (const id of ids) {
    phase = 'overlay:' + id;
    try {
      await page.evaluate(i => toggleOverlayPill(i), id);
    } catch (e) {
      (errorsByPhase[phase] = errorsByPhase[phase] || []).push('threw: ' + e.message);
    }
    await page.waitForTimeout(250);
  }
  const thrown = Object.entries(errorsByPhase)
    .filter(([k]) => k.startsWith('overlay:'));
  ok('no overlay threw while turning on', thrown.length === 0,
     thrown.map(([k, v]) => `${k}: ${v[0]}`).join(' | '));

  const zAudit = await page.evaluate(() => {
    const panes = [...document.querySelectorAll('.leaflet-pane')];
    const canvases = panes.filter(p => p.querySelector('canvas'))
      .map(p => ({ name: p.className, z: parseInt(getComputedStyle(p).zIndex) || 0 }));
    const markerPanes = panes.filter(p =>
      /-m-pane$|marker-?pane/i.test(p.className) && p.children.length)
      .map(p => ({ name: p.className, z: parseInt(getComputedStyle(p).zIndex) || 0 }));
    const violations = [];
    for (const c of canvases) for (const m of markerPanes) {
      if (c.z >= m.z) violations.push(`${c.name}(z=${c.z}) >= ${m.name}(z=${m.z})`);
    }
    return { canvases: canvases.length, markerPanes: markerPanes.length, violations };
  });
  ok('every <canvas> pane sits below every occupied marker pane',
     zAudit.violations.length === 0,
     `checked ${zAudit.canvases} canvas pane(s) against ${zAudit.markerPanes} marker pane(s): `
     + zAudit.violations.join(' | '));

  // And back off, one at a time, the same way a real person would leave
  // the map before closing the tab.
  for (const id of ids) {
    phase = 'overlay-off:' + id;
    try {
      await page.evaluate(i => {
        if (activeLayers[i] || document.getElementById('op-' + i)?.classList.contains('active'))
          toggleOverlayPill(i);
      }, id);
    } catch (e) {
      (errorsByPhase[phase] = errorsByPhase[phase] || []).push('threw: ' + e.message);
    }
  }
  await page.waitForTimeout(300);
  const thrownOff = Object.entries(errorsByPhase)
    .filter(([k]) => k.startsWith('overlay-off:'));
  ok('no overlay threw while turning back off', thrownOff.length === 0,
     thrownOff.map(([k, v]) => `${k}: ${v[0]}`).join(' | '));
}

console.log('\n2. the main tabs and left-menu bubbles open without throwing');
{
  phase = 'tabs';
  const rows = ['regular', 'models'];
  for (const r of rows) {
    try { await page.evaluate(x => switchTab(x), r); }
    catch (e) { (errorsByPhase.tabs = errorsByPhase.tabs || []).push(`${r}: ${e.message}`); }
    await page.waitForTimeout(200);
  }
  ok('switching between the top tabs does not throw',
     !errorsByPhase.tabs, (errorsByPhase.tabs || []).join(' | '));

  phase = 'sidebar';
  const bubbleIds = await page.evaluate(() =>
    typeof TAB_BUBBLES !== 'undefined' ? TAB_BUBBLES.regular.map(b => b.id) : []);
  ok('the main sidebar bubble list is not empty', bubbleIds.length > 0, String(bubbleIds.length));
}

console.log('\n3. Settings panel and Tutorial open and close cleanly');
{
  phase = 'settings';
  await page.evaluate(() => lqmOpenSettings());
  await page.waitForTimeout(300);
  const settingsOpen = await page.evaluate(() =>
    !!document.getElementById('lqm-settings-overlay')?.classList.contains('lqm-panel-open'));
  ok('the Settings panel opens', settingsOpen, String(settingsOpen));
  await page.evaluate(() => lqmCloseSettings());

  phase = 'tutorial';
  await page.evaluate(() => openTutorial());
  await page.waitForTimeout(300);
  const tutOpen = await page.evaluate(() =>
    document.getElementById('tutorial-modal-overlay').classList.contains('open'));
  await page.evaluate(() => closeTutorial());
  await page.waitForTimeout(200);
  const tutClosed = await page.evaluate(() =>
    !document.getElementById('tutorial-modal-overlay').classList.contains('open'));
  ok('the Tutorial opens and closes cleanly',
     tutOpen && tutClosed, JSON.stringify({ tutOpen, tutClosed }));
  ok('nothing threw opening Settings or the Tutorial',
     !errorsByPhase.settings && !errorsByPhase.tutorial,
     [...(errorsByPhase.settings || []), ...(errorsByPhase.tutorial || [])].join(' | '));
}

console.log('\n4. the drawing tools arm and disarm without throwing');
{
  // Each is a toggle: calling it again (or deactivateTool) is how it turns
  // itself back off, the same as a person pressing the same button twice
  // or Escape.
  const tools = [
    { name: 'distance', arm: 'startDistanceTool()', disarm: 'startDistanceTool()' },
    { name: 'poly filter', arm: '_polyToggleFilter()', disarm: 'deactivateTool()' },
    { name: 'storm cone', arm: 'toggleStormConeTool()', disarm: 'toggleStormConeTool()' },
  ];
  for (const t of tools) {
    phase = 'tool:' + t.name;
    try {
      await page.evaluate(([a, d]) => { window.eval(a); window.eval(d); }, [t.arm, t.disarm]);
      ok(`${t.name} tool arms and disarms without throwing`, true);
    } catch (e) {
      ok(`${t.name} tool arms and disarms without throwing`, false, e.message);
    }
    await page.waitForTimeout(150);
  }
}

console.log('\n5. updateLoadStatus: terminal messages surface, in-progress ones do not');
{
  // The boot screen's own #load-status is long gone by now (page loaded
  // 3.5s+ ago), so every call here exercises the post-boot fallback pill.
  phase = 'load-status';
  const r = await page.evaluate(() => {
    updateLoadStatus('');   // start from a known-clear state, whatever boot left behind
    updateLoadStatus('Radar 7/12…');
    const duringProgress = document.getElementById('load-status')?.textContent || '';
    updateLoadStatus('No active Mesoscale Discussions.');
    const terminal = document.getElementById('load-status')?.textContent || '';
    updateLoadStatus('');
    const cleared = document.getElementById('load-status')?.style.display;
    return { duringProgress, terminal, cleared };
  });
  ok('an in-progress "…" message never reaches the pill',
     r.duringProgress === '', JSON.stringify(r));
  ok('a terminal message (no trailing …) does reach it',
     r.terminal === 'No active Mesoscale Discussions.', JSON.stringify(r));
  ok('clearing with an empty string hides it', r.cleared === 'none', JSON.stringify(r));
}

console.log('\n6. summary');
{
  const allErrors = Object.entries(errorsByPhase);
  ok('nothing threw anywhere in the whole sweep', allErrors.length === 0,
     allErrors.map(([k, v]) => `[${k}] ${v.join('; ')}`).join('  ///  '));
}

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
