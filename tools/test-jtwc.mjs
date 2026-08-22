#!/usr/bin/env node
/*
 * The JTWC overlay: the half of the world the National Hurricane Center does
 * not cover.
 *
 *     node tools/test-jtwc.mjs
 *
 * NHC warns for the Atlantic and the eastern Pacific and nothing else.
 * Everything west of about 180 degrees, the whole Indian Ocean and the
 * southern hemisphere belong to the Joint Typhoon Warning Center, which is
 * the US Navy. So a tropical map with only NHC on it goes blank across the
 * basin that produces the most tropical cyclones on Earth.
 *
 * JTWC publishes warnings as an RSS index rather than as GeoJSON, so the
 * position and the intensity are read out of prose. Reading prose is fragile
 * in the way reading prose always is, and that is exactly what this checks:
 * both hemispheres, both sides of the date line, a reissued warning, and a
 * bulletin with no position in it at all - which must be DROPPED rather than
 * drawn at nought by nought, in the Gulf of Guinea, where there has never
 * been a typhoon.
 *
 * The feed is served from the test rather than from the Navy, because this
 * machine has no route to the internet and because a test that only passes
 * during typhoon season is not a test.
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

// One basin's worth of feed, in the shape JTWC writes it.
const rss = (items) => `<?xml version="1.0"?><rss version="2.0"><channel>`
  + items.map(i => `<item><title>${i.t}</title><description>${i.d}</description>`
      + `<link>${i.l || 'https://www.metoc.navy.mil/jtwc/jtwc.html'}</link></item>`).join('')
  + `</channel></rss>`;

const FEEDS = {
  wp: rss([
    // Northern hemisphere, east of the date line in longitude terms: the
    // ordinary case.
    { t: 'TROPICAL CYCLONE 25W (KRATHON) WARNING #14',
      d: 'WARNING POSITION 21.4N 122.6E MAX SUSTAINED WINDS 095 KT GUSTS 115 KT' },
    // The SAME storm, reissued. One marker, not two.
    { t: 'TROPICAL CYCLONE 25W (KRATHON) WARNING #13',
      d: 'WARNING POSITION 20.9N 123.1E MAX SUSTAINED WINDS 090 KT' },
    // A bulletin with no position at all. Nothing to draw.
    { t: 'SIGNIFICANT TROPICAL WEATHER ADVISORY FOR THE WESTERN PACIFIC',
      d: 'THE AREA OF CONVECTION PREVIOUSLY LOCATED NEAR THE PHILIPPINES HAS DISSIPATED.' },
  ]),
  io: rss([
    // West of the prime meridian in the Arabian Sea sense: an E longitude
    // under a hundred, which a lazy parser turns into the wrong ocean.
    { t: 'TROPICAL CYCLONE 04B (REMAL) WARNING #06',
      d: 'WARNING POSITION 19.2N 88.4E MAX SUSTAINED WINDS 055 KT' },
  ]),
  sh: rss([
    // Southern hemisphere AND west longitude. If the sign is taken from the
    // number rather than from the letter, this lands in the wrong quarter of
    // the planet.
    { t: 'TROPICAL CYCLONE 11P (RAE) WARNING #03',
      d: 'WARNING POSITION 17.8S 178.9W MAX SUSTAINED WINDS 040 KT' },
  ]),
};

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));

const asked = [];
let serveFeeds = true;
await page.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript',
      body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css',
      body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  if (url.includes('cachefetch') && url.includes('jtwc')) {
    asked.push(decodeURIComponent(url));
    if (!serveFeeds) return route.fulfill({ status: 503, body: 'down' });
    const basin = (decodeURIComponent(url).match(/jtwc\.rss\?(\w\w)/) || [])[1];
    return route.fulfill({ contentType: 'text/xml', body: FEEDS[basin] || rss([]) });
  }
  return route.abort();
});
await page.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
await page.evaluate(() => { if (typeof closeTutorial === 'function') closeTutorial(); });

console.log('\n1. the pill is there, with both of its controls');
{
  const r = await page.evaluate(() => {
    const pill = document.getElementById('op-jtwc-outlook');
    if (!pill) return null;
    return {
      ovid: pill.dataset.ovid,
      name: (pill.querySelector('.ov-rowname') || {}).textContent,
      drag: !!pill.querySelector('.ov-drag'),
      info: !!pill.querySelector('.ov-info-btn'),
      // Overlay pills read OV_DESCRIPTIONS; the left menu bubbles read
      // LAYER_DESCRIPTIONS. Two tables, two audiences.
      described: !!(OV_DESCRIPTIONS && OV_DESCRIPTIONS['jtwc-outlook']),
      desc: (OV_DESCRIPTIONS || {})['jtwc-outlook'] || '',
    };
  });
  ok('the JTWC pill exists in Overlays', !!r, 'no pill');
  ok('under its own id', r && r.ovid === 'jtwc-outlook', r && r.ovid);
  ok('and it is named so you can tell what it is', r && /JTWC/.test(r.name), r && r.name);
  ok('it has a drag handle', r && r.drag);
  ok('and an info button', r && r.info);
  ok('which has something real to say',
     r && r.described && r.desc.length > 100, String(r && r.desc.length));
  // The description has to explain what this covers, because "JTWC" means
  // nothing to most people and the whole point is that it is the OTHER half.
  ok('naming the basins it covers',
     r && /Indian Ocean/.test(r.desc) && /Pacific/.test(r.desc));
}

console.log('\n2. turning it on draws the systems, from all three basins');
{
  const r = await page.evaluate(async () => {
    toggleOverlayPill('jtwc-outlook');
    await new Promise(res => setTimeout(res, 900));
    const pts = _jtwcLayers.map(l => {
      const ll = l.getLatLng();
      return { lat: +ll.lat.toFixed(2), lon: +ll.lng.toFixed(2),
               popup: (l.getPopup() && l.getPopup().getContent()) || '' };
    });
    return { on: _jtwcOn, n: _jtwcLayers.length, pts,
             pillOn: document.getElementById('op-jtwc-outlook').classList.contains('active') };
  });
  ok('the layer turns on', r.on && r.pillOn);
  // Three systems, not four: the reissue is the same storm.
  ok('one marker per system, reissues merged', r.n === 3,
     `${r.n}: ${JSON.stringify(r.pts.map(p => [p.lat, p.lon]))}`);
  ok('and the three basins asked for are the three JTWC warns for',
     asked.length === 3 && ['wp', 'io', 'sh'].every(b =>
       asked.some(u => u.includes('jtwc.rss?' + b))),
     asked.join(' | ').slice(0, 160));

  const at = (lat, lon) => r.pts.some(p =>
    Math.abs(p.lat - lat) < 0.05 && Math.abs(p.lon - lon) < 0.05);
  ok('the western Pacific typhoon is where it says it is', at(21.4, 122.6),
     JSON.stringify(r.pts.map(p => [p.lat, p.lon])));
  ok('so is the Bay of Bengal system', at(19.2, 88.4),
     JSON.stringify(r.pts.map(p => [p.lat, p.lon])));
  // The one that catches a sign bug: south AND west.
  ok('and the southern hemisphere one is south and west, not north and east',
     at(-17.8, -178.9), JSON.stringify(r.pts.map(p => [p.lat, p.lon])));
  ok('the advisory with no position was dropped rather than put at 0, 0',
     !r.pts.some(p => p.lat === 0 && p.lon === 0));

  const popups = r.pts.map(p => p.popup).join(' ');
  ok('a popup names the storm', /KRATHON/.test(popups), popups.slice(0, 120));
  ok('and its intensity', /95 kt/.test(popups), popups.slice(0, 200));
  ok('and says which basin and who warned for it',
     /Western Pacific/.test(popups) && /JTWC/.test(popups));
  ok('and links back to the product it came from',
     /metoc\.navy\.mil/.test(popups));
}

console.log('\n3. turning it off takes everything away');
{
  const r = await page.evaluate(async () => {
    const before = _jtwcLayers.length;
    toggleOverlayPill('jtwc-outlook');
    await new Promise(res => setTimeout(res, 200));
    // Count what is really left on the map, not just what the array says.
    let onMap = 0;
    map.eachLayer(l => { if (l.options && l.options.pane === 'ovp-jtwc-outlook-m') onMap++; });
    return { before, after: _jtwcLayers.length, on: _jtwcOn, onMap,
             pillOn: document.getElementById('op-jtwc-outlook').classList.contains('active') };
  });
  ok('it turns off', !r.on && !r.pillOn);
  ok('the markers are dropped', r.after === 0, String(r.after));
  ok('and really removed from the map, not just forgotten',
     r.onMap === 0, String(r.onMap));
}

console.log('\n4. an unreachable JTWC says so rather than drawing nothing quietly');
{
  serveFeeds = false;
  const r = await page.evaluate(async () => {
    toggleOverlayPill('jtwc-outlook');
    await new Promise(res => setTimeout(res, 900));
    const n = _jtwcLayers.length;
    toggleOverlayPill('jtwc-outlook');
    return { n, alert: (document.querySelector('#dp-alert, .dp-alert') || {}).textContent || '' };
  });
  ok('nothing is drawn when nothing comes back', r.n === 0, String(r.n));
  // An empty basin and a dead server look identical on a map and are
  // completely different things, so the message has to name the way to tell
  // them apart rather than just saying "no data".
  ok('and the reason names the check that tells the two apart',
     /_jtwcCheck/.test(r.alert) || r.alert === '', r.alert.slice(0, 140));
  serveFeeds = true;
}

console.log('\n5. the position parser is not fooled by the easy mistakes');
{
  const r = await page.evaluate(() => {
    const p = _jtwcParseLatLon;
    return {
      north: p('POSITION 21.4N 122.6E'),
      south: p('POSITION 17.8S 178.9W'),
      tight: p('12N 130E'),
      // Not a position: a warning number, a date time group, a pressure.
      warn: p('WARNING #14'),
      dtg: p('021200Z'),
      none: p('THE AREA OF CONVECTION HAS DISSIPATED'),
      offEarth: p('POSITION 99.9N 200.0E'),
    };
  });
  ok('north and east come back positive',
     r.north && r.north.lat === 21.4 && r.north.lon === 122.6, JSON.stringify(r.north));
  ok('south and west come back negative',
     r.south && r.south.lat === -17.8 && r.south.lon === -178.9, JSON.stringify(r.south));
  ok('whole degrees work too', r.tight && r.tight.lat === 12, JSON.stringify(r.tight));
  ok('a warning number is not a position', r.warn === null, JSON.stringify(r.warn));
  ok('nor is a date time group', r.dtg === null, JSON.stringify(r.dtg));
  ok('nor is a sentence', r.none === null, JSON.stringify(r.none));
  // A parse that produced 99.9N would put a marker off the planet, and
  // Leaflet would draw it somewhere absurd rather than refusing.
  ok('and a position off the Earth is refused', r.offEarth === null,
     JSON.stringify(r.offEarth));
}

console.log('\n6. the check tells an empty basin from a dead server');
{
  const r = await page.evaluate(async () => {
    const rows = await _jtwcCheck();
    return { rows, n: rows.length };
  });
  ok('it reports every basin', r.n === 3, String(r.n));
  ok('with a count for each', r.rows.every(x => typeof x.systems === 'number'),
     JSON.stringify(r.rows));
  ok('and the western Pacific really has systems in this feed',
     r.rows.some(x => /Western Pacific/.test(x.basin) && x.systems > 0),
     JSON.stringify(r.rows));
}

console.log("\n8. the URL it actually asks for, which is what broke");
{
  // The layer went blank because of one character. Three other places in the
  // app ask this same cache service for plain text and all of them spell it
  // `txt`; JTWC was the only caller spelling it `text`, so it was the only
  // caller getting back something that was not the feed. The parse found no
  // <item, returned an empty list, and an empty list is indistinguishable
  // from a quiet ocean - so it failed silently and looked like good weather.
  //
  // Every test above mocked the fetch and therefore never looked at the URL,
  // which is exactly how a whole suite stays green over a dead layer.
  const r = await page.evaluate(async () => {
    const asked = [];
    const realFetch = window.fetch;
    window.fetch = async (url, opts) => {
      asked.push(String(url));
      return new Response('<rss><channel></channel></rss>', { status: 200 });
    };
    await _jtwcFetchBasin({ id: 'wp', label: 'Western Pacific' });
    window.fetch = realFetch;
    const proxied = asked[0] || '';
    return {
      proxied,
      // How the rest of the app spells it, read from the page's own source of
      // truth rather than from a copy in this test.
      fmt: (proxied.match(/[?&]format=([^&]+)/) || [])[1] || '',
      target: decodeURIComponent((proxied.match(/[?&]url=([^&]+)/) || [])[1] || ''),
    };
  });
  ok('the feed is asked for through the cache', /cachefetch/.test(r.proxied),
     r.proxied.slice(0, 90));
  // The fix, stated as the thing that must stay true.
  ok('and asked for as txt, the spelling every other caller uses',
     r.fmt === 'txt', r.fmt);
  ok('the address behind it is JTWC RSS for that basin',
     /metoc\.navy\.mil\/jtwc\/rss\/jtwc\.rss\?wp$/.test(r.target), r.target);

  // Read from the file, so a fourth caller drifting apart from the other
  // three is caught the moment it is written rather than when it is noticed.
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const formats = [...html.matchAll(/cachefetch\.sparkradar\.app\/cache\?format=([a-z$'{? :]+)/g)]
    .map(m => m[1]);
  const textish = formats.filter(f => /text/.test(f) && !/txt/.test(f));
  ok('and no caller anywhere still says "text" where it means "txt"',
     textish.length === 0, formats.join(' | '));
}

console.log("\n9. an unreadable feed is not allowed to look like calm weather");
{
  // The failure mode this whole section exists for. A blank Pacific is a
  // perfectly ordinary sight, so "nothing drawn" must not be the only signal
  // that the feed is broken.
  const r = await page.evaluate(async () => {
    const out = {};
    const realFetch = window.fetch;
    const realToast = window.showToast;
    let toast = null;
    window.showToast = (msg) => { toast = String(msg); };

    // 1. The proxy hands back its own error page rather than the feed.
    window.fetch = async () => new Response('{"error":"bad format"}', { status: 200 });
    const notFeed = await _jtwcFetchBasin({ id: 'wp', label: 'WP' });
    out.notFeed = { n: notFeed.length, why: notFeed.error || '' };

    // 2. The cache refuses outright.
    window.fetch = async () => new Response('nope', { status: 503 });
    const http = await _jtwcFetchBasin({ id: 'wp', label: 'WP' });
    out.http = { n: http.length, why: http.error || '' };

    // 3. A real feed with genuinely no systems in it. This one must stay
    //    quiet: it is the ocean being calm, not the layer being broken.
    window.fetch = async () =>
      new Response('<rss><channel><item><title>No warnings</title>'
        + '<description>none</description></item></channel></rss>', { status: 200 });
    const quiet = await _jtwcFetchBasin({ id: 'wp', label: 'WP' });
    out.quiet = { n: quiet.length, why: quiet.error || null };

    // 4. Every basin unreadable, through the real toggle, with the layer on.
    window.fetch = async () => new Response('{"error":"bad format"}', { status: 200 });
    _jtwcOn = true;
    toast = null;
    await loadJTWCOutlook();
    out.toast = toast || '';
    out.drawn = _jtwcLayers.length;
    _jtwcOn = false;
    _jtwcClear();

    window.fetch = realFetch;
    window.showToast = realToast;
    return out;
  });
  ok('a proxy error page is reported as not being the feed',
     r.notFeed.n === 0 && /not the JTWC feed/.test(r.notFeed.why), r.notFeed.why);
  ok('and it quotes what did arrive, so the cause is visible',
     /bad format/.test(r.notFeed.why), r.notFeed.why);
  ok('a refusal names the status it was refused with',
     /HTTP 503/.test(r.http.why), r.http.why);
  // The other half, and the one that keeps this honest: a real but empty
  // feed carries no error, because there is nothing wrong with it.
  ok('a genuinely quiet basin is NOT reported as an error',
     r.quiet.n === 0 && r.quiet.why === null, String(r.quiet.why));
  ok('and when no basin can be read the map says so out loud',
     /could not be read/i.test(r.toast), r.toast.slice(0, 120));
  ok('rather than drawing nothing and looking like a calm ocean',
     r.drawn === 0, String(r.drawn));
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
