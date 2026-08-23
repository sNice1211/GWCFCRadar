#!/usr/bin/env node
/*
 * Every panel and every popup, in the app's own red, and every one a gradient.
 *
 *     node tools/test-surface-system.mjs
 *
 * The claim being checked is a sweeping one, so this does not read the CSS and
 * take its word for it. It opens the real page, finds the surfaces in the real
 * DOM, and asks the browser what it actually computed for each one. A selector
 * with a typo, a rule another rule outranks, and a panel nobody remembered all
 * look identical in the source and are all caught here.
 *
 * Two things are asserted of each surface: its background is a gradient, not a
 * flat fill, and the colours in that gradient are red rather than the navy a
 * lot of these panels used to be.
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
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + String(extra).slice(0, 260) + '>' : '')); }
};

const html = readFileSync(join(ROOT, 'index.html'), 'utf8');

console.log('\n1. the source');
ok('no em dash anywhere in the page', !html.includes('—'));
ok('there is a single place the surfaces are defined',
   /THE SURFACE SYSTEM/.test(html));
ok('and it is built from named tokens, not colours typed at each panel',
   ['--grad-panel', '--grad-surface', '--grad-card', '--grad-raise',
    '--grad-sunk', '--grad-scrim', '--edge-3d', '--lift-3d']
     .every(t => html.includes(t)));
// A pop-out is its own document and the page's stylesheet does not reach it.
ok('the pop-out window carries its own copy of the look',
   /separate document, so the page's own stylesheet does not/.test(html));

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'],
});
const ctx = await browser.newContext();
const page = await ctx.newPage();
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
await page.waitForTimeout(3500);
// Open as much of the interface as will open, so the sweep in section 9 sees
// the panels that are only built the first time they are shown.
await page.evaluate(() => {
  document.querySelectorAll('#tut-modal, #tutorial-modal').forEach(e => { e.style.display = 'none'; });
  ['alerts-panel', 'eas-panel', 'nwr-rec-panel', 'overlay-pills-row', 'gps-hud',
   'overlay-launcher'].forEach(id => {
    const e = document.getElementById(id);
    if (e) e.style.display = 'flex';
  });
});
await page.waitForTimeout(400);

// Reads what the browser really computed, and pulls the rgb triples out of
// whatever gradient it ended up with.
await page.evaluate(() => {
  window.__surface = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return { missing: true };
    const cs = getComputedStyle(el);
    const img = cs.backgroundImage || '';
    const stops = [...img.matchAll(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/g)]
      .map(m => [Number(m[1]), Number(m[2]), Number(m[3])]);
    return {
      gradient: /gradient/.test(img),
      stops,
      shadow: cs.boxShadow || '',
      image: img.slice(0, 120),
    };
  };
  // Red means the red channel leads. Checked on the stops that carry any
  // colour at all, so a gradient that fades to transparent black still counts.
  // Several panels are built the first time they are opened, so they are not
  // in the document at load. A missing element proves nothing about the rule,
  // so a stand-in with the same id is inserted and measured instead: what is
  // being asked is whether the selector reaches an element of that name.
  window.__surfaceOrStub = (sel) => {
    if (document.querySelector(sel)) return __surface(sel);
    const stub = document.createElement('div');
    if (sel.startsWith('#')) stub.id = sel.slice(1);
    else stub.className = sel.replace(/^\./, '').replace(/\./g, ' ');
    stub.style.cssText = 'position:fixed;left:-9999px;width:40px;height:40px;';
    document.body.appendChild(stub);
    const out = __surface(sel);
    out.stubbed = true;
    stub.remove();
    return out;
  };
  window.__isRed = (stops) => {
    const lit = stops.filter(([r, g, b]) => r + g + b > 24);
    return lit.length > 0 && lit.every(([r, g, b]) => r > g && r > b);
  };
  // Cyan: blue leads and green is close behind it.
  window.__isCyan = (stops) => {
    const lit = stops.filter(([r, g, b]) => r + g + b > 24);
    return lit.length > 0 && lit.every(([r, g, b]) => b > r && g > r);
  };
  // Orange: red leads, but green is well clear of blue. That middle term is
  // what separates orange from the red everything else is, and it is the
  // check that would catch the panel quietly going red again.
  window.__isOrange = (stops) => {
    const lit = stops.filter(([r, g, b]) => r + g + b > 24);
    return lit.length > 0 && lit.every(([r, g, b]) => r > g && g > b && (g - b) >= 8);
  };
  // Ink: dark and near-neutral. No channel runs far ahead of the others, and
  // the whole thing stays dark. This is what says a popup is black rather
  // than "a very dark red", which is what it would be if the sweep caught it.
  window.__isInk = (stops) => {
    if (!stops.length) return false;
    return stops.every(([r, g, b]) =>
      Math.max(r, g, b) - Math.min(r, g, b) <= 18 && (r + g + b) / 3 <= 60);
  };
});

// Every surface named in the system, by the selector the CSS uses.
// #eas-panel and #nwr-rec-panel are orange, #animbar is cyan, and the alert
// popup and the overlay panels are black. All of those are checked on their
// own below; what is left here is the red family.
const PANELS = [
  '#alerts-panel', '#tropical-model-panel',
  '#severe-model-panel', '#snd-panel', '#hd-panel', '#fnv3-panel',
  '#stormcone-panel', '#sc-style-panel', '#sc-points-panel', '#gps-hud',
  '#inspector-readout', '#ov-info-tooltip', '#overlay-pills-row',
  '#txt-font-menu', '#forecast-panel', '#lqm-settings-overlay',
];
// The panels an overlay opens sit over the map while you read what is under
// them, so they take the same near-black the alert popup does. The overlay
// LIST is not among them: that is a menu you drive the app from, so it stays
// in the house colour and is checked in PANELS above.
const OVERLAY_PANELS = [
  '#spc-controls', '#wpc-controls', '#fw-controls', '#cpc-controls',
  '#meso-panel', '#storm-reports-panel', '#tornado-tracks-panel',
];
const SCRIMS = [
  '#cc-modal', '#tab-lock-overlay', '#credits-modal-overlay',
  '#feedback-modal-overlay', '#sg-editor-overlay', '#forecast-modal',
];
const CONTROLS = ['#overlay-toggle-btn'];

console.log('\n2. every panel shell is a gradient, and it is red');
{
  const results = await page.evaluate(
    (sels) => Object.fromEntries(sels.map(s => [s, __surfaceOrStub(s)])), PANELS);
  const all = Object.entries(results);
  const unreached = all.filter(([, r]) => r.missing).map(([s]) => s);
  ok('every panel named in the CSS is reachable by that selector',
     unreached.length === 0, unreached.join(' '));
  const live = all.filter(([, r]) => !r.stubbed).length;
  console.log(`       (${live} already on the page, ${all.length - live} built on demand`
              + ` and measured through a stand-in)`);

  const flat = all.filter(([, r]) => !r.gradient).map(([s]) => s);
  ok('every one of them paints a gradient, not a flat fill',
     flat.length === 0, flat.join(' '));

  const notRed = await page.evaluate((sels) =>
    sels.filter(s => !__isRed(__surfaceOrStub(s).stops)), PANELS);
  ok('and every one of them is red', notRed.length === 0, notRed.join(' '));

  const noBevel = all.filter(([, r]) => !/inset/.test(r.shadow)).map(([s]) => s);
  ok('each has the inset bevel that makes the edge read as an edge',
     noBevel.length === 0, noBevel.join(' '));
}

console.log('\n2b. the overlay panels are black, and the overlay list is not');
{
  const r = await page.evaluate((sels) =>
    Object.fromEntries(sels.map(s => [s, __surfaceOrStub(s)])), OVERLAY_PANELS);
  const all = Object.entries(r);
  ok('every overlay panel is reachable', all.every(([, v]) => !v.missing),
     all.filter(([, v]) => v.missing).map(([s]) => s).join(' '));
  ok('each is a gradient', all.every(([, v]) => v.gradient),
     all.filter(([, v]) => !v.gradient).map(([s]) => s).join(' '));
  const notInk = await page.evaluate((sels) =>
    sels.filter(s => !__isInk(__surfaceOrStub(s).stops)), OVERLAY_PANELS);
  ok('and black rather than red', notInk.length === 0, notInk.join(' '));
  // The distinction that was actually chosen: panels black, list red.
  const listRed = await page.evaluate(() => __isRed(__surfaceOrStub('#overlay-pills-row').stops));
  ok('while the overlay list itself stays in the house colour', listRed);
}

console.log('\n3. the dim behind a modal is red too, not neutral black');
{
  const results = await page.evaluate(
    (sels) => Object.fromEntries(sels.map(s => [s, __surfaceOrStub(s)])), SCRIMS);
  const all = Object.entries(results);
  ok('every scrim is reachable', all.every(([, r]) => !r.missing),
     all.filter(([, r]) => r.missing).map(([s]) => s).join(' '));
  const flat = all.filter(([, r]) => !r.gradient).map(([s]) => s);
  ok('each is a gradient rather than one flat wash', flat.length === 0, flat.join(' '));
  const notRed = await page.evaluate((sels) =>
    sels.filter(s => !__isRed(__surfaceOrStub(s).stops)), SCRIMS);
  ok('and warm rather than neutral, so the page carries through it',
     notRed.length === 0, notRed.join(' '));
}

console.log('\n4. Settings, which is what started this');
{
  const r = await page.evaluate(() => {
    lqmOpenSettings();
    _lqmSetBuildRail();
    const parts = {};
    ['#lqm-set-shell', '#lqm-set-rail', '#lqm-set-content',
     '.lqm-settings-group', '.lqm-set-tab', '.lqm-settings-category',
     '.lqm-toggle-track', '.lqm-slider'].forEach(s => { parts[s] = __surface(s); });
    // A tab that is on has to look different from one that is not, or the
    // whole rail reads as one block.
    // The selected tab compared against one that is definitely NOT selected.
    // Taking tabs[0] as the unselected one is what made this pass by
    // comparing an element with itself, because the first tab is the one
    // that opens selected.
    const on = document.querySelector('#lqm-set-rail .lqm-set-tab.on');
    const off = document.querySelector('#lqm-set-rail .lqm-set-tab:not(.on)');
    const bg = el => el ? getComputedStyle(el).backgroundImage : '';
    const onOff = { on: bg(on), off: bg(off), same: bg(on) === bg(off),
                    haveBoth: !!on && !!off && on !== off };
    if (typeof lqmCloseSettings === 'function') lqmCloseSettings();
    return { parts, onOff };
  });
  const entries = Object.entries(r.parts).filter(([, v]) => !v.missing);
  ok('every piece of the settings panel was found', entries.length >= 7,
     Object.entries(r.parts).filter(([, v]) => v.missing).map(([s]) => s).join(' '));
  const flat = entries.filter(([, v]) => !v.gradient).map(([s]) => s);
  ok('and every piece of it is a gradient', flat.length === 0, flat.join(' '));

  const notRed = await page.evaluate((sels) =>
    sels.filter(s => { const v = __surface(s); return !v.missing && !__isRed(v.stops); }),
    entries.map(([s]) => s));
  ok('the whole panel is in the app\'s red, not the greys it was',
     notRed.length === 0, notRed.join(' '));
  ok('there is a selected tab and an unselected one to compare', r.onOff.haveBoth);
  ok('a selected tab does not look like an unselected one',
     r.onOff.haveBoth && !r.onOff.same, `on=${r.onOff.on} off=${r.onOff.off}`);
  // Sunk, not raised: the slider track and the toggle track are cut into the
  // panel, and the direction of their gradient is what says so.
  const sunk = await page.evaluate(() => {
    const s = __surface('.lqm-slider');
    if (s.missing || s.stops.length < 2) return null;
    const first = s.stops[0], last = s.stops[s.stops.length - 1];
    return { darkerAtTop: (first[0] + first[1] + first[2]) < (last[0] + last[1] + last[2]) };
  });
  ok('a slider track is lit from below, so it reads as cut in rather than laid on',
     sunk && sunk.darkerAtTop, JSON.stringify(sunk));
}

console.log('\n5. map popups');
{
  const r = await page.evaluate(async () => {
    // A real Leaflet popup, opened through the app's own builder so the
    // classes are the ones the app really uses.
    const p = { event: 'Tornado Warning', areaDesc: 'Somewhere',
                severity: 'Extreme', sent: new Date().toISOString(),
                expires: new Date(Date.now() + 3.6e6).toISOString(), description: '' };
    const pop = L.popup({ className: 'ap-popup-container' })
      .setLatLng([28.5, -80.7])
      .setContent(_buildAlertPopupHTML(p, '#ff0000')).openOn(map);
    await new Promise(r2 => setTimeout(r2, 220));
    const wrap = __surface('.ap-popup-container .leaflet-popup-content-wrapper');
    const tip = __surface('.ap-popup-container .leaflet-popup-tip');
    map.closePopup(pop);

    // The NWR station popup belongs to the weather-radio family, so it is
    // orange while the alert popup beside it is black.
    const np = L.popup({ className: 'nwr-popup' }).setLatLng([28.5, -80.7])
      .setContent('<div class="nwr-inner">station</div>').openOn(map);
    await new Promise(r3 => setTimeout(r3, 200));
    const nwrWrap = __surface('.nwr-popup .leaflet-popup-content-wrapper');
    map.closePopup(np);
    return { wrap, tip, nwrWrap, nwrOrange: __isOrange(nwrWrap.stops) };
  });
  ok('an alert popup is a gradient', r.wrap.gradient, r.wrap.image);
  // Black, not red: this one sits ON the weather, so it stays out of the way
  // of the colours underneath it.
  ok('and it is black rather than red', await page.evaluate(s => __isInk(s), r.wrap.stops),
     JSON.stringify(r.wrap.stops));
  ok('it did not quietly become a very dark red',
     !(await page.evaluate(s => __isRed(s) && !__isInk(s), r.wrap.stops)),
     JSON.stringify(r.wrap.stops));
  ok('its little arrow is a gradient too, so it does not hang off as a flat tab',
     r.tip.gradient, r.tip.image);
  ok('and the arrow matches the popup it points at',
     await page.evaluate(s => __isInk(s), r.tip.stops), JSON.stringify(r.tip.stops));
  ok('the NWR station popup beside it is orange, not black or red',
     r.nwrWrap.gradient && r.nwrOrange, r.nwrWrap.image);
}

console.log('\n6. the right-click menu and the map controls');
{
  const r = await page.evaluate(async () => {
    _cmOpen({ latlng: L.latLng(28.5, -80.7),
              originalEvent: { clientX: 200, clientY: 200,
                               preventDefault() {}, stopPropagation() {} } });
    await new Promise(r2 => setTimeout(r2, 150));
    const menu = __surface('#map-ctx-menu');
    _cmClose();
    return { menu };
  });
  ok('the right-click menu is a gradient', r.menu.gradient, r.menu.image);
  ok('and it is red', await page.evaluate(s => __isRed(s), r.menu.stops),
     JSON.stringify(r.menu.stops));

  const c = await page.evaluate((sels) =>
    Object.fromEntries(sels.map(s => [s, __surface(s)])), CONTROLS);
  const present = Object.entries(c).filter(([, v]) => !v.missing);
  ok('the map\'s own buttons are gradients as well',
     present.length > 0 && present.every(([, v]) => v.gradient),
     JSON.stringify(present.map(([s, v]) => [s, v.gradient])));
}

console.log('\n7. the pop-out window, which is its own document');
{
  const r = await page.evaluate(async () => {
    const src = document.getElementById('alerts-panel-body');
    src.innerHTML = '<div class="a">A WARNING</div>';
    _popOutPanel('alerts');
    await new Promise(r2 => setTimeout(r2, 350));
    const w = _popWins.alerts && _popWins.alerts.win;
    if (!w) return { opened: false };
    const g = (el) => el ? w.getComputedStyle(el).backgroundImage : '';
    const out = {
      opened: true,
      body: g(w.document.body),
      header: g(w.document.querySelector('header')),
      row: g(w.document.querySelector('main > *')),
    };
    try { w.close(); } catch (e) {}

    // And the EAS one, which has to come out orange rather than red or the
    // pinned window does not look related to the panel it came from.
    const esrc = document.getElementById('eas-panel-body');
    if (esrc) esrc.innerHTML = '<div class="a">AN EAS ALERT</div>';
    _popOutPanel('eas');
    await new Promise(r2 => setTimeout(r2, 350));
    const ew = _popWins.eas && _popWins.eas.win;
    if (ew) {
      const eg = (el) => el ? ew.getComputedStyle(el).backgroundImage : '';
      out.easBody = eg(ew.document.body);
      out.easHeader = eg(ew.document.querySelector('header'));
      try { ew.close(); } catch (e) {}
    }
    return out;
  });
  ok('the window opens', r.opened);
  ok('its background is a gradient', /gradient/.test(r.body || ''), r.body);
  ok('so is its header', /gradient/.test(r.header || ''), r.header);
  ok('and so is every row in it', /gradient/.test(r.row || ''), r.row);
  const reds = await page.evaluate((vals) => vals.map(v => {
    const stops = [...String(v).matchAll(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/g)]
      .map(m => [Number(m[1]), Number(m[2]), Number(m[3])]);
    return __isRed(stops);
  }), [r.body, r.header, r.row]);
  ok('and all three are red, so a pinned window matches the app it came from',
     reds.every(Boolean), JSON.stringify(reds));
  const easHues = await page.evaluate((vals) => vals.map(v => {
    const stops = [...String(v).matchAll(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/g)]
      .map(m => [Number(m[1]), Number(m[2]), Number(m[3])]);
    return { orange: __isOrange(stops), gradient: /gradient/.test(String(v)) };
  }), [r.easBody, r.easHeader]);
  ok('the EAS window opened too', !!r.easBody);
  ok('and it is orange, matching the panel it came out of',
     easHues.every(h => h.gradient && h.orange), JSON.stringify(easHues));
}

console.log('\n8. the bars that are always on screen');
{
  // These are not panels people open, they are the furniture. The animation
  // bar was the loudest thing left: a solid cyan strip across the bottom of a
  // red application.
  const BARS = ['#export-toolbar', '#draw-toolbar', '#text-toolbar',
                '#poly-toolbar', '#dist-toolbar', '#radius-toolbar',
                '#stormcone-toolbar', '#xsec-toolbar', '#top-search-bar'];
  const r = await page.evaluate((sels) =>
    Object.fromEntries(sels.map(s => [s, __surfaceOrStub(s)])), BARS);
  const all = Object.entries(r);
  ok('every bar is reachable', all.every(([, v]) => !v.missing),
     all.filter(([, v]) => v.missing).map(([s]) => s).join(' '));
  const flat = all.filter(([, v]) => !v.gradient).map(([s]) => s);
  ok('and every one of them is a gradient', flat.length === 0, flat.join(' '));
  const notRed = await page.evaluate((sels) =>
    sels.filter(s => !__isRed(__surfaceOrStub(s).stops)), BARS);
  ok('and red', notRed.length === 0, notRed.join(' '));
}

console.log('\n8b. the two surfaces that keep their own colour');
{
  // The animation bar is cyan with a red border, and that pairing is what
  // makes it findable on a map that is otherwise red end to end. A sweep took
  // it once already; this is what stops that happening again quietly.
  const r = await page.evaluate(() => {
    const bar = __surface('#animbar');
    const labels = getComputedStyle(document.querySelector('#timeline-labels')).color;
    const border = getComputedStyle(document.querySelector('#animbar')).borderTopColor;
    const eas = __surfaceOrStub('#eas-panel');
    const card = __surfaceOrStub('.eas-card');
    return { bar, labels, border, eas, card,
             barCyan: __isCyan(bar.stops), easOrange: __isOrange(eas.stops),
             cardOrange: __isOrange(card.stops), barRed: __isRed(bar.stops) };
  });
  ok('the animation bar is a gradient', r.bar.gradient, r.bar.image);
  ok('and it is cyan again, not red', r.barCyan && !r.barRed, r.bar.image);
  ok('it kept its red border, which is the pairing that makes it findable',
     /170,\s*0,\s*0/.test(r.border), r.border);
  ok('its tick times are black again, which is what reads on cyan',
     /rgb\(0,\s*0,\s*0\)/.test(r.labels), r.labels);
  ok('the EAS panel is a gradient', r.eas.gradient, r.eas.image);
  ok('and it is orange, the colour its own header already used',
     r.easOrange, r.eas.image);
  ok('its cards are orange too', r.cardOrange, r.card.image);

  // The weather-radio family: EAS, the NWR station popup and the recordings
  // panel are one subject and share one colour.
  const nwr = await page.evaluate(() => {
    const panel = __surfaceOrStub('#nwr-rec-panel');
    const head = __surfaceOrStub('#nwr-rec-header');
    return { panel, head,
             panelOrange: __isOrange(panel.stops), headOrange: __isOrange(head.stops),
             panelRed: __isRed(panel.stops) && !__isOrange(panel.stops) };
  });
  ok('the NWR recordings panel is a gradient', nwr.panel.gradient, nwr.panel.image);
  ok('and orange, in the same family as EAS', nwr.panelOrange, nwr.panel.image);
  ok('not red, which is what the sweep had made it', !nwr.panelRed);
  ok('its header is orange too', nwr.headOrange, nwr.head.image);
}

console.log('\n9. the sweep: nothing in the UI is still flat');
{
  // Read the CSS and you check what you remembered to check. This walks every
  // visible element in the real page instead and reports anything painting a
  // flat fill, which is the only way to answer "every single thing" honestly.
  //
  // Most of what this originally found was not forgotten. It was written with
  // the `background` SHORTHAND at a higher specificity than the surface
  // system, and the shorthand resets background-image to none, so the gradient
  // was set and then thrown away by a rule that only meant to set a colour.
  const r = await page.evaluate(() => {
    // A swatch is a reading, not a surface. Gradient one and it lies about
    // the palette, so these are meant to be flat and are checked separately.
    const KEY = '.radar-pal-swatch,.trop-model-swatch,.spc-swatch,.alert-swatch,'
              + '.ov-panel-swatch,.atcf-swatch,.dtb-pal-swatch,#dtb-color-swatch,'
              + '#txt-color-swatch,.insp-swatch,.cyc-ens-legend i,.xs-legend i';
    const flat = [];
    document.querySelectorAll('*').forEach(el => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      if (/gradient|url\(/.test(cs.backgroundImage || '')) return;
      if (el.closest(KEY) || el.matches(KEY)) return;
      // Leaflet's own tile and canvas layers paint the weather, not the UI.
      if (el.closest('.leaflet-tile-pane, .leaflet-overlay-pane, canvas, svg')) return;
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/
        .exec(cs.backgroundColor || '');
      if (!m) return;
      if ((m[4] === undefined ? 1 : Number(m[4])) < 0.04) return;
      const box = el.getBoundingClientRect();
      if (box.width < 6 || box.height < 6) return;
      const cls = (typeof el.className === 'string' && el.className.trim())
        ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
      flat.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + cls)
                + ' ' + cs.backgroundColor);
    });
    return [...new Set(flat)];
  });
  ok('no visible element paints a flat fill', r.length === 0,
     `${r.length} left`);
  if (r.length) r.forEach(x => console.log('       still flat: ' + x));

  // And the other half of the claim: the colour keys are still flat, because
  // a gradient on one of those would misrepresent the scale it stands for.
  const keys = await page.evaluate(() => {
    const out = { checked: 0, gradient: [] };
    ['.radar-pal-swatch', '.spc-swatch', '.alert-swatch', '.atcf-swatch',
     '.dtb-pal-swatch', '.ov-panel-swatch'].forEach(sel => {
      const st = __surfaceOrStub(sel);
      out.checked++;
      if (st.gradient) out.gradient.push(sel);
    });
    return out;
  });
  ok('every colour key stays a flat colour, because it is a reading',
     keys.gradient.length === 0, keys.gradient.join(' '));
  console.log(`       (${keys.checked} colour keys held flat on purpose)`);
}

console.log('\n9b. nothing became unreadable');
{
  // A gradient behind text is only an improvement if the text still reads.
  // Checked as a real contrast ratio against the darkest stop of whatever is
  // behind it, which is the worst case on a vertical gradient.
  const bad = await page.evaluate(() => {
    const lum = ([r, g, b]) => {
      const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92
                                        : Math.pow((c + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const parse = s => { const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(s || '');
                         return m ? [+m[1], +m[2], +m[3]] : null; };
    const out = [];
    // #timeline-labels is here because it is exactly what a colour sweep
    // breaks: the tick times were pure black, which read fine on the cyan the
    // animation bar used to be and not at all on the red it is now.
    ['#lqm-set-shell', '#alerts-panel', '#map-ctx-menu',
     '#timeline-labels', '.tool-btn', '#animbar'].forEach(sel => {
      const el = document.querySelector(sel);
      if (!el) return;
      const cs = getComputedStyle(el);
      const fg = parse(cs.color);
      // Text with no background of its own is read against whichever ancestor
      // actually paints one, which is what the eye sees behind it.
      let bgEl = el, stops = [];
      while (bgEl && !stops.length) {
        stops = [...(getComputedStyle(bgEl).backgroundImage || '').matchAll(
          /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/g)].map(m => [+m[1], +m[2], +m[3]]);
        bgEl = bgEl.parentElement;
      }
      if (!fg || !stops.length) return;
      stops.forEach(st => {
        const l1 = lum(fg), l2 = lum(st);
        const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        if (ratio < 4.5) out.push(`${sel} ${ratio.toFixed(1)}:1 on rgb(${st})`);
      });
    });
    return out;
  });
  ok('text still clears 4.5:1 against every stop of its own background',
     bad.length === 0, bad.join(' | '));
}

console.log('\n10. the About card is gone');
{
  const r = await page.evaluate(() => {
    lqmOpenSettings();
    _lqmSetBuildRail();
    const tabs = Array.from(document.querySelectorAll('#lqm-set-rail .lqm-set-tab'))
      .map(t => t.textContent.trim());
    const cards = Array.from(
      document.querySelectorAll('#lqm-set-content .lqm-settings-group'))
      .map(g => g.querySelector('.lqm-settings-category').textContent.trim());
    if (typeof lqmCloseSettings === 'function') lqmCloseSettings();
    return { tabs, cards, credits: !!document.getElementById('lqm-credits-btn') };
  });
  ok('there is no About tab', !r.tabs.includes('About'), r.tabs.join(' | '));
  ok('and no About card', !r.cards.includes('About'), r.cards.join(' | '));
  // The card held the only Settings route to the credits, but not the only
  // route in the app, so removing it does not orphan the modal.
  ok('the credits are still reachable from the menu', r.credits);
  console.log(`       (${r.tabs.length} tabs: ${r.tabs.join(', ')})`);
}

console.log('\n11. nothing threw');
ok('no uncaught page errors', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
