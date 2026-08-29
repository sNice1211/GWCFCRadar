#!/usr/bin/env node
/*
 * Alert panels: Comfortaa everywhere, and coming to the front when one fires.
 *
 *     node tools/test-alert-raise.mjs
 *
 * Two things are checked, and both were previously invisible.
 *
 * The font first. Both ways of detaching a panel escape the page's cascade:
 * the pop-out is a separate document with no stylesheet of its own, and the
 * floating picture-in-picture window is a canvas, where naming a font that
 * has not downloaded yet does not fail, it silently draws in the system face.
 * So neither could be caught by looking at the page. The pop-out is checked by
 * reading computed styles inside the real popup window; the canvas is checked
 * by measuring the same string twice, once in Comfortaa and once in the
 * fallback, because two different faces cannot produce the same width.
 *
 * Then the raise, which is opt in: Settings > Alerts > Open Panel on New
 * Alert, off by default, because a panel appearing over whatever you are
 * doing every time a warning fires is the behaviour most people want to be
 * able to stop. Turned on, a newly issued alert opens its panel, brings it to
 * the front and marks the new row. Section 12 covers the switch itself, and
 * the line it has to hold: off means the panel stays put, never that the
 * warning is suppressed. The subtlety is "unless a specific area is selected":
 * someone watching one county should not have the panel thrown at them for a
 * warning two states away. So the gate is checked from both sides, with an
 * area set and without, and the seeding pass is checked too, since everything
 * is new on the first load and a panel that flies open for an hour-old
 * warning the moment the page opens is noise rather than an alert.
 *
 * These drive the real renderers with real feature objects. Nothing asserts
 * on a mock: the assertions read the actual panel's display, z-index and
 * class list after the actual code has run.
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

// A real Comfortaa file, served to the page and to the popup, so the font
// checks below measure a genuine web font rather than a missing one.
let FONT = null;
try {
  FONT = readFileSync(join(ROOT, 'tools', 'fixtures', 'Comfortaa.ttf'));
} catch { FONT = null; }

const ctx = await browser.newContext();
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));

// Routed on the context, not the page, so the pop-out window gets the same
// stubs. A popup that cannot reach the font would fail the font check for the
// wrong reason.
await ctx.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript',
      body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css',
      body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  if (url.includes('fonts.googleapis.com')) {
    if (!FONT) return route.fulfill({ contentType: 'text/css', body: '' });
    return route.fulfill({ contentType: 'text/css',
      body: `@font-face{font-family:'Comfortaa';font-style:normal;`
          + `font-weight:400 700;src:url(https://fonts.gstatic.com/c.ttf)`
          + `format('truetype');}` });
  }
  if (url.includes('fonts.gstatic.com') && FONT)
    return route.fulfill({ contentType: 'font/ttf', body: FONT });
  return route.abort();
});

await page.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4200);
await page.evaluate(() => { if (typeof closeTutorial === 'function') closeTutorial(); });
// Raising the panel is opt in now: Settings > Alerts > Open Panel on New
// Alert, off by default. Everything below this line exists to test the raise
// itself, so the switch is turned on for it. Section 12 is where the switch
// being off is checked, and it puts it back afterwards.
await page.evaluate(() => {
  try { localStorage.setItem('lqm_alertpopup', 'true'); } catch (e) {}
});

// One warning, as the National Weather Service actually shapes it.
const feat = (id, event, area, lat = 35, lon = -97) => ({
  type: 'Feature',
  id,
  properties: { id, event, areaDesc: area, severity: 'Severe',
                expires: new Date(Date.now() + 3600e3).toISOString() },
  geometry: { type: 'Polygon', coordinates: [[
    [lon, lat], [lon + 1, lat], [lon + 1, lat + 1], [lon, lat + 1], [lon, lat]]] },
});

const easAlert = (id, type, translation, fips) => ({
  id, type, translation, fipsCodes: [fips], originator: 'WXR',
  callsign: 'KTST', startTimeEpoch: Math.floor(Date.now() / 1000),
  endTimeEpoch: Math.floor(Date.now() / 1000) + 3600,
});

const reset = () => page.evaluate(() => {
  _alertSeen.alerts = null;
  _alertSeen.eas = null;
  _homeLocation = { country: '', state: '', county: '', city: '' };
  if (typeof _polyFilter !== 'undefined') {
    _polyFilter.active = false; _polyFilter.polygons = [];
  }
  document.getElementById('alerts-panel').style.display = 'none';
  document.getElementById('eas-panel').style.display = 'none';
  activeLayers.tornado = true; activeLayers.tstm = true; activeLayers.flood = true;
});

const panelShown = (id) => page.evaluate(
  (i) => document.getElementById(i).style.display, id);
const marked = (id) => page.evaluate(
  (i) => document.querySelectorAll('#' + i + ' .alert-just-in').length, id);

console.log('\n1. the page knows what "a specific area" means');
{
  const r = await page.evaluate(() => {
    const out = {};
    _homeLocation = { country: '', state: '', county: '', city: '' };
    _polyFilter.active = false; _polyFilter.polygons = [];
    out.nothing = _alertsAreaSelected();
    _homeLocation = { country: 'US', state: 'Oklahoma', county: 'Canadian', city: '' };
    out.home = _alertsAreaSelected();
    out.inside = _alertInHomeArea('Canadian County, OK');
    out.outside = _alertInHomeArea('Dade County, FL');
    _homeLocation = { country: '', state: '', county: '', city: '' };
    _polyFilter.active = true; _polyFilter.polygons = [[{ lat: 1, lng: 1 }]];
    out.poly = _alertsAreaSelected();
    // A polygon is applied to the feature list before this ever sees it, so
    // with no home terms every alert that got this far is in the area.
    out.polyInside = _alertInHomeArea('anywhere at all');
    _polyFilter.active = false; _polyFilter.polygons = [];
    return out;
  });
  ok('no area set reads as no area', r.nothing === false, JSON.stringify(r));
  ok('a home location counts as an area', r.home === true);
  ok('an alert in that county matches', r.inside === true);
  ok('one two states away does not', r.outside === false);
  ok('a drawn polygon counts as an area', r.poly === true);
  ok('and with a polygon the list is already narrowed, so it does not '
     + 'double filter by text', r.polyInside === true);
}

console.log('\n2. first render seeds rather than raising');
{
  await reset();
  await page.evaluate((f) => renderAlerts([f]), feat('a1', 'Tornado Warning', 'Canadian, OK'));
  ok('the panel does not fling itself open on the first load',
     await panelShown('alerts-panel') === 'none', await panelShown('alerts-panel'));
  ok('but the alert was noted as seen',
     await page.evaluate(() => _alertSeen.alerts.size) === 1);
}

console.log('\n3. a new alert brings the panel to the front');
{
  await page.evaluate((fs) => renderAlerts(fs),
    [feat('a1', 'Tornado Warning', 'Canadian, OK'),
     feat('a2', 'Severe Thunderstorm Warning', 'Grady, OK', 34)]);
  ok('the panel opened itself', await panelShown('alerts-panel') === 'flex',
     await panelShown('alerts-panel'));
  ok('and the new card is the one marked', await marked('alerts-panel') === 1,
     String(await marked('alerts-panel')));
  const z = await page.evaluate(() =>
    +getComputedStyle(document.getElementById('alerts-panel')).zIndex);
  ok('and it was raised above the panels sharing its layer', z > 900, String(z));
  ok('the marked card is the new one, not the first row',
     await page.evaluate(() => {
       const el = document.querySelector('#alerts-panel .alert-just-in');
       return el && el.dataset.alertId;
     }) === 'a2');
}

console.log('\n4. re-rendering the same alerts raises nothing');
{
  await page.evaluate(() => {
    document.getElementById('alerts-panel').style.display = 'none';
  });
  await page.evaluate((fs) => renderAlerts(fs),
    [feat('a1', 'Tornado Warning', 'Canadian, OK'),
     feat('a2', 'Severe Thunderstorm Warning', 'Grady, OK', 34)]);
  ok('a redraw of the same list leaves the panel closed',
     await panelShown('alerts-panel') === 'none', await panelShown('alerts-panel'));
}

console.log('\n5. with an area set, only alerts in it raise the panel');
{
  await reset();
  await page.evaluate(() => {
    _homeLocation = { country: 'US', state: 'Oklahoma', county: 'Canadian', city: '' };
  });
  await page.evaluate((f) => renderAlerts([f]), feat('b0', 'Flood Warning', 'Canadian, OK'));
  // Seeded. Now one far away, then one at home.
  await page.evaluate((fs) => renderAlerts(fs),
    [feat('b0', 'Flood Warning', 'Canadian, OK'),
     feat('b1', 'Tornado Warning', 'Dade, FL', 25, -80)]);
  ok('a warning outside the chosen area does not raise the panel',
     await panelShown('alerts-panel') === 'none', await panelShown('alerts-panel'));
  ok('and nothing is marked', await marked('alerts-panel') === 0);

  await page.evaluate((fs) => renderAlerts(fs),
    [feat('b0', 'Flood Warning', 'Canadian, OK'),
     feat('b1', 'Tornado Warning', 'Dade, FL', 25, -80),
     feat('b2', 'Tornado Warning', 'Canadian, OK')]);
  ok('one inside it does', await panelShown('alerts-panel') === 'flex',
     await panelShown('alerts-panel'));
  ok('and it is the one marked',
     await page.evaluate(() => {
       const el = document.querySelector('#alerts-panel .alert-just-in');
       return el && el.dataset.alertId;
     }) === 'b2');
}

console.log('\n6. a drawn polygon gates it too, through the list itself');
{
  await reset();
  await page.evaluate(() => {
    // A box around Oklahoma only.
    _polyFilter.active = true;
    _polyFilter.polygons = [[{ lat: 33, lng: -100 }, { lat: 33, lng: -94 },
                             { lat: 37, lng: -94 }, { lat: 37, lng: -100 }]];
  });
  await page.evaluate((f) => renderAlerts([f]), feat('c0', 'Flood Warning', 'Canadian, OK'));
  await page.evaluate((fs) => renderAlerts(fs),
    [feat('c0', 'Flood Warning', 'Canadian, OK'),
     feat('c1', 'Tornado Warning', 'Dade, FL', 25, -80)]);
  ok('an alert outside the drawn area never reaches the panel, so nothing '
     + 'is raised', await panelShown('alerts-panel') === 'none',
     await panelShown('alerts-panel'));
  await page.evaluate((fs) => renderAlerts(fs),
    [feat('c0', 'Flood Warning', 'Canadian, OK'),
     feat('c2', 'Tornado Warning', 'Grady, OK', 34.5, -98)]);
  ok('one inside it raises', await panelShown('alerts-panel') === 'flex',
     await panelShown('alerts-panel'));
}

console.log('\n7. the EAS panel behaves the same way');
{
  await reset();
  await page.evaluate((a) => renderEASAlerts([a], false),
    easAlert('e1', 'TOR', 'Tornado Warning for Canadian County', '040017'));
  ok('first pass seeds without raising',
     await panelShown('eas-panel') === 'none', await panelShown('eas-panel'));

  await page.evaluate((as) => renderEASAlerts(as, false),
    [easAlert('e1', 'TOR', 'Tornado Warning for Canadian County', '040017'),
     easAlert('e2', 'SVR', 'Severe Thunderstorm Warning', '040051')]);
  ok('a new activation opens the panel',
     await panelShown('eas-panel') === 'flex', await panelShown('eas-panel'));
  ok('and marks the new card', await marked('eas-panel') === 1,
     String(await marked('eas-panel')));

  // EAS carries no coordinates, so only the home location can gate it.
  await reset();
  await page.evaluate(() => {
    _homeLocation = { country: 'US', state: 'Oklahoma', county: 'Canadian', city: '' };
  });
  await page.evaluate((a) => renderEASAlerts([a], false),
    easAlert('f0', 'RWT', 'Required Weekly Test for Canadian County', '040017'));
  await page.evaluate((as) => renderEASAlerts(as, false),
    [easAlert('f0', 'RWT', 'Required Weekly Test for Canadian County', '040017'),
     easAlert('f1', 'TOR', 'Tornado Warning for Dade County Florida', '120025')]);
  ok('an activation outside the chosen area does not raise it',
     await panelShown('eas-panel') === 'none', await panelShown('eas-panel'));
  await page.evaluate((as) => renderEASAlerts(as, false),
    [easAlert('f0', 'RWT', 'Required Weekly Test for Canadian County', '040017'),
     easAlert('f2', 'TOR', 'Tornado Warning for Canadian County', '040017')]);
  ok('one inside it does', await panelShown('eas-panel') === 'flex',
     await panelShown('eas-panel'));
}

console.log('\n8. reading back through history is left alone');
{
  await reset();
  await page.evaluate((a) => renderEASAlerts([a], false),
    easAlert('g1', 'TOR', 'one', '040017'));
  await page.evaluate((as) => renderEASAlerts(as, true),
    [easAlert('g1', 'TOR', 'one', '040017'),
     easAlert('g9', 'TOR', 'from last week', '040017')]);
  ok('the Recent tab does not throw the panel around',
     await panelShown('eas-panel') === 'none', await panelShown('eas-panel'));
  // And going back to Active must not then treat everything as brand new.
  await page.evaluate((as) => renderEASAlerts(as, false),
    [easAlert('g1', 'TOR', 'one', '040017'),
     easAlert('g9', 'TOR', 'from last week', '040017')]);
  ok('and switching back to Active does not treat the history as new',
     await panelShown('eas-panel') === 'none', await panelShown('eas-panel'));
}

console.log('\n9. a panel dragged somewhere deliberately stays there');
{
  await reset();
  await page.evaluate(() => {
    const p = document.getElementById('alerts-panel');
    p.style.display = 'flex';
    p.style.setProperty('position', 'fixed', 'important');
    p.style.setProperty('left', '30px', 'important');
    p.style.setProperty('top', '200px', 'important');
    p.style.setProperty('transform', 'none', 'important');
  });
  await page.evaluate((f) => renderAlerts([f]), feat('h0', 'Flood Warning', 'Canadian, OK'));
  await page.evaluate((fs) => renderAlerts(fs),
    [feat('h0', 'Flood Warning', 'Canadian, OK'),
     feat('h1', 'Tornado Warning', 'Canadian, OK')]);
  const where = await page.evaluate(() => {
    const st = document.getElementById('alerts-panel').style;
    return { left: st.left, top: st.top };
  });
  ok('an open panel that is on screen is not moved',
     where.left === '30px' && where.top === '200px', JSON.stringify(where));
  ok('but it is still marked and raised', await marked('alerts-panel') === 1);

  // Dragged off the edge, it does get brought back.
  await page.evaluate(() => {
    const p = document.getElementById('alerts-panel');
    p.style.setProperty('top', '-4000px', 'important');
  });
  await page.evaluate((fs) => renderAlerts(fs),
    [feat('h0', 'Flood Warning', 'Canadian, OK'),
     feat('h1', 'Tornado Warning', 'Canadian, OK'),
     feat('h2', 'Severe Thunderstorm Warning', 'Canadian, OK')]);
  const back = await page.evaluate(() =>
    document.getElementById('alerts-panel').style.top);
  ok('one dragged off the screen is brought back to the top', back === '80px',
     back);
}

console.log('\n10. the floating window paints in Comfortaa');
{
  const r = await page.evaluate(async () => {
    await _pipLoadFont();
    const c = document.createElement('canvas').getContext('2d');
    const S = 'Tornado Warning WWWWiiii';
    c.font = 'bold 15px ' + _PIP_FONT;
    const a = c.measureText(S).width;
    c.font = 'bold 15px monospace';
    const b = c.measureText(S).width;
    c.font = "bold 15px 'Comfortaa'";
    const d = c.measureText(S).width;
    return { pipFont: _PIP_FONT, withPip: a, withMono: b, withComfortaa: d,
             ready: _pipFontReady,
             loaded: !!(document.fonts && document.fonts.check("15px 'Comfortaa'")) };
  });
  ok('the canvas font string names Comfortaa first',
     /^'Comfortaa'/.test(r.pipFont), r.pipFont);
  ok('the font is loaded before the window paints', r.ready === true);
  if (r.loaded) {
    ok('and the canvas really measures in it, not the fallback',
       Math.abs(r.withPip - r.withComfortaa) < 0.5
       && Math.abs(r.withPip - r.withMono) > 0.5,
       `pip ${r.withPip} comfortaa ${r.withComfortaa} mono ${r.withMono}`);
  } else {
    ok('and the canvas really measures in it (font fixture absent, '
       + 'checked by name only)', true);
  }
  const stale = await page.evaluate(() => {
    // Nothing in the picture-in-picture drawing code may still name the
    // system face: canvas falls back silently, so a missed one is invisible.
    const src = document.documentElement.outerHTML;
    const i = src.indexOf('function _pipDraw');
    const j = src.indexOf('async function _pipToggle');
    return (src.slice(i, j).match(/system-ui/g) || []).length;
  });
  ok('no font string in the drawing code still names the system face',
     stale === 0, String(stale));
}

console.log('\n11. the pop-out window is Comfortaa too');
{
  // Time boxed, both times. A window built with document.write has an opaque
  // origin, so its font request does not always come back through the route
  // handler above, and document.fonts.ready then never settles: the check
  // hangs rather than failing, which is the worst way for a test to break.
  // The computed family is what is actually being asserted, and that is
  // readable whether or not the file itself ever arrives.
  let popup = null;
  try {
    [popup] = await Promise.all([
      ctx.waitForEvent('page', { timeout: 15000 }),
      page.evaluate(() => _popOutPanel('alerts')),
    ]);
  } catch (e) { popup = null; }
  if (!popup) {
    ok('the pop-out window opened', false, 'no window appeared');
  } else {
  await popup.waitForTimeout(1200);
  const r = await popup.evaluate(async () => {
    await Promise.race([
      document.fonts ? document.fonts.ready : Promise.resolve(),
      new Promise(res => setTimeout(res, 2500)),
    ]).catch(() => {});
    const fam = (el) => el ? getComputedStyle(el).fontFamily : '';
    return {
      body: fam(document.body),
      title: fam(document.querySelector('header .t')),
      count: fam(document.querySelector('header .c')),
      linked: [...document.querySelectorAll('link[rel="stylesheet"]')]
        .some(l => (l.href || '').includes('Comfortaa')),
    };
  });
  ok('the popup asks for the font with a real link tag', r.linked === true);
  ok('its body is Comfortaa', /Comfortaa/.test(r.body), r.body);
  ok('its title is Comfortaa, not a monospace face',
     /Comfortaa/.test(r.title) && !/mono/i.test(r.title), r.title);
  ok('its count is too', /Comfortaa/.test(r.count) && !/mono/i.test(r.count),
     r.count);
  await popup.close();
  }
}

console.log('\n12. the switch that decides whether it raises at all');
{
  // Settings > Alerts > Open Panel on New Alert. Off by default, because a
  // panel appearing over whatever you are doing every time a warning fires is
  // the behaviour people most want to be able to stop.
  //
  // The line this section holds: the switch decides whether the PANEL OPENS
  // ITSELF and nothing else. A switch in a weather app that quietly stopped
  // warnings arriving would be a genuinely dangerous thing to ship, so the
  // checks below prove the alert is still tracked while it is off.
  const r = await page.evaluate(() => {
    const out = {};
    const panel = document.getElementById('alerts-panel');
    const items = (ids) => ids.map(id => ({
      id, area: '', card: document.createElement('div') }));
    const shut = () => { panel.style.display = 'none'; };
    const setSw = (v) => {
      try {
        if (v === null) localStorage.removeItem('lqm_alertpopup');
        else localStorage.setItem('lqm_alertpopup', v);
      } catch (e) {}
    };

    // Never set at all is the state a new visitor is in.
    setSw(null);
    out.defaultIsOff = !_alertPopupAllowed();
    _alertSeen.alerts = null;
    _alertMaybeRaise('alerts', items(['s1']));          // first pass seeds
    shut();
    _alertMaybeRaise('alerts', items(['s1', 's2']));    // s2 is genuinely new
    out.stayedShutByDefault = panel.style.display !== 'flex';
    // The alert is still KNOWN about, which is the whole safety point.
    out.trackedAnyway = _alertSeen.alerts.has('s2');

    // Turned on, the same event raises it.
    setSw('true');
    shut();
    _alertMaybeRaise('alerts', items(['s1', 's2', 's3']));
    out.raisesWhenOn = panel.style.display === 'flex';

    // Off again, and one more new alert.
    setSw('false');
    shut();
    _alertMaybeRaise('alerts', items(['s1', 's2', 's3', 's4']));
    out.stayedShutWhenOff = panel.style.display !== 'flex';
    out.trackedWhileOff = _alertSeen.alerts.has('s4');

    // Switching back on must not then raise for s4, which happened while the
    // switch was down. If the bookkeeping were skipped while off, every alert
    // would stay permanently "new" and re-enabling would fling the panel open
    // for something an hour old.
    setSw('true');
    shut();
    _alertMaybeRaise('alerts', items(['s1', 's2', 's3', 's4']));
    out.noStaleRaise = panel.style.display !== 'flex';
    _alertMaybeRaise('alerts', items(['s1', 's2', 's3', 's4', 's5']));
    out.stillRaisesForNew = panel.style.display === 'flex';
    shut();

    // The control itself.
    const el = document.getElementById('lqm-set-alertpopup');
    out.rowExists = !!el;
    out.label = el ? el.closest('.lqm-settings-row')
      .querySelector('.lqm-settings-lbl').textContent.trim() : null;
    out.inAlertsSection = !!(el && /Alerts/.test(
      el.closest('.lqm-settings-group').querySelector('.lqm-settings-category').textContent));
    // Flipping the switch in the UI must be what writes the preference.
    setSw(null);
    el.checked = true; el.dispatchEvent(new Event('change'));
    out.uiWritesOn = localStorage.getItem('lqm_alertpopup') === 'true'
                  && _alertPopupAllowed();
    el.checked = false; el.dispatchEvent(new Event('change'));
    out.uiWritesOff = localStorage.getItem('lqm_alertpopup') === 'false'
                   && !_alertPopupAllowed();

    setSw('true');    // leave the rest of the file as it found things
    return out;
  });
  ok('a fresh visitor has it off, so nothing flings itself open',
     r.defaultIsOff && r.stayedShutByDefault, JSON.stringify(r));
  // The one that matters most. Off must mean quiet, never blind.
  ok('but the alert is still tracked while it is off',
     r.trackedAnyway && r.trackedWhileOff, JSON.stringify(r));
  ok('turning it on makes a new alert raise the panel', r.raisesWhenOn);
  ok('turning it off again stops that', r.stayedShutWhenOff);
  ok('and re-enabling does not raise for one that arrived while it was off',
     r.noStaleRaise, JSON.stringify(r));
  ok('while a genuinely new one still does', r.stillRaisesForNew);
  ok('the switch is in Settings, under Alerts, and says what it does',
     r.rowExists && r.inAlertsSection
     && r.label === 'Open Panel on New Alert', JSON.stringify(r));
  ok('and flipping it is what saves the choice',
     r.uiWritesOn && r.uiWritesOff, JSON.stringify(r));
}

console.log('\n13. the page did not throw doing any of that');
ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
console.log(`\n${fail ? '' : 'all '}${pass} passed`
  + (fail ? `, ${fail} FAILED` : ''));
process.exit(fail ? 1 : 0);
