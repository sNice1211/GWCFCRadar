#!/usr/bin/env node
/*
 * The GWCFC product format, and all 162 templates built from it.
 *
 *     npm i playwright && node tools/test-product-templates.mjs
 *
 * The office wrote 162 template files: 18 hazards, each issuable as a Watch,
 * a Warning or an Emergency, each of those at a Base, Severe or Extreme tier.
 * The app does not carry 162 files. It carries the handful of things that
 * actually differ between them and assembles the rest, because every one of
 * them shares the same header, the same six-row HAZARDS block and the same
 * signature.
 *
 * That is only worth doing if it is EXACTLY the same format. So this builds
 * every one of the 162 in the real page and compares it byte for byte with
 * the file the office wrote, which is kept in tools/fixtures as the thing
 * being conformed to. A compression that drifts is not a compression, it is a
 * second format that looks like the first one until the day it does not.
 *
 * Then the reformatter, which is what the desk actually uses: somebody else's
 * pasted product read for what it says and written out as one of ours.
 */

import { readdirSync, existsSync, readFileSync } from 'fs';
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
const FIX = join(ROOT, 'tools', 'fixtures', 'GWCFC_Product_Templates');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  try {
    for (const d of readdirSync('/opt/pw-browsers')) {
      if (!d.startsWith('chromium-')) continue;
      const p = join('/opt/pw-browsers', d, 'chrome-linux', 'chrome');
      if (existsSync(p)) return p;
    }
  } catch { /* let Playwright try its own */ }
  return undefined;
}

const LEAFLET_STUB = `(() => {
  const chain = () => new Proxy(function(){}, {
    get: (t, k) => {
      if (k === 'getCenter')  return () => ({ lat: 35.3, lng: -97.3 });
      if (k === 'getZoom')    return () => 7;
      if (k === 'hasLayer')   return () => false;
      if (k === 'getPane')    return () => document.createElement('div');
      if (k === 'createPane') return () => document.createElement('div');
      if (k === 'getBounds')  return () => ({ getWest:()=>-100, getEast:()=>-95,
        getNorth:()=>38, getSouth:()=>33, contains:()=>true, pad(){return this;} });
      if (k === 'then') return undefined;
      return chain();
    },
    apply: () => chain(), construct: () => chain(),
  });
  Object.defineProperty(window, 'L',
    { value: chain(), writable: true, configurable: true });
})();`;

const browser = await chromium.launch({ executablePath: chromePath() });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.addInitScript(LEAFLET_STUB);
await page.route('**://**', (r) =>
  r.request().url().startsWith('file://') ? r.continue() : r.abort());
await page.goto('file://' + join(ROOT, 'index.html'),
                { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);

console.log('\n1. the format is in the page');
ok('no uncaught errors while starting', errors.length === 0, errors[0]);
const shape = await page.evaluate(() => ({
  hazards: Object.keys(GWCFC_TPL_HAZARDS).length,
  kinds: Object.keys(GWCFC_TPL_KINDS).length,
  tiers: Object.keys(GWCFC_TPL_TIERS).length,
  offices: GWCFC_TPL_OFFICES.length,
  products: gwcfcTemplateList().length,
  rows: GWCFC_TPL_HAZARD_ROWS.length,
}));
ok('18 hazards', shape.hazards === 18, shape.hazards);
ok('three kinds and three tiers',
   shape.kinds === 3 && shape.tiers === 3, JSON.stringify(shape));
ok('which is 162 products', shape.products === 162, shape.products);
ok('the eight field offices are there', shape.offices === 8, shape.offices);
ok('and the six standing hazard rows', shape.rows === 6, shape.rows);

console.log('\n2. every one of the 162 is byte for byte the office\'s own file');
{
  const want = [];
  const root = join(FIX, 'products');
  for (const d of readdirSync(root).sort()) {
    for (const f of readdirSync(join(root, d)).sort()) {
      const base = f.replace('.txt', '');
      want.push({
        haz: d,
        kind: base.endsWith('Watch') ? 'watch'
            : base.endsWith('Warning') ? 'warning' : 'emergency',
        tier: /_Severe_/.test(base) ? 'severe'
            : /_Extreme_/.test(base) ? 'extreme' : 'base',
        file: `${d}/${f}`,
        text: readFileSync(join(root, d, f), 'utf8'),
      });
    }
  }
  ok('the fixture has all 162 files', want.length === 162, want.length);

  const got = await page.evaluate((list) => list.map(x =>
    gwcfcBuildProduct(x.haz, x.kind, x.tier, {})), want);

  const bad = [];
  want.forEach((w, i) => { if (got[i] !== w.text) bad.push(w.file); });
  ok('all 162 match exactly', bad.length === 0,
     bad.length + ' differ, first: ' + (bad[0] || ''));
  if (bad.length) {
    const w = want.find(x => x.file === bad[0]);
    const g = got[want.indexOf(w)].split('\n'), W = w.text.split('\n');
    for (let i = 0; i < Math.max(g.length, W.length); i++) {
      if (g[i] !== W[i]) {
        console.log('       line ' + (i + 1) + '\n         want '
          + JSON.stringify(W[i]) + '\n         got  ' + JSON.stringify(g[i]));
        break;
      }
    }
  }
}

console.log('\n3. the blanks fill in, and the office fills BOTH its slots');
{
  const r = await page.evaluate(() => {
    const t = gwcfcBuildProduct('hurricane', 'warning', 'extreme', {
      event: 'MILTON', advisory: '#14', office: gwcfcOfficeLine('TFO'),
      officeCode: 'TFO', issued: '0500 PM EDT WED OCT 09 2026',
      discussion: 'Milton is nearing landfall.',
      'data.CATEGORY': '4', 'data.MOVEMENT': 'ENE at 16 mph',
      areas: 'Hillsborough and Pinellas', valid: 'Now until landfall',
      'haz.WIND': 'EXTREME', notes: 'Do not go outside.',
      forecaster: 'Ralph',
    });
    return { t, line1: t.split('\n')[0] };
  });
  ok('the product name carries the tier prefix',
     r.line1.startsWith('EXTREME HURRICANE WARNING'), r.line1);
  ok('and the event and advisory number',
     r.line1.includes('MILTON') && r.line1.includes('#14'), r.line1);
  ok('the office appears in the header',
     /Issued by TFO .* Tampa FL/.test(r.t), r.t.split('\n')[2]);
  ok('and again in the signature, saying the same thing',
     /\nOffice: TFO\n/.test(r.t));
  ok('a filled DATA row shows the value', /CATEGORY: 4\n/.test(r.t));
  ok('and an unfilled one still shows what it wants',
     /PEAK GUST: \(value or N\/A\)\n/.test(r.t));
  ok('a filled hazard row shows the level', /WIND: EXTREME\n/.test(r.t));
  ok('the notes are there', /Do not go outside\./.test(r.t));
  ok('and it still ends with the signature block',
     r.t.trimEnd().endsWith('&&'), JSON.stringify(r.t.slice(-40)));
}

console.log('\n4. an EXTREME watch still says monitor, because a watch is a watch');
{
  const r = await page.evaluate(() => ({
    watch: gwcfcBuildProduct('flood', 'watch', 'extreme', {}),
    warn: gwcfcBuildProduct('flood', 'warning', 'base', {}),
    emer: gwcfcBuildProduct('flood', 'emergency', 'base', {}),
  }));
  ok('the extreme watch is tiered EXTREME',
     /SEVERITY TIER: EXTREME/.test(r.watch));
  ok('but its call to action is the watch one',
     /MONITOR LATER STATEMENTS/.test(r.watch));
  ok('a warning says take action now',
     /TAKE PROTECTIVE ACTION NOW/.test(r.warn));
  ok('and an emergency says act immediately',
     /ACT IMMEDIATELY/.test(r.emer));
}

console.log('\n5. pasted text comes back as one of ours');
{
  const r = await page.evaluate(() => {
    const paste = [
      '* WHAT...60 mph wind gusts and quarter size hail',
      '* WHERE...Cleveland County',
      '* WHEN...Until 815 PM CDT',
      '* IMPACTS...Minor damage to trees and power lines',
      '* SOURCE...Radar indicated',
      '',
      'HAIL...1.00 IN',
      'WIND...60 MPH',
      'SOME UNKNOWN TAG...keep me',
    ].join('\n');
    return { out: gwcfcReformat(paste, { haz: 'thunderstorm' }),
             empty: gwcfcReformat('   \n  \n'), sim: AD_SIM_LINE };
  });
  ok('it is a GWCFC product now, not a bullet list',
     /THUNDERSTORM WARNING/.test(r.out) && !/^\* WHAT/m.test(r.out));
  ok('the WHAT and IMPACTS become the discussion',
     /60 mph wind gusts and quarter size hail Minor damage/.test(r.out));
  ok('WHERE becomes the areas affected',
     /AREAS AFFECTED: Cleveland County/.test(r.out));
  ok('WHEN becomes the valid time',
     /VALID: Until 815 PM CDT/.test(r.out));
  ok('the hail tag lands in MAX HAIL SIZE',
     /MAX HAIL SIZE: 1\.00 IN/.test(r.out));
  ok('and the wind tag in MAX WIND GUST',
     /MAX WIND GUST: 60 MPH/.test(r.out));
  ok('SOURCE goes to the forecaster notes',
     /Source: Radar indicated/.test(r.out));
  // Nothing is thrown away. A tag this format has no row for would otherwise
  // vanish, and a forecaster pasting a product is entitled to all of it back.
  ok('a tag with nowhere to go is kept rather than dropped',
     /SOME UNKNOWN TAG: keep me/.test(r.out), r.out.slice(-400));
  // Top and bottom, and compared against the banner itself rather than a
  // prefix of it: the line goes on to say NOT ISSUED BY THE NATIONAL WEATHER
  // SERVICE, and matching only the first three words tests almost nothing.
  ok('the desk still marks its output simulated, top and bottom',
     r.out.startsWith(r.sim) && r.out.trimEnd().endsWith(r.sim),
     JSON.stringify(r.out.slice(-70)));
  ok('and empty input reformats to nothing rather than a blank product',
     r.empty === '', JSON.stringify(r.empty).slice(0, 60));
}

console.log('\n6. the hazard is read from the words, and named products win');
{
  const cases = [
    ['Severe Thunderstorm Warning with quarter size hail', 'thunderstorm'],
    ['HAILSTORM WARNING', 'hailstorm'],
    ['golf ball size hail', 'hailstorm'],
    ['Winter Storm Warning', 'winter-storm'],
    ['Flash Flood Warning', 'flood'],
    ['Storm Surge Watch', 'surge'],
    ['dense fog advisory', 'fog'],
    ['nothing recognisable', 'thunderstorm'],
  ];
  const got = await page.evaluate((cs) =>
    cs.map(([t]) => gwcfcGuessHazard(t)), cases);
  cases.forEach(([t, want], i) => {
    ok(`${JSON.stringify(t.slice(0, 42))} reads as ${want}`,
       got[i] === want, got[i]);
  });
}

console.log('\n7. hail is gone from the desk, because Hailstorm replaced it');
{
  const r = await page.evaluate(() => ({
    hazardKeys: Object.keys(AD_HAZARDS),
    inProducts: AD_PRODUCTS.filter(p => (p.haz || []).indexOf('hail') >= 0)
                           .map(p => p.id),
    // Every hazard a product still names has to exist, or the composer
    // renders a control for nothing.
    dangling: AD_PRODUCTS.flatMap(p => (p.haz || []))
      .filter(h => !AD_HAZARDS[h]),
    hailstorm: !!GWCFC_TPL_HAZARDS.hailstorm,
    hailRows: (GWCFC_TPL_HAZARDS.hailstorm || {}).data || [],
  }));
  ok('there is no hail hazard left',
     r.hazardKeys.indexOf('hail') === -1, r.hazardKeys.join(','));
  ok('and no product still asks for one',
     r.inProducts.length === 0, r.inProducts.join(','));
  ok('nothing was left pointing at a hazard that no longer exists',
     r.dangling.length === 0, r.dangling.join(','));
  ok('Hailstorm is a product family in its place', r.hailstorm);
  ok('with far more than the one number the slider gave',
     r.hailRows.length >= 8 && r.hailRows.indexOf('MAX HAIL SIZE') >= 0,
     r.hailRows.join(', '));
}

console.log('\n8. the picker offers all of them, and loading one fills the box');
{
  const r = await page.evaluate(() => {
    _adOpen();
    const sel = (id) => document.getElementById(id);
    const counts = {
      haz: sel('ad-tpl-haz') ? sel('ad-tpl-haz').options.length : 0,
      kind: sel('ad-tpl-kind') ? sel('ad-tpl-kind').options.length : 0,
      tier: sel('ad-tpl-tier') ? sel('ad-tpl-tier').options.length : 0,
      office: sel('ad-tpl-office') ? sel('ad-tpl-office').options.length : 0,
    };
    sel('ad-tpl-haz').value = 'tsunami';
    sel('ad-tpl-kind').value = 'emergency';
    sel('ad-tpl-tier').value = 'extreme';
    sel('ad-tpl-office').value = 'MIFO';
    _adLoadTemplate();
    return { counts, body: _adDraft.body || '',
             box: (sel('ad-body') || {}).value || '' };
  });
  ok('every hazard is on offer', r.counts.haz === 18, r.counts.haz);
  ok('with the three kinds and three tiers',
     r.counts.kind === 3 && r.counts.tier === 3, JSON.stringify(r.counts));
  ok('and the eight offices plus a no-office choice',
     r.counts.office === 9, r.counts.office);
  ok('loading one writes the product into the draft',
     /EXTREME TSUNAMI EMERGENCY/.test(r.body), r.body.split('\n')[2] || '');
  ok('with the chosen office in it', /Issued by MIFO/.test(r.body));
  ok('and it lands in the text box the forecaster edits',
     r.box === r.body && r.box.length > 400, r.box.length);
}

console.log('\n9. both copies of the desk carry the same format');
{
  const app = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const portal = readFileSync(join(ROOT, 'forecasting-portal.html'), 'utf8');
  for (const [name, src] of [['the radar', app], ['the portal', portal]]) {
    ok(`${name} has the template table`, /GWCFC_TPL_HAZARDS/.test(src));
    ok(`${name} builds products from it`, /function gwcfcBuildProduct/.test(src));
    ok(`${name} reformats into it`, /return gwcfcReformat\(raw, opts\)/.test(src));
    ok(`${name} offers the picker`, /_adLoadTemplate/.test(src));
    ok(`${name} has no hail hazard`, !/^  hail: \{$/m.test(src));
  }
}

console.log('\n10. nothing threw along the way');
ok('no uncaught errors at all', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
