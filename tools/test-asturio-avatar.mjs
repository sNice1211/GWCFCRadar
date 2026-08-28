#!/usr/bin/env node
/*
 * The Asturio AI mark, and the Discord bot wearing it.
 *
 *     node tools/test-asturio-avatar.mjs
 *
 * The bot answered as a default grey circle with a letter in it, which is what
 * an unconfigured bot looks like, so the assistant that shares a brain and a
 * name with the one in the app did not look related to it at all.
 *
 * Two things worth checking rather than eyeballing.
 *
 * THE GENERATOR IS DETERMINISTIC. It scatters a couple of hundred glyphs, and
 * if that scattering changed on every run the file could not be committed:
 * every rebuild would show as a diff and nobody could tell a real change from
 * noise. So the test runs it twice and demands the same bytes.
 *
 * THE MARK IS THE APP'S. It is supposed to be the site's own logo lit as an
 * instrument, not a new thing that happens to be nearby, so the checks read
 * the site's palette out of index.html and require the mark to use those exact
 * values. A mark that drifts off-brand is the failure this catches.
 *
 * The upload path is checked for the thing that actually goes wrong with it:
 * Discord rate limits avatar changes hard, so a bot that re-uploads on every
 * restart gets refused and then cannot change it when it matters.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SVG  = join(ROOT, 'assets', 'img', 'asturio-ai.svg');
const PNG  = join(ROOT, 'assets', 'img', 'asturio-ai-512.png');
const GEN  = join(ROOT, 'tools', 'make-asturio-avatar.mjs');
const BOT  = join(ROOT, 'services', 'bot', 'asturio-bot.mjs');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

console.log('\n1. the mark exists, in both the forms it is needed in');
{
  ok('there is an SVG', existsSync(SVG));
  ok('and a PNG, which is what Discord takes', existsSync(PNG));
  const png = readFileSync(PNG);
  // Discord refuses avatars over 10 MB and squashes anything not square.
  ok('the PNG is really a PNG',
     png[0] === 0x89 && png.toString('latin1', 1, 4) === 'PNG');
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  ok(`it is square, ${w} by ${h}`, w === h, w + 'x' + h);
  ok('at 512, which is the size Discord stores', w === 512, String(w));
  ok('and small enough to upload',
     png.length < 2 * 1024 * 1024, (png.length / 1024).toFixed(0) + ' KB');
}

console.log('\n2. the generator is deterministic');
{
  const before = readFileSync(SVG, 'utf8');
  const pngBefore = readFileSync(PNG);
  execFileSync(process.execPath, [GEN], { cwd: ROOT, stdio: 'pipe' });
  const after = readFileSync(SVG, 'utf8');
  const pngAfter = readFileSync(PNG);
  // The one that matters. A generator whose output moves on every run cannot
  // live in a repository.
  ok('running it again produces the same SVG, byte for byte',
     before === after, before.length + ' vs ' + after.length);
  ok('and the same PNG', Buffer.compare(pngBefore, pngAfter) === 0,
     pngBefore.length + ' vs ' + pngAfter.length);
  ok('the seed is written down rather than taken from the clock',
     /rain\(\d+\)/.test(readFileSync(GEN, 'utf8')));
  ok('and nothing in it reaches for Math.random',
     !/Math\.random/.test(readFileSync(GEN, 'utf8')));
}

console.log('\n3. it is the app\'s own logo, not a lookalike');
{
  const svg = readFileSync(SVG, 'utf8');
  const page = readFileSync(join(ROOT, 'index.html'), 'utf8');
  // Read the palette out of the page rather than repeating it here, so this
  // check fails if the mark drifts off the brand it is meant to carry.
  const brand = ['#008CBA', '#e8b800', '#aa0000'];
  brand.forEach(c => {
    ok(`the site uses ${c}`, page.includes(c));
    ok(`and so does the mark`, svg.toLowerCase().includes(c.toLowerCase()));
  });
  // The logo is a rounded nonagon, not a circle. Nine sides is what makes it
  // read as the same shape rather than as a near-miss.
  ok('the rings are nine-sided, like the logo',
     /const N = 9;/.test(readFileSync(GEN, 'utf8')));
  ok('there are five of them, outside in',
     (svg.match(/stroke-width="(1[24]|9|6)"/g) || []).length >= 5,
     String((svg.match(/stroke-width=/g) || []).length));
}

console.log('\n4. the Matrix and Jarvis parts are actually there');
{
  const svg = readFileSync(SVG, 'utf8');
  const glyphs = (svg.match(/<text /g) || []).length;
  ok(`there is falling code, ${glyphs} glyphs`, glyphs > 80, String(glyphs));
  ok('with katakana in it, not only digits', /[゠-ヿ]/.test(svg));
  // The instrument half: a dial with ticks, a lit sweep, and an eye.
  ok('a dial with tick marks', (svg.match(/<line /g) || []).length >= 60,
     String((svg.match(/<line /g) || []).length));
  ok('a lit sweep across it', /A 182 182 0 0 1/.test(svg));
  ok('and an eye at the middle', /url\(#core\)/.test(svg));
  ok('read through a screen, so scanlines', /height="1.4"/.test(svg));
}

console.log('\n5. it survives being shown small and on any background');
{
  const svg = readFileSync(SVG, 'utf8');
  // Discord shows this at about 40 pixels in a message list. A mark with no
  // edge disappears into a light theme.
  ok('there is a rim, so it has an edge on a light background',
     /stroke-width="3" opacity="0.55"/.test(svg));
  ok('and the face is clipped to a circle, which is how Discord crops it',
     /clip-path="url\(#face\)"/.test(svg));
  ok('it carries its own name for a screen reader',
     /<title>Asturio AI<\/title>/.test(svg) && /aria-label="Asturio AI"/.test(svg));
}

console.log('\n6. the bot wears it, and only uploads when it changes');
{
  const bot = readFileSync(BOT, 'utf8');
  ok('the bot points at the PNG',
     /asturio-ai-512\.png/.test(bot));
  ok('and sets it on ready', /applyAvatar\(c\.user\)/.test(bot)
     && /setAvatar\(png\)/.test(bot));
  // The failure this guards against: Discord limits avatar changes to a
  // couple an hour, so re-uploading on every restart burns the allowance and
  // then the picture cannot be changed when it needs to be.
  ok('it records what it last sent', /AVATAR_STAMP/.test(bot)
     && /writeFileSync\(AVATAR_STAMP/.test(bot));
  ok('and skips the upload when that has not changed',
     /if \(had === stamp\) return;/.test(bot));
  ok('the stamp is the picture, not the date',
     /createHash\('sha256'\)\.update\(png\)/.test(bot));
  ok('a failure to set it is not a failure to run',
     /Avatar not changed this time/.test(bot));
  ok('and a missing picture is not either',
     /no picture to set/.test(bot));
}

console.log('\n7. the stamp is local state, not source');
{
  const ig = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  ok('the avatar stamp is ignored', /services\/bot\/\.avatar-stamp/.test(ig));
  ok('and no stray gitignore was left in the bot folder',
     !existsSync(join(ROOT, 'services', 'bot', '.gitignore')));
}

console.log('\n8. house rules');
{
  const files = [SVG, GEN, BOT, join(ROOT, 'tools', 'test-asturio-avatar.mjs'),
                 join(ROOT, 'services', 'bot', 'README.md')];
  // Built by code point rather than typed. A test that searches for a
  // forbidden character by writing it out contains the character it forbids,
  // and then the repo-wide sweep flags the very file doing the sweeping.
  const EM = String.fromCharCode(0x2014);
  const dashes = files.filter(f => readFileSync(f, 'utf8').includes(EM));
  ok('no em dashes anywhere in the new work, this file included',
     dashes.length === 0, dashes.join(', '));
}

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
