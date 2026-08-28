#!/usr/bin/env node
/*
 * The assistant's background set.
 *
 *     node tools/make-backgrounds.mjs
 *
 * WHY THESE ARE DRAWN RATHER THAN DOWNLOADED
 *
 * The ask was to find images online. Two things are in the way of that, and
 * both of them are the kind that bite later rather than now.
 *
 * A picture found online has an owner. Committing one into a public
 * repository publishes it again, and "it was on the internet" is not a
 * licence. The set that IS safe to take, NASA and NOAA imagery, is public
 * domain and genuinely on theme for hurricanes, but this machine cannot reach
 * either host, so it could not be fetched even where it was allowed.
 *
 * Drawn instead: original, so there is nothing to licence; vector, so a few
 * kilobytes covers a phone and a 5K display alike where a photograph would be
 * megabytes; and in the site's own red, gold and blue, so the room still
 * looks like one room whichever is picked.
 *
 * And the part that actually answers the ask: the page takes an upload. Any
 * picture, from anywhere, chosen by the person whose assistant it is. That is
 * the honest way to get an arbitrary image in, rather than me guessing at
 * eight of them.
 *
 * Everything random is SEEDED. A generator whose output moves on every run
 * cannot be committed: every rebuild shows as a diff and nobody can tell a
 * real change from noise.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT  = join(ROOT, 'assets', 'bg');

// The site's scheme, plus the blue that was asked for by name.
const RED = '#aa0000', HOT = '#d81616', EMBER = '#ff5a2b';
const GOLD = '#e8b800', GOLD_HI = '#ffd76a';
const BLUE = '#0d5f9e', BLUE_HI = '#3aa6e8';
const PALE = '#f3e6c8', INK = '#0b0503';

const W = 1600, H = 1000;

function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const n = (v) => Number(v).toFixed(1);

// Every background sits on the same dark ground, so switching one for another
// changes the picture and not the brightness of the room.
function wrap(inner, defs) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"
     viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice">
  <defs>
    <radialGradient id="ground" cx="50%" cy="38%" r="78%">
      <stop offset="0%" stop-color="#2a0a06"/>
      <stop offset="55%" stop-color="#170806"/>
      <stop offset="100%" stop-color="${INK}"/>
    </radialGradient>
${defs || ''}
  </defs>
  <rect width="${W}" height="${H}" fill="url(#ground)"/>
${inner}
</svg>
`;
}

/* ── Hurricane ────────────────────────────────────────────────────────────
   Logarithmic spiral bands, which is the shape a real cyclone actually
   makes: r grows by a constant factor per turn, so the bands open out as
   they go rather than staying the same width like a clock spring. */
function hurricane() {
  const r = rng(1101);
  const cx = W * 0.5, cy = H * 0.5;
  const arms = [];
  const N = 7;
  for (let a = 0; a < N; a++) {
    const off = (a / N) * Math.PI * 2;
    const pts = [];
    for (let t = 1.0; t < 13.2; t += 0.05) {
      const rad = 21 * Math.exp(0.26 * t);
      pts.push([cx + rad * Math.cos(t + off), cy + rad * Math.sin(t + off) * 0.62]);
    }
    const d = pts.map((p, i) => (i ? 'L' : 'M') + n(p[0]) + ' ' + n(p[1])).join(' ');
    const c = a % 3 === 0 ? GOLD : (a % 3 === 1 ? HOT : BLUE);
    arms.push(`<path d="${d}" fill="none" stroke="${c}" stroke-width="${(34 + r() * 40).toFixed(0)}"
      stroke-linecap="round" opacity="${(0.2 + r() * 0.18).toFixed(2)}"
      filter="url(#soft)"/>`);
    // A thinner, brighter line inside each band gives it an edge, which is
    // what stops seven blurs reading as one smudge.
    arms.push(`<path d="${d}" fill="none" stroke="${c}" stroke-width="2.5"
      opacity="0.3"/>`);
  }
  const eye = `
    <ellipse cx="${cx}" cy="${cy}" rx="66" ry="42" fill="${INK}" opacity="0.94"/>
    <ellipse cx="${cx}" cy="${cy}" rx="66" ry="42" fill="none"
             stroke="${GOLD_HI}" stroke-width="3" opacity="0.55" filter="url(#soft)"/>
    <ellipse cx="${cx}" cy="${cy}" rx="112" ry="72" fill="none"
             stroke="${EMBER}" stroke-width="10" opacity="0.2" filter="url(#soft)"/>`;
  return wrap(arms.join('\n  ') + eye,
    `<filter id="soft" x="-25%" y="-25%" width="150%" height="150%">
       <feGaussianBlur stdDeviation="18"/></filter>`);
}

/* ── Baseball field ───────────────────────────────────────────────────────
   The diamond as geometry rather than as a photograph: the infield square,
   the base paths, the pitcher's circle and the outfield arc, which is the
   set of lines that make the shape recognisable from across a room. */
function diamond() {
  const cx = W * 0.5, hp = H * 0.86;            // home plate
  const side = 300;                              // base path length
  const s = side / Math.SQRT2;
  const b1 = [cx + s, hp - s], b2 = [cx, hp - s * 2], b3 = [cx - s, hp - s];
  const arc = (rad) =>
    `M ${n(cx - rad)} ${n(hp)} A ${n(rad)} ${n(rad)} 0 0 1 ${n(cx + rad)} ${n(hp)}`;
  const g = [];
  // The outfield, as three arcs stepping outward in the three colours.
  [[860, BLUE, 0.3], [660, HOT, 0.26], [470, GOLD, 0.24]].forEach(([rad, c, o]) => {
    g.push(`<path d="${arc(rad)}" fill="none" stroke="${c}" stroke-width="3"
      opacity="${o}" filter="url(#glow)"/>`);
  });
  // The infield dirt, as a filled arc behind the diamond.
  g.push(`<path d="${arc(400)} Z" fill="${RED}" opacity="0.13"/>`);
  // The diamond itself.
  const dia = `M ${n(cx)} ${n(hp)} L ${n(b1[0])} ${n(b1[1])}
               L ${n(b2[0])} ${n(b2[1])} L ${n(b3[0])} ${n(b3[1])} Z`;
  g.push(`<path d="${dia}" fill="${GOLD}" opacity="0.07"/>`);
  g.push(`<path d="${dia}" fill="none" stroke="${GOLD_HI}" stroke-width="3.5"
    opacity="0.6" filter="url(#glow)"/>`);
  // Foul lines, running past the bases and off the frame.
  g.push(`<path d="M ${n(cx)} ${n(hp)} L ${n(cx + 980)} ${n(hp - 980)}"
    stroke="${PALE}" stroke-width="2.5" opacity="0.28"/>`);
  g.push(`<path d="M ${n(cx)} ${n(hp)} L ${n(cx - 980)} ${n(hp - 980)}"
    stroke="${PALE}" stroke-width="2.5" opacity="0.28"/>`);
  // The bases and the mound.
  [[cx, hp], b1, b2, b3].forEach((p, i) => {
    g.push(`<rect x="${n(p[0] - 11)}" y="${n(p[1] - 11)}" width="22" height="22"
      transform="rotate(45 ${n(p[0])} ${n(p[1])})"
      fill="${i === 0 ? PALE : GOLD_HI}" opacity="0.75" filter="url(#glow)"/>`);
  });
  g.push(`<circle cx="${n(cx)}" cy="${n(hp - s)}" r="34" fill="none"
    stroke="${HOT}" stroke-width="3" opacity="0.5" filter="url(#glow)"/>`);
  return wrap(g.join('\n  '),
    `<filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
       <feGaussianBlur stdDeviation="4" result="b"/>
       <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
     </filter>`);
}

/* ── Geometric ────────────────────────────────────────────────────────────
   Triangles in the three colours, overlapping with a screen blend so the
   overlaps make new colours rather than just stacking. This is the one the
   ask named directly: shapes, in red and gold and blue. */
function geometric() {
  const r = rng(4242);
  const out = [];
  const cols = [RED, HOT, GOLD, GOLD_HI, BLUE, BLUE_HI];
  for (let i = 0; i < 46; i++) {
    const cx = r() * W, cy = r() * H;
    const size = 70 + r() * 330;
    const rot = r() * 360;
    const c = cols[(r() * cols.length) | 0];
    const pts = [[0, -size / 2], [size / 2, size / 2], [-size / 2, size / 2]]
      .map(p => n(cx + p[0]) + ',' + n(cy + p[1])).join(' ');
    const filled = r() < 0.35;
    out.push(`<polygon points="${pts}" transform="rotate(${n(rot)} ${n(cx)} ${n(cy)})"
      ${filled ? `fill="${c}" opacity="${(0.05 + r() * 0.07).toFixed(3)}"`
               : `fill="none" stroke="${c}" stroke-width="${(1 + r() * 2.5).toFixed(1)}"
                  opacity="${(0.16 + r() * 0.3).toFixed(3)}"`}/>`);
  }
  // A few hexagons, so it is not only triangles.
  for (let i = 0; i < 12; i++) {
    const cx = r() * W, cy = r() * H, rad = 40 + r() * 150;
    const pts = Array.from({ length: 6 }, (_, k) => {
      const a = (k / 6) * Math.PI * 2;
      return n(cx + rad * Math.cos(a)) + ',' + n(cy + rad * Math.sin(a));
    }).join(' ');
    out.push(`<polygon points="${pts}" fill="none" stroke="${cols[(r() * cols.length) | 0]}"
      stroke-width="1.6" opacity="${(0.14 + r() * 0.22).toFixed(3)}"/>`);
  }
  return wrap(`<g style="mix-blend-mode:screen">\n  ${out.join('\n  ')}\n</g>`);
}

/* ── Radar sweep ──────────────────────────────────────────────────────────
   The instrument this whole thing grew out of: range rings, bearing spokes,
   a lit sector, and a scatter of returns. */
function sweep() {
  const r = rng(7788);
  const cx = W / 2, cy = H / 2;
  const out = [];
  for (let i = 1; i <= 6; i++) {
    out.push(`<circle cx="${cx}" cy="${cy}" r="${i * 78}" fill="none"
      stroke="${i % 2 ? GOLD : BLUE}" stroke-width="1.4"
      opacity="${(0.34 - i * 0.03).toFixed(2)}"/>`);
  }
  for (let a = 0; a < 12; a++) {
    const t = (a / 12) * Math.PI * 2;
    out.push(`<line x1="${cx}" y1="${cy}" x2="${n(cx + 470 * Math.cos(t))}"
      y2="${n(cy + 470 * Math.sin(t))}" stroke="${GOLD}" stroke-width="1"
      opacity="0.16"/>`);
  }
  out.push(`<path d="M ${cx} ${cy} L ${n(cx + 470 * Math.cos(-1.35))}
    ${n(cy + 470 * Math.sin(-1.35))} A 470 470 0 0 1
    ${n(cx + 470 * Math.cos(-0.15))} ${n(cy + 470 * Math.sin(-0.15))} Z"
    fill="url(#fan)" opacity="0.5"/>`);
  // Returns, weighted toward the middle so the picture has a storm in it
  // rather than an even dusting.
  for (let i = 0; i < 200; i++) {
    const t = r() * Math.PI * 2, rad = Math.pow(r(), 0.6) * 460;
    const x = cx + rad * Math.cos(t), y = cy + rad * Math.sin(t);
    const near = 1 - rad / 460;
    const c = near > 0.7 ? EMBER : (near > 0.45 ? GOLD : BLUE_HI);
    out.push(`<circle cx="${n(x)}" cy="${n(y)}" r="${(1.4 + r() * 4.5).toFixed(1)}"
      fill="${c}" opacity="${(0.12 + near * 0.4).toFixed(2)}"/>`);
  }
  return wrap(out.join('\n  '),
    `<radialGradient id="fan" cx="50%" cy="50%" r="50%">
       <stop offset="0%" stop-color="${GOLD_HI}" stop-opacity="0.5"/>
       <stop offset="100%" stop-color="${GOLD}" stop-opacity="0"/>
     </radialGradient>`);
}

/* ── Circuit ──────────────────────────────────────────────────────────────
   Traces that turn at right angles and forty five degrees, which is what
   makes a drawing read as a board rather than as a maze. */
function circuit() {
  const r = rng(9090);
  const out = [];
  const GRID = 40;
  for (let i = 0; i < 60; i++) {
    let x = Math.round(r() * (W / GRID)) * GRID;
    let y = Math.round(r() * (H / GRID)) * GRID;
    let d = 'M ' + x + ' ' + y;
    const len = 3 + ((r() * 7) | 0);
    for (let k = 0; k < len; k++) {
      const dir = (r() * 4) | 0;
      const step = GRID * (1 + ((r() * 3) | 0));
      if (dir === 0) x += step; else if (dir === 1) x -= step;
      else if (dir === 2) y += step; else y -= step;
      x = Math.max(0, Math.min(W, x)); y = Math.max(0, Math.min(H, y));
      d += ' L ' + x + ' ' + y;
    }
    const c = r() < 0.4 ? GOLD : (r() < 0.6 ? BLUE_HI : HOT);
    out.push(`<path d="${d}" fill="none" stroke="${c}" stroke-width="1.6"
      opacity="${(0.14 + r() * 0.26).toFixed(2)}" stroke-linejoin="round"/>`);
    out.push(`<circle cx="${x}" cy="${y}" r="4" fill="${c}"
      opacity="${(0.3 + r() * 0.4).toFixed(2)}"/>`);
  }
  return wrap(out.join('\n  '));
}

/* ── Contours ─────────────────────────────────────────────────────────────
   Topographic lines from a sum of sine hills, which is how a contour map is
   actually made: pick a height, trace where the surface crosses it. Done
   here by marching a coarse grid, which is plenty at this scale. */
function contours() {
  const r = rng(3131);
  // Kept inside the frame with a margin, because a hill centred off the edge
  // contributes a few flat arcs and nothing else.
  const hills = Array.from({ length: 7 }, () => ({
    x: W * (0.12 + r() * 0.76), y: H * (0.12 + r() * 0.76),
    a: 0.7 + r() * 0.8, s: 170 + r() * 260,
  }));
  const field = (x, y) => hills.reduce((v, h) =>
    v + h.a * Math.exp(-((x - h.x) ** 2 + (y - h.y) ** 2) / (2 * h.s * h.s)), 0);
  const out = [];
  const STEP = 10;
  // The levels stop at the height the surface actually reaches. Running
  // past it draws nothing, which is how a third of the lines went missing.
  let peak = 0;
  for (let y = 0; y < H; y += 20) for (let x = 0; x < W; x += 20)
    peak = Math.max(peak, field(x, y));
  const LEVELS = 16;
  for (let li = 1; li <= LEVELS; li++) {
    const level = (li / (LEVELS + 1)) * peak;
    const segs = [];
    for (let y = 0; y < H; y += STEP) {
      for (let x = 0; x < W; x += STEP) {
        // Marching squares, the two-case version: a segment wherever the
        // level falls between a cell corner and its neighbour.
        const a = field(x, y), b = field(x + STEP, y), c = field(x, y + STEP);
        if ((a < level) !== (b < level)) {
          const t = (level - a) / (b - a || 1);
          segs.push(`M ${n(x + t * STEP)} ${y} l 0 ${STEP}`);
        }
        if ((a < level) !== (c < level)) {
          const t = (level - a) / (c - a || 1);
          segs.push(`M ${x} ${n(y + t * STEP)} l ${STEP} 0`);
        }
      }
    }
    const c = li % 3 === 0 ? GOLD : (li % 3 === 1 ? HOT : BLUE);
    out.push(`<path d="${segs.join(' ')}" fill="none" stroke="${c}"
      stroke-width="1.5" opacity="${(0.22 + (li / LEVELS) * 0.4).toFixed(2)}"/>`);
  }
  return wrap(out.join('\n  '));
}

/* ── Embers ───────────────────────────────────────────────────────────────
   Soft drifting light, for when the picture behind the words should be
   almost nothing at all. The quietest of the set on purpose: a background
   that competes with the text has stopped being a background. */
function embers() {
  const r = rng(5150);
  const out = [];
  for (let i = 0; i < 34; i++) {
    const x = r() * W, y = r() * H, rad = 60 + r() * 300;
    const c = r() < 0.45 ? GOLD : (r() < 0.7 ? HOT : BLUE);
    out.push(`<circle cx="${n(x)}" cy="${n(y)}" r="${n(rad)}" fill="${c}"
      opacity="${(0.03 + r() * 0.06).toFixed(3)}" filter="url(#big)"/>`);
  }
  for (let i = 0; i < 150; i++) {
    out.push(`<circle cx="${n(r() * W)}" cy="${n(r() * H)}"
      r="${(0.6 + r() * 1.8).toFixed(1)}" fill="${r() < 0.5 ? GOLD_HI : PALE}"
      opacity="${(0.15 + r() * 0.45).toFixed(2)}"/>`);
  }
  return wrap(out.join('\n  '),
    `<filter id="big" x="-50%" y="-50%" width="200%" height="200%">
       <feGaussianBlur stdDeviation="55"/></filter>`);
}

const SET = {
  hurricane, diamond, geometric, sweep, circuit, contours, embers,
};

mkdirSync(OUT, { recursive: true });
let total = 0;
for (const [name, fn] of Object.entries(SET)) {
  const svg = fn();
  writeFileSync(join(OUT, name + '.svg'), svg);
  total += svg.length;
  console.log('  ' + (name + '.svg').padEnd(18)
            + (svg.length / 1024).toFixed(1).padStart(7) + ' KB');
}
console.log('\n' + Object.keys(SET).length + ' backgrounds, '
          + (total / 1024).toFixed(0) + ' KB in total.');
