#!/usr/bin/env node
/*
 * The AI Cyclones panel: one merged section, styled like Run Models, with a
 * forecast-hour playbar.
 *
 *     npm i playwright && node tools/test-cyclone-playbar.mjs
 *
 * An ensemble of cyclone tracks is a thing that HAPPENS, over about five days,
 * and drawing all of it at once is the single view that hides when. Fifty
 * lines fanning out of Florida tell you where the storm might go and say
 * nothing about whether the spread opens on day two or day five, which is the
 * difference between a forecast you can act on and a picture.
 *
 * So the panel gains the same playbar the models panel has. Nothing is
 * re-fetched to scrub it: every line already holds its full leg, and a frame
 * is that leg cut off at the chosen hour. These checks drive it with a known
 * set of tracks and read the coordinates back off the layers, so "the line got
 * shorter" is a measurement rather than a screenshot.
 *
 * The panel was also two halves, the DeepMind tracks and the GEFS centres,
 * split by a paragraph of prose inside a collapsible card, each with its own
 * button somewhere down the page. They are two views of one question and are
 * now two switches in one row.
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

// Polylines and markers that remember what they were last set to, which is
// what turns "the track shortened" into something readable.
const LEAFLET_STUB = `(() => {
  const mkPoly = (latlngs, opts) => ({
    __latlngs: latlngs, __opts: opts,
    setLatLngs(v) { this.__latlngs = v; return this; },
    getLatLngs() { return this.__latlngs; },
    addTo() { return this; }, on() { return this; }, remove() { return this; },
    setStyle() { return this; },
  });
  const mkMarker = (ll, opts) => ({
    __latlng: ll, __opts: opts, __el: document.createElement('div'),
    setLatLng(v) { this.__latlng = v; return this; },
    getLatLng() { return this.__latlng; },
    getElement() { return this.__el; },
    addTo() { return this; }, on() { return this; }, remove() { return this; },
    bindTooltip() { return this; }, openTooltip() { return this; },
    bindPopup() { return this; }, setIcon() { return this; },
    setZIndexOffset() { return this; }, setOpacity() { return this; },
  });
  const fakeMap = {
    getZoom() { return 5; }, setZoom() {}, setZoomAround() {},
    _limitZoom(z) { return z; },
    getContainer() { return document.getElementById('map') || document.body; },
    mouseEventToContainerPoint(e) { return { x: e.clientX, y: e.clientY }; },
    scrollWheelZoom: { disable(){}, enable(){}, enabled(){ return false; } },
    getCenter() { return { lat: 25, lng: -70 }; },
    hasLayer() { return false; }, addLayer(){ return this; },
    removeLayer(){ return this; },
    getPane() { return document.createElement('div'); },
    createPane() { return document.createElement('div'); },
    on(){ return this; }, off(){ return this; }, once(){ return this; },
    fire(){ return this; }, invalidateSize(){ return this; },
    flyTo(){ return this; }, panTo(){ return this; }, setView(){ return this; },
    getBounds() { return { getWest:()=>-100, getEast:()=>-40, getNorth:()=>45,
      getSouth:()=>5, contains:()=>true, pad(){ return this; } }; },
    getSize() { return { x: 400, y: 400 }; },
    dragging: { enable(){}, disable(){}, enabled(){ return true; } },
    touchZoom: { enable(){}, disable(){} },
    doubleClickZoom: { enable(){}, disable(){}, enabled(){ return true; } },
    attributionControl: { setPrefix(){},
      getContainer(){ return document.createElement('div'); } },
  };
  const chain = () => new Proxy(function(){}, {
    get: (t, k) => {
      if (k === 'map') return () => fakeMap;
      if (k === 'polyline') return mkPoly;
      if (k === 'marker') return mkMarker;
      if (k === 'divIcon') return (o) => o;
      if (k === 'imageOverlay') return (u, b, o) =>
        ({ __url: u, addTo(){ return this; }, on(){ return this; } });
      if (k === 'then') return undefined;
      return chain();
    },
    apply: () => chain(), construct: () => chain(),
  });
  Object.defineProperty(window, 'L', { value: chain(), writable: true, configurable: true });
  window.__fakeMap = fakeMap;
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

console.log('\n1. the panel is one section, laid out like Run Models');
ok('no uncaught errors while starting', errors.length === 0, errors[0]);
{
  const r = await page.evaluate(() => {
    const p = document.getElementById('ai-cyclones-panel');
    const q = (s) => !!p.querySelector(s);
    return {
      exists: !!p,
      // The collapsible card and the paragraph that split it in two are gone.
      noCard: !p.querySelector('#spcard-cyclones'),
      noIntro: !p.querySelector('#cyc-ens-intro'),
      noSubHead: !p.querySelector('#cyc-ens-head'),
      // And it wears the models panel's own clothes.
      dropdowns: q('.sev-dropdowns'),
      runRow: q('.sev-run-row'),
      playbar: q('.sev-playbar-row'),
      fcastHeader: q('.sev-fcast-header'),
      panelClass: p.className,
    };
  });
  ok('the panel is there', r.exists);
  ok('the collapsible card is gone', r.noCard);
  ok('and the paragraph that split it in two', r.noIntro && r.noSubHead);
  ok('it uses the models panel dropdown row', r.dropdowns);
  ok('it has a run row', r.runRow);
  ok('it has the models panel playbar', r.playbar);
  ok('and the forecast-hour header', r.fcastHeader);
  ok('on the shared panel shell',
     /models-style-panel/.test(r.panelClass), r.panelClass);
}

console.log('\n2. the four switches are one row, not a scatter');
{
  const r = await page.evaluate(() => {
    const row = document.getElementById('cyc-layer-row');
    const btns = row ? [...row.querySelectorAll('button')] : [];
    const cs = row ? getComputedStyle(row) : null;
    return {
      count: btns.length,
      ids: btns.map(b => b.id),
      display: cs ? cs.display : null,
      cols: cs ? cs.gridTemplateColumns.split(' ').length : 0,
    };
  });
  ok('all four are in the one row', r.count === 4, r.ids.join(','));
  ok('the AI tracks and the GEFS centres sit together',
     r.ids.includes('cyc-lab-btn') && r.ids.includes('cyc-ens-centres-btn'),
     r.ids.join(','));
  ok('with the mean track and the ensemble stats',
     r.ids.includes('cyc-mean-btn') && r.ids.includes('cyc-ens-btn'),
     r.ids.join(','));
  ok('laid out as a grid rather than floated pills',
     r.display === 'grid', r.display);
  ok('two columns wide, so no name has to be shortened', r.cols === 2, r.cols);
}

console.log('\n3. the playbar hides itself when there is nothing to scrub');
{
  const r = await page.evaluate(() => {
    _cycFrames = [];
    _cycSyncPlaybar();
    const row = document.getElementById('cyc-playbar-row');
    return { hidden: getComputedStyle(row).display === 'none' };
  });
  ok('no run means no slider offered', r.hidden);
}

console.log('\n4. a loaded run gives the bar its forecast hours');
{
  const r = await page.evaluate(() => {
    // Two tracks over the same six-hourly forecast, drawn through the real
    // drawing function so the legs and tags are built exactly as they are
    // in the app.
    const mk = (n, lon0) => Array.from({ length: n }, (_, i) => ({
      lat: 20 + i * 0.8, lon: lon0 - i * 0.9, lead: i * 6,
      wind: 40 + i * 5, mslp: 1000 - i * 4 }));
    _cycGroups = {};
    _cycLayers = [];
    _cycDrawTrack(mk(9, -60), { color: '#7fd4ff', weight: 1, opacity: 0.35 },
                  'm|01', 'IDA M1');
    _cycDrawTrack(mk(9, -62), { color: '#7fd4ff', weight: 1, opacity: 0.35 },
                  'm|02', 'IDA M2');
    _cycIndex = { run: '20260828T12', man: {} };
    _cycBuildFrames();
    return { frames: _cycFrames.slice(), idx: _cycFrameIdx,
             visible: getComputedStyle(
               document.getElementById('cyc-playbar-row')).display !== 'none' };
  });
  ok('the hours come from the tracks themselves',
     JSON.stringify(r.frames) === JSON.stringify([0,6,12,18,24,30,36,42,48]),
     JSON.stringify(r.frames));
  ok('the bar appears once there is something to scrub', r.visible);
  // Opening on the full picture is what someone expects before touching
  // anything; starting at hour zero would look like an empty map.
  ok('and it opens showing the whole forecast', r.idx === 8, r.idx);
}

console.log('\n5. scrubbing actually shortens the tracks');
{
  const r = await page.evaluate(() => {
    const len = () => _cycGroups['m|01'].lines[0].getLatLngs().length;
    const full = len();
    _cycRenderFrame(0);
    const atZero = len();
    _cycRenderFrame(4);              // F+024, five points in
    const atMid = len();
    _cycRenderFrame(8);
    const back = len();
    return { full, atZero, atMid, back };
  });
  ok('the whole track is nine points', r.full === 9, r.full);
  ok('at hour zero only the first point is drawn', r.atZero === 1, r.atZero);
  ok('at F+024 five points are drawn', r.atMid === 5, r.atMid);
  // The end of the bar must restore everything, or scrubbing away and back
  // would quietly lose the tail of every track.
  ok('and the end of the bar puts the whole track back', r.back === 9, r.back);
}

console.log('\n6. the name tag walks along with the storm');
{
  const r = await page.evaluate(() => {
    const tag = () => _cycGroups['m|01'].tags[0].getLatLng();
    _cycRenderFrame(8);
    const end = tag();
    _cycRenderFrame(2);
    const mid = tag();
    return { end, mid, moved: JSON.stringify(end) !== JSON.stringify(mid) };
  });
  // A tag pinned at day five over empty sea is worse than no tag.
  ok('the tag is not left out at the end of the run', r.moved,
     JSON.stringify(r));
  ok('it sits at the head of the drawn part',
     Math.abs(r.mid[0] - (20 + 2 * 0.8)) < 0.001, JSON.stringify(r.mid));
}

console.log('\n7. the labels read the right hour and the right valid time');
{
  const r = await page.evaluate(() => {
    _cycRenderFrame(4);
    return {
      flbl: document.getElementById('cyc-fcast-flbl').textContent,
      date: document.getElementById('cyc-fcast-date').textContent,
      run: document.getElementById('cyc-run-lbl').textContent,
    };
  });
  ok('the forecast hour reads F+024', r.flbl === 'F+024', r.flbl);
  // Run 12Z on the 28th plus 24 hours is 12Z on the 29th. Getting this wrong
  // by parsing the run label loosely would put the whole panel a day out.
  ok('the valid time is the run plus the lead',
     /29 Aug 2026 12/.test(r.date), r.date);
  ok('and the run itself is shown', r.run === '20260828T12', r.run);
}

console.log('\n8. play walks forward, wraps, and stops');
{
  const r = await page.evaluate(async () => {
    _cycSpeed = 4;
    _cycRenderFrame(6);
    _cycTogglePlay();
    const playing = !!_cycPlayTimer;
    await new Promise(res => setTimeout(res, 500));
    const moved = _cycFrameIdx;
    _cycTogglePlay();
    const stopped = !_cycPlayTimer;
    return { playing, moved, stopped, from: 6 };
  });
  ok('pressing play starts it', r.playing);
  ok('and it advances on its own', r.moved !== r.from, r.moved);
  ok('pressing it again stops it', r.stopped);
}

console.log('\n9. play at the end restarts rather than sitting still');
{
  const r = await page.evaluate(async () => {
    _cycStopPlay();
    _cycSpeed = 4;
    _cycRenderFrame(8);              // the last frame
    _cycTogglePlay();
    const justAfter = _cycFrameIdx;
    _cycStopPlay();
    return { justAfter };
  });
  ok('it rewinds to the start instead of doing nothing',
     r.justAfter === 0, r.justAfter);
}

console.log('\n10. the speed button cycles and keeps playing');
{
  const r = await page.evaluate(() => {
    _cycStopPlay();
    _cycSpeed = 1;
    const seen = [];
    for (let i = 0; i < 5; i++) { _cycCycleSpeed(); seen.push(_cycSpeed); }
    const label = document.getElementById('cyc-speed-btn').textContent;
    _cycSpeed = 1;
    _cycTogglePlay();
    _cycCycleSpeed();
    const stillPlaying = !!_cycPlayTimer;
    _cycStopPlay();
    return { seen, label, stillPlaying };
  });
  ok('the speeds cycle round', JSON.stringify(r.seen) === JSON.stringify([2,4,0.5,1,2]),
     JSON.stringify(r.seen));
  ok('the button says which one', /×/.test(r.label), r.label);
  ok('changing speed mid-play does not stop it', r.stillPlaying);
}

console.log('\n11. dragging the bar seeks, and stops playback first');
{
  const r = await page.evaluate(() => {
    _cycRenderFrame(0);
    _cycSpeed = 4;
    _cycTogglePlay();
    // The panel is hidden until opened, and a hidden element has no box, so
    // a seek computed from it would land at zero however the code behaved.
    const panel = document.getElementById('ai-cyclones-panel');
    panel.style.display = 'block';
    panel.style.visibility = 'visible';
    const track = document.getElementById('cyc-playbar-track');
    track.style.width = '200px';
    track.style.display = 'block';
    const r0 = track.getBoundingClientRect();
    track.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: r0.left + r0.width * 0.5, clientY: r0.top + 4,
      bubbles: true, cancelable: true }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    return { idx: _cycFrameIdx, stopped: !_cycPlayTimer, width: r0.width };
  });
  ok('a press on the middle of the bar seeks to the middle',
     r.idx === 4, r.idx + ' of 8, track ' + r.width + 'px');
  ok('and grabbing the bar stops playback', r.stopped);
}

console.log('\n12. clearing the tracks stops the timer');
{
  const r = await page.evaluate(() => {
    _cycSpeed = 4;
    _cycTogglePlay();
    const was = !!_cycPlayTimer;
    _cycClear();
    return { was, now: !!_cycPlayTimer, frames: _cycFrames.length };
  });
  // A running bar over torn-down lines would keep calling setLatLngs on
  // layers that are no longer on the map.
  ok('it was running', r.was);
  ok('and clearing stops it', !r.now);
  ok('and forgets the frames', r.frames === 0, r.frames);
}

console.log('\n13. a track with no forecast hours is still drawn');
{
  const r = await page.evaluate(() => {
    _cycGroups = {}; _cycLayers = [];
    // Some feeds carry no lead at all. Filtering on a missing field would
    // hide the whole track the moment a playbar existed.
    const pts = Array.from({ length: 5 }, (_, i) =>
      ({ lat: 20 + i, lon: -60 - i }));
    _cycDrawTrack(pts, { color: '#7fd4ff', weight: 1, opacity: 0.35 },
                  'n|01', 'NAMELESS M1');
    _cycBuildFrames();
    return { frames: _cycFrames.length,
             drawn: _cycGroups['n|01'].lines[0].getLatLngs().length };
  });
  ok('it offers no bar, since there are no hours to offer', r.frames === 0, r.frames);
  ok('but the track is drawn in full', r.drawn === 5, r.drawn);
}

console.log('\n14. nothing threw along the way');
ok('no uncaught errors at all', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
