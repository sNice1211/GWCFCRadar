// GWCFCRadar -- NEXRAD Level-2 Proxy Worker (first-elevation truncation)
// Fetches the latest Level-2 file from UCAR THREDDS but only streams the
// first ~5 MB, then trims to the last COMPLETE bzip2 block boundary so the
// client receives a valid (not corrupt) subset containing the lowest
// elevation cut.  This cuts client-side decompression from 20 MB down to
// ~3 MB, preventing crashes on low-memory devices.
// Paste into Cloudflare Workers editor, Save and Deploy.

var THREDDS = 'https://thredds.ucar.edu/thredds';
var FILE_HEADER_SIZE = 24;
var STREAM_LIMIT = 5 * 1024 * 1024;

addEventListener('fetch', function(event) {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  try {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    var url = new URL(request.url);
    var station = (url.searchParams.get('station') || '').toUpperCase().trim();

    if (!station) return jsonErr('station param required', 400);
    if (!/^[A-Z]{4}$/.test(station)) return jsonErr('station must be 4 letters e.g. KLTX', 400);

    var result = await fetchTruncatedL2(station);
    if (!result) {
      return jsonErr('No Level-2 data found for ' + station + '. Station may be offline or data is delayed.', 502);
    }

    var h = corsHeaders();
    h['Content-Type'] = 'application/octet-stream';
    h['Cache-Control'] = 'public, max-age=90';
    h['X-Radar-File'] = result.name;
    return new Response(result.data, { headers: h });

  } catch (e) {
    return jsonErr('Internal error: ' + e.message, 500);
  }
}

async function fetchTruncatedL2(station) {
  for (var dayOff = 0; dayOff <= 1; dayOff++) {
    var d = new Date(Date.now() - dayOff * 86400000);
    var yyyy = String(d.getUTCFullYear());
    var mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    var dd = String(d.getUTCDate()).padStart(2, '0');
    var yyyymmdd = yyyy + mm + dd;

    try {
      var latestCatUrl = THREDDS + '/catalog/nexrad/level2/' + station + '/' + yyyymmdd + '/latest.xml';
      var latestRes = await fetch(latestCatUrl);
      if (!latestRes.ok) continue;
      var latestXml = await latestRes.text();

      var m = /urlPath="([^"]+\.ar2v)"/.exec(latestXml);
      if (!m) continue;
      var filename = m[1].split('/').pop();

      var fileUrl = THREDDS + '/fileServer/nexrad/level2/' + station + '/' + yyyymmdd + '/' + filename;
      var truncated = await streamAndTruncate(fileUrl);
      if (!truncated) continue;

      return { data: truncated, name: filename };
    } catch (err) { continue; }
  }
  return null;
}

async function streamAndTruncate(url) {
  var res = await fetch(url);
  if (!res.ok) return null;

  var reader = res.body.getReader();
  var chunks = [];
  var totalBytes = 0;

  try {
    while (totalBytes < STREAM_LIMIT) {
      var chunk = await reader.read();
      if (chunk.done) break;
      chunks.push(chunk.value);
      totalBytes += chunk.value.length;
    }
  } finally {
    reader.cancel().catch(function() {});
  }

  if (totalBytes === 0) return null;

  // Assemble chunks into one Uint8Array
  var combined = new Uint8Array(totalBytes);
  var offset = 0;
  for (var i = 0; i < chunks.length; i++) {
    combined.set(chunks[i], offset);
    offset += chunks[i].length;
  }

  // Walk the bzip2 block structure to find the last COMPLETE block.
  // NEXRAD Level-2 layout after the 24-byte file header:
  //   [int32 big-endian compressed_size][that many bytes of bzip2 data] ...
  // Negative size means "last block" in the original file.
  var view = new DataView(combined.buffer);
  var pos = FILE_HEADER_SIZE;
  var lastGoodPos = pos;

  while (pos + 4 <= combined.length) {
    var sizeRaw = view.getInt32(pos, false); // big-endian
    var size = Math.abs(sizeRaw);
    if (size === 0) break;
    if (pos + 4 + size > combined.length) break; // block cut off -- stop before it
    pos += 4 + size;
    lastGoodPos = pos;
    if (sizeRaw < 0) break; // was marked last block in original file
  }

  if (lastGoodPos <= FILE_HEADER_SIZE) return null;

  return combined.slice(0, lastGoodPos).buffer;
}

function corsHeaders() {
  var h = {};
  h['Access-Control-Allow-Origin'] = '*';
  h['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
  h['Access-Control-Allow-Headers'] = 'Content-Type';
  return h;
}

function jsonErr(msg, status) {
  var h = corsHeaders();
  h['Content-Type'] = 'application/json';
  return new Response(JSON.stringify({ error: msg }), { status: status, headers: h });
}
