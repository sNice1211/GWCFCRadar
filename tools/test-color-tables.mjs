#!/usr/bin/env node
/*
 * Colour tables anchored to values, and the Settings panel they live in.
 *
 *     node tools/test-color-tables.mjs
 *
 * A colour table used to be a list of colours spread evenly across a
 * product's range. That is easy and it is not how anybody reads a radar
 * picture: a forecaster wants green to START at 20 dBZ and red at 50,
 * because those numbers are thresholds. So a stop is now a value and a
 * colour, and the interesting failures are all about that pairing.
 *
 * The one that already happened, and the reason a whole section here exists:
 * the code that decides "is this a usable palette" tested every stop with a
 * hex-string regex. Anchored stops are objects, so they all failed it, the
 * palette was silently treated as absent, and the product carried on
 * painting itself in the default colours while the editor cheerfully showed
 * the custom ones. Nothing threw. It just quietly did not work.
 *
 * The .pal reader is checked against the format's real semantics rather than
 * against whatever it happens to return: a two-colour Color line is a band
 * that fades to the NEXT line's value, which is what makes GRLevelX tables
 * look banded, and getting that wrong produces a table that is plausible and
 * wrong.
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
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
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
await page.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'load' });
await page.waitForTimeout(2200);


console.log('\n1. a stop is a value and a colour');
{
  const r = await page.evaluate(() => {
    const def = { min: 0, max: 100, unit: 'dBZ', step: 1 };
    const g = _fxGradientFn('ref', [{ v: 20, c: '#00ff00' }, { v: 50, c: '#ff0000' }]);
    return {
      atLow: g(20), atHigh: g(50), atMid: g(35),
      below: g(-10), above: g(200),
      // The legacy form has to keep meaning what it always meant, because
      // it is what is already saved in people's browsers.
      legacyLo: _fxGradientFn('ref', ['#000000', '#ffffff'])(-30),
      legacyHi: _fxGradientFn('ref', ['#000000', '#ffffff'])(80),
      legacyMid: _fxGradientFn('ref', ['#000000', '#ffffff'])(25),
      norm: _stopsNormalize(['#000000', '#ffffff'], def),
      unsorted: _stopsNormalize(
        [{ v: 60, c: '#ff0000' }, { v: 10, c: '#00ff00' }], def),
    };
  });
  ok('the colour at a stop is exactly that stop', r.atLow === 'rgb(0,255,0)'
     && r.atHigh === 'rgb(255,0,0)', `${r.atLow} / ${r.atHigh}`);
  ok('and between them it blends', r.atMid === 'rgb(128,128,0)', r.atMid);
  // Outside the table the colour is held, not faded away: a value below the
  // lowest stop is still that colour, which is what a table means.
  ok('below the table it holds the first colour', r.below === 'rgb(0,255,0)', r.below);
  ok('above it holds the last', r.above === 'rgb(255,0,0)', r.above);
  ok('a legacy list of colours still spreads across the range',
     r.legacyLo === 'rgb(0,0,0)' && r.legacyHi === 'rgb(255,255,255)',
     `${r.legacyLo} / ${r.legacyHi}`);
  ok('with its middle still in the middle', r.legacyMid === 'rgb(128,128,128)',
     r.legacyMid);
  ok('and converting it anchors the ends at the range ends',
     r.norm.length === 2 && r.norm[0].v === 0 && r.norm[1].v === 100,
     JSON.stringify(r.norm));
  ok('a table typed out of order is sorted, not rejected',
     r.unsorted.length === 2 && r.unsorted[0].v === 10,
     JSON.stringify(r.unsorted));
}


console.log('\n2. the palette really reaches the picture');
{
  // This is the bug that already happened once. The editor showed the custom
  // colours and the map kept painting the defaults, because the "is this
  // usable" check only recognised hex strings.
  const r = await page.evaluate(() => {
    _fxColors.ref = { on: true, stops: [{ v: 20, c: '#00ff00' },
                                        { v: 50, c: '#ff0000' }] };
    const anchored = _fxPaletteFor('ref');
    const drawn = _meshColorFn('ref')(20);
    _fxColors.ref = { on: true, stops: ['#000000', '#ffffff'] };
    const legacy = _fxPaletteFor('ref');
    const drawnLegacy = _meshColorFn('ref')(-30);
    _fxColors.ref = { on: true, stops: [{ v: 5, c: 'not a colour' }] };
    const junk = _fxPaletteFor('ref');
    delete _fxColors.ref;
    return { anchored: !!anchored, drawn, legacy: !!legacy, drawnLegacy,
             junk: junk === null };
  });
  ok('an anchored table is recognised as a palette', r.anchored);
  ok('and the renderer paints with it, not with the defaults',
     r.drawn === 'rgb(0,255,0)', r.drawn);
  ok('a legacy table is still recognised too', r.legacy);
  ok('and still paints', r.drawnLegacy === 'rgb(0,0,0)', r.drawnLegacy);
  ok('while nonsense is refused rather than half applied', r.junk);
}


console.log('\n3. the 256-step table the picture recolourer indexes');
{
  const r = await page.evaluate(() => {
    const def = { min: -30, max: 80 };
    const lut = _customLut([{ v: -30, c: '#000000' }, { v: 80, c: '#ffffff' }], def);
    // A table that only covers the top of the range must leave the bottom
    // clamped, not stretched: this is what anchoring buys.
    const narrow = _customLut([{ v: 50, c: '#ff0000' }, { v: 80, c: '#0000ff' }], def);
    return {
      len: lut.length, first: lut[0], last: lut[255],
      narrowLow: narrow[0],
      narrowAt50: narrow[Math.round(((50 + 30) / 110) * 255)],
      tooFew: _customLut([{ v: 5, c: '#ffffff' }], def),
      // lo/hi is how the model manifest spells the same thing.
      loHi: _customLut([{ v: 0, c: '#000000' }, { v: 10, c: '#ffffff' }],
                       { lo: 0, hi: 10 })[255],
    };
  });
  ok('it has one entry per step of the original ramp', r.len === 256, String(r.len));
  ok('the ends land on the end colours',
     JSON.stringify(r.first) === '[0,0,0]'
     && JSON.stringify(r.last) === '[255,255,255]',
     `${JSON.stringify(r.first)} ${JSON.stringify(r.last)}`);
  ok('a table covering only part of the range clamps below it',
     JSON.stringify(r.narrowLow) === '[255,0,0]', JSON.stringify(r.narrowLow));
  ok('and starts where it says it starts',
     JSON.stringify(r.narrowAt50) === '[255,0,0]', JSON.stringify(r.narrowAt50));
  ok('one stop is not a table', r.tooFew === null, JSON.stringify(r.tooFew));
  // The radar families say min/max and the model manifest says lo/hi. A
  // table anchored to values is meaningless if the range is read wrong.
  ok('lo/hi is understood as well as min/max',
     JSON.stringify(r.loHi) === '[255,255,255]', JSON.stringify(r.loHi));
}


console.log('\n4. somebody else\'s GRLevelX .pal file');
{
  const r = await page.evaluate(() => ({
    pal: parseColorTable([
      'Product: BR', 'Units: DBZ', 'Step: 5', '; a comment',
      'Color: 5 0 236 236',
      'Color: 20 0 255 0 0 128 0',
      'SolidColor: 35 255 255 0',
      'Color4: 75 255 255 255 255',
    ].join('\n')),
    csv: parseColorTable('10,#00ff00\n20,#ffff00\n30,255,0,0\n'),
    json: parseColorTable(JSON.stringify(
      { units: 'dBZ', stops: [{ v: 5, c: '#04e9e7' }, { v: 50, c: '#fd0000' }] })),
    plainJson: parseColorTable(JSON.stringify(['#000000', '#ffffff'])),
    junk: parseColorTable('hello world\nthis is not a colour table'),
    empty: parseColorTable(''),
  }));

  ok('the header is read', r.pal.product === 'BR' && r.pal.units === 'DBZ'
     && r.pal.step === 5, JSON.stringify(r.pal).slice(0, 90));
  const s = r.pal.stops;
  ok('a plain Color line is one stop at its value',
     s[0].v === 5 && s[0].c === '#00ecec', JSON.stringify(s[0]));
  // The part that is easy to get plausibly wrong. "Color: 20 r g b r2 g2 b2"
  // means the band STARTS at 20 with the first colour and reaches the second
  // just as the next line's value arrives. Treating the second colour as
  // another stop at 20, or ignoring it, both produce a table that looks
  // fine and is not the one in the file.
  ok('a two-colour line fades from its own value to the next one',
     s[1].v === 20 && s[1].c === '#00ff00'
     && s[2].v === 35 && s[2].c === '#008000',
     JSON.stringify(s.slice(1, 3)));
  ok('SolidColor holds flat until the next value instead of fading',
     s[3].v === 35 && s[4].v === 75 && s[3].c === s[4].c,
     JSON.stringify(s.slice(3, 5)));
  ok('Color4 is read and its alpha ignored rather than eaten as a colour',
     s[s.length - 1].c === '#ffffff' && s[s.length - 1].v === 75,
     JSON.stringify(s[s.length - 1]));
  ok('two stops at one value survive, because that is a hard edge',
     s.filter(x => x.v === 35).length === 2, JSON.stringify(s));

  ok('a CSV of value and hex is read', r.csv.stops.length === 3
     && r.csv.stops[0].v === 10 && r.csv.stops[0].c === '#00ff00',
     JSON.stringify(r.csv.stops));
  ok('and a CSV of value and r,g,b',
     r.csv.stops[2].c === '#ff0000', JSON.stringify(r.csv.stops[2]));
  ok('JSON with values is read as anchored',
     r.json.stops.length === 2 && r.json.stops[1].v === 50,
     JSON.stringify(r.json.stops));
  ok('and a plain JSON list of colours as the legacy form',
     Array.isArray(r.plainJson.stops) && typeof r.plainJson.stops[0] === 'string',
     JSON.stringify(r.plainJson.stops));
  ok('a file that is not a colour table yields nothing, rather than guessing',
     r.junk.stops.length === 0, JSON.stringify(r.junk.stops));
  ok('and neither does an empty one', r.empty.stops.length === 0);
}


console.log('\n5. a table can be taken away again');
{
  const r = await page.evaluate(() => {
    const def = { min: -30, max: 80, unit: 'dBZ' };
    const stops = [{ v: 5, c: '#04e9e7' }, { v: 50, c: '#fd0000' }];
    const pal = colorTableToPal(stops, def, 'BR');
    return { pal, back: parseColorTable(pal).stops,
             hasDownload: typeof _ctDownload === 'function' };
  });
  ok('the export names the product and its units',
     /Product: BR/.test(r.pal) && /Units: dBZ/.test(r.pal), r.pal.split('\n')[0]);
  ok('and writes one Color line per stop',
     (r.pal.match(/^Color:/gm) || []).length === 2, r.pal);
  // The real test of an exporter is whether the importer agrees with it.
  ok('reading it back gives the same table',
     r.back.length === 2 && r.back[0].v === 5 && r.back[0].c === '#04e9e7'
     && r.back[1].v === 50 && r.back[1].c === '#fd0000',
     JSON.stringify(r.back));
  ok('and there is something to save it with', r.hasDownload);
}


console.log('\n6. editing a table by value');
{
  const r = await page.evaluate(() => {
    lqmOpenSettings();
    lqmSettingsCat('radar');
    _fxUiPick('ref');
    _fxUiApplyTable([{ v: 20, c: '#00ff00' }, { v: 60, c: '#ff0000' }], 'test');
    const boxes = () => Array.from(
      document.querySelectorAll('#lqm-fx-stops .lqm-grad-stop-v')).map(i => +i.value);
    const before = boxes();
    const paintedAt20 = _meshColorFn('ref')(20);
    _fxUiStopValue(0, 40);                       // move green up to 40
    const moved = boxes();
    const paintedAt40 = _meshColorFn('ref')(40);
    _fxUiAddStop();
    const added = boxes();
    _fxUiInvert();
    const invertedVals = boxes();
    const invertedTop = _meshColorFn('ref')(60);
    // Dragging a stop past its neighbour is a legitimate edit.
    _fxUiStopValue(0, 99);
    const resorted = boxes();
    const out = { before, moved, added, invertedVals, resorted,
                  paintedAt20, paintedAt40, invertedTop };
    _fxUiReset();
    return out;
  });
  ok('the editor shows a value box per stop', r.before.length === 2,
     JSON.stringify(r.before));
  ok('anchored where the table says', r.before[0] === 20 && r.before[1] === 60,
     JSON.stringify(r.before));
  ok('and the map paints that colour at that value',
     r.paintedAt20 === 'rgb(0,255,0)', r.paintedAt20);
  ok('typing a new value moves the colour there',
     r.moved[0] === 40 && r.paintedAt40 === 'rgb(0,255,0)',
     `${JSON.stringify(r.moved)} ${r.paintedAt40}`);
  // A new stop goes in the widest gap by VALUE. Appending to the list would
  // put it somewhere nobody asked for now that position means something.
  ok('a new colour lands between the two furthest apart',
     r.added.length === 3 && r.added[1] > r.added[0] && r.added[1] < r.added[2],
     JSON.stringify(r.added));
  // Invert flips the COLOURS and leaves the anchors alone: an inverted table
  // should still have its edges on the same numbers.
  ok('inverting keeps every anchor where it was',
     JSON.stringify(r.invertedVals) === JSON.stringify(r.added),
     `${JSON.stringify(r.invertedVals)} vs ${JSON.stringify(r.added)}`);
  ok('while the colours really did swap ends',
     r.invertedTop === 'rgb(0,255,0)', r.invertedTop);
  ok('and a stop dragged past its neighbour re-sorts rather than breaking',
     r.resorted[0] <= r.resorted[1] && r.resorted[1] <= r.resorted[2],
     JSON.stringify(r.resorted));
}


console.log('\n7. the Settings rail');
{
  const r = await page.evaluate(() => {
    lqmOpenSettings();
    const tabs = Array.from(document.querySelectorAll('#lqm-set-rail .lqm-set-tab'))
      .map(t => t.dataset.tab);
    // The tab's words have to be the section's own words, not a second set
    // invented beside them that can drift.
    const labels = Array.from(document.querySelectorAll('#lqm-set-rail .lqm-set-tab'))
      .map(t => t.querySelector('span').textContent);
    const headings = Array.from(
      document.querySelectorAll('#lqm-set-content .lqm-settings-category'))
      .map(h => h.textContent.trim());
    labels.headings = headings;
    const shown = () => Array.from(
      document.querySelectorAll('#lqm-set-content [data-cat]'))
      .filter(g => !g.hidden).map(g => g.dataset.cat);
    lqmSettingsCat('model-colors');
    const onModels = shown();
    const litTab = document.querySelector('#lqm-set-rail .lqm-set-tab.on').dataset.tab;
    const litCount = document.querySelectorAll('#lqm-set-rail .lqm-set-tab.on').length;
    lqmSettingsCat('alerts');
    const onAlerts = shown();
    // A tab that reveals nothing reads as something being broken.
    const everyTabHasContent = tabs.every(t =>
      document.querySelector(`#lqm-set-content [data-cat="${t}"]`));
    // A gated card is deliberately unreachable until its gate opens: the
    // Forecaster Desk has no tab for anyone who is not a forecaster, because
    // a tab reading "Forecaster Desk" announces the feature to exactly the
    // people who cannot use it. Everything ungated must still have a way in.
    const everyCardHasTab = Array.from(
      document.querySelectorAll('#lqm-set-content [data-cat]'))
      .filter(g => !(g.dataset.gated && g.style.display === 'none'))
      .every(g => tabs.includes(g.dataset.cat));
    const gatedHidden = Array.from(
      document.querySelectorAll('#lqm-set-content [data-gated]'))
      .filter(g => g.style.display === 'none')
      .every(g => !tabs.includes(g.dataset.cat));
    lqmSettingsCat('nonsense-category');
    const afterJunk = shown();
    // Rebuilding must not duplicate the rail.
    lqmOpenSettings(); lqmOpenSettings();
    const tabsAfter = document.querySelectorAll('#lqm-set-rail .lqm-set-tab').length;
    return { tabs, onModels, litTab, litCount, onAlerts, everyTabHasContent,
             everyCardHasTab, gatedHidden, afterJunk, tabsAfter, labels };
  });
  ok('there is a tab per section', r.tabs.length >= 14, String(r.tabs.length));
  ok('every tab id is unique, so one click lights one tab',
     new Set(r.tabs).size === r.tabs.length, r.tabs.join(','));
  // The names are the ones the sections already had. Inventing tab labels
  // beside them would mean two names for one thing and a second place for
  // them to drift apart.
  ok('the tabs are named after the sections themselves',
     r.labels.includes('Radar Colors') && r.labels.includes('StormStream Mode')
     && r.labels.includes('Map Borders & Labels'), r.labels.join(' | '));
  ok('and nothing was renamed on the way',
     r.tabs.length === r.labels.length, r.labels.join(' | '));
  ok('choosing one shows only that section',
     r.onModels.length === 1 && r.onModels[0] === 'model-colors',
     r.onModels.join(','));
  ok('and lights exactly one tab', r.litTab === 'model-colors' && r.litCount === 1,
     `${r.litTab} x${r.litCount}`);
  ok('switching swaps the whole content',
     r.onAlerts.length === 1 && r.onAlerts[0] === 'alerts', r.onAlerts.join(','));
  ok('every tab reveals something', r.everyTabHasContent);
  ok('and every ungated card is reachable from some tab', r.everyCardHasTab);
  ok('while a gated one is offered no tab at all', r.gatedHidden);
  ok('an unknown category falls back rather than showing an empty panel',
     r.afterJunk.length > 0, r.afterJunk.join(','));
  ok('opening twice does not build the rail twice',
     r.tabsAfter === r.tabs.length, `${r.tabsAfter} vs ${r.tabs.length}`);
}


console.log('\n8. radar and models have their own opacity');
{
  const r = await page.evaluate(() => {
    const before = modelOpacity;
    lqmSetModelOpacity(35);
    const after = modelOpacity;
    const label = document.getElementById('lqm-modelopacity-val').textContent;
    const saved = localStorage.getItem('lqm_modelopacity');
    const radarBefore = radarOpacity;
    lqmSetRadarOpacity(55);
    const both = { model: modelOpacity, radar: radarOpacity };
    lqmSetModelOpacity(72);
    return { before, after, label, saved, radarBefore, both,
             hasRadarSlider: !!document.getElementById('lqm-set-opacity'),
             hasModelSlider: !!document.getElementById('lqm-set-modelopacity') };
  });
  ok('both sliders exist', r.hasRadarSlider && r.hasModelSlider);
  ok('the model slider moves model opacity', r.after === 0.35, String(r.after));
  ok('and says so on screen', r.label === '35%', r.label);
  ok('and is remembered', r.saved === '35', String(r.saved));
  // The two are separate on purpose: a model field is a smooth wash and
  // radar is scattered echoes, so the level that works for one is wrong for
  // the other. One shared slider meant always compromising.
  ok('moving radar opacity leaves models alone',
     r.both.radar === 0.55 && r.both.model === 0.35,
     `radar ${r.both.radar}, model ${r.both.model}`);
}


console.log('\n9. nothing above threw');
{
  const real = errors.filter(e => !/Failed to fetch|NetworkError|ERR_FAILED|net::/i.test(e));
  ok('no page errors', real.length === 0, real.slice(0, 3).join(' | '));
}

await browser.close();
console.log();
if (fail) { console.log(`${fail} FAILED, ${pass} passed`); process.exit(1); }
console.log(`all ${pass} passed`);
