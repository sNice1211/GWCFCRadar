#!/usr/bin/env node
/*
 * The sounding, now that it is a right-click away.
 *
 *     node tools/test-sounding-ctx.mjs
 *
 * It used to be a button inside the Run Models panel, and that was wrong twice
 * over. It only ever read the map's centre, so getting a profile somewhere
 * meant dragging the map until that place was in the middle. And it sat inside
 * the models panel, which made it look like a thing about models, when the
 * profile is read off the Pi's own level images and has nothing to do with
 * which layer is on screen: radar, satellite, a model chart or a bare basemap
 * all give the same answer for the same point.
 *
 * So it moved to the menu where every other "what is HERE" question is already
 * asked. These check it is really there, that it takes the point that was
 * clicked rather than the middle of the screen, and that it opens whatever is
 * drawn underneath.
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

console.log('\n1. the old button is gone from the models panel');
{
  const r = await page.evaluate(() => ({
    btn: !!document.getElementById('sev-sounding-btn'),
    styleLeftBehind: [...document.styleSheets].some(sh => {
      try { return [...sh.cssRules].some(r => (r.selectorText || '').includes('sev-sounding-btn')); }
      catch (e) { return false; }
    }),
  }));
  ok('no Sounding button inside Run Models any more', r.btn === false);
  ok('and no styling left behind for it', r.styleLeftBehind === false);
}

console.log('\n2. it is in the right-click menu instead');
{
  const r = await page.evaluate(() => {
    _cmOpen({ latlng: L.latLng(35.4, -97.6), originalEvent: null });
    const el = document.getElementById('map-ctx-menu');
    const items = [...el.querySelectorAll('.cm-item')].map(i => i.textContent.trim());
    const row = [...el.querySelectorAll('.cm-item')]
      .find(i => /sounding/i.test(i.textContent));
    return {
      open: el.classList.contains('open'),
      items,
      hasRow: !!row,
      handler: row ? row.getAttribute('onclick') : null,
      hasIcon: row ? !!row.querySelector('svg') : false,
    };
  });
  ok('the menu opens', r.open);
  ok('there is a Sounding row in it', r.hasRow, JSON.stringify(r.items));
  ok('it calls the point handler, not the centre one',
     r.handler === '_cmSoundingHere()', String(r.handler));
  ok('it carries an icon like every other row', r.hasIcon);
}

console.log('\n3. it uses the point that was clicked, not the middle of the map');
{
  const r = await page.evaluate(async () => {
    // Move the map somewhere clearly different from the point clicked, so
    // reading the centre instead would be obvious.
    map.setView([44.0, -110.0], 5);
    const asked = [];
    const real = window.openSounding;
    window.openSounding = (lat, lon) => { asked.push([lat, lon]); };
    _cmOpen({ latlng: L.latLng(29.76, -95.37), originalEvent: null });
    _cmSoundingHere();
    const closed = !document.getElementById('map-ctx-menu').classList.contains('open');
    window.openSounding = real;
    const c = map.getCenter();
    return { asked, closed, centre: [c.lat, c.lng] };
  });
  ok('the sounding was asked for exactly once', r.asked.length === 1, JSON.stringify(r));
  ok('at the clicked point',
     r.asked[0] && Math.abs(r.asked[0][0] - 29.76) < 0.001
     && Math.abs(r.asked[0][1] + 95.37) < 0.001, JSON.stringify(r.asked));
  ok('and NOT at the map centre',
     r.asked[0] && Math.abs(r.asked[0][0] - r.centre[0]) > 1, JSON.stringify(r));
  ok('the menu closes behind it', r.closed);
}

console.log('\n4. it works whatever is drawn underneath');
{
  // The whole point of the move: the profile comes from the Pi's level
  // images, so the layer on screen is irrelevant. If anything ever made it
  // depend on the active layer, this is what would catch it.
  const r = await page.evaluate(async () => {
    const out = {};
    const real = window.openSounding;
    const scene = async (name, setup) => {
      const asked = [];
      window.openSounding = (lat, lon) => { asked.push([lat, lon]); };
      setup();
      _cmOpen({ latlng: L.latLng(31.0, -88.0), originalEvent: null });
      const row = [...document.querySelectorAll('#map-ctx-menu .cm-item')]
        .find(i => /sounding/i.test(i.textContent));
      const dim = row ? row.classList.contains('cm-dim') : true;
      row.click();
      out[name] = { count: asked.length, dim };
    };
    await scene('radar', () => {
      activeLayers.satellite = false; activeLayers.nexrad = true; _hdOn = false;
    });
    await scene('satellite', () => {
      activeLayers.nexrad = false; activeLayers.satellite = true; _hdOn = false;
    });
    await scene('model', () => {
      activeLayers.satellite = false; activeLayers.nexrad = false; _hdOn = true;
    });
    await scene('nothing', () => {
      activeLayers.satellite = false; activeLayers.nexrad = false; _hdOn = false;
    });
    window.openSounding = real;
    _hdOn = false;
    return out;
  });
  for (const scene of ['radar', 'satellite', 'model', 'nothing']) {
    ok(`with ${scene} on screen it still opens`, r[scene].count === 1,
       JSON.stringify(r[scene]));
    ok(`and is not greyed out under ${scene}`, r[scene].dim === false,
       JSON.stringify(r[scene]));
  }
}

console.log('\n5. a drawing tool still owns right-click');
{
  const r = await page.evaluate(() => {
    document.getElementById('map-ctx-menu').classList.remove('open');
    const was = typeof activeTool !== 'undefined' ? activeTool : null;
    activeTool = 'measure';
    _cmOpen({ latlng: L.latLng(35, -97), originalEvent: null });
    const opened = document.getElementById('map-ctx-menu').classList.contains('open');
    activeTool = was;
    return { opened };
  });
  ok('the menu stays out of the way while a tool is active', r.opened === false);
}

console.log('\n6. the model menu still works after the button came out');
{
  const r = await page.evaluate(() => {
    const panel = document.getElementById('run-models-panel');
    return {
      panel: !!panel,
      modelSel: !!document.getElementById('sev-model-sel'),
      regionSel: !!document.getElementById('sev-region-sel'),
      varSel: !!document.getElementById('sev-var-sel'),
      // Removing a child must not have taken the row it sat in with it.
      row: !!document.querySelector('.sev-dropdowns .sev-dd-wrap'),
    };
  });
  ok('the Run Models panel is intact', r.panel && r.row, JSON.stringify(r));
  ok('the model picker is still there', r.modelSel);
  ok('the region picker is still there', r.regionSel);
  ok('the product picker is still there', r.varSel);
}

console.log('\n7. the page carries the new fields and region names');
{
  const r = await page.evaluate(() => {
    const ids = HD_FIELDS.map(f => f.id);
    const want = ['rh2m', 'tcc', 'vis', 'cin', 'prate', 'snod', 'lftx', 'dswrf'];
    return {
      missing: want.filter(w => !ids.includes(w)),
      total: ids.length,
      noUnit: HD_FIELDS.filter(f => !f.unit).map(f => f.id),
      noLabel: HD_FIELDS.filter(f => !f.label).map(f => f.id),
      dupe: ids.filter((v, i) => ids.indexOf(v) !== i),
      conus32: _hdRegionLabel('conus32'),
      // Every field must have an Inspector scale, or hovering it reads a
      // number off a scale it was not painted with.
      noScale: ids.filter(id => !HD_INSP_SCALES[id]),
      badRamp: Object.entries(HD_INSP_SCALES)
        .filter(([, v]) => !HD_INSP_RAMPS[v.ramp]).map(([k]) => k),
    };
  });
  ok('all eight new fields are on the page', r.missing.length === 0, r.missing.join(','));
  // Sixteen before, twenty-four after. Written as a floor rather than an
  // exact number so adding a field later is not a test failure.
  ok('the field list really grew, from sixteen', r.total >= 24, String(r.total));
  ok('every field has a label and a unit',
     r.noUnit.length === 0 && r.noLabel.length === 0,
     JSON.stringify([r.noUnit, r.noLabel]));
  ok('no field is listed twice', r.dupe.length === 0, r.dupe.join(','));
  ok('every field has an Inspector scale', r.noScale.length === 0, r.noScale.join(','));
  ok('every scale names a ramp that exists', r.badRamp.length === 0, r.badRamp.join(','));
  ok('the folded coarse NAM grid has a readable region name',
     /32/.test(r.conus32), r.conus32);
}

console.log('\n8. the region picker says which resolution each region is');
{
  const r = await page.evaluate(() => {
    // Stand in a Pi index shaped the way the folded catalogue writes one.
    _hdIndex = { models: { nam: { label: 'NAM', res: '12 km', regions: {
      conus:   { res: '12 km', path: 'nam/conus/x/manifest.json', run: 'r' },
      alaska:  { res: '6 km',  path: 'nam/alaska/x/manifest.json', run: 'r' },
      conus32: { res: '32 km', path: 'nam/conus32/x/manifest.json', run: 'r' },
    } } } };
    _hdModel = 'nam'; _hdRegion = 'conus'; _hdFromPicker = true; _hdOn = true;
    _hdFillRegionPicker();
    const sel = document.getElementById('sev-region-sel');
    return {
      shown: sel.style.display !== 'none',
      opts: [...sel.options].map(o => o.textContent),
    };
  });
  ok('the picker shows when a model has more than one region', r.shown);
  ok('CONUS does not repeat the model resolution it already states',
     r.opts.some(o => o === 'CONUS'), JSON.stringify(r.opts));
  ok('a nest says its own finer resolution',
     r.opts.some(o => /Alaska.*6 km/.test(o)), JSON.stringify(r.opts));
  ok('and the coarse grid says its own',
     r.opts.some(o => /32 km/.test(o)), JSON.stringify(r.opts));
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
