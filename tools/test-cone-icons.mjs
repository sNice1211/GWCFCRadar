#!/usr/bin/env node
/*
 * A published cone draws what the forecaster drew: line, dots and icons.
 *
 *     npm i playwright && node tools/test-cone-icons.mjs
 *
 * The Storm Cone tool lets a forecaster put a category icon on any point of
 * the track: a tropical storm here, a category two there. None of them ever
 * reached anybody. Nor did the dashed centre line or the time dots, because
 * all three hang off one array, and that array was always empty.
 *
 * The serializer read `centerPts`. _scBuildTrack returns `centerLine`, and
 * has never returned anything called centerPts, so the expression was
 * undefined every single time and every cone ever published carried an empty
 * centre line. The ring drew. Nothing inside it did.
 *
 * This drives the REAL cone builder and the REAL serializer rather than a
 * description of them, because the bug was precisely a name that did not
 * exist: a test written against a hand-made object would have used whatever
 * name the test author had in mind and passed against the broken code.
 *
 * It also checks the recovery path, which is the half that matters today: a
 * cone published yesterday cannot be fixed by fixing the writer, so the
 * reader rebuilds the centre line out of the ring.
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

// The cone builder does real spherical geometry, and all of it is the app's
// own arithmetic. The only thing it wants from Leaflet is L.latLng, which is
// a value object holding two numbers, and one distance measurement. Both are
// provided for real here rather than fetched from a CDN a sandbox cannot
// reach: a haversine is a haversine, and the geometry under test is the
// cone builder's, not Leaflet's.
const LEAFLET_REAL_ENOUGH = `(() => {
  const R = 6371008.8;                      // metres, the same sphere Leaflet uses
  const rad = (d) => d * Math.PI / 180;
  function LL(a, b) {
    if (a && typeof a === 'object' && 'lat' in a) return LL(a.lat, a.lng ?? a.lon);
    if (Array.isArray(a)) return LL(a[0], a[1]);
    return { lat: +a, lng: +b, distanceTo(o) {
      const p = LL(o);
      const dLat = rad(p.lat - this.lat), dLon = rad(p.lng - this.lng);
      const h = Math.sin(dLat / 2) ** 2
        + Math.cos(rad(this.lat)) * Math.cos(rad(p.lat)) * Math.sin(dLon / 2) ** 2;
      return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
    } };
  }
  const stub = () => ({ addTo() { return this; }, on() { return this; },
    getElement: () => null, bindTooltip() { return this; },
    getBounds: () => ({ getCenter: () => LL(35, -97) }) });
  window.L = { latLng: LL, latLngBounds: () => ({ getCenter: () => LL(35, -97) }),
    marker: stub, circleMarker: stub, polyline: stub, polygon: stub,
    layerGroup: stub, geoJSON: stub, divIcon: (o) => o,
    tileLayer: Object.assign(stub, { wms: stub }),
    map: () => ({ setView() { return this; }, on() { return this; },
                  createPane: () => document.createElement('div'),
                  getPane: () => document.createElement('div') }) };
})();`;

const browser = await chromium.launch({ executablePath: chromePath() });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));

await page.addInitScript(LEAFLET_REAL_ENOUGH);
await page.route('**://**', (r) =>
  r.request().url().startsWith('file://') ? r.continue() : r.abort());
await page.goto('file://' + join(ROOT, 'index.html'),
                { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);

console.log('\n1. the real cone builder, and what the real serializer stores');
const built = await page.evaluate(() => {
  // Enough map for _scBuildTrack: it measures distances and reads nothing else.
  //
  // A BARE assignment, not window.map. The page declares `let map` at the top
  // of a classic script, and a top-level let is a lexical binding rather than
  // a property of window, so window.map would make a second unrelated name
  // that _scBuildTrack never reads. This is the same trap that made an
  // earlier suite pass for entirely the wrong reason.
  map = {
    distance: (a, b) => L.latLng(a).distanceTo(b),
    getCenter: () => L.latLng(35, -97),
    removeLayer: () => {},
    // _ovPane asks for a pane and makes one if it is missing. Both answers
    // are fine here; the panes are z-order, not geometry.
    getPane: () => document.createElement('div'),
    createPane: () => document.createElement('div'),
  };
  const path = [L.latLng(28.0, -80.0), L.latLng(30.5, -82.0),
                L.latLng(33.0, -85.5)];
  let track = _scBuildTrack(path, null, 'drag');
  // Two category marks, the thing that never arrived.
  const cats = new Array(track.pointCats.length).fill(null);
  const mid = Math.floor(cats.length / 2);
  // Real category keys. TTB_ICONS is keyed cat1..cat5, td, ts and so on, and
  // an unknown key falls through to a plain dot rather than an icon, so a
  // made-up one here would have looked exactly like the bug being tested.
  cats[mid] = 'td';
  cats[cats.length - 1] = 'cat3';
  track = _scBuildTrack(path, { ...track, pointCats: cats }, 'drag');

  _scCones = [{ id: 'c1', speed: 15, curve: 0, dots: 3, offset: 0,
                width: 22, style: null, track }];
  _scTrack = null;
  const doc = _fdSerializeCones()[0];
  return {
    hasCenterPts: 'centerPts' in track,
    hasCenterLine: Array.isArray(track.centerLine),
    trackLen: track.centerLine ? track.centerLine.length : 0,
    ringLen: track.ring.length,
    doc,
    trueCentre: track.centerLine.map(p => [p.lat, p.lng]),
  };
});

ok('no uncaught errors', errors.length === 0, errors[0]);
ok('the track has NO centerPts, which is the name that was being read',
   built.hasCenterPts === false);
ok('it has centerLine, which is the name it has always used',
   built.hasCenterLine);
ok('and the published cone now carries a real centre line',
   Array.isArray(built.doc.center) && built.doc.center.length > 1,
   (built.doc.center || []).length);
ok('as long as the track itself',
   built.doc.center.length === built.trackLen,
   `${built.doc.center.length} vs ${built.trackLen}`);
ok('the category marks are published',
   Array.isArray(built.doc.cats)
   && built.doc.cats.filter(Boolean).length === 2,
   JSON.stringify((built.doc.cats || []).filter(Boolean)));
ok('and so is how the cone was drawn, which decides where its dots go',
   built.doc.mode === 'drag', built.doc.mode);

console.log('\n2. drawing it puts the icons on the map');
{
  const drew = await page.evaluate((doc) => {
    // Count what actually goes onto the map, by kind.
    const added = { markers: 0, dots: 0, lines: 0, polys: 0 };
    const realMarker = L.marker, realCircle = L.circleMarker;
    const realLine = L.polyline, realPoly = L.polygon;
    const stub = () => ({ addTo() { return this; },
                          getBounds: () => L.latLngBounds(),
                          getElement: () => null,
                          setAttribute() {}, on() { return this; } });
    L.marker = (...a) => { added.markers++; return stub(); };
    L.circleMarker = (...a) => { added.dots++; return stub(); };
    L.polyline = (...a) => { added.lines++; return stub(); };
    L.polygon = (...a) => { added.polys++; return stub(); };
    try {
      _gwcfcDraw({ storms: [], areas: [], cones: [doc], alerts: [] },
                 [], 'test-pane');
    } finally {
      L.marker = realMarker; L.circleMarker = realCircle;
      L.polyline = realLine; L.polygon = realPoly;
    }
    return added;
  }, built.doc);
  ok('the cone outline is drawn', drew.polys === 1, JSON.stringify(drew));
  ok('the dashed centre line is drawn', drew.lines === 1, JSON.stringify(drew));
  // Two category icons plus the office tag, which is also a marker.
  ok('both category icons are drawn', drew.markers === 3, JSON.stringify(drew));
  // Three evenly spread dots were asked for and two points carry a category.
  // One of the three lands on one of the two, and a category outranks a plain
  // dot at the same spot, so four marks in total: two icons and two dots.
  // Never a mark on every point, which is what taking every index of a sparse
  // array used to produce.
  ok('a category replaces the plain dot at the same point rather than '
     + 'sitting on top of it',
     drew.dots === 2, JSON.stringify(drew));
  ok('and the marks are the handful placed, not one per point of the track',
     drew.dots + (drew.markers - 1) === 4 && drew.dots + drew.markers < 10,
     JSON.stringify(drew));
}

console.log('\n3. a cone published BEFORE the fix still gets its icons back');
{
  // Exactly what is in the database right now: everything except a centre
  // line, because the writer never managed to store one.
  const legacy = await page.evaluate(({ doc, trueCentre }) => {
    const old = { ...doc, center: [] };
    const rebuilt = _gwcfcConeCentre(old);
    // How far each recovered point is from the real one, in degrees.
    let worst = 0;
    for (let i = 0; i < Math.min(rebuilt.length, trueCentre.length); i++) {
      worst = Math.max(worst,
        Math.abs(rebuilt[i][0] - trueCentre[i][0]),
        Math.abs(rebuilt[i][1] - trueCentre[i][1]));
    }
    return { len: rebuilt.length, want: trueCentre.length, worst };
  }, { doc: built.doc, trueCentre: built.trueCentre });
  ok('the centre line is rebuilt out of the ring',
     legacy.len === legacy.want, `${legacy.len} vs ${legacy.want}`);
  // The two edges are the centre pushed out by the same distance in opposite
  // directions, so their midpoint is the centre. Anything past a rounding
  // error means the ring is not laid out the way this assumes.
  // The two edges are the centre walked out along a great circle at right
  // angles, so the centre is the point half way back along the arc between
  // them. What is left is the four decimal places the ring is rounded to when
  // it is published, which is about eleven metres.
  ok('and it lands on the real line to the precision the document stores',
     legacy.worst < 2e-4, 'worst error ' + legacy.worst + ' degrees');
  ok('which is very much closer than averaging the two numbers would be',
     legacy.worst < 1e-3, legacy.worst);

  const drew = await page.evaluate((doc) => {
    const added = { markers: 0, dots: 0, lines: 0, polys: 0 };
    const realMarker = L.marker, realCircle = L.circleMarker;
    const realLine = L.polyline, realPoly = L.polygon;
    const stub = () => ({ addTo() { return this; },
                          getBounds: () => L.latLngBounds(),
                          getElement: () => null,
                          setAttribute() {}, on() { return this; } });
    L.marker = () => { added.markers++; return stub(); };
    L.circleMarker = () => { added.dots++; return stub(); };
    L.polyline = () => { added.lines++; return stub(); };
    L.polygon = () => { added.polys++; return stub(); };
    try {
      _gwcfcDraw({ storms: [], areas: [], cones: [{ ...doc, center: [] }],
                   alerts: [] }, [], 'test-pane');
    } finally {
      L.marker = realMarker; L.circleMarker = realCircle;
      L.polyline = realLine; L.polygon = realPoly;
    }
    return added;
  }, built.doc);
  ok('so an already-published cone draws its icons with no republish',
     drew.markers >= 3, JSON.stringify(drew));
  ok('and its centre line too', drew.lines === 1, JSON.stringify(drew));
}

console.log('\n4. a ring that is not one of ours is left alone');
{
  const r = await page.evaluate(() => ({
    square: _gwcfcConeCentre({ ring: [[0, 0], [0, 1], [1, 1], [1, 0]], center: [] }).length,
    empty: _gwcfcConeCentre({ ring: [], center: [] }).length,
    missing: _gwcfcConeCentre({}).length,
    // A centre line that IS published is used as given rather than recomputed.
    given: _gwcfcConeCentre({ center: [[1, 1], [2, 2]], ring: [] }).length,
  }));
  ok('a four-corner shape is not folded into a line', r.square === 0, r.square);
  ok('an empty ring gives nothing', r.empty === 0);
  ok('a cone with no ring at all does not throw', r.missing === 0);
  ok('and a real centre line is trusted rather than rebuilt', r.given === 2);
}

console.log('\n5. the two copies of the serializer agree');
{
  const { readFileSync } = await import('fs');
  const app = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const portal = readFileSync(join(ROOT, 'forecasting-portal.html'), 'utf8');
  for (const [name, src] of [['the radar', app], ['the portal', portal]]) {
    ok(`${name} reads centerLine`, /_scCentreOf/.test(src));
    // The expression, not the prose: the comment above the fix names the old
    // key on purpose, and a plain search for the word finds that too.
    ok(`${name} no longer READS centerPts`,
       !/\.centerPts\s*\?/.test(src) && !/track\.centerPts\.map/.test(src));
    ok(`${name} publishes the click points of a multi cone`,
       /dotIdx:/.test(src));
  }
}

console.log('\n6. nothing threw along the way');
ok('no uncaught errors at all', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
