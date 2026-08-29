#!/usr/bin/env node
/*
 * The ocean layers, the Inspector rows that read them, and the layer-order
 * control, all driven in a real browser with real Leaflet and no network.
 *
 *     node tools/test-sst-overlay.mjs
 *
 * The Pi's SST fields are not pictures: they are measurements encoded two
 * bytes to a pixel, so the tests here decode a PNG this file builds itself
 * and check the numbers that come back, not the colours. That is the whole
 * reason the Inspector can report a real temperature rather than a swatch.
 *
 * The three things worth being careful about, and the reason each is here:
 *
 *   1. An anomaly is a DIFFERENCE. Twenty degrees C is 68 F, but a rise of
 *      twenty C is a rise of 36 F. Convert one like the other and a correct
 *      number becomes a wrong one, which is checked in section 3.
 *   2. The fields are stored 0..360 in longitude and the map hands back
 *      -180..180, so half the world reads as no data if the wrap is missed.
 *      Section 5 puts the cursor in the Pacific on purpose.
 *   3. Layer order is a z-index question, and the overlay band starts at 402.
 *      The four map layers have to stay under it, which section 7 measures
 *      rather than assumes.
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
await page.goto('file://' + join(ROOT, 'index.html'),
                { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);

console.log('\n1. the page boots and the ocean pane sits where it should');
{
  ok('no page errors on boot', errors.length === 0, errors[0]);
  const z = await page.evaluate(() => ({
    sst: +map.getPane('sstPane').style.zIndex,
    sat: +map.getPane('satPhotoPane').style.zIndex,
    radar: +map.getPane('radarPane').style.zIndex,
    alerts: +map.getPane('alertsPane').style.zIndex,
  }));
  // The whole reason anyone puts sea temperature under a radar map is to see
  // the storm over the warm water. Painted the other way round it is a blue
  // rectangle hiding the weather.
  ok('the ocean draws below the satellite', z.sst < z.sat, JSON.stringify(z));
  ok('the ocean draws below the radar', z.sst < z.radar, JSON.stringify(z));
  ok('alerts stay above all three',
     z.alerts > z.radar && z.alerts > z.sat && z.alerts > z.sst, JSON.stringify(z));
}

console.log('\n2. the Waves row opens a source row, not a layer');
{
  const r = await page.evaluate(() => {
    toggleSstSourceSub();
    const rows = [...document.querySelectorAll('#sub-bubbles .sub-bubble')];
    return {
      labels: rows.map(e => e.querySelector('.sb-label')?.textContent || '').join(','),
      info: rows.filter(e => e.id.startsWith('sub-sstsrc-'))
               .map(e => !!e.querySelector('.layer-info-btn, .info-btn, [data-info]')
                       || e.children.length > 2),
    };
  });
  ok('Open-Meteo is offered first, because it needs no Pi',
     /Open-Meteo/.test(r.labels)
     && r.labels.indexOf('Open-Meteo') < r.labels.indexOf('OISST'), r.labels);
  ok('all four sources are there',
     /Open-Meteo/.test(r.labels) && /OISST/.test(r.labels)
     && /Coral Reef Watch/.test(r.labels) && /Ocean Heat/.test(r.labels), r.labels);
  ok('every source bubble carries an info button',
     r.info.length === 4 && r.info.every(Boolean), JSON.stringify(r.info));
}

console.log('\n3. every source and variant has a written description');
{
  const missing = await page.evaluate(() => {
    const gaps = [];
    SST_SOURCE_ROW.forEach(s => {
      if (!LAYER_DESCRIPTIONS['sst-' + s.id]) gaps.push('sst-' + s.id);
    });
    Object.values(SST_VARIANT_ROW).flat().forEach(v => {
      if (!LAYER_DESCRIPTIONS['sst-var-' + v]) gaps.push('sst-var-' + v);
    });
    return gaps;
  });
  ok('nothing in either row is undocumented', missing.length === 0,
     missing.join(','));
  const anomalyText = await page.evaluate(() =>
    LAYER_DESCRIPTIONS['sst-var-anomaly_gmr'] || '');
  ok('the global-mean-removed field explains why it exists',
     /global/i.test(anomalyText) && anomalyText.length > 120, anomalyText.slice(0, 60));
}

console.log('\n4. an anomaly converts as a difference, a temperature does not');
{
  const r = await page.evaluate(() => {
    const before = _units.temp;
    _units.temp = 'F';
    const out = {
      actual: _sstToDisplay(20, 'oisst', 'actual'),
      anomaly: _sstToDisplay(20, 'oisst', 'anomaly'),
      change: _sstToDisplay(2, 'oisst', 'change7d'),
      heat: _sstToDisplay(90, 'aoml', 'tchp'),
      unitA: _sstUnitLabel('oisst', 'anomaly'),
      unitH: _sstUnitLabel('aoml', 'tchp'),
      unitD: _sstUnitLabel('aoml', 'd26'),
    };
    _units.temp = 'C';
    out.celsius = _sstToDisplay(20, 'oisst', 'actual');
    _units.temp = before;
    return out;
  });
  ok('20 C as a temperature is 68 F', Math.abs(r.actual - 68) < 1e-6, String(r.actual));
  ok('20 C as an anomaly is 36 F, not 68', Math.abs(r.anomaly - 36) < 1e-6, String(r.anomaly));
  ok('a 2 C change is a 3.6 F change', Math.abs(r.change - 3.6) < 1e-6, String(r.change));
  ok('ocean heat is left alone, it is not a temperature',
     Math.abs(r.heat - 90) < 1e-6, String(r.heat));
  ok('and in Celsius nothing is converted at all',
     Math.abs(r.celsius - 20) < 1e-6, String(r.celsius));
  ok('the units say what is being shown',
     r.unitA === '°F' && r.unitH === 'kJ/cm²' && r.unitD === 'm',
     [r.unitA, r.unitH, r.unitD].join(' '));
}

console.log('\n5. a frame decodes back to the numbers that went into it');
{
  // Build a PNG the way the Pi does: value split high byte into red, low byte
  // into green, over a stated range, alpha 0 for land. Then read it back
  // through the page's own decoder and check the numbers survive the trip.
  const r = await page.evaluate(async () => {
    const w = 8, h = 4, lo = -8, hi = 8, span = hi - lo;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(w, h);
    // Row 0 all 2.0, row 1 all -3.5, row 2 land, row 3 all 0.
    const rowVal = [2.0, -3.5, null, 0];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4;
        const v = rowVal[y];
        if (v === null) { img.data[p + 3] = 0; continue; }
        const n = Math.round((v - lo) / span * 65535);
        img.data[p] = (n >> 8) & 255;
        img.data[p + 1] = n & 255;
        img.data[p + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const url = cv.toDataURL('image/png');

    // Point the page's loader at that picture rather than at a Pi.
    const realBase = _hdBase;
    _hdBase = 'http://test.invalid';
    _sstIndex = { sources: { oisst: { label: 'OISST', variants: { anomaly: {
      label: 'Anomaly', range: [lo, hi], bounds: [[-90, 0], [90, 360]],
      frames: ['20260828'] } } } } };
    _sstSource = 'oisst'; _sstVariant = 'anomaly';
    const realLoad = window._sndLoadImage;
    window._sndLoadImage = async () => {
      const im = new Image();
      await new Promise(res => { im.onload = res; im.src = url; });
      return im;
    };
    const frame = await _sstLoadFrame('20260828');
    window._sndLoadImage = realLoad;
    _hdBase = realBase;
    if (!frame) return { none: true };
    return {
      w: frame.w, h: frame.h,
      warm: frame.vals[0],
      cold: frame.vals[frame.w],
      land: frame.vals[frame.w * 2],
      zero: frame.vals[frame.w * 3],
    };
  });
  ok('the frame comes back the size it went in', r.w === 8 && r.h === 4,
     JSON.stringify(r));
  ok('a +2.0 anomaly decodes to +2.0', Math.abs(r.warm - 2) < 0.001, String(r.warm));
  ok('a -3.5 anomaly decodes to -3.5', Math.abs(r.cold + 3.5) < 0.001, String(r.cold));
  ok('land comes back as no reading, not as zero', r.land === null || Number.isNaN(r.land),
     String(r.land));
  ok('and a real zero survives as zero, not as land',
     r.zero === 0 || Math.abs(r.zero) < 0.001, String(r.zero));
}

console.log('\n6. the Inspector reads that grid, wrap and all');
{
  const r = await page.evaluate(() => {
    // A 4x2 grid covering the whole world, west 0 east 360, with a different
    // value in every column. Distinct columns are the point: a wrap that
    // merely clamped to the edge would land on a value too, so only a column
    // that nothing else reaches proves the arithmetic actually happened.
    // Columns sit at 0, 120, 240 and 360 degrees east.
    const vals = new Float32Array([1, 2, 3, 4, 1, 2, 3, 4]);
    _sstGrid = { vals, w: 4, h: 2, bounds: [[-90, 0], [90, 360]] };
    _sstSource = 'oisst'; _sstVariant = 'anomaly';
    _sstIndex = { sources: { oisst: { label: 'OISST', variants: {
      anomaly: { label: 'Anomaly' } } } } };
    const before = _units.temp; _units.temp = 'C';
    const east = _inspSstRow({ lat: 0, lng: 120 });     // inside 0..360 already
    const west = _inspSstRow({ lat: 0, lng: -120 });    // 240 E, only via the wrap
    const off = _inspSstRow({ lat: 95, lng: 10 });      // off the top of the world
    _sstVariant = 'anomaly_records';
    _sstGrid = { vals: new Float32Array([99, 99, 99, 99]), w: 2, h: 2,
                 bounds: [[-90, 0], [90, 360]] };
    const rec = _inspSstRow({ lat: 0, lng: 100 });
    _sstVariant = 'anomaly';
    _units.temp = before;
    return { east, west, off, rec };
  });
  ok('120 E reads the column that sits at 120 E',
     r.east.value === '+2.0', JSON.stringify(r.east));
  ok('120 W wraps to 240 E and reads THAT column, not the edge',
     r.west.value === '+3.0', JSON.stringify(r.west));
  ok('a positive anomaly is shown with its sign', /^\+/.test(r.east.value),
     r.east.value);
  ok('a point off the grid says so rather than inventing a number',
     /off grid/.test(r.off.value), JSON.stringify(r.off));
  ok('a record flag reads as a record, not as a 99 degree anomaly',
     /RECORD/i.test(r.rec.value), JSON.stringify(r.rec));
}

console.log('\n7. the layer-order control, and the band it has to stay inside');
{
  const r = await page.evaluate(() => {
    localStorage.removeItem('gwcfc_map_stack_order');
    _stackApply();
    const before = {
      borders: MAP_STACK_TOP_Z, order: _stackOrder().slice(),
    };
    // Put the ocean on top and everything else under it.
    _stackSave(['ocean', 'radar', 'satellite', 'borders']);
    const z = {
      ocean: +map.getPane('sstPane').style.zIndex,
      radar: +map.getPane('radarPane').style.zIndex,
      sat: +map.getPane('satPhotoPane').style.zIndex,
    };
    localStorage.removeItem('gwcfc_map_stack_order');
    _stackApply();
    const back = +map.getPane('sstPane').style.zIndex;
    return { before, z, back };
  });
  ok('the default order puts borders on top', r.before.order[0] === 'borders',
     r.before.order.join(','));
  ok('moving the ocean to the top actually raises its pane',
     r.z.ocean > r.z.radar && r.z.ocean > r.z.sat, JSON.stringify(r.z));
  // 402 is where the overlay list starts. A map layer that climbs into that
  // band would land in the middle of the overlays and cover half of them.
  ok('no map layer reaches the overlay band at 402',
     Math.max(r.z.ocean, r.z.radar, r.z.sat) < 402, JSON.stringify(r.z));
  ok('clearing the saved order puts the ocean back at the bottom',
     r.back === 398, String(r.back));
}

console.log('\n8. a saved order survives, and a stale one is repaired');
{
  const r = await page.evaluate(() => {
    const out = {};
    // A list written by an older version: names a layer that is gone, and is
    // missing one added since.
    localStorage.setItem('gwcfc_map_stack_order',
      JSON.stringify(['radar', 'a-layer-that-no-longer-exists']));
    out.repaired = _stackOrder();
    localStorage.setItem('gwcfc_map_stack_order', 'not json at all');
    out.garbage = _stackOrder();
    localStorage.removeItem('gwcfc_map_stack_order');
    out.clean = _stackOrder();
    return out;
  });
  ok('a name that no longer exists is dropped',
     !r.repaired.includes('a-layer-that-no-longer-exists'), r.repaired.join(','));
  ok('the layers it never heard of are appended, so nothing goes missing',
     r.repaired.length === 4 && r.repaired[0] === 'radar', r.repaired.join(','));
  ok('unreadable storage falls back to the default rather than throwing',
     r.garbage.length === 4, r.garbage.join(','));
  ok('and with nothing saved the default is what you get',
     r.clean.join(',') === 'borders,radar,satellite,ocean', r.clean.join(','));
}

console.log('\n9. both order lists render, and the arrows move rows');
{
  const r = await page.evaluate(() => {
    localStorage.removeItem('gwcfc_map_stack_order');
    _stackRender();
    _ovOrderRender();
    const names = () => [...document.querySelectorAll('#lqm-stack-list .lqm-order-row')]
      .map(e => e.dataset.stackid);
    const first = names();
    // Click the second row's down arrow.
    const row = document.querySelectorAll('#lqm-stack-list .lqm-order-row')[1];
    row.querySelector('[data-move="down"]').click();
    const after = names();
    const ov = [...document.querySelectorAll('#lqm-ovorder-list .lqm-order-row')];
    const ends = {
      topUpOff: document.querySelector('#lqm-stack-list .lqm-order-row [data-move="up"]')
        .classList.contains('off'),
    };
    localStorage.removeItem('gwcfc_map_stack_order');
    _stackApply();
    return { first, after, ovCount: ov.length,
             ovNames: ov.slice(0, 2).map(e => e.dataset.ovid),
             ovLabel: ov[0] ? ov[0].querySelector('.lqm-order-name').textContent : '',
             ends };
  });
  ok('the map-layer list renders all four rows', r.first.length === 4,
     r.first.join(','));
  ok('the down arrow swaps a row with the one below it',
     r.after[1] === r.first[2] && r.after[2] === r.first[1],
     r.first.join(',') + ' -> ' + r.after.join(','));
  ok('the top row cannot be moved up', r.ends.topUpOff, String(r.ends.topUpOff));
  ok('the overlay list mirrors the real fly-out rows', r.ovCount > 15,
     String(r.ovCount));
  ok('and it mirrors them in order, with their names',
     r.ovNames[0] === 'alerts' && /Alert Polygons/.test(r.ovLabel),
     r.ovNames.join(',') + ' / ' + r.ovLabel);
}

console.log('\n10. reordering in Settings moves the real overlay rows');
{
  const r = await page.evaluate(() => {
    _ovOrderRender();
    const realOrder = () => [...document.querySelectorAll('#overlay-pills-row .ov-pill')]
      .map(e => e.dataset.ovid);
    const before = realOrder();
    const rows = document.querySelectorAll('#lqm-ovorder-list .lqm-order-row');
    rows[0].querySelector('[data-move="down"]').click();
    const after = realOrder();
    const paneA = map.getPane('ovp-' + after[0]);
    const paneB = map.getPane('ovp-' + after[1]);
    const out = { before: before.slice(0, 3), after: after.slice(0, 3),
                  za: paneA ? +paneA.style.zIndex : null,
                  zb: paneB ? +paneB.style.zIndex : null };
    // Put it back so later suites and the user's own saved order are not
    // left holding this test's shuffle.
    rows[0].querySelector('[data-move="up"]');
    const back = document.querySelectorAll('#lqm-ovorder-list .lqm-order-row');
    back[0].querySelector('[data-move="down"]').click();
    localStorage.removeItem('gwcfc_overlay_order');
    return out;
  });
  ok('the fly-out list really moved, not just the copy in Settings',
     r.after[0] === r.before[1] && r.after[1] === r.before[0],
     r.before.join(',') + ' -> ' + r.after.join(','));
  ok('and the map panes follow, top of the list drawing on top',
     r.za === null || r.zb === null || r.za > r.zb, `${r.za} vs ${r.zb}`);
}

console.log('\n11. the Inspector rows for the layers it used to walk past');
{
  const r = await page.evaluate(() => {
    const out = {};
    // Lightning: the parser hands back { refreshSecs, features }, and the
    // row has to read features rather than a key that does not exist.
    _ltgData = { refreshSecs: 60, features: [
      { lat: 35.0, lon: -97.0, ts: Date.now() - 5 * 60000, label: 'x' },
      { lat: 40.0, lon: -80.0, ts: Date.now(), label: 'y' },
    ] };
    const before = _units.dist; _units.dist = 'mi';
    out.ltg = _inspLightningRow({ lat: 35.05, lng: -97.0 });
    _units.dist = before;
    _ltgData = null;
    out.ltgNone = _inspLightningRow({ lat: 35, lng: -97 });

    // The GWCFC outlook draws plain polygons, so the risk name has to ride
    // on the polygon itself for the Inspector to find it.
    const poly = L.polygon([[34, -98], [34, -96], [36, -96], [36, -98]]);
    poly._gwoLabel = 'Enhanced'; poly._gwoColor = '#e8b800';
    _gwcfcLayers = [poly];
    out.inside = _inspGwcfcRow({ lat: 35, lng: -97 });
    out.outside = _inspGwcfcRow({ lat: 20, lng: -60 });
    _gwcfcLayers = [];
    return out;
  });
  ok('the nearest strike is found and measured',
     r.ltg.label === 'Nearest strike' && Math.abs(+r.ltg.value - 3) <= 1,
     JSON.stringify(r.ltg));
  ok('and it says how long ago, because a strike an hour old is not weather',
     /min ago|just now/.test(r.ltg.unit), r.ltg.unit);
  ok('with nothing loaded it says so rather than reporting a distance',
     /none/.test(r.ltgNone.value), JSON.stringify(r.ltgNone));
  ok('an outlook covering the point is named',
     r.inside.value === 'Enhanced', JSON.stringify(r.inside));
  ok('and a point outside every area says none here',
     /none here/.test(r.outside.value), JSON.stringify(r.outside));
}

console.log('\n12. MRMS reads a real number back out of the colour');
{
  const r = await page.evaluate(() => {
    // The Pi paints MRMS by looking a value up in a 256-step ramp. Take a
    // known step of the reflectivity ramp, hand the Inspector that colour,
    // and the value that comes back has to be the one that produced it.
    const scale = { ramp: 'radar', lo: -10, hi: 75 };
    const lut = _hdInspLut('radar');
    const step = 128;
    const c = lut[step];
    const wanted = scale.lo + (step / 255) * (scale.hi - scale.lo);
    const hit = _hdColorToValue(scale, c[0], c[1], c[2]);
    _mrmsOn = { ref: true };
    _mrmsManifest = { products: { ref: { label: 'Composite Reflectivity',
      unit: 'dBZ', min: -10, max: 75, ramp: 'radar' } } };
    // A stand-in for the overlay: the row only ever asks for one pixel.
    _mrmsOv = { ref: { _image: null } };
    const noImg = _inspMrmsRows(0, 0);
    // An older Pi that never wrote a ramp name has to degrade, not break.
    _mrmsManifest.products.ref.ramp = undefined;
    const legacy = _inspMrmsRow('ref', 0, 0);
    _mrmsOn = {}; _mrmsOv = {}; _mrmsManifest = null;
    return { wanted, hit, noImg: noImg.length, legacy };
  });
  ok('a colour off the ramp inverts back to its own value',
     r.hit && Math.abs(r.hit.value - r.wanted) < 0.5,
     JSON.stringify(r.hit) + ' wanted ' + r.wanted);
  ok('the step index comes back too, so the ends can be marked as clamps',
     r.hit && r.hit.idx === 128, JSON.stringify(r.hit));
  ok('one row per active MRMS product', r.noImg === 1, String(r.noImg));
  ok('and with no picture on screen it says so rather than guessing',
     /off screen|no data/.test(r.legacy.value), JSON.stringify(r.legacy));
}

console.log('\n13. the ocean colours in Settings recolour without refetching');
{
  const r = await page.evaluate(() => {
    const out = {};
    localStorage.removeItem('gwcfc_sst_ramp_anomaly');
    out.stock = JSON.stringify(_sstActiveRamp('oisst', 'anomaly'));
    _sstRampWrite('anomaly', [[-8, [0, 0, 0]], [8, [255, 255, 255]]]);
    out.custom = JSON.stringify(_sstActiveRamp('oisst', 'anomaly'));
    out.sharesWithChange = JSON.stringify(_sstActiveRamp('oisst', 'change7d'));
    out.notActual = JSON.stringify(_sstActiveRamp('oisst', 'actual'));
    localStorage.removeItem('gwcfc_sst_ramp_anomaly');
    out.reset = JSON.stringify(_sstActiveRamp('oisst', 'anomaly'));
    // Junk in storage must not take the layer down with it.
    localStorage.setItem('gwcfc_sst_ramp_anomaly', '{{{');
    out.garbage = JSON.stringify(_sstActiveRamp('oisst', 'anomaly'));
    localStorage.removeItem('gwcfc_sst_ramp_anomaly');
    return out;
  });
  ok('an edited scale is what the layer uses',
     r.custom === '[[-8,[0,0,0]],[8,[255,255,255]]]', r.custom);
  ok('anomaly and change share one scale, because the sign means the same',
     r.sharesWithChange === r.custom, r.sharesWithChange);
  ok('the actual-temperature scale is left alone', r.notActual !== r.custom,
     r.notActual);
  ok('resetting gives the published scale back', r.reset === r.stock, r.reset);
  ok('unreadable storage falls back rather than throwing',
     r.garbage === r.stock, r.garbage);
}

console.log('\n14. with no Pi, it says what still works instead of nothing');
{
  const r = await page.evaluate(async () => {
    const toasts = [];
    const real = window.showToast;
    window.showToast = (m) => toasts.push(m);
    _sstIndex = null;
    _sstReportMissing('nopi');
    _sstIndex = { sources: { oisst: { label: 'OISST', variants: {} } } };
    _sstSource = 'oisst'; _sstVariant = 'anomaly';
    _sstReportMissing('nobuild');
    window.showToast = real;
    return toasts;
  });
  ok('a missing Pi is named as the problem', /Pi/.test(r[0]), r[0]);
  ok('and Open-Meteo is offered, because it needs no Pi',
     /Open-Meteo/.test(r[0]), r[0]);
  ok('a source that has not built the field yet says which one',
     /OISST/.test(r[1]) && /anomaly/.test(r[1]), r[1]);
  ok('and explains that it builds on a schedule rather than on demand',
     /builds/.test(r[1]), r[1]);
}

console.log('\n15. turning the layer off lets go of its memory');
{
  const r = await page.evaluate(() => {
    // Blob URLs pin their bytes for the life of the tab unless revoked, so a
    // layer that forgets to free them leaks a megabyte per frame shown.
    const freed = [];
    const realFree = window._pbFree;
    window._pbFree = (u) => { freed.push(u); realFree(u); };
    _sstBlobs.set('a', 'blob:fake-a');
    _sstBlobs.set('b', 'blob:fake-b');
    _sstFrames = ['a', 'b'];
    _sstOn = true;
    _sstDisable();
    window._pbFree = realFree;
    return { freed, left: _sstBlobs.size, on: _sstOn,
             frames: _sstFrames.length, grid: _sstGrid };
  });
  ok('every frame it was holding is released', r.freed.length === 2,
     r.freed.join(','));
  ok('and nothing is left in the map of them', r.left === 0, String(r.left));
  ok('the layer really is off', r.on === false, String(r.on));
  ok('and the Inspector has no stale grid to report from',
     r.grid === null, JSON.stringify(r.grid));
}

console.log('\n16. still no page errors after all of that');
ok('the whole run stayed clean', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
