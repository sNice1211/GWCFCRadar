#!/usr/bin/env node
/*
 * The personal assistant page.
 *
 *     npm i playwright && node tools/test-assistant.mjs
 *
 * assistant.html is a standalone AI assistant: the same brain the radar app
 * and the Discord bot use, behind a Jarvis-style instrument built from the
 * site's own logo, with Matrix rain behind it.
 *
 * The things worth checking rather than eyeballing are the ones that are
 * quietly wrong on a page like this and never announce themselves.
 *
 * ESCAPING. Model output goes into innerHTML. A reply containing a tag would
 * otherwise be executed, and nothing about the page would look broken until
 * the day it mattered. The markdown pass escapes first and then adds back only
 * the markup it built itself, and this test feeds it the actual attacks.
 *
 * THE HISTORY. A failed turn must come back out of the history, or every
 * later request re-sends the question that already broke and the assistant
 * looks permanently stuck on it. And only the tail is sent, because a
 * conversation that grows forever eventually exceeds what the model takes,
 * which reads as the assistant breaking rather than the history being long.
 *
 * NO SECRETS. The page holds no key. It talks to the same worker the app
 * uses, which is the only reason it can be opened from anywhere.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('playwright is not installed, skipping. npm i playwright');
  process.exit(0);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = join(ROOT, 'assistant.html');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  try {
    for (const d of readdirSync('/opt/pw-browsers')) {
      if (!d.startsWith('chromium-')) continue;
      const p = join('/opt/pw-browsers', d, 'chrome-linux', 'chrome');
      if (existsSync(p)) return p;
    }
  } catch { /* let Playwright try its own */ }
  return undefined;
}

const browser = await chromium.launch({ executablePath: chromePath() });
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
// Nothing leaves the machine. Every outbound call is answered here, so the
// test never depends on the worker being up and never spends its quota.
const calls = [];
await page.route('**://**', async (r) => {
  const url = r.request().url();
  if (url.startsWith('file://')) return r.continue();
  if (url.includes('asturio-ai')) {
    calls.push(JSON.parse(r.request().postData() || '{}'));
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ candidates: [{ finishReason: 'STOP',
        content: { parts: [{ text: 'Reply **one**.' }] } }] }) });
  }
  return r.abort();
});
await page.goto('file://' + PAGE, { waitUntil: 'load' });
await page.waitForTimeout(1200);

console.log('\n1. the page stands up on its own');
ok('no uncaught errors while starting', errors.length === 0, errors[0]);
{
  const r = await page.evaluate(() => ({
    title: document.title,
    rain: !!document.getElementById('rain'),
    glass: !!document.getElementById('glass'),
    // The logo is IMPORTED, not redrawn. A second version of a mark that
    // already exists is two logos to keep in step, and one of them goes
    // wrong eventually.
    logo: (document.querySelector('#core img') || {}).getAttribute
        ? document.querySelector('#core img').getAttribute('src') : null,
    drawn: document.querySelectorAll('#core svg, #core .ring').length,
    input: !!document.getElementById('q'),
    send: !!document.getElementById('send'),
    mic: !!document.getElementById('mic'),
  }));
  ok('it is called Asturio', r.title === 'ASTURIO', r.title);
  ok('there is falling code and a screen over it', r.rain && r.glass);
  ok('the core is the site logo file itself',
     r.logo === 'assets/img/asturio-btn.png', String(r.logo));
  ok('and is not redrawn in code beside it', r.drawn === 0, String(r.drawn));
  ok('and somewhere to type, send and speak', r.input && r.send && r.mic);
}

console.log('\n2. the boot sequence, then the room is ready');
{
  const r = await page.evaluate(() => ({
    boot: document.querySelectorAll('.boot').length,
    seeds: document.querySelectorAll('#seeds button').length,
    state: document.getElementById('state').textContent,
  }));
  ok('it announces itself', r.boot >= 3, String(r.boot));
  ok('and offers somewhere to start', r.seeds === 4, String(r.seeds));
  ok('then stands by', /STANDING BY/.test(r.state), r.state);
}

console.log('\n3. asking works end to end');
{
  const r = await page.evaluate(async () => {
    await ask('Hello there');
    const msgs = [...document.querySelectorAll('.msg')];
    const last = msgs[msgs.length - 1];
    return {
      mine: !!document.querySelector('.msg.me'),
      reply: last.querySelector('.bubble').innerHTML,
      seeds: !!document.getElementById('seeds'),
      turns: history.length,
      idle: document.getElementById('state').textContent,
      busy: document.body.classList.contains('busy'),
    };
  });
  ok('the question is shown', r.mine);
  ok('the answer is rendered as markdown',
     /<strong>one<\/strong>/.test(r.reply), r.reply.slice(0, 60));
  // The suggestions are for an empty room. Leaving them under a conversation
  // is clutter that never goes away.
  ok('the starting suggestions go away once used', !r.seeds);
  ok('both turns are remembered', r.turns === 2, String(r.turns));
  ok('and it goes back to standing by', /STANDING BY/.test(r.idle) && !r.busy,
     r.idle);
}

console.log('\n4. what it sends is what it should send');
{
  const body = calls[calls.length - 1];
  ok('it asks the shared worker, so the page holds no key', calls.length === 1);
  ok('it sends a system instruction', !!(body.system_instruction
     && body.system_instruction.parts && body.system_instruction.parts[0].text));
  const sys = body.system_instruction.parts[0].text;
  // The persona is a general assistant that knows weather, not a weather bot
  // that tolerates other questions.
  ok('the persona is a personal assistant', /personal AI assistant/.test(sys));
  ok('it knows the time and place it is being asked in',
     /RIGHT NOW:/.test(sys) && /timezone/.test(sys));
  ok('it is told not to state live weather as fact',
     /do not\s*\n?state current conditions/i.test(sys.replace(/\s+/g, ' '))
     || /not\s+state\s+current\s+conditions/i.test(sys.replace(/\s+/g, ' ')));
  ok('and it carries the house rule about em dashes',
     /em dash/i.test(sys));
  ok('the conversation goes with it', Array.isArray(body.contents)
     && body.contents.length === 1 && body.contents[0].role === 'user');
}

console.log('\n5. a reply cannot run code');
{
  const r = await page.evaluate(() => {
    const attacks = [
      '<img src=x onerror="window.__pwned=1">',
      '<script>window.__pwned=1<\/script>',
      '<a href="javascript:window.__pwned=1">tap</a>',
      'plain <b>bold</b> tags',
    ];
    const out = attacks.map(a => md(a));
    const probe = document.createElement('div');
    probe.innerHTML = out.join('');
    document.body.appendChild(probe);
    const hrefs = [...probe.querySelectorAll('a')].map(a => a.getAttribute('href'));
    const bad = probe.querySelectorAll('img,script,b').length;
    probe.remove();
    return { out, pwned: !!window.__pwned, bad, hrefs };
  });
  // Escape first, then add back only what the function itself built. Anything
  // else and a model reply is an injection.
  ok('a tag in a reply is shown, not run', r.pwned !== true);
  ok('and no element is created from it', r.bad === 0, String(r.bad));
  ok('the angle brackets survive as text',
     r.out[0].includes('&lt;img'), r.out[0].slice(0, 40));
  // Links are built here from an escaped string, so an href can only ever be
  // the http URL that was matched.
  ok('no javascript: link can be built',
     r.hrefs.every(h => !h || /^https?:\/\//.test(h)), JSON.stringify(r.hrefs));
}

console.log('\n6. markdown renders the things it claims to');
{
  const r = await page.evaluate(() => ({
    bold: md('**yes**'),
    code: md('run `ls` now'),
    fence: md('```\nline one\n```'),
    list: md('- one\n- two'),
    head: md('## Title'),
    link: md('see https://example.com/x now'),
  }));
  ok('bold', /<strong>yes<\/strong>/.test(r.bold), r.bold);
  ok('inline code', /<code>ls<\/code>/.test(r.code), r.code);
  ok('code fences', /<pre><code>/.test(r.fence), r.fence);
  ok('lists', /<ul><li>one<\/li>/.test(r.list), r.list);
  ok('headings', /<h2>Title<\/h2>/.test(r.head), r.head);
  ok('and bare links become links',
     /<a href="https:\/\/example.com\/x"/.test(r.link)
     && /rel="noopener noreferrer"/.test(r.link), r.link);
}

console.log('\n7. the conversation survives a reload');
{
  const r = await page.evaluate(() => {
    const raw = localStorage.getItem('asturio_assistant_v1');
    return { saved: !!raw, turns: raw ? JSON.parse(raw).length : 0 };
  });
  ok('it is written down', r.saved);
  ok('with both turns in it', r.turns === 2, String(r.turns));

  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(900);
  const back = await page.evaluate(() => ({
    msgs: document.querySelectorAll('.msg').length,
    turns: history.length,
    // Read the RENDERED log, not the page's markup. body.innerHTML includes
    // the inline script, which contains the string this looks for, so the
    // first version of this check passed on the page's own source code and
    // would have gone on passing whatever the page actually drew.
    boot: document.getElementById('log').textContent.includes('CORE'),
    restored: document.getElementById('log').textContent.includes('RESTORED'),
  }));
  ok('and comes back on the next visit', back.turns === 2, String(back.turns));
  ok('with the messages redrawn', back.msgs >= 3, String(back.msgs));
  ok('it says so rather than replaying the boot',
     back.restored && !back.boot, JSON.stringify(back));
}

console.log('\n8. a failed turn does not poison the next one');
{
  const r = await page.evaluate(async () => {
    const real = window.fetch;
    window.fetch = () => Promise.reject(new Error('offline'));
    const before = history.length;
    await ask('This one will fail');
    const after = history.length;
    window.fetch = real;
    const last = [...document.querySelectorAll('.bubble')].pop();
    return { before, after, err: last.className.includes('err'),
             text: last.textContent };
  });
  // The question comes back out. Leaving it in means every later request
  // re-sends the one that already broke.
  ok('the failed question is taken back out of the history',
     r.after === r.before, r.before + ' then ' + r.after);
  ok('the failure is shown as a failure', r.err);
  ok('and it says what went wrong, not just that something did',
     /could not reach|no connection/i.test(r.text), r.text.slice(0, 70));
}

console.log('\n9. a long conversation is trimmed, not sent whole');
{
  const r = await page.evaluate(async () => {
    history = [];
    for (let i = 0; i < 200; i++) {
      history.push({ role: 'user', parts: [{ text: 'q' + i }] });
      history.push({ role: 'model', parts: [{ text: 'a' + i }] });
    }
    window.__sent = null;
    const real = window.fetch;
    window.fetch = (u, o) => {
      window.__sent = JSON.parse(o.body);
      return real(u, o);
    };
    await ask('one more');
    window.fetch = real;
    return { sent: window.__sent.contents.length, max: MAX_TURNS,
             kept: JSON.parse(localStorage.getItem('asturio_assistant_v1')).length };
  });
  // A history that grows without limit eventually exceeds what the model
  // takes, and the failure looks like the assistant breaking.
  ok(`only the last ${r.max} turns are sent`, r.sent === r.max,
     String(r.sent));
  ok('and what is stored is bounded too',
     r.kept <= r.max * 2, String(r.kept));
}

console.log('\n10. new clears it');
{
  const r = await page.evaluate(() => {
    window.confirm = () => true;
    wipe();
    return { turns: history.length,
             stored: localStorage.getItem('asturio_assistant_v1'),
             boot: document.getElementById('log').textContent.includes('CORE'),
             seeds: document.querySelectorAll('#seeds button').length };
  });
  ok('the history goes', r.turns === 0 && r.stored === null,
     r.turns + '/' + r.stored);
  ok('and the room boots again, seeds and all',
     r.boot && r.seeds === 4, JSON.stringify(r));
}

console.log('\n11. it behaves on a phone, and for someone who wants stillness');
{
  await page.setViewportSize({ width: 390, height: 780 });
  await page.waitForTimeout(400);
  const r = await page.evaluate(() => {
    const b = document.body;
    return { overflowX: b.scrollWidth > b.clientWidth + 1,
             coreW: document.getElementById('core').getBoundingClientRect().width };
  });
  ok('nothing spills off the side', !r.overflowX);
  ok('and the core shrinks to fit', r.coreW <= 50, String(r.coreW));

  const src = readFileSync(PAGE, 'utf8');
  ok('reduced motion is honoured', /prefers-reduced-motion: reduce/.test(src));
  ok('and the rain stops when the tab is hidden',
     /visibilitychange/.test(src) && /document\.hidden \? stop\(\)/.test(src));
}

console.log('\n12. house rules');
{
  const src = readFileSync(PAGE, 'utf8');
  const EM = String.fromCharCode(0x2014);
  ok('no em dash anywhere in the page', !src.includes(EM));
  // The page is public. A key in it would be a key given away.
  ok('no API key is in the page',
     !/AIza[0-9A-Za-z_-]{20,}/.test(src) && !/sk-[A-Za-z0-9]{20,}/.test(src));
  ok('it uses the shared worker, which is what keeps it keyless',
     /asturio-ai\.ralphies1005\.workers\.dev/.test(src));
  // The same file the radar app's own AI button uses, so the assistant looks
  // like itself in all three places rather than in two and a half.
  ok('and it wears the app\'s real logo file',
     /assets\/img\/asturio-btn\.png/.test(src));
}

console.log('\n13. it wears the house style');
{
  const src = readFileSync(PAGE, 'utf8');
  const r = await page.evaluate(() => {
    // A pseudo-element cannot be selected, only read off the element it hangs
    // from, so the helper takes it as a second argument.
    const cs = (sel, prop, pseudo) =>
      getComputedStyle(document.querySelector(sel), pseudo || null)
        .getPropertyValue(prop);
    const grads = [
      cs('#bg', 'background-image'),
      cs('.bubble', 'background-image'),
      cs('#send', 'background-image'),
      cs('#q', 'background-image'),
      cs('#core', 'background-image', '::before'),
      cs('header', 'background-image', '::after'),
    ];
    return {
      font: cs('body', 'font-family'),
      inputFont: cs('#q', 'font-family'),
      grads,
      // No cyan left anywhere in the computed styles of the main furniture.
      cyan: [...document.querySelectorAll('*')].some(el => {
        const c = getComputedStyle(el);
        return /0,\s*140,\s*186|79,\s*214,\s*255/.test(c.color + c.backgroundColor);
      }),
    };
  });
  ok('Comfortaa, everywhere', /Comfortaa/.test(r.font), r.font);
  ok('including the box you type in', /Comfortaa/.test(r.inputFont), r.inputFont);
  ok('and the font is actually loaded',
     /fonts\.googleapis\.com\/css2\?family=Comfortaa/.test(src));
  // "Everything is a gradient" is a claim the computed styles can settle.
  ok('the page, panels, buttons, field, halo and rules are all gradients',
     r.grads.every(g => /gradient/.test(g)), r.grads.map(g => g.slice(0, 22)).join(' | '));
  ok('nothing is left painted in the old cyan', !r.cyan);
  // The scheme is named once and reused, so two ramps cannot drift apart.
  ok('the ramps are named once in the palette',
     (src.match(/--g-[a-z]+:/g) || []).length >= 6,
     String((src.match(/--g-[a-z]+:/g) || []).length));
  ok('and the palette is red and gold',
     /--red:\s*#aa0000/.test(src) && /--gold:\s*#e8b800/.test(src));
}

console.log('\n14. nothing threw along the way');
ok('no uncaught errors at all', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
