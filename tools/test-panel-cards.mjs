#!/usr/bin/env node
/*
 * The reorganized Spaghetti Models panel, and the Google models actually
 * drawing.
 *
 *     node tools/test-panel-cards.mjs
 *
 * Two halves. The cards: four sections that used to be one long scroll of
 * headings and dividers are now fold-away cards whose state is remembered,
 * and every control keeps its id, so nothing that drove the old layout
 * breaks. The Google models: the Pi's new fetch produces a manifest whose
 * track sets are FNV3_members / GENC_members with storm|member|track keys
 * and no storm names, so this proves the page draws that shape, keeps two
 * simultaneous storms in one member apart, names lines from the a-deck
 * index, and hides the genesis dropdown that steers a picture no run
 * carries.
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

// ── the run the fixed pipeline would build ──────────────────────────────────
const RUN = '2026_08_26T00_00';
const T = (lead, lat, lon, wind, mslp) => ({ lat, lon, lead, wind, mslp });
const FNV3_TRACKS = {
  // Member 3 carries TWO storms at once, split by track id. Welding them
  // into one line is the defect the third key part exists to prevent.
  'unknown|3|0': [T(0, 21.9, -65.2, 63, 986), T(6, 22.4, -66.1, 71, 979),
                  T(12, 23.0, -67.0, 84, 968)],
  'unknown|3|1': [T(0, 12.0, -35.0, 30, 1006), T(6, 12.4, -36.2, 33, 1005)],
  'unknown|7|0': [T(0, 21.8, -65.0, 58, 990), T(6, 22.1, -66.0, 62, 985)],
};
const GENC_TRACKS = {
  'unknown|0|0': [T(0, 21.7, -65.1, 55, 992), T(6, 22.0, -66.2, 60, 987)],
};
const MAN = {
  run: RUN, built_at: '2026-08-26T02:40:00Z', genesis: {},
  tracks: {
    FNV3_members: { variant: 'FNV3', kind: 'members',
      label: 'Google FNV3 (50 members)', path: 'tracks_FNV3_members.json',
      storms: 1, members: 2, lines: 3 },
    GENC_members: { variant: 'GENC', kind: 'members',
      label: 'Google GenCast', path: 'tracks_GENC_members.json',
      storms: 1, members: 1, lines: 1 },
  },
};
let manServed = MAN;
const SPAG_INDEX = {
  updated: '2026-08-26T01:05:00Z', source: 'ATCF a-decks',
  storms: [{ id: 'al092026', atcf: 'AL092026', name: 'GABRIELLE',
             basin: 'al', path: 'al092026.json', cycle: '2026082600',
             tier: 'full', lat: 21.8, lon: -65.1, vmax: 65, mslp: 985,
             n_aids: 7, n_tracks: 7 }],
};

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const json = (route, obj) => route.fulfill({ contentType: 'application/json',
  body: JSON.stringify(obj), headers: { 'Access-Control-Allow-Origin': '*' } });

await page.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript',
      body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css',
      body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  if (url.includes('/cyclones/latest.json'))
    return json(route, { run: RUN, path: `${RUN}/manifest.json`,
                         updated: MAN.built_at });
  if (url.includes('/cyclones/') && url.includes('manifest.json'))
    return json(route, manServed);
  if (url.includes('tracks_FNV3_members.json'))
    return json(route, { variant: 'FNV3', kind: 'members', run: RUN,
                         tracks: FNV3_TRACKS });
  if (url.includes('tracks_GENC_members.json'))
    return json(route, { variant: 'GENC', kind: 'members', run: RUN,
                         tracks: GENC_TRACKS });
  if (url.includes('/spaghetti/latest.json')) return json(route, SPAG_INDEX);
  return route.abort();
});

await page.goto('file://' + join(ROOT, 'index.html'),
                { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4200);
await page.evaluate(() => { if (typeof closeTutorial === 'function') closeTutorial(); });
await page.evaluate(() => { _hdBase = 'https://example.invalid/wx'; });

console.log('\n1. the panel is four cards, not one long scroll');
{
  const s = await page.evaluate(() => ({
    ids: [...document.querySelectorAll('#spaghetti-models-panel .spanel-card')]
      .map(c => c.id),
    heads: [...document.querySelectorAll('#spaghetti-models-panel .spanel-head')]
      .map(h => h.textContent.trim().replace(/\s+/g, ' ')),
    bodies: document.querySelectorAll(
      '#spaghetti-models-panel .spanel-body').length,
  }));
  ok('four cards, in reading order: storms, guidance, cyclones, animation',
     s.ids.join(',') === 'spcard-storms,spcard-guidance,spcard-cyclones,spcard-anim',
     s.ids.join(','));
  ok('each has a clickable head and a body', s.bodies === 4);
  ok('the heads say what each card is',
     /Active Storms/.test(s.heads[0]) && /Model Guidance/.test(s.heads[1])
     && /AI Cyclones/.test(s.heads[2]) && /Track Animation/.test(s.heads[3]),
     s.heads.join(' | '));
  const inside = await page.evaluate(() => ({
    storms: !!document.querySelector('#spcard-storms #trop-storm-sel'),
    spag: !!document.querySelector('#spcard-guidance #spag-btn')
       && !!document.querySelector('#spcard-guidance #spag-groups'),
    cyc: !!document.querySelector('#spcard-cyclones #cyc-lab-btn')
       && !!document.querySelector('#spcard-cyclones #cyc-ens-centres-btn'),
    anim: !!document.querySelector('#spcard-anim #tanim-play'),
  }));
  ok('the storm picker lives in the storms card', inside.storms);
  ok('the guidance controls live in the guidance card', inside.spag);
  ok('DeepMind and the GEFS centres share the cyclones card', inside.cyc);
  ok('the transport lives in the animation card', inside.anim);
}

console.log('\n2. cards fold, and the fold is remembered');
{
  await page.evaluate(() => _spCardToggle('cyclones'));
  let s = await page.evaluate(() => ({
    closed: document.getElementById('spcard-cyclones')
      .classList.contains('closed'),
    bodyHidden: getComputedStyle(document.querySelector(
      '#spcard-cyclones .spanel-body')).display === 'none',
    saved: localStorage.getItem('gwcfc_spanel_closed'),
  }));
  ok('a click folds the card', s.closed && s.bodyHidden);
  ok('and the choice is written down', s.saved === '["cyclones"]', s.saved);
  await page.evaluate(() => {
    document.getElementById('spcard-cyclones').classList.remove('closed');
    _spCardRestore();
  });
  ok('restore reapplies it, so reopening the panel keeps the fold',
     await page.evaluate(() => document.getElementById('spcard-cyclones')
       .classList.contains('closed')));
  await page.evaluate(() => _spCardToggle('cyclones'));
  ok('and a second click opens it again',
     await page.evaluate(() => !document.getElementById('spcard-cyclones')
       .classList.contains('closed')));
}

console.log('\n3. the Google models draw from the fixed manifest');
{
  await page.evaluate(() => _cycEnable());
  await page.waitForTimeout(500);
  const s = await page.evaluate(() => ({
    on: _cycOn,
    keys: Object.keys(_cycGroups).filter(k => !k.startsWith('ens|')),
    labels: Object.entries(_cycGroups)
      .filter(([k]) => !k.startsWith('ens|')).map(([, g]) => g.label),
    options: [...document.getElementById('cyc-variant-sel').options]
      .map(o => o.textContent),
    variant: _cycVariant,
  }));
  ok('the layer is on with tracks drawn', s.on && s.keys.length === 3,
     s.keys.join(','));
  ok('member 3\'s two simultaneous storms are two separate lines',
     s.keys.some(k => k.includes('|3|0')) && s.keys.some(k => k.includes('|3|1')),
     s.keys.join(','));
  ok('the model picker offers both Google models by their real names',
     s.options.includes('Google FNV3 (50 members)')
     && s.options.includes('Google GenCast'), s.options.join(','));
  ok('FNV3 is the default', s.variant === 'FNV3', s.variant);
  ok('the nameless track beside GABRIELLE takes her name',
     s.labels.some(l => /^GABRIELLE M3$/.test(l)), s.labels.join(','));
  ok('the mid-Atlantic track matches no storm and stays a bare member',
     s.labels.some(l => /^M3$/.test(l)), s.labels.join(','));
}

console.log('\n4. switching to GenCast redraws from its file');
{
  await page.evaluate(() => _spagCycVariant('GENC'));
  await page.waitForTimeout(500);
  const s = await page.evaluate(() => ({
    keys: Object.keys(_cycGroups).filter(k => !k.startsWith('ens|')),
    variant: _cycVariant,
  }));
  ok('the variant moved', s.variant === 'GENC');
  ok('and exactly GenCast\'s one line is drawn',
     s.keys.length === 1 && s.keys[0].includes('GENC'), s.keys.join(','));
  await page.evaluate(() => _spagCycVariant('FNV3'));
  await page.waitForTimeout(400);
}

console.log('\n5. the genesis dropdown only exists when a run carries genesis');
{
  const hidden = await page.evaluate(() => getComputedStyle(
    document.getElementById('cyc-genesis-sel').closest('.sev-dd-wrap'))
    .display === 'none');
  ok('with no genesis in the run, the dropdown is gone', hidden);
  manServed = { ...MAN, genesis: { cumulative: {
    png: 'cumulative.png', bounds: [[0, -100], [40, -20]], unit: '%' } } };
  await page.evaluate(() => { _cycIndex = null; _cycAt = 0; });
  await page.evaluate(() => _spagCycSync());
  await page.waitForTimeout(400);
  const shown = await page.evaluate(() => getComputedStyle(
    document.getElementById('cyc-genesis-sel').closest('.sev-dd-wrap'))
    .display !== 'none');
  ok('and comes back the moment a run carries one', shown);
  manServed = MAN;
  await page.evaluate(() => { _cycIndex = null; _cycAt = 0; });
}

console.log('\n6. house rules');
{
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  ok('no em dash in the page', !html.includes(String.fromCharCode(0x2014)));
  ok('no leftover standalone section heads above the cards',
     !/<div id="spag-head">/.test(html) && !/<div id="tanim-head">/.test(html));
  ok('the update bar says the Google models work now',
     /Google AI cyclone models work now/.test(html));
  ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

await browser.close();
console.log(`\n${fail ? '' : 'all '}${pass} passed`
  + (fail ? `, ${fail} FAILED` : ''));
process.exit(fail ? 1 : 0);
