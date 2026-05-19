// GWCFCRadar Service Worker — tile cache for instant loads
// Bump CACHE version to force-clear old cached tiles.
const CACHE = 'gwcfc-v3';

// All tile / data hosts we intercept and cache
const CACHE_HOSTS = new Set([
  'api.maptiler.com',           // base map tiles — never change
  'mesonet.agron.iastate.edu',  // NEXRAD + GOES WMS tiles
  'tilecache.rainviewer.com',   // RainViewer satellite tiles
  'api.rainviewer.com',         // RainViewer frame index
  'opengeo.ncep.noaa.gov',      // NOAA Level III WMS tiles
]);

// How long each host's responses stay fresh
const TTL_MS = {
  'api.maptiler.com':          7 * 24 * 3600 * 1000,  // 7 days  — static raster tiles
  'tilecache.rainviewer.com':  5 * 60 * 1000,          // 5 min   — satellite tiles
  'api.rainviewer.com':        5 * 60 * 1000,          // 5 min   — frame index JSON
  'mesonet.agron.iastate.edu': 10 * 60 * 1000,         // 10 min  — radar/GOES WMS tiles
  'opengeo.ncep.noaa.gov':     10 * 60 * 1000,         // 10 min  — NOAA Level III tiles
};

self.addEventListener('install',  ()  => self.skipWaiting());
self.addEventListener('activate', e   => e.waitUntil(clients.claim()));

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  let url;
  try { url = new URL(e.request.url); } catch { return; }

  if (CACHE_HOSTS.has(url.hostname)) {
    e.respondWith(cacheFirst(e.request, TTL_MS[url.hostname] ?? 10 * 60 * 1000));
    return;
  }
  // Cache same-origin data files
  if (url.pathname.endsWith('windy-webcams.json')) {
    e.respondWith(cacheFirst(e.request, 2 * 3600 * 1000)); // 2 h — matches workflow schedule
  }
});

async function cacheFirst(req, ttl) {
  const cache = await caches.open(CACHE);
  const hit   = await cache.match(req);

  if (hit) {
    const age = Date.now() - +(hit.headers.get('x-sw-ts') ?? 0);
    if (age < ttl) return hit;   // fresh — serve instantly from cache
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
    // Network failed — serve stale cache if available, else 503
    return hit ?? new Response('', { status: 503 });
  }
}
