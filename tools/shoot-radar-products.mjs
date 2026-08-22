#!/usr/bin/env node
/*
 * A picture of every radar product, from a NEXRAD and from a terminal, drawn
 * from the live feed by the real renderer, plus the exact colour every value
 * in each product maps to.
 *
 *     node tools/shoot-radar-products.mjs [outdir]
 *
 * Two different questions get answered here and they need different pictures.
 *
 * The live shot proves the whole chain works: bucket to worker to mesh to
 * canvas. What it cannot prove is that the colours are RIGHT, because real
 * weather only visits the part of the scale it happens to be in today.
 *
 * So each product also gets a ramp: a synthetic sweep whose gates step
 * evenly across the product's whole range, rendered by the same code, then
 * read back pixel by pixel. That turns "does it look ok" into a table of
 * value to colour that can be checked against the published scale.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const { chromium } = await import('playwright');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const OUT = process.argv[2] || join(ROOT, 'shots');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));

// Node fetches the buckets and hands the bytes to the page: the browser has
// no idea about this machine's proxy, node does.
await page.route('**://**', async route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('s3.amazonaws.com')) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'GWCFC shots' } });
      const body = Buffer.from(await r.arrayBuffer());
      return route.fulfill({
        status: r.status,
        contentType: r.headers.get('content-type') || 'application/octet-stream',
        headers: { 'access-control-allow-origin': '*' },
        body,
      });
    } catch { return route.abort(); }
  }
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

const savePng = (name, dataUrl) => {
  if (!dataUrl || !/^data:image\/png;base64,/.test(dataUrl)) return false;
  writeFileSync(join(OUT, name),
    Buffer.from(dataUrl.split(',')[1], 'base64'));
  return true;
};

// ── which sites actually have weather in them right now ────────────────────
// A clear-air radar draws almost nothing, and nothing is not a colour that
// can be judged. Probe a spread of sites and keep the busiest.
async function busiest(cands, product, tilt) {
  const out = [];
  for (const site of cands) {
    const r = await page.evaluate(async ([s, p, t]) => {
      try { _disableL3(); } catch (e) {}
      _prBucketSite = null; _prProduct = p; _prTilt = t;
      try { await _l3BucketShow(s); } catch (e) { return { site: s, px: -1 }; }
      if (typeof _l3Canvas === 'undefined' || !_l3Canvas) return { site: s, px: 0 };
      const S = _l3Canvas.width;
      const d = _l3Canvas.getContext('2d').getImageData(0, 0, S, S).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 10) n++;
      return { site: s, px: n, frac: n / (S * S) };
    }, [site, product, tilt]);
    out.push(r);
    console.log(`   probe ${site} ${product}: ${r.px} painted px`);
  }
  return out.sort((a, b) => b.px - a.px);
}

const NEXRAD_CANDS = (process.env.NEXRAD_SITES
  || 'KTLX,KFWS,KHGX,KLIX,KMLB,KTBW,KAMX,KJAX,KLCH,KEWX').split(',');
const TDWR_CANDS = (process.env.TDWR_SITES
  || 'TDAL,THOU,TMCO,TTPA,TMIA,TIAH,TATL,TDFW').split(',');

console.log('\nprobing NEXRAD sites for active weather');
const nx = await busiest(NEXRAD_CANDS, 'reflectivity', 1);
console.log('\nprobing terminal sites for active weather');
const td = await busiest(TDWR_CANDS, 'reflectivity', 1);

const NEXRAD = (nx[0] && nx[0].px > 0) ? nx[0].site : 'KTLX';
const TDWR = (td[0] && td[0].px > 0) ? td[0].site : 'TDAL';
console.log(`\nusing NEXRAD ${NEXRAD}, terminal ${TDWR}\n`);

// ── the live shots ─────────────────────────────────────────────────────────
const shots = [];
async function shoot(site, product, tilt, tag) {
  const r = await page.evaluate(async ([s, p, t]) => {
    try { _disableL3(); } catch (e) {}
    _prBucketSite = null; _prProduct = p; _prTilt = t;
    const code = _l3BucketCode(s, p, t);
    if (!code) return { code: null, reason: 'not published for this site' };
    try { await _l3BucketShow(s); } catch (e) { return { code, reason: e.message }; }
    if (typeof _l3Canvas === 'undefined' || !_l3Canvas) {
      return { code, reason: 'no canvas' };
    }
    const S = _l3Canvas.width;
    const ctx = _l3Canvas.getContext('2d');
    const d = ctx.getImageData(0, 0, S, S).data;
    let painted = 0;
    const hist = {};
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] <= 10) continue;
      painted++;
      const k = `${d[i]},${d[i + 1]},${d[i + 2]}`;
      hist[k] = (hist[k] || 0) + 1;
    }
    const top = Object.entries(hist).sort((a, b) => b[1] - a[1]).slice(0, 12);
    return {
      code, size: S, painted, colours: Object.keys(hist).length,
      top: top.map(([c, n]) => ({ c, n })),
      png: _l3Canvas.toDataURL('image/png'),
      // What the mesh itself holds, so a colour can be traced to a value.
      stats: (() => {
        const m = _lastMeshData;
        if (!m) return null;
        let lo = Infinity, hi = -Infinity, n = 0;
        for (let i = 8; i < m.length; i += 9) {
          const v = m[i];
          if (v !== v) continue;
          n++; if (v < lo) lo = v; if (v > hi) hi = v;
        }
        return n ? { n, lo, hi } : null;
      })(),
    };
  }, [site, product, tilt]);
  const name = `${tag}-${product}${tilt > 1 ? '-t' + tilt : ''}.png`;
  if (r.png && savePng(name, r.png)) r.file = name;
  delete r.png;
  r.site = site; r.product = product; r.tilt = tilt;
  shots.push(r);
  console.log(`  ${site} ${product} t${tilt}: ${r.code || '-'} `
            + `${r.painted != null ? r.painted + 'px ' + r.colours + ' colours' : r.reason}`);
  return r;
}

console.log('NEXRAD products');
for (const p of ['reflectivity', 'velocity', 'srvelocity', 'corrcoeff',
                 'diffrefl', 'kdp', 'hydroclass', 'echotops']) {
  await shoot(NEXRAD, p, 1, 'nexrad');
}
console.log('\nterminal products');
for (const p of ['reflectivity', 'velocity']) {
  await shoot(TDWR, p, 1, 'tdwr');
}
await shoot(TDWR, 'reflectivity', 5, 'tdwr');   // the long range sweep
console.log('\nterminal, asked for something it cannot make');
await shoot(TDWR, 'corrcoeff', 1, 'tdwr');

// ── the ramps: value to colour, read straight off the canvas ───────────────
console.log('\nbuilding value-to-colour ramps');
const ramps = await page.evaluate(() => {
  const OUT = {};
  const SAMPLE = {
    n0b: { fam: 'ref', vals: [] },
    n0g: { fam: 'vel', vals: [] },
    n0s: { fam: 'vel', vals: [] },
    n0c: { fam: 'cc',  vals: [] },
    n0x: { fam: 'zdr', vals: [] },
    n0k: { fam: 'kdp', vals: [] },
    n0h: { fam: 'hc',  vals: [] },
    eet: { fam: 'et',  vals: [] },
    tz0: { fam: 'ref', vals: [] },
    tv0: { fam: 'vel', vals: [] },
  };
  const steps = (min, max, n) =>
    Array.from({ length: n }, (_, i) => min + (max - min) * i / (n - 1));
  Object.entries(SAMPLE).forEach(([code, s]) => {
    const d = RADAR_FAMS[s.fam];
    s.vals = s.fam === 'hc'
      ? Object.keys(HC_CLASSES).map(Number)
      : steps(d.min, d.max, 45);
  });

  Object.entries(SAMPLE).forEach(([code, s]) => {
    // One row of square gates, each holding one known value, drawn by the
    // same renderer the live picture uses. Reading the middle of each square
    // back gives the colour that value really receives, not the colour the
    // colour table was supposed to give it.
    const site = _meshSiteLatLon('ktlx') || { lat: 35, lon: -95 };
    const N = s.vals.length;
    const arr = [];
    const W = 8 / N;
    s.vals.forEach((v, i) => {
      const x0 = site.lon - 4 + i * W, x1 = x0 + W;
      const y0 = site.lat - 0.5, y1 = site.lat + 0.5;
      arr.push(x0, y0, x1, y0, x1, y1, x0, y1, v);
    });
    const result = {
      meshData: Float32Array.from(arr),
      bounds: [site.lon - 4, site.lat - 4, site.lon + 4, site.lat + 4],
      metadata: { timeIso: '2026-08-22T00:00:00Z' },
    };
    _meshBox = null;
    const img = _meshToImage(result, code,
      [site.lon - 4, site.lat - 4, site.lon + 4, site.lat + 4]);
    if (!img) { OUT[code] = { error: 'nothing drew' }; return; }
    const S = img.canvas.width;
    const ctx = img.canvas.getContext('2d');
    const cy = Math.round(S / 2);
    const rows = s.vals.map((v, i) => {
      const cx = Math.round(S * ((i + 0.5) / N));
      const p = ctx.getImageData(cx, cy, 1, 1).data;
      const hex = p[3] === 0 ? null
        : '#' + [p[0], p[1], p[2]].map(x => x.toString(16).padStart(2, '0')).join('');
      return { v: Math.round(v * 1000) / 1000, hex };
    });
    OUT[code] = { fam: s.fam, rows, png: img.canvas.toDataURL('image/png') };
  });
  return OUT;
});
Object.entries(ramps).forEach(([code, r]) => {
  if (r.png && savePng(`ramp-${code}.png`, r.png)) r.file = `ramp-${code}.png`;
  delete r.png;
});

writeFileSync(join(OUT, 'report.json'),
  JSON.stringify({ nexradSite: NEXRAD, tdwrSite: TDWR,
                   probes: { nexrad: nx, tdwr: td },
                   shots, ramps, errors }, null, 2));
console.log(`\nwrote ${OUT}/report.json and the pngs beside it`);
if (errors.length) console.log('page errors:', errors.slice(0, 3));
await browser.close();
