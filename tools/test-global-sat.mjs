#!/usr/bin/env node
/*
 * The Global Mosaic satellite branch and the Satellite Colors settings tab.
 *
 *     node tools/test-global-sat.mjs
 *
 * Two features, one suite, because they shipped together and share a fate:
 * the GMGSI worldwide mosaic (Himawari, Meteosat and GOES stitched hourly)
 * arriving as a third satellite "kind" with its own sectors, and a settings
 * card that recolors every satellite picture through one CSS custom
 * property. Both have a server half (pi/satellite_pipeline.py) and a page
 * half, and the drift between those two files is exactly the kind of break
 * no one notices until a menu goes empty, so the last section reads the
 * pipeline source and holds the two lists against each other.
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

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'],
});
const ctx = await browser.newContext();
await ctx.addInitScript(() => {
  try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {}
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));

// One fake manifest for the global/pacific sector, shaped the way the Pi
// writes it, so the frames path can be walked without a Pi.
const MANIFEST = {
  sat: 'global', sector: 'pacific',
  products: {
    ir: {
      bounds: [[-55, 80], [55, 180]],
      frames: [
        { t: '20260823_120000', file: 'ir_20260823_120000.png',
          bounds: [[-55, 80], [55, 180]] },
        { t: '20260823_130000', file: 'ir_20260823_130000.png',
          bounds: [[-55, 80], [55, 180]] },
      ],
    },
  },
};

await page.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript',
      body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css',
      body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  if (url.includes('/satellite/global/pacific/manifest.json'))
    return route.fulfill({ contentType: 'application/json',
      body: JSON.stringify(MANIFEST) });
  return route.abort();
});
await page.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);

console.log('\n1. the catalogue holds together');
{
  const r = await page.evaluate(() => {
    const kind = GOES_KINDS.find(k => k.id === 'global');
    const cats = GOES_CATS.filter(c => c.kind === 'global');
    const prods = GOES_PRODUCTS.filter(p => p.gsat === 'global');
    const regions = GOES_REGIONS.filter(rg => rg.g);
    return {
      kind: !!kind,
      cats: cats.map(c => c.id),
      prods: prods.map(p => ({ id: p.id, src: p.src, recipe: p.recipe, group: p.group })),
      groupsResolve: prods.every(p => GOES_CATS.some(c => c.id === p.group && c.kind === 'global')),
      regions: regions.map(rg => rg.id),
      regionsInert: regions.every(rg => !rg.url && !rg.prefix),
    };
  });
  ok('a third kind, Global Mosaic, exists', r.kind);
  ok('with one category of its own', r.cats.length === 1, r.cats.join());
  ok('four products, all served by the Pi',
     r.prods.length === 4 && r.prods.every(p => p.src === 'pi'),
     JSON.stringify(r.prods));
  ok('their recipes are the four the pipeline builds',
     ['ir', 'vis', 'wv', 'swir'].every(x => r.prods.some(p => p.recipe === x)));
  ok('every product\'s group resolves to a global category', r.groupsResolve);
  ok('four sectors, marked g, with no WMS behind them',
     r.regions.length === 4 && r.regionsInert, r.regions.join());
}

console.log('\n2. the two worlds of sectors never mix');
{
  const r = await page.evaluate(() => {
    const offered = () => GOES_REGIONS
      .filter(rg => _goesRegionAvailable(rg, _goesProduct().ch)).map(rg => rg.id);
    const before = { product: _goesProductId, region: _goesRegionId };
    _setGoesProduct('glb-ir');
    const onGlobal = { offered: offered(), region: _goesRegionId,
                       target: _goesPiTarget() };
    _setGoesRegion('pacific');
    const onPacific = { target: _goesPiTarget() };
    // Back to a WMS band while sitting on a Himawari crop.
    _setGoesProduct('ch13');
    const onBand = { offered: offered(), region: _goesRegionId,
                     cfg: _detectGoesConfig() };
    _setGoesProduct(before.product); _setGoesRegion(before.region);
    return { onGlobal, onPacific, onBand };
  });
  ok('a global product offers exactly the four mosaic sectors',
     r.onGlobal.offered.length === 4 && r.onGlobal.offered.every(
       id => ['global', 'pacific', 'meteosat', 'indian'].includes(id)),
     r.onGlobal.offered.join());
  ok('landing on it from a GOES sector falls back to Whole World',
     r.onGlobal.region === 'global', r.onGlobal.region);
  ok('and the frames target is the global satellite',
     r.onGlobal.target && r.onGlobal.target.sat === 'global'
       && r.onGlobal.target.sector === 'global',
     JSON.stringify(r.onGlobal.target));
  ok('picking the Himawari sector aims the target at it',
     r.onPacific.target && r.onPacific.target.sector === 'pacific',
     JSON.stringify(r.onPacific.target));
  ok('going back to an ABI band hides every mosaic sector',
     !r.onBand.offered.some(id => ['global', 'pacific', 'meteosat', 'indian'].includes(id)),
     r.onBand.offered.join());
  ok('and the region fell back rather than pointing a WMS at nothing',
     r.onBand.region === 'auto' && r.onBand.cfg && !!r.onBand.cfg.url,
     r.onBand.region);
}

console.log('\n3. frames really come from the Pi\'s global folder');
{
  const r = await page.evaluate(async () => {
    const realBase = _hdBase;
    _hdBase = 'https://pi.example.test';
    _goesPiMan.clear();
    const before = { product: _goesProductId, region: _goesRegionId };
    _setGoesProduct('glb-ir');
    _setGoesRegion('pacific');
    const frames = await _goesPiFrames();
    _setGoesProduct(before.product); _setGoesRegion(before.region);
    _hdBase = realBase;
    _goesPiMan.clear();
    return {
      n: frames.length,
      url: frames[0] ? frames[0].url : '',
      bounds: frames[0] ? frames[0].bounds : null,
      ordered: frames.length === 2 && frames[0].time < frames[1].time,
    };
  });
  ok('both hourly frames arrived', r.n === 2, String(r.n));
  ok('from /satellite/global/pacific/',
     /\/satellite\/global\/pacific\/ir_20260823_120000\.png$/.test(r.url), r.url);
  ok('carrying the sector\'s own rectangle',
     JSON.stringify(r.bounds) === JSON.stringify([[-55, 80], [55, 180]]),
     JSON.stringify(r.bounds));
  ok('oldest first, the order the timeline wants', r.ordered);
}

console.log('\n4. the menu itself offers the branch');
{
  const r = await page.evaluate(() => {
    toggleSatelliteSub();
    const wrap = document.getElementById('sub-bubbles');
    const kinds = Array.from(wrap.querySelectorAll('[data-sat-kind]'))
      .map(el => el.dataset.satKind);
    const globalBtn = wrap.querySelector('[data-sat-kind="global"]');
    if (globalBtn) globalBtn.click();
    const cats = Array.from(wrap.querySelectorAll('[data-sat-cat]'))
      .map(el => el.dataset.satCat);
    const catBtn = wrap.querySelector('[data-sat-cat="global-mosaic"]');
    if (catBtn) catBtn.click();
    const prods = Array.from(wrap.querySelectorAll('[data-product-id]'))
      .map(el => el.dataset.productId);
    // Choose the mosaic's infrared and read the region row as painted.
    const irBtn = wrap.querySelector('[data-product-id="glb-ir"]');
    if (irBtn) irBtn.click();
    const rowIds = Array.from(document.querySelectorAll('#sat-region-row .sat-region-btn'))
      .map(el => el.dataset.regionId);
    // Leave the menu the way it was found.
    _setGoesProduct('ch13'); _setGoesRegion('auto');
    wrap.innerHTML = ''; wrap.style.display = 'none'; wrap.dataset.mode = '';
    return { kinds, cats, prods, rowIds };
  });
  ok('level one lists the Global Mosaic kind', r.kinds.includes('global'), r.kinds.join());
  ok('level two lists its category', r.cats.includes('global-mosaic'), r.cats.join());
  ok('level three lists all four products',
     ['glb-ir', 'glb-vis', 'glb-wv', 'glb-swir'].every(id => r.prods.includes(id)),
     r.prods.join());
  ok('and the region row shows the mosaic\'s own sectors',
     r.rowIds.length === 4 && r.rowIds.includes('pacific'), r.rowIds.join());
}

console.log('\n5. every satellite surface is smooth and filterable');
{
  const r = await page.evaluate(() => {
    const pane = map.getPane('satPhotoPane');
    const cs = pane ? getComputedStyle(pane) : null;
    return {
      exists: !!pane,
      z: cs ? Number(cs.zIndex) : null,
      radarZ: Number(getComputedStyle(map.getPane('radarPane')).zIndex),
      alertsZ: Number(getComputedStyle(map.getPane('alertsPane')).zIndex),
      clicks: pane ? pane.style.pointerEvents : '',
      // The crisp/smooth rules bind to the IMG inside a pane, not to the
      // pane element, so that is where they have to be measured.
      rendering: (() => {
        const img = document.createElement('img');
        pane.appendChild(img);
        const v = getComputedStyle(img).imageRendering;
        img.remove(); return v;
      })(),
      radarRendering: (() => {
        const img = document.createElement('img');
        map.getPane('radarPane').appendChild(img);
        const v = getComputedStyle(img).imageRendering;
        img.remove(); return v;
      })(),
    };
  });
  ok('the photo pane exists', r.exists);
  ok('under the alerts, near the radar', r.z < r.alertsZ, `${r.z} vs ${r.alertsZ}`);
  ok('it cannot steal a click', r.clicks === 'none');
  ok('photographs are NOT forced pixelated the way radar is',
     r.rendering !== 'pixelated' && r.radarRendering === 'pixelated',
     `photo: ${r.rendering}, radar: ${r.radarRendering}`);
}

console.log('\n6. satellite colors change the paint, not the data');
{
  const r = await page.evaluate(() => {
    const prop = () => document.documentElement.style.getPropertyValue('--sat-filter').trim();
    _satcReset();
    const atRest = prop();
    _satcSet('contrast', 140);
    const contrast = prop();
    _satcSet('invert', true);
    _satcSet('colorize', true);
    _satcSet('hue', 120);
    const tinted = prop();
    // Order is meaning: the negative must be tinted, not the original.
    const orderRight = tinted.indexOf('invert(1)') !== -1
      && tinted.indexOf('invert(1)') < tinted.indexOf('sepia(1)')
      && tinted.indexOf('sepia(1)') < tinted.indexOf('hue-rotate(120deg)');
    const saved = JSON.parse(localStorage.getItem('gwcfc_satcolors') || 'null');
    _satcPreset('green');
    const preset = Object.assign({}, _satc);
    _satcReset();
    const cleared = prop();
    const savedAfterReset = JSON.parse(localStorage.getItem('gwcfc_satcolors') || 'null');
    return { atRest, contrast, tinted, orderRight, saved, preset, cleared, savedAfterReset };
  });
  ok('at rest there is no filter at all', r.atRest === '', r.atRest);
  ok('one slider writes one clean filter', r.contrast === 'contrast(1.4)', r.contrast);
  ok('invert, then tint, then tone: the order that means something', r.orderRight, r.tinted);
  ok('the choice survives in localStorage',
     r.saved && r.saved.contrast === 140 && r.saved.invert === true && r.saved.hue === 120,
     JSON.stringify(r.saved));
  ok('a preset is just named slider positions',
     r.preset.colorize === true && r.preset.hue === 60, JSON.stringify(r.preset));
  ok('reset clears the filter and the stored copy says so',
     r.cleared === '' && r.savedAfterReset && r.savedAfterReset.contrast === 100,
     r.cleared);
}

console.log('\n7. the settings tab is really there');
{
  const r = await page.evaluate(() => {
    lqmOpenSettings();
    _lqmSetBuildRail();
    const tabs = Array.from(document.querySelectorAll('#lqm-set-rail .lqm-set-tab'))
      .map(t => ({ id: t.dataset.tab, label: t.textContent.trim() }));
    const tab = tabs.find(t => /satellite colors/i.test(t.label));
    if (tab) lqmSettingsCat(tab.id);
    const card = document.querySelector('[data-cat="' + (tab ? tab.id : '') + '"]');
    const controls = ['lqm-satc-bright', 'lqm-satc-contrast', 'lqm-satc-sat',
                      'lqm-satc-hue', 'lqm-satc-invert', 'lqm-satc-colorize',
                      'lqm-satc-preset']
      .map(id => !!document.getElementById(id));
    // Whatever the map is doing is what the card shows.
    _satcSet('bright', 120);
    _satcSyncUi();
    const shown = document.getElementById('lqm-satc-bright').value;
    _satcReset();
    if (typeof lqmCloseSettings === 'function') lqmCloseSettings();
    return { tab, visible: card ? !card.hidden : false, controls, shown };
  });
  ok('the rail has a Satellite Colors tab', !!r.tab, JSON.stringify(r.tab));
  ok('clicking it shows the card', r.visible);
  ok('with every control present', r.controls.every(Boolean), r.controls.join());
  ok('and the card reads from the map\'s state, not from its own memory',
     r.shown === '120', r.shown);
}

console.log('\n8. the page and the pipeline agree on names');
{
  // Read from the two sources of truth rather than from copies here: the
  // sector ids the page offers must be folders the pipeline writes, and the
  // recipes the page asks for must be products the pipeline builds.
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const pipe = readFileSync(join(ROOT, 'pi', 'satellite_pipeline.py'), 'utf8');
  const sectorBlock = (pipe.match(/GLOBAL_SECTORS\s*=\s*\{([\s\S]*?)\n\}/) || [])[1] || '';
  const pipeSectors = [...sectorBlock.matchAll(/^\s*"([a-z]+)":/gm)].map(m => m[1]);
  const productBlock = (pipe.match(/GLOBAL_PRODUCTS\s*=\s*\{([\s\S]*?)\n\}/) || [])[1] || '';
  const pipeProducts = [...productBlock.matchAll(/^\s*"([a-z]+)":/gm)].map(m => m[1]);
  const pageSectors = [...html.matchAll(/\{ id: '([a-z]+)',\s+label: '[^']*',\s+url: null, prefix: null, g: true \}/g)]
    .map(m => m[1]);
  const pageRecipes = [...html.matchAll(/gsat: 'global', recipe: '([a-z]+)'/g)].map(m => m[1]);
  ok('the pipeline names four sectors', pipeSectors.length === 4, pipeSectors.join());
  ok('the page offers exactly those sectors',
     pageSectors.length === 4 && pageSectors.every(s => pipeSectors.includes(s)),
     `page: ${pageSectors.join()}, pipe: ${pipeSectors.join()}`);
  ok('the pipeline builds four products', pipeProducts.length === 4, pipeProducts.join());
  ok('the page asks for exactly those recipes',
     pageRecipes.length === 4 && pageRecipes.every(p => pipeProducts.includes(p)),
     `page: ${pageRecipes.join()}, pipe: ${pipeProducts.join()}`);
  ok('no em dash anywhere in the pipeline', !pipe.includes('\u2014'));
}

console.log('\n9. nothing threw');
ok('no uncaught page errors', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
