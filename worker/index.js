/**
 * GWCFCRadar -- NEXRAD Level-3 Proxy Worker
 * Fetches CC / ZDR from NOAA tgftp, parses binary L3, returns JSON.
 * Client renders with Canvas 2D -- no WASM, no Workers needed on PS5.
 *
 * Paste this entire file into the Cloudflare Workers editor and Save & Deploy.
 * Test: https://<your-worker>.workers.dev/radar?station=KLTX&product=cc&debug
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// DS folder codes to try in order for each product (NOAA tgftp)
const DS_CODES = {
  cc:  ['p2cr', 'p0c', 'n0c'],
  zdr: ['p2xr', 'p0x', 'n0x'],
};

const PRODUCT_META = {
  cc:  { min: 0.2,  max: 1.05, name: 'Corr. Coeff.' },
  zdr: { min: -8.0, max: 8.0,  name: 'Diff. Refl.'  },
};

export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
      }

      const url     = new URL(request.url);
      const station = (url.searchParams.get('station') || '').toLowerCase().trim();
      const product = (url.searchParams.get('product') || 'cc').toLowerCase().trim();
      const debug   = url.searchParams.has('debug');

      if (!station) return jsonErr('station param required', 400);
      if (!/^[a-z]{4}$/.test(station)) return jsonErr('station must be 4 letters, e.g. kltx', 400);

      const codes = DS_CODES[product];
      const meta  = PRODUCT_META[product];
      if (!codes || !meta) {
        return jsonErr('unknown product "' + product + '" -- use cc or zdr', 400);
      }

      // Try each DS folder code until one returns data
      let rawBuf = null;
      let usedUrl = null;
      const tried = [];

      for (const ds of codes) {
        const tgftp = 'https://tgftp.nws.noaa.gov/SL.us008001/DF.of/DC.radar/DS.' + ds + '/SI.' + station + '/sn.last';
        tried.push(tgftp);
        try {
          const res = await fetch(tgftp, { headers: { 'User-Agent': 'GWCFCRadar/1.0' } });
          if (res.ok) {
            rawBuf  = await res.arrayBuffer();
            usedUrl = tgftp;
            break;
          }
        } catch (_) { /* try next DS code */ }
      }

      if (!rawBuf) {
        return jsonErr(
          'No Level-3 data for ' + station.toUpperCase() + ' ' + product.toUpperCase() +
          '.\nTried:\n' + tried.join('\n'),
          502
        );
      }

      let parsed;
      try {
        parsed = parseL3(new Uint8Array(rawBuf), meta);
      } catch (e) {
        const hex = Array.from(new Uint8Array(rawBuf).slice(0, 160))
          .map(b => b.toString(16).padStart(2, '0')).join(' ');
        return jsonErr(
          'Parse failed: ' + e.message + '\nURL: ' + usedUrl + '\nFirst 160 bytes:\n' + hex,
          500
        );
      }

      if (debug) parsed._debug = { url: usedUrl, rawBytes: rawBuf.byteLength };

      return new Response(JSON.stringify(parsed), {
        headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=90' },
      });

    } catch (e) {
      return jsonErr('Internal error: ' + e.message, 500);
    }
  },
};

// ============================================================
// NEXRAD Level-3 binary parser
// Ref: NWS ICD 2620001W "RPG to Class 1 User"
//
// File layout:
//   [0..N-1]  WMO header (variable -- 0, 21, or 30 bytes, ends with \r\r\n)
//   [N..N+17] Message Header Block (MHB, 18 bytes)
//   [N+18..]  Product Description Block (PDB, 102 bytes)
//   [N + symHW*2 ..] Symbology Block
//
// All multi-byte integers are big-endian (littleEndian=false in DataView).
// ============================================================

function parseL3(buf, meta) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // Auto-detect WMO header length: scan for \r\r\n terminator
  // WMO headers look like "SDUS53 KLTX 012345\r\r\n" (21 bytes typical)
  let msgOff = 0;
  for (let i = 0; i < Math.min(50, buf.length - 2); i++) {
    if (buf[i] === 0x0D && buf[i + 1] === 0x0D && buf[i + 2] === 0x0A) {
      msgOff = i + 3;
      break;
    }
  }
  // Align to 2-byte boundary (all NEXRAD structures are halfword-aligned)
  if (msgOff & 1) msgOff++;

  if (msgOff + 120 > buf.length) {
    throw new Error('File too short (' + buf.length + ' bytes, msgOff=' + msgOff + ')');
  }

  // ---- Message Header Block (MHB) starts at msgOff ----
  // HW1 = message code, HW2 = date, HW3-4 = time, ...
  const scanDate = dv.getUint16(msgOff + 2, false); // days since 1 Jan 1970 (1-indexed)
  const scanTime = dv.getUint32(msgOff + 4, false); // seconds past midnight UTC

  // ---- Product Description Block (PDB) starts 18 bytes after MHB ----
  const pdb = msgOff + 18;

  const lat = dv.getInt32(pdb + 0, false) / 1000; // degrees N
  const lon = dv.getInt32(pdb + 4, false) / 1000; // degrees E (negative = West)

  // PDB HW54-55 (bytes 106-109 from MHB, bytes 88-91 from PDB start):
  // Offset to Symbology Block in halfwords from start of MHB
  const symHW  = dv.getInt32(pdb + 88, false);
  const symOff = msgOff + symHW * 2;

  if (symHW < 60 || symOff + 20 > buf.length) {
    throw new Error('Symbology offset out of range (symHW=' + symHW + ', symOff=' + symOff + ', len=' + buf.length + ')');
  }

  // ---- Symbology Block ----
  // Header: divider(-1, 2B) blockId(2B) blockLen(4B) numLayers(2B) = 10 bytes
  const symDiv = dv.getInt16(symOff, false);
  if (symDiv !== -1) {
    throw new Error('Bad symbology divider 0x' + (symDiv & 0xFFFF).toString(16) + ' at byte ' + symOff);
  }

  // Skip block header (10 bytes) + layer header: divider(2B) + length(4B) = 6 bytes
  let off = symOff + 10 + 6;

  // ---- Data Packet ----
  if (off + 2 > buf.length) throw new Error('Packet code read out of bounds');
  const packetCode = dv.getUint16(off, false);
  off += 2;

  // Packet 0x0010 = Digital Radial Data Array (standard L3)
  // Packet 0xAF1F = Generic Radial (some super-res products)
  if (packetCode !== 0x0010 && packetCode !== 0xAF1F) {
    throw new Error('Unexpected packet code 0x' + packetCode.toString(16));
  }

  // Packet header (12 bytes):
  // indexFirstBin(2) numBins(2) iCenter(2) jCenter(2) scaleFactor(2) numRadials(2)
  if (off + 12 > buf.length) throw new Error('Packet header read out of bounds');
  const numGates    = dv.getUint16(off + 2,  false);
  const scaleFactor = dv.getUint16(off + 8,  false); // 1/1000 km per gate
  const numRadials  = dv.getUint16(off + 10, false);
  off += 12;

  if (numGates === 0)    throw new Error('numGates is 0');
  if (numRadials === 0)  throw new Error('numRadials is 0');
  if (numGates * numRadials > 10_000_000) {
    throw new Error('Data too large: ' + numRadials + ' radials x ' + numGates + ' gates');
  }

  const gateKm = scaleFactor > 0 ? scaleFactor / 1000 : 0.25;

  // ---- Radials ----
  const azimuths = new Float32Array(numRadials);
  const flat     = new Uint8Array(numRadials * numGates);

  for (let r = 0; r < numRadials; r++) {
    if (off + 6 > buf.length) throw new Error('Radial header out of bounds at radial ' + r);
    const numBytes   = dv.getUint16(off,     false);
    const startAngle = dv.getInt16 (off + 2, false) / 10; // degrees CW from N
    off += 6;

    if (off + numBytes > buf.length) throw new Error('Radial data out of bounds at radial ' + r);
    azimuths[r] = startAngle;
    flat.set(buf.subarray(off, off + Math.min(numBytes, numGates)), r * numGates);
    off += numBytes;
  }

  // ---- Base64-encode flat array for JSON transport ----
  // Chunk to avoid spread-call stack overflow on large datasets
  let b64raw = '';
  for (let i = 0; i < flat.length; i += 8192) {
    b64raw += String.fromCharCode(...flat.subarray(i, i + 8192));
  }

  const epochMs = (scanDate - 1) * 86_400_000 + scanTime * 1000;

  return {
    lat,
    lon,
    num_radials: numRadials,
    num_gates:   numGates,
    gate_km:     gateKm,
    azimuths:    Array.from(azimuths),
    min_val:     meta.min,
    max_val:     meta.max,
    name:        meta.name,
    time:        new Date(epochMs).toISOString(),
    data:        btoa(b64raw),
  };
}

function jsonErr(msg, status) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
