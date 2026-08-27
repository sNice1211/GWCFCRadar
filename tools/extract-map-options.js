#!/usr/bin/env node
/*
 * Reads index.html and writes services/bot/map-options.json: every layer, overlay and
 * product the site actually offers.
 *
 *     node tools/extract-map-options.js
 *
 * The bot builds its /map command from that file, so the two cannot drift.
 * Typed by hand they had already drifted: the command offered six radar
 * products where the page shows five, and knew nothing about half the overlays.
 *
 * More importantly it takes only what the page really shows. The dual polarity
 * radar products sit in the source commented out, and a command that offered
 * them would promise a picture nobody can see, on the site or in Discord. Lines
 * that are commented out are dropped here for exactly that reason, so "what the
 * bot can ask for" and "what a visitor can click" stay the same list.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// A commented out entry is one nobody can reach. Dropping those lines is the
// whole point, so it happens before anything is matched.
const live = (text) =>
  text.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

function block(name) {
  const re = new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\n\\s*\\];`);
  const m = html.match(re);
  return m ? live(m[1]) : null;
}

// { id: 'x', ..., label: 'Y' } in either order, quoted either way.
function entries(text) {
  if (!text) return [];
  const out = [];
  for (const line of text.split('\n')) {
    const id = line.match(/\bid\s*:\s*'([^']+)'/);
    const label = line.match(/\blabel\s*:\s*'([^']+)'/);
    if (id) out.push({ value: id[1], name: label ? label[1] : id[1] });
  }
  return out;
}

// ── Layers, from the object that tracks which are on ───────────────────────
const layersRaw = html.match(/(?:let|const|var)\s+activeLayers\s*=\s*\{([\s\S]*?)\n\s*\}/);
const layers = layersRaw
  ? [...live(layersRaw[1]).matchAll(/(\w+)\s*:/g)].map(m => m[1])
  : [];

// ── Overlays, from the pills themselves ────────────────────────────────────
// Read off the markup rather than a list, because the markup is what a visitor
// actually clicks. The title attribute is the description the site shows on
// hover, which makes a good Discord description too.
const overlays = [];
for (const m of html.matchAll(
  /class="ov-pill[^"]*"[^>]*data-ovid="([^"]+)"[^>]*title="([^"]*)"/g)) {
  if (m[1].includes('$')) continue;             // a template, not a pill
  overlays.push({ value: m[1], name: m[2].split(/\s+-\s+/)[0].trim() || m[1] });
}
for (const m of html.matchAll(/data-ovid="([^"]+)"/g)) {
  if (m[1].includes('$')) continue;
  if (!overlays.some(o => o.value === m[1])) {
    overlays.push({ value: m[1], name: m[1] });
  }
}

// ── Products, one family at a time ─────────────────────────────────────────
const families = {
  radar:       entries(block('const RADAR_SUB_BUBBLES')),
  wind:        entries(block('const WIND_SUB_BUBBLES')),
  temperature: entries(block('const TEMPERATURE_SUB_BUBBLES')),
  waves:       entries(block('const WAVES_SUB_BUBBLES')),
  air:         entries(block('const AIR_SUB_BUBBLES')),
  pressure:    entries(block('const PRESSURE_SUB_BUBBLES')),
};

// The radar sub bubbles are named for people, and the URL takes short ids.
const RADAR_URL_ID = {
  reflectivity: 'ref', velocity: 'vel',
  hc: 'hc', accum: 'accum', boha: 'boha',
};
families.radar = families.radar
  .filter(p => RADAR_URL_ID[p.value])
  .map(p => ({ value: RADAR_URL_ID[p.value], name: p.name }));
// MRMS is a radar product on the page but is loaded by its own path rather
// than through selectProduct, so it is not in that row. The URL accepts it.
if (!families.radar.some(p => p.value === 'mrms')) {
  families.radar.push({ value: 'mrms', name: 'MRMS Composite' });
}

// ── Satellite bands ────────────────────────────────────────────────────────
const satellite = [];
{
  const m = html.match(/GOES_PRODUCTS\s*=\s*\[([\s\S]*?)\n\s*\];/);
  const text = m ? live(m[1]) : '';
  for (const line of text.split('\n')) {
    const id = line.match(/\bid\s*:\s*'(ch\d+)'/);
    const label = line.match(/\blabel\s*:\s*'([^']+)'/);
    if (id) satellite.push({ value: id[1], name: `${label ? label[1] : id[1]} (${id[1]})` });
  }
}

// ── Basemaps ───────────────────────────────────────────────────────────────
const basemaps = [...new Set(
  [...live(html).matchAll(/setMapType\('([a-z]+)'\)/g)].map(m => m[1]))]
  .concat('dark')                       // the default, never set by a call
  .filter((v, i, a) => a.indexOf(v) === i)
  .sort();

const out = {
  generated: 'by tools/extract-map-options.js from index.html, do not edit',
  layers, overlays, basemaps, satellite, families,
};

const dest = path.join(root, 'services', 'bot', 'map-options.json');
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');

console.log(`layers      ${layers.length}`);
console.log(`overlays    ${overlays.length}`);
console.log(`basemaps    ${basemaps.length}   ${basemaps.join(', ')}`);
console.log(`satellite   ${satellite.length}`);
for (const [k, v] of Object.entries(families)) {
  console.log(`${k.padEnd(11)} ${v.length}   ${v.map(p => p.value).join(', ')}`);
}
console.log(`\nwrote ${path.relative(root, dest)}`);
