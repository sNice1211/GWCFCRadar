/**
 * GWCFCRadar — NEXRAD Level-3 Proxy Worker
 *
 * Fetches NEXRAD Level-3 dual-pol products (CC, ZDR) from NOAA's public
 * tgftp server, parses the binary format, and returns JSON that the client
 * can render with Canvas 2D — no WASM, no Workers on the client.
 *
 * Deploy: cd worker && npm i && npx wrangler deploy
 * Endpoint: https://gwcfcradar-radar.YOUR_SUBDOMAIN.workers.dev/radar?station=KLTX&product=cc
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Maps our product keys to NOAA tgftp DS folder codes and L3 product codes
// DS folder codes confirmed from NOAA ICD for Product Distribution and Acquisition
const PRODUCTS = {
  cc:  { ds: 'p2cr', code: 165, name: 'Corr. Coeff.',   min: 0.2,  max: 1.05, unit: '' },
  zdr: { ds: 'p2xr', code: 159, name: 'Diff. Refl.',    min: -8.0, max: 8.0,  unit: 'dB' },
  ref: { ds: 'p19r0',code: 94,  name: 'Reflectivity',   min: -32,  max: 94.5, unit: 'dBZ' },
  vel: { ds: 'p2u',  code: 99,  name: 'Velocity',       min: -127, max: 127,  unit: 'kt' },
};

// Fallback DS codes to try if the primary one returns 404
const DS_FALLBACKS = {
  cc:  ['p2cr', 'p0c', 'n0c', '165'],
  zdr: ['p2xr', 'p0x', 'n0x', '159'],
  ref: ['p19r0', 'p0q', 'n0q'],
  vel: ['p2u', 'p0v', 'n0v'],
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const station = url.searchParams.get('station')?.toLowerCase();
    const product = url.searchParams.get('product')?.toLowerCase() || 'cc';
    const debug   = url.searchParams.has('debug');

    if (!station) {
      return err('station param required (e.g. ?station=KLTX&product=cc)', 400);
    }

    const meta = PRODUCTS[product];
    if (!meta) {
      return err(`unknown product "${product}" — valid: ${Object.keys(PRODUCTS).join(', ')}`, 400);
    }

    // Try each DS code until one returns data
    const fallbacks = DS_FALLBACKS[product] || [meta.ds];
    let rawBuf = null, usedUrl = null;
    const tried = [];

    for (const ds of fallbacks) {
      const tgftp = `https://tgftp.nws.noaa.gov/SL.us008001/DF.of/DC.radar/DS.${ds}/SI.${station}/sn.last`;
      tried.push(tgftp);
      try {
        const res = await fetch(tgftp, { cf: { cacheTtl: 90, cacheEverything: true } });
        if (res.ok) {
          rawBuf = await res.arrayBuffer();
          usedUrl = tgftp;
          break;
        }
      } catch (_) { /* try next */ }
    }

    if (!rawBuf) {
      return err(`No Level-3 data found for ${station.toUpperCase()} ${product.toUpperCase()}. Tried:\n${tried.join('\n')}`, 502);
    }

    let parsed;
    try {
      parsed = parseL3(new Uint8Array(rawBuf), meta);
    } catch (e) {
      if (debug) {
        // Return raw bytes as hex for debugging
        const hex = [...new Uint8Array(rawBuf).slice(0, 120)]
          .map(b => b.toString(16).padStart(2, '0')).join(' ');
        return err(`Parse failed: ${e.message}\nURL: ${usedUrl}\nFirst 120 bytes: ${hex}`, 500);
      }
      return err(`Parse failed: ${e.message}`, 500);
    }

    if (debug) parsed._debug = { url: usedUrl, rawBytes: rawBuf.byteLength };

    return new Response(JSON.stringify(parsed), {
      headers: {
        ...CORS,
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=90',
      },
    });
  },
};

// ── NEXRAD Level-3 binary parser ─────────────────────────────────────────────
// Ref: NWS ICD 2620001 "Interface Control Document for the RPG to Class 1 User"

function parseL3(buf, meta) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // Skip 30-byte WMO header (ASCII text like "SDUS53 KLTX 012345\r\r\n")
  let off = 30;

  // ── Message Header Block (18 bytes) ──
  const productCode = dv.getInt16(off, false);
  const scanDate    = dv.getUint16(off + 2, false);  // days since 1 Jan 1970
  const scanTime    = dv.getUint32(off + 4, false);  // seconds since midnight UTC
  off += 18;

  // ── Product Description Block (102 bytes) ──
  const pdb = off;
  const lat = dv.getInt32(pdb + 0, false) / 1000;   // degrees N
  const lon = dv.getInt32(pdb + 4, false) / 1000;   // degrees E (negative = West)

  // Offset to Symbology Block from message start (byte 30), in 2-byte half-words
  const symHW = dv.getInt32(pdb + 60, false);
  let symOff  = 30 + symHW * 2;
  off = pdb + 102;

  // ── Symbology Block ──
  // divider(-1,2) blockId(1,2) blockLen(4) numLayers(2) = 10 bytes header
  if (dv.getInt16(symOff, false) !== -1) {
    throw new Error(`Bad symbology block divider at offset ${symOff}`);
  }
  const numLayers = dv.getUint16(symOff + 8, false);
  symOff += 10;

  // Layer header: divider(-1,2) layerLen(4) = 6 bytes
  symOff += 6;

  // ── Data Packet ──
  const packetCode = dv.getUint16(symOff, false);
  symOff += 2;

  if (packetCode !== 16 && packetCode !== 0xAF1F) {
    throw new Error(`Unknown packet code 0x${packetCode.toString(16)} (expected 0x10 or 0xAF1F)`);
  }

  // Packet header (12 bytes):
  // indexFirstBin(2) numBins(2) iCenter(2) jCenter(2) scaleFactor(2) numRadials(2)
  const numGates    = dv.getUint16(symOff + 2, false);
  const scaleFactor = dv.getUint16(symOff + 8, false); // 1/1000 km per gate
  const numRadials  = dv.getUint16(symOff + 10, false);
  symOff += 12;

  const gateKm = scaleFactor / 1000;

  // ── Radials ──
  const azimuths = new Float32Array(numRadials);
  // Store all gate values flat: [r0g0, r0g1, ..., r0gN, r1g0, ...]
  const flat = new Uint8Array(numRadials * numGates);

  for (let r = 0; r < numRadials; r++) {
    const numBytes   = dv.getUint16(symOff, false);
    const startAngle = dv.getInt16(symOff + 2, false) / 10; // degrees clockwise from N
    symOff += 6;

    azimuths[r] = startAngle;
    const rowStart = r * numGates;
    const copyLen  = Math.min(numBytes, numGates);
    flat.set(buf.subarray(symOff, symOff + copyLen), rowStart);
    symOff += numBytes;
  }

  // Epoch ms from WSR-88D date/time (days are 1-indexed from 1 Jan 1970)
  const epochMs = (scanDate - 1) * 86_400_000 + scanTime * 1000;

  // Encode flat array as base64 for JSON transport
  // Cloudflare Workers have btoa()
  let b64 = '';
  const chunk = 8192;
  for (let i = 0; i < flat.length; i += chunk) {
    b64 += String.fromCharCode(...flat.subarray(i, i + chunk));
  }

  return {
    lat, lon,
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

function err(msg, status) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
