// GWCFCRadar Service Worker — radar tile cache for instant loads
const CACHE = 'gwcfc-v7';

// IEM L3 tile cache — immutable per timestamp key
const IEM_L3_RE = /\/cache\/tile\.py\/1\.0\.0\/nexrad-n0q-\d{12}\//;
// RainViewer radar tiles — immutable per unix timestamp in path (/v2/radar/{ts}/)
const RV_TILE_RE = /\/v2\/radar\/\d+\//;
// NASA GIBS WMS tiles with explicit TIME — immutable per timestamp
const GIBS_TIME_RE = /\/wms\/epsg3857\/best\/wms\.cgi.*[?&]TIME=/;

const CACHE_HOSTS = new Set([
  'api.maptiler.com',             // basemap tiles — static forever
  'mesonet.agron.iastate.edu',    // IEM NEXRAD L3 tile cache + WMS fallback
  'tilecache.rainviewer.com',     // RainViewer radar tiles
  'api.rainviewer.com',           // RainViewer frame index JSON
  'opengeo.ncep.noaa.gov',        // NOAA single-site REF WMS
  'gibs.earthdata.nasa.gov',      // NASA GIBS satellite tiles (Himawari via WMS)
]);

const TTL_MS = {
  'api.maptiler.com':           7 * 24 * 3600 * 1000,  // 7 days  — static tiles
  'tilecache.rainviewer.com':   5 * 60 * 1000,          // default 5 min; overridden below for radar tiles
  'api.rainviewer.com':         2 * 60 * 1000,          // 2 min   — frame index (check for new frames)
  'mesonet.agron.iastate.edu':  2 * 3600 * 1000,        // 2 hr    — WMS fallback
  'opengeo.ncep.noaa.gov':      2 * 3600 * 1000,        // 2 hr    — single-site REF
  'gibs.earthdata.nasa.gov':    2 * 3600 * 1000,        // 2 hr    — satellite WMS tiles
};

self.addEventListener('install', () => self.skipWaiting());

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
    let ttl;
    if (url.hostname === 'mesonet.agron.iastate.edu' && IEM_L3_RE.test(url.pathname)) {
      ttl = 24 * 3600 * 1000; // IEM L3 radar tiles: immutable per timestamp → 24 hr
    } else if (url.hostname === 'tilecache.rainviewer.com' && RV_TILE_RE.test(url.pathname)) {
      ttl = 24 * 3600 * 1000; // RainViewer radar tiles: immutable per timestamp → 24 hr
    } else if (url.hostname === 'gibs.earthdata.nasa.gov' && GIBS_TIME_RE.test(e.request.url)) {
      ttl = 24 * 3600 * 1000; // GIBS satellite WMS with explicit TIME: immutable → 24 hr
    } else {
      ttl = TTL_MS[url.hostname] ?? 10 * 60 * 1000;
    }
    e.respondWith(cacheFirst(e.request, ttl));
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
    // Network failed — serve stale cache so radar never goes blank
    return hit ?? new Response('', { status: 503 });
  }
}
