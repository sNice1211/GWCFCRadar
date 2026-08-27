#!/usr/bin/env node
/*
 * The service worker's caching brain, run outside a browser.
 *
 *     node tools/test-sw.mjs
 *
 * sw.js is loaded into a mocked worker scope (self, caches, fetch) and its
 * fetch handler is exercised the way the browser would. We prove:
 *
 *   - a radar tile is fetched once and then served from cache, no network
 *   - a CDN library (Leaflet) lands in the static cache, cache-first
 *   - opening the app prefers the network and stores the page as the shell
 *   - when the network dies, the app still opens from the cached shell
 *   - when the network is merely slow, the cached shell answers at the
 *     timeout instead of leaving the user staring at white
 *   - a request to a live-data host (api.weather.gov) is not intercepted
 *   - the tile cache is pruned back under its cap, oldest entries first
 *
 * This is what makes "repeat visits are instant" a checked fact rather than
 * a hope pinned on the browser.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import vm from 'vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

// ── The mocked worker scope ────────────────────────────────────────────────

class MockCache {
  constructor() { this.m = new Map(); }
  _key(req) { return typeof req === 'string' ? req : req.url; }
  async match(req) { const r = this.m.get(this._key(req)); return r ? r.clone() : undefined; }
  async put(req, res) { this.m.set(this._key(req), res); }
  async delete(req) { return this.m.delete(this._key(req)); }
  async keys() { return [...this.m.keys()].map(u => ({ url: u })); }
}
const cacheStore = new Map();
const caches = {
  async open(name) {
    if (!cacheStore.has(name)) cacheStore.set(name, new MockCache());
    return cacheStore.get(name);
  },
  async keys() { return [...cacheStore.keys()]; },
  async delete(name) { return cacheStore.delete(name); },
};

// The network, swappable per scene. Counts calls so "served from cache"
// is provable as zero fetches.
let netImpl = async () => new Response('', { status: 404 });
let netCalls = 0;
const fetchMock = (req) => { netCalls++; return netImpl(req); };

const listeners = {};
const selfMock = {
  addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
  skipWaiting: () => {},
  registration: { scope: 'https://ralphhtml.github.io/GWCFCRadar/', showNotification: async () => {} },
  location: { origin: 'https://ralphhtml.github.io', hostname: 'ralphhtml.github.io' },
};

// Open tabs, so "the worker told the page a new version landed" is provable.
const clientMsgs = [];
const clientsMock = {
  claim: async () => {},
  matchAll: async () => [{ postMessage: (m) => clientMsgs.push(m) }],
};

const ctx = vm.createContext({
  self: selfMock, caches, fetch: fetchMock, clients: clientsMock,
  Response, Headers, URL, console, setTimeout, clearTimeout, Date, Promise, Math,
});
vm.runInContext(readFileSync(join(ROOT, 'sw.js'), 'utf8'), ctx);

const fetchHandlers = listeners.fetch || [];
function dispatchFetch(request) {
  let responded = null;
  const e = { request, respondWith(p) { responded = Promise.resolve(p); }, waitUntil() {} };
  fetchHandlers.forEach(fn => fn(e));
  return responded; // null means the SW let the browser handle it
}
const GET = (url, mode) => ({ url, method: 'GET', mode: mode || 'no-cors' });

// ── Scenes ─────────────────────────────────────────────────────────────────

const TILE = 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-202608190000/6/14/25.png';

async function main() {
  console.log('\n1. radar tiles: one trip to the network, then the cache');
  netImpl = async () => new Response('tile-bytes', { status: 200 });
  netCalls = 0;
  let r1 = await dispatchFetch(GET(TILE));
  ok('the first request is intercepted and answered', r1 && r1.status === 200, String(r1 && r1.status));
  ok('it went to the network once', netCalls === 1, String(netCalls));
  let r2 = await dispatchFetch(GET(TILE));
  ok('the second request is served from cache, zero network',
     r2 && r2.status === 200 && netCalls === 1, `calls=${netCalls}`);
  ok('the stored copy carries its timestamp',
     !!(r2 && r2.headers.get('x-sw-ts')), 'no x-sw-ts');

  console.log('\n2. the render-blocking library comes off disk after one visit');
  netImpl = async () => new Response('leaflet-js', { status: 200 });
  netCalls = 0;
  const LEAF = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js';
  await dispatchFetch(GET(LEAF));
  const r3 = await dispatchFetch(GET(LEAF));
  ok('leaflet is cached after the first fetch',
     r3 && r3.status === 200 && netCalls === 1, `calls=${netCalls}`);
  const staticCache = cacheStore.get('gwcfc-static-v3');
  ok('and it lives in the static cache, not among the tiles',
     !!(staticCache && staticCache.m.has(LEAF)), [...(staticCache ? staticCache.m.keys() : [])].join(','));

  console.log('\n2b. the shell fetch cannot be fooled by the HTTP cache');
{
  // GitHub Pages marks the page cacheable for ten minutes, so a plain
  // fetch(req) after a deploy gets the OLD page from the browser's own HTTP
  // cache, believes it is fresh, and saves it as the shell. That is how "I
  // merged it and the live site did not change" happens. The fix is a
  // forced revalidation, and it has to stay in the source.
  const src = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  ok('the shell is fetched with a forced revalidation',
     /fetch\(req\.url,\s*\{\s*cache:\s*'no-cache'/.test(src));
  ok('and the stale shell cache is purged by the version bump',
     /gwcfc-static-v3/.test(src) && !/STATIC_CACHE = 'gwcfc-static-v2'/.test(src));
  // The shell is served from disk instantly and refreshed in the background:
  // a repeat open must never wait on the network for a page already held.
  ok('the shell strategy is stale-while-revalidate',
     /shellStaleWhileRevalidate/.test(src) && !/SHELL_TIMEOUT_MS/.test(src));
}

console.log('\n3. first-ever open: nothing cached, the network answers and is stored');
  netImpl = async () => new Response('<html>fresh</html>', { status: 200 });
  netCalls = 0;
  const NAV = GET('https://ralphhtml.github.io/GWCFCRadar/?focus_alert=x', 'navigate');
  const r4 = await dispatchFetch(NAV);
  ok('a fast network answers with the fresh page',
     r4 && (await r4.clone().text()) === '<html>fresh</html>', 'not fresh');
  await new Promise(res => setTimeout(res, 20)); // let the background put land
  const shellKey = 'https://ralphhtml.github.io/GWCFCRadar/';
  ok('the page is stored under one fixed shell key, query string and all ignored',
     !!(staticCache && staticCache.m.has(shellKey)), [...(staticCache ? staticCache.m.keys() : [])].join(','));

  console.log('\n4. the network dies: the app still opens');
  netImpl = async () => { throw new Error('offline'); };
  const r5 = await dispatchFetch(GET('https://ralphhtml.github.io/GWCFCRadar/', 'navigate'));
  ok('the cached shell answers when the network throws',
     r5 && (await r5.clone().text()) === '<html>fresh</html>', String(r5 && r5.status));

  console.log('\n5. a repeat open never waits on the network at all');
  let slowResolve;
  netCalls = 0;
  netImpl = () => new Promise(res => { slowResolve = res; }); // hangs until released
  const t0 = Date.now();
  const r6 = await dispatchFetch(GET('https://ralphhtml.github.io/GWCFCRadar/', 'navigate'));
  const waited = Date.now() - t0;
  ok('the cached shell arrives instantly, even mid-hang',
     r6 && (await r6.clone().text()) === '<html>fresh</html>', String(r6 && r6.status));
  ok('with zero network wait: the disk copy answers, not a timeout',
     waited < 1000, waited + 'ms');
  ok('while a background refresh was still fired for next time',
     netCalls === 1, String(netCalls));
  slowResolve(new Response('late', { status: 200 })); // release the hanging fetch
  // Let that release finish writing the shell before the next scene sets its
  // own cached copy, or the two writes race and the next scene reads this
  // one's leftovers.
  await new Promise(res => setTimeout(res, 30));

  console.log('\n5b. a newer version announces itself instead of hiding');
  {
    // Serving from disk is what makes a repeat open instant, but it also
    // means a fresh deploy sits unseen until the NEXT open, which reads like
    // a change that never shipped. The worker has to say so.
    clientMsgs.length = 0;
    const KEY = 'https://ralphhtml.github.io/GWCFCRadar/';
    const staticC = cacheStore.get('gwcfc-static-v3');
    staticC.m.set(KEY, new Response('<html>v1</html>',
      { status: 200, headers: { etag: 'W/"aaa"' } }));
    netImpl = async () => new Response('<html>v2</html>',
      { status: 200, headers: { etag: 'W/"bbb"' } });
    const r = await dispatchFetch(GET(KEY, 'navigate'));
    ok('the cached page still answers immediately',
       (await r.clone().text()) === '<html>v1</html>');
    await new Promise(res => setTimeout(res, 30));
    ok('and the open tab is told a newer version landed',
       clientMsgs.some(m => m && m.type === 'gwcfc-shell-updated'),
       JSON.stringify(clientMsgs));

    // The common case: nothing changed. Saying so would be crying wolf.
    clientMsgs.length = 0;
    staticC.m.set(KEY, new Response('<html>v2</html>',
      { status: 200, headers: { etag: 'W/"bbb"' } }));
    await dispatchFetch(GET(KEY, 'navigate'));
    await new Promise(res => setTimeout(res, 30));
    ok('an unchanged page says nothing at all', clientMsgs.length === 0,
       JSON.stringify(clientMsgs));
  }

  console.log('\n6. live data is never intercepted');
  const r7 = dispatchFetch(GET('https://api.weather.gov/alerts/active'));
  ok('api.weather.gov passes straight through to the browser', r7 === null, 'was intercepted');
  const r8 = dispatchFetch({ url: 'https://mesonet.agron.iastate.edu/x', method: 'POST', mode: 'cors' });
  ok('a POST is never intercepted', r8 === null, 'was intercepted');

  console.log('\n7. the tile cache is pruned, oldest first');
  const tileCache = cacheStore.get('gwcfc-v19');
  // Fill well past the cap with pre-aged entries.
  for (let i = 0; i < 950; i++) {
    await tileCache.put('https://mesonet.agron.iastate.edu/fake/' + i,
      new Response('x', { status: 200, headers: { 'x-sw-ts': String(1000 + i) } }));
  }
  // 25 real fetches trip the once-every-25-puts prune check.
  netImpl = async () => new Response('t', { status: 200 });
  for (let i = 0; i < 26; i++) {
    await dispatchFetch(GET('https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-202608190005/6/1/' + i + '.png'));
  }
  await new Promise(res => setTimeout(res, 50)); // prune runs async after the put
  const left = (await tileCache.keys()).length;
  ok('the cache is trimmed back under its cap', left <= 760, String(left));
  ok('the newest entries survived the trim',
     !!(await tileCache.match('https://mesonet.agron.iastate.edu/fake/949')), 'newest evicted');
  ok('the oldest entries are the ones gone',
     !(await tileCache.match('https://mesonet.agron.iastate.edu/fake/0')), 'oldest survived');

  console.log();
  console.log(fail ? `${fail} FAILED, ${pass} passed` : `all ${pass} passed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
