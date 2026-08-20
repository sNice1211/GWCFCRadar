#!/usr/bin/env node
/*
 * The radar value filter and custom colors, proven on pixels.
 *
 *     node tools/test-radar-fx.mjs
 *
 * Runs the real page in a real browser with no network at all, hands the
 * renderer a synthetic mesh whose raw values are known exactly, and then
 * counts and samples the pixels that come out. That is the whole promise of
 * these settings: the filter hides real values, the colors repaint real
 * values, on every product family, Level 2 spelling or Level 3 code alike.
 *
 * It also pins the foundation the settings stand on: a Level 3 bucket code
 * like 'n0b' must PAINT. The renderer used to switch on exact product
 * strings, every bucket code fell through to "no color", and the whole
 * Level 3 fallback drew invisible pictures that only pixel-counting like
 * this would ever catch.
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

async function boot(initLocalStorage) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  if (initLocalStorage) {
    await page.addInitScript(seed => {
      Object.entries(seed).forEach(([k, v]) => localStorage.setItem(k, v));
    }, initLocalStorage);
  }
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
  // Three squares of known raw value on a 10 x 10 degree stage, so a filter
  // that keeps one of them keeps almost exactly a third of the pixels.
  //
  // The stage is built AROUND the radar site rather than at fixed absolute
  // coordinates, because that is what real radar data is: gates in a circle
  // centred on the antenna. Frames are now drawn into one site-centred box
  // for the whole loop (so playback cannot wobble), and a stage sitting off
  // to one side of its own site is geometry no real sweep produces.
  await page.evaluate(() => {
    window.__mkMesh = (cells, site) => {
      const arr = [];
      cells.forEach(c => arr.push(c.x0, c.y0, c.x1, c.y0, c.x1, c.y1,
                                  c.x0, c.y1, c.v));
      return { meshData: Float32Array.from(arr),
               bounds: [site.lon - 5, site.lat - 5, site.lon + 5, site.lat + 5],
               metadata: { timeIso: '2026-08-18T00:00:00Z' } };
    };
    // Offsets in degrees from the site: south-west, centre, north-east.
    window.__threeSquares = (a, b, c, stationId) => {
      const site = _meshSiteLatLon(stationId || 'ktlx') || { lat: 35, lon: -95 };
      const sq = (dx0, dy0, dx1, dy1, v) => ({
        x0: site.lon + dx0, y0: site.lat + dy0,
        x1: site.lon + dx1, y1: site.lat + dy1, v,
      });
      return window.__mkMesh([
        sq(-4, -4, -2, -2, a),
        sq(-1, -1,  1,  1, b),
        sq( 2,  2,  4,  4, c),
      ], site);
    };
    window.__opaque = () => {
      if (!_l3Canvas) return -1;
      const d = _l3Canvas.getContext('2d').getImageData(0, 0, 1000, 1000).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 10) n++;
      return n;
    };
    // Sample the center of square k (0..2) as [r,g,b,a].
    window.__sample = (k) => {
      const cx = [200, 500, 800][k], cy = [800, 500, 200][k];
      return [..._l3Canvas.getContext('2d').getImageData(cx, cy, 1, 1).data];
    };
  });
  return { page, errors };
}

console.log('\n1. the page boots and the family map holds');
const { page, errors } = await boot();
{
  ok('the page boots clean with real Leaflet', errors.length === 0, errors[0]);
  const fams = await page.evaluate(() => [
    _meshFamily('ref'), _meshFamily('n0b'), _meshFamily('n3b'),
    _meshFamily('tz0'), _meshFamily('tzl'), _meshFamily('ncr'),
    _meshFamily('vel'), _meshFamily('n1g'), _meshFamily('tv1'),
    _meshFamily('n0c'), _meshFamily('n0x'), _meshFamily('n0k'),
    _meshFamily('n0h'), _meshFamily('eet'), _meshFamily('sw'),
    _meshFamily('nonsense'),
  ].join(','));
  ok('every code lands in its family',
     fams === 'ref,ref,ref,ref,ref,ref,vel,vel,vel,cc,zdr,kdp,hc,et,sw,',
     fams);
}

console.log('\n2. a Level 3 bucket code paints real pixels');
{
  const n = await page.evaluate(() => {
    _renderMesh(window.__threeSquares(10, 30, 50, 'KTLX'), 'n0b', 'KTLX');
    return window.__opaque();
  });
  ok('reflectivity under its bucket name draws', n > 100000, String(n));
  const terminals = await page.evaluate(() => {
    _renderMesh(window.__threeSquares(10, 30, 50, 'TTPA'), 'tz0', 'TTPA');
    return window.__opaque();
  });
  ok('and the terminal dialect draws the same picture',
     terminals === n, terminals + ' vs ' + n);
  const hc = await page.evaluate(() => {
    _renderMesh(window.__threeSquares(60, 100, 140, 'KTLX'), 'n0h', 'KTLX');
    return { n: window.__opaque(), rain: window.__sample(0),
             hail: window.__sample(1) };
  });
  ok('hydro classes paint their categories', hc.n > 100000, String(hc.n));
  ok('rain paints green and hail paints red',
     hc.rain[1] > hc.rain[0] && hc.hail[0] > hc.hail[1],
     JSON.stringify([hc.rain, hc.hail]));
  const et = await page.evaluate(() => {
    _renderMesh(window.__threeSquares(5, 30, 55, 'KTLX'), 'eet', 'KTLX');
    return window.__opaque();
  });
  ok('echo tops paint', et > 100000, String(et));
}

console.log('\n3. the filter hides raw values, not paint');
{
  const r = await page.evaluate(() => {
    _fxFilter = {}; _fxColors = {}; _fxSave();
    _renderMesh(window.__threeSquares(10, 30, 50, 'KTLX'), 'n0b', 'KTLX');
    const all = window.__opaque();
    _fxFilter = { ref: { on: true, min: 40, max: 80 } }; _fxSave();
    _radarFxApply();
    const kept = window.__opaque();
    _fxFilter = { ref: { on: true, min: 75, max: 80 } }; _fxSave();
    _radarFxApply();
    const none = window.__opaque();
    _fxFilter = {}; _fxSave(); _radarFxApply();
    const back = window.__opaque();
    return { all, kept, none, back };
  });
  ok('everything shows with no filter', r.all > 100000, String(r.all));
  ok('a 40 dBZ floor keeps only the strong square',
     r.kept > 0 && Math.abs(r.kept - r.all / 3) < r.all * 0.05,
     r.kept + ' of ' + r.all);
  ok('a floor above every echo hides them all', r.none === 0, String(r.none));
  ok('clearing the filter brings everything back', r.back === r.all,
     r.back + ' vs ' + r.all);
}

console.log('\n4. custom colors repaint from the raw value');
{
  const r = await page.evaluate(() => {
    _fxFilter = {}; _fxColors = {}; _fxSave();
    // Squares at 2, 30 and 50 dBZ: the built-in scale hides anything under
    // 5 dBZ, so the weak square is invisible until the user's own colors
    // take over and paint the whole range.
    _renderMesh(window.__threeSquares(2, 30, 50, 'KTLX'), 'n0b', 'KTLX');
    const dflt = window.__opaque();
    _fxColors = { ref: { on: true,
      stops: ['#ff0000', '#ff0000', '#ff0000', '#ff0000', '#ff0000'] } };
    _fxSave(); _radarFxApply();
    const painted = window.__opaque();
    const weak = window.__sample(0), strong = window.__sample(2);
    _fxColors = {}; _fxSave(); _radarFxApply();
    return { dflt, painted, weak, strong };
  });
  // Three equal squares; the default scale hides the 2 dBZ one, so custom
  // colors painting all three lands at very nearly 3/2 the default's pixels.
  ok('the default scale hides the weak echo', r.dflt > 0
     && r.painted > r.dflt * 1.4 && r.painted < r.dflt * 1.6,
     r.painted + ' vs ' + r.dflt);
  ok('and the paint is exactly the chosen color',
     r.weak[0] === 255 && r.weak[1] === 0 && r.strong[0] === 255,
     JSON.stringify([r.weak, r.strong]));
  const grad = await page.evaluate(() => {
    _fxColors = { ref: { on: true,
      stops: ['#000000', '#404040', '#808080', '#c0c0c0', '#ffffff'] } };
    _fxSave(); _radarFxApply();
    const lo = window.__sample(0), hi = window.__sample(2);
    _fxColors = {}; _fxSave(); _radarFxApply();
    return { lo: lo[0], hi: hi[0] };
  });
  ok('a gradient runs low to high across the family range',
     grad.lo < grad.hi, JSON.stringify(grad));
}

console.log('\n5. one honest scale: knots and true echo tops');
{
  const v = await page.evaluate(() => {
    const mesh = Float32Array.from([0,0,1,0,1,1,0,1, -20]);
    _l3MeshNormalize(mesh, 'N0G');
    const kt = mesh[8];
    const mesh2 = Float32Array.from([0,0,1,0,1,1,0,1, 155, 0,0,1,0,1,1,0,1, 45]);
    _l3MeshNormalize(mesh2, 'EET');
    return { kt: +kt.toFixed(2), topped: mesh2[8], plain: mesh2[17] };
  });
  ok('Level 3 velocity converts m/s to knots', v.kt === -38.88, String(v.kt));
  ok('a topped echo top drops its +150 flag', v.topped === 5, String(v.topped));
  ok('an ordinary echo top stays put', v.plain === 45, String(v.plain));
  const insp = await page.evaluate(() => [
    _inspFormatValue('vel', 40.4),
    _inspFormatValue('n0h', 60),
    _inspFormatValue('n0h', 100),
    INSP_UNITS[_meshFamily('n0g')],
    INSP_UNITS[_meshFamily('n0b')],
  ].join('|'));
  ok('the Inspector reads knots, class names and family units',
     insp === '40|Light Rain|Hail|kt|dBZ', insp);
}

console.log('\n6. the Settings panel drives it all');
{
  const ui = await page.evaluate(() => {
    _fxFilter = {}; _fxColors = {}; _fxSave();
    lqmOpenSettings();
    const sel = document.getElementById('lqm-fx-fam');
    const opts = [...sel.options].map(o => o.value);
    _fxUiPick('vel');
    const mn = document.getElementById('lqm-fx-min');
    const mx = document.getElementById('lqm-fx-max');
    const velRange = mn.min + '..' + mx.max;
    const velLabel = document.getElementById('lqm-fx-min-val').textContent;
    _fxUiPick('ref');
    const refRange = document.getElementById('lqm-fx-min').min + '..'
                   + document.getElementById('lqm-fx-max').max;
    return { opts: opts.join(','), velRange, velLabel, refRange };
  });
  ok('the picker offers every family',
     ui.opts === 'ref,vel,sw,cc,zdr,kdp,hc,et,vil,composite,onehour,stormtotal', ui.opts);
  ok('velocity gets its own knots range', ui.velRange === '-100..100'
     && / kt$/.test(ui.velLabel), ui.velRange + ' / ' + ui.velLabel);
  ok('reflectivity gets the dBZ range', ui.refRange === '-30..80', ui.refRange);

  const state = await page.evaluate(() => {
    document.getElementById('lqm-fx-min').value = 40;
    _fxUiMin(40);
    _fxUiFilterOn(true);
    return { saved: localStorage.getItem('gwcfc_radar_filter'),
             active: !!_fxFilterFor('ref') };
  });
  ok('switching the filter on records it',
     state.active && /"ref"/.test(state.saved) && /"min":40/.test(state.saved),
     state.saved);
  const reset = await page.evaluate(() => {
    _fxUiReset();
    return { saved: localStorage.getItem('gwcfc_radar_filter'),
             active: !!_fxFilterFor('ref') };
  });
  ok('reset forgets this product\'s rules',
     !reset.active && !/"ref":\{"on":true/.test(reset.saved), reset.saved);
}

console.log('\n6b. picture-only families hide the filter, raw families keep it');
{
  const rows = await page.evaluate(() => {
    _fxUiPick('vil');
    const pic = {
      filter: document.getElementById('lqm-fx-filter-row').style.display,
      min: document.getElementById('lqm-fx-min-row').style.display,
      max: document.getElementById('lqm-fx-max-row').style.display,
      note: document.getElementById('lqm-fx-picture-note').style.display,
    };
    _fxUiPick('ref');
    const raw = {
      filter: document.getElementById('lqm-fx-filter-row').style.display,
      min: document.getElementById('lqm-fx-min-row').style.display,
      max: document.getElementById('lqm-fx-max-row').style.display,
      note: document.getElementById('lqm-fx-picture-note').style.display,
    };
    return { pic, raw };
  });
  ok('VIL (picture-only) hides the filter/min/max rows and shows the note',
     rows.pic.filter === 'none' && rows.pic.min === 'none'
     && rows.pic.max === 'none' && rows.pic.note !== 'none',
     JSON.stringify(rows.pic));
  ok('reflectivity (raw) shows the filter/min/max rows and hides the note',
     rows.raw.filter !== 'none' && rows.raw.min !== 'none'
     && rows.raw.max !== 'none' && rows.raw.note === 'none',
     JSON.stringify(rows.raw));
}

console.log('\n6c. Model Colors: per-field custom palettes for Pi chart pictures');
{
  const r = await page.evaluate(() => {
    localStorage.removeItem('gwcfc_model_colors');
    _hdColors = {};
    lqmOpenSettings();
    const sel = document.getElementById('lqm-hc-field');
    const hasFields = sel.options.length > 0;
    const firstIsT2m = sel.options.length && sel.options[0] !== undefined;
    _hdUiPick('t2m');
    _hdUiColor(0, '#123456');
    _hdUiColorsOn(true);
    const savedRaw = localStorage.getItem('gwcfc_model_colors');
    const pal = _hdPaletteFor('t2m');
    return { hasFields, firstIsT2m, savedRaw, pal };
  });
  ok('the field picker is populated from HD_FIELDS', r.hasFields, String(r.hasFields));
  ok('turning custom colors on for a field records it',
     r.pal && r.pal[0] === '#123456', JSON.stringify(r.pal));
  ok('the choice persists to localStorage',
     /"t2m"/.test(r.savedRaw) && /123456/.test(r.savedRaw), r.savedRaw);

  const reset = await page.evaluate(() => {
    _hdUiReset();
    return { pal: _hdPaletteFor('t2m'), saved: localStorage.getItem('gwcfc_model_colors') };
  });
  ok('reset forgets this field\'s custom colors',
     reset.pal === null && !/"t2m"/.test(reset.saved), JSON.stringify(reset));
}

console.log('\n6d. gradient editor: variable stop count, invert, presets, live preview');
{
  const radar = await page.evaluate(() => {
    _fxColors = {}; _fxSave();
    lqmOpenSettings();
    _fxUiPick('ref');
    const startCount = document.querySelectorAll('#lqm-fx-stops .lqm-grad-stop').length;
    _fxUiAddStop();
    const afterAdd = document.querySelectorAll('#lqm-fx-stops .lqm-grad-stop').length;
    const stopsAfterAdd = _fxColors.ref.stops.length;
    _fxUiRemoveStop(0);
    const afterRemove = document.querySelectorAll('#lqm-fx-stops .lqm-grad-stop').length;
    const original = FX_DEFAULT_STOPS.ref.slice();
    _fxColors.ref.stops = original.slice();
    _fxUiRenderStops();
    _fxUiInvert();
    const inverted = _fxColors.ref.stops.slice();
    _fxUiPreset('grayscale');
    const preset = _fxColors.ref.stops.slice();
    const presetOn = _fxColors.ref.on;
    const preview = document.getElementById('lqm-fx-preview').style.background;
    // Down to the floor of 2 stops, the remove button must disappear so a
    // gradient can never lose its low/high ends entirely.
    _fxColors.ref.stops = ['#000000', '#ffffff'];
    _fxUiRenderStops();
    const delButtonsAtFloor = document.querySelectorAll('#lqm-fx-stops .lqm-grad-stop-del').length;
    _fxColors = {}; _fxSave();   // leave no custom-color state behind for later sections
    return { startCount, afterAdd, stopsAfterAdd, afterRemove, original, inverted, preset, presetOn, preview, delButtonsAtFloor };
  });
  ok('radar: starts with 5 stops shown', radar.startCount === 5, String(radar.startCount));
  ok('radar: adding a stop grows both the swatch row and the saved array',
     radar.afterAdd === 6 && radar.stopsAfterAdd === 6, JSON.stringify(radar));
  ok('radar: removing a stop shrinks it back', radar.afterRemove === 5, String(radar.afterRemove));
  ok('radar: invert reverses the stop order',
     radar.inverted.join() === radar.original.slice().reverse().join(), JSON.stringify(radar));
  ok('radar: picking a preset replaces the stops and turns colors on',
     radar.preset.join() === '#000000,#404040,#808080,#c0c0c0,#ffffff' && radar.presetOn === true,
     JSON.stringify(radar));
  ok('radar: the preview bar is a real CSS gradient of the current stops',
     radar.preview.startsWith('linear-gradient') && radar.preview.includes('rgb(0, 0, 0)'), radar.preview);
  ok('radar: at the 2-stop floor, neither remaining stop can be deleted',
     radar.delButtonsAtFloor === 0, String(radar.delButtonsAtFloor));

  const model = await page.evaluate(() => {
    _hdColors = {}; _hdColorsSave();
    _hdUiPick('t2m');
    _hdUiAddStop();
    const afterAdd = document.querySelectorAll('#lqm-hc-stops .lqm-grad-stop').length;
    _hdUiInvert();
    const inverted = _hdColors.t2m.stops.length;
    _hdUiPreset('sunset');
    const preset = _hdColors.t2m.stops.slice();
    return { afterAdd, inverted, preset };
  });
  ok('model: adding a stop works the same way as the radar side',
     model.afterAdd === 6, String(model.afterAdd));
  ok('model: invert keeps the same stop count', model.inverted === 6, String(model.inverted));
  ok('model: presets apply here too',
     model.preset.join() === '#0d0887,#7e03a8,#cc4778,#f89441,#f0f921', model.preset.join());
}

console.log('\n7. the Pi reroute knows when raw data is required');
{
  const r = await page.evaluate(() => {
    _prSite = 'KTLX'; _prProduct = 'reflectivity'; _prTilt = 1;
    _fxFilter = { ref: { on: true, min: 40, max: 80 } }; _fxSave();
    const l2yes = _fxWantsRaw('l2');
    const l3yes = _fxWantsRaw('l3');
    _prProduct = 'vil';
    const vilL3 = _fxWantsRaw('l3');   // no raw feed for VIL
    _prProduct = 'velocity';
    const velNo = _fxWantsRaw('l3');   // filter is on ref, not vel
    _prProduct = 'reflectivity';
    _fxFilter = {}; _fxSave();
    const off = _fxWantsRaw('l3');
    return { l2yes, l3yes, vilL3, velNo, off };
  });
  ok('a reflectivity filter demands raw at both levels',
     r.l2yes === true && r.l3yes === true, JSON.stringify(r));
  ok('VIL keeps the Pi\'s paint, having no raw feed', r.vilL3 === false,
     String(r.vilL3));
  ok('a filter on one family leaves the others alone', r.velNo === false,
     String(r.velNo));
  ok('no rules, no reroute', r.off === false, String(r.off));
}

console.log('\n8. saved rules survive a fresh visit');
{
  const seeded = await boot({
    gwcfc_radar_filter: JSON.stringify({ ref: { on: true, min: 40, max: 80 } }),
    gwcfc_radar_colors: JSON.stringify({ ref: { on: true,
      stops: ['#ff0000', '#ff0000', '#ff0000', '#ff0000', '#ff0000'] } }),
  });
  const r = await seeded.page.evaluate(() => {
    _renderMesh(window.__threeSquares(10, 30, 50, 'KTLX'), 'n0b', 'KTLX');
    return { n: window.__opaque(), px: window.__sample(2),
             f: !!_fxFilterFor('ref'), c: !!_fxPaletteFor('ref') };
  });
  ok('the saved filter and colors load on boot', r.f && r.c,
     JSON.stringify(r));
  ok('and the very first draw obeys them: one square, painted red',
     r.n > 0 && r.n < 200000 && r.px[0] === 255 && r.px[1] === 0,
     r.n + ' ' + JSON.stringify(r.px));
  ok('nothing threw on the seeded boot', seeded.errors.length === 0,
     seeded.errors.join(' | '));
  await seeded.page.close();
}

console.log('\n9. nothing threw along the way');
ok('no uncaught errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
