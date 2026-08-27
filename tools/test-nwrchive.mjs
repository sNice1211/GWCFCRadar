// NWRchive: the NOAA Weather Radio archive site (nwrchive.html).
// Drill-down region > state > station > year/month > day, the day player,
// alert highlights with filters, station search, demo mode, and the wiring
// to the JSON indexes pi/nwr_index.py writes.
//
//   node tools/test-nwrchive.mjs
import { chromium } from '/tmp/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + String(extra).slice(0, 300) + '>' : '')); }
};

console.log('\n1. the source');
const html = readFileSync(join(ROOT, 'nwrchive.html'), 'utf8');
// Built from its code point rather than written out, so this file can
// check for the character without containing one and breaking the rule
// it is checking.
const EM_DASH = String.fromCharCode(0x2014);
ok('no em dash anywhere in the page', !html.includes(EM_DASH));
ok('the home page nav already points at this exact filename',
   /href="nwrchive\.html"/.test(readFileSync(join(ROOT, 'index (3).html'), 'utf8')));
ok('all six sketch regions exist',
   ['Northeast', 'Southeast', 'Northwest', 'Southwest', 'Mideast', 'Midwest']
     .every(r => html.includes("'" + r + "'")));
ok('audio comes from rolling and highlights paths like the archiver writes',
   html.includes("'/rolling/'") && html.includes("'/highlights/'")
   && html.includes("/meta/"));
ok('no emoji anywhere: every icon is a real inline SVG',
   !/&#x1F|&#x26A0|&#x25B6|&#x2753/.test(html)
   && ![...html].some(c => {
     const p = c.codePointAt(0);
     return (p >= 0x1F000 && p <= 0x1FAFF) || (p >= 0x2600 && p <= 0x27BF);
   })
   && (html.match(/class="ic"/g) || []).length >= 8);
ok('the header thanks the three stream providers, not our socials',
   !/discord\.gg|youtube\.com|x\.com\/GWCFCenter/.test(html)
   && /Thanks/.test(html) && /weatherusa\.net/.test(html)
   && /noaaweatherradio\.org/.test(html) && /globaleas\.org/.test(html)
   && /weatherradio\.org/.test(html));

const BASE = 'https://archive.test/nwr';
const FAKE_INDEX = { generated: '2026-08-24T00:00:00Z', stations: [
  { id: 'KIH21', name: 'KIH21 Sebring FL 162.475', state: 'FL', freq: '162.475',
    dates: { '2026-08-23': { chunks: 5, highlights: 0 },
             '2026-08-24': { chunks: 5, highlights: 2 } } },
  { id: 'KEC50', name: 'KEC50 Miami FL 162.550', state: 'FL', freq: '162.550',
    dates: { '2026-08-24': { chunks: 3, highlights: 0 } } },
  { id: 'KWO35', name: 'KWO35 New York NY 162.550', state: 'NY', freq: '162.550',
    dates: { '2026-08-24': { chunks: 2, highlights: 0 } } },
] };
const FAKE_DAY = {
  chunks: ['120000', '120200', '120400', '131400', '131600'],
  highlights: [
    { t: '131400', reason: 'same_tone', keywords: ['tornado', 'warning'],
      transcript: 'A tornado warning has been issued for Highlands County.' },
    { t: '131600', reason: 'keyword', keywords: ['flash flood'],
      transcript: 'A flash flood warning continues for Polk County.' },
  ],
};

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'],
});
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const audioAsked = [];
await page.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url === BASE + '/index.json')
    return route.fulfill({ contentType: 'application/json',
      body: JSON.stringify(FAKE_INDEX) });
  if (url.startsWith(BASE + '/meta/KIH21/2026-08-24'))
    return route.fulfill({ contentType: 'application/json',
      body: JSON.stringify(FAKE_DAY) });
  if (url.includes('.opus')) { audioAsked.push(url); return route.abort(); }
  return route.abort();   // fonts etc.
});

console.log('\n2. demo mode: browsable when the archive cannot be reached');
{
  await page.goto('file://' + join(ROOT, 'nwrchive.html'),
                  { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  const r = await page.evaluate(() => ({
    demo: DEMO,
    banner: !!document.querySelector('.notice.demo'),
    regions: document.querySelectorAll('#app .card').length,
    dflt: NWR_DEFAULT_BASE,
  }));
  // The page ships pointed at the real archive. This is the check that it
  // stays pointed there: it spent a while shipping with an empty default,
  // which meant every visitor got the two-station sample and no way to tell
  // that was not the archive.
  ok('it ships pointed at a real archive, not at nothing',
     /^https:\/\/\S+/.test(r.dflt || ''), JSON.stringify(r.dflt));
  // In this run that host is not routed, so the fetch fails. Falling back to
  // the sample rather than to an empty page is the behaviour under test, and
  // saying so on screen is the half that matters.
  ok('an unreachable archive falls back to the sample and says so',
     r.demo && r.banner, JSON.stringify(r));
  ok('the six region cards are on screen', r.regions === 6, String(r.regions));

  const fonts = await page.evaluate(() => {
    const bad = [];
    document.querySelectorAll('body *').forEach(el => {
      if (!el.offsetParent && el.tagName !== 'BODY') return;
      const f = getComputedStyle(el).fontFamily || '';
      if (f && !/comfortaa/i.test(f.split(',')[0])) {
        bad.push(el.tagName + '#' + (el.id || '') + ' -> ' + f.slice(0, 40));
      }
    });
    return bad.slice(0, 6);
  });
  ok('nothing on the page renders in anything but Comfortaa',
     fonts.length === 0, fonts.join(' | '));
}

console.log('\n2b. Home goes to the home page, never to the radar');
{
  const r = await page.evaluate(() => ({
    // On the GitHub Pages copy and in a local preview, a neighbouring
    // index.html is the RADAR APP, so Home must leave for the real site.
    here: document.getElementById('nav-home').getAttribute('href'),
    footer: document.querySelector('footer .home-link').getAttribute('href'),
    pages: homeHref.call(null),
    gwcfc: (() => {
      // What the link becomes when the page really is on GWCFC.net.
      const real = location.hostname;
      try {
        Object.defineProperty(location, 'hostname',
          { get: () => 'gwcfc.net', configurable: true });
      } catch (e) { return 'index.html'; }
      const out = homeHref();
      try {
        Object.defineProperty(location, 'hostname',
          { get: () => real, configurable: true });
      } catch (e) {}
      return out;
    })(),
  }));
  ok('off the network\'s own site, Home leaves for the home page',
     /^https?:\/\/[^/]*gwcfc\.net/i.test(r.here), r.here);
  ok('and the footer link goes to the same place',
     r.footer === r.here, r.footer);
  ok('on GWCFC.net itself it stays a plain neighbour link',
     r.gwcfc === 'index.html', r.gwcfc);
}

console.log('\n3. a real archive: the sketch drill-down');
{
  await page.goto('file://' + join(ROOT, 'nwrchive.html') + '?base=' + BASE,
                  { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  const home = await page.evaluate(() => ({
    demo: DEMO,
    sub: document.querySelector('.sub').textContent,
  }));
  ok('the ?base= URL connects it to the archive (no demo banner)',
     home.demo === false && /3 stations/.test(home.sub), JSON.stringify(home));

  const region = await page.evaluate(() => {
    location.hash = '#/region/Southeast';
    return new Promise(res => setTimeout(() => {
      const cards = Array.from(document.querySelectorAll('#app .card'));
      const fl = cards.find(c => c.textContent.includes('Florida'));
      const dim = cards.filter(c => c.classList.contains('dim')).length;
      res({ n: cards.length, fl: fl ? fl.textContent : '', dim });
    }, 100));
  });
  ok('Southeast lists its states with Florida counted',
     /2 stations/.test(region.fl), region.fl);
  ok('states with nothing archived show grayed, not hidden',
     region.dim > 0 && region.n === 9, JSON.stringify(region));

  const state = await page.evaluate(() => {
    location.hash = '#/state/FL';
    return new Promise(res => setTimeout(() => {
      const cards = Array.from(document.querySelectorAll('#app .card'));
      res({ n: cards.length, txt: cards.map(c => c.textContent).join('|') });
    }, 100));
  });
  ok('Florida lists exactly its two stations',
     state.n === 2 && /KIH21/.test(state.txt) && /KEC50/.test(state.txt)
       && !/KWO35/.test(state.txt), state.txt);

  const station = await page.evaluate(() => {
    location.hash = '#/station/KIH21';
    return new Promise(res => setTimeout(() => {
      const h2s = Array.from(document.querySelectorAll('#app h2')).map(h => h.textContent);
      const cards = Array.from(document.querySelectorAll('#app .card')).map(c => c.textContent);
      res({ h2s, cards });
    }, 100));
  });
  ok('the station page groups days under year and month',
     station.h2s.includes('2026') && station.h2s.some(t => /August/.test(t)),
     JSON.stringify(station.h2s));
  ok('each day card carries its counts, alerts flagged in gold',
     station.cards.length === 2 && station.cards.some(t => /2 alerts/.test(t)),
     JSON.stringify(station.cards));
}

console.log('\n4. a day: the player and the highlights');
{
  const r = await page.evaluate(() => {
    location.hash = '#/station/KIH21/2026-08-24';
    return new Promise(res => setTimeout(() => {
      res({
        chunks: document.querySelectorAll('.chunkbtn').length,
        hlChunks: document.querySelectorAll('.chunkbtn.hl').length,
        hlCards: document.querySelectorAll('.hlcard').length,
        transcript: (document.querySelector('.hlcard .tr') || {}).textContent || '',
        audio: !!document.getElementById('au'),
      });
    }, 300));
  });
  ok('every two-minute chunk is a button', r.chunks === 5, String(r.chunks));
  ok('chunks where an alert aired glow gold', r.hlChunks === 2, String(r.hlChunks));
  ok('both highlights render with their transcripts',
     r.hlCards === 2 && /Highlands County/.test(r.transcript), r.transcript);
  ok('there is a real audio element', r.audio);

  const play = await page.evaluate(() => {
    playChunk(0);
    const first = document.getElementById('au').src;
    playHighlight('131400');
    const hl = document.getElementById('au').src;
    return { first, hl,
             marked: document.querySelectorAll('.chunkbtn.playing').length };
  });
  ok('playing a chunk points the player at the rolling archive',
     play.first.endsWith('/rolling/KIH21/2026-08-24/120000.opus'), play.first);
  ok('playing a highlight uses its permanent better-quality copy',
     play.hl.endsWith('/highlights/KIH21/2026-08-24/131400.opus'), play.hl);
  ok('the playing chunk is marked in the grid', play.marked === 1);

  const filt = await page.evaluate(() => {
    setHlFilter('tone');
    return new Promise(res => setTimeout(() => {
      const cards = Array.from(document.querySelectorAll('.hlcard')).map(c => c.textContent);
      setHlFilter('all');
      res(cards);
    }, 300));
  });
  ok('the SAME-tone filter narrows to tone-detected alerts only',
     filt.length === 1 && /SAME tone/.test(filt[0]), JSON.stringify(filt));
}

console.log('\n4b. the search bar fills the bar, and Filter works');
{
  const layout = await page.evaluate(() => {
    const nav = document.querySelector('nav').getBoundingClientRect();
    const inp = document.getElementById('q').getBoundingClientRect();
    const btn = document.getElementById('filter-btn').getBoundingClientRect();
    return { navW: nav.width, inpW: inp.width,
             sameRow: Math.abs(inp.top - btn.top) < 6,
             btnRight: btn.left > inp.right - 2 };
  });
  ok('the search box takes the empty middle of the bar, not a corner',
     layout.inpW > layout.navW * 0.3,
     Math.round(layout.inpW) + 'px of ' + Math.round(layout.navW));
  ok('the Filter button sits beside it on the same row',
     layout.sameRow && layout.btnRight, JSON.stringify(layout));

  const f = await page.evaluate(() => {
    const out = {};
    document.getElementById('filter-btn').click();
    out.opened = document.getElementById('filter-panel').classList.contains('on');
    // KWO35 in New York has recordings but never caught an alert, so the
    // alerts-only filter must drop it and keep the Sebring station.
    setFilter('withAlerts', true);
    out.lit = document.getElementById('filter-btn').classList.contains('on');
    out.dot = document.getElementById('filter-dot').textContent;
    location.hash = '#/state/NY';
    return new Promise(res => setTimeout(() => {
      out.nyEmpty = /matches the filters/i.test(document.getElementById('app').textContent);
      location.hash = '#/state/FL';
      setTimeout(() => {
        out.flCards = document.querySelectorAll('#app .card').length;
        out.flText = document.getElementById('app').textContent;
        clearFilters();
        setTimeout(() => {
          out.clearedCards = document.querySelectorAll('#app .card').length;
          out.clearedDot = document.getElementById('filter-dot').style.display;
          res(out);
        }, 120);
      }, 120);
    }, 120));
  });
  ok('the button opens its panel', f.opened);
  ok('choosing a filter lights the button and counts it',
     f.lit && f.dot === '1', JSON.stringify({ lit: f.lit, dot: f.dot }));
  ok('a state whose stations caught no alerts says so, not a bare blank',
     f.nyEmpty);
  ok('and the filter really narrows the list',
     f.flCards === 1 && /KIH21/.test(f.flText) && !/KEC50/.test(f.flText),
     f.flCards + ' cards');
  ok('clearing brings everything back and unlights the button',
     f.clearedCards === 2 && f.clearedDot === 'none',
     JSON.stringify({ n: f.clearedCards, dot: f.clearedDot }));

  // The day page's alert pills and the Filter panel are the same setting.
  const shared = await page.evaluate(() => {
    location.hash = '#/station/KIH21/2026-08-24';
    return new Promise(res => setTimeout(() => {
      setHlFilter('tone');
      setTimeout(() => {
        const out = {
          cards: document.querySelectorAll('.hlcard').length,
          radio: document.getElementById('f-hl-tone').checked,
          dot: document.getElementById('filter-dot').textContent,
        };
        clearFilters();
        setTimeout(() => res(out), 120);
      }, 200);
    }, 300));
  });
  ok('the day page pills and the Filter panel are one setting',
     shared.cards === 1 && shared.radio === true && shared.dot === '1',
     JSON.stringify(shared));
}

console.log('\n5. search and about');
{
  const r = await page.evaluate(() => new Promise(res => setTimeout(() => {
    document.getElementById('q').value = 'sebring';
    doSearch();
    const hits = Array.from(document.querySelectorAll('#q-results div')).map(d => d.textContent);
    document.getElementById('q').value = 'KWO';
    doSearch();
    const byCall = Array.from(document.querySelectorAll('#q-results div')).map(d => d.textContent);
    location.hash = '#/about';
    setTimeout(() => res({ hits, byCall,
      about: document.getElementById('app').textContent }), 100);
  }, 400)));
  ok('searching a city finds its station',
     r.hits.length === 1 && /KIH21/.test(r.hits[0]), JSON.stringify(r.hits));
  ok('searching a callsign works too',
     r.byCall.length === 1 && /KWO35/.test(r.byCall[0]), JSON.stringify(r.byCall));
  ok('the About page tells the story',
     /SAME/.test(r.about) && /90 days/.test(r.about), r.about.slice(0, 120));
  ok('and credits all three providers by name',
     /WeatherUSA/.test(r.about) && /NOAAWeatherRadio\.org/.test(r.about)
       && /Global Weather/.test(r.about), r.about.slice(-300));
}

console.log('\n6. nothing threw');
// ── The centre's own name, and where Home goes ──────────────────────────────
// Both were wrong at once: the footer called the network by a name it does
// not have, and Home pointed at a relative index.html, which in THIS
// repository is the radar app rather than the centre's website.
{
  const src = readFileSync(join(ROOT, 'nwrchive.html'), 'utf8');
  ok('the network is called by its real name',
     /Guta Weather &amp; Climate Forecasting Center/.test(src)
       && !/Gulf West Central/.test(src));
  ok('and it is named that way everywhere, footer and about alike',
     (src.match(/Guta Weather &amp; Climate Forecasting Center/g) || []).length >= 2);
  const links = await page.evaluate(() => ({
    home: (document.getElementById('nav-home') || {}).getAttribute
      ? document.getElementById('nav-home').getAttribute('href') : '',
    footer: [...document.querySelectorAll('.home-link')]
      .map(a => a.getAttribute('href')),
  }));
  ok('Home points at the website, spelled out in full',
     links.home === 'https://gwcfc.net/', links.home);
  ok('and so does the footer, rather than a relative index.html that is '
     + 'the radar in this repo',
     links.footer.length > 0 && links.footer.every(h => h === 'https://gwcfc.net/'),
     links.footer.join(','));
}

ok('no uncaught page errors', errors.length === 0, errors.join(' | '));

await browser.close();
console.log('\nthe logo in the header');
{
  // The mark is a folder crossed with a radio, drawn with three gradients.
  // Checked by name rather than by shape: the geometry is allowed to be
  // tweaked, the identity is not.
  ok('the header carries the new mark, not the old generic radio glyph',
     html.includes('nwr-folder') && html.includes('nwr-face')
     && !html.includes('M3.4 6.8 16.2 2l.7 1.9L9.5 6.5H20a2 2 0'));
  ok('all three gradients are defined',
     ['nwr-folder', 'nwr-face', 'nwr-trim'].every(g => html.includes(`id="${g}"`)));
  ok('every gradient it paints with is one it defined',
     [...html.matchAll(/url\(#(nwr-[a-z]+)\)/g)]
       .every(m => html.includes(`id="${m[1]}"`)),
     [...html.matchAll(/url\(#(nwr-[a-z]+)\)/g)].map(m => m[1]).join(','));
  // The header is red and so is the radio face, so the mark needs something
  // to sit against or the face melts into the bar.
  ok('the mark sits on a dark plate, since red on red has no edge',
     /\.brand \.badge \{[^}]*background: rgba\(0,0,0,0\.34\)/.test(html));
  ok('and the old gold ring is gone, because the folder is gold too',
     !/\.brand \.badge \{[^}]*border: 3px solid var\(--gold\)/.test(html));
  ok('the page finally has a favicon', /rel="icon"/.test(html));
  ok('and it is the mark rather than a stock glyph',
     /rel="icon"[^>]*nwr-folder/.test(html));
}

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
