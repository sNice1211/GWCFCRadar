#!/usr/bin/env node
/*
 * The Alert Desk: writing and issuing your own practice warnings.
 *
 *     node tools/test-alert-desk.mjs
 *
 * Two things are being checked here, and the second matters more than the
 * first. One, that a product written at the desk really behaves like an
 * alert: it draws, it files into the panel, it expires, StormStream can be
 * told to skip it. Two, that it can never pass for a real one. Every copy of
 * a simulated product has to carry the word, and a silent regression there
 * is the kind that only shows up in somebody else's screenshot.
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
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + String(extra).slice(0, 300) + '>' : '')); }
};

// ── Source-level checks, before a browser is involved ─────────────────────
console.log('\n1. the source itself');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');

ok('there is no em dash anywhere in the page', !html.includes('\u2014'));
ok('the desk is reachable from the Alerts settings card',
   /_adUiOpen\(\)/.test(html) && /Write an Alert/.test(html));
ok('StormStream has its own toggle for including your products',
   /lqm-ss-includemine/.test(html) && /_adUiIncludeSS/.test(html));
ok('renderAlerts folds desk products in rather than drawing them separately',
   /_adMergeIntoAlerts\(features\)/.test(html));

// ── In a real browser ─────────────────────────────────────────────────────
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

// A square in the Gulf, used everywhere below as "the area".
await page.evaluate(() => {
  window.__box = (lat, lng, d) => ([
    { lat: lat + d, lng: lng - d }, { lat: lat + d, lng: lng + d },
    { lat: lat - d, lng: lng + d }, { lat: lat - d, lng: lng - d },
  ]);
  window.__reset = () => {
    _adState.items = [];
    _adSave();
    _adDraft = _adNewDraft('TOR');
    _adRedrawAlerts();
  };
});

console.log('\n2. the product catalogue');
{
  const r = await page.evaluate(() => ({
    count: AD_PRODUCTS.length,
    kinds: [...new Set(AD_PRODUCTS.map(p => p.kind))].sort(),
    // A product whose event name is not in the colour table paints the
    // fallback grey, which reads as "unknown alert" rather than as itself.
    greyed: AD_PRODUCTS.filter(p => _alertColorFor(p.event) === '#aaaaaa').map(p => p.event),
    // Every hazard a product offers has to exist in the scale table.
    unknownHaz: AD_PRODUCTS.flatMap(p => p.haz.filter(h => !AD_HAZARDS[h])),
    emergencyColoured: _alertColorFor('Tornado Emergency') !== '#aaaaaa',
  }));
  ok('warnings, watches and statements are all issuable',
     r.kinds.join(',') === 'statement,warning,watch', r.kinds.join(','));
  ok('there are at least a dozen products', r.count >= 12, r.count);
  ok('every one of them has a real colour on the map',
     r.greyed.length === 0, r.greyed.join(', '));
  ok('and a tornado emergency has its own', r.emergencyColoured);
  ok('every hazard a product offers exists in the scale',
     r.unknownHaz.length === 0, r.unknownHaz.join(', '));
}

console.log('\n3. the intensity scale');
{
  const r = await page.evaluate(() => {
    const keys = Object.keys(AD_HAZARDS);
    const bad = [];
    keys.forEach(k => {
      const H = AD_HAZARDS[k];
      ['what', 'impact', 'amt'].forEach(f => {
        if (!Array.isArray(H[f]) || H[f].length !== AD_LEVELS.length) bad.push(k + '.' + f + ' length');
        else if (H[f][0] !== null) bad.push(k + '.' + f + ' level 0 is not empty');
        else if (H[f].slice(1).some(v => !v)) bad.push(k + '.' + f + ' has a blank level');
      });
      if (!H.label || !H.unit) bad.push(k + ' missing label or unit');
    });
    return { levels: AD_LEVELS, keys, bad };
  });
  ok('the scale is None, Low, Moderate, High, Extreme',
     r.levels.join(',') === 'None,Low,Moderate,High,Extreme', r.levels.join(','));
  ok('rain, wind, hail, flooding, surge and waves are all on it',
     ['rain', 'wind', 'hail', 'flooding', 'surge', 'waves'].every(k => r.keys.includes(k)),
     r.keys.join(' '));
  ok('every hazard has wording for all five stops and none for None',
     r.bad.length === 0, r.bad.join('; '));
}

console.log('\n4. what a written product says');
{
  const r = await page.evaluate(() => {
    __reset();
    _adDraft = _adNewDraft('TOR');
    _adDraft.poly = __box(28.5, -80.7, 0.35);
    _adDraft.areaMode = 'draw';
    _adDraft.areaName = 'Brevard County';
    _adSetLevel('tornado', 3);
    _adSetLevel('hail', 2);
    _adDraft.source = 'Trained weather spotters';
    _adIssue();
    const a = _adState.items[0];
    return { text: _adText(a), head: _adHeadline(a), ev: _adEventName(a) };
  });
  const t = r.text;
  ok('it has a WHAT bullet', /\* WHAT\.\.\./.test(t), t);
  ok('a WHERE bullet naming the area', /\* WHERE\.\.\.Brevard County\./.test(t));
  ok('a WHEN bullet with a real clock time', /\* WHEN\.\.\.Until \d/.test(t));
  ok('an IMPACTS bullet', /\* IMPACTS\.\.\./.test(t));
  ok('and a SOURCE bullet', /\* SOURCE\.\.\.Trained weather spotters\./.test(t));
  ok('the hazards set to something appear, the ones left at None do not',
     /tornado/i.test(t) && /hail/i.test(t) && !/gust/i.test(t), t);
  ok('a spotter report is tagged as observed, not radar indicated',
     /TORNADO\.\.\.OBSERVED/.test(t), t);
  ok('the product says it is simulated, at the top and the bottom',
     (t.match(/SIMULATED PRODUCT/g) || []).length === 2);
  ok('so does the headline', /^SIMULATED /.test(r.head), r.head);
}

console.log('\n5. the optional amount beside the severity');
{
  const r = await page.evaluate(() => {
    __reset();
    _adDraft = _adNewDraft('SVR');
    _adDraft.poly = __box(29.7, -95.4, 0.4); _adDraft.areaMode = 'draw';
    _adDraft.areaName = 'Harris County';
    _adSetLevel('hail', 2);
    _adSetLevel('wind', 3);
    _adSetAmount('hail', '2.75');
    _adIssue();
    const withAmt = _adText(_adState.items[0]);

    // The same product with nothing typed, to prove the box really is optional.
    _adDraft = _adNewDraft('SVR');
    _adDraft.poly = __box(29.7, -95.4, 0.4); _adDraft.areaMode = 'draw';
    _adDraft.areaName = 'Harris County';
    _adSetLevel('hail', 2);
    _adSetLevel('wind', 3);
    _adIssue();
    const noAmt = _adText(_adState.items[0]);

    // Typing an amount for a hazard still at None should turn it on rather
    // than being quietly dropped.
    _adDraft = _adNewDraft('SVR');
    _adSetAmount('rain', '3.10');
    const promoted = _adDraft.haz.rain.lvl;

    return { withAmt, noAmt, promoted };
  });
  ok('a typed amount is what the product says', /2\.75 in/.test(r.withAmt), r.withAmt);
  ok('and it reaches the tag block the rest of the app reads',
     /HAIL\.\.\.2\.75IN/.test(r.withAmt), r.withAmt);
  ok('the wind left blank still falls back to its level wording',
     /gusts to 80 mph/.test(r.withAmt) && /WIND\.\.\.80MPH/.test(r.withAmt), r.withAmt);
  ok('leaving every amount blank still issues a complete product',
     /\* WHAT\.\.\./.test(r.noAmt) && /quarter size hail/.test(r.noAmt), r.noAmt);
  ok('an amount typed against a None hazard switches that hazard on',
     r.promoted > 0, r.promoted);
}

console.log('\n6. it behaves like an alert once issued');
{
  const r = await page.evaluate(() => {
    __reset();
    // A real NWS alert alongside it, so the merge can be seen not to drop
    // either side.
    const real = {
      type: 'Feature', id: 'real-1',
      geometry: { type: 'Polygon', coordinates: [[[-81.5, 27.5], [-81.0, 27.5], [-81.0, 28.0], [-81.5, 28.0], [-81.5, 27.5]]] },
      properties: { id: 'real-1', event: 'Flood Warning', areaDesc: 'Somewhere real',
                    severity: 'Severe', sent: new Date().toISOString(),
                    expires: new Date(Date.now() + 3600000).toISOString(), description: '' },
    };
    renderAlerts([real]);

    _adDraft = _adNewDraft('TOR');
    _adDraft.poly = __box(28.5, -80.7, 0.35); _adDraft.areaMode = 'draw';
    _adDraft.areaName = 'Brevard County';
    _adSetLevel('tornado', 3);
    _adIssue();

    const mine = _lastAlertFeatures.filter(f => f.properties._simulated);
    const cards = [...document.querySelectorAll('#alerts-panel-body .alert-card')];
    const simCards = cards.filter(c => /SIMULATED/.test(c.textContent));
    const badge = document.getElementById('ad-sim-badge');

    // The drawn polygon, straight off the Leaflet layer the map is using.
    let dashed = null;
    const lyr = _alertLayerById[mine[0] && mine[0].properties.id];
    if (lyr && lyr.options) dashed = lyr.options.dashArray;

    const popup = _buildAlertPopupHTML(mine[0].properties, '#ff0000');

    return {
      realKept: _lastAlertFeatures.some(f => f.properties.id === 'real-1'),
      mineCount: mine.length,
      totalCards: cards.length,
      simCards: simCards.length,
      dashed,
      badgeOn: !!badge && badge.classList.contains('on'),
      popupMarked: /NOT ISSUED BY THE NATIONAL WEATHER SERVICE/.test(popup),
      sev: mine[0].properties.severity,
    };
  });
  ok('the real alert is still there', r.realKept);
  ok('and yours is on the map beside it', r.mineCount === 1, r.mineCount);
  ok('both appear in the alerts panel', r.totalCards === 2, r.totalCards);
  ok('exactly the simulated one is marked on its card', r.simCards === 1, r.simCards);
  ok('its polygon is drawn dashed, not solid', r.dashed === '9 6', r.dashed);
  ok('the corner badge is up while it is live', r.badgeOn);
  ok('its popup carries the banner too', r.popupMarked);
  ok('a tornado warning files as a severe alert', r.sev === 'Severe', r.sev);
}

console.log('\n7. tornado emergency and PDS');
{
  const r = await page.evaluate(() => {
    __reset();
    _adDraft = _adNewDraft('TOR');
    _adDraft.poly = __box(35.5, -97.5, 0.3); _adDraft.areaMode = 'draw';
    _adDraft.areaName = 'Oklahoma County';
    _adSetLevel('tornado', 4);
    _adSetTag('emergency');
    _adIssue();
    const a = _adState.items[0];
    const f = _adToFeature(a);
    return {
      ev: _adEventName(a),
      colour: _alertColorFor(_adEventName(a)),
      text: _adText(a),
      sev: f.properties.severity,
      // StormStream ranks by these phrases, the same way it does for a real one.
      ssPri: _ssPriority(f),
      tags: _ssParseTags(f.properties.description),
    };
  });
  ok('an emergency becomes its own event, so it paints its own colour',
     r.ev === 'Tornado Emergency' && r.colour !== '#aaaaaa', r.ev + ' ' + r.colour);
  ok('the words are in the product', /TORNADO EMERGENCY/.test(r.text));
  ok('it files as extreme', r.sev === 'Extreme', r.sev);
  ok('StormStream ranks it above an ordinary warning', r.ssPri >= 10, r.ssPri);
  ok('the existing tag reader picks the emergency up', r.tags.isEmergency === true);
}

console.log('\n8. expiry, continuation and cancellation');
{
  const r = await page.evaluate(() => {
    __reset();
    _adDraft = _adNewDraft('SVR');
    _adDraft.poly = __box(32.8, -96.8, 0.3); _adDraft.areaMode = 'draw';
    _adDraft.areaName = 'Dallas County';
    _adSetLevel('wind', 2);
    _adIssue();
    const uid = _adState.items[0].uid;
    const onMapNow = _lastAlertFeatures.filter(f => f.properties._simulated).length;

    // Wind the clock past the expiry and let the sweep settle it.
    _adState.items[0].expires = Date.now() - 1000;
    _adExpireSweep(true);
    const afterExpiry = {
      status: _adState.items[0].status,
      onMap: _lastAlertFeatures.filter(f => f.properties._simulated).length,
      badge: document.getElementById('ad-sim-badge').classList.contains('on'),
    };

    // Continuing it puts it back up.
    _adExtend(uid, 15);
    const afterExtend = {
      status: _adState.items[0].status,
      onMap: _lastAlertFeatures.filter(f => f.properties._simulated).length,
      note: _adState.items[0].note,
    };

    // Upgrading a severe thunderstorm warning is the real desk move.
    _adUpgrade(uid);
    const upgraded = _adEventName(_adState.items[0]);

    _adCancelProduct(uid);
    const afterCancel = {
      status: _adState.items[0].status,
      onMap: _lastAlertFeatures.filter(f => f.properties._simulated).length,
      note: _adState.items[0].note,
    };
    return { onMapNow, afterExpiry, afterExtend, upgraded, afterCancel };
  });
  ok('it is on the map while valid', r.onMapNow === 1);
  ok('once the expiry passes it comes off on its own',
     r.afterExpiry.status === 'expired' && r.afterExpiry.onMap === 0, JSON.stringify(r.afterExpiry));
  ok('and the corner badge goes with it', r.afterExpiry.badge === false);
  ok('continuing it puts it back up with a note saying so',
     r.afterExtend.status === 'active' && r.afterExtend.onMap === 1
     && /Continued until/.test(r.afterExtend.note || ''), JSON.stringify(r.afterExtend));
  ok('a severe thunderstorm warning can be upgraded to a tornado warning',
     r.upgraded === 'Tornado Warning', r.upgraded);
  ok('cancelling takes it off the map and records why',
     r.afterCancel.status === 'cancelled' && r.afterCancel.onMap === 0
     && /Cancelled/.test(r.afterCancel.note || ''), JSON.stringify(r.afterCancel));
}

console.log('\n9. StormStream only cycles yours when you ask it to');
{
  const r = await page.evaluate(() => {
    __reset();
    _ssCfg.coverage = 'us';
    _adDraft = _adNewDraft('TOR');
    _adDraft.poly = __box(28.5, -80.7, 0.35); _adDraft.areaMode = 'draw';
    _adDraft.areaName = 'Brevard County';
    _adSetLevel('tornado', 2);
    _adIssue();
    _adUiIncludeSS(true);
    const on = _ssActiveInCoverage().filter(f => f.properties._simulated).length;
    _adUiIncludeSS(false);
    const off = _ssActiveInCoverage().filter(f => f.properties._simulated).length;
    const stored = JSON.parse(localStorage.getItem('gwcfc_stormstream') || '{}').includeMine;
    _adUiIncludeSS(true);
    return { on, off, stored };
  });
  ok('with the toggle on it is in the rotation', r.on === 1, r.on);
  ok('with it off StormStream skips it', r.off === 0, r.off);
  ok('and the choice is remembered', r.stored === false, r.stored);
}

console.log('\n10. counties, zones and the area they make');
{
  const r = await page.evaluate(() => {
    __reset();
    // The two lookups the desk does against the NWS are stubbed here so the
    // shape maths can be checked without a network. What is under test is the
    // merge, not the fetch.
    _adZoneInfoCache.set('FLC009', Promise.resolve({
      id: 'FLC009', name: 'Brevard', state: 'FL',
      geometry: { type: 'Polygon', coordinates: [[[-81, 28], [-80.5, 28], [-80.5, 28.5], [-81, 28.5], [-81, 28]]] },
    }));
    _adZoneInfoCache.set('FLC095', Promise.resolve({
      id: 'FLC095', name: 'Orange', state: 'FL',
      geometry: { type: 'MultiPolygon', coordinates: [[[[-81.6, 28.3], [-81.1, 28.3], [-81.1, 28.8], [-81.6, 28.8], [-81.6, 28.3]]]] },
    }));
    return Promise.all([_adZoneInfo('FLC009'), _adZoneInfo('FLC095')]).then(zs => {
      _adDraft = _adNewDraft('TOA');
      zs.forEach(_adAddZone);
      const g = _adDraftGeometry();
      const desc = _adDraftAreaDesc();
      _adSetLevel('tornado', 2);
      _adIssue();
      const issued = _adState.items[0];
      const dup = _adAddZone(zs[0]);
      _adRemoveZone('FLC009');
      return {
        type: g && g.type,
        rings: g ? g.coordinates.length : 0,
        desc,
        issuedArea: issued.areaDesc,
        mode: issued.area.mode,
        // The heavy shapes must not be written to localStorage: they are
        // fetched by id and cached, and a handful of counties would blow the
        // whole storage budget if they were kept.
        stored: JSON.stringify(_adState.items[0]).length,
        savedZones: issued.area.zones,
        dupRejected: dup === false,
        afterRemove: _adDraft.zones.length,
      };
    });
  });
  ok('several counties merge into one multi-part shape',
     r.type === 'MultiPolygon' && r.rings === 2, r.type + ' x' + r.rings);
  ok('the area reads as the county names with their state',
     /Brevard and Orange in FL/.test(r.desc), r.desc);
  ok('the issued product keeps that area description', r.issuedArea === r.desc, r.issuedArea);
  ok('and remembers it was built from zones', r.mode === 'zones', r.mode);
  ok('adding the same county twice does nothing', r.dupRejected);
  ok('removing one takes it back out', r.afterRemove === 1, r.afterRemove);
  ok('only zone ids are stored, not their boundaries',
     r.stored < 4000 && r.savedZones.every(z => !z.geometry),
     r.stored + ' bytes');
}

console.log('\n11. it survives a reload');
{
  const before = await page.evaluate(() => {
    __reset();
    _adDraft = _adNewDraft('FFW');
    _adDraft.poly = __box(30.4, -91.1, 0.3); _adDraft.areaMode = 'draw';
    _adDraft.areaName = 'East Baton Rouge Parish';
    _adSetLevel('rain', 3);
    _adSetLevel('flooding', 3);
    _adSetAmount('rain', '4.20');
    _adDraft.mins = 240;
    _adIssue();
    return { uid: _adState.items[0].uid, text: _adText(_adState.items[0]) };
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  // The page-level helpers do not survive a reload.
  await page.evaluate(() => {
    window.__box = (lat, lng, d) => ([
      { lat: lat + d, lng: lng - d }, { lat: lat + d, lng: lng + d },
      { lat: lat - d, lng: lng + d }, { lat: lat - d, lng: lng - d },
    ]);
    window.__reset = () => { _adState.items = []; _adSave(); _adDraft = _adNewDraft('TOR'); _adRedrawAlerts(); };
  });
  const after = await page.evaluate(() => {
    const a = _adState.items[0];
    return {
      count: _adState.items.length,
      uid: a && a.uid,
      onMap: (_lastAlertFeatures || []).filter(f => f.properties._simulated).length,
      text: a ? _adText(a) : '',
      badge: !!document.getElementById('ad-sim-badge'),
    };
  });
  ok('the product is still there after a refresh', after.count === 1 && after.uid === before.uid,
     after.uid);
  ok('word for word the same', after.text === before.text);
  ok('back on the map without anyone reissuing it', after.onMap === 1, after.onMap);
  ok('and the badge is back with it', after.badge);
}

console.log('\n12. the desk panel itself');
{
  const r = await page.evaluate(() => {
    _adOpen();
    const modal = document.getElementById('ad-modal');
    const compose = document.getElementById('ad-compose');
    const preview = document.getElementById('ad-preview');
    const segs = compose.querySelectorAll('.ad-seg').length;
    const amts = compose.querySelectorAll('.ad-amt').length;
    const active = document.getElementById('ad-active').textContent;

    // The Issue button must refuse a product with no area.
    _adDraft = _adNewDraft('TOR');
    _adRenderCompose();
    const blocked = document.getElementById('ad-issue').disabled;
    _adDraft.poly = __box(28.5, -80.7, 0.3);
    _adSyncDraftUi();
    const allowed = !document.getElementById('ad-issue').disabled;

    // Switching product should keep the hazards you already dialled in.
    _adSetLevel('hail', 3);
    _adSetProduct('SVR');
    const kept = _adDraft.haz.hail.lvl;
    const polyKept = _adDraft.poly.length;

    const shown = modal.style.display;
    _adClose();
    return {
      shown, closed: modal.style.display, segs, amts,
      previewMarked: /SIMULATED/.test(preview.textContent),
      hasActive: /Flash Flood Warning/.test(active),
      blocked, allowed, kept, polyKept,
      headNote: /marked SIMULATED/i.test(document.getElementById('ad-head-note').textContent),
    };
  });
  ok('the desk opens', r.shown === 'flex');
  ok('and closes', r.closed === 'none');
  ok('every hazard gets a five-stop severity picker', r.segs >= 3, r.segs);
  ok('and an amount box beside it', r.amts === r.segs, r.amts + ' vs ' + r.segs);
  ok('the live preview says the product is simulated', r.previewMarked);
  ok('the header says so too, before anything is written', r.headNote);
  ok('what is already on the air is listed', r.hasActive);
  ok('a product with no area cannot be issued', r.blocked);
  ok('once an area exists it can', r.allowed);
  ok('changing product keeps the hazards you already set', r.kept === 3, r.kept);
  ok('and keeps the area you already drew', r.polyKept === 4, r.polyKept);
}

console.log('\n13. re-issuing something from the history');
{
  const r = await page.evaluate(async () => {
    __reset();
    _adDraft = _adNewDraft('TOR');
    _adDraft.poly = __box(28.5, -80.7, 0.35); _adDraft.areaMode = 'draw';
    _adDraft.areaName = 'Brevard County';
    _adSetLevel('tornado', 3); _adSetAmount('hail', '1.50');
    _adIssue();
    const uid = _adState.items[0].uid;
    _adCancelProduct(uid);

    _adReuse(uid);
    await new Promise(r2 => setTimeout(r2, 200));
    const d = _adDraft;
    const ready = !document.getElementById('ad-issue').disabled;
    _adIssue();
    _adClose();
    return {
      code: d.code, lvl: d.haz.tornado.lvl, amt: d.haz.hail.amt,
      area: d.areaName, ready,
      live: _adState.items.filter(a => a.status === 'active').length,
      total: _adState.items.length,
    };
  });
  ok('the composer comes back loaded with the old product', r.code === 'TOR' && r.lvl === 3, r.code + '/' + r.lvl);
  ok('including the amount that was typed', r.amt === '1.50', r.amt);
  ok('and the area it covered', /Brevard/.test(r.area || ''), r.area);
  ok('so it can go straight back out', r.ready && r.live === 1, r.live);
  ok('without overwriting the cancelled one in the history', r.total === 2, r.total);
}

console.log('\n14. nothing threw along the way');
await page.evaluate(() => { __reset(); });
ok('no uncaught page errors', errors.length === 0, errors.join(' | '));

await browser.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
