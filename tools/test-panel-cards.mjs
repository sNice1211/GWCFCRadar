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

console.log('\n1. both tropical panels are flat, and hold their own controls');
{
  // The cards are gone. Both panels were folding cards, and in both cases the
  // fold could hide a control from the thing it controls: the AI Cyclones
  // panel split the DeepMind tracks from the GEFS centres with a paragraph of
  // prose between them, and the Spaghetti panel could fold the play button
  // away from the lines it plays. They are laid out like Run Models now, so
  // what is worth checking here is that nothing was LOST in the flattening.
  // The layouts themselves are covered in depth by test-spag-playbar and
  // test-cyclone-playbar.
  const s = await page.evaluate(() => ({
    cards: document.querySelectorAll('.spanel-card').length,
    heads: document.querySelectorAll('.spanel-head').length,
    fold: typeof window._spCardToggle,
    // The Active Storms card went earlier, by request: it duplicated what the
    // NHC Outlook overlay already draws on the map.
    storms: !document.querySelector('#spcard-storms')
       && !document.getElementById('trop-storm-sel'),
    spagChips: !!document.querySelector('#spaghetti-models-panel #spag-groups'),
    spagBtn: !!document.querySelector('#spaghetti-models-panel #spag-btn'),
    spagPlay: !!document.querySelector('#spaghetti-models-panel #tanim-play'),
    spagBar: !!document.querySelector('#spaghetti-models-panel .sev-playbar-row'),
    cycTracks: !!document.querySelector('#ai-cyclones-panel #cyc-layer-row #cyc-lab-btn'),
    cycEns: !!document.querySelector('#ai-cyclones-panel #cyc-layer-row #cyc-ens-centres-btn'),
    cycMean: !!document.querySelector('#ai-cyclones-panel #cyc-layer-row #cyc-mean-btn'),
    cycBar: !!document.querySelector('#ai-cyclones-panel .sev-playbar-row'),
  }));
  ok('no cards are left anywhere', s.cards === 0 && s.heads === 0,
     s.cards + ' cards, ' + s.heads + ' heads');
  ok('and the fold machinery went with them', s.fold === 'undefined', s.fold);
  ok('the Active Storms card and its picker are still gone', s.storms);
  ok('the spaghetti panel kept its chips, its guidance switch and its clock',
     s.spagChips && s.spagBtn && s.spagPlay && s.spagBar,
     JSON.stringify(s));
  ok('the cyclones panel kept all three layer switches',
     s.cycTracks && s.cycEns && s.cycMean, JSON.stringify(s));
  ok('and both wear the same playbar', s.spagBar && s.cycBar);
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
  // Not the update bar: that string describes whatever shipped LAST. The
  // durable claim is that the variant table still carries the download
  // API's real slugs.
  ok('the variant table still names the real Google model slugs',
     /FNV3:\s+'Google FNV3/.test(html) && /GENC:\s+'Google GenCast'/.test(html));
  ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

await browser.close();
console.log(`\n${fail ? '' : 'all '}${pass} passed`
  + (fail ? `, ${fail} FAILED` : ''));
process.exit(fail ? 1 : 0);
