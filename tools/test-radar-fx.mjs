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
    // The canvas is sized to the box it draws now, rather than fixed at a
    // thousand pixels, so that a sweep reaching 460 km is not four times
    // blockier than one reaching 115. Nothing here may assume a size: read
    // the one the renderer chose and work in fractions of it.
    window.__opaque = () => {
      if (!_l3Canvas) return -1;
      const S = _l3Canvas.width;
      const d = _l3Canvas.getContext('2d').getImageData(0, 0, S, S).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 10) n++;
      return n;
    };
    // Sample the center of square k (0..2) as [r,g,b,a].
    window.__sample = (k) => {
      const S = _l3Canvas.width;
      const cx = Math.round([0.2, 0.5, 0.8][k] * S);
      const cy = Math.round([0.8, 0.5, 0.2][k] * S);
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
  // A stop is a value AND a colour now, so the palette is objects rather
  // than bare hex. The colour still has to be the one that was picked.
  ok('turning custom colors on for a field records it',
     r.pal && (r.pal[0].c || r.pal[0]) === '#123456', JSON.stringify(r.pal));
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
  // Invert flips the COLOURS and leaves the anchors where they are. Once a
  // stop is pinned to a value, reversing the array itself would move every
  // edge as well, which is not what inverting a colour table means: an
  // inverted reflectivity scale should still change colour at 35 and 50.
  ok('radar: invert reverses the colours and keeps the anchors',
     radar.inverted.map(s => s.c || s).join()
       === radar.original.slice().reverse().join(),
     JSON.stringify(radar.inverted));
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

console.log('\n10. an override you are not looking at cannot hide');
{
  // The reported fault: "all the colors are messed up and I have no color
  // tables on". The colour tables were innocent - checked to the pixel in
  // section 1 - and so was the renderer. What was not innocent is that these
  // settings are keyed by PRODUCT FAMILY and the panel shows ONE family at a
  // time, while "Back to Normal" cleared only the family on screen.
  //
  // Set a palette on Reflectivity, switch the picker to Velocity, press
  // Reset: Velocity is cleared, the panel now shows Velocity's untouched
  // settings, and Reflectivity carries on repainting every radar picture on
  // the site. The panel says nothing is on. Everything looks wrong. And it is
  // both levels at once, because a family does not know which level it came
  // from.
  const r = await page.evaluate(() => {
    _fxColors = {}; _fxFilter = {};
    // Somebody experiments with reflectivity colours.
    _fxColors.ref = { on: true,
      stops: ['#000000', '#333333', '#777777', '#bbbbbb', '#ffffff'] };
    _fxFilter.vel = { on: true, min: -20, max: 20 };
    _fxSave();
    const beforeCount = _fxActiveList().length;

    // ...then looks at a different product and presses Reset.
    _fxUiFam = 'vel';
    _fxUiReset();
    const afterOne = {
      active: _fxActiveList().map(x => x.fam),
      refStillOn: !!_fxPaletteFor('ref'),
    };
    // What the panel now says, which is the whole point.
    _fxUiSync();
    const line = (document.getElementById('lqm-fx-active') || {}).textContent || '';

    // And the way out.
    _fxUiResetAll();
    const afterAll = {
      active: _fxActiveList().length,
      ref: _fxPaletteFor('ref'), vel: _fxFilterFor('vel'),
      stored: localStorage.getItem('gwcfc_radar_colors'),
    };
    _fxUiSync();
    const cleanLine = (document.getElementById('lqm-fx-active') || {}).textContent || '';
    return { beforeCount, afterOne, line, afterAll, cleanLine };
  });
  ok('two products overriding is seen as two', r.beforeCount === 2,
     String(r.beforeCount));
  // Not a bug in itself - but it must not be the only thing called "reset".
  ok('resetting one product leaves the other one running',
     r.afterOne.refStillOn && r.afterOne.active.join(',') === 'ref',
     JSON.stringify(r.afterOne));
  // The fix. The panel now says so, whichever product is selected.
  ok('and the panel says out loud which products are still changed',
     /Reflectivity/i.test(r.line) && /colors/i.test(r.line), r.line);
  ok('naming that it applies to both levels, since that is what confuses',
     /Level 2 and Level 3/.test(r.line), r.line);
  ok('resetting every product really clears them all',
     r.afterAll.active === 0 && !r.afterAll.ref && !r.afterAll.vel,
     JSON.stringify(r.afterAll));
  ok('and clears what was saved, so a reload does not bring them back',
     !r.afterAll.stored || r.afterAll.stored === '{}', String(r.afterAll.stored));
  ok('the panel then says plainly that nothing is changed',
     /standard colors/i.test(r.cleanLine), r.cleanLine);
}

console.log('\n11. every product the menu offers can actually be coloured');
{
  // Found while chasing the above. Storm relative velocity matched no rule in
  // _meshFamily, so it had no colour function and painted NOTHING - a product
  // in the menu that could only ever draw an empty map.
  const r = await page.evaluate(() => {
    _fxUiResetAll();
    const codes = [];
    Object.keys(PR_PRODUCTS).forEach(k => {
      const p = PR_PRODUCTS[k];
      (p.l3Tilts || (p.l3 ? [p.l3] : [])).forEach(c => codes.push({ k, c }));
      if (p.l2) codes.push({ k, c: p.l2 });
    });
    // Only the ones the browser decodes itself. The Pi-painted pictures
    // (VIL, the precip totals) have no raw numbers behind them by design.
    const picture = Object.keys(RADAR_PICTURE_FAMS || {});
    const raw = codes.filter(x => !picture.includes(x.k));
    return raw.map(x => {
      const fam = _meshFamily(x.c);
      let paints = false;
      try {
        const fn = _meshColorFn(x.c);
        const probe = fam === 'cc' ? 0.95 : fam === 'vel' ? 40
                    : fam === 'zdr' ? 2 : fam === 'kdp' ? 2
                    : fam === 'sw' ? 5 : fam === 'hc' ? 30
                    : fam === 'et' ? 30 : 45;
        paints = !!fn(probe);
      } catch (e) {}
      return { product: x.k, code: x.c, fam, paints };
    });
  });
  const noFam = r.filter(x => !x.fam);
  const blank = r.filter(x => !x.paints);
  ok('every decoded product code maps to a family',
     noFam.length === 0, noFam.map(x => x.code).join(','));
  ok('and every one of them actually returns a colour',
     blank.length === 0, blank.map(x => `${x.code}:${x.fam}`).join(','));
  // The specific one that was broken.
  const srv = r.filter(x => /^n\ds$/.test(x.code));
  ok('storm relative velocity reads as velocity, not as nothing',
     srv.length > 0 && srv.every(x => x.fam === 'vel' && x.paints),
     JSON.stringify(srv));
}

console.log('\n12. correlation coefficient is not one flat green');
{
  // Reported as "why is cc green". Because it was, all of it.
  //
  // CC asks whether everything in a gate is the same kind of thing. Rain
  // answers about 0.98 and essentially ALL precipitation answers between 0.95
  // and 1.00, so a ramp spread evenly across the nominal 0 to 1.05 range
  // spends nineteen twentieths of itself on values the weather never takes.
  // Everything from 0.85 up landed inside a forty degree slice of green: a CC
  // picture of a supercell was a green blob.
  const r = await page.evaluate(() => {
    _fxUiResetAll();
    const fn = _meshColorFn('cc');
    const hex = v => String(fn(v));
    // Where all the weather actually is.
    const wx = [0.95, 0.96, 0.97, 0.98, 0.99, 1.00].map(hex);
    // The one thing CC exists to find, and the rain it sits inside.
    const debris = hex(0.70), rain = hex(0.98);
    const lum = h => {
      const n = parseInt(h.slice(1), 16);
      return { r: n >> 16 & 255, g: n >> 8 & 255, b: n & 255 };
    };
    // Monotonic: no jumping backwards and forwards across the scale.
    const ramp = [];
    for (let v = 0.80; v <= 1.001; v += 0.01) ramp.push(hex(+v.toFixed(2)));
    return { wx, uniqueWx: new Set(wx).size,
             debris, rain, dRGB: lum(debris), rRGB: lum(rain),
             ramp, uniqueRamp: new Set(ramp).size,
             below: fn(-1), noise: fn(0.3), lowEnd: hex(0.2) };
  });
  // The actual complaint, as a number.
  ok('the range where all precipitation lives gets six different colours',
     r.uniqueWx === 6, r.wx.join(' '));
  ok('and 0.80 upward is more than a couple of shades',
     r.uniqueRamp >= 8, `${r.uniqueRamp} colours across 0.80-1.00`);
  // Debris used to be ORANGE while the rain around it was green, which is
  // backwards from every operational display and from the reason CC is on the
  // menu at all.
  ok('debris reads cold and rain reads warm, not the other way round',
     r.dRGB.b > r.dRGB.r && r.rRGB.r > r.rRGB.b,
     `debris ${r.debris}, rain ${r.rain}`);
  ok('so a debris ball cannot be mistaken for the rain around it',
     r.debris !== r.rain);
  ok('a value below the scale draws nothing rather than a colour',
     r.below === null, String(r.below));
  // The floor, and the mistake it corrects. CC below about 0.45 is the
  // speckle a radar returns from clear air. It is not weather and it covers
  // most of a sweep on most days, so drawing it from the bottom of the range
  // upward buried the actual weather under a wash of the lowest band. Every
  // other product here already has this floor: reflectivity starts at 5 dBZ,
  // velocity has a dead zone either side of nought, KDP ignores near-zero.
  ok('the clear-air noise carpet is not painted at all',
     r.noise === null, String(r.noise));
  ok('but real non-meteorological targets above it still are',
     /^#/.test(r.debris), r.debris);
}

console.log('\n13. correlation coefficient is not dragged down by the merge');
{
  // "CC is still wrong" after the colour scale was fixed, and the colour
  // scale was not the whole story: the VALUES were being corrupted before any
  // colour saw them.
  //
  // Far from the radar the renderer thins the sweep - stride is 1 inside
  // 100 km and doubles every 100 km after, so past 300 km eight gates collapse
  // into one. Reflectivity merges by taking the maximum and velocity by the
  // largest magnitude, and for those the extreme IS the signal: a core and a
  // couplet are what a merged cell must not lose.
  //
  // Correlation coefficient was doing the same thing in reverse, taking the
  // MINIMUM. But low CC is mostly noise - one poorly lit gate at low signal to
  // noise reads low - so the minimum hands the whole merged cell to its worst
  // gate. Uniform 0.98 rain past 300 km reported whichever of eight gates
  // happened to be lowest, and the far half of every sweep came out looking
  // like mixed or non-meteorological echo.
  //
  // Nothing is lost by averaging instead: debris balls are observed CLOSE to
  // the radar, and inside 100 km the stride is 1, so no merge is happening
  // there at all. The minimum rule only ever applied where it was not needed.
  const src = readFileSync(join(ROOT, 'src/parse/radar_worker.js'), 'utf8');
  // Both decode paths, Level 2 and Level 3, have to agree.
  const meanSites = (src.match(/ccSum \+= v; ccCount \+= 1;/g) || []).length;
  ok('both decode paths merge CC by a running mean', meanSites === 2,
     `${meanSites} of 2`);
  ok('and neither one still takes the minimum',
     !/(layer === 'CC'|isCorrelation)\)?\s*value = Math\.min/.test(src)
     && !/Math\.min\(value, v\)/.test(src),
     'a Math.min merge is still in the file');
  // The other two must NOT have changed: their extremes are the signal.
  ok('reflectivity still keeps the strongest gate in a merged cell',
     /else value = Math\.max\(value, v\);/.test(src));
  ok('and velocity still keeps the fastest',
     (src.match(/Math\.abs\(v\) > Math\.abs\(value\)/g) || []).length === 2);
  // The bias this removes, stated as arithmetic so the reason is checkable
  // rather than merely described: eight gates of ordinary rain with one noisy
  // one among them.
  const gates = [0.98, 0.99, 0.98, 0.97, 0.99, 0.98, 0.72, 0.98];
  const asMin = Math.min(...gates);
  const asMean = gates.reduce((a, b) => a + b, 0) / gates.length;
  const band = await page.evaluate((g) => {
    const fn = _meshColorFn('cc');
    const mn = Math.min(...g);
    const mean = g.reduce((a, b) => a + b, 0) / g.length;
    return { min: String(fn(mn)), mean: String(fn(mean)) };
  }, gates);
  ok('one noisy gate in eight used to decide the whole cell',
     Math.abs(asMin - 0.72) < 1e-9 && asMean > 0.94,
     `min ${asMin}, mean ${asMean.toFixed(3)}`);
  ok('and it painted that cell a different colour from the rain it is in',
     band.min !== band.mean, `${band.min} vs ${band.mean}`);
}

console.log('\n14. every product covers the range it claims to cover');
{
  // "I do not know about the others". This walks all eight families, asks the
  // colour function for sixty values across the range the family itself
  // declares, and checks the answer is neither one flat colour nor a hole
  // where real data lives.
  const r = await page.evaluate(() => {
    _fxUiResetAll();
    const pick = { ref: 'ref', vel: 'vel', sw: 'sw', cc: 'cc',
                   zdr: 'zdr', kdp: 'kdp', hc: 'n0h', et: 'eet' };
    const out = {};
    Object.keys(RADAR_FAMS).forEach(fam => {
      const d = RADAR_FAMS[fam];
      const fn = _meshColorFn(pick[fam]);
      const cols = [], blank = [];
      for (let i = 0; i <= 60; i++) {
        const v = d.min + (d.max - d.min) * i / 60;
        const c = fn(v);
        if (c) cols.push(String(c)); else blank.push(+v.toFixed(2));
      }
      out[fam] = { distinct: new Set(cols).size, painted: cols.length,
                   blank: blank.length, first: blank[0], last: blank[blank.length - 1] };
    });
    return out;
  });
  // A family that answers with one colour across its whole range is the exact
  // fault reported for CC.
  const flat = Object.entries(r).filter(([, v]) => v.distinct < 5);
  ok('no product paints its whole range in fewer than five colours',
     flat.length === 0, flat.map(([k, v]) => `${k}:${v.distinct}`).join(', '));
  // Reflectivity below 5 dBZ, velocity within 5 kt of zero, KDP near zero and
  // echo tops below 5 kft are deliberately blank: drawing them would fill the
  // map with things that are not weather.
  const mostlyBlank = Object.entries(r).filter(([, v]) => v.painted < 30);
  ok('and none of them is mostly blank across its own range',
     mostlyBlank.length === 0,
     mostlyBlank.map(([k, v]) => `${k}:${v.painted}/61`).join(', '));
  ok('correlation coefficient in particular now has real resolution',
     r.cc.distinct >= 10, `${r.cc.distinct} colours`);
  // Its blank part is the clear-air noise below 0.45, deliberately, and it
  // must not creep upward into the range where weather lives.
  ok('and what it leaves blank is only the noise below 0.45',
     r.cc.last < 0.45, `blank up to ${r.cc.last}`);
}

console.log('\n15. nothing threw along the way');
ok('no uncaught errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
