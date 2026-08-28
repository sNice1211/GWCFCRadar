#!/usr/bin/env node
/*
 * Builds the Asturio AI assistant mark: an SVG, and a PNG for Discord.
 *
 *     node tools/make-asturio-avatar.mjs
 *
 * The Discord bot had no face at all. It answered as a default grey circle
 * with a letter in it, which is what an unconfigured bot looks like, so the
 * assistant that shares its brain with the one in the app did not look
 * related to it in any way.
 *
 * The mark is BUILT rather than drawn by hand, for two reasons. It has to
 * stay in step with the app's own logo, which is a set of concentric rounded
 * nonagons in the site's red, gold and cyan, and a generator can be re-run
 * when that changes where a hand-drawn file just goes stale. And the Matrix
 * rain behind it is a hundred and fifty glyphs; placing those by hand is not
 * work, it is typing.
 *
 * Everything random here is SEEDED. A generator whose output changes on every
 * run cannot be committed, because every rebuild would show as a diff and
 * nobody could tell a real change from noise. Same seed, same file, byte for
 * byte.
 *
 * On the three references. Jarvis is a gold and cyan heads-up display, Ultron
 * is the same idea lit red, and the Matrix is falling glyphs. They share one
 * thing, which is a glowing instrument read through a dark screen, and the
 * app's logo is already red, gold and cyan. So the mark is the app's own
 * rings as a lit iris, with the rain behind it, rather than a green thing
 * that would look like a different product.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_SVG = join(ROOT, 'assets', 'img', 'asturio-ai.svg');
const OUT_PNG = join(ROOT, 'assets', 'img', 'asturio-ai-512.png');

const S = 512;                 // Discord shows avatars small; 512 is its own max
const C = S / 2;

// The site's palette, not an approximation of it. These are the values the
// page uses, so the mark cannot drift away from the app it belongs to.
const CY   = '#008CBA';        // the cyan of the outer ring and the UI accent
const RED  = '#aa0000';        // the app's red
const HOT  = '#d81616';        // the brighter red the warnings use
const GOLD = '#e8b800';        // the gold of the middle ring
const PALE = '#f3e6c8';        // the near-white ring inside the gold
const INK  = '#05080c';        // the screen this is read through

// A seeded generator, so the rain falls the same way every time.
// Mulberry32: small, fast, and good enough for scattering glyphs.
function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The logo is a rounded nonagon, not a circle: nine sides with the corners
// taken off. Reproduced here as a path so the rings read as the same shape
// rather than as circles that happen to be nearby.
function nonagon(cx, cy, r, round, rot) {
  const N = 9;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const a = rot + (i / N) * Math.PI * 2;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  let d = '';
  for (let i = 0; i < N; i++) {
    const p = pts[i], nx = pts[(i + 1) % N], pv = pts[(i + N - 1) % N];
    // Walk in from each corner by `round`, then arc across it.
    const inFrom = (a, b) => {
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1;
      const k = Math.min(round, len / 2) / len;
      return [a[0] + dx * k, a[1] + dy * k];
    };
    const a1 = inFrom(p, pv), a2 = inFrom(p, nx);
    d += (i === 0 ? `M ${a1[0].toFixed(2)} ${a1[1].toFixed(2)}`
                  : ` L ${a1[0].toFixed(2)} ${a1[1].toFixed(2)}`);
    d += ` Q ${p[0].toFixed(2)} ${p[1].toFixed(2)}`
       + ` ${a2[0].toFixed(2)} ${a2[1].toFixed(2)}`;
  }
  return d + ' Z';
}

// The rain: columns of glyphs down the face, brightest at the head of each
// run and fading up the trail, which is what makes it read as falling rather
// than as scattered text.
function rain(seed) {
  const r = rng(seed);
  const GLYPHS = '01アイウエオカキクケコサシスセソタチツテトナニヌネノ<>[]{}/\\|=+*';
  const COLS = 26, out = [];
  const colW = S / COLS;
  for (let c = 0; c < COLS; c++) {
    const x = c * colW + colW / 2;
    const runs = 1 + Math.floor(r() * 2);
    for (let k = 0; k < runs; k++) {
      const head = r() * S;
      const len = 4 + Math.floor(r() * 9);
      const step = 15;
      for (let i = 0; i < len; i++) {
        const y = head - i * step;
        if (y < -10 || y > S + 10) continue;
        // The head glyph is pale and the trail falls away behind it.
        const t = i / len;
        const op = (i === 0 ? 0.95 : 0.6 * (1 - t)) * (0.6 + r() * 0.4);
        if (op < 0.045) continue;
        const g = GLYPHS[Math.floor(r() * GLYPHS.length)];
        const fill = i === 0 ? PALE : (r() < 0.25 ? GOLD : CY);
        out.push(`<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" `
          + `font-family="monospace" font-size="15" text-anchor="middle" `
          + `fill="${fill}" opacity="${op.toFixed(3)}">${g}</text>`);
      }
    }
  }
  return out.join('\n    ');
}

// The instrument ring: tick marks round the outside, longer every fifth, the
// way a dial is read. This is the part that says "reading something" rather
// than "decorative circle".
function ticks(radius) {
  const out = [];
  const N = 60;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 - Math.PI / 2;
    const long = i % 5 === 0;
    const r1 = radius, r2 = radius + (long ? 11 : 6);
    out.push(`<line x1="${(C + r1 * Math.cos(a)).toFixed(1)}" `
      + `y1="${(C + r1 * Math.sin(a)).toFixed(1)}" `
      + `x2="${(C + r2 * Math.cos(a)).toFixed(1)}" `
      + `y2="${(C + r2 * Math.sin(a)).toFixed(1)}" `
      + `stroke="${long ? GOLD : CY}" stroke-width="${long ? 2 : 1}" `
      + `opacity="${long ? 0.75 : 0.4}"/>`);
  }
  return out.join('\n    ');
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}"
     viewBox="0 0 ${S} ${S}" role="img" aria-label="Asturio AI">
  <title>Asturio AI</title>
  <defs>
    <radialGradient id="screen" cx="50%" cy="42%" r="72%">
      <stop offset="0%"   stop-color="#0d1520"/>
      <stop offset="62%"  stop-color="#070c12"/>
      <stop offset="100%" stop-color="${INK}"/>
    </radialGradient>
    <radialGradient id="core" cx="50%" cy="50%" r="50%">
      <stop offset="0%"   stop-color="${PALE}" stop-opacity="0.95"/>
      <stop offset="38%"  stop-color="${GOLD}" stop-opacity="0.75"/>
      <stop offset="75%"  stop-color="${HOT}"  stop-opacity="0.5"/>
      <stop offset="100%" stop-color="${RED}"  stop-opacity="0"/>
    </radialGradient>
    <filter id="glow" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="5" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="soft" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="12"/>
    </filter>
    <clipPath id="face"><circle cx="${C}" cy="${C}" r="${C}"/></clipPath>
  </defs>

  <g clip-path="url(#face)">
    <rect width="${S}" height="${S}" fill="url(#screen)"/>

    <!-- The rain, held back so it is texture behind the instrument rather
         than the subject of the picture. -->
    <g opacity="0.85">
    ${rain(20260828)}
    </g>

    <!-- The dial. -->
    <g filter="url(#glow)">
    ${ticks(186)}
    </g>

    <!-- A sweep, the arc that says the instrument is live. Static in the
         file: an avatar is one frame, and a spinner that cannot spin reads
         as a broken one, so this is a lit sector rather than a needle. -->
    <path d="M ${C} ${C} L ${(C + 182 * Math.cos(-1.9)).toFixed(1)} ${(C + 182 * Math.sin(-1.9)).toFixed(1)}
             A 182 182 0 0 1 ${(C + 182 * Math.cos(-0.75)).toFixed(1)} ${(C + 182 * Math.sin(-0.75)).toFixed(1)} Z"
          fill="${CY}" opacity="0.13"/>

    <!-- The app's own rings, outside in, in the app's own order:
         cyan, red, gold, pale, then the dark red heart. -->
    <g fill="none" filter="url(#glow)">
      <path d="${nonagon(C, C, 150, 29, -Math.PI / 2)}" stroke="${CY}"   stroke-width="14" opacity="0.95"/>
      <path d="${nonagon(C, C, 124, 24, -Math.PI / 2)}" stroke="${RED}"  stroke-width="14" opacity="0.95"/>
      <path d="${nonagon(C, C,  99, 19, -Math.PI / 2)}" stroke="${GOLD}" stroke-width="9"  opacity="0.95"/>
      <path d="${nonagon(C, C,  82, 15, -Math.PI / 2)}" stroke="${PALE}" stroke-width="6"  opacity="0.85"/>
      <path d="${nonagon(C, C,  65, 12, -Math.PI / 2)}" stroke="${HOT}"  stroke-width="12" opacity="0.95"/>
    </g>

    <!-- The eye. Every one of the three references is, in the end, a lit
         thing looking back at you. -->
    <circle cx="${C}" cy="${C}" r="50" fill="url(#core)" filter="url(#soft)"/>
    <circle cx="${C}" cy="${C}" r="26" fill="url(#core)"/>
    <circle cx="${C}" cy="${C}" r="9" fill="${PALE}" opacity="0.9"/>

    <!-- Scanlines, the last thing, over everything, because a screen is what
         all of this is being read through. -->
    <g opacity="0.14">
      ${Array.from({ length: Math.floor(S / 4) }, (_, i) =>
        `<rect x="0" y="${i * 4}" width="${S}" height="1.4" fill="#000"/>`).join('\n      ')}
    </g>
  </g>

  <!-- The rim, so the mark still has an edge on a light background. -->
  <circle cx="${C}" cy="${C}" r="${C - 1.5}" fill="none"
          stroke="${CY}" stroke-width="3" opacity="0.55"/>
</svg>
`;

mkdirSync(dirname(OUT_SVG), { recursive: true });
writeFileSync(OUT_SVG, svg);
console.log('wrote ' + OUT_SVG.replace(ROOT + '/', '') + '  ' + svg.length + ' bytes');

// Discord wants a raster. Rendering it here rather than committing only an
// SVG means the bot has a file it can actually upload, and the two cannot
// disagree because one is made from the other.
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('playwright not installed, so the PNG was not rendered. '
            + 'The SVG is written; run this again where playwright is available.');
  process.exit(0);
}


const { readdirSync, existsSync } = await import('node:fs');
let exe = process.env.CHROME_PATH;
if (!exe) {
  try {
    for (const d of readdirSync('/opt/pw-browsers')) {
      if (!d.startsWith('chromium-')) continue;
      const p = join('/opt/pw-browsers', d, 'chrome-linux', 'chrome');
      if (existsSync(p)) { exe = p; break; }
    }
  } catch { /* fall through to Playwright's own */ }
}

const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({
  viewport: { width: S, height: S }, deviceScaleFactor: 1 });
await page.setContent(
  `<body style="margin:0;background:transparent">${svg}</body>`,
  { waitUntil: 'load' });
await page.screenshot({ path: OUT_PNG, omitBackground: true });
await browser.close();
console.log('wrote ' + OUT_PNG.replace(ROOT + '/', ''));
