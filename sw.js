// GWCFCRadar Service Worker — L3 tile cache optimized for instant radar loads
// Bump CACHE version to force-clear all old cached tiles on next visit.
const CACHE = 'gwcfc-v5';

// IEM L3 tile cache URL pattern — tiles are immutable per timestamp key
// /cache/tile.py/1.0.0/nexrad-n0q-YYYYMMDDHHMM/z/x/y.png
const IEM_L3_RE = /\/cache\/tile\.py\/1\.0\.0\/nexrad-n0q-\d{12}\//;

// All tile / data hosts we intercept and cache
const CACHE_HOSTS = new Set([
  'api.maptiler.com',           // basemap tiles — static forever
  'mesonet.agron.iastate.edu',  // IEM NEXRAD L3 tile cache + WMS fallback
  'tilecache.rainviewer.com',   // RainViewer satellite tiles
  'api.rainviewer.com',         // RainViewer frame index JSON
  'opengeo.ncep.noaa.gov',      // NOAA single-site REF WMS
]);

const TTL_MS = {
  'api.maptiler.com':          7 * 24 * 3600 * 1000,  // 7 days  — static tiles
  'tilecache.rainviewer.com':  5 * 60 * 1000,          // 5 min   — satellite
  'api.rainviewer.com':        5 * 60 * 1000,          // 5 min   — frame index
  'mesonet.agron.iastate.edu': 2 * 3600 * 1000,        // 2 hr    — WMS fallback
  'opengeo.ncep.noaa.gov':     2 * 3600 * 1000,        // 2 hr    — single-site REF
};

self.addEventListener('install', () => self.skipWaiting());

// On activate: delete every old cache version, then take control immediately
self.addEventListener('activate', e => e.waitUntil(
  caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => clients.claim())
));

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  let url;
  try { url = new URL(e.request.url); } catch { return; }

  if (CACHE_HOSTS.has(url.hostname)) {
    // IEM L3 tile cache tiles are immutable per timestamp key — cache 24 hr
    const ttl = (url.hostname === 'mesonet.agron.iastate.edu' && IEM_L3_RE.test(url.pathname))
      ? 24 * 3600 * 1000
      : (TTL_MS[url.hostname] ?? 10 * 60 * 1000);
    e.respondWith(cacheFirst(e.request, ttl));
    return;
  }

  // Same-origin data files
  if (url.pathname.endsWith('windy-webcams.json')) {
    e.respondWith(cacheFirst(e.request, 2 * 3600 * 1000));
  }
});

async function cacheFirst(req, ttl) {
  const cache = await caches.open(CACHE);
  const hit   = await cache.match(req);

  if (hit) {
    const age = Date.now() - +(hit.headers.get('x-sw-ts') ?? 0);
    if (age < ttl) return hit;  // fresh — serve instantly, zero network
  }

  try {
    const res = await fetch(req);
    if (res.ok) {
      const buf  = await res.arrayBuffer();
      const hdrs = new Headers(res.headers);
      hdrs.set('x-sw-ts', String(Date.now()));
      const stored = new Response(buf, { status: res.status, headers: hdrs });
      cache.put(req, stored.clone());
      return stored;
    }
    return res;
  } catch {
    // Network failed — always serve stale cache so radar never goes blank
    return hit ?? new Response('', { status: 503 });
  }
}
