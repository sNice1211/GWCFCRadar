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
// The viewport the tests run in, for the one assertion made outside the page.
const innerWidthGuess = 1280;
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

console.log('\n7. a small card by default, a big one when asked');
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
    const tbl = el.querySelector('.snd-tables');
    const quick = el.querySelector('.snd-quick');
    return {
      open: el.classList.contains('open'),
      big: el.classList.contains('big'),
      w: b.width, h: b.height, vw: innerWidth, vh: innerHeight,
      skewSized: sk.width > 100 && sk.height > 100,
      hodoShown: getComputedStyle(el.querySelector('.snd-right')).display !== 'none',
      quickCount: quick.querySelectorAll('.snd-q').length,
      quickText: quick.textContent,
      tables: tbl.querySelectorAll('table').length,
      headers: [...tbl.querySelectorAll('th')].map(t => t.textContent),
      body: tbl.textContent,
      where: el.querySelector('.snd-where').textContent,
      hourLbl: el.querySelector('.snd-hour-lbl').textContent,
      hourMax: +el.querySelector('.snd-hour').max,
    };
  });
  ok('the panel opens', r.open);
  // A sounding is glanced at while still looking at the map, so the default
  // is a card in the corner rather than a takeover of the screen.
  ok('it is a small card, not a full-screen takeover',
     !r.big && r.w < r.vw * 0.6 && r.h < r.vh * 0.8, JSON.stringify(r));
  ok('the skew-T canvas is really sized and drawn', r.skewSized);
  ok('the hodograph is not squeezed in at card size', r.hodoShown === false);
  ok('four quick numbers stand in for the tables',
     r.quickCount === 4, String(r.quickCount));
  ok('and they are the ones a warning is written from',
     /CAPE/.test(r.quickText) && /shear/i.test(r.quickText)
     && /SRH/.test(r.quickText), r.quickText);
  ok('the full tables are built, ready for when it is expanded',
     r.tables === 4, String(r.tables));
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

console.log('\n7b. expanding shows the hodograph and the full tables');
{
  const r = await page.evaluate(() => {
    const el = document.getElementById('snd-panel');
    el.querySelector('.snd-big').click();
    const b = el.getBoundingClientRect();
    const ho = el.querySelector('#snd-hodo');
    return {
      big: el.classList.contains('big'),
      wider: b.width, vw: innerWidth,
      hodoShown: getComputedStyle(el.querySelector('.snd-right')).display !== 'none',
      hodoSized: ho.width > 100 && ho.height > 100,
      tablesShown: getComputedStyle(el.querySelector('.snd-tables')).display !== 'none',
      quickHidden: getComputedStyle(el.querySelector('.snd-quick')).display === 'none',
    };
  });
  ok('it expands', r.big && r.wider > r.vw * 0.5, JSON.stringify(r));
  ok('the hodograph appears', r.hodoShown && r.hodoSized, JSON.stringify(r));
  ok('and is really drawn, not just made visible', r.hodoSized);
  ok('the full tables appear', r.tablesShown);
  ok('and the quick row steps aside, rather than saying it twice',
     r.quickHidden);

  const back = await page.evaluate(() => {
    const el = document.getElementById('snd-panel');
    el.querySelector('.snd-big').click();
    return { big: el.classList.contains('big'),
             w: el.getBoundingClientRect().width };
  });
  ok('and it shrinks back to a card', !back.big && back.w < innerWidthGuess,
     JSON.stringify(back));
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
  // The message has to say what to DO. "could not read the sounding index"
  // is true and useless: it does not distinguish a Pi that is off from one
  // that simply is not building soundings, and those have different fixes.
  ok('a Pi with no soundings says so, and says how to switch them on',
     /not building soundings/i.test(r.err) && /install\.sh/.test(r.err), r.err);
}

console.log('\n10. the Pi\'s SounderPy answer becomes the same kind of profile');
{
  const r = await page.evaluate(() => {
    const body = {
      source: 'rap', label: 'RAP analysis', valid: '2026-08-20T18:00Z',
      site: '', lat: 35.4, lon: -97.6, cached: true,
      engine: { fetch: 'SounderPy', params: 'SHARPpy' },
      params: { engine: 'SHARPpy' },
      profile: {
        p: [985, 925, 850, 700, 500, 300],
        z: [380, 940, 1620, 3180, 5820, 9410],   // above SEA level
        T: [30, 24, 18, 6, -13, -44],
        Td: [21, 18, 13, -4, -25, -60],
        u: [6, 14, 22, 33, 47, 68], v: [3, -2, -4, 5, 12, 16],
      },
    };
    const prof = _sndFromPi(body);
    let short = null;
    try {
      _sndFromPi({ profile: { p: [1000, 850], z: [0, 1], T: [20, 10],
                              Td: [15, 5], u: [1, 2], v: [1, 2] } });
    } catch (e) { short = e.message; }
    return {
      via: prof.via, n: prof.levels.length,
      td: prof.levels[0].td, zMSL: prof.levels[0].zMSL,
      hasZ: prof.levels[0].z === undefined,
      engine: prof.engine, fetcher: prof.fetcher, cached: prof.cached,
      valid: prof.valid, short,
    };
  });
  ok('it is marked as having come from the Pi\'s door', r.via === 'pi', r.via);
  ok('every level arrives', r.n === 6, String(r.n));
  // The whole reason for this path: SounderPy sends the dew point itself, so
  // it must not be thrown away and recomputed from a humidity nobody sent.
  ok('the dew point is kept as sent, not recomputed', r.td === 21, String(r.td));
  ok('height arrives under its own name, because it is above sea level',
     r.zMSL === 380 && r.hasZ, JSON.stringify(r));
  ok('SHARPpy is named as what did the sums', r.engine === 'SHARPpy', r.engine);
  ok('and SounderPy as what fetched them', r.fetcher === 'SounderPy', r.fetcher);
  ok('a cached answer says so', r.cached === true);
  ok('the valid time comes across', /2026-08-20T18/.test(r.valid), r.valid);
  ok('and a profile too short to read is refused with a sentence',
     /too few/.test(r.short || ''), r.short);
}

console.log('\n11. real heights are used when the source has them');
{
  const r = await page.evaluate(() => {
    // Denver: the ground is a mile up, so treating height above SEA level as
    // height above GROUND puts the 0-1 km layer at 1600 m and makes every
    // low-level number nonsense.
    const denver = [
      { p: 840, t: 28, td: 12, u: 5, v: 2, zMSL: 1610 },
      { p: 700, t: 14, td: 4, u: 18, v: -3, zMSL: 3120 },
      { p: 500, t: -9, td: -20, u: 40, v: 6, zMSL: 5800 },
      { p: 300, t: -40, td: -55, u: 62, v: 14, zMSL: 9350 },
    ];
    _sndHeightsFrom(denver);
    // No heights at all: it has to fall back to the hypsometric walk.
    const noZ = [{ p: 1000, t: 25, td: 18 }, { p: 850, t: 15, td: 10 },
                 { p: 700, t: 5, td: -2 }, { p: 500, t: -12, td: -25 }];
    _sndHeightsFrom(noZ);
    // One bad level, out of order. Trusting it would give a layer with
    // negative depth and take the shear with it.
    const broken = [{ p: 1000, t: 25, td: 18, zMSL: 100 },
                    { p: 850, t: 15, td: 10, zMSL: 90 },
                    { p: 700, t: 5, td: -2, zMSL: 3000 },
                    { p: 500, t: -12, td: -25, zMSL: 5600 }];
    _sndHeightsFrom(broken);
    return {
      sfc: denver[0].z, top: denver[3].z,
      noZsfc: noZ[0].z, noZtop: noZ[3].z,
      brokenMono: broken.every((r, i) => i === 0 || r.z > broken[i - 1].z),
      brokenTop: broken[3].z,
    };
  });
  ok('the ground is zero even a mile above sea level', r.sfc === 0, String(r.sfc));
  ok('and the top is the real depth above it, not above the sea',
     Math.abs(r.top - 7740) < 1, String(r.top));
  ok('a source with no heights still gets them, hypsometrically',
     r.noZsfc === 0 && r.noZtop > 4000 && r.noZtop < 7000,
     `${r.noZsfc}, ${r.noZtop && r.noZtop.toFixed(0)}`);
  ok('and one bad height makes it fall back rather than build a broken profile',
     r.brokenMono && r.brokenTop > 4000, JSON.stringify(r));
}

console.log('\n12. SHARPpy\'s numbers replace the browser\'s, field by field');
{
  const r = await page.evaluate(() => {
    const rows = [
      { p: 1000, t: 29, rh: 78, u: 4, v: 2 }, { p: 925, t: 23, rh: 76, u: 10, v: -4 },
      { p: 850, t: 18, rh: 68, u: 20, v: -2 }, { p: 700, t: 7, rh: 55, u: 30, v: 6 },
      { p: 600, t: -2, rh: 48, u: 36, v: 10 }, { p: 500, t: -13, rh: 42, u: 44, v: 14 },
      { p: 400, t: -27, rh: 36, u: 52, v: 16 }, { p: 300, t: -43, rh: 30, u: 60, v: 18 },
      { p: 250, t: -53, rh: 25, u: 64, v: 18 }, { p: 200, t: -57, rh: 20, u: 66, v: 16 },
    ];
    const prof = { levels: rows, run: 'x', via: 'levels' };
    const before = _sndDerive(prof);
    const after = _sndApplyParams(_sndDerive(prof), {
      sb: { cape: 4321, cin: -55, lcl: 900, lfc: 1400, el: 12000 },
      wind: { shear6: 61, srh1: 222, esrh: 333, ebwd: 48 },
      composite: { pwat: 2, stp_cin: 3.4, scp: 12, ship: 1.8, dcape: 950,
                   lapse03: 8.1, eil: [960, 800] },
      motion: { rm: [30, 5], lm: [10, 20] },
    });
    // A params block that failed must change nothing at all.
    const errd = _sndApplyParams(_sndDerive(prof), { error: 'SHARPpy blew up' });
    const nulled = _sndApplyParams(_sndDerive(prof), null);
    const tables = _sndTables(after);
    const plain = _sndTables(before);
    return {
      beforeCape: before.sb.cape, afterCape: after.sb.cape,
      cin: after.sb.cin, lcl: after.sb.lclZ,
      shear6: after.shear6, srh1: after.srh1, esrh: after.esrh,
      pwatBefore: before.pwat, pwat: after.pwat,
      stp: after.stp, ship: after.ship, dcape: after.dcape,
      rm: after.motion && after.motion.right,
      traceKept: !!(after.sb.trace && after.sb.trace.length > 3),
      engine: after.engine, beforeEngine: before.engine,
      errdCape: errd.sb.cape, nulledCape: nulled.sb.cape,
      hasEffRows: /Effective SRH/.test(tables) && /Effective inflow/.test(tables),
      hasShip: /SHIP/.test(tables), hasDcape: /DCAPE/.test(tables),
      plainHasEff: /Effective SRH/.test(plain), plainHasShip: /SHIP/.test(plain),
    };
  });
  ok('CAPE is SHARPpy\'s once it has sent one',
     r.afterCape === 4321 && r.beforeCape !== 4321,
     `${r.beforeCape} -> ${r.afterCape}`);
  ok('CIN stays negative, because both sides already agree it is',
     r.cin === -55, String(r.cin));
  ok('the LCL height comes across', r.lcl === 900, String(r.lcl));
  ok('shear and helicity too', r.shear6 === 61 && r.srh1 === 222,
     `${r.shear6}, ${r.srh1}`);
  // The one real unit trap on this path: SHARPpy carries precipitable water
  // in inches and this panel has always shown millimetres. Two inches is
  // 50.8 mm, and left unconverted it would read as a desert.
  ok('precipitable water is converted from inches, not copied',
     Math.abs(r.pwat - 50.8) < 0.01, `${r.pwatBefore} -> ${r.pwat}`);
  ok('the composites come across', r.stp === 3.4 && r.ship === 1.8,
     `${r.stp}, ${r.ship}`);
  ok('and the storm motion', r.rm && r.rm.u === 30 && r.rm.v === 5,
     JSON.stringify(r.rm));
  // SHARPpy sends parameters, not curves, so the drawn parcel line stays the
  // browser's. Losing it would blank the chart to gain a number.
  ok('the parcel trace survives, so the chart still has a line on it',
     r.traceKept);
  ok('and the panel says which engine the numbers came from',
     r.engine === 'SHARPpy' && r.beforeEngine !== 'SHARPpy', String(r.engine));
  ok('a params block that failed changes nothing',
     r.errdCape === r.beforeCape, `${r.errdCape} vs ${r.beforeCape}`);
  ok('and no params block at all changes nothing either',
     r.nulledCape === r.beforeCape);
  // The effective-inflow rows cannot be computed honestly from twelve
  // pressure levels, so they appear only when SHARPpy sent them.
  ok('the effective-layer rows appear when SHARPpy sent them', r.hasEffRows);
  ok('as do SHIP and DCAPE', r.hasShip && r.hasDcape);
  ok('and they stay off the table when it did not, rather than showing dashes',
     !r.plainHasEff && !r.plainHasShip);
}

console.log('\n13. Auto asks the Pi first and falls back without an error');
{
  const r = await page.evaluate(async () => {
    const el = document.getElementById('snd-panel');
    const rows = [
      { p: 1000, t: 29, rh: 78, u: 4, v: 2 }, { p: 925, t: 23, rh: 76, u: 10, v: -4 },
      { p: 850, t: 18, rh: 68, u: 20, v: -2 }, { p: 700, t: 7, rh: 55, u: 30, v: 6 },
      { p: 600, t: -2, rh: 48, u: 36, v: 10 }, { p: 500, t: -13, rh: 42, u: 44, v: 14 },
      { p: 400, t: -27, rh: 36, u: 52, v: 16 }, { p: 300, t: -43, rh: 30, u: 60, v: 18 },
    ];
    window._sndProfile = async (lat, lon, fhr) =>
      ({ hour: fhr || 0, run: '2026082012', lat, lon, via: 'levels', levels: rows });
    _sndManifest = { hours: [0, 6, 12, 18, 24], run: '2026082012' };
    _hdBase = 'https://pi.example';
    _sndSource = 'auto'; _sndPiDown = false;

    const asked = [];
    const realFetch = window.fetch;
    window.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/sounding?')) {
        asked.push(u);
        return new Response(JSON.stringify({
          source: 'rap', label: 'RAP analysis', valid: '2026-08-20T18:00Z',
          lat: 35.4, lon: -97.6, cached: false,
          engine: { fetch: 'SounderPy', params: 'SHARPpy' },
          params: { sb: { cape: 3100, cin: -30, lcl: 850 },
                    ml: { cape: 2750, cin: -41, lcl: 1020 },
                    mu: { cape: 3260, cin: -12, lcl: 850 },
                    wind: { shear6: 58, srh1: 240, esrh: 310 },
                    composite: { pwat: 1.5, stp_cin: 2.2, scp: 9 } },
          profile: {
            p: [985, 925, 850, 700, 500, 400, 300, 250],
            z: [380, 940, 1620, 3180, 5820, 7400, 9410, 10600],
            T: [30, 24, 18, 6, -13, -27, -44, -53],
            Td: [21, 18, 13, -4, -25, -38, -60, -66],
            u: [6, 14, 22, 33, 47, 55, 68, 72],
            v: [3, -2, -4, 5, 12, 14, 16, 15],
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return realFetch(url, opts);
    };

    await openSounding(35.4, -97.6);
    await new Promise(r => setTimeout(r, 350));
    const good = {
      asked: asked.slice(),
      note: el.querySelector('.snd-note').textContent,
      quick: el.querySelector('.snd-quick').textContent,
      hourLbl: el.querySelector('.snd-hour-lbl').textContent,
      piMode: !!el._piMode,
      fell: !!el.querySelector('.snd-note').querySelector('.snd-fell'),
    };

    // Now the Pi's door is gone, the way an older serve.py answers.
    window.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/sounding?')) {
        return new Response('Not Found', { status: 404 });
      }
      return realFetch(url, opts);
    };
    _sndPiDown = false;
    await openSounding(35.4, -97.6);
    await new Promise(r => setTimeout(r, 350));
    const fellBack = {
      note: el.querySelector('.snd-note').innerHTML,
      shown: getComputedStyle(el.querySelector('.snd-note')).display,
      tables: el.querySelector('.snd-tables').querySelectorAll('table').length,
      err: el.querySelector('.snd-tables').textContent.slice(0, 60),
      piMode: !!el._piMode,
      down: _sndPiDown,
    };
    // A second click must not knock on the door again now it is known shut.
    const before = asked.length;
    await openSounding(36, -97);
    await new Promise(r => setTimeout(r, 300));
    const noRetry = asked.length === before;

    window.fetch = realFetch;
    return { good, fellBack, noRetry };
  });
  ok('Auto asks the Pi\'s door', r.good.asked.length === 1, JSON.stringify(r.good.asked));
  ok('with the point on the query string',
     /lat=35\.4000/.test(r.good.asked[0] || '') && /lon=-97\.6000/.test(r.good.asked[0] || ''),
     r.good.asked[0]);
  ok('and asks for the analysis by default',
     /source=rap/.test(r.good.asked[0] || ''), r.good.asked[0]);
  // Hour zero must NOT be sent: the service already knows the current hour is
  // not published and asks for the one before it. Naming an hour here would
  // override that with the one that does not exist.
  ok('and does not name an hour, so the service can pick the published one',
     !/when=/.test(r.good.asked[0] || ''), r.good.asked[0]);
  // The quick row shows the mixed-layer parcel, which is the one a forecaster
  // reads first, so this checks that SHARPpy's ML CAPE reached the screen and
  // not just that some number changed somewhere.
  ok('the numbers on screen are SHARPpy\'s',
     /2750/.test(r.good.quick) && /240/.test(r.good.quick), r.good.quick);
  ok('the note says where they came from',
     /SHARPpy/.test(r.good.note) && /SounderPy/.test(r.good.note), r.good.note);
  ok('and that the heights are the real ones',
     /geopotential/.test(r.good.note), r.good.note);
  ok('nothing is flagged as a fallback when nothing fell back', !r.good.fell);
  // The slider changes meaning with the source, because an analysis has no
  // forecast hours. It has to say which it is showing.
  ok('the slider now reads as time, not as a forecast hour',
     r.good.hourLbl === 'now' && r.good.piMode, r.good.hourLbl);

  ok('a Pi with no such door still draws a sounding', r.fellBack.tables === 4,
     `${r.fellBack.tables} tables, err: ${r.fellBack.err}`);
  ok('rather than an error where the numbers should be',
     !/cannot|could not/i.test(r.fellBack.err), r.fellBack.err);
  ok('and it says plainly that it fell back, and why',
     /Fell back/.test(r.fellBack.note) && /sounding service/.test(r.fellBack.note),
     r.fellBack.note.slice(0, 160));
  ok('the reason is visible at card size, not hidden until expanded',
     r.fellBack.shown !== 'none', r.fellBack.shown);
  ok('the slider goes back to meaning a forecast hour', !r.fellBack.piMode);
  ok('a door that answered 404 is remembered as shut', r.fellBack.down);
  ok('so the next click does not wait on it all over again', r.noRetry);
}

console.log('\n13b. and the picker can force either one');
{
  const r = await page.evaluate(async () => {
    const el = document.getElementById('snd-panel');
    const sel = el.querySelector('.snd-src');
    const ids = [...sel.options].map(o => o.value);
    const asked = [];
    const realFetch = window.fetch;
    window.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/sounding?')) {
        asked.push(u);
        return new Response(JSON.stringify({ error: 'no such hour yet' }),
                            { status: 502 });
      }
      return realFetch(url, opts);
    };
    // Explicitly the level images: the door must not be touched at all.
    sel.value = 'levels'; sel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 300));
    const levelsOnly = { asked: asked.length,
                         tables: el.querySelector('.snd-tables')
                                   .querySelectorAll('table').length };
    // Explicitly a SounderPy source: no silent fallback, because the person
    // asked for that one and a quiet substitution would be a lie.
    sel.value = 'obs'; sel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 300));
    const forced = { asked: asked.slice(),
                     err: el.querySelector('.snd-tables').textContent };
    sel.value = 'auto'; sel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 300));
    window.fetch = realFetch;
    return { ids, levelsOnly, forced,
             saved: localStorage.getItem('gwcfc_snd_source') };
  });
  ok('every source is offered, the floor included',
     r.ids.includes('auto') && r.ids.includes('rap') && r.ids.includes('obs')
     && r.ids.includes('levels'), JSON.stringify(r.ids));
  ok('choosing the level images does not touch the Pi\'s door at all',
     r.levelsOnly.asked === 0, String(r.levelsOnly.asked));
  ok('and still draws the full sounding', r.levelsOnly.tables === 4,
     String(r.levelsOnly.tables));
  ok('choosing a SounderPy source really asks for that one',
     /source=obs/.test(r.forced.asked.join(' ')), r.forced.asked.join(' '));
  ok('and when it fails it says so rather than quietly showing something else',
     /no such hour yet/.test(r.forced.err), r.forced.err.slice(0, 120));
  ok('the choice is remembered for next time', r.saved === 'auto', String(r.saved));
}

console.log('\n14. nothing above threw');
{
  const real = errors.filter(e => !/Failed to fetch|NetworkError|ERR_FAILED|net::/i.test(e));
  ok('no page errors', real.length === 0, real.slice(0, 3).join(' | '));
}

await browser.close();
console.log();
if (fail) { console.log(`${fail} FAILED, ${pass} passed`); process.exit(1); }
console.log(`all ${pass} passed`);
