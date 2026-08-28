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
    // The level images, named. The picker no longer has an "Auto" that would
    // have wandered onto them by itself. Saved as well as set, because
    // openSounding restores the remembered choice over the variable.
    _sndSource = 'levels';
    localStorage.setItem('gwcfc_snd_source', 'levels');
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
      // At card size the chart view is the skew-T alone. The hodograph is not
      // squeezed in beside it any more; it is a view of its own, which is how
      // it became readable on a phone at all.
      hodoInChart: !!el.querySelector('.snd-pane[data-pane="chart"] #snd-hodo'),
      hodoHasPane: !!el.querySelector('.snd-pane[data-pane="hodo"] #snd-hodo'),
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
  ok('the hodograph is not squeezed in beside the skew-T', !r.hodoInChart);
  ok('it has a view of its own instead', r.hodoHasPane);
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
      // The hodograph is its own view now rather than the cramped half of the
      // chart, so expanding is no longer what reveals it: choosing it is.
      hodoSized: (() => {
        _sndTab(el, 'hodo');
        const c = el.querySelector('#snd-hodo');
        const okd = c.width > 100 && c.height > 100;
        _sndTab(el, 'chart');
        return okd;
      })(),
      windSized: (() => {
        _sndTab(el, 'wind');
        const c = el.querySelector('#snd-wind');
        const okd = c.width > 100 && c.height > 100;
        _sndTab(el, 'chart');
        return okd;
      })(),
      tablesShown: getComputedStyle(el.querySelector('.snd-tables')).display !== 'none',
      quickHidden: getComputedStyle(el.querySelector('.snd-quick')).display === 'none',
    };
  });
  ok('it expands', r.big && r.wider > r.vw * 0.5, JSON.stringify(r));
  ok('the hodograph draws when its view is chosen', r.hodoSized);
  ok('and so does the wind profile beside it', r.windSized);
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

console.log('\n13. a named model asks the Pi\'s door, and reports it when the '
          + 'door is shut');
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
    // RAP, the default: straight at the Pi's SounderPy door.
    _sndSource = 'rap'; _sndPiDown = false;
    localStorage.setItem('gwcfc_snd_source', 'rap');

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

    // Now the Pi's door is gone, the way an older serve.py answers. This used
    // to be served from Open-Meteo without asking, so the panel drew a full
    // chart from a different provider while the picker still said RAP. It
    // reports the failure by name instead, and offers the switch.
    const om = { hourly: { time: [] } };
    const now = new Date(); now.setUTCMinutes(0, 0, 0);
    for (let i = -48; i <= 48; i++) {
      om.hourly.time.push(new Date(now.getTime() + i * 3600e3)
        .toISOString().slice(0, 16));
    }
    const n = om.hourly.time.length;
    const fill = (name, v) => { om.hourly[name] = new Array(n).fill(v); };
    fill('surface_pressure', 985); fill('temperature_2m', 29);
    fill('dew_point_2m', 21); fill('wind_speed_10m', 12);
    fill('wind_direction_10m', 180);
    const omT = { 1000: 30, 975: 28, 950: 26, 925: 24, 900: 22, 850: 18,
                  800: 14, 700: 6, 600: -3, 500: -13, 400: -27, 300: -44,
                  250: -53, 200: -57, 150: -60, 100: -62, 70: -60, 50: -55,
                  30: -50 };
    let zz = 100;
    for (const lv of Object.keys(omT).map(Number).sort((a, b) => b - a)) {
      fill(`temperature_${lv}hPa`, omT[lv]);
      fill(`relative_humidity_${lv}hPa`, 55);
      fill(`wind_speed_${lv}hPa`, 30);
      fill(`wind_direction_${lv}hPa`, 230);
      fill(`geopotential_height_${lv}hPa`, (zz += 700));
    }
    om.elevation = 350;
    window.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/sounding?')) {
        return new Response('Not Found', { status: 404 });
      }
      if (u.includes('api.open-meteo.com')) {
        return new Response(JSON.stringify(om),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return realFetch(url, opts);
    };
    // A cache that already holds this point would skip the request this half
    // of the test is about.
    _sndOMMem.clear();
    try { localStorage.removeItem('gwcfc_om_cache'); } catch (e) {}
    _sndPiDown = false;
    await openSounding(35.4, -97.6);
    await new Promise(r => setTimeout(r, 350));
    const alertEl = el.querySelector('.snd-alert');
    const refused = {
      alert: alertEl.textContent,
      shown: getComputedStyle(alertEl).display,
      onScreen: alertEl.getBoundingClientRect().height > 0,
      offersWeb: !!alertEl.querySelector('button.snd-fix-go'),
      picker: el.querySelector('.snd-src').value,
      tables: el.querySelector('.snd-tables').querySelectorAll('table').length,
      down: _sndPiDown,
    };
    // A second click must not knock on the door again now it is known shut.
    const before = asked.length;
    await openSounding(36, -97);
    await new Promise(r => setTimeout(r, 300));
    const noRetry = asked.length === before;

    window.fetch = realFetch;
    return { good, refused, noRetry };
  });
  ok('the named model asks the Pi\'s door', r.good.asked.length === 1,
     JSON.stringify(r.good.asked));
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

  // A Pi with no such door: the panel says which source could not answer,
  // rather than drawing Open-Meteo's numbers under that source's name.
  ok('a Pi with no such door is reported, by the name of the source picked',
     /RAP analysis \(Pi\) could not answer/.test(r.refused.alert),
     r.refused.alert.slice(0, 120));
  // The specific reason, translated into what to do about it, rather than a
  // generic "that did not work": this Pi's serve.py has no such door.
  ok('and the reason is the real one, not a generic failure',
     /cannot fetch real profiles yet/.test(r.refused.alert)
     && /install\.sh/.test(r.refused.alert), r.refused.alert.slice(0, 200));
  ok('the offer to use Open-Meteo is a button, not a silent substitution',
     r.refused.offersWeb, JSON.stringify(r.refused));
  ok('the picker still shows what was actually asked for',
     r.refused.picker === 'rap', r.refused.picker);
  ok('and no tables are drawn from numbers nobody asked for',
     r.refused.tables === 0, String(r.refused.tables));
  // The old message went only into the tables, which live in a pane that is
  // hidden unless the Numbers tab is up, so it reached nobody.
  ok('the message is on screen at card size, not behind a tab',
     r.refused.shown !== 'none' && r.refused.onScreen,
     JSON.stringify(r.refused));
  ok('a door that answered 404 is remembered as shut', r.refused.down);
  ok('so the next click does not wait on it all over again', r.noRetry);
}

console.log('\n13b. the Pi sources are put away, not thrown out');
{
  // The Pi is off the air, so a menu that still offered seven ways to ask it
  // was offering seven ways to wait and then be told no. They are hidden.
  //
  // Hidden is the whole point of this section: NOTHING was deleted. The
  // SounderPy door, the rendered site images and the level reader are all
  // still here and still work, because the fetching never asked the menu
  // anything - it reads _sndSource. So this drives them from code, which is
  // exactly what uncommenting one `hidden` would restore to the menu.
  const r = await page.evaluate(async () => {
    const el = document.getElementById('snd-panel');
    const sel = el.querySelector('.snd-src');
    const offered = [...sel.options].map(o => o.value);
    const known = SND_SOURCES.map(s => s.id);
    const hidden = SND_SOURCES.filter(s => s.hidden).map(s => s.id);

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

    // The rendered site images, reached the only way that is left. The door
    // must not be touched at all.
    _sndSource = 'pisite'; _sndPiDown = false;
    await _sndRefresh(el, 0);
    await new Promise(r2 => setTimeout(r2, 300));
    const siteOnly = { asked: asked.length,
                       tables: el.querySelector('.snd-tables')
                                 .querySelectorAll('table').length };

    // A named SounderPy source still asks for that one by name.
    _sndSource = 'obs'; _sndPiDown = false;
    await _sndRefresh(el, 0);
    await new Promise(r2 => setTimeout(r2, 300));
    const forced = { asked: asked.slice(),
                     note: el.querySelector('.snd-note').textContent,
                     alert: el.querySelector('.snd-alert').textContent };

    // And the menu's own choice is still remembered.
    sel.value = 'web'; sel.dispatchEvent(new Event('change'));
    await new Promise(r2 => setTimeout(r2, 300));
    window.fetch = realFetch;
    return { offered, known, hidden, siteOnly, forced,
             saved: localStorage.getItem('gwcfc_snd_source') };
  });
  ok('the menu offers only the source that can answer without the Pi',
     r.offered.join(',') === 'web', JSON.stringify(r.offered));
  // If this ever fails because an id vanished from SND_SOURCES, something was
  // deleted that was only meant to be put away.
  ok('but every Pi source is still in the app, merely hidden',
     r.known.join(',') === 'rap,obs,hrrr,nam,gfs,pisite,levels,web',
     JSON.stringify(r.known));
  ok('and all seven of them are the hidden ones',
     r.hidden.join(',') === 'rap,obs,hrrr,nam,gfs,pisite,levels',
     JSON.stringify(r.hidden));
  ok('a hidden source still works when it is asked for in code',
     r.siteOnly.tables === 4, String(r.siteOnly.tables));
  ok('and the site images still do not touch the Pi\'s door',
     r.siteOnly.asked === 0, String(r.siteOnly.asked));
  ok('a named SounderPy source still asks for that one by name',
     /source=obs/.test(r.forced.asked.join(' ')), r.forced.asked.join(' '));
  // It used to answer this from Open-Meteo and mention it in the note. It
  // reports the refusal by name now, carrying the Pi's own words for it.
  ok('and says so by name when that source refuses, with the Pi\'s reason',
     /Observed balloon \(Pi\) could not answer/.test(r.forced.alert)
     && /no such hour yet/.test(r.forced.alert),
     r.forced.alert.slice(0, 200));
  ok('the menu choice is still remembered for next time',
     r.saved === 'web', String(r.saved));
}

console.log('\n13c. and there is a source that needs no Pi at all');
{
  const r = await page.evaluate(async () => {
    const el = document.getElementById('snd-panel');
    // A plausible Open-Meteo answer: nineteen pressure levels plus surface,
    // humidity rather than dew point, wind as speed and direction.
    const LV = [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500,
                400, 300, 250, 200, 150, 100, 70, 50, 30];
    const hourly = { time: [] };
    for (let h = 0; h < 4; h++) {
      const t = new Date(Date.now() + (h - 1) * 3600e3);
      t.setUTCMinutes(0, 0, 0);
      hourly.time.push(t.toISOString().slice(0, 16));
    }
    const put = (name, val) => { hourly[name] = hourly.time.map(() => val); };
    // A lapse rate that is real but not saturated, so CAPE is finite.
    LV.forEach((lv, i) => {
      put(`temperature_${lv}hPa`, 30 - i * 4.5);
      put(`relative_humidity_${lv}hPa`, Math.max(12, 80 - i * 4));
      put(`wind_speed_${lv}hPa`, 10 + i * 3);
      put(`wind_direction_${lv}hPa`, 180 + i * 5);
      put(`geopotential_height_${lv}hPa`, 100 + i * 900);
    });
    put('temperature_2m', 31); put('dew_point_2m', 22);
    put('surface_pressure', 985);
    put('wind_speed_10m', 8); put('wind_direction_10m', 170);

    // The cache is doing its job by now, and its job is to skip the
    // request this section is here to inspect. Emptied first.
    _sndOMMem.clear();
    try { localStorage.removeItem('gwcfc_om_cache'); } catch (e) {}
    let askedUrl = null;
    const realFetch = window.fetch;
    window.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('open-meteo')) {
        askedUrl = u;
        return new Response(JSON.stringify({ elevation: 350, hourly }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      // Everything Pi shaped is dead, which is the whole point of this test.
      if (u.includes('/sounding?')) return new Response('gone', { status: 500 });
      return realFetch(url, opts);
    };
    window._sndProfile = async () => { throw new Error('this Pi has no soundings'); };
    _hdBase = 'https://pi.example';
    _sndSource = 'rap'; _sndPiDown = false;
    localStorage.setItem('gwcfc_snd_source', 'rap');

    await openSounding(35.4, -97.6);
    await new Promise(res => setTimeout(res, 400));
    // A dead Pi with a Pi source picked. This used to fire the request below
    // and draw its answer under the RAP label; now it must not ask at all.
    const notAsked = {
      url: askedUrl,
      alert: el.querySelector('.snd-alert').textContent,
      tables: el.querySelectorAll('table').length,
    };

    // And now when it is chosen outright, which is the only way it is
    // reached. Everything after this checks the request itself.
    _sndSource = 'web'; askedUrl = null;
    localStorage.setItem('gwcfc_snd_source', 'web');
    await openSounding(35.4, -97.6);
    await new Promise(res => setTimeout(res, 400));
    const auto = {
      url: askedUrl,
      note: el.querySelector('.snd-note').innerHTML,
      tables: el.querySelectorAll('table').length,
      rows: (el.querySelector('.snd-note').textContent.match(/(\d+) standard/) || [])[1],
    };

    // Asked for a second time at the same point.
    askedUrl = null;
    await openSounding(35.4, -97.6);
    await new Promise(res => setTimeout(res, 400));
    const forced = { url: askedUrl, tables: el.querySelectorAll('table').length };

    // The profile itself, so the physics can be checked rather than the HTML.
    const prof = await _sndOpenMeteo(35.4, -97.6, 0, 'auto');
    window.fetch = realFetch;
    return { notAsked, auto, forced, prof, ids: SND_SOURCES.map(s => s.id) };
  });

  ok('the web source is offered in the picker', r.ids.includes('web'),
     r.ids.join(','));
  // The rule this section now enforces: a dead Pi does not become a request
  // to somebody else. Open-Meteo is a choice, not a substitution.
  ok('a dead Pi does not reach for Open-Meteo on its own',
     r.notAsked.url === null, String(r.notAsked.url).slice(0, 60));
  ok('and nothing is drawn from a source that was not chosen',
     r.notAsked.tables === 0, String(r.notAsked.tables));
  ok('the panel says which source failed and offers the switch',
     /could not answer/.test(r.notAsked.alert)
     && /Open-Meteo/.test(r.notAsked.alert), r.notAsked.alert.slice(0, 120));
  ok('choosing Open-Meteo outright does fetch it', !!r.auto.url,
     String(r.auto.url).slice(0, 60));
  ok('and draws a real sounding', r.auto.tables === 4, String(r.auto.tables));
  ok('saying plainly that it came from the web source',
     /without going through the Pi/.test(r.auto.note), r.auto.note.slice(0, 140));
  // No second request for the same point: the cache is what keeps this source
  // inside its free allowance, and it is worth asserting rather than
  // tolerating.
  ok('asking again for the same point is served from the cache',
     r.forced.url === null && r.forced.tables === 4,
     `${!!r.forced.url}, ${r.forced.tables}`);
  // The request has to actually ask for what the panel needs.
  ok('it asks for wind in knots, which is what the panel reads',
     /wind_speed_unit=kn/.test(r.auto.url));
  ok('and for the geopotential heights rather than guessing them',
     /geopotential_height_500hPa/.test(r.auto.url));

  const L = r.prof.levels;
  ok('the profile has the standard levels plus the surface', L.length >= 15,
     String(L.length));
  ok('it runs from the ground upward', L[0].p > L[L.length - 1].p,
     `${L[0].p} -> ${L[L.length - 1].p}`);
  // Pressure levels below the ground are not levels of this sounding, and a
  // duplicate surface would make a zero depth layer that shear divides by.
  const dupes = L.filter((x, i) => i && Math.abs(x.p - L[i - 1].p) < 0.5);
  ok('with no level repeated at the surface pressure', dupes.length === 0,
     JSON.stringify(dupes.slice(0, 2)));
  ok('and nothing underground', L.every(x => x.p <= L[0].p),
     String(L.filter(x => x.p > L[0].p).length));
  // Dew point is derived from humidity, so it must be a real number and it
  // must never exceed the temperature, which is what a bad Magnus does.
  const wet = L.filter(x => x.td != null);
  ok('dew point is derived for every level that had humidity', wet.length >= 10,
     String(wet.length));
  ok('and is never above the temperature',
     wet.every(x => x.td <= x.t + 0.01),
     JSON.stringify(wet.filter(x => x.td > x.t + 0.01).slice(0, 2)));
  // The wind convention is the one thing here that is silently wrong-able: a
  // wind FROM 180 (a southerly) blows toward the north, so v must be
  // positive. Getting the sign wrong flips every hodograph and every
  // helicity value while still drawing a normal looking chart.
  const sfc = L[0];
  ok('a southerly wind gives a northward v, as the convention requires',
     sfc.v > 0 && Math.abs(sfc.u) < Math.abs(sfc.v),
     `u=${sfc.u.toFixed(1)} v=${sfc.v.toFixed(1)}`);
  ok('and the speed survives the conversion',
     Math.abs(Math.hypot(sfc.u, sfc.v) - 8) < 0.1,
     String(Math.hypot(sfc.u, sfc.v).toFixed(2)));
  ok('it is labelled as not having come from the Pi',
     r.prof.via === 'openmeteo' && r.prof.engine === 'browser',
     `${r.prof.via}, ${r.prof.engine}`);
}

console.log("\n13c2. Open-Meteo cannot be asked often enough to be cut off");
{
  // The panel used to spend a whole request PER HOUR OF THE SLIDER, because
  // every answer already contains the entire series and the code was only
  // indexing a different element of it. Dragging that slider from end to end
  // fired eleven identical downloads and threw ten away. Open-Meteo's free
  // tier is generous but finite, and it is the one source with nothing of
  // ours behind it: spend it and the panel has no floor left.
  //
  // Everything below counts real requests rather than inspecting the guard.
  const r = await page.evaluate(async () => {
    let hits = 0;
    const realFetch = window.fetch;
    const hourly = { time: [] };
    const now = new Date(); now.setUTCMinutes(0, 0, 0);
    for (let i = -48; i <= 48; i++) {
      hourly.time.push(new Date(now.getTime() + i * 3600e3)
        .toISOString().slice(0, 16));
    }
    const n = hourly.time.length;
    const put = (k, v) => { hourly[k] = new Array(n).fill(v); };
    const LV = [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300,
                250, 200, 150, 100, 70, 50, 30];
    LV.forEach((lv, i) => {
      put(`temperature_${lv}hPa`, 30 - i * 4.5);
      put(`relative_humidity_${lv}hPa`, Math.max(12, 80 - i * 4));
      put(`wind_speed_${lv}hPa`, 10 + i * 3);
      put(`wind_direction_${lv}hPa`, 180 + i * 5);
      put(`geopotential_height_${lv}hPa`, 100 + i * 900);
    });
    put('temperature_2m', 31); put('dew_point_2m', 22);
    put('surface_pressure', 985);
    put('wind_speed_10m', 8); put('wind_direction_10m', 170);

    let status = 200, retryAfter = null;
    window.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('open-meteo')) {
        hits++;
        if (status !== 200) {
          const h = retryAfter ? { 'Retry-After': String(retryAfter) } : {};
          return new Response('slow down', { status, headers: h });
        }
        return new Response(JSON.stringify({ elevation: 350, hourly }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return realFetch(url, opts);
    };
    const reset = () => {
      _sndOMMem.clear();
      _sndOMHoldUntil = 0;
      _sndOMLastAt = 0;
      try {
        localStorage.removeItem('gwcfc_om_cache');
        localStorage.removeItem('gwcfc_om_calls');
      } catch (e) {}
      hits = 0;
    };
    const out = {};

    // 1. Every stop the slider has, from one request.
    reset();
    for (const h of SND_BACK_HOURS) await _sndOpenMeteo(41.1, -101.2, h, 'web');
    out.wholeSlider = { stops: SND_BACK_HOURS.length, hits };

    // 2. A click a few hundred metres away is the same question.
    reset();
    await _sndOpenMeteo(41.1, -101.2, 0, 'web');
    const afterFirst = hits;
    await _sndOpenMeteo(41.1004, -101.2004, 0, 'web');
    out.nearby = { afterFirst, total: hits };

    // 3. Clicks that arrive together share one request rather than racing.
    reset();
    await Promise.all([0, 1, 2, 3, 6].map(h =>
      _sndOpenMeteo(44.4, -93.3, h, 'web')));
    out.together = hits;

    // 4. The budget is checked BEFORE sending, not discovered by refusal.
    reset();
    const spent = [];
    for (let i = 0; i < SND_OM_BUDGET[0].max; i++) spent.push(Date.now());
    localStorage.setItem('gwcfc_om_calls', JSON.stringify(spent));
    out.over = _sndOMOverBudget();
    let refusedWhy = null;
    try { await _sndOpenMeteo(12.5, 34.5, 0, 'web'); }
    catch (e) { refusedWhy = String(e.message || e); }
    out.refused = { why: refusedWhy, hits };

    // 5. Spent budget must not mean a blank panel when something is saved.
    reset();
    await _sndOpenMeteo(51.5, -0.12, 0, 'web');
    const gotOne = hits;
    _sndOMMem.get(_sndOMKey(51.5, -0.12, 'best_match')).at =
      Date.now() - (SND_OM_TTL_MS + 60e3);          // stale, not gone
    localStorage.setItem('gwcfc_om_calls', JSON.stringify(spent));
    const stale = await _sndOpenMeteo(51.5, -0.12, 0, 'web');
    out.stale = { gotOne, after: hits, levels: stale.levels.length };

    // 6. A real refusal is believed, and nothing is sent until it passes.
    reset();
    status = 429; retryAfter = 90;
    let saidWhat = null;
    try { await _sndOpenMeteo(-33.9, 151.2, 0, 'web'); }
    catch (e) { saidWhat = String(e.message || e); }
    const afterRefusal = hits;
    try { await _sndOpenMeteo(-33.9, 151.2, 0, 'web'); } catch (e) {}
    out.rateLimited = {
      said: saidWhat, sentOnce: afterRefusal, sentAgain: hits,
      holdsFor: Math.round((_sndOMHoldUntil - Date.now()) / 1000),
    };

    status = 200; retryAfter = null;
    reset();
    window.fetch = realFetch;
    return out;
  });

  ok('the whole slider costs one request, not one per stop',
     r.wholeSlider.hits === 1,
     `${r.wholeSlider.hits} requests for ${r.wholeSlider.stops} stops`);
  ok('a click in the same neighbourhood costs nothing at all',
     r.nearby.afterFirst === 1 && r.nearby.total === 1,
     JSON.stringify(r.nearby));
  ok('clicks that arrive together make one request between them',
     r.together === 1, String(r.together));
  ok('a full budget is noticed before anything is sent',
     /requests in a minute/.test(r.over || ''), String(r.over));
  ok('and nothing is sent once it is full', r.refused.hits === 0,
     String(r.refused.hits));
  ok('which is said in words rather than shown as a broken panel',
     /holding off/.test(r.refused.why || ''), r.refused.why);
  // The point of keeping the old answer: fifteen minutes stale is a sounding,
  // and an error message is not.
  ok('a saved answer is used rather than an error when the budget is spent',
     r.stale.after === r.stale.gotOne && r.stale.levels > 5,
     JSON.stringify(r.stale));
  ok('a real refusal is taken at its word', r.rateLimited.sentOnce === 1
     && r.rateLimited.sentAgain === 1, JSON.stringify(r.rateLimited));
  ok('for exactly as long as it asked for',
     Math.abs(r.rateLimited.holdsFor - 90) <= 2,
     String(r.rateLimited.holdsFor));
  ok('and it says which of the two things happened',
     /rate limiting/.test(r.rateLimited.said || ''), r.rateLimited.said);
}

console.log('\n13d. the soundings the Pi rendered as images');
{
  const r = await page.evaluate(async () => {
    const el = document.getElementById('snd-panel');
    // Two frames for the nearest site, an hour apart, stamped like the
    // pipeline stamps them: by valid time.
    const st = (hoursAgo) => {
      const t = new Date(Date.now() - hoursAgo * 3600e3);
      t.setUTCMinutes(0, 0, 0);
      const p2 = n => String(n).padStart(2, '0');
      return `${t.getUTCFullYear()}${p2(t.getUTCMonth() + 1)}${p2(t.getUTCDate())}`
           + `_${p2(t.getUTCHours())}0000`;
    };
    const fNew = st(1), fOld = st(4);
    const man = { updated: 'now', sites: {
      OUN: { name: 'Norman OK', lat: 35.18, lon: -97.44,
             dir: `OUN/${fNew}`, valid: 'x', frames: [fOld, fNew] },
      FWD: { name: 'Fort Worth TX', lat: 32.83, lon: -97.30,
             dir: `FWD/${fNew}`, valid: 'x', frames: [fNew] },
    } };
    const n = 40;
    const body = (site, name) => ({
      source: 'rap', label: 'RAP analysis', valid: '2026-08-21T02:00Z',
      site: name, site_id: site, site_name: name, lat: 35.18, lon: -97.44,
      engine: { fetch: 'sounderpy', params: 'SHARPpy' },
      params: { sb: { cape: 2222, cin: -15, lcl: 900 },
                wind: { srh1: 111, srh3: 222, esrh: 180, shear6: 45 } },
      profile: {
        p: Array.from({length: n}, (_, i) => 1000 - i * 20),
        z: Array.from({length: n}, (_, i) => 100 + i * 180),
        T: Array.from({length: n}, (_, i) => 25 - i),
        Td: Array.from({length: n}, (_, i) => 18 - i * 1.4),
        u: Array.from({length: n}, (_, i) => i * 0.8),
        v: Array.from({length: n}, (_, i) => 5 + i * 0.5),
      },
    });

    const asked = [];
    const realFetch = window.fetch;
    window.fetch = async (url) => {
      const u = String(url);
      asked.push(u);
      if (u.includes('/sounding?')) return new Response('gone', { status: 500 });
      if (u.includes('/soundings/manifest.json')) {
        return new Response(JSON.stringify(man),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const m = u.match(/\/soundings\/(\w+)\/([0-9_]+)\/sounding\.json/);
      if (m) {
        return new Response(JSON.stringify(body(m[1], man.sites[m[1]].name)),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return realFetch(url);
    };
    window._sndProfile = async () => { throw new Error('no level images'); };
    _hdBase = 'https://pi.example';
    _sndSource = 'pisite'; _sndPiDown = false; _sndSitesMan = null;
    localStorage.setItem('gwcfc_snd_source', 'pisite');
    // Every source falls back to Open-Meteo now, and a cached Open-Meteo
    // answer would quietly stand in for the site images this section is
    // about, passing the shape of the test while proving nothing.
    _sndOMMem.clear();
    try { localStorage.removeItem('gwcfc_om_cache'); } catch (e) {}

    // Click NEAR Norman: the nearest site must be OUN, and the distance real.
    await openSounding(35.60, -97.20);
    await new Promise(res => setTimeout(res, 400));
    const auto = {
      tables: el.querySelectorAll('table').length,
      note: el.querySelector('.snd-note').innerHTML,
      img: (el.querySelector('.snd-pimg img') || {}).src || '',
      head: (el.querySelector('.snd-pimg-head') || {}).textContent || '',
      piMode: !!el._piMode,
    };

    // Six hours back must pick the OLD frame, because the stamps are valid
    // times and the slider walks them.
    const profBack = await _sndPrebuilt(35.60, -97.20, 6);
    // And a click in the middle of nowhere is refused rather than answered
    // with air from half a country away.
    let farErr = '';
    try { await _sndPrebuilt(44.0, -110.0, 0); }
    catch (e) { farErr = String(e.message || e); }

    // Explicitly choosing the source works too.
    _sndSource = 'pisite';
    await openSounding(32.9, -97.25);
    await new Promise(res => setTimeout(res, 400));
    const forced = {
      site: (el.querySelector('.snd-pimg-head') || {}).textContent || '',
      tables: el.querySelectorAll('table').length,
    };
    window.fetch = realFetch;
    _sndSource = 'auto'; _sndSitesMan = null;
    return { auto, backPng: profBack.png, farErr, forced,
             ids: SND_SOURCES.map(x => x.id), oldStamp: fOld };
  });

  ok('the picker offers the Pi site images', r.ids.includes('pisite'),
     r.ids.join(','));
  ok('the site images answer when the live door is dead', r.auto.tables === 4,
     String(r.auto.tables));
  ok('the nearest real site answered', /Norman OK/.test(r.auto.note),
     r.auto.note.slice(0, 120));
  ok('and the note says how far away that site is',
     /\d+ km from the point/.test(r.auto.note), r.auto.note.slice(0, 200));
  ok('the numbers on screen are SHARPpy\'s, from the saved file',
     /SHARPpy/.test(r.auto.note));
  ok('the Pi\'s rendered PNG is shown in the panel',
     r.auto.img.includes('/soundings/OUN/') && r.auto.img.includes('skewt.png'),
     r.auto.img);
  ok('with the site named above it', /Norman OK/.test(r.auto.head), r.auto.head);
  ok('the slider means hours back on this source', r.auto.piMode === true);
  ok('and scrubbing back really picks the older frame',
     r.backPng.includes(r.oldStamp), r.backPng);
  ok('a click too far from any site is refused, not answered with far air',
     /350 km/.test(r.farErr), r.farErr);
  ok('choosing the source outright picks the nearest site to that click',
     /Fort Worth/.test(r.forced.site) && r.forced.tables === 4,
     r.forced.site);
}

console.log('\n13e. the panel is four views, not one long column');
{
  const r = await page.evaluate(async () => {
    const el = document.getElementById('snd-panel');
    const tabs = Array.from(el.querySelectorAll('.snd-tab')).map(t => t.dataset.tab);
    // Hidden views are still in the DOM and still fillable; they are simply
    // not offered. Both halves of that are worth asserting.
    const panes = Array.from(el.querySelectorAll('.snd-pane'))
      .map(p => p.dataset.pane);
    const shown = () => Array.from(el.querySelectorAll('.snd-pane'))
      .filter(p => !p.hidden).map(p => p.dataset.pane);
    const atOpen = shown();
    _sndTab(el, 'numbers');
    const onNumbers = shown();
    const lit = Array.from(el.querySelectorAll('.snd-tab.on')).map(t => t.dataset.tab);
    _sndTab(el, 'wind');
    const onWind = shown();
    // Each pane really holds the thing its tab promises.
    const homes = {
      chart:   !!el.querySelector('.snd-pane[data-pane="chart"] #snd-skewt'),
      hodo:    !!el.querySelector('.snd-pane[data-pane="hodo"] #snd-hodo'),
      wind:    !!el.querySelector('.snd-pane[data-pane="wind"] #snd-wind'),
      numbers: !!el.querySelector('.snd-pane[data-pane="numbers"] .snd-tables'),
      image:   !!el.querySelector('.snd-pane[data-pane="image"] .snd-pimg'),
    };
    // Where the numbers came from is not behind a tab any more.
    const noteOutside = !el.querySelector('.snd-pane .snd-note')
      && !!el.querySelector('#snd-panel > .snd-note');
    // The chart is a view like the other three. It used to sit outside the
    // panes so a tab could not hide it, which meant choosing Numbers changed
    // nothing visible on a card sized panel.
    const chartInPane = !!el.querySelector('.snd-pane[data-pane="chart"] #snd-skewt');
    // And the switch is above what it switches, not below it.
    const tabsAbove = !!(el.querySelector('.snd-tabs').compareDocumentPosition(
      el.querySelector('.snd-pane')) & Node.DOCUMENT_POSITION_FOLLOWING);
    // A tab is a tab to a screen reader too, and exactly one is current.
    const marked = Array.from(el.querySelectorAll('.snd-tab'))
      .filter(t => t.getAttribute('aria-selected') === 'true').length;
    _sndTab(el, 'chart');
    // Coming back has to redraw: a canvas in a hidden pane measures zero, so
    // whatever it held while it was away is the wrong size.
    const c = el.querySelector('#snd-skewt');
    const redrawn = c.width > 100 && c.height > 100;
    return { tabs, panes, atOpen, onNumbers, lit, onWind, homes, noteOutside,
             chartInPane, tabsAbove, marked, redrawn };
  });
  ok('the four views offered are the ones Open-Meteo can fill',
     r.tabs.join(',') === 'chart,hodo,wind,numbers', r.tabs.join(','));
  // Image showed a picture only the Pi renders, so with the Pi sources hidden
  // it could only ever be blank. Hidden, not deleted, like everything else.
  ok('Image and Source are gone from the bar but still in the panel',
     !r.tabs.includes('image') && !r.tabs.includes('source')
     && r.panes.includes('image') && r.panes.includes('source'),
     r.panes.join(','));
  ok('and the chart is the one open to begin with',
     r.atOpen.length === 1 && r.atOpen[0] === 'chart', r.atOpen.join(','));
  ok('choosing one shows only it', r.onNumbers.length === 1
     && r.onNumbers[0] === 'numbers', r.onNumbers.join(','));
  ok('and lights only its tab', r.lit.length === 1 && r.lit[0] === 'numbers',
     r.lit.join(','));
  ok('switching again swaps it', r.onWind.join(',') === 'wind', r.onWind.join(','));
  ok('every view holds what its tab promises',
     Object.values(r.homes).every(Boolean), JSON.stringify(r.homes));
  ok('and the note sits under all of them rather than behind one',
     r.noteOutside);
  ok('the chart is a view like the rest, not a fixture above them',
     r.chartInPane);
  ok('and the switch sits above what it switches', r.tabsAbove);
  ok('exactly one tab is marked current for a screen reader',
     r.marked === 1, String(r.marked));
  ok('coming back to the chart redraws it at the size it really is',
     r.redrawn);
}

console.log("\n13e2. the new views are free: switching asks Open-Meteo nothing");
{
  // Hodograph and Wind are drawn from the SAME profile the chart is drawn
  // from, which came from the same cached Open-Meteo answer. Adding views is
  // therefore not adding load, and this proves it by counting requests rather
  // than by reasoning about the code: every tab, twice round, and the count
  // has to stay at zero.
  const r = await page.evaluate(async () => {
    const el = document.getElementById('snd-panel');
    let hits = 0;
    const realFetch = window.fetch;
    window.fetch = async (url, opts) => {
      if (String(url).includes('open-meteo')) hits++;
      return realFetch(url, opts);
    };
    const tabs = Array.from(el.querySelectorAll('.snd-tab')).map(b => b.dataset.tab);
    for (let round = 0; round < 2; round++) {
      for (const id of tabs) {
        _sndTab(el, id);
        await new Promise(r2 => setTimeout(r2, 20));
      }
    }
    // Every drawn view really drew, rather than being free by doing nothing.
    const sizes = {};
    for (const [id, sel] of [['chart', '#snd-skewt'], ['hodo', '#snd-hodo'],
                             ['wind', '#snd-wind']]) {
      _sndTab(el, id);
      await new Promise(r2 => setTimeout(r2, 20));
      const c = el.querySelector(sel);
      sizes[id] = c ? (c.width > 100 && c.height > 100) : false;
    }
    _sndTab(el, 'chart');
    const read = el.querySelector('.snd-hodo-read');
    const readText = read ? read.textContent : '';
    window.fetch = realFetch;
    return { hits, tabs, sizes, readText, rounds: tabs.length * 2 };
  });
  ok('switching through every view costs no requests at all',
     r.hits === 0, `${r.hits} requests over ${r.rounds} switches`);
  ok('and each drawn view really drew something',
     r.sizes.chart && r.sizes.hodo && r.sizes.wind, JSON.stringify(r.sizes));
  // A hodograph's shape says whether a storm can rotate; these say how much.
  ok('the hodograph carries the numbers it is read for',
     /SRH/.test(r.readText) && /shear/i.test(r.readText),
     r.readText.slice(0, 100));
}

console.log('\n13f. the Pi says why it is empty, in the browser');
{
  const r = await page.evaluate(async () => {
    const realFetch = window.fetch;
    window.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/soundings/manifest.json')) {
        return new Response(JSON.stringify({ sites: {} }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes('/soundings/status.json')) {
        return new Response(JSON.stringify({
          ok: false, reason: 'missing matplotlib',
          fix: '~/wxenv/bin/pip install matplotlib' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return realFetch(url);
    };
    _hdBase = 'https://pi.example';
    _sndSitesMan = null;
    if (typeof _piStatusCache !== 'undefined') _piStatusCache.clear();
    let msg = '';
    try { await _sndPrebuilt(35.4, -97.6, 0); }
    catch (e) { msg = String(e.message || e); }
    // And a healthy Pi says nothing at all.
    const quiet = _piStatusLine({ ok: true, reason: '' });
    const nothing = _piStatusLine(null);
    window.fetch = realFetch;
    _sndSitesMan = null;
    if (typeof _piStatusCache !== 'undefined') _piStatusCache.clear();
    return { msg, quiet, nothing };
  });
  // "The Pi has not built any soundings yet" is equally true of a first run,
  // a missing package and a dead upstream. Only one of those has something
  // to do about it, and the person looking at the map cannot read the log.
  ok('a missing package is named rather than shrugged at',
     /matplotlib/.test(r.msg), r.msg);
  ok('with the command that fixes it', /pip install/.test(r.msg), r.msg);
  ok('and a healthy Pi produces no noise', r.quiet === '' && r.nothing === '',
     `${JSON.stringify(r.quiet)} ${JSON.stringify(r.nothing)}`);
}

console.log('\n13g. the verdict, and the meters under the numbers');
{
  // A sounding is a wall of numbers, and the first question anybody actually
  // has is "is anything going to happen here". The numbers already answered
  // that and never said it out loud. These check the sentence is real rather
  // than decorative: that it changes with the profile, and that it refuses to
  // cry severe over a profile that is capped shut.
  const r = await page.evaluate(() => {
    const severe = {
      sb:{label:'SB',cape:2480,cin:-32}, ml:{label:'ML',cape:1980,cin:-58},
      sfc:{t:29,td:22}, shear6:52, srh1:212, stp:2.4, scp:7.2, ship:1.6,
      dcape:1080,
    };
    const capped = {
      sb:{label:'SB',cape:3000,cin:-220}, ml:{label:'ML',cape:2600,cin:-240},
      sfc:{t:31,td:20}, shear6:55, srh1:250, stp:3.0, scp:8, ship:2,
    };
    const quiet = {
      sb:{label:'SB',cape:20,cin:-2}, ml:{label:'ML',cape:5,cin:-1},
      sfc:{t:14,td:3}, shear6:8, srh1:12, stp:0, scp:0, ship:0,
    };
    const plain = {
      sb:{label:'SB',cape:900,cin:-20}, ml:{label:'ML',cape:700,cin:-25},
      sfc:{t:26,td:18}, shear6:14, srh1:30, stp:0, scp:0, ship:0,
    };
    return {
      severe: _sndVerdictHTML(severe), capped: _sndVerdictHTML(capped),
      quiet: _sndVerdictHTML(quiet), plain: _sndVerdictHTML(plain),
      qs: _sndQuick(severe),
      mZero: _sndMeterPct(0, 1000, 2500),
      mWarm: _sndMeterPct(1000, 1000, 2500),
      mHot: _sndMeterPct(2500, 1000, 2500),
      mOver: _sndMeterPct(99999, 1000, 2500),
      mNull: _sndMeterPct(null, 1000, 2500),
    };
  });
  ok('a dangerous profile is called dangerous',
     /lv4/.test(r.severe) && /Dangerous/.test(r.severe), r.severe);
  ok('and says what it supports, not just a word',
     /tornado/i.test(r.severe), r.severe);
  ok('large hail is named when SHIP says so', /hail/i.test(r.severe), r.severe);
  // The one that matters most. 3000 J/kg under 220 J/kg of inhibition is a
  // blue sky afternoon, and shouting severe over it would be the panel lying
  // with total confidence.
  ok('a capped profile is NOT called severe, however good the rest looks',
     /Capped/.test(r.capped) && !/lv4/.test(r.capped), r.capped);
  ok('and the cap is named as the reason', /inhibition/i.test(r.capped), r.capped);
  ok('nothing to work with reads as quiet',
     /Quiet/.test(r.quiet) && /lv0/.test(r.quiet), r.quiet);
  ok('and an ordinary storm day is neither quiet nor dangerous',
     !/lv0/.test(r.plain) && !/lv4/.test(r.plain), r.plain);
  // A bar is only worth drawing if it means the same thing on every tile,
  // which is what anchoring warm and hot to fixed marks buys.
  ok('the meter is empty at zero', r.mZero === 0, String(r.mZero));
  ok('half full at the warm threshold', r.mWarm === 50, String(r.mWarm));
  ok('four fifths at the hot one', r.mHot === 80, String(r.mHot));
  ok('and never past full, however extreme', r.mOver === 100, String(r.mOver));
  ok('a missing value draws nothing rather than NaN', r.mNull === 0, String(r.mNull));
  ok('every quick tile carries one',
     (r.qs.match(/snd-meter/g) || []).length === 4,
     String((r.qs.match(/snd-meter/g) || []).length));
}

console.log('\n13g2. the verdict cannot contradict itself');
{
  // The bug this section exists for, off a real click at 29.79, -80.54: the
  // panel read DANGEROUS directly above its own sentence, "755 J/kg with 21 kt
  // of deep shear. Supports ordinary thunderstorms." Both halves were true of
  // the numbers and only one of them could be true of the day, because the
  // word and the sentence were being decided by two separate ladders. The
  // word's ladder reached its top rung on SCP alone and never asked about
  // shear, so a composite parameter arriving too high from upstream promoted
  // an ordinary afternoon to the loudest thing the panel can say.
  const r = await page.evaluate(() => {
    const say = (o) => _sndVerdictHTML(Object.assign({
      sb: { label: 'SB', cape: 800, cin: -20 },
      ml: { label: 'ML', cape: 755, cin: -25 },
      sfc: { t: 28, td: 21 }, shear6: 21, srh1: 40,
      stp: 0, scp: 0, ship: 0,
    }, o));
    return {
      // The exact profile from the screenshot, with SCP arriving high.
      real: say({ scp: 7.2 }),
      // A day that genuinely earns the word still gets it.
      earned: say({ cape: 2400, shear6: 55, stp: 2.2, scp: 8,
                    sb: { label: 'SB', cape: 2900, cin: -30 },
                    ml: { label: 'ML', cape: 2400, cin: -40 } }),
      // Shear without a composite is organised, not dangerous.
      sheared: say({ shear6: 34, scp: 2.5,
                     ml: { label: 'ML', cape: 1400, cin: -30 } }),
    };
  });
  const word = h => (/snd-verdict-word[^>]*>([^<]+)</.exec(h) || [])[1];
  ok('high SCP with 21 kt of shear is NOT called dangerous',
     word(r.real) !== 'Dangerous', word(r.real) + ' | ' + r.real);
  ok('it is called what its own sentence says it is',
     word(r.real) === 'Active' && /ordinary thunderstorms/.test(r.real),
     word(r.real) + ' | ' + r.real);
  ok('a profile that really does support tornadoes still says so',
     word(r.earned) === 'Dangerous' && /tornado/.test(r.earned),
     word(r.earned));
  ok('and organised shear reads as organised, one rung down',
     word(r.sheared) === 'Organised', word(r.sheared) + ' | ' + r.sheared);
}

console.log('\n13g3. the panel stopped decorating itself');
{
  // Three things were doing no work: a gradient thread along the top of the
  // head, an outlined pill around the verdict word that pulsed red, and a
  // bordered chip around the coordinate. All three were louder than the text
  // they framed.
  const r = await page.evaluate(() => {
    const el = document.getElementById('snd-panel');
    el.classList.add('open');           // measured, so it has to be on screen
    const head = el.querySelector('.snd-head');
    const before = getComputedStyle(head, '::before');
    // Put a level 4 verdict up deliberately: it was the one that glowed and
    // pulsed, so it is the one worth measuring.
    el.querySelector('.snd-verdict').innerHTML = _sndVerdictHTML({
      sb: { label: 'SB', cape: 2900, cin: -30 },
      ml: { label: 'ML', cape: 2400, cin: -40 },
      sfc: { t: 29, td: 22 }, shear6: 55, srh1: 210,
      stp: 2.2, scp: 8, ship: 1.4,
    });
    const w = el.querySelector('.snd-verdict-word');
    const ws = getComputedStyle(w);
    const where = getComputedStyle(el.querySelector('.snd-where'));
    // One track of equal parts, not four loose pills: same row, same width.
    const btns = Array.from(el.querySelectorAll('.snd-tab'))
      .map(b => b.getBoundingClientRect());
    const wide = btns.map(b => Math.round(b.width));
    return {
      thread: before.content !== 'none' && before.content !== 'normal',
      badges: el.querySelectorAll('.snd-badge').length,
      wordBorder: ws.borderTopWidth,
      wordShadow: ws.boxShadow,
      wordAnim: ws.animationName,
      whereBorder: where.borderTopWidth,
      count: btns.length,
      sameRow: btns.every(b => Math.round(b.top) === Math.round(btns[0].top)),
      equal: wide.every(x => Math.abs(x - wide[0]) <= 1),
      wide,
    };
  });
  ok('the decorative colour bar is gone', !r.thread, String(r.thread));
  ok('the verdict is text, not a badge in a bubble',
     r.badges === 0 && r.wordBorder === '0px',
     r.badges + ' badges, border ' + r.wordBorder);
  ok('with no glow around it either', r.wordShadow === 'none', r.wordShadow);
  ok('and it does not pulse for attention', r.wordAnim === 'none', r.wordAnim);
  ok('the coordinate is a caption, not a chip', r.whereBorder === '0px',
     r.whereBorder);
  ok('the four views share one row', r.count === 4 && r.sameRow,
     r.count + ' tabs');
  ok('in equal parts, so none of them reads as the important one',
     r.equal, r.wide.join(','));
}

console.log('\n13g4. the panel is painted in the radar\'s own colours');
{
  // Not "a red theme". Every colour in the panel is an entry in the same NWS
  // reflectivity table the map paints echoes with, so these check the two
  // cannot drift: a hex typed into the panel by hand would pass a screenshot
  // and fail here the moment the radar table changed under it.
  const r = await page.evaluate(async () => {
    const el = document.getElementById('snd-panel');
    el.classList.add('open');
    // A tab fades into its lit state over 140ms. Reading the background the
    // instant it is chosen catches the transition part way and returns
    // transparent about one run in three, which is a flaky test rather than a
    // real fault. Settle first.
    _sndTab(el, 'chart');
    await new Promise(res => setTimeout(res, 260));
    const cs = getComputedStyle(el);
    const tok = n => cs.getPropertyValue(n).trim().toLowerCase();
    const fromTable = dbz =>
      (NWS_DBZ_META.find(m => m.dbz === dbz) || {}).hex.toLowerCase();
    // The verdict word at each level, resolved to real pixels.
    const lv = [];
    const vd = el.querySelector('.snd-verdict');
    for (let i = 0; i <= 4; i++) {
      vd.innerHTML = `<span class="snd-verdict-word lv${i}">x</span>`;
      lv.push(getComputedStyle(vd.firstChild).color);
    }
    const rgb = hex => {
      const n = parseInt(hex.slice(1), 16);
      return `rgb(${n >> 16 & 255}, ${n >> 8 & 255}, ${n & 255})`;
    };
    return {
      tokens: {
        '--r-cyan': [tok('--r-cyan'), fromTable(5)],
        '--r-blue': [tok('--r-blue'), fromTable(10)],
        '--r-green': [tok('--r-green'), fromTable(20)],
        '--r-yellow': [tok('--r-yellow'), fromTable(35)],
        '--r-orange': [tok('--r-orange'), fromTable(45)],
        '--r-red': [tok('--r-red'), fromTable(50)],
        '--r-mag': [tok('--r-mag'), fromTable(65)],
      },
      lv,
      wantLv: [rgb(fromTable(10)), rgb(fromTable(20)), rgb(fromTable(35)),
               rgb(fromTable(45)), rgb(fromTable(50))],
      // Red leads: the panel's own edge is the 50 dBZ red, not a neutral grey.
      edge: cs.borderTopColor,
      titleLit: getComputedStyle(el.querySelector('.snd-title')).color,
      tabLit: getComputedStyle(el.querySelector('.snd-tab.on')).backgroundColor,
    };
  });
  const wrong = Object.entries(r.tokens).filter(([, [got, want]]) => got !== want);
  ok('every colour token is an entry in the radar table, not a copy of one',
     wrong.length === 0,
     wrong.map(([k, v]) => `${k} ${v[0]} != ${v[1]}`).join('; '));
  ok('the verdict runs up the ramp, quiet at the faint end and dangerous at '
     + 'the intense one',
     r.lv.join(' | ') === r.wantLv.join(' | '),
     r.lv.join(' | '));
  ok('and 50 dBZ red leads: it is the panel edge',
     /^rgba?\(2[45]\d, 0, 0/.test(r.edge), r.edge);
  ok('the title is red too, lifted so small type stays readable',
     /^rgb\(255, 111, 99\)$/.test(r.titleLit), r.titleLit);
  ok('and the chosen view is filled with it', /^rgba\(253, 0, 0/.test(r.tabLit),
     r.tabLit);
}

console.log('\n13h. a hanging Pi cannot hang the panel');
{
  // The symptom this section exists for: the panel sat on "Building the
  // sounding" forever. Not one of the sounding fetches had a timeout, and an
  // IMAGE that hangs fires neither onload nor onerror, so its promise never
  // settled at all. The fallback chain below it therefore never ran, and the
  // web source that would have drawn something was never reached.
  // A request that is accepted and then never answered, held open here rather
  // than hoped for from a real address. A refused port is NOT this case: it
  // fires onerror at once, which was always handled. The one that stuck the
  // panel was the request that simply never came back.
  await page.route('**/hangs-forever.png', () => { /* never fulfilled */ });
  const r = await page.evaluate(async () => {
    const out = {};
    // An image request that never answers, the exact case that stuck.
    const t0 = Date.now();
    try {
      await _sndLoadImage('https://example.test/hangs-forever.png', 700);
      out.settled = 'resolved';
    } catch (e) {
      out.settled = 'rejected';
      out.why = String(e.message || e);
    }
    out.waited = Date.now() - t0;
    return out;
  });
  ok('a hanging image gives up instead of waiting for ever',
     r.settled === 'rejected', JSON.stringify(r));
  ok('and says it timed out rather than blaming the file',
     /timed out/.test(r.why || ''), r.why);
  ok('at about the deadline, not long after',
     r.waited < 3000, r.waited + 'ms');
  // Every network read in the sounding path has to be bounded, or one of them
  // becomes the new place it hangs.
  // Read from the SOURCE, not from window. Earlier sections here replace
  // _sndProfile and friends with test doubles, and a double has no timeout,
  // so asking the live function asks the mock and fails a fixed product.
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const bounded = ['_sndSitesManifest', '_sndPrebuilt', '_sndProfile',
                   '_sndOMSeries', '_sndPiSounding', '_sndLoadImage']
    .filter(n => {
      const m = new RegExp('\\n(?:async )?function ' + n
                           + '\\([\\s\\S]*?\\n\\}').exec(html);
      return !m || !/_abortSignal\(|setTimeout\(/.test(m[0]);
    });
  ok('every sounding fetch is bounded by a deadline',
     bounded.length === 0, bounded.join(', '));
}

console.log('\n13i. a source that cannot answer says so, instead of quietly '
          + 'becoming Open-Meteo');
{
  // The behaviour this replaces: every branch of _sndFetchFor ended at
  // Open-Meteo. Pick "RAP analysis (Pi)" with the Pi off and you got a full
  // chart drawn from Open-Meteo's global blend, while the picker still read
  // RAP and the only hint was a line of small print under a table in a pane
  // that is hidden unless the Numbers tab is up. Reading CAPE off that chart
  // meant reading a different model than the one chosen, with nothing on
  // screen to say so.
  const setup = async (mode) => page.evaluate((mode) => {
    window.__om = 0;
    // Counted rather than routed, so this measures the DECISION to reach for
    // Open-Meteo and not whether a request happened to succeed.
    _sndOpenMeteo = async (lat, lon, hr, id) => {
      window.__om++;
      return { via: 'openmeteo', label: 'Open-Meteo', valid: 'now', hour: 0,
               levels: [{ p: 1000, t: 25, td: 20, u: 5, v: 5, zMSL: 100 },
                        { p: 850, t: 14, td: 8, u: 10, v: 8, zMSL: 1500 },
                        { p: 700, t: 4, td: -4, u: 15, v: 10, zMSL: 3100 },
                        { p: 500, t: -10, td: -24, u: 30, v: 15, zMSL: 5800 },
                        { p: 300, t: -34, td: -50, u: 50, v: 20, zMSL: 9600 }] };
    };
    const boom = async () => { throw new Error('the Pi is not answering'); };
    _sndPiSounding = boom; _sndProfile = boom; _sndPrebuilt = boom;
    _sndPiModelSounding = boom;
    if (mode === 'pisite-recovers') {
      _sndProfile = async () => ({ via: 'levels', run: 'x', hour: 0,
        levels: [{ p: 1000, t: 25, rh: 70 }, { p: 850, t: 14, rh: 60 },
                 { p: 700, t: 4, rh: 50 }, { p: 500, t: -10, rh: 40 }] });
    }
  }, mode);

  const attempt = (src) => page.evaluate(async (src) => {
    _sndSource = src;
    const el = document.getElementById('snd-panel')
      || Object.assign(document.createElement('div'), { id: 'tmp' });
    try {
      const r = await _sndFetchFor(el, 35.3, -97.3, 0);
      return { threw: false, via: r.prof && r.prof.via, om: window.__om };
    } catch (e) {
      return { threw: true, om: window.__om, down: !!e.sourceDown,
               label: e.sourceLabel || '', why: String(e.message || e) };
    }
  }, src);

  await setup('all-fail');
  for (const [src, label] of [['rap', 'RAP analysis (Pi)'],
                              ['levels', 'Pi model levels'],
                              ['pisite', 'Pi site images (SounderPy)']]) {
    const r = await attempt(src);
    ok(`${src} fails as itself rather than becoming Open-Meteo`,
       r.threw === true && r.om === 0, JSON.stringify(r));
    ok(`  and the failure names ${label}`,
       r.down === true && r.label === label, JSON.stringify(r));
  }

  // A model source, which had its own copy of the fallback and additionally
  // swapped the forecast hour for the current one on the way out.
  await page.evaluate(() => {
    _sndPiSources = [{ id: 'model:gfs', pi: 'model:gfs', model: 'gfs',
                       label: 'GFS (model)', out: 48, step: 3, isModel: true }];
  });
  const rm = await attempt('model:gfs');
  ok('a model source fails as itself too',
     rm.threw === true && rm.om === 0 && rm.label === 'GFS (model)',
     JSON.stringify(rm));

  // Open-Meteo is still reachable. It was never the problem; being reached
  // WITHOUT being asked for was.
  const rw = await attempt('web');
  ok('Open-Meteo still answers when it is the one picked',
     rw.threw === false && rw.via === 'openmeteo' && rw.om === 1,
     JSON.stringify(rw));

  // The one recovery kept: inside the Pi's own sounding source, from its
  // rendered images to its level images. Same Pi, same data, and it says so.
  await setup('pisite-recovers');
  const rp = await page.evaluate(async () => {
    _sndSource = 'pisite';
    const r = await _sndFetchFor(document.createElement('div'), 35.3, -97.3, 0);
    return { via: r.prof.via, fellBack: r.fellBack, om: window.__om };
  });
  ok('the Pi still recovers from its images to its levels, and announces it',
     rp.via === 'levels' && /not answering/.test(rp.fellBack || '')
     && rp.om === 0, JSON.stringify(rp));

  // Now the message itself, through the real panel.
  await setup('all-fail');
  const shown = await page.evaluate(async () => {
    const el = document.getElementById('snd-panel');
    _sndSource = 'rap';
    // Something drawn first, so the "stale chart is cleared" check has a
    // stale chart to clear.
    el._snd = { rows: [1, 2, 3] };
    // Recorded rather than assumed: earlier sections in this file leave the
    // select on whatever they last chose, so the claim is that the FAILURE
    // does not move it, not that it happens to read 'rap'.
    const pickerBefore = el.querySelector('.snd-src').value;
    await _sndRefresh(el, 0);
    const a = el.querySelector('.snd-alert');
    const box = a.getBoundingClientRect();
    return {
      // The bug that made every message unreachable: the only place an error
      // was written lives inside a pane that is hidden on the tab the panel
      // opens on.
      insideHiddenPane: !!a.closest('.snd-pane'),
      onScreen: box.width > 0 && box.height > 0,
      namesSource: /RAP analysis \(Pi\) could not answer/.test(a.textContent),
      saysNotSwapped: /not a different model wearing/.test(a.textContent),
      offersWeb: !!a.querySelector('button.snd-fix-go'),
      offersRetry: a.querySelectorAll('.snd-fix button').length === 2,
      staleChartGone: el._snd === null,
      pickerUnmoved: el.querySelector('.snd-src').value === pickerBefore,
      pickerNow: el.querySelector('.snd-src').value,
      om: window.__om,
    };
  });
  ok('the failure is written where it can actually be seen',
     shown.insideHiddenPane === false && shown.onScreen === true,
     JSON.stringify(shown));
  ok('it names the source that failed', shown.namesSource, JSON.stringify(shown));
  ok('and says plainly that nothing was substituted', shown.saysNotSwapped);
  ok('it offers Open-Meteo as a button, and a retry',
     shown.offersWeb && shown.offersRetry, JSON.stringify(shown));
  ok('the picker has not moved on its own',
     shown.pickerUnmoved, shown.pickerNow);
  ok('nothing was fetched from Open-Meteo to get here', shown.om === 0);
  // A chart left under a failure message is the same lie in a quieter voice.
  ok('and the previous chart is cleared rather than left to be read',
     shown.staleChartGone, JSON.stringify(shown));

  // Pressing the button is what moves the panel, and only then.
  const after = await page.evaluate(async () => {
    document.querySelector('#snd-panel .snd-fix-go').click();
    await new Promise(r => setTimeout(r, 300));
    const el = document.getElementById('snd-panel');
    return { source: _sndSource, picker: el.querySelector('.snd-src').value,
             via: el._prof && el._prof.via,
             alertCleared: el.querySelector('.snd-alert').innerHTML === '',
             saved: localStorage.getItem('gwcfc_snd_source'),
             om: window.__om };
  });
  ok('pressing it switches to Open-Meteo and draws',
     after.source === 'web' && after.via === 'openmeteo' && after.om === 1,
     JSON.stringify(after));
  ok('the picker follows, and the choice is remembered',
     after.picker === 'web' && after.saved === 'web', JSON.stringify(after));
  ok('and the failure message goes once there is an answer',
     after.alertCleared, JSON.stringify(after));

  // The source itself, so a future edit cannot quietly reinstate the old
  // behaviour by adding one more catch.
  const src = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const fn = /\nasync function _sndFetchFor\([\s\S]*?\n\}/.exec(src);
  const omInFetch = (fn ? fn[0] : '').match(/_sndOpenMeteo\(/g) || [];
  ok('_sndFetchFor reaches for Open-Meteo exactly once, on the web branch',
     omInFetch.length === 1, String(omInFetch.length));
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
