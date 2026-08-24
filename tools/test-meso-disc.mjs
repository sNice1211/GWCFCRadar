#!/usr/bin/env node
/*
 * SPC Mesoscale Discussions: reproduces the exact reported failure - the
 * primary NOAA MapServer answering with a validly-shaped but EMPTY GeoJSON
 * response - and proves the overlay now keeps trying its other two sources
 * instead of accepting that as "done", the same way loadWPCOutlook and
 * loadFireWxOutlook (its siblings, same URL-fallback pattern) already did.
 *
 *     node tools/test-meso-disc.mjs
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

const REAL_MCD = JSON.stringify({ type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { product_id: '1234', concerning: 'Severe potential' },
    geometry: { type: 'Polygon', coordinates: [[[-98, 35], [-97, 35], [-97, 36], [-98, 36], [-98, 35]]] } },
] });
const EMPTY = JSON.stringify({ type: 'FeatureCollection', features: [] });

async function boot(mockNet) {
  const page = await browser.newPage();
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
    const hit = mockNet(url);
    if (hit !== undefined)
      return route.fulfill({ contentType: 'application/json', body: hit });
    return route.abort();
  });
  await page.goto('file://' + join(ROOT, 'index.html'),
                  { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  return { page, errors };
}

console.log('\n1. the primary source answering empty no longer ends the search');
{
  // mapservices.weather.noaa.gov (primary) answers with a valid, empty
  // GeoJSON - exactly what a live 200 OK with the wrong/retired layer index
  // looks like. mesonet.agron.iastate.edu (the second source) has the real,
  // active MCD. The old loose check took the first (empty) answer as final.
  const { page, errors } = await boot(url => {
    if (url.includes('mapservices.weather.noaa.gov')) return EMPTY;
    if (url.includes('mesonet.agron.iastate.edu')) return REAL_MCD;
    return undefined;
  });
  await page.evaluate(() => loadMesoDisc());
  await page.waitForTimeout(1500);
  const st = await page.evaluate(() => ({
    hasLayer: !!_mesoLayer,
    count: _mesoLayer ? Object.keys(_mesoLayer._layers).length : 0,
  }));
  ok('it fell through to the second source and drew the real MCD',
     st.hasLayer === true && st.count === 1, JSON.stringify(st));
  ok('nothing threw', errors.length === 0, errors.join(' | '));
  await page.close();
}

console.log('\n2. the primary source having real data still wins immediately');
{
  const { page } = await boot(url => {
    if (url.includes('mapservices.weather.noaa.gov')) return REAL_MCD;
    return EMPTY;
  });
  await page.evaluate(() => loadMesoDisc());
  await page.waitForTimeout(1000);
  const st = await page.evaluate(() => ({
    hasLayer: !!_mesoLayer,
    count: _mesoLayer ? Object.keys(_mesoLayer._layers).length : 0,
  }));
  ok('the primary source is still tried first and used when it has data',
     st.hasLayer === true && st.count === 1, JSON.stringify(st));
  await page.close();
}

console.log('\n2b. the server\'s own copy is tried before any public source');
{
  // feeds_pipeline.py fetches the MCDs on the server and serve.py exposes
  // them at /feeds/mcd.json. A fresh copy there must win outright - and a
  // fresh copy that is validly EMPTY is the real state of the sky, so the
  // public sources must not be bothered either way.
  const asked = [];
  const { page } = await boot(url => {
    asked.push(url);
    if (url.includes('/feeds/mcd.json')) return JSON.stringify({
      fetched: new Date().toISOString(),
      source: 'test',
      geojson: JSON.parse(REAL_MCD),
    });
    return EMPTY;
  });
  await page.evaluate(() => { _hdBase = 'https://pi.example.test'; return loadMesoDisc(); });
  await page.waitForTimeout(1000);
  const st = await page.evaluate(() => ({
    hasLayer: !!_mesoLayer,
    count: _mesoLayer ? Object.keys(_mesoLayer._layers).length : 0,
  }));
  // Only the MCD's own addresses count, direct or inside a relay's url=
  // parameter: the radar mosaic also lives on mesonet.agron, and other
  // boot-time features use the same relays for their own feeds.
  const publicAsked = asked.filter(u => {
    let d = u; try { d = decodeURIComponent(u); } catch {}
    return /SPC_mcd|spc_mcd\.geojson|\/products\/md\/md\.geojson/.test(d);
  });
  ok('the MCD on the map came from the server copy',
     st.hasLayer === true && st.count === 1, JSON.stringify(st));
  ok('and no public source or relay was asked at all',
     publicAsked.length === 0, publicAsked.join(' | ').slice(0, 160));

  // Stale is a different story: hours old means the fetcher is down, and
  // the live sources then deserve their turn.
  asked.length = 0;
  await page.evaluate(() => new Promise(res => {
    const realFetch = window.fetch;
    window.fetch = (u, o) => {
      const s = String(u);
      if (s.includes('/feeds/mcd.json')) {
        return Promise.resolve(new Response(JSON.stringify({
          fetched: new Date(Date.now() - 3 * 3600000).toISOString(),
          geojson: { type: 'FeatureCollection', features: [] },
        }), { status: 200 }));
      }
      return realFetch(u, o);
    };
    loadMesoDisc().then(() => { window.fetch = realFetch; res(); });
  }));
  const stalePublic = asked.filter(u => /mapservices\.weather\.noaa\.gov/.test(u));
  ok('a stale server copy hands the job back to the live sources',
     stalePublic.length > 0, String(asked.length));
  await page.close();
}

console.log('\n3. every source genuinely empty reports "none active", not "broken"');
{
  const mesoHosts = ['mapservices.weather.noaa.gov', 'mesonet.agron.iastate.edu', 'www.spc.noaa.gov'];
  const { page } = await boot(url => mesoHosts.some(h => url.includes(h)) ? EMPTY : undefined);
  await page.evaluate(() => loadMesoDisc());
  await page.waitForTimeout(1500);
  const status = await page.evaluate(() =>
    document.getElementById('load-status')?.textContent || '');
  ok('says no active MCDs rather than claiming the feature failed',
     /no active/i.test(status), status);
  await page.close();
}

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
