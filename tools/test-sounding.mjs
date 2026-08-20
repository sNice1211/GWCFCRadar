#!/usr/bin/env node
/*
 * The sounding: the meteorology, then the chart.
 *
 *     node tools/test-sounding.mjs
 *
 * What was there before was a temperature line in a 320px box. This is a real
 * sounding - skew-T, hodograph, parcel theory, shear and helicity - and all of
 * it is worked out in the browser from the four fields the Pi ships.
 *
 * That makes it the most testable thing in the app and also the most dangerous
 * to get subtly wrong: a CAPE that is out by a factor, a helicity with the
 * wrong sign, or heights taken from a standard atmosphere instead of the
 * profile would all draw a chart that looks completely normal and says the
 * wrong thing about whether a storm can rotate.
 *
 * So the physics is checked against values that are known independently - a
 * dry adiabat's own definition, a saturated profile having no CAPE, a
 * textbook LCL, a hodograph whose helicity can be worked out by hand - rather
 * than against whatever the code happens to return.
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
await page.waitForTimeout(4200);
await page.evaluate(() => { if (typeof closeTutorial === 'function') closeTutorial(); });

console.log('\n1. the thermodynamics agree with values known independently');
{
  const r = await page.evaluate(() => {
    // Saturation vapour pressure at 0 C is 6.11 hPa and at 20 C about 23.4.
    // Both are printed in every textbook, so they check the formula rather
    // than the code's own opinion of itself.
    const es0 = _sndEs(0), es20 = _sndEs(20);
    // A dry adiabat is defined by its own equation, so lifting 1000 to 700 mb
    // and bringing it back must land where it started.
    const up = _sndDryLapse(700, 30, 1000);
    const back = _sndDryLapse(1000, up, 700);
    // Saturated air has its LCL at the surface.
    const lclSat = _sndLCL(1000, 20, 20);
    // 30 over 15 at 1000 mb. Espy's rule of thumb puts the LCL at roughly
    // 125 m per degree of spread, so 15 degrees is about 1875 m, which is a
    // shade over 800 mb. That is an independent number to check against
    // rather than whatever this code happens to return.
    const lclDry = _sndLCL(1000, 30, 15);
    const espyM = 125 * (30 - 15);
    // A moist adiabat is shallower than a dry one, always.
    const moist = _sndMoistStep(1000, 25, -50);
    const dry = _sndDryLapse(950, 25, 1000);
    return { es0, es20, up, back, lclSat, lclDry, moist, dry };
  });
  ok('saturation vapour pressure at 0 C is 6.1 hPa',
     Math.abs(r.es0 - 6.11) < 0.05, r.es0.toFixed(3));
  ok('and at 20 C is about 23.4 hPa',
     Math.abs(r.es20 - 23.4) < 0.4, r.es20.toFixed(2));
  ok('a dry adiabat is reversible: up and back returns the start',
     Math.abs(r.back - 30) < 0.01, `${r.up.toFixed(2)} -> ${r.back.toFixed(4)}`);
  ok('saturated air condenses immediately, so its LCL is the surface',
     Math.abs(r.lclSat.p - 1000) < 5, r.lclSat.p.toFixed(1));
  ok('30 over 15 at the surface puts the LCL near 800 mb, which is where '
     + `Espy's ${r.espyM} m rule of thumb puts it too`,
     r.lclDry.p > 780 && r.lclDry.p < 830, r.lclDry.p.toFixed(1));
  ok('a moist adiabat is shallower than a dry one, because condensation '
     + 'releases heat', r.moist > r.dry, `${r.moist.toFixed(2)} vs ${r.dry.toFixed(2)}`);
}

console.log('\n2. heights come from the profile, not from a standard atmosphere');
{
  const r = await page.evaluate(() => {
    const cold = [{ p: 1000, t: -20 }, { p: 850, t: -25 }, { p: 700, t: -30 },
                  { p: 500, t: -45 }];
    const warm = [{ p: 1000, t: 30 }, { p: 850, t: 20 }, { p: 700, t: 10 },
                  { p: 500, t: -8 }];
    _sndHeights(cold); _sndHeights(warm);
    return {
      cold500: cold[3].z, warm500: warm[3].z,
      sfcCold: cold[0].z, sfcWarm: warm[0].z,
    };
  });
  ok('the surface is zero by definition', r.sfcCold === 0 && r.sfcWarm === 0);
  ok('500 mb over a warm column is higher than over a cold one, which is the '
     + 'whole point of doing it this way',
     r.warm500 > r.cold500 + 500, `${r.warm500.toFixed(0)} vs ${r.cold500.toFixed(0)}`);
  ok('and both land in a physically sane range for 500 mb',
     r.cold500 > 4000 && r.warm500 < 7000,
     `${r.cold500.toFixed(0)}, ${r.warm500.toFixed(0)}`);
}

console.log('\n3. CAPE is zero where it should be and large where it should be');
{
  const r = await page.evaluate(() => {
    // An isothermal, saturated column cannot be unstable: a parcel lifted in
    // it is never warmer than what surrounds it.
    const stable = [];
    for (let p = 1000; p >= 200; p -= 50) stable.push({ p, t: 10, rh: 100, u: 0, v: 0 });
    const stableD = _sndDerive({ levels: stable });

    // A steep, humid profile is the classic big-CAPE sounding.
    const juicy = [
      { p: 1000, t: 30, rh: 80, u: 5, v: 5 },
      { p: 925, t: 24, rh: 80, u: 10, v: 8 },
      { p: 850, t: 19, rh: 70, u: 15, v: 10 },
      { p: 700, t: 8, rh: 55, u: 22, v: 12 },
      { p: 600, t: -1, rh: 45, u: 28, v: 12 },
      { p: 500, t: -12, rh: 40, u: 35, v: 10 },
      { p: 400, t: -25, rh: 35, u: 45, v: 8 },
      { p: 300, t: -42, rh: 30, u: 55, v: 5 },
      { p: 250, t: -52, rh: 25, u: 60, v: 3 },
      { p: 200, t: -56, rh: 20, u: 62, v: 0 },
    ];
    const juicyD = _sndDerive({ levels: juicy });

    // The same profile with a cold, dry surface layer: capped, so a surface
    // parcel goes nowhere while something above it still can.
    const capped = JSON.parse(JSON.stringify(juicy));
    capped[0].t = 14; capped[0].rh = 40;
    capped[1].t = 22;
    const cappedD = _sndDerive({ levels: capped });

    return {
      stableCape: stableD.sb.cape,
      cape: juicyD.sb.cape, cin: juicyD.sb.cin,
      lclZ: juicyD.sb.lclZ, lfcZ: juicyD.sb.lfcZ, elZ: juicyD.sb.elZ,
      elAboveTop: juicyD.sb.elAboveTop,
      mlCape: juicyD.ml.cape, muCape: juicyD.mu.cape,
      cappedSb: cappedD.sb.cape, cappedMu: cappedD.mu.cape,
      cappedCin: cappedD.sb.cin,
    };
  });
  ok('a saturated isothermal column has no CAPE at all',
     r.stableCape < 1, r.stableCape.toFixed(2));
  ok('a steep humid profile has a lot', r.cape > 1500, r.cape.toFixed(0));
  ok('and not an absurd amount, which is what a units slip looks like',
     r.cape < 8000, r.cape.toFixed(0));
  ok('CIN is negative or zero, never positive', r.cin <= 0, r.cin.toFixed(0));
  ok('the LCL is below the LFC, which is below the EL',
     r.lclZ < r.lfcZ + 1 && r.lfcZ < r.elZ,
     JSON.stringify([r.lclZ, r.lfcZ, r.elZ].map(x => x && x.toFixed(0))));
  ok('the equilibrium level is up near the tropopause',
     r.elZ > 9000, r.elZ && r.elZ.toFixed(0));
  ok('and a parcel still buoyant at the top level is flagged as reaching '
     + 'past the sounding rather than reported as having no EL',
     r.elAboveTop === true, String(r.elAboveTop));
  ok('the mixed-layer parcel is not more unstable than the surface one',
     r.mlCape <= r.cape + 1, `${r.mlCape.toFixed(0)} vs ${r.cape.toFixed(0)}`);
  ok('the most-unstable parcel is at least as unstable as the surface one',
     r.muCape >= r.cape - 1, `${r.muCape.toFixed(0)} vs ${r.cape.toFixed(0)}`);
  ok('a capped profile kills the surface parcel', r.cappedSb < r.cape / 2,
     `${r.cappedSb.toFixed(0)} vs ${r.cape.toFixed(0)}`);
  ok('but the most-unstable parcel still finds the instability above the cap',
     r.cappedMu > r.cappedSb, `${r.cappedMu.toFixed(0)} vs ${r.cappedSb.toFixed(0)}`);
}

console.log('\n4. shear and helicity are worked out, not guessed');
{
  const r = await page.evaluate(() => {
    // A hodograph that curves anticyclonically in the low levels: the classic
    // shape, and one whose helicity has a definite sign.
    // A hodograph with a real low-level turn in it: southeasterly at the
    // surface swinging round to westerly aloft, which is the shape a
    // tornadic environment has.
    const rows = [
      { p: 1000, t: 25, rh: 70, u: 4, v: -10 },
      { p: 925, t: 20, rh: 70, u: 14, v: -12 },
      { p: 850, t: 16, rh: 65, u: 24, v: -8 },
      { p: 700, t: 6, rh: 55, u: 34, v: 2 },
      { p: 600, t: -2, rh: 50, u: 40, v: 10 },
      { p: 500, t: -14, rh: 45, u: 46, v: 16 },
      { p: 400, t: -28, rh: 40, u: 54, v: 20 },
      { p: 300, t: -44, rh: 35, u: 62, v: 22 },
    ];
    const d = _sndDerive({ levels: rows });
    // Straight-line hodograph. The usual shorthand is "no helicity", but that
    // is only true when the storm motion sits ON the hodograph: Bunkers puts
    // it off to one side by design, so some helicity is correct. What must
    // hold is that a storm moving along the line itself sees none.
    const straight = rows.map((r, i) => ({ ...r, u: i * 8, v: 0 }));
    const sd = _sndDerive({ levels: straight });
    const onLine = _sndSRH(sd.rows, 0, 3000, { u: 20, v: 0 });
    // Reversing the turning must flip the sign of the helicity.
    const mirror = rows.map(r => ({ ...r, v: -r.v }));
    const md = _sndDerive({ levels: mirror });
    return {
      shear1: d.shear1, shear3: d.shear3, shear6: d.shear6,
      srh1: d.srh1, srh3: d.srh3,
      rm: d.motion.right, lm: d.motion.left, mean: d.motion.mean,
      straightSrh: sd.srh3, straightOnLine: onLine,
      mirrorSrh: md.srh1,
      stp: d.stp, scp: d.scp,
    };
  });
  ok('shear grows with the depth of the layer',
     r.shear1 < r.shear3 && r.shear3 < r.shear6,
     JSON.stringify([r.shear1, r.shear3, r.shear6].map(x => x && x.toFixed(1))));
  ok('0-6 km shear over this hodograph is strong, as drawn',
     r.shear6 > 40, r.shear6.toFixed(1));
  ok('the right mover and the left mover sit either side of the mean wind',
     Math.abs((r.rm.u + r.lm.u) / 2 - r.mean.u) < 0.01
     && Math.abs((r.rm.v + r.lm.v) / 2 - r.mean.v) < 0.01, JSON.stringify(r));
  ok('and they are 15 m/s apart, which is what Bunkers says',
     Math.abs(Math.hypot(r.rm.u - r.lm.u, r.rm.v - r.lm.v) - 15 * 1.94384) < 0.5,
     Math.hypot(r.rm.u - r.lm.u, r.rm.v - r.lm.v).toFixed(2));
  ok('a curved hodograph gives real helicity', Math.abs(r.srh3) > 50,
     r.srh3.toFixed(0));
  ok('0-3 km helicity is at least as large as 0-1 km, being a deeper layer',
     Math.abs(r.srh3) >= Math.abs(r.srh1) - 1,
     `${r.srh1.toFixed(0)} / ${r.srh3.toFixed(0)}`);
  ok('a storm moving along a straight hodograph sees no helicity at all',
     Math.abs(r.straightOnLine) < 1, r.straightOnLine.toFixed(3));
  ok('while the right mover off that same line does see some, as it should',
     Math.abs(r.straightSrh) > 1, r.straightSrh.toFixed(1));
  ok('mirroring the turning flips the sign',
     Math.sign(r.mirrorSrh) === -Math.sign(r.srh1) || Math.abs(r.srh1) < 1,
     `${r.srh1.toFixed(0)} -> ${r.mirrorSrh.toFixed(0)}`);
  ok('the composites come out as numbers rather than as nothing',
     isFinite(r.stp) && isFinite(r.scp), JSON.stringify([r.stp, r.scp]));
}

console.log('\n5. precipitable water and lapse rates read in the right units');
{
  const r = await page.evaluate(() => {
    // A real temperature profile, not a linear-in-pressure one: the old
    // fixture had 9 C at 200 mb, which is forty degrees too warm and made the
    // column hold a physically impossible amount of water.
    const tAt = (p) => p >= 850 ? 25 - (1000 - p) * 0.045
                     : p >= 250 ? 18.3 - (850 - p) * 0.093 : -55;
    const humid = [];
    for (let p = 1000; p >= 200; p -= 50)
      humid.push({ p, t: tAt(p), rh: 95, u: 0, v: 0 });
    const dry = humid.map(x => ({ ...x, rh: 5 }));
    const dh = _sndDerive({ levels: humid }), dd = _sndDerive({ levels: dry });
    return { humid: dh.pwat, dry: dd.pwat, lr: dh.lr03 };
  });
  ok('a nearly saturated column carries tens of millimetres of water',
     r.humid > 30 && r.humid < 90, r.humid.toFixed(1));
  ok('a desert-dry one carries almost none', r.dry < 4, r.dry.toFixed(2));
  ok('and the humid one carries far more than the dry one',
     r.humid > r.dry * 5, `${r.humid.toFixed(1)} vs ${r.dry.toFixed(1)}`);
  ok('lapse rates land in degrees per kilometre, not per metre',
     r.lr > 1 && r.lr < 12, r.lr.toFixed(2));
}

console.log('\n6. the skew really skews');
{
  const r = await page.evaluate(() => {
    // The defining property: an isotherm leans right going up the chart. If
    // the skew were dropped this would be a vertical line and the chart would
    // be a plain temperature plot wearing a sounding's name.
    const bot = _sndSkewXY(400, 500, 0, 1000);
    const top = _sndSkewXY(400, 500, 0, 200);
    const hot = _sndSkewXY(400, 500, 20, 1000);
    return { bot, top, hot };
  });
  ok('pressure decreases upward on the chart', r.top.y < r.bot.y,
     JSON.stringify([r.bot.y, r.top.y]));
  ok('an isotherm leans right as it rises, which is the skew',
     r.top.x > r.bot.x + 20, JSON.stringify([r.bot.x, r.top.x]));
  ok('warmer is further right at the same level', r.hot.x > r.bot.x,
     JSON.stringify([r.bot.x, r.hot.x]));
}

console.log('\n7. the panel is a full sounding, not a box in the corner');
{
  const r = await page.evaluate(async () => {
    // Stand in a profile so the panel can be driven without a Pi.
    const rows = [
      { p: 1000, t: 29, rh: 78, u: 4, v: 2 }, { p: 925, t: 23, rh: 76, u: 10, v: -4 },
      { p: 850, t: 18, rh: 68, u: 20, v: -2 }, { p: 700, t: 7, rh: 55, u: 30, v: 6 },
      { p: 600, t: -2, rh: 48, u: 36, v: 10 }, { p: 500, t: -13, rh: 42, u: 44, v: 14 },
      { p: 400, t: -27, rh: 36, u: 52, v: 16 }, { p: 300, t: -43, rh: 30, u: 60, v: 18 },
      { p: 250, t: -53, rh: 25, u: 64, v: 18 }, { p: 200, t: -57, rh: 20, u: 66, v: 16 },
    ];
    _sndManifest = { hours: [0, 6, 12, 18, 24], run: '2026082012' };
    window._sndProfile = async (lat, lon, fhr) =>
      ({ hour: fhr || 0, run: '2026082012', lat, lon, levels: rows });
    await openSounding(35.4, -97.6);
    await new Promise(r => setTimeout(r, 300));
    const el = document.getElementById('snd-panel');
    const b = el.getBoundingClientRect();
    const sk = el.querySelector('#snd-skewt');
    const ho = el.querySelector('#snd-hodo');
    const tbl = el.querySelector('.snd-tables');
    return {
      open: el.classList.contains('open'),
      full: b.width >= innerWidth - 2 && b.height >= innerHeight - 2,
      skewSized: sk.width > 100 && sk.height > 100,
      hodoSized: ho.width > 100 && ho.height > 100,
      tables: tbl.querySelectorAll('table').length,
      headers: [...tbl.querySelectorAll('th')].map(t => t.textContent),
      body: tbl.textContent,
      where: el.querySelector('.snd-where').textContent,
      hourLbl: el.querySelector('.snd-hour-lbl').textContent,
      hourMax: +el.querySelector('.snd-hour').max,
    };
  });
  ok('the panel opens', r.open);
  ok('and fills the screen instead of being a 320px box', r.full, JSON.stringify(r));
  ok('the skew-T canvas is really sized and drawn', r.skewSized);
  ok('so is the hodograph', r.hodoSized);
  ok('there are four parameter tables', r.tables === 4, String(r.tables));
  ok('covering parcels, wind, thermodynamics and composites',
     ['Parcel', 'Wind', 'Thermodynamics', 'Composites'].every(
       h => r.headers.some(x => x.includes(h))), JSON.stringify(r.headers));
  ok('all three parcels are listed',
     /SB/.test(r.body) && /ML/.test(r.body) && /MU/.test(r.body), r.body.slice(0, 120));
  ok('the numbers are filled in, not dashes',
     (r.body.match(/--/g) || []).length < 4, r.body.slice(0, 200));
  ok('the header names the point', /35\.40/.test(r.where), r.where);
  ok('and the forecast hour', /F\+000/.test(r.hourLbl), r.hourLbl);
  ok('the hour slider spans the hours the Pi has', r.hourMax === 4, String(r.hourMax));
}

console.log('\n8. stepping the forecast hour redraws it');
{
  const r = await page.evaluate(async () => {
    const el = document.getElementById('snd-panel');
    const before = el.querySelector('.snd-hour-lbl').textContent;
    const sl = el.querySelector('.snd-hour');
    sl.value = '2';
    sl.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 250));
    return { before, after: el.querySelector('.snd-hour-lbl').textContent };
  });
  ok('the label follows the slider', r.after === 'F+012',
     `${r.before} -> ${r.after}`);
}

console.log('\n9. it closes, and says so plainly when it cannot read anything');
{
  const r = await page.evaluate(async () => {
    const el = document.getElementById('snd-panel');
    el.querySelector('.snd-x').click();
    const closed = !_sndPanelIsOpen();
    window._sndProfile = async () => { throw new Error('this Pi has no soundings'); };
    await openSounding(35, -97);
    await new Promise(r => setTimeout(r, 200));
    return { closed, err: el.querySelector('.snd-tables').textContent };
  });
  ok('the close button closes it', r.closed);
  ok('a Pi with no soundings says exactly that, rather than spinning',
     /no soundings/.test(r.err), r.err);
}

console.log('\n10. nothing above threw');
{
  const real = errors.filter(e => !/Failed to fetch|NetworkError|ERR_FAILED|net::/i.test(e));
  ok('no page errors', real.length === 0, real.slice(0, 3).join(' | '));
}

await browser.close();
console.log();
if (fail) { console.log(`${fail} FAILED, ${pass} passed`); process.exit(1); }
console.log(`all ${pass} passed`);
