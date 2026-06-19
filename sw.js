// GWCFCRadar Service Worker — radar tile cache + background alert notifications
const CACHE       = 'gwcfc-v10';
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

// ── Home location + GPS coords (sent from page via postMessage) ──
let _swLocation = null;
let _swCoords   = null; // { lat, lon } for rain detection
let _swRainWas  = false;

// ── Lifecycle ────────────────────────────────────────────────
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => e.waitUntil(
  caches.keys()
    .then(keys => Promise.all(
      keys.filter(k => k !== CACHE && k !== NOTIF_CACHE).map(k => caches.delete(k))
    ))
    .then(() => clients.claim())
));

// ── Message from page: receive home location + GPS coords ────
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SET_LOCATION') {
    _swLocation = e.data.location || null;
    if (e.data.coords) _swCoords = e.data.coords;
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

// ── Severity maps (mirrored from page JS) ────────────────────
const _SW_NWS_SEV_RANK = { Extreme:4, Severe:3, Moderate:2, Minor:1, Unknown:0 };
const _SW_EAS_TYPE_SEV = {
  TOR:4, SVR:3, EWW:3, FFW:3, SMW:2, TOA:3, SVA:2, FFA:2,
  WSW:2, BZW:3, ISW:2, HWW:2, CFW:1, MWS:1, RWT:0, RWS:0,
};
const _SW_EAS_TYPE_LABELS = {
  TOR:'Tornado Warning', SVR:'Severe Thunderstorm Warning',
  EWW:'Extreme Wind Warning', FFW:'Flash Flood Warning',
  TOA:'Tornado Watch', SVA:'Severe Thunderstorm Watch',
  FFA:'Flash Flood Watch', SMW:'Special Marine Warning',
  BZW:'Blizzard Warning', WSW:'Winter Storm Warning',
};

// ── Background alert check (both NWS + EAS + Rain) ───────────
async function _checkAndNotify() {
  const loc = _swLocation;
  const terms = loc
    ? [loc.county, loc.city, loc.state].filter(Boolean).map(s => s.toLowerCase().trim())
    : [];
  const locationSet = terms.length > 0;
  const seenCache = await caches.open(NOTIF_CACHE);
  const now = Date.now();

  async function _isSeen(id) {
    const hit = await seenCache.match(new Request(id));
    return !!hit;
  }
  async function _markSeen(id) {
    await seenCache.put(new Request(id), new Response('1', {
      headers: { 'x-ts': String(now) }
    }));
  }

  async function _fire(id, title, body, sevRank) {
    if (await _isSeen(id)) return;
    await _markSeen(id);
    const isUrgent = sevRank >= 3;
    await self.registration.showNotification(title, {
      body,
      icon:    './icons/icon-192.png',
      badge:   './icons/icon-192.png',
      tag:     id,
      vibrate: isUrgent ? [300, 100, 300, 100, 300] : [150],
      requireInteraction: isUrgent,
      data:    { url: self.location.origin + '/GWCFCRadar/' },
    });
  }

  // ── NWS Weather Alerts ──
  try {
    const nwsUrl = locationSet
      ? 'https://api.weather.gov/alerts/active?status=actual&message_type=alert'
      : 'https://api.weather.gov/alerts/active?status=actual&message_type=alert&severity=Extreme,Severe';
    const nr = await fetch(nwsUrl, { signal: AbortSignal.timeout(10000) });
    if (nr.ok) {
      const nwsData = await nr.json();
      const ranked = (nwsData.features || [])
        .map(f => ({
          f,
          sev: _SW_NWS_SEV_RANK[f.properties.severity] ?? 0,
          matches: locationSet
            ? terms.some(t => (f.properties.areaDesc || '').toLowerCase().includes(t))
            : true,
        }))
        .filter(x => x.matches)
        .sort((a, b) => b.sev - a.sev);

      let nwsFired = 0;
      for (const { f, sev } of ranked) {
        if (nwsFired >= 5) break;
        const id   = f.properties.id || f.id;
        if (!id) continue;
        const ev   = f.properties.event     || 'Weather Alert';
        const area = (f.properties.areaDesc || '').slice(0, 90);
        const onset = f.properties.onset ? new Date(f.properties.onset).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}) : '';
        const ends  = (f.properties.ends || f.properties.expires)
          ? new Date(f.properties.ends||f.properties.expires).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}) : '';
        const emoji = sev>=4?'🚨':sev>=3?'⚡':sev>=2?'⚠️':'📢';
        const body  = [area, onset?`Onset: ${onset}`:'', ends?`Until: ${ends}`:''].filter(Boolean).join(' · ');
        await _fire('nws:' + id, `${emoji} ${ev}`, body, sev);
        nwsFired++;
      }
    }
  } catch(e) { /* NWS fetch failed */ }

  // ── EAS Alerts ──
  const EAS_PROXIES_SW = [
    u => u,
    u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    u => `https://api.codetabs.com/v1/proxy?quest=${u}`,
  ];
  let easAlerts = [];
  for (const proxy of EAS_PROXIES_SW) {
    try {
      const er = await fetch(proxy('https://alerts.globaleas.org/api/v1/alerts/active'), {
        signal: AbortSignal.timeout(8000)
      });
      if (!er.ok) continue;
      const raw = await er.json();
      easAlerts = Array.isArray(raw) ? raw : (raw.alerts || raw.data || raw.results || []);
      break;
    } catch { continue; }
  }

  if (easAlerts.length) {
    const ranked = easAlerts
      .map(a => {
        const tc  = (a.type || '').toUpperCase();
        const sev = _SW_EAS_TYPE_SEV[tc] ?? 1;
        const text = [a.translation||'', (a.fipsCodes||[]).join(' '), a.originator||'', a.callsign||'']
          .join(' ').toLowerCase();
        return { a, sev, tc, matches: locationSet ? terms.some(t => text.includes(t)) : sev >= 3 };
      })
      .filter(x => x.matches)
      .sort((a, b) => b.sev - a.sev);

    let easFired = 0;
    for (const { a, sev, tc } of ranked) {
      if (easFired >= 3) break;
      const id    = String(a.id || a.hash || '');
      if (!id) continue;
      const label = _SW_EAS_TYPE_LABELS[tc] || tc;
      const orig  = a.originator ? ` · ${a.originator.toUpperCase()}` : '';
      const call  = a.callsign   ? ` (${a.callsign})`                 : '';
      const trans = (a.translation || '').replace(/\s+/g,' ').trim().slice(0, 100);
      const emoji = sev>=4?'🚨':sev>=3?'⚡':'📻';
      await _fire('eas:' + id, `${emoji} EAS: ${label}${orig}${call}`, trans, sev);
      easFired++;
    }
  }

  // ── Rain Near Me (background GPS-based check) ──
  if (_swCoords) {
    try {
      const { lat, lon } = _swCoords;
      const rr = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        `&current=precipitation,rain,showers,snowfall&timezone=auto`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (rr.ok) {
        const rd = await rr.json();
        const cur = rd.current || {};
        const precip = (cur.precipitation || 0) + (cur.rain || 0) + (cur.showers || 0);
        const snow   = cur.snowfall || 0;
        const isAny  = precip > 0.05 || snow > 0.05;
        if (isAny && !_swRainWas) {
          _swRainWas = true;
          const type  = snow > 0.05 ? 'Snow' : precip >= 2.5 ? 'Heavy Rain' : precip >= 0.5 ? 'Rain' : 'Light Rain';
          const emoji = snow > 0.05 ? '❄️' : precip >= 2.5 ? '⛈️' : '🌧️';
          const amt   = snow > 0.05 ? `${snow.toFixed(1)} mm/h snow` : `${precip.toFixed(1)} mm/h`;
          await self.registration.showNotification(`${emoji} ${type} Near You`, {
            body:    `${amt} detected at your location`,
            icon:    './icons/icon-192.png',
            badge:   './icons/icon-192.png',
            tag:     'rain-near-me',
            vibrate: [150],
            data:    { url: self.location.origin + '/GWCFCRadar/' },
          });
        } else if (!isAny) {
          _swRainWas = false;
        }
      }
    } catch(e) { /* rain check failed silently */ }
  }

  // Prune seen cache entries older than 24 h
  try {
    const keys = await seenCache.keys();
    for (const key of keys) {
      const resp = await seenCache.match(key);
      if (resp) {
        const ts = +(resp.headers.get('x-ts') ?? 0);
        if (now - ts > 24 * 3600 * 1000) seenCache.delete(key);
      }
    }
  } catch {}
}
