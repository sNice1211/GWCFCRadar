// GWCFCRadar Service Worker — radar tile cache + background alert notifications
const CACHE       = 'gwcfc-v9';
const NOTIF_CACHE = 'gwcfc-notif-seen-v1'; // tracks alert IDs already notified

// ── Radar tile caches ────────────────────────────────────────
const IEM_L3_RE = /\/cache\/tile\.py\/1\.0\.0\/nexrad-n0q-\d{12}\//;
const RV_TILE_RE = /\/v2\/radar\/\d+\//;

const CACHE_HOSTS = new Set([
  'api.maptiler.com',
  'mesonet.agron.iastate.edu',
  'tilecache.rainviewer.com',
  'api.rainviewer.com',
  'opengeo.ncep.noaa.gov',
]);

const TTL_MS = {
  'api.maptiler.com':          7 * 24 * 3600 * 1000,
  'tilecache.rainviewer.com':  5 * 60 * 1000,
  'api.rainviewer.com':        2 * 60 * 1000,
  'mesonet.agron.iastate.edu': 2 * 3600 * 1000,
  'opengeo.ncep.noaa.gov':     2 * 3600 * 1000,
};

// ── Home location (sent from page via postMessage) ───────────
let _swLocation = null;

// ── Lifecycle ────────────────────────────────────────────────
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => e.waitUntil(
  caches.keys()
    .then(keys => Promise.all(
      keys.filter(k => k !== CACHE && k !== NOTIF_CACHE).map(k => caches.delete(k))
    ))
    .then(() => clients.claim())
));

// ── Message from page: receive home location ─────────────────
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SET_LOCATION') {
    _swLocation = e.data.location || null;
  }
});

// ── Periodic background sync (Chrome Android) ────────────────
self.addEventListener('periodicsync', e => {
  if (e.tag === 'check-alerts') e.waitUntil(_checkAndNotify());
});

// ── Push event (FCM — fires even when browser is closed) ─────
self.addEventListener('push', e => {
  let payload = {};
  try { payload = e.data ? e.data.json() : {}; } catch {}
  const title = payload.title || '⚡ Weather Alert';
  const body  = payload.body  || '';
  const url   = payload.url   || self.location.origin + '/GWCFCRadar/';
  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon:    './icons/icon-192.png',
      badge:   './icons/icon-192.png',
      tag:     payload.id || 'gwcfc-alert',
      vibrate: payload.severe ? [200, 100, 200] : [100],
      data:    { url },
    })
  );
});

// ── Notification tap: focus or open app ─────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.location.origin;
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const match = list.find(c => c.url.startsWith(self.location.origin));
      if (match) return match.focus();
      return clients.openWindow(url);
    })
  );
});

// ── Fetch: radar tile cache-first ───────────────────────────
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  let url;
  try { url = new URL(e.request.url); } catch { return; }
  if (!CACHE_HOSTS.has(url.hostname)) return;

  let ttl;
  if (url.hostname === 'mesonet.agron.iastate.edu' && IEM_L3_RE.test(url.pathname)) {
    ttl = 24 * 3600 * 1000;
  } else if (url.hostname === 'tilecache.rainviewer.com' && RV_TILE_RE.test(url.pathname)) {
    ttl = 24 * 3600 * 1000;
  } else {
    ttl = TTL_MS[url.hostname] ?? 10 * 60 * 1000;
  }
  e.respondWith(cacheFirst(e.request, ttl));
});

async function cacheFirst(req, ttl) {
  const cache = await caches.open(CACHE);
  const hit   = await cache.match(req);
  if (hit) {
    const age = Date.now() - +(hit.headers.get('x-sw-ts') ?? 0);
    if (age < ttl) return hit;
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
    return hit ?? new Response('', { status: 503 });
  }
}

// ── Background alert check ───────────────────────────────────
async function _checkAndNotify() {
  const loc = _swLocation;
  if (!loc) return;
  const terms = [loc.county, loc.city, loc.state]
    .filter(Boolean).map(s => s.toLowerCase().trim());
  if (!terms.length) return;

  let features = [];
  try {
    const r = await fetch(
      'https://api.weather.gov/alerts/active?status=actual&message_type=alert',
      { signal: AbortSignal.timeout(10000) }
    );
    if (!r.ok) return;
    const data = await r.json();
    features = data.features || [];
  } catch { return; }

  const matches = features.filter(f => {
    const desc = (f.properties.areaDesc || '').toLowerCase();
    return terms.some(t => desc.includes(t));
  });

  const seenCache = await caches.open(NOTIF_CACHE);
  const now = Date.now();

  for (const f of matches) {
    const id = f.properties.id || f.id || String(now);
    if (!id) continue;

    // Skip if already notified
    const seen = await seenCache.match(new Request(id));
    if (seen) continue;

    // Record as seen (keep for 24 h)
    seenCache.put(new Request(id), new Response('1', {
      headers: { 'x-ts': String(now) }
    }));

    const ev   = f.properties.event    || 'Weather Alert';
    const area = (f.properties.areaDesc || '').slice(0, 100);
    const sev  = f.properties.severity || '';

    await self.registration.showNotification(`⚡ ${ev}`, {
      body:    area,
      icon:    './icons/icon-192.png',
      badge:   './icons/icon-192.png',
      tag:     id,
      vibrate: (sev === 'Extreme' || sev === 'Severe') ? [200, 100, 200] : [100],
      data:    { url: self.location.origin + '/GWCFCRadar/' },
    });
  }

  // Prune seen cache entries older than 24 h
  const keys = await seenCache.keys();
  for (const key of keys) {
    const resp = await seenCache.match(key);
    if (resp) {
      const ts = +(resp.headers.get('x-ts') ?? 0);
      if (now - ts > 24 * 3600 * 1000) seenCache.delete(key);
    }
  }
}
