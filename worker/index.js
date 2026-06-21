/**
 * GWCFCRadar — NEXRAD Level-3 Proxy Worker
 * Fetches CC / ZDR from NOAA tgftp, parses binary L3, returns JSON.
 * Client renders with Canvas 2D — no WASM, no Workers needed on PS5.
 *
 * Deploy: cd worker && npm i && npx wrangler deploy
 * Test:   https://gwcfcradar-radar.YOUR.workers.dev/radar?station=KLTX&product=cc&debug
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
  zdr: { min: -8.0, max: 8.0,  name: 'Diff. Refl.' },
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url     = new URL(request.url);
    const station = url.searchParams.get('station')?.toLowerCase();
    const product = url.searchParams.get('product')?.toLowerCase() || 'cc';
    const debug   = url.searchParams.has('debug');

    if (!station) return jsonErr('station param required', 400);

    const codes = DS_CODES[product];
    const meta  = PRODUCT_META[product];
    if (!codes || !meta) {
      return jsonErr(`unknown product "${product}" — use cc or zdr`, 400);
    }

    // Try each DS folder code until one returns data
    let rawBuf = null;
    let usedUrl = null;
    const tried = [];

    for (const ds of codes) {
      const tgftp = `https://tgftp.nws.noaa.gov/SL.us008001/DF.of/DC.radar/DS.${ds}/SI.${station}/sn.last`;
      tried.push(tgftp);
      try {
        const res = await fetch(tgftp);
        if (res.ok) {
          rawBuf  = await res.arrayBuffer();
          usedUrl = tgftp;
          break;
        }
      } catch (_) { /* try next DS code */ }
    }

    if (!rawBuf) {
      return jsonErr(
        `No Level-3 data for ${station.toUpperCase()} ${product.toUpperCase()}.\nTried:\n${tried.join('\n')}`,
        502
      );
    }

    let parsed;
    try {
      parsed = parseL3(new Uint8Array(rawBuf), meta);
    } catch (e) {
      // Always include hex dump so we can debug DS code / format issues
      const hex = [...new Uint8Array(rawBuf).slice(0, 160)]
        .map(b => b.toString(16).padStart(2, '0')).join(' ');
      return jsonErr(
        `Parse failed: ${e.message}\nURL: ${usedUrl}\nFirst 160 bytes:\n${hex}`,
        500
      );
    }

    if (debug) parsed._debug = { url: usedUrl, rawBytes: rawBuf.byteLength };

    return new Response(JSON.stringify(parsed), {
      headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=90' },
    });
  },
};

// ── NEXRAD Level-3 binary parser ─────────────────────────────────────────────
// Ref: NWS ICD 2620001W "RPG to Class 1 User"
//
// File layout:
//   [0..29]  WMO header (30 bytes ASCII, e.g. "SDUS53 KLTX 012345\r\r\n")
//   [30..47] Message Header Block (MHB, 18 bytes)
//   [48..]   Product Description Block (PDB, ~102 bytes)
//   [30 + symHW*2 ..] Symbology Block
//
// All multi-byte integers are big-endian (false = big-endian in DataView).

function parseL3(buf, meta) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // ── Message Header Block starts at file byte 30 ──
  const scanDate = dv.getUint16(32, false); // days since 1 Jan 1970 (1-indexed)
  const scanTime = dv.getUint32(34, false); // seconds since midnight UTC

  // ── Product Description Block starts at file byte 48 ──
  const pdb = 48;
  const lat = dv.getInt32(pdb + 0,  false) / 1000; // degrees N
  const lon = dv.getInt32(pdb + 4,  false) / 1000; // degrees E (West = negative)

  // Offset to Symbology Block: PDB bytes 88-91, in halfwords from message start (file byte 30)
  // NWS ICD Table V-E: HW54-55 = message bytes 106-109 = PDB bytes 88-91
  const symHW  = dv.getInt32(pdb + 88, false);
  const symOff = 30 + symHW * 2; // file byte offset

  // ── Symbology Block ──
  // Header: divider(-1, 2B) blockId(1, 2B) blockLen(4B) numLayers(2B) = 10 bytes
  if (dv.getInt16(symOff, false) !== -1) {
    throw new Error(`Bad symbology divider at file byte ${symOff} (symHW=${symHW})`);
  }
  // Skip block header (10 bytes) + layer header divider+length (6 bytes)
  let off = symOff + 10 + 6;

  // ── Data Packet ──
  const packetCode = dv.getUint16(off, false);
  off += 2;

  // Packet 16 (0x0010) = Digital Radial Data Array
  // Packet 0xAF1F       = Generic Radial Data (used in some super-res products)
  if (packetCode !== 0x0010 && packetCode !== 0xAF1F) {
    throw new Error(`Unexpected packet code 0x${packetCode.toString(16)}`);
  }

  // Packet header (12 bytes):
  // indexFirstBin(2) numBins(2) iCenter(2) jCenter(2) scaleFactor(2) numRadials(2)
  const numGates    = dv.getUint16(off + 2,  false);
  const scaleFactor = dv.getUint16(off + 8,  false); // units of 1/1000 km per gate
  const numRadials  = dv.getUint16(off + 10, false);
  off += 12;

  const gateKm = scaleFactor / 1000; // km per gate (e.g. 250 → 0.25 km)

  // ── Radials ──
  const azimuths = new Float32Array(numRadials);
  const flat     = new Uint8Array(numRadials * numGates); // raw encoded values

  for (let r = 0; r < numRadials; r++) {
    const numBytes   = dv.getUint16(off,     false);
    const startAngle = dv.getInt16 (off + 2, false) / 10; // degrees clockwise from N
    off += 6; // skip numBytes(2) + startAngle(2) + deltaAngle(2)

    azimuths[r] = startAngle;
    const copyLen = Math.min(numBytes, numGates);
    flat.set(buf.subarray(off, off + copyLen), r * numGates);
    off += numBytes;
  }

  // ── Base64-encode flat data for JSON transport ──
  // Chunked to avoid stack overflow from large spread calls
  let b64 = '';
  for (let i = 0; i < flat.length; i += 8192) {
    b64 += String.fromCharCode(...flat.subarray(i, i + 8192));
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
    data:        btoa(b64),
  };
}

function jsonErr(msg, status) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
