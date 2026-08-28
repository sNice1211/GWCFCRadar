#!/usr/bin/env node
/*
 * Shapes in the draw tool, and a colour for the polygon tool.
 *
 *     npm i playwright && node tools/test-draw-shapes.mjs
 *
 * SHAPES. Freehand answers "draw roughly here". A shape answers "draw exactly
 * this", which is what a box round a county or a circle round a storm needs,
 * and no amount of care with a finger gets you a straight line.
 *
 * The geometry is worked out in screen pixels and converted back, not computed
 * in degrees, and that is the part worth testing rather than trusting. A
 * degree of longitude is a fraction of a degree of latitude in width once you
 * are away from the equator, so a circle built in degrees comes out as a
 * visible egg over Michigan. These checks read the returned points back and
 * measure them: is the circle round, is the rectangle closed, does the star
 * have ten points and two radii.
 *
 * POLYGON COLOUR. It was #ffcc00 in four places and nowhere else, so two
 * polygons meaning different things looked identical, and one over a
 * gold-and-orange storm core was invisible. The checks below drive the picker
 * and read the style off the layers, including a finished polygon: a colour
 * that only applied to the NEXT polygon would read as the picker not working.
 */

import { readdirSync, existsSync } from 'fs';
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

// A map whose pixel-to-coordinate conversion is a plain linear scale, so a
// shape built in pixels comes back as coordinates this test can measure. The
// scale is deliberately ANISOTROPIC, 1 unit of latitude per 100 px against 2
// of longitude, which is the whole point: it stands in for the real squashing
// that makes a degrees-based circle an egg. A shape built in pixels must come
// back round in pixels, not in degrees.
const LEAFLET_STUB = `(() => {
  const SX = 200, SY = 100;   // px per degree, deliberately different
  const toLL = (p) => {
    const x = Array.isArray(p) ? p[0] : p.x, y = Array.isArray(p) ? p[1] : p.y;
    return { lat: 40 - y / SY, lng: -90 + x / SX };
  };
  const toPt = (ll) => {
    const lat = Array.isArray(ll) ? ll[0] : ll.lat;
    const lng = Array.isArray(ll) ? ll[1] : (ll.lng != null ? ll.lng : ll.lon);
    return { x: (lng + 90) * SX, y: (40 - lat) * SY };
  };
  const poly = (ll, o) => ({ __ll: ll, __o: o || {},
    setLatLngs(v) { this.__ll = v; return this; },
    getLatLngs() { return this.__ll; },
    setStyle(s) { this.__o = { ...this.__o, ...s }; return this; },
    addTo() { return this; }, on() { return this; }, remove() { return this; },
    bindTooltip() { return this; }, getBounds() { return {
      getCenter: () => ({ lat: 35, lng: -88 }) }; } });
  const mk = (ll, o) => ({ __ll: ll, __o: o || {},
    setLatLng(v) { this.__ll = v; return this; },
    getLatLng() { return this.__ll; },
    setStyle(s) { this.__o = { ...this.__o, ...s }; return this; },
    getElement() { return document.createElement('div'); },
    addTo() { return this; }, on() { return this; }, remove() { return this; },
    bindTooltip() { return this; } });
  const fm = {
    getZoom: () => 7, setZoom() {}, setZoomAround() {}, _limitZoom: z => z,
    getContainer: () => document.getElementById('map') || document.body,
    mouseEventToContainerPoint: e => ({ x: e.clientX, y: e.clientY }),
    latLngToContainerPoint: toPt, containerPointToLatLng: toLL,
    scrollWheelZoom: { disable() {}, enable() {} },
    getCenter: () => ({ lat: 35, lng: -88 }),
    hasLayer: () => false, addLayer() { return this; }, removeLayer() { return this; },
    getPane: () => document.createElement('div'),
    createPane: () => document.createElement('div'),
    on() { return this; }, off() { return this; }, once() { return this; },
    fire() { return this; }, invalidateSize() { return this; },
    flyTo() { return this; }, panTo() { return this; }, setView() { return this; },
    getSize: () => ({ x: 800, y: 600 }),
    getBounds: () => ({ getWest: () => -100, getEast: () => -80, getNorth: () => 45,
      getSouth: () => 25, contains: () => true, pad() { return this; } }),
    dragging: { enable() {}, disable() {} }, touchZoom: { enable() {}, disable() {} },
    doubleClickZoom: { enable() {}, disable() {}, enabled: () => true },
    attributionControl: { setPrefix() {}, getContainer: () => document.createElement('div') },
  };
  function Polygon() {} function CircleMarker() {} function Circle() {}
  const ch = () => new Proxy(function(){}, { get: (t, k) => {
    if (k === 'map') return () => fm;
    if (k === 'polyline') return poly;
    if (k === 'polygon') return (ll, o) => Object.assign(
      Object.create(Polygon.prototype), poly(ll, o));
    if (k === 'circleMarker') return (ll, o) => Object.assign(
      Object.create(CircleMarker.prototype), mk(ll, o));
    if (k === 'marker') return mk;
    if (k === 'Polygon') return Polygon;
    if (k === 'CircleMarker') return CircleMarker;
    if (k === 'Circle') return Circle;
    if (k === 'divIcon') return o => o;
    if (k === 'DomEvent') return { stopPropagation() {}, preventDefault() {} };
    if (k === 'imageOverlay') return () => ({ addTo() { return this; }, on() { return this; } });
    if (k === 'then') return undefined;
    return ch();
  }, apply: () => ch(), construct: () => ch() });
  Object.defineProperty(window, 'L', { value: ch(), writable: true, configurable: true });
  window.__toPt = toPt;
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

console.log('\n1. the draw tool offers shapes');
ok('no uncaught errors while starting', errors.length === 0, errors[0]);
{
  const r = await page.evaluate(() => {
    const sel = document.getElementById('dtb-shape');
    return {
      exists: !!sel,
      inBar: !!document.querySelector('#draw-toolbar #dtb-shape'),
      values: sel ? [...sel.options].map(o => o.value) : [],
      first: sel ? sel.options[0].value : null,
      setter: typeof _dtbSetShape === 'function',
      geom: typeof _dtbShapePoints === 'function',
    };
  });
  ok('there is a shape picker in the draw toolbar', r.exists && r.inBar);
  ok('freehand is still the default', r.first === 'free', r.first);
  ok('and it offers a real set of shapes',
     ['line','arrow','rect','circle','ellipse','triangle','diamond','star']
       .every(v => r.values.includes(v)), r.values.join(','));
  ok('with a setter and a geometry function', r.setter && r.geom);
}

console.log('\n2. the shapes are the shapes they say they are');
{
  const r = await page.evaluate(() => {
    const a = { x: 100, y: 100 }, b = { x: 300, y: 200 };
    const P = (s) => _dtbShapePoints(a, b, s);
    const closed = (p) => p.length > 2
      && p[0].x === p[p.length - 1].x && p[0].y === p[p.length - 1].y;
    const circ = P('circle');
    const r0 = Math.hypot(b.x - a.x, b.y - a.y);
    const radii = circ.slice(0, -1).map(p => Math.hypot(p.x - a.x, p.y - a.y));
    const ell = P('ellipse');
    const star = P('star');
    const starR = star.slice(0, -1).map(p =>
      Math.hypot(p.x - 200, p.y - 150));
    return {
      line: P('line').length,
      rectN: P('rect').length, rectClosed: closed(P('rect')),
      triN: P('triangle').length, triClosed: closed(P('triangle')),
      diaN: P('diamond').length, diaClosed: closed(P('diamond')),
      arrowN: P('arrow').length,
      circClosed: closed(circ),
      circSpread: Math.max(...radii) - Math.min(...radii),
      circWanted: r0,
      ellClosed: closed(ell),
      ellW: Math.max(...ell.map(p => p.x)) - Math.min(...ell.map(p => p.x)),
      ellH: Math.max(...ell.map(p => p.y)) - Math.min(...ell.map(p => p.y)),
      starN: star.length,
      starOuter: Math.max(...starR), starInner: Math.min(...starR),
    };
  });
  ok('a line is two points', r.line === 2, r.line);
  ok('a rectangle is four corners, closed', r.rectN === 5 && r.rectClosed, r.rectN);
  ok('a triangle is three, closed', r.triN === 4 && r.triClosed, r.triN);
  ok('a diamond is four, closed', r.diaN === 5 && r.diaClosed, r.diaN);
  // The arrow doubles back so the head is part of the same stroke and undoes
  // in one press rather than leaving a floating chevron behind.
  ok('an arrow is one stroke that doubles back for its head',
     r.arrowN === 5, r.arrowN);
  ok('a circle closes', r.circClosed);
  // The measurement that matters: every point the same distance from centre.
  ok(`a circle is round, spread ${r.circSpread.toFixed(4)} px`,
     r.circSpread < 0.001, r.circSpread);
  ok('and its radius is the drag distance',
     Math.abs(r.circWanted - 223.6) < 0.5, r.circWanted.toFixed(1));
  ok('an ellipse fills the dragged box',
     Math.abs(r.ellW - 200) < 0.5 && Math.abs(r.ellH - 100) < 0.5,
     r.ellW.toFixed(1) + ' x ' + r.ellH.toFixed(1));
  ok('a star has ten points and two radii',
     r.starN === 11 && r.starOuter > r.starInner * 2,
     r.starN + ', ' + r.starOuter.toFixed(0) + '/' + r.starInner.toFixed(0));
}

console.log('\n3. built in pixels, not in degrees');
{
  const r = await page.evaluate(() => {
    // The stub scales longitude twice as hard as latitude. A circle computed
    // in degrees would come back with equal spans in DEGREES and therefore an
    // egg on screen. Built in pixels it is the other way round, which is what
    // a person actually sees.
    const a = { lat: 35, lng: -88 };
    const b = map.containerPointToLatLng([
      map.latLngToContainerPoint(a).x + 200,
      map.latLngToContainerPoint(a).y]);
    const lls = _dtbShapeLatLngs(a, b, 'circle');
    const pts = lls.map(ll => map.latLngToContainerPoint(ll));
    const cx = map.latLngToContainerPoint(a);
    const radii = pts.slice(0, -1).map(p => Math.hypot(p.x - cx.x, p.y - cx.y));
    const degLat = Math.max(...lls.map(p => p.lat)) - Math.min(...lls.map(p => p.lat));
    const degLng = Math.max(...lls.map(p => p.lng)) - Math.min(...lls.map(p => p.lng));
    return { spread: Math.max(...radii) - Math.min(...radii),
             degLat, degLng };
  });
  ok(`round on screen to ${r.spread.toFixed(4)} px`, r.spread < 0.001, r.spread);
  // Proof it was not computed in degrees: the degree spans differ, by exactly
  // the scale difference the stub imposes.
  ok('and deliberately NOT equal in degrees, which is the point',
     Math.abs(r.degLat / r.degLng - 2) < 0.01,
     r.degLat.toFixed(4) + ' lat vs ' + r.degLng.toFixed(4) + ' lng');
}

console.log('\n4. dragging a shape replaces the outline rather than trailing');
{
  const r = await page.evaluate(() => {
    activeTool = 'draw';
    _dtbMode = 'pencil';
    _allToolLayers.length = 0;
    _dtbSetShape('rect');
    const at = (x, y) => ({ latlng: map.containerPointToLatLng([x, y]) });
    _onDrawDown(at(100, 100));
    const afterDown = _drawStroke.getLatLngs().length;
    _onDrawMove(at(200, 150));
    const mid = _drawStroke.getLatLngs().length;
    _onDrawMove(at(300, 200));
    const end = _drawStroke.getLatLngs().slice();
    const layers = _allToolLayers.length;
    _onDrawUp();
    const anchorCleared = _drawAnchor === null;
    const pts = end.map(ll => map.latLngToContainerPoint(ll));
    const w = Math.max(...pts.map(p => p.x)) - Math.min(...pts.map(p => p.x));
    const h = Math.max(...pts.map(p => p.y)) - Math.min(...pts.map(p => p.y));
    return { afterDown, mid, count: end.length, layers, anchorCleared, w, h };
  });
  ok('the stroke starts as one point', r.afterDown === 1, r.afterDown);
  // A freehand stroke would be 2 then 3 points. A shape is redrawn whole.
  ok('and becomes the whole rectangle on the first move', r.mid === 5, r.mid);
  ok('still five after the second move, not nine', r.count === 5, r.count);
  ok('it follows the pointer, so the box is the dragged box',
     Math.abs(r.w - 200) < 0.5 && Math.abs(r.h - 100) < 0.5,
     r.w.toFixed(1) + ' x ' + r.h.toFixed(1));
  // One layer, so one press of undo removes the whole shape.
  ok('one layer, so undo takes the shape off in one press', r.layers === 1, r.layers);
  ok('and the anchor is released on mouse up', r.anchorCleared);
}

console.log('\n5. freehand is untouched');
{
  const r = await page.evaluate(() => {
    activeTool = 'draw';
    _allToolLayers.length = 0;
    _dtbSetShape('free');
    const at = (x, y) => ({ latlng: map.containerPointToLatLng([x, y]) });
    _onDrawDown(at(100, 100));
    _onDrawMove(at(120, 110));
    _onDrawMove(at(140, 130));
    _onDrawMove(at(160, 160));
    const n = _drawStroke.getLatLngs().length;
    const anchor = _drawAnchor;
    _onDrawUp();
    return { n, anchor };
  });
  // The trail still accumulates, which is the whole difference between a
  // freehand stroke and a shape.
  ok('a freehand stroke still collects every point', r.n === 4, r.n);
  ok('and never takes an anchor', r.anchor === null);
}

console.log('\n6. the polygon tool has a colour');
{
  const r = await page.evaluate(() => ({
    swatch: !!document.querySelector('#poly-toolbar #ptb-color-swatch'),
    palette: !!document.querySelector('#poly-toolbar #ptb-palette'),
    native: !!document.querySelector('#poly-toolbar #ptb-native-color'),
    pick: typeof _polyPickColor === 'function',
    style: typeof _polyFillStyle === 'function',
    dflt: _polyColor,
  }));
  ok('there is a swatch in the polygon toolbar', r.swatch);
  ok('with a palette and a custom picker', r.palette && r.native);
  ok('and the functions behind them', r.pick && r.style);
  ok('gold is still the default', r.dflt === '#ffcc00', r.dflt);
}

console.log('\n7. the palette fills itself, once');
{
  const r = await page.evaluate(() => {
    _polyInitPalette();
    const n1 = document.querySelectorAll('#ptb-palette .dtb-pal-swatch').length;
    _polyInitPalette();
    const n2 = document.querySelectorAll('#ptb-palette .dtb-pal-swatch').length;
    return { n1, n2, colors: DTB_COLORS.length };
  });
  ok('every colour plus the custom entry',
     r.n1 === r.colors + 1, r.n1 + ' of ' + (r.colors + 1));
  ok('and building it twice does not double it', r.n2 === r.n1, r.n2);
}

console.log('\n8. picking a colour recolours what is already drawn');
{
  const r = await page.evaluate(() => {
    _allToolLayers.length = 0;
    _polyPts = []; _polyMarkers = []; _polyFinal = null; _polyPreview = null;
    _polyPickColor('#ffcc00');
    activeTool = 'polygon';
    const at = (x, y) => ({ latlng: map.containerPointToLatLng([x, y]) });
    _onPolyClick(at(100, 100));
    _onPolyClick(at(300, 100));
    _onPolyClick(at(300, 250));
    const before = {
      poly: _polyFinal.__o.color,
      fill: _polyFinal.__o.fillColor,
      dot: _polyMarkers[0].__o.color,
    };
    _polyPickColor('#4488ff');
    const after = {
      poly: _polyFinal.__o.color,
      fill: _polyFinal.__o.fillColor,
      dot: _polyMarkers[0].__o.color,
      saved: localStorage.getItem('gwcfc_poly_color'),
      swatch: document.getElementById('ptb-color-swatch').style.background,
    };
    return { before, after };
  });
  ok('it starts gold', r.before.poly === '#ffcc00', r.before.poly);
  // The one that matters. A colour that only applied to the NEXT polygon
  // would read as the picker doing nothing, because the polygon you are
  // looking at is the one you were trying to change.
  ok('the polygon on screen turns blue', r.after.poly === '#4488ff', r.after.poly);
  ok('its fill turns with it', r.after.fill === '#4488ff', r.after.fill);
  ok('and so do the vertex dots', r.after.dot === '#4488ff', r.after.dot);
  ok('the swatch shows the choice', /68, 136, 255|#4488ff/.test(r.after.swatch),
     r.after.swatch);
  ok('and it is remembered for next time',
     r.after.saved === '#4488ff', r.after.saved);
}

console.log('\n9. a new polygon is drawn in the chosen colour');
{
  const r = await page.evaluate(() => {
    _allToolLayers.length = 0;
    _polyPts = []; _polyMarkers = []; _polyFinal = null;
    activeTool = 'polygon';
    const at = (x, y) => ({ latlng: map.containerPointToLatLng([x, y]) });
    _onPolyClick(at(400, 400));
    _onPolyClick(at(500, 400));
    _onPolyClick(at(500, 500));
    return { poly: _polyFinal.__o.color, dot: _polyMarkers[0].__o.color };
  });
  ok('the shape uses it', r.poly === '#4488ff', r.poly);
  ok('and so do its dots', r.dot === '#4488ff', r.dot);
}

console.log('\n10. nothing threw along the way');
ok('no uncaught errors at all', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
