// GWCFCRadar -- NEXRAD Level-2 Proxy Worker
// Source: UCAR THREDDS Data Server (public, no credentials needed)
// Paste into Cloudflare Workers editor, Save and Deploy.
// Test: https://YOUR-WORKER.workers.dev?station=KLTX
// Returns: raw Level-2 binary (application/octet-stream) for client-side parsing

var THREDDS = 'https://thredds.ucar.edu/thredds';

addEventListener('fetch', function(event) {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  try {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    var url     = new URL(request.url);
    var station = (url.searchParams.get('station') || '').toUpperCase().trim();

    if (!station) return jsonErr('station param required', 400);
    if (!/^[A-Z]{4}$/.test(station)) return jsonErr('station must be 4 letters e.g. KLTX', 400);

    var result = await fetchLatestL2(station);
    if (!result) {
      return jsonErr('No Level-2 data found for ' + station + '. Station may be offline or data is delayed.', 502);
    }

    var h = corsHeaders();
    h['Content-Type']  = 'application/octet-stream';
    h['Cache-Control'] = 'public, max-age=90';
    h['X-Radar-File']  = result.name;
    return new Response(result.body, { headers: h });

  } catch (e) {
    return jsonErr('Internal error: ' + e.message, 500);
  }
}

async function fetchLatestL2(station) {
  for (var dayOff = 0; dayOff <= 1; dayOff++) {
    var d    = new Date(Date.now() - dayOff * 86400000);
    var yyyy = String(d.getUTCFullYear());
    var mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
    var dd   = String(d.getUTCDate()).padStart(2, '0');
    var yyyymmdd = yyyy + mm + dd;

    try {
      // UCAR provides a "latest" resolver catalog -- resolve it to get the actual filename
      var latestCatUrl = THREDDS + '/catalog/nexrad/level2/' + station + '/' + yyyymmdd + '/latest.xml';
      var latestRes = await fetch(latestCatUrl);
      if (!latestRes.ok) continue;
      var latestXml = await latestRes.text();

      // The resolved catalog contains urlPath="NWS/NEXRAD2/KXXX/YYYYMMDD/filename.ar2v"
      var m = /urlPath="([^"]+\.ar2v)"/.exec(latestXml);
      if (!m) continue;
      var urlPath = m[1];

      // Extract just the filename from the full path
      var filename = urlPath.split('/').pop();

      var fileUrl = THREDDS + '/fileServer/nexrad/level2/' + station + '/' + yyyymmdd + '/' + filename;
      var fileRes = await fetch(fileUrl);
      if (!fileRes.ok) continue;

      return { body: fileRes.body, name: filename };
    } catch (err) { continue; }
  }
  return null;
}

function corsHeaders() {
  var h = {};
  h['Access-Control-Allow-Origin']  = '*';
  h['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
  h['Access-Control-Allow-Headers'] = 'Content-Type';
  return h;
}

function jsonErr(msg, status) {
  var h = corsHeaders();
  h['Content-Type'] = 'application/json';
  return new Response(JSON.stringify({ error: msg }), { status: status, headers: h });
}
