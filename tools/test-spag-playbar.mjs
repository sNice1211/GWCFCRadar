#!/usr/bin/env node
/*
 * The Spaghetti Models panel, flattened and given the shared playbar, and the
 * AI Cyclones mean track, which was dead.
 *
 *     npm i playwright && node tools/test-spag-playbar.mjs
 *
 * THE PANEL. It was two folding cards, Model Guidance and Track Animation,
 * and they were never two subjects: the animation animates the guidance.
 * Splitting them meant the play button could be folded away from the lines it
 * plays, and someone who closed the second card had no way to know a clock
 * existed at all. It is now one flat section in Run Models' shape, sharing
 * that panel's actual playbar rules rather than a hand-rolled range input with
 * two vendor-prefixed thumbs.
 *
 * THE MEAN TRACK. It answered "turn the AI cyclone tracks on first" while the
 * tracks were plainly on. _cycStorms threw away every group key containing
 * "unknown", and the feed routinely names no storm, so it returned an empty
 * list on most runs. The borrowed name went into the LABEL while the key kept
 * the literal "unknown", and everything downstream reads the key. Both the
 * mean track and the ensemble stats start from that list, so both were dead in
 * exactly the case the surrounding code goes to trouble to handle.
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

const LEAFLET_STUB = `(() => {
  const poly = (ll, o) => ({ __ll: ll, __o: o,
    setLatLngs(v) { this.__ll = v; return this; },
    getLatLngs() { return this.__ll; },
    addTo() { return this; }, on() { return this; }, remove() { return this; },
    bindTooltip() { return this; }, setStyle(s) { this.__o = { ...this.__o, ...s }; return this; } });
  const mk = (ll, o) => ({ __ll: ll, __o: o, __el: document.createElement('div'),
    setLatLng(v) { this.__ll = v; return this; },
    getLatLng() { return this.__ll; },
    getElement() { return this.__el; },
    addTo() { return this; }, on() { return this; }, remove() { return this; },
    bindTooltip() { return this; }, setStyle() { return this; },
    setIcon() { return this; }, setZIndexOffset() { return this; } });
  const fm = {
    getZoom: () => 5, setZoom() {}, setZoomAround() {}, _limitZoom: z => z,
    getContainer: () => document.getElementById('map') || document.body,
    mouseEventToContainerPoint: e => ({ x: e.clientX, y: e.clientY }),
    scrollWheelZoom: { disable() {}, enable() {} },
    getCenter: () => ({ lat: 25, lng: -70 }),
    hasLayer: () => false, addLayer() { return this; }, removeLayer() { return this; },
    getPane: () => document.createElement('div'),
    createPane: () => document.createElement('div'),
    on() { return this; }, off() { return this; }, once() { return this; },
    fire() { return this; }, invalidateSize() { return this; },
    flyTo() { return this; }, panTo() { return this; }, setView() { return this; },
    getSize: () => ({ x: 400, y: 400 }),
    getBounds: () => ({ getWest: () => -100, getEast: () => -40, getNorth: () => 45,
      getSouth: () => 5, contains: () => true, pad() { return this; } }),
    dragging: { enable() {}, disable() {} }, touchZoom: { enable() {}, disable() {} },
    doubleClickZoom: { enable() {}, disable() {}, enabled: () => true },
    attributionControl: { setPrefix() {}, getContainer: () => document.createElement('div') },
  };
  const ch = () => new Proxy(function(){}, { get: (t, k) => {
    if (k === 'map') return () => fm;
    if (k === 'polyline') return poly;
    if (k === 'marker' || k === 'circleMarker') return mk;
    if (k === 'divIcon') return o => o;
    if (k === 'imageOverlay') return () => ({ addTo() { return this; }, on() { return this; } });
    if (k === 'then') return undefined;
    return ch();
  }, apply: () => ch(), construct: () => ch() });
  Object.defineProperty(window, 'L', { value: ch(), writable: true, configurable: true });
})();`;

const browser = await chromium.launch({ executablePath: chromePath() });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.addInitScript(LEAFLET_STUB);
await page.route('**://**', (r) =>
  r.request().url().startsWith('file://') ? r.continue() : r.abort());
await page.goto('file://' + join(ROOT, 'index.html'),
                { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);

console.log('\n1. the spaghetti panel is one flat section');
ok('no uncaught errors while starting', errors.length === 0, errors[0]);
{
  const r = await page.evaluate(() => {
    const p = document.getElementById('spaghetti-models-panel');
    return {
      exists: !!p,
      noCards: !p.querySelector('.spanel-card'),
      noHeads: !p.querySelector('.spanel-head'),
      playbar: !!p.querySelector('.sev-playbar-row'),
      fcast: !!p.querySelector('.sev-fcast-header'),
      chips: !!p.querySelector('#spag-groups'),
      // The hand-rolled range input is gone, replaced by the shared track.
      noRange: !p.querySelector('#tanim-scrub'),
      track: !!p.querySelector('#tanim-playbar-track'),
      panelClass: p.className,
    };
  });
  ok('the panel is there', r.exists);
  ok('the two folding cards are gone', r.noCards && r.noHeads);
  ok('it has the models panel playbar', r.playbar);
  ok('and the forecast-hour header', r.fcast);
  ok('the model chips are still there', r.chips);
  ok('the hand-rolled range slider is gone', r.noRange);
  ok('replaced by the shared playbar track', r.track);
  ok('on the shared panel shell',
     /models-style-panel/.test(r.panelClass), r.panelClass);
}

console.log('\n2. the card system is gone everywhere, not just hidden');
{
  const r = await page.evaluate(() => ({
    anyCard: document.querySelectorAll('.spanel-card').length,
    toggle: typeof window._spCardToggle,
    restore: typeof window._spCardRestore,
    cycCard: !document.querySelector('#ai-cyclones-panel .spanel-card'),
  }));
  // Both panels are flat now, so the fold machinery has no users. Leaving it
  // behind is dead code the next reader takes as still in play.
  ok('no cards remain in the page', r.anyCard === 0, r.anyCard);
  ok('and the fold machinery went with them',
     r.toggle === 'undefined' && r.restore === 'undefined',
     r.toggle + '/' + r.restore);
  ok('the AI Cyclones panel is flat too', r.cycCard);
}

console.log('\n3. the two switches are one row');
{
  const r = await page.evaluate(() => {
    const row = document.getElementById('spag-layer-row');
    const cs = row ? getComputedStyle(row) : null;
    return {
      ids: row ? [...row.querySelectorAll('button')].map(b => b.id) : [],
      display: cs ? cs.display : null,
      cols: cs ? cs.gridTemplateColumns.split(' ').length : 0,
    };
  });
  ok('guidance and the clock reset sit together',
     r.ids.join(',') === 'spag-btn,tanim-stop', r.ids.join(','));
  ok('laid out as a grid', r.display === 'grid', r.display);
  ok('two columns wide', r.cols === 2, r.cols);
}

console.log('\n4. the playbar drives the forecast-hour clock');
{
  const r = await page.evaluate(() => {
    _tanim.hMax = 120;
    _tanim.h = 0;
    _tanim.on = false;
    _tanim.tracks = [{ pts: [] }, { pts: [] }];
    _tanimSyncBar(60);
    const fill = document.getElementById('tanim-playbar-fill').style.width;
    const thumb = document.getElementById('tanim-playbar-thumb').style.left;
    const hour = document.getElementById('tanim-hour').textContent;
    const date = document.getElementById('tanim-fcast-date').textContent;
    return { fill, thumb, hour, date };
  });
  ok('halfway through 120 hours fills the bar halfway',
     r.fill === '50%', r.fill);
  ok('and the thumb sits there too', r.thumb === '50%', r.thumb);
  ok('the hour reads F+060', r.hour === 'F+060', r.hour);
  ok('and the header says what is loaded',
     /2 tracks, out to F\+120/.test(r.date), r.date);
}

console.log('\n5. the play icon follows the clock, from one place');
{
  const r = await page.evaluate(() => {
    _tanim.on = true;  _tanimSyncBar();
    const playing = document.getElementById('tanim-play').innerHTML;
    _tanim.on = false; _tanimSyncBar();
    const paused = document.getElementById('tanim-play').innerHTML;
    return { playing, paused,
             onClass: /on/.test(document.getElementById('tanim-play').className) };
  });
  // Five scattered pairs of lines used to write this icon, and they had
  // drifted: pause wrote the icon but left the bar where it was.
  ok('running shows pause', /ic-pause/.test(r.playing));
  ok('stopped shows play', /ic-play/.test(r.paused));
  ok('and the filled state comes off with it', !r.onClass);
}

console.log('\n6. speed is a multiple, and it cycles');
{
  const r = await page.evaluate(() => {
    _tanim.speed = 24;
    const seen = [];
    for (let i = 0; i < 5; i++) { _tanimCycleSpeed(); seen.push(_tanim.speed); }
    return { seen, label: document.getElementById('tanim-speed-btn').textContent };
  });
  ok('the speeds cycle round',
     JSON.stringify(r.seen) === JSON.stringify([48, 96, 12, 24, 48]),
     JSON.stringify(r.seen));
  ok('shown as a multiple, like the other two panels', /×/.test(r.label), r.label);
}

console.log('\n7. dragging the bar seeks the clock');
{
  const r = await page.evaluate(() => {
    const panel = document.getElementById('spaghetti-models-panel');
    panel.style.display = 'block';
    panel.style.visibility = 'visible';
    const track = document.getElementById('tanim-playbar-track');
    track.style.width = '200px';
    track.style.display = 'block';
    // Give the collector something real to find, then let the seek build its
    // own layers the way it does in the app. Handing it half a state instead
    // was testing a situation the app never reaches.
    _tanimStop();
    _tanimCollect = () => ([{ pts: [
      { h: 0, lat: 20, lon: -60 }, { h: 60, lat: 25, lon: -65 },
      { h: 120, lat: 30, lon: -70 }] }]);
    const rect = track.getBoundingClientRect();
    track.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: rect.left + rect.width * 0.25, clientY: rect.top + 4,
      bubbles: true, cancelable: true }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    return { h: Math.round(_tanim.h), hMax: _tanim.hMax,
             lines: _tanim.lines.length, width: rect.width };
  });
  ok('the seek built the layers it needed', r.lines === 1, r.lines);
  ok('and the span came from the track', r.hMax === 120, r.hMax);
  // A quarter of the way along a 120 hour span is hour 30.
  ok('a quarter of the way along is F+030',
     Math.abs(r.h - 30) <= 2, r.h + ', track ' + r.width + 'px');
}

console.log('\n8. the mean track works when the feed names the storm');
{
  const r = await page.evaluate(() => {
    const pts = (n, lon0) => Array.from({ length: n }, (_, i) =>
      ({ lat: 20 + i * 0.8, lon: lon0 - i * 0.9, lead: i * 6,
         wind: 40 + i * 4, mslp: 1000 - i * 3 }));
    _cycGroups = {}; _cycLayers = []; _cycClearMeanTrack();
    for (let m = 1; m <= 6; m++) {
      const k = `f|ida|${String(m).padStart(2, '0')}`;
      _cycDrawTrack(pts(9, -60 - m * 0.3),
                    { color: '#7fd4ff', weight: 1, opacity: 0.35 }, k, 'IDA M' + m);
      _cycGroups[k].pts = pts(9, -60 - m * 0.3);
    }
    _spagCycMeanTrack();
    return { storms: _cycStorms(), drawn: _cycMeanLayers.length };
  });
  ok('the storm is found', r.storms.length === 1 && r.storms[0].storm === 'ida',
     JSON.stringify(r.storms));
  ok('and the mean track is drawn', r.drawn > 0, r.drawn);
}

console.log('\n9. and when it does not, which is the normal case');
{
  const r = await page.evaluate(() => {
    const pts = (n, lon0) => Array.from({ length: n }, (_, i) =>
      ({ lat: 20 + i * 0.8, lon: lon0 - i * 0.9, lead: i * 6,
         wind: 40 + i * 4, mslp: 1000 - i * 3 }));
    _cycGroups = {}; _cycLayers = []; _cycClearMeanTrack();
    for (let m = 1; m <= 6; m++) {
      const k = `f|unknown|${String(m).padStart(2, '0')}`;
      _cycDrawTrack(pts(9, -60 - m * 0.3),
                    { color: '#7fd4ff', weight: 1, opacity: 0.35 }, k, 'M' + m);
      _cycGroups[k].pts = pts(9, -60 - m * 0.3);
    }
    const storms = _cycStorms();
    const members = _cycMembersOf('unknown').length;
    _spagCycMeanTrack();
    return { storms, members, drawn: _cycMeanLayers.length,
             btnOn: document.getElementById('cyc-mean-btn')
                      .classList.contains('on') };
  });
  // This is the bug. The members were always there; the storm list threw the
  // only key they had away, so the button answered "turn the tracks on first"
  // over six member tracks that were plainly on.
  ok('the members were always findable', r.members === 6, r.members);
  ok('an unnamed storm is now a storm', r.storms.length === 1,
     JSON.stringify(r.storms));
  ok('so the mean track draws', r.drawn > 0, r.drawn);
  ok('and the button shows itself on', r.btnOn);
}

console.log('\n10. the ensemble stats work on the same list');
{
  const r = await page.evaluate(() => {
    const e = _cycEnsemble('unknown');
    return { got: !!e, members: e && e.members, mean: e && e.meanTrack.length };
  });
  // Same root cause, same fix: the stats panel starts from _cycStorms too.
  ok('the ensemble is readable for an unnamed storm', r.got);
  ok('with all six members', r.members === 6, r.members);
  ok('and a mean track to draw', r.mean > 1, r.mean);
}

console.log('\n11. a named storm still wins over unnamed ones on a tie');
{
  const r = await page.evaluate(() => {
    const pts = (n, lon0) => Array.from({ length: n }, (_, i) =>
      ({ lat: 20 + i * 0.8, lon: lon0 - i * 0.9, lead: i * 6, wind: 40, mslp: 1000 }));
    _cycGroups = {}; _cycLayers = [];
    for (let m = 1; m <= 3; m++) {
      for (const name of ['unknown', 'ida']) {
        const k = `f|${name}|${m}`;
        _cycDrawTrack(pts(5, -60), { color: '#7fd4ff', weight: 1, opacity: 0.35 },
                      k, name + ' M' + m);
        _cycGroups[k].pts = pts(5, -60);
      }
    }
    return _cycStorms();
  });
  ok('both are listed', r.length === 2, JSON.stringify(r));
  ok('and the named one is offered first', r[0].storm === 'ida',
     JSON.stringify(r));
}

console.log('\n12. nothing threw along the way');
ok('no uncaught errors at all', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
