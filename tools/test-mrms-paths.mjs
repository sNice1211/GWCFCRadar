#!/usr/bin/env node
/*
 * Every MRMS address the pipeline asks for is one NOAA actually serves.
 *
 *     node tools/test-mrms-paths.mjs
 *
 * This exists because eighteen of them were not, and nothing caught it for a
 * long time. A product MRMS does not publish behaves exactly like a product
 * that simply has not had its turn in the rotation yet: no error reaches the
 * page, the menu just never lists it. The catalogue said eighty-seven and the
 * radar row showed twenty or thirty, and the gap was invisible from either
 * end.
 *
 * The truth is not written down twice. tools/mrms-catalogue.txt is a listing
 * of NOAA's own MRMS bucket, and every path in radar_pipeline.py is checked
 * against it. Refresh the listing with tools/refresh-mrms-catalogue.sh.
 *
 * Offline: no network, so it runs in the ordinary suite.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

// ── NOAA's catalogue ───────────────────────────────────────────────────────
// The bucket carries an elevation suffix that the NCEP web server drops, so
// both spellings count as the same product.
const catalogue = readFileSync(join(ROOT, 'tools/mrms-catalogue.txt'), 'utf8')
  .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
// The suffix is noise for a flat 2D mosaic and is the whole identity for a
// slice of the 3D stack, where it is the only thing separating 1 km from
// 2 km. So both spellings are kept and each product is matched against the
// right one.
const norm = p => p.replace(/(_\d\d\.\d\d|_scale_1)$/, '');
const known = new Set(catalogue.map(norm));
const knownExact = new Set(catalogue);

console.log('\n1. the catalogue listing is present and plausible');
ok('NOAA lists a few hundred CONUS products', catalogue.length > 150,
   String(catalogue.length));
ok('and the ones this app leans on are among them',
   ['MergedReflectivityQCComposite_00.50', 'MESH_Max_60min_00.50',
    'PrecipRate_00.00'].every(p => catalogue.includes(p)));

// ── What the pipeline asks for ─────────────────────────────────────────────
const py = readFileSync(join(ROOT, 'pi/radar_pipeline.py'), 'utf8');
const start = py.indexOf('MRMS_PRODUCTS = {');
const end = py.indexOf('\n}\n', start);
const block = py.slice(start, end);

// One entry is a key and a body; the body names a path and may name a base.
const entries = [];
const re = /^    "([a-z0-9_]+)":\s*\{([\s\S]*?)\},\s*$/gm;
let m;
while ((m = re.exec(block)) !== null) {
  const body = m[2];
  const path = /"path":\s*"([^"]+)"/.exec(body);
  if (!path) continue;
  entries.push({ key: m[1], path: path[1], flash: /FLASH_BASE/.test(body),
                 refl3d: /REFL3D_BASE/.test(body) });
}

console.log('\n2. every product the pipeline asks for really exists');
ok('the catalogue in the pipeline is not empty', entries.length > 50,
   String(entries.length));

// FLASH products live in their own tree and drop the FLASH_ prefix from the
// address, so both spellings are accepted for those.
const resolves = (e) => (e.refl3d ? knownExact.has(e.path) : known.has(e.path))
  || (e.flash && known.has('FLASH_' + e.path));
const dead = entries.filter(e => !resolves(e));
ok('no entry points at an address MRMS does not serve', dead.length === 0,
   dead.map(d => `${d.key}=${d.path}`).join(' '));

console.log('\n3. no product is asked for twice under two names');
{
  // Two keys on one address is wasted budget: the same grid downloaded twice
  // a pass, and two rows in the menu that always agree. It happened once
  // already, when the lightning densities were re-added under new names
  // beside the broken old ones.
  const byPath = new Map();
  entries.forEach(e => {
    const k = e.refl3d ? '3D/' + e.path
      : (e.flash ? 'FLASH/' : '2D/') + norm(e.path);
    byPath.set(k, (byPath.get(k) || []).concat(e.key));
  });
  const dupes = [...byPath.entries()].filter(([, keys]) => keys.length > 1);
  ok('each address is claimed by exactly one product key', dupes.length === 0,
     dupes.map(([p, k]) => `${p}<-${k.join(',')}`).join(' '));

  const keys = entries.map(e => e.key);
  ok('and no product key is defined twice',
     new Set(keys).size === keys.length);
}

console.log('\n4. the pass can get through the catalogue');
{
  // The menu is drawn from what has actually been built, so a catalogue the
  // pass cannot walk is a menu that never fills. Five minutes a pass, and a
  // first build has to happen before a product can appear at all.
  const num = (name, dflt) => {
    const r = new RegExp(name + '\\s*=\\s*(?:float|int)\\(os\\.environ\\.get\\('
                         + '"[^"]+",\\s*"([\\d.]+)"\\)\\)');
    const mm = r.exec(py);
    return mm ? Number(mm[1]) : dflt;
  };
  const perPass = num('MRMS_PASS_MAX', 0);
  const passes = Math.ceil(entries.length / perPass);
  ok('a first pass over everything takes under half an hour',
     passes * 5 <= 30, `${entries.length} products, ${perPass} a pass, `
     + `${passes} passes = ${passes * 5} min`);
  // The ordering rule that makes the first hour bearable.
  ok('products never built jump the queue',
     /never\s*=\s*\[n for n in names if not \(state\.get\(n\) or \{\}\)\.get\("last"\)\]/
       .test(py));
}

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
