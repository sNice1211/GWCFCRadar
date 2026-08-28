#!/usr/bin/env node
/*
 * The rebuilt Spaghetti Models panel, driven through the real page.
 *
 *     node tools/test-spaghetti-panel.mjs
 *
 * The Pi half has its own suite (tools/test-spaghetti.py) proving the a-deck
 * parses honestly. This is the page's half: given a guidance document the Pi
 * already built, does the panel draw the right lines in the right colours,
 * prefer a raw run over its interpolated twin, keep thirty-one GEFS members
 * behind a chip instead of on by default, and does the track animation
 * actually march every visible line out hour by hour, dots and all.
 *
 * The animation is tested by SEEKING, not by playing: a wall-clock loop in a
 * test measures the test machine, but a seek to F+24 has exactly one right
 * answer per track, and interpolation inside a segment is what separates
 * dots that glide from dots that teleport every six hours.
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

// ── the guidance the Pi is pretending to have built ─────────────────────────
const P = (tau, lat, lon, vmax, mslp) => ({ tau, lat, lon, vmax, mslp });
const STORM = {
  id: 'al092026', atcf: 'AL092026', name: 'GABRIELLE',
  basin: 'al', cy: 9, year: 2026, cycle: '2026082600',
  source: 'NHC public a-deck (ftp.nhc.noaa.gov)', tier: 'full',
  generated: '2026-08-26T01:00:00Z',
  aids: {
    OFCL: [P(0, 21.9, -65.0, 65, null), P(12, 22.9, -67.1, 70, null),
           P(24, 24.0, -69.2, 75, null), P(36, 25.2, -71.0, 80, null)],
    TVCN: [P(0, 21.9, -65.0, null, null), P(12, 23.0, -67.0, null, null),
           P(24, 24.1, -69.1, null, null)],
    AVNO: [P(0, 21.8, -65.1, 65, 985), P(12, 22.8, -67.2, 70, 980),
           P(24, 23.8, -69.4, 72, 976), P(36, 24.8, -71.4, 74, 973)],
    AVNI: [P(0, 21.9, -65.0, 64, null), P(12, 22.9, -67.1, 69, null)],
    HFSA: [P(0, 21.8, -65.1, 66, 984), P(12, 23.1, -66.8, 78, 972),
           P(24, 24.6, -68.4, 96, 955)],
    AEMN: [P(0, 21.8, -65.1, 60, null), P(12, 22.7, -67.0, 63, null),
           P(24, 23.6, -68.9, 66, null)],
    AC00: [P(0, 21.8, -65.1, 58, null), P(12, 22.6, -67.3, 60, null)],
    AP05: [P(0, 21.8, -65.1, 55, null), P(12, 23.0, -67.5, 61, null),
           P(24, 24.4, -69.9, 68, null)],
    DSHP: [P(0, null, null, 65, null), P(12, null, null, 72, null)],
  },
  aid_meta: {
    OFCL: { kind: 'official', label: 'NHC official', n_points: 4, has_track: true, has_intensity: true, tau_max: 36 },
    TVCN: { kind: 'consensus', label: 'Track consensus', n_points: 3, has_track: true, has_intensity: false, tau_max: 24 },
    AVNO: { kind: 'dynamical', label: 'GFS', n_points: 4, has_track: true, has_intensity: true, tau_max: 36 },
    AVNI: { kind: 'dynamical', label: 'GFS (interp)', n_points: 2, has_track: true, has_intensity: true, tau_max: 12 },
    HFSA: { kind: 'dynamical', label: 'HAFS-A', n_points: 3, has_track: true, has_intensity: true, tau_max: 24 },
    AEMN: { kind: 'ensemble_mean', label: 'GEFS mean', n_points: 3, has_track: true, has_intensity: true, tau_max: 24 },
    AC00: { kind: 'ensemble_member', label: 'GEFS control', n_points: 2, has_track: true, has_intensity: true, tau_max: 12 },
    AP05: { kind: 'ensemble_member', label: 'GEFS p05', n_points: 3, has_track: true, has_intensity: true, tau_max: 24 },
    DSHP: { kind: 'statistical', label: 'DSHIPS intensity', n_points: 2, has_track: false, has_intensity: true, tau_max: 12 },
  },
  official: 'OFCL',
  best_track: [
    { dtg: '2026082518', lat: 21.0, lon: -64.5, vmax: 60, mslp: 990 },
    { dtg: '2026082600', lat: 21.8, lon: -65.1, vmax: 65, mslp: 985 },
  ],
  consensus_membership: [{
    tech: 'TVCN', label: 'Track consensus',
    members: [{ tech: 'AVNI', state: 'present' },
              { tech: 'EMXI', state: 'withheld' }],
    reproducible: false,
  }],
  withheld_note: 'NHC public a-deck withholds ECMWF aids.',
  qc: { seen: 40, kept: 38 },
};
const INDEX = {
  updated: '2026-08-26T01:05:00Z',
  source: 'ATCF a-decks: NHC aid_public + UCAR adecks_open',
  storms: [{ id: 'al092026', atcf: 'AL092026', name: 'GABRIELLE',
             basin: 'al', path: 'al092026.json', cycle: '2026082600',
             tier: 'full', lat: 21.8, lon: -65.1, vmax: 65, mslp: 985,
             n_aids: 9, n_tracks: 7 }],
};
// A GEFS ensemble-centres run whose one storm starts beside GABRIELLE, so
// the nameless track can take her name.
const ENSRUN = {
  model: 'gefs', run: '20260826_00', members: 31, step_h: 6, out_h: 168,
  built: '2026-08-26T04:35:00Z',
  tracks: [{ member: 'gep03', points: [
    { step_h: 0, lat: 21.9, lon: -65.2, mslp_hpa: 986, vmax_kt: 63 },
    { step_h: 6, lat: 22.4, lon: -66.1, mslp_hpa: 979, vmax_kt: 71 },
    { step_h: 12, lat: 23.0, lon: -67.0, mslp_hpa: 968, vmax_kt: 84 },
  ]}],
};

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
  if (url.includes('/spaghetti/latest.json')) return json(route, INDEX);
  if (url.includes('/spaghetti/al092026.json')) return json(route, STORM);
  if (url.includes('/enscenters/latest.json'))
    return json(route, { run: ENSRUN.run, path: `${ENSRUN.run}/gefs.json`,
                         model: 'gefs', members: 31, updated: ENSRUN.built });
  if (url.includes('/enscenters/')) return json(route, ENSRUN);
  return route.abort();
});

await page.goto('file://' + join(ROOT, 'index.html'),
                { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4200);
await page.evaluate(() => { if (typeof closeTutorial === 'function') closeTutorial(); });
await page.evaluate(() => { _hdBase = 'https://example.invalid/wx'; });

const st = () => page.evaluate(() => ({
  on: _spagOn,
  layers: _spagModelTrackLayers.length,
  anim: _spagAnimTracks.length,
  status: (document.getElementById('spag-status') || {}).textContent || '',
  legend: [...document.querySelectorAll('#spag-legend .spag-leg')]
    .map(e => e.textContent),
  tags: [...document.querySelectorAll('.spag-tag')].map(e => e.textContent),
}));

console.log('\n1. the metered pressure-tracing hack is gone, root and branch');
{
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  ok('no Open-Meteo ensemble endpoint anywhere in the page',
     !html.includes('ensemble-api.open-meteo.com'));
  ok('no grid-sampling constants left behind',
     !html.includes('SPAG_GRID_COLS'));
  ok('the panel has the guidance controls instead',
     await page.evaluate(() => !!document.getElementById('spag-btn')
       && !!document.getElementById('spag-groups')
       && !!document.getElementById('spag-legend')));
  // The transport is now the shared Run Models playbar: the range input and
  // the speed dropdown were replaced by a track with a fill and a thumb, and
  // a speed button that cycles multiples.
  ok('and the animation transport',
     await page.evaluate(() => !!document.getElementById('tanim-play')
       && !!document.getElementById('tanim-playbar-track')
       && !!document.getElementById('tanim-speed-btn')));
  ok('all inside the Spaghetti Models panel',
     await page.evaluate(() =>
       !!document.querySelector('#spaghetti-models-panel #spag-btn')
       && !!document.querySelector('#spaghetti-models-panel #tanim-play')));
}

console.log('\n2. turning the guidance on draws the deck');
{
  await page.evaluate(() => _spagToggle());
  await page.waitForTimeout(500);
  const s = await st();
  ok('the layer is on', s.on === true);
  // 7 drawable aids minus the AVNI twin minus 2 members (off by default)
  // = OFCL, TVCN, AVNO, HFSA, AEMN. Each is casing+line+tag = 15, plus the
  // dashed best track = 16.
  ok('exactly the right aids are drawn', s.layers === 16, String(s.layers));
  ok('each line wears its model name tag',
     ['OFCL', 'TVCN', 'AVNO', 'HFSA', 'AEMN'].every(t => s.tags.includes(t)),
     s.tags.join(','));
  ok('the interpolated GFS twin is NOT drawn beside the raw run',
     !s.tags.includes('AVNI'));
  ok('the members wait behind their chip', !s.tags.includes('AP05'));
  ok('the status names the cycle', /2026082600z/.test(s.status), s.status);
  ok('and the storm with its aid count', /GABRIELLE: 5 aids/.test(s.status),
     s.status);
  ok('and says the consensus leans on withheld members',
     /withheld ECMWF/.test(s.status), s.status);
  ok('and names the source', /NHC a-deck/.test(s.status), s.status);
}

console.log('\n3. the colours are the catalogue, not accidents');
{
  const cols = await page.evaluate(() => {
    const by = {};
    _spagModelTrackLayers.forEach(l => {
      if (l.options && l.options.color && l.options.color !== '#000'
          && l.options.color !== '#9fb3c8') {
        by[l.options.color] = (by[l.options.color] || 0) + 1;
      }
    });
    return by;
  });
  ok('the official forecast is white', '#ffffff' in cols, JSON.stringify(cols));
  ok('the consensus is gold', '#ffd166' in cols);
  ok('GFS is its blue', '#29b6f6' in cols);
  ok('HAFS-A is its red', '#ff5d5d' in cols);
  ok('the GEFS mean is its pale blue', '#9fd0ff' in cols);
  const best = await page.evaluate(() =>
    _spagModelTrackLayers.some(l => l.options
      && l.options.color === '#9fb3c8' && l.options.dashArray));
  ok('the best track is there, grey and dashed, under the fan', best);
}

console.log('\n4. the group chips change what is drawn');
{
  await page.evaluate(() => _spagGroupToggle('members'));
  await page.waitForTimeout(400);
  let s = await st();
  // +2 members at casing+line each (members carry no tags) = +4.
  ok('turning the members chip on adds the member lines',
     s.layers === 20, String(s.layers));
  ok('members still do not stack thirty-one tags on the map',
     !s.tags.includes('AP05') && !s.tags.includes('AC00'));
  ok('the animation registry grew with them', s.anim === 7, String(s.anim));
  await page.evaluate(() => _spagGroupToggle('members'));
  await page.waitForTimeout(400);
  s = await st();
  ok('and off again removes them', s.layers === 16, String(s.layers));

  await page.evaluate(() => _spagGroupToggle('official'));
  await page.waitForTimeout(400);
  s = await st();
  ok('hiding the official group removes exactly its three pieces',
     s.layers === 13 && !s.tags.includes('OFCL'), String(s.layers));
  await page.evaluate(() => _spagGroupToggle('official'));
  await page.waitForTimeout(400);
}

console.log('\n5. the legend is per-model and clickable');
{
  let s = await st();
  ok('the legend lists the drawn models',
     ['AVNO', 'HFSA', 'OFCL', 'TVCN', 'AEMN']
       .every(t => s.legend.includes(t)), s.legend.join(','));
  ok('but not the members, whose chip is their handle',
     !s.legend.includes('AP05'));
  await page.evaluate(() => _spagLegendToggle('HFSA'));
  await page.waitForTimeout(400);
  s = await st();
  ok('tapping one model hides just that model',
     s.layers === 13 && !s.tags.includes('HFSA'), String(s.layers));
  ok('its legend chip stays, struck through, so it can come back',
     s.legend.includes('HFSA'));
  await page.evaluate(() => _spagLegendToggle('HFSA'));
  await page.waitForTimeout(400);
  s = await st();
  ok('and tapping again restores it',
     s.layers === 16 && s.tags.includes('HFSA'));
}

console.log('\n6. the GEFS centres take the storm\'s name from the a-deck');
{
  await page.evaluate(() => _ensToggle());
  await page.waitForTimeout(500);
  const g = await page.evaluate(() => {
    const k = Object.keys(_cycGroups).find(x => x.startsWith('ens|'));
    return k ? _cycGroups[k].label : null;
  });
  ok('the nameless ensemble track is named for the nearest active storm',
     g === 'GABRIELLE M3 84kt', String(g));
}

console.log('\n7. the animation: every line dotting its way out');
{
  await page.evaluate(() => _tanimSeek(24));
  await page.waitForTimeout(300);
  const a = await page.evaluate(() => ({
    lines: _tanim.lines.length,
    heads: _tanim.heads.filter(h => map.hasLayer(h)).length,
    hMax: _tanim.hMax,
    hour: document.getElementById('tanim-hour').textContent,
    dimmed: _spagModelTrackLayers.filter(l => l.setStyle
      && l.options.opacity === 0.08).length > 0,
  }));
  // 6 spaghetti tracks (5 aids + best? best is not in the registry: 5) plus
  // the ensemble centres track = 6.
  ok('one animated line per visible track', a.lines === 6, String(a.lines));
  ok('the clock readout shows the seek', a.hour === 'F+024', a.hour);
  ok('the still lines dim underneath so the motion reads', a.dimmed);
  ok('the span comes from the longest track', a.hMax === 36, String(a.hMax));

  // The one-right-answer check: AVNO at F+24 must sit exactly on its 24h
  // point, and at F+30 exactly halfway to its 36h point.
  const avno = await page.evaluate(() => {
    const i = _tanim.tracks.findIndex(t => t.color === '#29b6f6');
    const at = h => { _tanimApply(h); const p = _tanim.heads[i].getLatLng();
                      return [p.lat, p.lng]; };
    _tanim.h = 24; const a24 = at(24);
    _tanim.h = 30; const a30 = at(30);
    return { a24, a30 };
  });
  ok('at F+24 the GFS dot sits on the 24-hour fix',
     Math.abs(avno.a24[0] - 23.8) < 1e-6 && Math.abs(avno.a24[1] + 69.4) < 1e-6,
     JSON.stringify(avno.a24));
  ok('at F+30 it has glided exactly halfway to the 36-hour fix, '
     + 'interpolated inside the segment rather than teleporting',
     Math.abs(avno.a30[0] - 24.3) < 1e-6 && Math.abs(avno.a30[1] + 70.4) < 1e-6,
     JSON.stringify(avno.a30));

  // A dot retires after its track ends; the line it drew stays.
  const done = await page.evaluate(() => {
    const i = _tanim.tracks.findIndex(t => t.pts[t.pts.length - 1].h === 12);
    _tanimApply(36);
    return { gone: !map.hasLayer(_tanim.heads[i]),
             line: _tanim.lines[i].getLatLngs().length > 0 };
  });
  ok('a track that ends early retires its dot', done.gone);
  ok('but keeps the line it drew', done.line);

  const play = await page.evaluate(() => {
    _tanimToggle();          // resume from the seek
    return { on: _tanim.on,
             btn: document.getElementById('tanim-play').textContent };
  });
  ok('play resumes from where the scrub parked it', play.on === true);
  ok('and the button shows pause', play.btn === String.fromCharCode(0x23F8),
     play.btn);
  await page.waitForTimeout(250);
  const moved = await page.evaluate(() => _tanim.h);
  ok('the clock actually runs', moved > 36 - 12 && moved !== 36,
     String(moved));

  await page.evaluate(() => _tanimStop());
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => ({
    lines: _tanim.lines.length,
    restored: _spagModelTrackLayers.every(l => !l.setStyle
      || l.options.opacity !== 0.08),
    hour: document.getElementById('tanim-hour').textContent,
  }));
  ok('stop takes every animated piece off the map', after.lines === 0);
  ok('and gives the still lines their opacity back', after.restored);
  ok('and rewinds the readout', after.hour === 'F+000', after.hour);
}

console.log('\n8. hiding the guidance puts everything away');
{
  await page.evaluate(() => _spagToggle());
  await page.waitForTimeout(300);
  const s = await st();
  ok('off means off', s.on === false && s.layers === 0, String(s.layers));
  ok('the animation registry is empty too', s.anim === 0);
  ok('and closing the panel would not resurrect it: the user-off flag holds',
     await page.evaluate(() => _spagUserOff === true));
}

console.log('\n9. a quiet Atlantic and a missing Pi both say what they are');
{
  await page.evaluate(() => { _spagIndex = { at: Date.now(),
    idx: { updated: 'now', storms: [] } }; _spagUserOff = false; });
  await page.evaluate(() => _spagToggle());
  await page.waitForTimeout(300);
  let s = await st();
  ok('no storms reads as quiet tropics, not as breakage',
     s.on === false && /Quiet tropics/i.test(s.status), s.status);
  await page.evaluate(() => { _spagIndex = null;
    _hdBase = null; _hdResolveBase = async () => null; });
  await page.evaluate(() => _spagToggle());
  await page.waitForTimeout(300);
  s = await st();
  ok('no Pi reads as the Pi not having updated yet',
     s.on === false && /No guidance from the Pi/.test(s.status), s.status);
}

console.log('\n10. house rules, credit, and the section head');
{
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  ok('no em dash in the page', !html.includes(String.fromCharCode(0x2014)));
  ok('the AI section head says both sources now',
     /AI Cyclones · DeepMind \+ GEFS/.test(html));
  ok('the credits name the a-deck and Triple-A Tropics together',
     /ATCF a-deck[\s\S]{0,200}Triple-A Tropics/.test(html));
  ok('and admit the ECMWF withholding on the panel itself',
     await page.evaluate(() => /ECMWF/.test(
       document.getElementById('cyc-credits').textContent)));
  ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

await browser.close();
console.log(`\n${fail ? '' : 'all '}${pass} passed`
  + (fail ? `, ${fail} FAILED` : ''));
process.exit(fail ? 1 : 0);
