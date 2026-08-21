#!/usr/bin/env node
/*
 * Why radar pictures looked like watercolour, and what makes them look like
 * radar again.
 *
 *     node tools/test-radar-quality.mjs
 *
 * Two things were wrong at once and they compounded each other.
 *
 * The colour scales were continuous sweeps through HSL. Radar has been drawn
 * in discrete bands since it was drawn on paper, and that is not tradition
 * for its own sake: a forecaster reads a band EDGE as a threshold. 35 dBZ is
 * about where a shower becomes a storm, 50 is where hail starts being worth
 * thinking about, 60 is a core. A smooth ramp has no edges, so none of those
 * numbers can be read off the picture at all.
 *
 * Then the browser smoothed the finished image as it magnified it, which on
 * top of a smooth ramp gives soft rainbow blobs, and on top of a banded one
 * would be worse than ugly: half way between the 45 and 50 colours is a
 * colour that means 47 dBZ, at a pixel where nothing measured 47 dBZ.
 *
 * So the bands are checked by their edges - one tenth of a dBZ either side of
 * a threshold must give two different colours, and a whole band must give
 * exactly one - and the crispness is checked by asking the browser what it
 * computed for a real overlay image, not by grepping for a CSS rule.
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
await page.waitForTimeout(4000);
await page.evaluate(() => { if (typeof closeTutorial === 'function') closeTutorial(); });

console.log('\n1. reflectivity is drawn in bands, and the edges are where they should be');
{
  const r = await page.evaluate(() => {
    const f = _meshColorFn('ref');
    const at = v => f(v);
    return {
      // Either side of every threshold a forecaster actually reads.
      edges: [20, 35, 50, 60, 65].map(e => [at(e - 0.1), at(e + 0.1)]),
      // And the whole of one band is one colour, which is what makes the
      // edge readable in the first place.
      inside: [35.2, 37, 39, 39.9].map(at),
      belowFirst: [at(-5), at(0), at(4.9)],
      atFirst: at(5.1),
      // The classic scale, spot checked at the colours everyone knows.
      green20: at(21), yellow35: at(36), red50: at(51), magenta65: at(66),
      distinct: new Set([...Array(15)].map((_, i) => at(5 + i * 5 + 0.1))).size,
    };
  });
  r.edges.forEach(([lo, hi], i) => {
    const e = [20, 35, 50, 60, 65][i];
    ok(`${e} dBZ is a real edge: a tenth either side is two colours`,
       lo !== hi, `${lo} vs ${hi}`);
  });
  ok('and everything inside one band is the same colour',
     new Set(r.inside).size === 1, JSON.stringify(r.inside));
  // Below the lowest band is clear-air return and ground clutter. Painting it
  // in the lowest band's colour is the haze that made every map look washed.
  ok('below the lowest band nothing is painted at all',
     r.belowFirst.every(c => c === null), JSON.stringify(r.belowFirst));
  ok('and the lowest band itself is painted', r.atFirst !== null, String(r.atFirst));
  ok('20 dBZ is the green everyone knows', r.green20 === '#02fd02', r.green20);
  ok('35 is yellow', r.yellow35 === '#fdf802', r.yellow35);
  ok('50 is red', r.red50 === '#fd0000', r.red50);
  ok('65 is magenta', r.magenta65 === '#f800fd', r.magenta65);
  ok('and all fifteen bands are different colours from each other',
     r.distinct === 15, String(r.distinct));
}

console.log('\n2. velocity is banded too, and still says nothing about still air');
{
  const r = await page.evaluate(() => {
    const f = _meshColorFn('vel');
    return {
      dead: [-4, -1, 0, 1, 4].map(f),
      inbound: [-20, -50, -100].map(f),
      outbound: [20, 50, 100].map(f),
      edge: [f(-20.1), f(-19.9)],
      band: new Set([-24, -22, -21].map(f)).size,
    };
  });
  // A colour at zero would fill the entire sweep with air that is not moving,
  // and the couplet that is the only reason anyone opened velocity would be
  // sitting inside it.
  ok('within a few knots of zero nothing is drawn',
     r.dead.every(c => c === null), JSON.stringify(r.dead));
  // Green towards, red away. Not a matter of taste: reading a couplet depends
  // on the two sides being told apart at a glance.
  ok('inbound is green', r.inbound.every(c => /^#00/.test(c)), JSON.stringify(r.inbound));
  ok('outbound is red', r.outbound.every(c => /^#(?:[4-9a-f]|f)/.test(c)),
     JSON.stringify(r.outbound));
  ok('the bands have real edges', r.edge[0] !== r.edge[1], JSON.stringify(r.edge));
  ok('and one band is one colour', r.band === 1, String(r.band));
}

console.log('\n3. echo tops step in the units the number is quoted in');
{
  const r = await page.evaluate(() => {
    const f = _meshColorFn('eet');
    return { edge: [f(44.9), f(45.1)], band: new Set([45.2, 47, 49].map(f)).size,
             low: f(2), high: f(60) };
  });
  ok('45 thousand feet is an edge', r.edge[0] !== r.edge[1], JSON.stringify(r.edge));
  ok('and five thousand feet of it is one colour', r.band === 1, String(r.band));
  ok('below the lowest band is nothing', r.low === null, String(r.low));
  ok('and the tall tops are painted', r.high !== null, String(r.high));
}

console.log('\n4. the picture is not smoothed as it is magnified');
{
  const r = await page.evaluate(() => {
    // A real overlay in the real pane, then ask the browser what it computed.
    // A CSS rule that exists but does not apply would pass a grep and fail
    // here, which is the point of doing it this way.
    const px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const ov = L.imageOverlay(px, [[35, -98], [36, -97]],
                              { pane: 'radarPane' }).addTo(map);
    const img = ov.getElement();
    const rendering = getComputedStyle(img).imageRendering;
    // And a layer in an ordinary pane must be untouched: this is a statement
    // about radar data, not about every picture on the map.
    const other = L.imageOverlay(px, [[35, -98], [36, -97]]).addTo(map);
    const otherRendering = getComputedStyle(other.getElement()).imageRendering;
    map.removeLayer(ov); map.removeLayer(other);
    return { rendering, otherRendering };
  });
  ok('a radar overlay is rendered crisp, not blended',
     /pixelated|crisp-edges|optimize-contrast/.test(r.rendering), r.rendering);
  ok('and an overlay in an ordinary pane is left alone',
     r.otherRendering === 'auto', r.otherRendering);
}

console.log('\n5. a custom palette still wins, because it was asked for');
{
  const r = await page.evaluate(() => {
    // Someone who has set their own colours has said what they want, and a
    // default that overrode them would be the app arguing with its user.
    const before = _meshColorFn('ref')(45);
    const realPal = window._fxPaletteFor, realGrad = window._fxGradientFn;
    window._fxPaletteFor = fam => (fam === 'ref' ? ['#111111', '#eeeeee'] : null);
    window._fxGradientFn = () => () => '#abcdef';
    const after = _meshColorFn('ref')(45);
    window._fxPaletteFor = realPal; window._fxGradientFn = realGrad;
    return { before, after, back: _meshColorFn('ref')(45) };
  });
  ok('a custom palette replaces the bands', r.after === '#abcdef',
     `${r.before} -> ${r.after}`);
  ok('and clearing it brings the bands back', r.back === r.before,
     `${r.back} vs ${r.before}`);
}

console.log('\n6. the raster is sized to what it is drawing');
{
  const r = await page.evaluate(() => {
    const mk = (halfDeg) => {
      const site = _meshSiteLatLon('ktlx');
      const cells = [];
      for (let i = 0; i < 40; i++) {
        const f = -halfDeg + (2 * halfDeg * i) / 40;
        cells.push(site.lon + f, site.lat + f,
                   site.lon + f + 0.05, site.lat + f,
                   site.lon + f + 0.05, site.lat + f + 0.05,
                   site.lon + f, site.lat + f + 0.05, 45);
      }
      return {
        meshData: Float32Array.from(cells),
        bounds: [site.lon - halfDeg, site.lat - halfDeg,
                 site.lon + halfDeg, site.lat + halfDeg],
        metadata: {},
      };
    };
    const small = _meshToImage(mk(1.2), 'ref', null);
    const big = _meshToImage(mk(5), 'ref', null);
    const kmPerPx = (res, halfDeg) => (halfDeg * 2 * 111) / res.canvas.width;
    return {
      smallPx: small.canvas.width, bigPx: big.canvas.width,
      smallKm: kmPerPx(small, 1.2), bigKm: kmPerPx(big, 5),
    };
  });
  // Fixed at a thousand pixels, a picture reaching 460 km would have been
  // four times blockier than one reaching 115: maxing the range would have
  // cost exactly the detail this whole change is about.
  ok('a bigger box gets a bigger canvas', r.bigPx > r.smallPx,
     `${r.smallPx} vs ${r.bigPx}`);
  ok('so the ground each pixel covers stays in the same order',
     r.bigKm < r.smallKm * 3, `${r.smallKm.toFixed(2)} vs ${r.bigKm.toFixed(2)} km/px`);
  ok('and neither is coarser than a kilometre a pixel',
     r.smallKm < 1 && r.bigKm < 1,
     `${r.smallKm.toFixed(2)}, ${r.bigKm.toFixed(2)}`);
}

console.log('\n7. long product names are not cut off mid-word');
{
  const r = await page.evaluate(() => {
    const wrap = document.getElementById('sub-bubbles');
    wrap.innerHTML = '';
    wrap.style.display = 'flex';
    const el = document.createElement('div');
    el.className = 'sub-bubble';
    el.innerHTML = '<span class="sb-label">Hybrid Scan Reflectivity</span>';
    wrap.appendChild(el);
    const lbl = el.querySelector('.sb-label');
    const col = getComputedStyle(wrap);
    return {
      // The label must fit inside its own pill, and the pill inside the
      // column. "COMPOSITE REFLECTIVI" was the failure: the word ran past
      // the column edge and the column clipped it square.
      labelFits: lbl.scrollWidth <= lbl.clientWidth + 1,
      pillFits: el.scrollWidth <= el.clientWidth + 1,
      inColumn: el.getBoundingClientRect().right
                <= wrap.getBoundingClientRect().right + 1,
      wraps: getComputedStyle(el).whiteSpace !== 'nowrap',
      lines: Math.round(lbl.getBoundingClientRect().height
                        / parseFloat(getComputedStyle(lbl).lineHeight || 14)),
      overflowX: col.overflowX,
    };
  });
  ok('a long label fits inside its own pill', r.labelFits, JSON.stringify(r));
  ok('the pill fits inside the column', r.pillFits && r.inColumn, JSON.stringify(r));
  ok('because it is allowed to wrap rather than run off the edge', r.wraps);
  ok('and it really did wrap, rather than just being short enough',
     r.lines >= 2, String(r.lines));
  // The column still clips sideways on purpose, which is exactly why nothing
  // may rely on overflowing it.
  ok('the column still clips sideways, so this had to be fixed properly',
     r.overflowX === 'hidden', r.overflowX);
}

console.log('\n7b. the pixel renderer draws the same picture, only truer');
{
  const r = await page.evaluate(() => {
    // A real polar sweep, so the gates lean over and grow the way they do on
    // the sky. A grid of little squares would not have tested the thing that
    // matters, which is whether the slanted outline is walked properly.
    function sweep(nRad, nGate, maxDeg) {
      const S = 9, md = new Float32Array(nRad * nGate * S);
      let k = 0;
      for (let rr = 0; rr < nRad; rr++) {
        const a0 = (rr / nRad) * 2 * Math.PI, a1 = ((rr + 1) / nRad) * 2 * Math.PI;
        for (let g = 0; g < nGate; g++) {
          const r0 = maxDeg * g / nGate, r1 = maxDeg * (g + 1) / nGate;
          md[k]   = -97 + r0 * Math.cos(a0); md[k+1] = 35 + r0 * Math.sin(a0);
          md[k+2] = -97 + r1 * Math.cos(a0); md[k+3] = 35 + r1 * Math.sin(a0);
          md[k+4] = -97 + r1 * Math.cos(a1); md[k+5] = 35 + r1 * Math.sin(a1);
          md[k+6] = -97 + r0 * Math.cos(a1); md[k+7] = 35 + r0 * Math.sin(a1);
          md[k+8] = 5 + ((rr + g) % 13) * 5;
          k += S;
        }
      }
      return md;
    }
    const cov = (cv) => {
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      const u = new Uint32Array(d.buffer);
      let n = 0; const seen = new Set();
      for (let i = 0; i < u.length; i++) if (u[i] !== 0) { n++; seen.add(u[i]); }
      return { painted: n, colors: seen.size };
    };
    const out = {};
    for (const [nRad, nGate, maxDeg, name] of
         [[720, 230, 4.1, 'far'], [360, 120, 0.35, 'near']]) {
      const md = sweep(nRad, nGate, maxDeg);
      const res = { meshData: md,
                    bounds: [-97 - maxDeg, 35 - maxDeg, -97 + maxDeg, 35 + maxDeg],
                    metadata: {} };
      const nu = cov(_meshToImage(res, 'ref', res.bounds).canvas);
      // Make one colour a hair translucent and the old canvas path renderer
      // takes over, which is how the two are compared on identical data.
      const real = window._meshRGBA;
      window._meshRGBA = (css) => { const v = real(css); return v ? { u32: v.u32, a: 254 } : v; };
      const old = cov(_meshToImage(res, 'ref', res.bounds).canvas);
      window._meshRGBA = real;
      out[name] = { nu, old, cells: md.length / 9 };
    }
    return out;
  });

  for (const where of ['far', 'near']) {
    const { nu, old } = r[where];
    // Not a pixel by pixel match, because the two rasterisers round edges
    // differently, but the amount of map covered has to agree. A pixel
    // renderer that quietly dropped gates would show up here as a shortfall.
    const ratio = nu.painted / Math.max(1, old.painted);
    ok(`${where}: it covers the same ground as the canvas renderer`,
       ratio > 0.97 && ratio < 1.03, `${ratio.toFixed(3)} (${nu.painted} vs ${old.painted})`);
    ok(`${where}: and it really painted something`, nu.painted > 10000, String(nu.painted));
  }
  // The near field is the case that could silently break: close to the radar
  // a gate is smaller than one pixel, and a scanline walk over something
  // finer than its own grid can come out empty.
  ok('the near field is not thinned out by sub-pixel gates',
     r.near.nu.painted / Math.max(1, r.near.old.painted) > 0.97,
     `${r.near.nu.painted} vs ${r.near.old.painted}`);

  // And the part that is not merely equal but better. Reflectivity is
  // thirteen discrete bands here. The canvas renderer anti-aliases every
  // band edge, blending neighbouring bands into thousands of in-between
  // shades - and an in-between shade is a reading the radar never took. A
  // pixel that is half "35 dBZ green" and half "40 dBZ yellow" gets painted
  // a colour that means neither. Writing pixels directly cannot do that.
  ok('the picture holds only the bands the data actually has',
     r.far.nu.colors <= 16, String(r.far.nu.colors));
  ok('where the canvas renderer invented thousands of in-between shades',
     r.far.old.colors > 1000, String(r.far.old.colors));
  ok('which is the same blur the pixelated rendering fixed, one layer down',
     r.near.nu.colors <= 16 && r.near.old.colors > 1000,
     `${r.near.nu.colors} vs ${r.near.old.colors}`);
}

console.log('\n8. nothing above threw');
{
  const real = errors.filter(e => !/Failed to fetch|NetworkError|ERR_FAILED|net::/i.test(e));
  ok('no page errors', real.length === 0, real.slice(0, 3).join(' | '));
}

await browser.close();
console.log();
if (fail) { console.log(`${fail} FAILED, ${pass} passed`); process.exit(1); }
console.log(`all ${pass} passed`);
