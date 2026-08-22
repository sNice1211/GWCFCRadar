#!/usr/bin/env node
/*
 * The cross section tool, and above all whether it can take the page down.
 *
 *     node tools/test-cross-section.mjs
 *
 * A radar picture is one thin cone through a storm. It says where the rain is
 * and nothing about how tall it is, and height is most of what separates a
 * shower from a supercell. A volume scan already holds the answer: the same
 * circle swept at rising angles, so sampling every one of them along a line
 * on the ground and stacking them by beam height IS a vertical slice.
 *
 * The tool borrows a great deal from the rest of the page to do that - the
 * Level 2 decoder, its single-slot worker, the volume cache, the colour
 * tables, the map. Every one of those is a way for a tool that is merely
 * OPEN to break a map that is WORKING, so most of what is checked here is
 * that it does not: that a missing dependency is a message rather than a
 * throw, that a decode losing its slot to the map is handled rather than
 * fatal, and that closing the tool leaves nothing behind on the map.
 *
 * The maths is checked against numbers that are true independently of this
 * code: a beam's height at a known range and angle, which is a published
 * table, and a point-in-quad lookup over a mesh built here by hand.
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
await page.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4200);
await page.evaluate(() => { if (typeof closeTutorial === 'function') closeTutorial(); });

console.log('\n1. it is a tool like the others, not a bolted-on panel');
{
  const r = await page.evaluate(() => {
    const btn = document.getElementById('tool-xsec');
    const bar = document.getElementById('xsec-toolbar');
    const panel = document.getElementById('xsec-panel');
    const sibs = Array.from(document.querySelectorAll('#right-menu .tool-btn'))
      .map(b => b.id);
    return {
      inMenu: sibs.includes('tool-xsec'),
      sameClass: !!btn && btn.classList.contains('tool-btn'),
      hasBar: !!bar, hasPanel: !!panel,
      // The bar is built from the same pieces every other tool bar is.
      barParts: bar ? ['dtb-drag', 'dtb-label', 'dtb-sep', 'dtb-btn']
        .filter(c => !bar.querySelector('.' + c)) : ['no bar'],
      hasClose: !!(bar && bar.querySelector('#xsec-close')),
      hasInfo: !!(bar && bar.querySelector('#xsec-info-btn')),
      label: (typeof TOOL_LABELS === 'object') && TOOL_LABELS['tool-xsec'],
      desc: (typeof TOOL_DESCRIPTIONS === 'object')
        && (TOOL_DESCRIPTIONS['tool-xsec'] || '').length,
      menus: bar ? Array.from(bar.querySelectorAll('select')).map(s => s.id) : [],
    };
  });
  ok('the button sits in the tool column with the rest',
     r.inMenu && r.sameClass);
  ok('it has a toolbar and a panel', r.hasBar && r.hasPanel);
  ok('and the toolbar is built from the same pieces as the others',
     r.barParts.length === 0, r.barParts.join(','));
  ok('with a close button and an info button',
     r.hasClose && r.hasInfo);
  // The flyout is the little tag that extends from an icon-only button. Every
  // other tool has one; a new tool without one looks unfinished.
  ok('the hover flyout knows its name', r.label === 'Cross Section', String(r.label));
  ok('and has something real to say in the info popout',
     r.desc > 120, String(r.desc));
  ok('its menus are there', r.menus.join(',') === 'xsec-product,xsec-site',
     r.menus.join(','));
}

console.log('\n2. opening and closing leaves the map as it found it');
{
  const r = await page.evaluate(() => {
    toggleCrossSection();
    // The tool's own three layers, held onto so the question after closing
    // can be "are THESE gone" rather than "did the total change", which any
    // unrelated thing the page loads meanwhile would answer wrongly.
    const mine = _xsLayers ? [_xsLayers.poly, _xsLayers.ha, _xsLayers.hb] : [];
    const openState = {
      on: document.getElementById('xsec-toolbar').classList.contains('visible'),
      panel: document.getElementById('xsec-panel').classList.contains('open'),
      lit: document.getElementById('tool-xsec').classList.contains('active'),
      onMap: mine.filter(l => l && map.hasLayer(l)).length,
      hasLine: !!document.querySelector('.xs-handle'),
    };
    toggleCrossSection();
    const after = {
      on: document.getElementById('xsec-toolbar').classList.contains('visible'),
      panel: document.getElementById('xsec-panel').classList.contains('open'),
      lit: document.getElementById('tool-xsec').classList.contains('active'),
      onMap: mine.filter(l => l && map.hasLayer(l)).length,
      handles: document.querySelectorAll('.xs-handle').length,
      cleared: _xsLayers === null,
    };
    return { openState, after };
  });
  ok('opening shows the bar, the panel and lights the button',
     r.openState.on && r.openState.panel && r.openState.lit,
     JSON.stringify(r.openState));
  ok('and puts a draggable line on the map', r.openState.hasLine);
  ok('the line really is three layers on the map, not decoration',
     r.openState.onMap === 3, String(r.openState.onMap));
  ok('closing puts all three back', !r.after.on && !r.after.panel && !r.after.lit);
  // The thing that makes a tool a nuisance rather than a feature: leaving
  // its markers on the map after it is shut.
  ok('and takes every one of its own layers off the map again',
     r.after.onMap === 0, String(r.after.onMap));
  ok('forgetting them too, so a reopen cannot double them up', r.after.cleared);
  ok('with no orphaned handles left in the document', r.after.handles === 0,
     String(r.after.handles));
}

console.log('\n3. the beam height is the real one, not straight-line trig');
{
  // A radar beam bends slightly toward the ground and the ground curves away
  // beneath it. Pretending the earth is 4/3 its real size reproduces both
  // with straight lines, and it is the model every height table in
  // operational meteorology is built on. Straight trig would put a 0.5 degree
  // beam at 100 km about 0.87 km up; the real answer is over 1.6 km, and the
  // difference is the whole reason storm tops are not read off a protractor.
  const r = await page.evaluate(() => ({
    atSite: _xsBeamHeightKm(0, 0.5, 0),
    near: _xsBeamHeightKm(50, 0.5, 0),
    far: _xsBeamHeightKm(100, 0.5, 0),
    veryFar: _xsBeamHeightKm(200, 0.5, 0),
    steep: _xsBeamHeightKm(100, 3.1, 0),
    naive: 100 * Math.tan(0.5 * Math.PI / 180),
    withSite: _xsBeamHeightKm(100, 0.5, 0.4),
  }));
  ok('at the antenna the beam is at the antenna', Math.abs(r.atSite) < 0.01,
     r.atSite.toFixed(4));
  ok('a half degree beam is about 1.5 km up at 100 km, which is the '
     + 'published figure',
     r.far > 1.35 && r.far < 1.6, r.far.toFixed(3));
  ok('and about 3.9 km at 200 km, which is not double 100 km, because the '
     + 'earth is curving away',
     r.veryFar > 3.6 && r.veryFar < 4.2, r.veryFar.toFixed(3));
  ok('so it is well above what flat-earth trigonometry would say',
     r.far > r.naive * 1.6, `${r.far.toFixed(2)} vs ${r.naive.toFixed(2)}`);
  ok('a steeper cut is higher at the same range', r.steep > r.far,
     `${r.steep.toFixed(2)} vs ${r.far.toFixed(2)}`);
  ok('and it rises with range, always', r.far > r.near && r.near > r.atSite);
  ok('the antenna sitting on a hill lifts the whole beam with it',
     Math.abs((r.withSite - r.far) - 0.4) < 0.001,
     (r.withSite - r.far).toFixed(4));
}

console.log('\n4. the mesh lookup finds the right cell, and quickly');
{
  // The Inspector walks the whole mesh to answer one point, which is fine for
  // one point. This asks 140 points of 10 elevations, and a mesh can hold a
  // quarter of a million quads: the same approach would be 35 million
  // point-in-polygon tests and a locked up tab. So the quads are indexed
  // once. What matters is that the index gives the SAME answer.
  const r = await page.evaluate(() => {
    // A plain 40x40 grid of square cells over 4 degrees, value = its column,
    // so the right answer at any point is known by arithmetic.
    const N = 40, step = 0.1, lon0 = -100, lat0 = 30;
    const mesh = new Float32Array(N * N * 9);
    let k = 0;
    for (let gy = 0; gy < N; gy++) {
      for (let gx = 0; gx < N; gx++) {
        const x = lon0 + gx * step, y = lat0 + gy * step;
        mesh[k++] = x;        mesh[k++] = y;
        mesh[k++] = x + step; mesh[k++] = y;
        mesh[k++] = x + step; mesh[k++] = y + step;
        mesh[k++] = x;        mesh[k++] = y + step;
        mesh[k++] = gx;
      }
    }
    const bounds = [lon0, lat0, lon0 + N * step, lat0 + N * step];
    const t0 = performance.now();
    const idx = _xsIndex(mesh, bounds);
    const built = performance.now() - t0;

    const probes = [];
    for (let i = 0; i < 500; i++) {
      const gx = i % N, gy = (i * 7) % N;
      probes.push({
        lon: lon0 + gx * step + step / 2,
        lat: lat0 + gy * step + step / 2,
        want: gx,
      });
    }
    const t1 = performance.now();
    let wrong = 0;
    probes.forEach(p => { if (_xsLookup(idx, p.lon, p.lat) !== p.want) wrong++; });
    const looked = performance.now() - t1;

    return {
      built, looked, wrong,
      outsideW: _xsLookup(idx, lon0 - 5, lat0 + 1),
      outsideE: _xsLookup(idx, lon0 + 99, lat0 + 1),
      outsideN: _xsLookup(idx, lon0 + 1, lat0 + 99),
      nullIdx: _xsLookup(null, 0, 0),
    };
  });
  ok('every probe lands in the cell it should', r.wrong === 0,
     `${r.wrong} wrong`);
  ok('a point outside the mesh is null, not the nearest guess',
     r.outsideW === null && r.outsideE === null && r.outsideN === null,
     `${r.outsideW}, ${r.outsideE}, ${r.outsideN}`);
  ok('and no index at all is null rather than a throw', r.nullIdx === null);
  // The point of the index. 500 lookups over 1600 quads should be instant;
  // the guard is against a regression back to a full walk per point.
  ok('500 lookups take a few milliseconds, not seconds', r.looked < 120,
     r.looked.toFixed(1) + 'ms');
  ok('and building the index is not the new slow part', r.built < 400,
     r.built.toFixed(1) + 'ms');
}

console.log('\n5. it refuses to build rather than breaking, when it must');
{
  const r = await page.evaluate(async () => {
    const out = {};
    const status = () => document.getElementById('xsec-status').textContent;

    toggleCrossSection();                      // on

    // No decoder in this build at all. The tool has to say so.
    const realWorker = window._workerProcess;
    window._workerProcess = undefined;
    await _xsBuild();
    out.noDecoder = status();
    window._workerProcess = realWorker;

    // No line drawn. Same: a sentence, not a throw.
    const keepLine = _xsLine;
    _xsLine = null;
    await _xsBuild();
    out.noLine = status();
    _xsLine = keepLine;

    // A warm volume cache for the rest, so these reach the decoder instead
    // of stopping at the download that comes before it.
    const keepCache = _l2VolCache;
    _l2VolCache = { station: document.getElementById('xsec-site').value,
                    at: Date.now(), buf: new ArrayBuffer(64) };

    // The decoder losing its slot to the map's own radar job. This is the
    // real one: _workerProcess has a single slot and rejects the loser with
    // 'superseded', which is normal traffic rather than a fault.
    window._workerProcess = async () => { throw new Error('superseded'); };
    await _xsBuild();
    out.superseded = status();

    // Any other decoder failure.
    window._workerProcess = async () => { throw new Error('parse blew up'); };
    await _xsBuild();
    out.broken = status();
    window._workerProcess = realWorker;
    _l2VolCache = keepCache;

    out.stillOpen = document.getElementById('xsec-toolbar')
      .classList.contains('visible');
    out.mapAlive = !!(window.map && typeof map.getCenter === 'function'
                      && isFinite(map.getCenter().lat));
    toggleCrossSection();                      // off
    return out;
  });
  ok('a build with no decoder says so in words',
     /decoder/i.test(r.noDecoder), r.noDecoder);
  ok('a build with no line says so too', /line/i.test(r.noLine), r.noLine);
  // The one that would otherwise look like a crash to the person using it.
  ok('losing the decoder to the map is explained, not thrown',
     /map started its own/i.test(r.superseded), r.superseded);
  ok('and any other failure is still a sentence', r.broken.length > 0
     && !/undefined/.test(r.broken), r.broken);
  ok('the tool is still open after all four', r.stillOpen);
  ok('and the map is still alive, which is the whole point', r.mapAlive);
}

console.log('\n6. a slice really is drawn, from a volume that is stood in for');
{
  const r = await page.evaluate(async () => {
    // A fake volume: three elevation angles over a patch of ground, with a
    // core that is high in the middle, so the picture has something in it
    // that a person could recognise as a storm.
    const ANGLES = { 1: 0.5, 2: 1.5, 3: 2.4 };
    const makeMesh = (elev) => {
      const N = 30, step = 0.05, lon0 = -98.5, lat0 = 34.8;
      const mesh = new Float32Array(N * N * 9);
      let k = 0;
      for (let gy = 0; gy < N; gy++) {
        for (let gx = 0; gx < N; gx++) {
          const x = lon0 + gx * step, y = lat0 + gy * step;
          mesh[k++] = x;        mesh[k++] = y;
          mesh[k++] = x + step; mesh[k++] = y;
          mesh[k++] = x + step; mesh[k++] = y + step;
          mesh[k++] = x;        mesh[k++] = y + step;
          // A core in the middle that weakens with height.
          const d = Math.hypot(gx - N / 2, gy - N / 2);
          mesh[k++] = Math.max(0, 60 - d * 3 - (elev - 1) * 8);
        }
      }
      return { mesh, bounds: [lon0, lat0, lon0 + N * step, lat0 + N * step] };
    };
    let calls = 0;
    const realWorker = window._workerProcess;
    window._workerProcess = async (buf, layer, opts) => {
      calls++;
      const el = (opts && opts.elevation) || 1;
      const m = makeMesh(el);
      return {
        meshData: m.mesh, bounds: m.bounds,
        metadata: {
          availableElevations: [1, 2, 3],
          elevationNumber: el,
          elevationAngle: ANGLES[el],
          timeIso: new Date().toISOString(),
          vcp: 212,
        },
      };
    };
    const realCache = _l2VolCache;
    _l2VolCache = { station: 'ktlx', at: Date.now(), buf: new ArrayBuffer(64) };

    toggleCrossSection();
    document.getElementById('xsec-site').value = 'ktlx';
    document.getElementById('xsec-product').value = 'ref';
    // A line straight through the middle of the fake echo.
    _xsLine = { a: L.latLng(35.0, -98.4), b: L.latLng(35.0, -97.2) };
    await _xsBuild();

    const cv = document.getElementById('xsec-canvas');
    const g = cv.getContext('2d');
    // Counting any pixel with alpha would count the panel's own background
    // wash, which covers the whole canvas: that test passes even when not one
    // gate is drawn, and it did. Count pixels that are actually COLOURED
    // instead - the background is a flat grey, radar colours are not.
    const px = g.getImageData(0, 0, cv.width, cv.height).data;
    let painted = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], gg = px[i + 1], b = px[i + 2];
      if (px[i + 3] > 0 && (Math.max(r, gg, b) - Math.min(r, gg, b)) > 25) painted++;
    }

    const out = {
      calls,
      cuts: _xsLast ? _xsLast.cuts.length : 0,
      samples: _xsLast ? _xsLast.pts.length : 0,
      status: document.getElementById('xsec-status').textContent,
      note: document.querySelector('#xsec-panel .xs-note').textContent,
      legend: document.querySelector('#xsec-panel .xs-legend').textContent,
      paintedFrac: painted / (cv.width * cv.height),
      // Every cut must have found SOME data, or the sampling is broken even
      // though the picture looks plausible.
      withData: _xsLast
        ? _xsLast.cuts.filter(c => c.row.some(s => s.v != null)).length : 0,
      // Height has to rise with the elevation angle at the same spot.
      // Counting distinct child tops does NOT work: align-items:center gives
      // a 9px drag handle and a 30px button different tops on the same row.
      // The bar's own height is the honest question - one row of 30px
      // controls plus padding is about 44px, two rows is about 80.
      barH: Math.round(document.getElementById('xsec-toolbar')
        .getBoundingClientRect().height),
      barW: Math.round(document.getElementById('xsec-toolbar')
        .getBoundingClientRect().width),
      vw: window.innerWidth,
      clearOfBar: (() => {
        const p = document.getElementById('xsec-panel').getBoundingClientRect();
        const b = document.getElementById('xsec-toolbar').getBoundingClientRect();
        return p.bottom <= b.top + 1 || p.right <= b.left || p.left >= b.right;
      })(),
      overlap: (() => {
        const p = document.getElementById('xsec-panel').getBoundingClientRect();
        const b = document.getElementById('xsec-toolbar').getBoundingClientRect();
        return `panel ${Math.round(p.top)}-${Math.round(p.bottom)}, `
             + `bar ${Math.round(b.top)}-${Math.round(b.bottom)}`;
      })(),
      allHaveKm: (_xsLast || {}).cuts
        ? _xsLast.cuts.every(c => c.row.every(s => Number.isFinite(s.km)))
        : false,
      risesWithAngle: (() => {
        const cs = (_xsLast || {}).cuts || [];
        if (cs.length < 2) return false;
        const mid = Math.floor(cs[0].row.length / 2);
        return cs[1].row[mid].z > cs[0].row[mid].z;
      })(),
    };
    toggleCrossSection();
    window._workerProcess = realWorker;
    _l2VolCache = realCache;
    return out;
  });
  ok('it decoded every elevation the volume said it had', r.cuts === 3,
     `${r.cuts} cuts from ${r.calls} decodes`);
  ok('and found real values in all of them', r.withData === 3,
     String(r.withData));
  ok('it sampled along the line rather than at one point', r.samples > 20,
     String(r.samples));
  ok('the higher cut really is drawn higher', r.risesWithAngle);
  ok('and real colour was painted on the canvas, not just its background',
     r.paintedFrac > 0.03, (r.paintedFrac * 100).toFixed(1) + '% coloured');
  // Every sample has to know how far along the line it is. It did not, once,
  // and every box was drawn at NaN: a chart that looked like clear air.
  ok('every sample carries its distance along the line', r.allHaveKm);
  ok('the status says what it did', /3 cuts/.test(r.status), r.status);
  // The panel must not cover the toolbar that drives it: the tool's own first
  // instruction is "press the arrow", and it used to sit on top of the arrow.
  ok('and the panel is clear of the bar it is driven from', r.clearOfBar,
     r.overlap);
  // A centred absolutely positioned bar is laid out inside HALF the window,
  // because left:50% is where its available space starts and the centring
  // transform happens afterwards. The close button wrapped onto a second row
  // on a perfectly wide screen because of it.
  ok('and the bar itself is one row, not wrapped', r.barH < 56,
     `${r.barH}px tall, ${r.barW}px wide in a ${r.vw}px window`);

  ok('the legend names the angles it used',
     /0\.5/.test(r.legend) && /2\.4/.test(r.legend), r.legend);
  // The honest caveat. A volume measures nothing between two elevation
  // angles, and a picture that hides that is claiming to know more than the
  // radar does.
  ok('and the note admits what a volume cannot see',
     /measures nothing between/.test(r.note), r.note.slice(0, 120));
  ok('naming the radar and the product it came from',
     /KTLX/.test(r.note) && /Reflectivity/.test(r.note), r.note.slice(0, 80));
}

console.log("\n7. the right-click menu opens on a double tap as well");
{
  // A touch screen has no right button, so the menu it holds - the sounding,
  // the nearest station, what is alerted here - was unreachable on a phone.
  // Double tap already meant "zoom in" though, and taking that from everybody
  // to give a menu to phone users would be a bad trade. So the two are told
  // apart by what actually touched the screen.
  const r = await page.evaluate(async () => {
    const cont = map.getContainer();
    const press = (kind) => {
      const ev = window.PointerEvent
        ? new PointerEvent('pointerdown', { pointerType: kind, bubbles: true })
        : new MouseEvent('mousedown', { bubbles: true });
      cont.dispatchEvent(ev);
    };
    const menu = () => document.getElementById('map-ctx-menu');
    const isOpen = () => !!(menu() && menu().classList.contains('open'));
    const close = () => { if (typeof _cmClose === 'function') _cmClose(); };

    close();
    // A finger.
    press('touch');
    const zoomOffForTouch = !map.doubleClickZoom.enabled();
    map.fire('dblclick', { latlng: L.latLng(35.2, -97.4),
                           originalEvent: new MouseEvent('dblclick'),
                           containerPoint: L.point(100, 100) });
    await new Promise(r2 => setTimeout(r2, 60));
    const afterTouch = isOpen();
    close();

    // A mouse. The menu must NOT open, and the zoom must come back.
    press('mouse');
    const zoomOnForMouse = map.doubleClickZoom.enabled();
    map.fire('dblclick', { latlng: L.latLng(35.2, -97.4),
                           originalEvent: new MouseEvent('dblclick'),
                           containerPoint: L.point(100, 100) });
    await new Promise(r2 => setTimeout(r2, 60));
    const afterMouse = isOpen();
    close();

    // Right click still works, whatever touched the screen last.
    _cmOpen({ latlng: L.latLng(35.2, -97.4) });
    const afterRightClick = isOpen();
    const body = menu() ? menu().textContent : '';
    close();

    return { zoomOffForTouch, afterTouch, zoomOnForMouse, afterMouse,
             afterRightClick, body: body.slice(0, 400) };
  });
  ok('a double tap opens the menu', r.afterTouch);
  // The zoom has to be off BEFORE the double click arrives: by the time one
  // fires, Leaflet has already decided to zoom.
  ok('and the tap that started it turned double-tap-zoom off first',
     r.zoomOffForTouch);
  ok('a mouse double click still zooms instead', !r.afterMouse);
  ok('with its zoom handed straight back', r.zoomOnForMouse);
  ok('and the right button still opens it, as it always did',
     r.afterRightClick);
  ok('the menu really is the one with the sounding in it',
     /Sounding/i.test(r.body), r.body.slice(0, 120));
}

console.log('\n8. nothing above threw');
{
  const real = errors.filter(e =>
    !/Failed to fetch|NetworkError|ERR_FAILED|net::/i.test(e));
  ok('no page errors', real.length === 0, real.slice(0, 3).join(' | '));
}

await browser.close();
console.log();
if (fail) { console.log(`${fail} FAILED, ${pass} passed`); process.exit(1); }
console.log(`all ${pass} passed`);
