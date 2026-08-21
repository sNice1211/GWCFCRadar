#!/usr/bin/env node
/*
 * The cyclone ensemble, read as a distribution.
 *
 *     node tools/test-cyclone-ensemble.mjs
 *
 * The spaghetti plot answers "where might it go" and nothing else. A large
 * ensemble is asked three other questions - how strong does it get, when does
 * it become a storm at all, and how much do the members disagree - and all
 * three are questions about a distribution, which five hundred overlapping
 * lines cannot show.
 *
 * Every number here is worked out in the browser from the member tracks
 * already on the map. That makes it cheap and it makes it testable: a
 * percentile, a probability and a median are all things a fixture can be
 * built to have a known answer for, so these check against answers worked out
 * by hand rather than against whatever the code returns.
 *
 * The failure that matters most is a quiet one. A wrong percentile still
 * draws a smooth, convincing fan; a probability computed over the wrong
 * denominator still prints a plausible percentage. Nothing about the picture
 * would look wrong.
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
await page.waitForTimeout(4200);
await page.evaluate(() => { if (typeof closeTutorial === 'function') closeTutorial(); });

// Ten members whose peaks are 25, 40, 55 ... 160 kt, one each. Spread that
// way on purpose, so every threshold has a different answer and each one can
// be counted on fingers: nine of the ten reach 34 kt, seven reach 64, five
// reach 96, two reach 137. The median peak is 92.5.
const seed = () => page.evaluate(() => {
  _cycGroups = {};
  const LEADS = [0, 12, 24, 36, 48, 60, 72];
  for (let i = 0; i < 10; i++) {
    const peak = 25 + i * 15;
    const pts = LEADS.map((lead, k) => ({
      lat: 20 + k * 0.5,
      lon: -60 - k * 0.8,
      lead,
      // Ramps linearly to its peak at +48 and eases off after, so the lead of
      // the peak is the same for every member and the heatmap has one column.
      wind: k <= 4 ? Math.round(20 + (peak - 20) * (k / 4))
                   : Math.round(peak - (k - 4) * 5),
    }));
    _cycGroups[`file|AL07|${i}`] = { pts, label: 'AL07 M' + i };
  }
  // A mean file for the same storm, which must NOT be counted as a member.
  _cycGroups['file_ensemble_mean|AL07|mean'] = {
    pts: LEADS.map((lead, k) => ({ lat: 20 + k * 0.5, lon: -60 - k * 0.8,
                                   lead, wind: 60 })),
    label: 'AL07 MEAN',
  };
  // A second storm, so storm separation has something to get wrong.
  for (let i = 0; i < 4; i++) {
    _cycGroups[`file|EP03|${i}`] = {
      pts: LEADS.map((lead, k) => ({ lat: 15 + k * 0.3, lon: -110 - k * 0.6,
                                     lead, wind: 25 + i })),
      label: 'EP03 M' + i,
    };
  }
});

console.log('\n1. members are gathered per storm, and the mean is not one of them');
{
  await seed();
  const r = await page.evaluate(() => ({
    al: _cycMembersOf('AL07').length,
    ep: _cycMembersOf('EP03').length,
    meanIncluded: _cycMembersOf('AL07').some(m => m.member === 'mean'),
    storms: _cycStorms().map(s => s.storm),
  }));
  ok('the ten members of the first storm are found', r.al === 10, String(r.al));
  ok('the ensemble mean is excluded, because it is a line and not an outcome',
     r.meanIncluded === false);
  ok('the other storm is kept separate', r.ep === 4, String(r.ep));
  ok('both storms are listed, busiest first',
     r.storms[0] === 'AL07' && r.storms.includes('EP03'), JSON.stringify(r.storms));
}

console.log('\n2. the intensity spread is the spread of the members');
{
  const r = await page.evaluate(() => {
    const e = _cycEnsemble('AL07');
    const at48 = e.fan.find(f => f.lead === 48);
    return {
      members: e.members,
      n48: at48.n, min48: at48.min, max48: at48.max,
      p50: at48.p50, p25: at48.p25, p75: at48.p75, mean: at48.mean,
      leadsAscend: e.fan.every((f, i) => i === 0 || f.lead > e.fan[i - 1].lead),
      ordered: e.fan.every(f =>
        f.min <= f.p10 && f.p10 <= f.p25 && f.p25 <= f.p50
        && f.p50 <= f.p75 && f.p75 <= f.p90 && f.p90 <= f.max),
    };
  });
  ok('the ensemble knows how many members it has', r.members === 10, String(r.members));
  ok('every member is in the sample at the peak hour', r.n48 === 10, String(r.n48));
  // At +48 every member is at its own peak: 25 through 160.
  ok('the weakest member at +48 is the 25 kt one', r.min48 === 25, String(r.min48));
  ok('and the strongest is the 160 kt one', r.max48 === 160, String(r.max48));
  ok('the median of 25..160 is 92.5', Math.abs(r.p50 - 92.5) < 0.01, String(r.p50));
  ok('the mean of 25..160 is 92.5 as well', Math.abs(r.mean - 92.5) < 0.01, String(r.mean));
  ok('the quartiles sit either side of it symmetrically',
     Math.abs((r.p75 - r.p50) - (r.p50 - r.p25)) < 0.01,
     JSON.stringify([r.p25, r.p50, r.p75]));
  ok('the fan runs forward in time', r.leadsAscend);
  ok('and the bands nest, min inside p10 inside p25 inside the median',
     r.ordered);
}

console.log('\n3. peak strength and its timing are read per member');
{
  const r = await page.evaluate(() => {
    const e = _cycEnsemble('AL07');
    return {
      n: e.lmi.length,
      kts: e.lmi.map(x => x.kt).sort((a, b) => a - b),
      leads: [...new Set(e.lmi.map(x => x.lead))],
      p10: e.lmiP10, p50: e.lmiP50, p90: e.lmiP90,
      peakWind: e.peak && e.peak.wind, peakLead: e.peak && e.peak.lead,
    };
  });
  ok('every member contributes a peak', r.n === 10, String(r.n));
  ok('and they are the ten peaks the fixture was built with',
     JSON.stringify(r.kts) === JSON.stringify([25, 40, 55, 70, 85, 100, 115, 130, 145, 160]),
     JSON.stringify(r.kts));
  ok('every member peaks at the same hour, as drawn',
     r.leads.length === 1 && r.leads[0] === 48, JSON.stringify(r.leads));
  ok('the median peak is 92.5 kt', Math.abs(r.p50 - 92.5) < 0.01, String(r.p50));
  ok('the tenth and ninetieth percentiles bracket it',
     r.p10 < r.p50 && r.p50 < r.p90, JSON.stringify([r.p10, r.p50, r.p90]));
  ok('the mean track peaks at the mean of the peaks',
     Math.abs(r.peakWind - 92.5) < 0.5, String(r.peakWind));
  ok('at the hour the members peak', r.peakLead === 48, String(r.peakLead));
}

console.log('\n4. the probabilities are counted over the members, not guessed');
{
  const r = await page.evaluate(() => {
    const e = _cycEnsemble('AL07');
    return { pTS: e.pTS, pC1: e.pC1, pC3: e.pC3, pC5: e.pC5,
             genFrac: e.genesisFrac, genMedian: e.genesisMedian,
             genN: e.genesis.length };
  });
  // Peaks 25..160. Nine of ten reach 34 kt (the 25 does not); seven reach 64;
  // five reach 96; two reach 137. Every one can be counted on fingers.
  ok('nine of the ten reach tropical storm strength',
     Math.abs(r.pTS - 0.9) < 0.001, r.pTS.toFixed(3));
  ok('seven of the ten reach hurricane strength',
     Math.abs(r.pC1 - 0.7) < 0.001, r.pC1.toFixed(3));
  ok('five reach major hurricane strength',
     Math.abs(r.pC3 - 0.5) < 0.001, r.pC3.toFixed(3));
  ok('two reach category five', Math.abs(r.pC5 - 0.2) < 0.001, r.pC5.toFixed(3));
  ok('the same nine are the ones that have a genesis time',
     r.genN === 9 && Math.abs(r.genFrac - 0.9) < 0.001,
     JSON.stringify([r.genN, r.genFrac]));
  ok('and a median genesis hour is reported',
     r.genMedian != null && r.genMedian >= 0 && r.genMedian <= 72,
     String(r.genMedian));
}

console.log('\n5. a member that stops early is dropped, not held at its last value');
{
  const r = await page.evaluate(() => {
    // One member ends at +24. Carrying it forward at its final wind would
    // drag the low end of the fan down for the rest of the forecast, which
    // is a spread that is not in the ensemble.
    const short = { ..._cycGroups['file|AL07|0'] };
    short.pts = short.pts.filter(p => p.lead <= 24);
    _cycGroups['file|AL07|0'] = short;
    const e = _cycEnsemble('AL07');
    const at24 = e.fan.find(f => f.lead === 24);
    const at48 = e.fan.find(f => f.lead === 48);
    return { n24: at24.n, n48: at48.n, min48: at48.min };
  });
  ok('it counts while it lasts', r.n24 === 10, String(r.n24));
  ok('and is gone from the sample after it ends', r.n48 === 9, String(r.n48));
  ok('so the weakest member after that is the next one up, 40 kt',
     r.min48 === 40, String(r.min48));
}

console.log('\n6. too few members is said, not drawn');
{
  const r = await page.evaluate(() => {
    _cycGroups = { 'file|SOLO|mean': { pts: [{ lat: 20, lon: -60, lead: 0, wind: 50 },
                                              { lat: 21, lon: -61, lead: 12, wind: 60 }] } };
    return { solo: _cycEnsemble('SOLO'), missing: _cycEnsemble('NOPE') };
  });
  ok('one lone mean track is not a distribution', r.solo === null);
  ok('and a storm that is not there returns nothing rather than throwing',
     r.missing === null);
}

console.log('\n7. the panel draws all four charts and the summary');
{
  await seed();
  const r = await page.evaluate(() => {
    _cycEnsOpen('AL07');
    const el = document.getElementById('cyc-ens-panel');
    const b = el.getBoundingClientRect();
    const canv = ['cyc-ens-fan', 'cyc-ens-gen', 'cyc-ens-lmi', 'cyc-ens-heat']
      .map(id => {
        const c = document.getElementById(id);
        return { id, w: c.width, h: c.height };
      });
    return {
      open: el.classList.contains('open'),
      full: b.width >= innerWidth - 2 && b.height >= innerHeight - 2,
      canv,
      stats: [...el.querySelectorAll('.cyc-ens-stat')].map(x => x.textContent),
      picks: [...el.querySelectorAll('.cyc-ens-pick option')].map(o => o.value),
      sub: el.querySelector('.cyc-ens-sub').textContent,
      note: el.querySelector('.cyc-ens-note').textContent,
    };
  });
  ok('the panel opens', r.open);
  ok('and fills the screen, because four charts do not fit in a corner',
     r.full, JSON.stringify(r));
  ok('all four charts are really sized and drawn',
     r.canv.every(c => c.w > 100 && c.h > 100), JSON.stringify(r.canv));
  ok('the summary carries the numbers a discussion quotes',
     r.stats.length >= 9, String(r.stats.length));
  ok('including the median peak, which rounds to 93 kt',
     r.stats.some(t => /median/i.test(t) && /9[23]/.test(t)), JSON.stringify(r.stats));
  ok('and the major hurricane probability, which is 50 per cent',
     r.stats.some(t => /major/i.test(t) && /50%/.test(t)), JSON.stringify(r.stats));
  ok('the storm picker lists both storms', r.picks.length === 2, JSON.stringify(r.picks));
  ok('and the header names the one being shown', /AL07/.test(r.sub), r.sub);
  ok('the note says where the numbers came from', /distribution/.test(r.note));
}

console.log('\n8. switching storms redraws for the other one');
{
  const r = await page.evaluate(() => {
    _cycEnsOpen('EP03');
    const el = document.getElementById('cyc-ens-panel');
    return { sub: el.querySelector('.cyc-ens-sub').textContent,
             stats: el.querySelector('.cyc-ens-summary').textContent,
             storm: _cycEnsStorm };
  });
  ok('the header follows', /EP03/.test(r.sub), r.sub);
  ok('the state follows', r.storm === 'EP03', String(r.storm));
  ok('and the numbers are that storm\'s, which never reaches hurricane strength',
     /0%/.test(r.stats), r.stats.slice(0, 160));
}

console.log('\n9. the mean track goes on the map, coloured by strength');
{
  const r = await page.evaluate(() => {
    _cycEnsOpen('AL07');
    const e = _cycDrawMeanTrack('AL07');
    const colors = _cycMeanLayers
      .filter(l => l.options && l.options.color && !l.options.fillColor)
      .map(l => l.options.color);
    return {
      built: !!e,
      layers: _cycMeanLayers.length,
      distinct: new Set(colors).size,
      star: _cycMeanLayers.some(l => l.options && l.options.icon
              && /9733|★/.test(l.options.icon.options.html || '')),
      onMap: _cycMeanLayers.every(l => map.hasLayer(l)),
    };
  });
  ok('the mean track is built', r.built);
  ok('it is drawn in pieces so it can change colour along its length',
     r.layers > 5, String(r.layers));
  ok('and it really does change colour, rather than being one flat line',
     r.distinct > 1, String(r.distinct));
  ok('the peak is marked with a star', r.star);
  ok('everything is actually on the map', r.onMap);

  const off = await page.evaluate(() => {
    _cycClearMeanTrack();
    return { layers: _cycMeanLayers.length };
  });
  ok('and it all comes off again together', off.layers === 0, String(off.layers));
}

console.log('\n10. categories are the Saffir-Simpson ones, in the right order');
{
  const r = await page.evaluate(() => ({
    td: _cycCat(20).label, ts: _cycCat(40).label, c1: _cycCat(70).label,
    c2: _cycCat(90).label, c3: _cycCat(100).label, c4: _cycCat(120).label,
    c5: _cycCat(150).label,
    boundary: [_cycCat(63).label, _cycCat(64).label],
    nullSafe: _cycCat(null).label,
    distinct: new Set(CYC_CATS.map(c => c.color)).size,
    total: CYC_CATS.length,
  }));
  ok('20 kt is a depression and 40 kt a storm', r.td === 'TD' && r.ts === 'TS',
     JSON.stringify([r.td, r.ts]));
  ok('the hurricane categories land where they should',
     r.c1 === 'C1' && r.c2 === 'C2' && r.c3 === 'C3' && r.c4 === 'C4' && r.c5 === 'C5',
     JSON.stringify(r));
  ok('64 kt is the hurricane threshold, and 63 is not',
     r.boundary[0] === 'TS' && r.boundary[1] === 'C1', JSON.stringify(r.boundary));
  ok('a missing wind does not crash the colour lookup', r.nullSafe === 'TD');
  ok('every category has its own colour', r.distinct === r.total,
     `${r.distinct} colours for ${r.total} categories`);
}

console.log('\n11. it closes, and says so when there is nothing loaded');
{
  const r = await page.evaluate(() => {
    document.querySelector('.cyc-ens-x').click();
    const closed = !_cycEnsIsOpen();
    _cycGroups = {};
    _cycEnsOpen();
    const el = document.getElementById('cyc-ens-panel');
    return { closed, empty: el.querySelector('.cyc-ens-summary').textContent };
  });
  ok('the close button closes it', r.closed);
  ok('with no tracks loaded it says to turn them on rather than showing blank '
     + 'charts', /spaghetti models/i.test(r.empty), r.empty.slice(0, 120));
}

console.log('\nZ. a run the Pi does not have leaves the button honest');
{
  const r = await page.evaluate(async () => {
    // The failure people actually hit: the Pi has no run yet. This used to
    // set _cycOn true before finding that out, so the button read "Hide
    // tracks" over an empty map and the NEXT press disabled rather than
    // retrying. Pressing again and again alternated between two kinds of
    // nothing, which is what a broken feature looks like from outside.
    const real = window._cycFresh;
    window._cycFresh = async () => null;
    _cycDisable();
    await _cycEnable();
    const afterFail = { on: _cycOn, layers: _cycLayers.length };
    // And a second press must TRY AGAIN rather than turn something off.
    let tried = 0;
    window._cycFresh = async () => { tried++; return null; };
    await _cycEnable();
    window._cycFresh = real;
    return { afterFail, tried };
  });
  ok('a run that is not there leaves the layer off, not on-with-nothing',
     r.afterFail.on === false, JSON.stringify(r.afterFail));
  ok('and nothing is drawn', r.afterFail.layers === 0, String(r.afterFail.layers));
  // It asks more than once per press, because the status line under the
  // panel refreshes from the same place. What matters is that it ASKS at all
  // rather than flipping a flag: a retry is a retry.
  ok('so pressing again really tries again rather than toggling nothing',
     r.tried >= 1, String(r.tried));
}

console.log('\nZb. the chosen variant follows what is really drawn');
{
  const r = await page.evaluate(async () => {
    // A saved choice the run does not carry. The code falls back for the
    // DRAWING, and used to leave the variable pointing at the absent one, so
    // the panel showed one thing and every later question was answered with
    // another.
    const real = window._cycFresh;
    const man = { tracks: {
      'fnv3_mean':    { variant: 'FNV3P0', path: 'a.json' },
      'fnv3_members': { variant: 'FNV3P0', path: 'b.json' },
    } };
    window._cycFresh = async () => ({ run: 'r', man });
    _cycVariant = 'OPER';                    // not in this run
    _cycDisable();
    await _cycEnable();
    const drawn = _cycVariant;
    await _spagCycSync();
    const sel = document.getElementById('cyc-variant-sel');
    const out = { drawn, afterSync: _cycVariant,
                  selValue: sel ? sel.value : null,
                  options: sel ? [...sel.options].map(o => o.value) : [] };
    window._cycFresh = real;
    _cycDisable();
    return out;
  });
  ok('the chosen variant moves to one the run actually has',
     r.drawn === 'FNV3P0', r.drawn);
  ok('and stays there after the panel is rebuilt',
     r.afterSync === 'FNV3P0', r.afterSync);
  // A select whose value is not among its own options silently shows the
  // first one, so a variable left behind makes the control a liar.
  ok('the control shows what is chosen rather than defaulting silently',
     r.selValue === r.afterSync, `${r.selValue} vs ${r.afterSync}`);
  ok('and only offers what the run holds', r.options.join() === 'FNV3P0',
     JSON.stringify(r.options));
}

console.log('\n12. nothing above threw');
{
  const real = errors.filter(e => !/Failed to fetch|NetworkError|ERR_FAILED|net::/i.test(e));
  ok('no page errors', real.length === 0, real.slice(0, 3).join(' | '));
}

await browser.close();
console.log();
if (fail) { console.log(`${fail} FAILED, ${pass} passed`); process.exit(1); }
console.log(`all ${pass} passed`);
