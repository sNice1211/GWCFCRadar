/**
 * GWCFCRadar -- NEXRAD Level-3 Proxy Worker
 * Fetches CC / ZDR from NOAA tgftp, parses binary L3, returns JSON.
 * Client renders with Canvas 2D -- no WASM, no Workers needed on PS5.
 *
 * Paste into Cloudflare Workers editor (Service Worker or Module format both work).
 * Test: https://YOUR-WORKER.workers.dev/radar?station=KLTX&product=cc&debug
 */

var DS_CODES = {
  cc:  ['p2cr', 'p0c', 'n0c'],
  zdr: ['p2xr', 'p0x', 'n0x']
};

var PRODUCT_META = {
  cc:  { min: 0.2,  max: 1.05, name: 'Corr. Coeff.' },
  zdr: { min: -8.0, max: 8.0,  name: 'Diff. Refl.' }
};

addEventListener('fetch', function(event) {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  try {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    var url     = new URL(request.url);
    var station = (url.searchParams.get('station') || '').toLowerCase().trim();
    var product = (url.searchParams.get('product') || 'cc').toLowerCase().trim();
    var debug   = url.searchParams.has('debug');

    if (!station) return jsonErr('station param required', 400);
    if (!/^[a-z]{4}$/.test(station)) return jsonErr('station must be 4 letters e.g. kltx', 400);

    var codes = DS_CODES[product];
    var meta  = PRODUCT_META[product];
    if (!codes || !meta) {
      return jsonErr('unknown product ' + product + ' use cc or zdr', 400);
    }

    var rawBuf  = null;
    var usedUrl = null;
    var tried   = [];

    for (var i = 0; i < codes.length; i++) {
      var ds    = codes[i];
      var tgftp = 'https://tgftp.nws.noaa.gov/SL.us008001/DF.of/DC.radar/DS.' + ds + '/SI.' + station + '/sn.last';
      tried.push(tgftp);
      try {
        var res = await fetch(tgftp, { headers: { 'User-Agent': 'GWCFCRadar/1.0' } });
        if (res.ok) {
          rawBuf  = await res.arrayBuffer();
          usedUrl = tgftp;
          break;
        }
      } catch (fetchErr) { /* try next DS code */ }
    }

    if (!rawBuf) {
      return jsonErr(
        'No Level-3 data for ' + station.toUpperCase() + ' ' + product.toUpperCase() +
        '. Tried: ' + tried.join(' | '),
        502
      );
    }

    var parsed;
    try {
      parsed = parseL3(new Uint8Array(rawBuf), meta);
    } catch (parseErr) {
      var bytes = new Uint8Array(rawBuf).slice(0, 160);
      var hex   = [];
      for (var b = 0; b < bytes.length; b++) {
        hex.push(bytes[b].toString(16).padStart(2, '0'));
      }
      return jsonErr(
        'Parse failed: ' + parseErr.message + ' | URL: ' + usedUrl + ' | Hex: ' + hex.join(' '),
        500
      );
    }

    if (debug) parsed._debug = { url: usedUrl, rawBytes: rawBuf.byteLength };

    var jsonHeaders = corsHeaders();
    jsonHeaders['Content-Type']  = 'application/json';
    jsonHeaders['Cache-Control'] = 'public, max-age=90';

    return new Response(JSON.stringify(parsed), { headers: jsonHeaders });

  } catch (err) {
    return jsonErr('Internal error: ' + err.message, 500);
  }
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

/* ---------------------------------------------------------------
   NEXRAD Level-3 binary parser
   Ref: NWS ICD 2620001W "RPG to Class 1 User"

   File layout:
     [0..N-1]  WMO header (0, 21, or 30 bytes -- ends with CR CR LF)
     [N..N+17] Message Header Block (18 bytes)
     [N+18..]  Product Description Block (102 bytes)
     [N + symHW*2..] Symbology Block

   All integers are big-endian (littleEndian=false in DataView).
--------------------------------------------------------------- */

function parseL3(buf, meta) {
  var dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  /* Auto-detect WMO header -- scan for CR CR LF (0x0D 0x0D 0x0A) */
  var msgOff = 0;
  for (var s = 0; s < Math.min(50, buf.length - 2); s++) {
    if (buf[s] === 0x0D && buf[s + 1] === 0x0D && buf[s + 2] === 0x0A) {
      msgOff = s + 3;
      break;
    }
  }
  if (msgOff & 1) msgOff++; /* align to 2-byte boundary */

  if (msgOff + 120 > buf.length) {
    throw new Error('File too short: ' + buf.length + ' bytes, msgOff=' + msgOff);
  }

  /* Message Header Block */
  var scanDate = dv.getUint16(msgOff + 2, false); /* days since 1 Jan 1970, 1-indexed */
  var scanTime = dv.getUint32(msgOff + 4, false); /* seconds past midnight UTC */

  /* Product Description Block starts 18 bytes into MHB */
  var pdb = msgOff + 18;
  var lat = dv.getInt32(pdb + 0, false) / 1000;  /* degrees N */
  var lon = dv.getInt32(pdb + 4, false) / 1000;  /* degrees E, negative = West */

  /* PDB bytes 88-91: Symbology Block offset in halfwords from MHB start */
  var symHW  = dv.getInt32(pdb + 88, false);
  var symOff = msgOff + symHW * 2;

  if (symHW < 60 || symOff + 20 > buf.length) {
    throw new Error('Symbology offset out of range: symHW=' + symHW + ' symOff=' + symOff + ' len=' + buf.length);
  }

  /* Symbology Block: first 2 bytes must be -1 (divider) */
  if (dv.getInt16(symOff, false) !== -1) {
    throw new Error('Bad symbology divider at byte ' + symOff);
  }

  /* Skip block header (10 bytes) + layer header: divider(2) + length(4) = 6 bytes */
  var off = symOff + 16;

  if (off + 2 > buf.length) throw new Error('Packet code out of bounds');
  var packetCode = dv.getUint16(off, false);
  off += 2;

  /* 0x0010 = Digital Radial Data Array  |  0xAF1F = Generic Radial */
  if (packetCode !== 0x0010 && packetCode !== 0xAF1F) {
    throw new Error('Unexpected packet code 0x' + packetCode.toString(16));
  }

  /* Packet header: indexFirstBin(2) numBins(2) iCenter(2) jCenter(2) scaleFactor(2) numRadials(2) */
  if (off + 12 > buf.length) throw new Error('Packet header out of bounds');
  var numGates    = dv.getUint16(off + 2,  false);
  var scaleFactor = dv.getUint16(off + 8,  false); /* units: 1/1000 km per gate */
  var numRadials  = dv.getUint16(off + 10, false);
  off += 12;

  if (numGates === 0)   throw new Error('numGates is 0');
  if (numRadials === 0) throw new Error('numRadials is 0');
  if (numGates * numRadials > 10000000) {
    throw new Error('Data too large: ' + numRadials + ' x ' + numGates);
  }

  var gateKm   = scaleFactor > 0 ? scaleFactor / 1000 : 0.25;
  var azimuths = new Float32Array(numRadials);
  var flat     = new Uint8Array(numRadials * numGates);

  for (var r = 0; r < numRadials; r++) {
    if (off + 6 > buf.length) throw new Error('Radial header OOB at radial ' + r);
    var numBytes   = dv.getUint16(off,     false);
    var startAngle = dv.getInt16(off + 2,  false) / 10; /* degrees CW from N */
    off += 6;
    if (off + numBytes > buf.length) throw new Error('Radial data OOB at radial ' + r);
    azimuths[r] = startAngle;
    var copyLen = numBytes < numGates ? numBytes : numGates;
    flat.set(buf.subarray(off, off + copyLen), r * numGates);
    off += numBytes;
  }

  /* Base64-encode in chunks to avoid stack overflow */
  var b64raw = '';
  for (var j = 0; j < flat.length; j += 8192) {
    var chunk = flat.subarray(j, j + 8192);
    var chars = [];
    for (var k = 0; k < chunk.length; k++) chars.push(chunk[k]);
    b64raw += String.fromCharCode.apply(null, chars);
  }

  var epochMs = (scanDate - 1) * 86400000 + scanTime * 1000;

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
    time:        new Date(epochMs).toISOString(),
    data:        btoa(b64raw)
  };
}
