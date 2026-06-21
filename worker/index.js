// GWCFCRadar -- NEXRAD Level-3 Proxy Worker
// Paste into Cloudflare Workers editor, Save and Deploy.
// Test: https://YOUR-WORKER.workers.dev/radar?station=KLTX&product=cc&debug

var DS_CODES = {
  cc:  ['p2cr', 'p0c', 'n0c'],
  zdr: ['p2xr', 'p0x', 'n0x']
};

var PRODUCT_META = {
  cc:  { min: 0.2,  max: 1.05, name: 'Corr. Coeff.' },
  zdr: { min: -8.0, max: 8.0,  name: 'Diff. Refl.'  }
};

addEventListener('fetch', function(event) {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  try {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    var url     = new URL(request.url);
    var station = (url.searchParams.get('station') || '').toLowerCase().trim();
    var product = (url.searchParams.get('product') || 'cc').toLowerCase().trim();
    var debug   = url.searchParams.has('debug');

    if (!station) return jsonErr('station param required', 400);
    if (!/^[a-z]{4}$/.test(station)) return jsonErr('station must be 4 letters e.g. kltx', 400);

    var codes = DS_CODES[product];
    var meta  = PRODUCT_META[product];
    if (!codes || !meta) return jsonErr('unknown product ' + product + ' -- use cc or zdr', 400);

    var rawBuf = null, usedUrl = null, tried = [];

    for (var i = 0; i < codes.length; i++) {
      var ds = codes[i];
      var tgftp = 'https://tgftp.nws.noaa.gov/SL.us008001/DF.of/DC.radar/DS.'
                + ds + '/SI.' + station + '/sn.last';
      tried.push(tgftp);
      try {
        var res = await fetch(tgftp, { headers: { 'User-Agent': 'GWCFCRadar/1.0' } });
        if (res.ok) {
          rawBuf  = await res.arrayBuffer();
          usedUrl = tgftp;
          break;
        }
      } catch (e1) { /* try next */ }
    }

    if (!rawBuf) {
      return jsonErr('No data for ' + station.toUpperCase() + ' ' + product.toUpperCase()
                     + ' -- tried: ' + tried.join(', '), 502);
    }

    var parsed;
    try {
      parsed = parseL3(new Uint8Array(rawBuf), meta);
    } catch (e2) {
      var raw = new Uint8Array(rawBuf).slice(0, 160);
      var hexArr = [];
      for (var b = 0; b < raw.length; b++) hexArr.push(raw[b].toString(16).padStart(2, '0'));
      return jsonErr('Parse error: ' + e2.message + ' | url: ' + usedUrl
                     + ' | hex: ' + hexArr.join(' '), 500);
    }

    if (debug) parsed._debug = { url: usedUrl, rawBytes: rawBuf.byteLength };

    var h = corsHeaders();
    h['Content-Type']  = 'application/json';
    h['Cache-Control'] = 'public, max-age=90';
    return new Response(JSON.stringify(parsed), { headers: h });

  } catch (e3) {
    return jsonErr('Internal error: ' + e3.message, 500);
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

// ---- NEXRAD Level-3 parser (NWS ICD 2620001W) ----
// Layout: WMO header (0-30 bytes, ends with 0x0D 0x0D 0x0A)
//         + Message Header Block (18 bytes)
//         + Product Description Block (102 bytes)
//         + Symbology Block (offset stored at PDB+88, in halfwords from MHB start)

function parseL3(buf, meta) {
  var dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // Find WMO header end (CR CR LF = 0x0D 0x0D 0x0A), then align to 2-byte boundary
  var msgOff = 0;
  for (var s = 0; s < Math.min(50, buf.length - 2); s++) {
    if (buf[s] === 0x0D && buf[s + 1] === 0x0D && buf[s + 2] === 0x0A) {
      msgOff = s + 3;
      break;
    }
  }
  if (msgOff & 1) msgOff++;

  if (msgOff + 120 > buf.length) {
    throw new Error('File too short: ' + buf.length + ' bytes');
  }

  // Message Header Block
  var scanDate = dv.getUint16(msgOff + 2, false); // days since 1970-01-01 (1-indexed)
  var scanTime = dv.getUint32(msgOff + 4, false); // seconds past midnight UTC

  // Product Description Block (PDB) = MHB + 18 bytes
  var pdb = msgOff + 18;
  var lat = dv.getInt32(pdb + 0, false) / 1000; // deg N
  var lon = dv.getInt32(pdb + 4, false) / 1000; // deg E (negative = West)

  // Symbology Block offset: PDB bytes 88-91, in halfwords from MHB start
  var symHW  = dv.getInt32(pdb + 88, false);
  var symOff = msgOff + symHW * 2;

  if (symHW < 60 || symOff + 20 > buf.length) {
    throw new Error('Symbology offset OOR: symHW=' + symHW + ' symOff=' + symOff);
  }

  // Symbology Block must start with divider = -1
  if (dv.getInt16(symOff, false) !== -1) {
    throw new Error('Bad symbology divider at byte ' + symOff);
  }

  // Skip block header (10 bytes) + layer header divider+length (6 bytes)
  var off = symOff + 16;

  if (off + 2 > buf.length) throw new Error('Packet code OOB');
  var pktCode = dv.getUint16(off, false);
  off += 2;

  // 0x0010 = Digital Radial Data Array, 0xAF1F = Generic Radial
  if (pktCode !== 0x0010 && pktCode !== 0xAF1F) {
    throw new Error('Bad packet code 0x' + pktCode.toString(16));
  }

  // Packet header: indexFirstBin(2) numBins(2) iCenter(2) jCenter(2) scaleFactor(2) numRadials(2)
  if (off + 12 > buf.length) throw new Error('Packet header OOB');
  var numGates    = dv.getUint16(off + 2,  false);
  var scaleFactor = dv.getUint16(off + 8,  false); // 1/1000 km per gate
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
    var startAngle = dv.getInt16 (off + 2, false) / 10; // deg CW from North
    off += 6;
    if (off + numBytes > buf.length) throw new Error('Radial data OOB at ' + r);
    azimuths[r] = startAngle;
    var copyLen = numBytes < numGates ? numBytes : numGates;
    flat.set(buf.subarray(off, off + copyLen), r * numGates);
    off += numBytes;
  }

  // Base64-encode in chunks to avoid stack overflow on large arrays
  var b64 = '';
  for (var j = 0; j < flat.length; j += 8192) {
    var chunk = flat.subarray(j, j + 8192);
    var chars = new Array(chunk.length);
    for (var k = 0; k < chunk.length; k++) chars[k] = chunk[k];
    b64 += String.fromCharCode.apply(null, chars);
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
    data:        btoa(b64)
  };
}
