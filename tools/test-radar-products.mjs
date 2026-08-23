#!/usr/bin/env node
/*
 * Every radar site, every product, every tilt: proven against the decoder.
 *
 *     node tools/test-radar-products.mjs
 *
 * The failure this suite exists to catch is a quiet one. The menu offers a
 * product, the tap fetches a file, the decoder does not know the product
 * code, and the user sees an error popup or, worse, an empty map. That looks
 * exactly like a broken radar and is really a table in index.html claiming
 * something the decoder never agreed to.
 *
 * So the truth here is not written down twice. It is read out of
 * src/parse/level3/src/products, one folder per product, each naming the
 * three letter codes it answers to, and every code index.html offers is
 * checked against that set. If someone adds a product code from memory, this
 * suite fails before a user ever taps it.
 *
 * It also checks the other direction, which is the whole point of the change
 * these tests came with: that the tables are not SHORT. A decoder that can
 * read four tilts of correlation coefficient while the menu offers one is a
 * radar showing a quarter of what it measured.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
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

// ── Ground truth, read off the decoder itself ──────────────────────────────
// Two things have to agree for a product to work: the folder must exist AND
// browser.js must import it, because the browser build has its own explicit
// import list rather than the Node build's readdir. A folder that exists but
// is not imported decodes fine under Node and fails in the page, which is
// the only place that matters.
const PRODUCT_DIR = join(ROOT, 'src/parse/level3/src/products');
const browserSrc = readFileSync(join(ROOT, 'src/parse/level3/src/browser.js'), 'utf8');
const importedCodes = new Set(
  [...browserSrc.matchAll(/products\/(\d+)\/index\.js/g)].map(m => m[1]));

const codeToAbbrs = {};      // '161' -> ['NXC', ... 'N3C']
const abbrToCode = {};       // 'N0C' -> '161'
for (const folder of readdirSync(PRODUCT_DIR)) {
  if (!/^\d+$/.test(folder)) continue;
  if (!importedCodes.has(folder)) continue;
  const file = join(PRODUCT_DIR, folder, 'index.js');
  if (!existsSync(file)) continue;
  const src = readFileSync(file, 'utf8');
  const m = /^const abbreviation = (.+);$/m.exec(src);
  if (!m) continue;
  // Either a bare string ('DAA') or an array of them.
  const abbrs = [...m[1].matchAll(/'([A-Z0-9]+)'/g)].map(x => x[1]);
  codeToAbbrs[folder] = abbrs;
  abbrs.forEach(a => { abbrToCode[a] = folder; });
}

console.log('\n0. the decoder ground truth loaded');
ok('the browser build imports a real set of products',
   importedCodes.size >= 20, `${importedCodes.size} imported`);
ok('and every imported product named its codes',
   Object.keys(codeToAbbrs).length === importedCodes.size,
   `${Object.keys(codeToAbbrs).length} of ${importedCodes.size}`);
ok('correlation coefficient is one of them, at four real tilts',
   ['N0C', 'N1C', 'N2C', 'N3C'].every(a => abbrToCode[a] === '161'));
ok('the terminals long range sweep is one of them',
   abbrToCode.TZL === '186');
ok('the upper velocity tilts live under their own product code',
   abbrToCode.N2U === '99' && abbrToCode.N3U === '99'
   && abbrToCode.N0G === '154');

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'],
});

async function boot() {
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
  return { page, errors };
}

const { page, errors } = await boot();
ok('the page boots clean', errors.length === 0, errors[0]);

const bucket = await page.evaluate(() => JSON.parse(JSON.stringify(PR_BUCKET)));
const tdwrCannot = await page.evaluate(() => TDWR_CANNOT.slice());
const pictureOnly = await page.evaluate(() => PR_PICTURE_ONLY.slice());

console.log('\n1. every code the menu offers is a code the decoder reads');
{
  const offered = [];
  Object.entries(bucket).forEach(([product, fams]) => {
    ['k', 't'].forEach(f => (fams[f] || []).forEach(c => offered.push([product, f, c])));
  });
  ok('the table is not empty', offered.length >= 30, String(offered.length));
  const unknown = offered.filter(([, , c]) => !abbrToCode[c]);
  ok('no code is invented: all of them exist in the decoder',
     unknown.length === 0,
     unknown.map(u => u.join('/')).join(' '));
}

console.log('\n2. the tilt lists are as long as the radar really scans');
{
  // Four antenna cuts of every dual-pol product. These were listed at one
  // each, so three quarters of the dual-pol data the Weather Service
  // publishes was unreachable from this app.
  ['corrcoeff', 'diffrefl', 'kdp', 'hydroclass'].forEach(p => {
    ok(`${p} offers four NEXRAD tilts`, (bucket[p].k || []).length === 4,
       String((bucket[p].k || []).length));
  });
  ok('reflectivity offers four NEXRAD tilts',
     (bucket.reflectivity.k || []).length === 4);
  ok('velocity offers four NEXRAD tilts, across its two product codes',
     (bucket.velocity.k || []).length === 4
     && abbrToCode[bucket.velocity.k[1]] !== abbrToCode[bucket.velocity.k[2]],
     bucket.velocity.k.join(','));
  ok('storm relative velocity is offered at all, at four tilts',
     (bucket.srvelocity && bucket.srvelocity.k || []).length === 4,
     JSON.stringify(bucket.srvelocity));
  ok('the terminals offer four reflectivity tilts plus the long range sweep',
     (bucket.reflectivity.t || []).length === 5
     && bucket.reflectivity.t[4] === 'TZL',
     bucket.reflectivity.t.join(','));
  ok('and four velocity tilts', (bucket.velocity.t || []).length === 4,
     bucket.velocity.t.join(','));
  // No repeats: a list that accidentally names the same file twice looks
  // like two tilts and draws one picture.
  const dupes = [];
  Object.entries(bucket).forEach(([p, fams]) => ['k', 't'].forEach(f => {
    const l = fams[f] || [];
    if (new Set(l).size !== l.length) dupes.push(p + '.' + f);
  }));
  ok('no tilt list repeats a code', dupes.length === 0, dupes.join(' '));
}

console.log('\n3. _l3BucketCode hands back the right file for the right site');
{
  const got = await page.evaluate(() => {
    const out = {};
    ['KTLX', 'KOUN', 'TJUA', 'TDAL', 'TJFK'].forEach(site => {
      out[site] = {};
      Object.keys(PR_BUCKET).forEach(p => {
        out[site][p] = [1, 2, 3, 4, 5].map(t => _l3BucketCode(site, p, t));
      });
    });
    return out;
  });
  ok('a NEXRAD walks its four correlation tilts in order',
     got.KTLX.corrcoeff.slice(0, 4).join(',') === 'N0C,N1C,N2C,N3C',
     got.KTLX.corrcoeff.join(','));
  ok('velocity crosses product codes without the caller noticing',
     got.KTLX.velocity.slice(0, 4).join(',') === 'N0G,N1G,N2U,N3U',
     got.KTLX.velocity.join(','));
  ok('a terminal walks four tilts and then the long range sweep',
     got.TDAL.reflectivity.join(',') === 'TZ0,TZ1,TZ2,TZ3,TZL',
     got.TDAL.reflectivity.join(','));
  ok('a terminal is not offered dual-pol it cannot measure',
     got.TDAL.corrcoeff.every(c => c === null));
  // The one WSR-88D whose id starts with T. Judged by the letter it would be
  // handed terminal codes it does not publish, which is Puerto Rico missing.
  ok('TJUA is read as the NEXRAD it is, not as a terminal',
     got.TJUA.corrcoeff[0] === 'N0C' && got.TJUA.reflectivity[0] === 'N0B',
     `${got.TJUA.corrcoeff[0]} ${got.TJUA.reflectivity[0]}`);
  ok('a tilt past the end clamps to the last real one rather than failing',
     got.KTLX.corrcoeff[4] === 'N3C', String(got.KTLX.corrcoeff[4]));
  ok('a product with no raw feed answers null rather than a guess',
     await page.evaluate(() => _l3BucketCode('KTLX', 'vil', 1) === null
                            && _l3BucketCode('KTLX', 'composite', 1) === null));
}

console.log('\n4. _prSiteCanMake tells the truth before anything is fetched');
{
  const r = await page.evaluate((cannot) => {
    const prods = Object.keys(PR_PRODUCTS);
    return {
      nexrad: prods.filter(p => _prSiteCanMake('KTLX', p)),
      tdwr: prods.filter(p => _prSiteCanMake('TDAL', p)),
      tjua: prods.filter(p => _prSiteCanMake('TJUA', p)),
      cannot,
    };
  }, tdwrCannot);
  ok('a NEXRAD can make all nine bucket products',
     r.nexrad.length === Object.keys(bucket).length, r.nexrad.join(','));
  ok('a terminal can make reflectivity and velocity, and nothing else',
     r.tdwr.slice().sort().join(',') === 'reflectivity,velocity',
     r.tdwr.join(','));
  ok('TJUA is treated as a NEXRAD here too',
     r.tjua.length === r.nexrad.length, r.tjua.join(','));
  ok('every product a terminal cannot make is one the tables list as such',
     tdwrCannot.every(p => !r.tdwr.includes(p)));
  ok('the picture-only products are refused for every site',
     pictureOnly.every(p => !r.nexrad.includes(p) && !r.tdwr.includes(p)),
     pictureOnly.join(','));
}

console.log('\n5. every offered code has a family and a colour');
{
  // The bug class this pins: a code that decodes fine, reaches the renderer,
  // matches no family, gets no colour function, and paints an empty picture.
  const bad = await page.evaluate(() => {
    const out = { noFam: [], noColor: [] };
    // Values a real sweep of each family actually contains. Sampling a blind
    // fraction of the range is not the same thing: the hydrometeor
    // classifier's range runs to 160 but 120 and 130 are reserved slots the
    // Weather Service never assigns, so nothing is meant to paint there.
    const SAMPLES = {
      ref: [10, 35, 60],
      vel: [-60, -20, 20, 60],
      cc:  [0.7, 0.92, 0.98],
      zdr: [-2, 0.5, 4],
      kdp: [1, 3, 6],
      hc:  Object.keys(HC_COLORS).map(Number),
      et:  [15, 35, 55],
      sw:  [2, 6, 12],
    };
    Object.values(PR_BUCKET).forEach(fams => ['k', 't'].forEach(f => {
      (fams[f] || []).forEach(code => {
        const c = code.toLowerCase();
        const fam = _meshFamily(c);
        if (!fam) { out.noFam.push(code); return; }
        const fn = _meshColorFn(c);
        (SAMPLES[fam] || [1]).forEach(v => {
          if (!fn || !fn(v)) out.noColor.push(code + '@' + v);
        });
      });
    }));
    return out;
  });
  ok('no offered code falls outside the family map', bad.noFam.length === 0,
     bad.noFam.join(','));
  ok('no offered code paints nothing at a real value',
     bad.noColor.length === 0, bad.noColor.join(','));
  // The hydrometeor classifier is a list of named things, not a slope, so
  // "every class the table names gets a colour" is the whole check.
  const hc = await page.evaluate(() => {
    const fn = _meshColorFn('n2h');
    return Object.keys(HC_CLASSES).filter(k => !fn(Number(k)));
  });
  ok('every named hydrometeor class paints on an upper tilt too',
     hc.length === 0, hc.join(','));
}

console.log('\n5b. the colour scales cover the values real sweeps actually hold');
{
  // Every number below was measured off live Level 3 files, not guessed.
  // A scale that discards the range its product actually lives in draws an
  // empty map, and an empty map is indistinguishable from a broken feed.
  const r = await page.evaluate(() => {
    const kdp = _meshColorFn('n0k');
    const vel = _meshColorFn('n0g');
    const cc = _meshColorFn('n0c');
    return {
      // Measured at KMLB in a full rain shield: median 0, 90th percentile
      // 0.15, heavy cores 1 to 4. The old scale drew nothing under 0.8.
      kdpOrdinary: [0, 0.05, 0.15, 0.3, 0.5].map(v => kdp(v)),
      kdpHeavy: [1, 2, 3, 4].map(v => kdp(v)),
      kdpNegative: [-1.5, -0.6].map(v => kdp(v)),
      kdpDistinct: new Set([0, 0.2, 0.4, 0.7, 1, 1.5, 2, 2.6, 3.4, 4.5]
        .map(v => kdp(v))).size,
      // The median gate of a live velocity sweep is about 2 kt. The old
      // dead zone was 5 kt either side, so the commonest reading was a hole.
      velNearZero: [-4, -2, 2, 4].map(v => vel(v)),
      velIsodop: [-0.5, 0, 0.5].map(v => vel(v)),
      // Nearly a tenth of a live CC sweep encodes above 1.0.
      ccTop: [0.995, 1.01, 1.05].map(v => cc(v)),
    };
  });
  ok('ordinary KDP paints, all of it',
     r.kdpOrdinary.every(c => c), JSON.stringify(r.kdpOrdinary));
  ok('and heavy KDP paints', r.kdpHeavy.every(c => c), JSON.stringify(r.kdpHeavy));
  ok('and negative KDP, which the file really carries, paints too',
     r.kdpNegative.every(c => c), JSON.stringify(r.kdpNegative));
  ok('KDP spreads its range over many colours rather than a few',
     r.kdpDistinct >= 8, String(r.kdpDistinct));
  ok('velocity paints the gates either side of the isodop',
     r.velNearZero.every(c => c), JSON.stringify(r.velNearZero));
  ok('and the blank zero line is only a knot wide',
     r.velIsodop.every(c => c === null), JSON.stringify(r.velIsodop));
  ok('CC above 1.0 is not painted brilliant white',
     r.ccTop.every(c => c && c.toLowerCase() !== '#fdfdfd'),
     JSON.stringify(r.ccTop));
  ok('and it reads as the top of the rain run, not a separate alarm',
     r.ccTop[1] === r.ccTop[2], JSON.stringify(r.ccTop));
}

console.log('\n5c. no palette resolves finer than its own product noise');
{
  // The rule this encodes, learned the hard way from correlation
  // coefficient: if neighbouring colour bands are closer together than the
  // product's gate-to-gate wobble, a smooth field renders as confetti.
  //
  // CC wobbles about 0.017 between adjacent gates in rain, measured on live
  // sweeps at KMLB, KJAX and KTBW. The old table put six high-contrast bands
  // in the 0.05 above 0.95, so rain crossed three or four of them on noise
  // alone and a solid rain shaft came out a red, yellow, green and cyan
  // checkerboard.
  const r = await page.evaluate(() => {
    const dist = (a, b) => {
      const h = s => [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16));
      if (!a || !b || a[0] !== '#' || b[0] !== '#') return null;
      const x = h(a), y = h(b);
      return Math.abs(x[0]-y[0]) + Math.abs(x[1]-y[1]) + Math.abs(x[2]-y[2]);
    };
    // Adjacent pairs from 0.94 up, which is ordinary precipitation and where
    // nearly every gate in a rain sweep lands.
    const rain = CC_BANDS.filter(b => b[0] >= 0.93 && b[1]);
    const steps = [];
    for (let i = 1; i < rain.length; i++) {
      steps.push({ from: rain[i-1][0], to: rain[i][0],
                   d: dist(rain[i-1][1], rain[i][1]) });
    }
    return {
      steps,
      worst: Math.max(...steps.map(s => s.d)),
      bandsInRain: rain.length,
      // The low end must keep its contrast: that is where CC earns its keep.
      debrisVsRain: dist(_meshColorFn('n0c')(0.70), _meshColorFn('n0c')(0.99)),
    };
  });
  ok('neighbouring bands in the rain range stay visually close',
     r.worst <= 90, `worst step ${r.worst}, ${JSON.stringify(r.steps)}`);
  ok('while still resolving the rain range into several steps',
     r.bandsInRain >= 6, String(r.bandsInRain));
  ok('and debris still looks nothing like rain',
     r.debrisVsRain > 200, String(r.debrisVsRain));
}


console.log('\n5d. resolution is at least as fine as the data');
{
  // Radar was capped at 1600 px, and a 460 km sweep is 920 km across: 575 m
  // a pixel, more than twice the 250 m gate it is drawing. The far half of
  // every long-range sweep was thrown away before it reached the screen.
  const r = await page.evaluate(() => {
    const src = String(_meshToImage);
    const cap = /MESH_MAX_PX\s*=\s*_devGB/.test(src);
    const target = /TARGET_KM_PER_PX\s*=\s*([\d.]+)/.exec(src);
    return {
      deviceAware: cap,
      target: target ? Number(target[1]) : null,
      // Big desktop numbers, since that is where the ceiling matters.
      hasBigCeiling: /3072|2560/.test(src),
    };
  });
  ok('the pixel ceiling is chosen from the device, not fixed', r.deviceAware);
  ok('and reaches past 1600 on a machine that can hold it', r.hasBigCeiling);
  ok('the target is at least as fine as a 250 m gate',
     r.target !== null && r.target <= 0.25, String(r.target));
}

console.log('\n5e. satellite is treated as a photograph, radar as data');
{
  const r = await page.evaluate(() => {
    const src = String(_makeGoesLayer);
    const css = [...document.styleSheets].flatMap(sh => {
      try { return [...sh.cssRules].map(x => x.cssText); } catch (e) { return []; }
    }).join('\n');
    return {
      retina: /detectRetina:\s*true/.test(src),
      photoClass: /wx-photo/.test(src),
      photoSmooth: /\.wx-photo[^{]*\{[^}]*image-rendering:\s*(auto|smooth|high-quality)/
        .test(css.replace(/\s+/g, ' ')),
      radarCrisp: /image-rendering:\s*pixelated/.test(css),
    };
  });
  ok('satellite asks for high-density tiles', r.retina);
  ok('and is marked as imagery so it is smoothed', r.photoClass);
  ok('the smoothing rule really exists', r.photoSmooth);
  ok('while radar stays crisp, because its bands mean something', r.radarCrisp);
}

console.log('\n5f. the menu believes the site over the table');
{
  const r = await page.evaluate(() => {
    // Pretend the probe came back saying this NEXRAD only has reflectivity,
    // which is what a site part way through maintenance looks like.
    _l3Avail.set('KTEST', { at: Date.now(), done: true,
                            set: new Set(['reflectivity']) });
    const offered = Object.keys(PR_PRODUCTS).filter(p => _prSiteCanMake('KTEST', p));
    // And a site nobody has probed still gets the full table.
    const unprobed = Object.keys(PR_PRODUCTS).filter(p => _prSiteCanMake('KNEW', p));
    // A site that answered with nothing offers nothing.
    _l3Avail.set('KDEAD', { at: Date.now(), done: true, set: new Set() });
    const dead = Object.keys(PR_PRODUCTS).filter(p => _prSiteCanMake('KDEAD', p));
    return { offered, unprobed: unprobed.length, dead: dead.length };
  });
  ok('a probed site offers only what it publishes',
     r.offered.join(',') === 'reflectivity', r.offered.join(','));
  ok('an unprobed site still offers the whole family, so a network problem '
     + 'cannot empty the menu', r.unprobed >= 8, String(r.unprobed));
  ok('and a site publishing nothing offers nothing', r.dead === 0, String(r.dead));
}

console.log('\n6. storm relative velocity is not converted twice');
{
  // The worker turns product 56's four bit codes into knots itself. Running
  // the metres-per-second conversion over the result as well would report a
  // 40 kt couplet as 78 kt, which is the difference between a note and a
  // warning.
  const r = await page.evaluate(() => {
    const mk = () => {
      const a = new Float32Array(9);
      a[8] = 40;
      return a;
    };
    const out = {};
    ['n0s', 'n1s', 'n0g', 'n2u', 'tv0'].forEach(c => {
      const m = mk(); _l3MeshNormalize(m, c); out[c] = m[8];
    });
    return out;
  });
  ok('storm relative velocity is left in the knots it already had',
     r.n0s === 40 && r.n1s === 40, `${r.n0s} ${r.n1s}`);
  ok('base velocity is still converted from metres per second',
     Math.abs(r.n0g - 77.75) < 0.1, String(r.n0g));
  ok('the upper velocity tilts are converted too',
     Math.abs(r.n2u - 77.75) < 0.1, String(r.n2u));
  ok('and the terminals velocity is converted',
     Math.abs(r.tv0 - 77.75) < 0.1, String(r.tv0));
}

console.log('\n7. the menu shows what the chosen radar can really do');
{
  const shot = await page.evaluate(async (site) => {
    _prBucketSite = site;
    _prOn = true;
    _prProduct = 'reflectivity';
    _prTilt = 1;
    _prRenderPiRow('l3');
    const row = document.getElementById('sub-bubbles');
    const bubbles = [...row.querySelectorAll('.sub-bubble')].map(el => ({
      id: el.id,
      out: el.classList.contains('unavailable'),
      title: el.title || '',
    }));
    const chips = [...row.querySelectorAll('.tilt-chip')].map(c => ({
      text: c.textContent, cut: c.dataset.cut,
      on: c.classList.contains('active'),
    }));
    return { bubbles, chips };
  }, 'TDAL');
  const byId = Object.fromEntries(shot.bubbles.map(b => [b.id, b]));
  ok('a terminal marks correlation coefficient as unavailable',
     byId['sub-pi-corrcoeff'] && byId['sub-pi-corrcoeff'].out === true);
  ok('and marks the rest of the dual-pol set the same way',
     ['diffrefl', 'kdp', 'hydroclass'].every(p =>
       byId['sub-pi-' + p] && byId['sub-pi-' + p].out === true));
  ok('and says why on the tooltip rather than leaving it a mystery',
     /does not publish/.test((byId['sub-pi-corrcoeff'] || {}).title || ''),
     (byId['sub-pi-corrcoeff'] || {}).title);
  ok('reflectivity and velocity are not marked out',
     byId['sub-pi-reflectivity'] && byId['sub-pi-reflectivity'].out === false
     && byId['sub-pi-velocity'] && byId['sub-pi-velocity'].out === false);
  ok('a terminal shows five reflectivity chips', shot.chips.length === 5,
     JSON.stringify(shot.chips));
  ok('the fifth reads LR, not 5, because it is not a fifth angle',
     shot.chips.length === 5 && shot.chips[4].text === 'LR'
     && shot.chips[4].cut === '5',
     JSON.stringify(shot.chips[4]));
  ok('exactly one chip is marked active',
     shot.chips.filter(c => c.on).length === 1);
}

console.log('\n8. the same row for a NEXRAD offers everything');
{
  const shot = await page.evaluate(() => {
    _prBucketSite = 'KTLX';
    _prOn = true;
    _prProduct = 'corrcoeff';
    _prTilt = 1;
    _prRenderPiRow('l3');
    const row = document.getElementById('sub-bubbles');
    return {
      out: [...row.querySelectorAll('.sub-bubble.unavailable')].map(e => e.id),
      chips: [...row.querySelectorAll('.tilt-chip')].map(c => c.textContent),
    };
  });
  ok('nothing with a raw feed is marked out at a NEXRAD',
     Object.keys(bucket).every(p => !shot.out.includes('sub-pi-' + p)),
     shot.out.join(','));
  ok('correlation coefficient now offers four tilts, not one',
     shot.chips.join(',') === '1,2,3,4', shot.chips.join(','));
}

console.log('\n9. clicking a chip marks the one that was clicked');
{
  // The active mark used to be set by matching the chip's own text against
  // the cut number. The moment a chip is labelled LR that comparison can
  // never be true, so the long range sweep would draw with no chip lit.
  const r = await page.evaluate(async () => {
    _prBucketSite = 'TDAL';
    _prOn = true; _prProduct = 'reflectivity'; _prTilt = 1;
    _prRenderPiRow('l3');
    const row = document.getElementById('sub-bubbles');
    const chips = [...row.querySelectorAll('.tilt-chip')];
    // Fire the handler without letting it reach the network.
    const realShow = window._l3BucketShow;
    window._l3BucketShow = async () => {};
    await chips[4].onclick({ stopPropagation() {} });
    window._l3BucketShow = realShow;
    return {
      tilt: _prTilt,
      lit: chips.filter(c => c.classList.contains('active'))
               .map(c => c.dataset.cut),
    };
  });
  ok('the long range chip sets tilt 5', r.tilt === 5, String(r.tilt));
  ok('and it is the only chip lit', r.lit.join(',') === '5', r.lit.join(','));
}

console.log('\n10. a remembered tilt cannot outrun the product');
{
  const r = await page.evaluate(() => {
    _prBucketSite = 'TDAL';
    _prOn = true; _prProduct = 'reflectivity'; _prTilt = 5;
    _prRenderPiRow('l3');
    // Now to velocity, which has four cuts and no long range sweep.
    _prProduct = 'velocity';
    _prRenderPiRow('l3');
    const row = document.getElementById('sub-bubbles');
    const chips = [...row.querySelectorAll('.tilt-chip')];
    return { tilt: _prTilt, chips: chips.length,
             lit: chips.filter(c => c.classList.contains('active')).length };
  });
  ok('the tilt is pulled back to one the product has', r.tilt === 4,
     String(r.tilt));
  ok('and a chip is still lit', r.lit === 1 && r.chips === 4,
     `${r.lit} of ${r.chips}`);
}

console.log('\n11. tilt 5 survives a reload');
{
  // The remembered tilt was thrown away above 4, so picking the terminals
  // long range sweep and coming back landed on the lowest cut instead.
  const p2 = await browser.newPage();
  await p2.addInitScript(() => localStorage.setItem('gwcfc_pr_tilt', '5'));
  await p2.route('**://**', route => {
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
  await p2.goto('file://' + join(ROOT, 'index.html'),
                { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(3000);
  const t = await p2.evaluate(() => _prTilt);
  ok('a remembered tilt of 5 is kept', t === 5, String(t));
  await p2.close();
}

console.log('\n12. nothing threw along the way');
ok('no uncaught errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
