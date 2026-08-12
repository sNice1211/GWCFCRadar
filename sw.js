// GWCFCRadar Service Worker - radar tile cache + background alert notifications
const CACHE       = 'gwcfc-v14';
const NOTIF_CACHE = 'gwcfc-notif-seen-v1'; // tracks alert IDs already notified

// ── Radar tile caches ────────────────────────────────────────
const IEM_L3_RE = /\/cache\/tile\.py\/1\.0\.0\/nexrad-n0q-\d{12}\//;
const RV_TILE_RE = /\/v2\/radar\/\d+\//;

// Severity to badge art, mirroring the page's _severityBadge(). The large icon
// slot (right) carries severity; the small badge slot (left) carries the logo.
// Both halves must agree with index.html, or a notification would look
// different depending on which path happened to fire it.
function _severityBadge(severity) {
  const s = Number(severity) || 0;
  if (s >= 4) return './icons/badge-extreme.png';
  if (s >= 3) return './icons/badge-severe.png';
  if (s >= 2) return './icons/badge-moderate.png';
  return './icons/badge-info.png';
}

// Notification titles are plain text. The page strips markup before calling
// showNotification, but strip here too so a stale cached page cannot put raw
// markup in front of the user.
function _plainText(v) {
  return String(v == null ? '' : v).replace(/<[^>]*>/g, '').replace(/\s{2,}/g, ' ').trim();
}

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
let _swCoords   = null;   // { lat, lon } for rain detection
let _swTileKey  = null;   // current IEM radar tileKey (e.g. "202406191800")
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
    if (e.data.coords)   _swCoords   = e.data.coords;
    if (e.data.tileKey)  _swTileKey  = e.data.tileKey;
  }
});

// ── Periodic background sync (Chrome Android) ────────────────
self.addEventListener('periodicsync', e => {
  if (e.tag === 'check-alerts') e.waitUntil(_checkAndNotify());
});

// ── Push event (FCM - fires even when browser is closed) ─────
self.addEventListener('push', e => {
  let payload = {};
  try { payload = e.data ? e.data.json() : {}; } catch {}
  const title = payload.title || '⚡ Weather Alert';
  const body  = payload.body  || '';
  const url   = payload.url   || self.location.origin + '/GWCFCRadar/';
  e.waitUntil(
    self.registration.showNotification(_plainText(title), {
      body: _plainText(body),
      icon:    _severityBadge(payload.severe ? 3 : 1),
      badge:   './icons/badge-logo.png',
      tag:     payload.id || 'gwcfc-alert',
      vibrate: payload.severe ? [200, 100, 200] : [100],
      data:    { url },
    })
  );
});

// ── Notification tap: focus or open app ─────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data    = e.notification.data || {};
  const url     = data.url || self.location.origin;
  const alertId = data.alertId || null;
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const match = list.find(c => c.url.startsWith(self.location.origin));
      if (match) {
        // Focusing alone left the user staring at wherever they already were.
        // Tell the open tab which alert to fly to; the id travels by message
        // because navigating an existing tab would throw away its state.
        if (alertId) { try { match.postMessage({ type: 'FOCUS_ALERT', alertId }); } catch(e) {} }
        return match.focus();
      }
      // Nothing open, so the id has to ride in on the URL instead.
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
    await self.registration.showNotification(_plainText(title), {
      body: _plainText(body),
      icon:    _severityBadge(sevRank),
      badge:   './icons/badge-logo.png',
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

  // ── Rain Near Me - read the IEM radar tile already in the SW cache ──
  if (_swCoords && _swTileKey) {
    try {
      const { lat, lon } = _swCoords;
      const Z   = 7;
      const n   = 1 << Z;
      const xF  = (lon + 180) / 360 * n;
      const latR = lat * Math.PI / 180;
      const yF  = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n;
      const tx  = Math.floor(xF), ty = Math.floor(yF);
      const px  = Math.floor((xF - tx) * 256);
      const py  = Math.floor((yF - ty) * 256);

      const tileUrl = `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-${_swTileKey}/${Z}/${tx}/${ty}.png`;

      // Try the SW cache first - this tile was already downloaded by the map
      const radarCache = await caches.open(CACHE);
      let resp = await radarCache.match(tileUrl);
      if (!resp) resp = await fetch(tileUrl, { signal: AbortSignal.timeout(8000) });
      if (!resp || !resp.ok) { _swRainWas = false; return; }

      const blob = await resp.blob();
      const bmp  = await createImageBitmap(blob);
      const oc   = new OffscreenCanvas(256, 256);
      const octx = oc.getContext('2d');
      octx.drawImage(bmp, 0, 0);
      const R  = 20;
      const x0 = Math.max(0, px - R), x1 = Math.min(255, px + R);
      const y0 = Math.max(0, py - R), y1 = Math.min(255, py + R);
      const pxData = octx.getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1).data;

      let maxAlpha = 0, bestR = 0, bestG = 0, bestB = 0;
      for (let i = 0; i < pxData.length; i += 4) {
        if (pxData[i + 3] > maxAlpha) {
          maxAlpha = pxData[i + 3];
          bestR = pxData[i]; bestG = pxData[i + 1]; bestB = pxData[i + 2];
        }
      }

      const isRaining = maxAlpha > 20;
      if (isRaining && !_swRainWas) {
        _swRainWas = true;
        let emoji = '🌧️', label = 'Rain';
        if (bestR > 180 && bestG < 80)       { emoji = '⛈️'; label = 'Heavy Rain'; }
        else if (bestR < 100 && bestB > 150) { emoji = '❄️'; label = 'Snow/Sleet'; }
        else if (bestG > 150 && bestR < 120) { emoji = '🌦️'; label = 'Light Rain'; }
        await self.registration.showNotification(`${emoji} ${label} Near You`, {
          body:    'Radar shows precipitation within ~25 miles of your location',
          icon:    _severityBadge(2),
          badge:   './icons/badge-logo.png',
          tag:     'rain-near-me',
          vibrate: [150],
          data:    { url: self.location.origin + '/GWCFCRadar/' },
        });
      } else if (!isRaining) {
        _swRainWas = false;
      }
    } catch(e) { /* silent */ }
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
