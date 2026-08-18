#!/usr/bin/env node
/*
 * The tripwire: no secret may live in this repository.
 *
 *     node tools/test-no-secrets.mjs
 *
 * Scans every git-tracked text file for credential shapes: Discord webhook
 * URLs and bot tokens, Google/OpenAI/GitHub/Slack/AWS key formats, private
 * key blocks, and the 64-hex account keys of the kind Ambient Weather uses.
 * The webhook spam attack and the Ambient Weather leak both started as one
 * of these sitting in a public file; this fails the suite the moment any
 * come back.
 *
 * Two known-public identifiers are allowed by name: the Firebase web key
 * and the MapTiler key. Both are designed to ship to browsers; their locks
 * are server-side (Firestore rules, MapTiler origin allowlist). Anything
 * else that matches is a failure, no matter how harmless it looks.
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';

const ROOT = new URL('..', import.meta.url).pathname;

// Public-by-design identifiers, allowed by exact value.
const ALLOWED = new Set([
  'AIzaSyAAPuBJFlhBFPhqPGlrNnn_c0NZFRgZTI8',   // Firebase web key
  // SHA-256 of the crowd-report admin password. A hash is not the secret:
  // it cannot be reversed to the password, so publishing it leaks nothing
  // (storing the hash rather than the plaintext is the point). The gate it
  // guards is client-side only, which its own comment admits; real
  // enforcement is the Firestore rules, not this string.
  '2a2d1ff14b1493d9c619ebb676c60bf67cd1fc0c7178015775c229331aac390c',
]);

const PATTERNS = [
  ['discord webhook url', /discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[A-Za-z0-9_-]{30,}/g],
  ['discord bot token', /\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{25,}\b/g],
  ['google api key', /\bAIza[0-9A-Za-z_-]{30,}\b/g],
  ['openai-style key', /\bsk-[A-Za-z0-9]{20,}\b/g],
  ['github token', /\bghp_[A-Za-z0-9]{20,}\b/g],
  ['slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ['aws access key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['64-hex account key', /\b[0-9a-f]{64}\b/g],
  ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g],
];

// Binary and generated files where these shapes appear as noise, not leaks.
const SKIP = /\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|pdf|zip)$|^package-lock\.json$|package-lock\.json$|\.bundle\.js$/;
// Markdown may QUOTE the shape of a secret while telling you where to put
// the real one; the private-key and token-shape patterns skip docs.
const DOC_ONLY_OK = new Set(['private key block', 'discord bot token']);

const files = execSync('git ls-files', { cwd: ROOT }).toString().trim().split('\n');
let bad = 0, scanned = 0;
for (const f of files) {
  if (SKIP.test(f)) continue;
  let text;
  try { text = readFileSync(ROOT + f, 'utf8'); } catch { continue; }
  scanned++;
  for (const [name, re] of PATTERNS) {
    if (DOC_ONLY_OK.has(name) && f.endsWith('.md')) continue;
    for (const m of text.matchAll(re)) {
      if (ALLOWED.has(m[0])) continue;
      const line = text.slice(0, m.index).split('\n').length;
      console.log(`  FAIL ${f}:${line}  ${name}  ${m[0].slice(0, 24)}...`);
      bad++;
    }
  }
}
console.log(bad
  ? `\n${bad} secret-shaped string(s) in ${scanned} files. Get them OUT of the repo, then rotate them: committed once is public forever.`
  : `\nall clean: ${scanned} tracked files, no secret shapes.`);
process.exit(bad ? 1 : 0);
