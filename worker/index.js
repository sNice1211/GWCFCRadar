// GWCFCRadar -- NEXRAD Level-3 Proxy Worker
// Data source: UCAR THREDDS (nexrad/level3) -- freely accessible from Cloudflare Workers
// Paste into Cloudflare Workers editor, Save and Deploy.
// Test: https://YOUR-WORKER.workers.dev/radar?station=KLTX&product=cc&debug

var PRODUCT_META = {
  cc:  { s3: 'N0C', min: 0.2,  max: 1.05, name: 'Corr. Coeff.' },
  zdr: { s3: 'N0X', min: -8.0, max: 8.0,  name: 'Diff. Refl.'  }
};

// UCAR THREDDS base URL for NEXRAD Level-3
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
    var product = (url.searchParams.get('product') || 'cc').toLowerCase().trim();
    var debug   = url.searchParams.has('debug');

    if (!station) return jsonErr('station param required', 400);
    if (!/^[A-Z]{4}$/.test(station)) return jsonErr('station must be 4 letters e.g. KLTX', 400);

    var meta = PRODUCT_META[product];
    if (!meta) return jsonErr('unknown product ' + product + ' -- use cc or zdr', 400);

    // Fetch latest file from UCAR THREDDS catalog
    var result = await fetchLatestThredds(station, meta.s3);
    if (!result) {
      return jsonErr('No Level-3 data found for ' + station + ' ' + product.toUpperCase()
                     + '. Station may not support dual-pol or data is delayed.', 502);
    }

    var parsed;
    try {
      parsed = parseL3(new Uint8Array(result.buf), meta);
    } catch (e2) {
      var raw = new Uint8Array(result.buf).slice(0, 160);
      var hexArr = [];
      for (var b = 0; b < raw.length; b++) hexArr.push(raw[b].toString(16).padStart(2, '0'));
      return jsonErr('Parse error: ' + e2.message + ' | url: ' + result.url
                     + ' | hex: ' + hexArr.join(' '), 500);
    }

    if (debug) parsed._debug = { url: result.url, rawBytes: result.buf.byteLength };

    var h = corsHeaders();
    h['Content-Type']  = 'application/json';
    h['Cache-Control'] = 'public, max-age=90';
    return new Response(JSON.stringify(parsed), { headers: h });

  } catch (e3) {
    return jsonErr('Internal error: ' + e3.message, 500);
  }
}

// Fetch the most recent Level-3 file from UCAR THREDDS
// Tries today then yesterday (UTC) in case today's data isn't up yet
async function fetchLatestThredds(station, s3Product) {
  for (var dayOff = 0; dayOff <= 1; dayOff++) {
    var d    = new Date(Date.now() - dayOff * 86400000);
    var yyyy = String(d.getUTCFullYear());
    var mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
    var dd   = String(d.getUTCDate()).padStart(2, '0');

    var catalogUrl = THREDDS + '/catalog/nexrad/level3/' + s3Product
                   + '/' + station + '/' + yyyy + '/' + mm + '/' + dd + '/catalog.xml';

    try {
      var catRes = await fetch(catalogUrl, { headers: { 'Accept': '*/*' } });
      if (!catRes.ok) continue;
      var xml = await catRes.text();

      // Pull all dataset names from catalog XML
      var names = [];
      var re = /name="([^"]+)"/g;
      var m;
      while ((m = re.exec(xml)) !== null) {
        if (m[1].indexOf(station) === 0) names.push(m[1]);
      }
      if (names.length === 0) continue;

      // Sort alphabetically -- filenames end with timestamp so last = newest
      names.sort();
      var latest = names[names.length - 1];

      var fileUrl = THREDDS + '/fileServer/nexrad/level3/' + s3Product
                  + '/' + station + '/' + yyyy + '/' + mm + '/' + dd + '/' + latest;

      var fileRes = await fetch(fileUrl);
      if (!fileRes.ok) continue;

      return { buf: await fileRes.arrayBuffer(), url: fileUrl };
    } catch (err) { continue; }
  }
  return null;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function jsonErr(msg, status) {
  var h = corsHeaders();
  h['Content-Type'] = 'application/json';
  return new Response(JSON.stringify({ error: msg }), { status: status, headers: h });
}

// ---- NEXRAD Level-3 binary parser (NWS ICD 2620001W) ----

function parseL3(buf, meta) {
  var dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // Scan for WMO header end: CR CR LF (0x0D 0x0D 0x0A), align to 2-byte boundary
  var msgOff = 0;
  for (var s = 0; s < Math.min(50, buf.length - 2); s++) {
    if (buf[s] === 0x0D && buf[s + 1] === 0x0D && buf[s + 2] === 0x0A) {
      msgOff = s + 3;
      break;
    }
  }
  if (msgOff & 1) msgOff++;

  if (msgOff + 120 > buf.length) throw new Error('File too short: ' + buf.length + ' bytes');

  var scanDate = dv.getUint16(msgOff + 2, false);
  var scanTime = dv.getUint32(msgOff + 4, false);
  var pdb      = msgOff + 18;
  var lat      = dv.getInt32(pdb + 0, false) / 1000;
  var lon      = dv.getInt32(pdb + 4, false) / 1000;
  var symHW    = dv.getInt32(pdb + 88, false);
  var symOff   = msgOff + symHW * 2;

  if (symHW < 60 || symOff + 20 > buf.length) {
    throw new Error('Symbology offset OOR: symHW=' + symHW + ' symOff=' + symOff);
  }
  if (dv.getInt16(symOff, false) !== -1) {
    throw new Error('Bad symbology divider at byte ' + symOff);
  }

  var off     = symOff + 16;
  if (off + 2 > buf.length) throw new Error('Packet code OOB');
  var pktCode = dv.getUint16(off, false);
  off += 2;

  if (pktCode !== 0x0010 && pktCode !== 0xAF1F) {
    throw new Error('Bad packet code 0x' + pktCode.toString(16));
  }

  if (off + 12 > buf.length) throw new Error('Packet header OOB');
  var numGates    = dv.getUint16(off + 2,  false);
  var scaleFactor = dv.getUint16(off + 8,  false);
  var numRadials  = dv.getUint16(off + 10, false);
  off += 12;

  if (!numGates)   throw new Error('numGates = 0');
  if (!numRadials) throw new Error('numRadials = 0');
  if (numGates * numRadials > 10000000) throw new Error('Data too large');

  var gateKm   = scaleFactor > 0 ? scaleFactor / 1000 : 0.25;
  var azimuths = new Float32Array(numRadials);
  var flat     = new Uint8Array(numRadials * numGates);

  for (var r = 0; r < numRadials; r++) {
    if (off + 6 > buf.length) throw new Error('Radial header OOB at ' + r);
    var numBytes   = dv.getUint16(off,     false);
    var startAngle = dv.getInt16(off + 2,  false) / 10;
    off += 6;
    if (off + numBytes > buf.length) throw new Error('Radial data OOB at ' + r);
    azimuths[r] = startAngle;
    var copyLen = numBytes < numGates ? numBytes : numGates;
    flat.set(buf.subarray(off, off + copyLen), r * numGates);
    off += numBytes;
  }

  var b64 = '';
  for (var j = 0; j < flat.length; j += 8192) {
    var chunk = flat.subarray(j, j + 8192);
    var chars = new Array(chunk.length);
    for (var k = 0; k < chunk.length; k++) chars[k] = chunk[k];
    b64 += String.fromCharCode.apply(null, chars);
  }

  return {
    lat:         lat,
    lon:         lon,
    num_radials: numRadials,
    num_gates:   numGates,
    gate_km:     gateKm,
    azimuths:    Array.from(azimuths),
    min_val:     meta.min,
    max_val:     meta.max,
    name:        meta.name,
    time:        new Date((scanDate - 1) * 86400000 + scanTime * 1000).toISOString(),
    data:        btoa(b64)
  };
}
