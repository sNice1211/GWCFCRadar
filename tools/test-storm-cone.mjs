#!/usr/bin/env node
/*
 * The Storm Cone tool's two drawing modes, driven the way a finger drives
 * them, in a real browser with real Leaflet and no network.
 *
 *     node tools/test-storm-cone.mjs
 *
 * Drag mode is the original gesture and must keep every power it had:
 * CURVE, DOTS, OFFSET, per-dot curve. Multi-point mode is the new grammar:
 * click point after point, the path runs smoothly THROUGH every click, each
 * click becomes a dot, and curve is not an input there at all - only OFFSET
 * bends anything. Both finishing gestures (double-click and the Finish
 * button), the Undo Point button, and the mode round-trip through the cone
 * list are all exercised here.
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

// Fire map gestures the way Leaflet delivers them.
const click = (lat, lng) => page.evaluate(([lat, lng]) =>
  map.fire('click', { latlng: L.latLng(lat, lng),
    originalEvent: { preventDefault() {}, stopPropagation() {} } }), [lat, lng]);
const move = (lat, lng) => page.evaluate(([lat, lng]) =>
  map.fire('mousemove', { latlng: L.latLng(lat, lng) }), [lat, lng]);
const dbl = (lat, lng) => page.evaluate(([lat, lng]) =>
  map.fire('dblclick', { latlng: L.latLng(lat, lng),
    originalEvent: { preventDefault() {}, stopPropagation() {} } }), [lat, lng]);

console.log('\n1. the toolbar knows its two grammars');
{
  ok('the page boots clean', errors.length === 0, errors[0]);
  const ui = await page.evaluate(() => {
    toggleStormConeTool();
    const sel = document.getElementById('sc-mode-sel');
    return {
      opts: sel ? [...sel.options].map(o => o.value).join(',') : 'missing',
      mode: _scMode,
      curveOn: !document.getElementById('sc-curve-input').disabled,
      dotsOn: !document.getElementById('sc-dots-input').disabled,
      finishHidden: document.getElementById('sc-finish-btn').style.display === 'none',
      dblZoomOff: !map.doubleClickZoom.enabled(),
    };
  });
  ok('the MODE dropdown offers drag and multi-point',
     ui.opts === 'drag,multi', ui.opts);
  ok('drag mode starts with CURVE and DOTS live',
     ui.mode === 'drag' && ui.curveOn && ui.dotsOn, JSON.stringify(ui));
  ok('the multi-only buttons stay hidden in drag mode', ui.finishHidden,
     String(ui.finishHidden));
  ok('double-click zoom is parked while the tool is active', ui.dblZoomOff,
     String(ui.dblZoomOff));
}

console.log('\n2. drag mode still does everything it did');
{
  await click(35.0, -97.5);
  await move(35.8, -96.2);
  await click(36.2, -95.5);
  const t = await page.evaluate(() => ({
    mode: _scTrack && _scTrack.mode,
    miles: _scTrack && +_scTrack.distanceMiles.toFixed(0),
    onMap: !!(_scPolygon && map.hasLayer(_scPolygon)),
  }));
  ok('click, aim, click draws a drag cone', t.mode === 'drag' && t.onMap,
     JSON.stringify(t));
  ok('with a believable length', t.miles > 100 && t.miles < 300, String(t.miles));
  const bent = await page.evaluate(() => {
    const before = _scTrack.center[14];
    document.getElementById('sc-curve-input').value = 8;
    _scOnCurveChange();
    const after = _scTrack.center[14];
    document.getElementById('sc-curve-input').value = 0;
    _scOnCurveChange();
    return map.distance(before, after);
  });
  ok('CURVE bends a drag cone', bent > 5000, String(Math.round(bent)));
}

console.log('\n3. multi-point mode: click, click, click, Finish');
{
  const sw = await page.evaluate(() => {
    _scNew();                 // commit the drag cone, start fresh
    _scSetMode('multi');
    return {
      curveOff: document.getElementById('sc-curve-input').disabled,
      dotsOff: document.getElementById('sc-dots-input').disabled,
      finishShown: document.getElementById('sc-finish-btn').style.display !== 'none',
      undoShown: document.getElementById('sc-undo-btn').style.display !== 'none',
      saved: localStorage.getItem('gwcfc_sc_mode'),
    };
  });
  ok('multi mode switches CURVE and DOTS off and shows Finish and Undo',
     sw.curveOff && sw.dotsOff && sw.finishShown && sw.undoShown,
     JSON.stringify(sw));
  ok('the choice is remembered', sw.saved === 'multi', sw.saved);

  await click(30.0, -90.0);
  await click(31.0, -89.0);
  await click(32.5, -88.8);
  await click(34.0, -89.5);
  const t = await page.evaluate(() => {
    _scMultiFinish();
    return {
      mode: _scTrack && _scTrack.mode,
      src: _scTrack && _scTrack.srcPoints.length,
      dots: _scDotIndices.length,
      onMap: !!(_scPolygon && map.hasLayer(_scPolygon)),
      // The smoothed path must pass THROUGH the clicked points: each click's
      // dot sits on the center line at that click.
      maxMiss: Math.max(..._scTrack.srcPoints.map((p, k) =>
        map.distance(p, _scTrack.center[_scTrack.dotIdx[k]]))),
    };
  });
  ok('Finish builds a multi cone from the four clicks',
     t.mode === 'multi' && t.src === 4 && t.onMap, JSON.stringify(t));
  ok('every clicked point became a dot', t.dots === 4, String(t.dots));
  ok('and the smooth path runs through the clicks (worst miss under 8 km)',
     t.maxMiss < 8000, String(Math.round(t.maxMiss)));
}

console.log('\n4. curve is not an input on a multi cone; offset is');
{
  const r = await page.evaluate(() => {
    const before = _scTrack.center.map(p => [p.lat, p.lng]);
    document.getElementById('sc-curve-input').value = 10;
    _scOnCurveChange();
    _scSetPointCurve(_scTrack.dotIdx[1], 10);
    const afterCurve = _scTrack.center.map(p => [p.lat, p.lng]);
    document.getElementById('sc-curve-input').value = 0;
    const sameCurve = JSON.stringify(before) === JSON.stringify(afterCurve);

    document.getElementById('sc-offset-input').value = 50;
    _scOnOffsetChange();
    const mid = Math.floor(_scTrack.center.length / 2);
    const offsetMoved = map.distance(_scTrack.center[mid], _scTrack.centerLine[mid]);
    document.getElementById('sc-offset-input').value = 0;
    _scOnOffsetChange();

    _scOpenPointsPanel();
    const panel = document.getElementById('sc-points-list').innerHTML;
    _scClosePointsPanel();
    return { sameCurve, offsetMoved,
             hasCurveInput: /sc-point-input/.test(panel),
             hasCats: /sc-cat-grid/.test(panel),
             hasSpeed: /sc-point-speed/.test(panel) };
  });
  ok('the CURVE input and per-dot curve do nothing to a multi cone',
     r.sameCurve, String(r.sameCurve));
  ok('OFFSET still shifts the storm-center line', r.offsetMoved > 1000,
     String(Math.round(r.offsetMoved)));
  ok('the Points panel hides curve but keeps icons and speed for multi',
     !r.hasCurveInput && r.hasCats && r.hasSpeed, JSON.stringify(r));
}

console.log('\n5. Undo Point and the double-click finish');
{
  await page.evaluate(() => _scNew());
  await click(40.0, -100.0);
  await click(40.5, -99.0);
  await click(41.0, -98.0);
  const undo = await page.evaluate(() => {
    _scMultiUndo();
    return _scMultiPts.length;
  });
  ok('Undo Point removes the most recent click', undo === 2, String(undo));

  // A real double-click delivers click, click, dblclick: the duplicated
  // final point must come back off before the cone builds.
  await click(41.5, -97.0);
  await click(41.5, -97.0);
  await dbl(41.5, -97.0);
  const t = await page.evaluate(() => ({
    mode: _scTrack && _scTrack.mode,
    src: _scTrack && _scTrack.srcPoints.length,
    placing: _scMultiPts.length,
  }));
  ok('double-click finishes the cone and drops the doubled point',
     t.mode === 'multi' && t.src === 3 && t.placing === 0, JSON.stringify(t));
}

console.log('\n6. the cone list round-trips the mode');
{
  const r = await page.evaluate(() => {
    _scNew();                       // commit the multi cone
    _scSetMode('drag');
    const multiId = _scCones[_scCones.length - 1].id;
    return { multiId, modeNow: _scMode };
  });
  ok('back in drag mode for a new cone', r.modeNow === 'drag', r.modeNow);
  const back = await page.evaluate((id) => {
    _scSelectCone(id);
    return {
      mode: _scMode,
      sel: document.getElementById('sc-mode-sel').value,
      curveOff: document.getElementById('sc-curve-input').disabled,
      dots: _scDotIndices.length,
    };
  }, r.multiId);
  ok('selecting the multi cone flips the toolbar to multi rules',
     back.mode === 'multi' && back.sel === 'multi' && back.curveOff,
     JSON.stringify(back));
  ok('and its click-dots come back with it', back.dots === 3, String(back.dots));
}

console.log('\n7. leaving the tool cleans up');
{
  const r = await page.evaluate(() => {
    deactivateTool();
    return { zoomBack: map.doubleClickZoom.enabled(), placing: _scMultiPts.length };
  });
  ok('double-click zoom comes back', r.zoomBack, String(r.zoomBack));
  ok('no half-placed points linger', r.placing === 0, String(r.placing));
}

console.log('\n8. nothing threw along the way');
ok('no uncaught errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
