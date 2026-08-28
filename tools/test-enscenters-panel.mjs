#!/usr/bin/env node
/*
 * The GEFS Ensemble Centres layer, driven through the real page.
 *
 *     node tools/test-enscenters-panel.mjs
 *
 * The Pi half of this feature has its own suite (tools/test-enscenters.py),
 * which proves the detection finds real cyclones and refuses cold-core lows.
 * This is the other half: given a run the Pi has already built, does the page
 * draw it, colour it honestly, and put it away again.
 *
 * Three things here are worth more than the rest.
 *
 * The colour is a claim. A line drawn in the major-hurricane red is telling
 * somebody a member spun up a category three, so the band a track lands in is
 * checked against its own peak wind rather than assumed from the code reading
 * plausibly.
 *
 * The two cyclone layers share their drawing code and must not share their
 * lifetime. The DeepMind tracks and these are separate buttons over the same
 * map, and an earlier draft wiped the shared group registry on either one's
 * clear: the other layer's lines stayed drawn while every tag on them went
 * dead. So one is turned off underneath the other on purpose here.
 *
 * And an empty result is not a failure. A run with no closed warm-core low in
 * any member is what a quiet tropics looks like, and the panel has to say so
 * in those words rather than looking broken.
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

// ── the run the Pi is pretending to have built ──────────────────────────────
// Shaped exactly as enscenters_pipeline.build writes it: step_h, lat, lon,
// mslp_hpa and vmax_kt per point, member on the track.
const line = (member, pts) => ({ member, points: pts.map(([h, la, lo, p, v]) =>
  ({ step_h: h, lat: la, lon: lo, mslp_hpa: p, vmax_kt: v })) });

const RUN = {
  model: 'gefs', label: 'GEFS ensemble centres',
  run: '20260825_00', members: 31, step_h: 6, out_h: 168,
  built: '2026-08-25T04:35:00Z',
  tracks: [
    // A major: deep enough that Atkinson-Holliday puts it past 96 kt.
    line('gep03', [[0, 14.0, -48.0, 995, 45], [6, 14.6, -49.4, 972, 78],
                   [12, 15.3, -50.9, 941, 112], [18, 16.1, -52.5, 948, 104]]),
    // A hurricane, but not a major.
    line('gep07', [[0, 13.8, -47.6, 999, 38], [6, 14.3, -49.0, 984, 62],
                   [12, 15.0, -50.2, 973, 76]]),
    // A depression that never gets going, which is most members most of the time.
    line('gec00', [[0, 13.9, -47.9, 1006, 22], [6, 14.2, -49.1, 1004, 26],
                   [12, 14.5, -50.4, 1005, 24]]),
    // And one across the date line, where a naive polyline goes the wrong way
    // round the world.
    line('gep11', [[0, 15.0, 178.0, 990, 55], [6, 15.4, 179.4, 988, 58],
                   [12, 15.9, -179.2, 986, 61], [18, 16.3, -177.8, 989, 57]]),
  ],
};
const QUIET = { ...RUN, run: '20260825_06', tracks: [] };

let serve = RUN;           // flipped between sections
let missing = false;       // the Pi has not built anything at all

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));

const json = (route, obj) => route.fulfill({ contentType: 'application/json',
  body: JSON.stringify(obj), headers: { 'Access-Control-Allow-Origin': '*' } });

await page.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript',
      body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css',
      body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  if (url.includes('/enscenters/latest.json')) {
    if (missing) return route.fulfill({ status: 404, body: '' });
    return json(route, { run: serve.run, path: `${serve.run}/gefs.json`,
                         model: 'gefs', members: serve.members,
                         updated: serve.built });
  }
  if (url.includes('/enscenters/') && url.includes('gefs.json'))
    return json(route, serve);
  return route.abort();
});

await page.goto('file://' + join(ROOT, 'index.html'),
                { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4200);
await page.evaluate(() => { if (typeof closeTutorial === 'function') closeTutorial(); });
// Point the page at a Pi that does not exist, so nothing below depends on a
// real one being up or on which GEFS run it happens to be holding.
await page.evaluate(() => { _hdBase = 'https://example.invalid/wx'; });

const st = () => page.evaluate(() => ({
  on: _ensOn, layers: _ensLayers.length,
  keys: Object.keys(_cycGroups),
  status: (document.getElementById('cyc-ens-status') || {}).textContent || '',
  btn: (document.getElementById('cyc-ens-centres-btn') || {}).textContent || '',
}));
const fresh = () => page.evaluate(() => { _ensIndex = null; _ensAt = 0; });

console.log('\n1. the control is on the panel, next to the models it sits beside');
{
  const seen = await page.evaluate(() => ({
    btn: !!document.getElementById('cyc-ens-centres-btn'),
    // The panel is one merged section now, so there is no GEFS sub-head to
    // read. The button itself is what names the ensemble, which is where a
    // person looks anyway.
    label: (document.getElementById('cyc-ens-centres-btn') || {}).textContent || '',
    status: !!document.getElementById('cyc-ens-status'),
    // The DeepMind controls are still where they were. This layer is an
    // addition to that panel, not a replacement for it.
    lab: !!document.getElementById('cyc-lab-btn'),
    inPanel: !!document.querySelector('#ai-cyclones-panel #cyc-ens-centres-btn'),
  }));
  ok('there is a GEFS centres button', seen.btn);
  ok('it is inside the AI Cyclones panel, beside the DeepMind tracks',
     seen.inPanel);
  ok('the button says which ensemble this is', /GEFS/.test(seen.label), seen.label);
  ok('there is a status line for it', seen.status);
  ok('and the DeepMind tracks button is untouched', seen.lab);
}

console.log('\n2. turning it on draws the run');
{
  await page.evaluate(() => _ensToggle());
  await page.waitForTimeout(400);
  const s = await st();
  ok('the layer is on', s.on === true);
  // Four tracks: three plain, one split in two by the date line. Every drawn
  // track also carries a tag, so eight pieces is the honest count.
  ok('every track in the run was drawn', s.layers === 9, String(s.layers));
  ok('all four are registered under ensemble keys',
     s.keys.filter(k => k.startsWith('ens|')).length === 4,
     s.keys.join(','));
  ok('the button now offers to hide them', /Hide/.test(s.btn), s.btn);
  ok('the status names the run', s.status.includes('20260825_00'), s.status);
  ok('and says how many members were read', /31 members/.test(s.status), s.status);
  ok('and how many of them reached hurricane strength',
     /2 reaching hurricane strength/.test(s.status), s.status);
}

console.log('\n3. the colour is a claim about intensity, so it is checked');
{
  const bands = await page.evaluate(() => {
    const out = {};
    Object.entries(_cycGroups).forEach(([k, g]) => {
      if (!k.startsWith('ens|') || !g.pts) return;
      const peak = Math.max(...g.pts.map(p => p.wind));
      out[k.split('|')[1]] = { peak, color: g.lines[0].options.color,
                               weight: g.lines[0].options.weight,
                               label: g.label };
    });
    return out;
  });
  ok('the 112 kt member is drawn in the major-hurricane colour',
     bands.gep03 && bands.gep03.color === '#ff5d5d',
     bands.gep03 && `${bands.gep03.peak} kt ${bands.gep03.color}`);
  ok('the 76 kt member is drawn as a hurricane, not a major',
     bands.gep07 && bands.gep07.color === '#ffb03a',
     bands.gep07 && `${bands.gep07.peak} kt ${bands.gep07.color}`);
  ok('the 26 kt control member is drawn as a depression',
     bands.gec00 && bands.gec00.color === '#7fd4ff',
     bands.gec00 && `${bands.gec00.peak} kt ${bands.gec00.color}`);
  ok('the 61 kt member is a tropical storm, one band below hurricane',
     bands.gep11 && bands.gep11.color === '#ffe86b',
     bands.gep11 && `${bands.gep11.peak} kt ${bands.gep11.color}`);
  // Weight as well as colour. Fifty lines at one width is a tangle whichever
  // colours they are, and the ones that matter have to read heavier.
  ok('the members that reach hurricane strength are drawn heavier',
     bands.gep03.weight > bands.gec00.weight,
     `${bands.gep03.weight} vs ${bands.gec00.weight}`);
  ok('the tag says which member it is and how strong it gets',
     /^M3 112kt$/.test(bands.gep03.label), bands.gep03.label);
  ok('and the control member is named as the control, not as member zero',
     /^CTL /.test(bands.gec00.label), bands.gec00.label);
}

console.log('\n4. the date line, where a straight line goes the wrong way');
{
  const legs = await page.evaluate(() => {
    const k = Object.keys(_cycGroups).find(x => x.startsWith('ens|gep11'));
    const g = _cycGroups[k];
    return g.lines.map(l => l.getLatLngs().map(p => Math.round(p.lng)));
  });
  ok('the crossing track is drawn as two pieces, not one', legs.length === 2,
     JSON.stringify(legs));
  ok('neither piece spans the globe',
     legs.every(l => Math.max(...l) - Math.min(...l) < 180),
     JSON.stringify(legs));
}

console.log('\n5. two cyclone layers over one map, with separate lifetimes');
{
  // The DeepMind layer clearing itself must not take these with it. They
  // share _cycDrawTrack and the group registry that makes the tags work, and
  // that sharing is exactly what made this breakable.
  const before = await st();
  await page.evaluate(() => _cycClear());
  const after = await st();
  ok('clearing the DeepMind tracks leaves the ensemble lines on the map',
     after.layers === before.layers, `${before.layers} -> ${after.layers}`);
  ok('and leaves their tags alive, so focus and the readout still work',
     after.keys.filter(k => k.startsWith('ens|')).length === 4,
     after.keys.join(','));
  ok('the ensemble layer still reports itself as on', after.on === true);

  // Focus reads the mapped point names. The Pi writes mslp_hpa and vmax_kt,
  // the shared readout wants mslp and wind, and a rename that never happened
  // shows up here as a readout full of "undefined".
  await page.evaluate(() => {
    const k = Object.keys(_cycGroups).find(x => x.startsWith('ens|gep03'));
    _cycFocus(k);
  });
  const info = await page.evaluate(() =>
    document.getElementById('cyc-focus-info').textContent);
  ok('focusing one member reads out its peak wind',
     /peak wind 112 kt/.test(info), info);
  ok('and its lowest pressure', /lowest pressure 941 hPa/.test(info), info);
  ok('and how far out the track runs', /F\+18h/.test(info), info);
}

console.log('\n6. turning it off puts everything away');
{
  await page.evaluate(() => _ensToggle());
  await page.waitForTimeout(200);
  const s = await st();
  ok('the layer is off', s.on === false);
  ok('nothing of it is left on the map', s.layers === 0, String(s.layers));
  ok('and nothing of it is left in the registry',
     s.keys.filter(k => k.startsWith('ens|')).length === 0, s.keys.join(','));
  ok('the button offers to show them again', /GEFS centres/.test(s.btn), s.btn);
}

console.log('\n7. a run that found nothing, which is a quiet tropics');
{
  serve = QUIET;
  await fresh();
  await page.evaluate(() => _ensToggle());
  await page.waitForTimeout(400);
  const s = await st();
  // Not "on" over an empty map. That is the bug the DeepMind layer already
  // had once: the button reads "Hide" with nothing drawn, and the next press
  // disables rather than retries, so it alternates between two kinds of
  // nothing forever.
  ok('the layer does not claim to be on with nothing drawn', s.on === false);
  ok('nothing was drawn', s.layers === 0, String(s.layers));
  ok('the status says the ensemble ran', /31 members/.test(s.status), s.status);
  ok('and says plainly that this is a quiet tropics, not a failure',
     /quiet tropics/i.test(s.status), s.status);
}

console.log('\n8. no run at all, which is the Pi not having got to it yet');
{
  missing = true;
  await fresh();
  await page.evaluate(() => { _ensIndex = null; });
  await page.evaluate(() => _ensToggle());
  await page.waitForTimeout(400);
  const s = await st();
  ok('the layer stays off', s.on === false);
  ok('the status says no run has arrived', /No ensemble run/.test(s.status),
     s.status);
  ok('and says how often the Pi looks', /four times a day/.test(s.status),
     s.status);
  missing = false;
}

console.log('\n9. credit, and what the data may be used for');
{
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const credit = await page.evaluate(() =>
    (document.getElementById('cyc-credits') || {}).textContent || '');
  ok('the credit is on the panel itself, not buried in a comment',
     credit.length > 0);
  ok('it names Triple-A Tropics', /Triple-A Tropics/.test(credit), credit);
  ok('and names Andrew Austin-Adler', /Andrew Austin-Adler/.test(credit));
  // \s+ not a space: the credit is markup, and markup wraps mid-phrase.
  ok('and says the method was used with permission',
     /with\s+permission/i.test(credit));
  ok('the DeepMind data is attributed', /Google DeepMind/.test(credit));
  // Weather Lab data comes with terms: it is experimental research output and
  // must not be presented as an operational forecast. Saying so is part of
  // being allowed to show it.
  ok('and marked experimental rather than operational',
     /experimental/i.test(credit), credit);
  ok('with the National Hurricane Center named as the real source',
     /National Hurricane Center/.test(credit));
  ok('the pipeline credits it at source too',
     /Triple-A Tropics/.test(
       readFileSync(join(ROOT, 'pi', 'enscenters_pipeline.py'), 'utf8')));
  // Not the update bar: that string describes whatever shipped LAST, and
  // pinning it here made this suite fail the moment anything else shipped.
  // The durable claim is that the feature's own section is still on the
  // panel.
  ok('the ensemble centres section is still on the panel',
     /GEFS ensemble centres/i.test(html));
}

console.log('\n10. house rules');
{
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  ok('no em dash in the page', !html.includes(String.fromCharCode(0x2014)));
  ok('no em dash in the pipeline',
     !readFileSync(join(ROOT, 'pi', 'enscenters_pipeline.py'), 'utf8')
       .includes(String.fromCharCode(0x2014)));
  ok('no em dash in the installer',
     !readFileSync(join(ROOT, 'pi', 'install.sh'), 'utf8')
       .includes(String.fromCharCode(0x2014)));
  ok('the installer registers the new service',
     /gwcfc-ens\.timer/.test(readFileSync(join(ROOT, 'pi', 'install.sh'), 'utf8')));
  ok('and installs the library the detection needs',
     /python3-scipy/.test(readFileSync(join(ROOT, 'pi', 'install.sh'), 'utf8')));
  ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

console.log('\n11. the Pi noticing it is missing a unit, run as the shell runs it');
{
  // The self-updater asks for a reinstall when the installer defines a service
  // this box does not have. That check used to name one unit by hand, so every
  // service added after it needed the line edited too and forgetting was
  // silent. Now it reads the names out of the installer, which is only safe if
  // it reads the lines that WRITE units and not the ones that delete them:
  // gwcfc-obs was removed with its feature, and a looser pattern finds it
  // correctly absent and asks for a reinstall on every run forever.
  //
  // So the fragment is executed rather than eyeballed, against an empty unit
  // directory and then a full one.
  const { execFileSync } = await import('child_process');
  const list = execFileSync('bash', ['-c',
    `grep -o 'cat > "\\$UNITS/gwcfc-[a-z-]*\\.\\(service\\|timer\\)"' `
    + `"${join(ROOT, 'pi', 'install.sh')}" | sed 's|.*/||; s|"$||' | sort -u`
  ], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);

  ok('the new ensemble timer is one of the units it looks for',
     list.includes('gwcfc-ens.timer'), list.join(' '));
  ok('and its service', list.includes('gwcfc-ens.service'));
  ok('the retired obs units are not, because the installer deletes them',
     !list.some(u => u.startsWith('gwcfc-obs')), list.join(' '));
  ok('the units it already had are still all in the list',
     ['gwcfc-serve.service', 'gwcfc-radar.timer', 'gwcfc-models.timer',
      'gwcfc-cyclones.timer', 'gwcfc-snd.timer', 'gwcfc-update.timer']
       .every(u => list.includes(u)), list.join(' '));
  ok('it finds every unit the installer writes, none missed',
     list.length === (readFileSync(join(ROOT, 'pi', 'install.sh'), 'utf8')
       .match(/cat > "\$UNITS\/gwcfc-/g) || []).length,
     String(list.length));
}

await browser.close();
console.log(`\n${fail ? '' : 'all '}${pass} passed`
  + (fail ? `, ${fail} FAILED` : ''));
process.exit(fail ? 1 : 0);
