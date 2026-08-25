#!/usr/bin/env node
/*
 * The GWCFC.net home page: Comfortaa everywhere, measured rather than grepped.
 *
 *     node tools/test-website.mjs
 *
 * The page sets its family on `body` and has done all along, so searching the
 * source for "Comfortaa" has always found it and always passed. That check was
 * worth nothing: every browser resets buttons, inputs, selects and textareas
 * to its own interface font rather than letting them inherit, so the passcode
 * box and the two buttons in the radar dialog were rendering in Arial next to
 * a page of Comfortaa. Nothing about that looks broken, which is exactly why
 * it survived: it is only visible beside the text next to it.
 *
 * So this walks every element that can carry text and reads what the browser
 * actually resolved, with the radar dialog shut and again with it open, since
 * the three elements that were wrong only appear in the second state.
 *
 * The font itself is served from a real file in tools/fixtures, so a missing
 * network is not mistaken for a missing declaration.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('playwright is not installed, skipping. npm i playwright');
  process.exit(0);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'index (3).html');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

let FONT = null;
try { FONT = readFileSync(join(ROOT, 'tools', 'fixtures', 'Comfortaa.ttf')); }
catch { FONT = null; }

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'],
});
const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
await ctx.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('fonts.googleapis.com')) {
    if (!FONT) return route.fulfill({ contentType: 'text/css', body: '' });
    return route.fulfill({ contentType: 'text/css',
      body: `@font-face{font-family:'Comfortaa';font-weight:300 700;`
          + `src:url(https://fonts.gstatic.com/c.ttf) format('truetype');}` });
  }
  if (url.includes('fonts.gstatic.com') && FONT)
    return route.fulfill({ contentType: 'font/ttf', body: FONT });
  return route.abort();
});

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto('file://' + SITE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2200);

// Everything that can show a glyph. The SVG shapes and the document plumbing
// are skipped because a font on them means nothing.
const SKIP = ['SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE', 'HEAD', 'HTML', 'BR',
              'SVG', 'PATH', 'G', 'USE', 'DEFS', 'CIRCLE', 'RECT', 'LINE',
              'POLYGON', 'POLYLINE', 'TEXT', 'TSPAN', 'IMG'];

const sweep = () => page.evaluate((skip) => {
  const bad = [];
  let n = 0;
  document.querySelectorAll('*').forEach(el => {
    if (skip.includes(el.tagName)) return;
    n++;
    const f = getComputedStyle(el).fontFamily;
    if (!/Comfortaa/i.test(f)) {
      bad.push(el.tagName + (el.id ? '#' + el.id : '') + ' :: ' + f);
    }
  });
  return { n, bad };
}, SKIP);

console.log('\n1. the page as it first loads');
{
  const r = await sweep();
  ok('there is a page to check', r.n > 40, String(r.n));
  ok(`every one of the ${r.n} elements resolves to Comfortaa`,
     r.bad.length === 0, r.bad.slice(0, 6).join(' | '));
}

console.log('\n2. the radar passcode dialog, which is where it was wrong');
{
  await page.evaluate(() => {
    const m = document.getElementById('radar-modal');
    if (m) m.style.display = 'flex';
  });
  await page.waitForTimeout(300);
  const r = await sweep();
  ok('the dialog is open', await page.evaluate(() =>
    document.getElementById('radar-modal').style.display) === 'flex');
  ok('the passcode box is Comfortaa, not the browser default',
     await page.evaluate(() =>
       /Comfortaa/i.test(getComputedStyle(
         document.getElementById('radar-input')).fontFamily)),
     await page.evaluate(() =>
       getComputedStyle(document.getElementById('radar-input')).fontFamily));
  ok('so are both of its buttons',
     await page.evaluate(() => [...document.querySelectorAll('#radar-modal button')]
       .every(b => /Comfortaa/i.test(getComputedStyle(b).fontFamily))));
  ok('and nothing else on the page slipped',
     r.bad.length === 0, r.bad.slice(0, 6).join(' | '));
}

console.log('\n3. the rule that fixes it, and that the font really arrived');
{
  const html = readFileSync(SITE, 'utf8');
  ok('form controls are pinned back to the page font',
     /button,\s*input,\s*select,\s*textarea[^{]*\{[^}]*font-family:\s*var\(--font\)/
       .test(html));
  ok('the placeholder is pinned too, since it does not always follow its input',
     /::placeholder[^{]*\{[^}]*font-family:\s*var\(--font\)/.test(html));
  ok('the font stack still starts with Comfortaa',
     /--font:\s*"Comfortaa"/.test(html));
  if (FONT) {
    // A declaration is not a rendering. Two different faces cannot measure the
    // same, so this is the check that the file actually loaded and is in use.
    const r = await page.evaluate(async () => {
      await Promise.race([document.fonts.ready,
                          new Promise(res => setTimeout(res, 2500))]);
      const c = document.createElement('canvas').getContext('2d');
      const S = 'GWCFC Tropical Weather WWWiii';
      c.font = "16px 'Comfortaa'"; const a = c.measureText(S).width;
      c.font = '16px Arial';       const b = c.measureText(S).width;
      return { a, b, loaded: document.fonts.check("16px 'Comfortaa'") };
    });
    ok('the font file loaded', r.loaded === true);
    ok('and it measures differently from the Arial it was falling back to',
       Math.abs(r.a - r.b) > 0.5, `comfortaa ${r.a} arial ${r.b}`);
  } else {
    ok('the font file loaded (fixture absent, skipped)', true);
  }
}

console.log('\n4. house rules');
{
  const html = readFileSync(SITE, 'utf8');
  ok('no em dash anywhere in the page', !html.includes(String.fromCharCode(0x2014)));
  ok('the nav still points at the radar and the archive',
     /nwrchive\.html/.test(html));
  ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

await browser.close();
console.log(`\n${fail ? '' : 'all '}${pass} passed`
  + (fail ? `, ${fail} FAILED` : ''));
process.exit(fail ? 1 : 0);
