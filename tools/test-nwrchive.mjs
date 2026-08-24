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
ok('no em dash anywhere in the page', !html.includes('—'));
ok('the home page nav already points at this exact filename',
   /href="nwrchive\.html"/.test(readFileSync(join(ROOT, 'index (3).html'), 'utf8')));
ok('all six sketch regions exist',
   ['Northeast', 'Southeast', 'Northwest', 'Southwest', 'Mideast', 'Midwest']
     .every(r => html.includes("'" + r + "'")));
ok('audio comes from rolling and highlights paths like the archiver writes',
   html.includes("'/rolling/'") && html.includes("'/highlights/'")
   && html.includes("/meta/"));

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

console.log('\n2. demo mode: browsable before any archive exists');
{
  await page.goto('file://' + join(ROOT, 'nwrchive.html'),
                  { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  const r = await page.evaluate(() => ({
    demo: DEMO,
    banner: !!document.querySelector('.notice.demo'),
    regions: document.querySelectorAll('#app .card').length,
  }));
  ok('with no base configured it runs on demo data and says so',
     r.demo && r.banner, JSON.stringify(r));
  ok('the six region cards are on screen', r.regions === 6, String(r.regions));
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
}

console.log('\n6. nothing threw');
ok('no uncaught page errors', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
