#!/usr/bin/env node
/*
 * Finding the Pi, and surviving a published address that lies.
 *
 *     npm i playwright && node tools/test-pi-address.mjs
 *
 * On 2026-08-27 the site reported the Pi unreachable for a day while the Pi
 * answered every request put to it. Nothing was broken in the way anyone
 * looked for. The chain was:
 *
 *   - the Pi's quick tunnel rotated its name, as quick tunnels do
 *   - a database rule change meant the Pi could no longer publish the new one
 *   - so the shared document went on naming an address dead for hours
 *   - and the site believed it, because believing it was the whole design
 *
 * Two defences, and this is what tests them. The Pi has a permanent hostname
 * that cannot rotate. And no candidate address is believed on its word: they
 * are asked, and the first that answers wins. An address that does not answer
 * is not an address, however officially it was published.
 *
 * The failure this guards against is silent by nature, so every check here is
 * about which address is CHOSEN, given what does and does not answer.
 */

import { readdirSync, existsSync } from 'fs';
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

const LEAFLET_STUB = `(() => {
  const chain = () => new Proxy(function(){}, {
    get: (t, k) => {
      if (k === 'getCenter')  return () => ({ lat: 35.3, lng: -97.3 });
      if (k === 'getZoom')    return () => 7;
      if (k === 'hasLayer')   return () => false;
      if (k === 'getPane')    return () => document.createElement('div');
      if (k === 'createPane') return () => document.createElement('div');
      if (k === 'getBounds')  return () => ({ getWest:()=>-100, getEast:()=>-95,
        getNorth:()=>38, getSouth:()=>33, contains:()=>true, pad(){return this;},
        getCenter:()=>({ lat:35, lng:-97 }) });
      if (k === 'then') return undefined;
      return chain();
    },
    apply: () => chain(), construct: () => chain(),
  });
  Object.defineProperty(window, 'L',
    { value: chain(), writable: true, configurable: true });
})();`;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = '/opt/pw-browsers';
  try {
    for (const d of readdirSync(root)) {
      if (!d.startsWith('chromium-')) continue;
      const p = join(root, d, 'chrome-linux', 'chrome');
      if (existsSync(p)) return p;
    }
  } catch { /* let Playwright try its own */ }
  return undefined;
}

const browser = await chromium.launch({ executablePath: chromePath() });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));

await page.addInitScript(LEAFLET_STUB);
await page.route('**://**', r =>
  r.request().url().startsWith('file://') ? r.continue() : r.abort());
await page.goto('file://' + join(ROOT, 'index.html'),
                { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);

// The whole world, as far as address resolution is concerned: which hosts are
// alive, what the shared document says, and what is saved in this browser.
await page.evaluate(() => {
  window.__world = { alive: [], published: null, saved: null, asked: [] };
  // Bare assignments: these are top-level lets, which are lexical bindings
  // rather than properties of window.
  _hdFetchPublished = async () => window.__world.published;
  window.__realAnswers = async (base) => {
    if (!base) return false;
    window.__world.asked.push(base);
    return window.__world.alive.includes(base);
  };
  _hdAnswers = window.__realAnswers;
  window.__resolve = async () => {
    window.__world.asked = [];
    _hdResolveCache = { at: 0, base: null, pr: null };
    try { localStorage.removeItem(HD_BASE_KEY); } catch (e) {}
    if (window.__world.saved) {
      try { localStorage.setItem(HD_BASE_KEY, window.__world.saved); } catch (e) {}
    }
    const base = await _hdResolveBase(true);
    let left = null;
    try { left = localStorage.getItem(HD_BASE_KEY); } catch (e) {}
    return { base, asked: window.__world.asked.slice(), saved: left };
  };
});

const FIXED = await page.evaluate(() => HD_FIXED_BASE);
const TUNNEL_OLD = 'https://dead-quick-tunnel.trycloudflare.com';
const TUNNEL_NEW = 'https://live-quick-tunnel.trycloudflare.com';

console.log('\n1. the permanent hostname exists and is a real https address');
ok('there is one', !!FIXED, String(FIXED));
ok('it is https, because the site is and a browser will not mix them',
   /^https:\/\//.test(FIXED || ''), String(FIXED));
ok('and it is not a quick tunnel, which is the thing that rotates',
   !/trycloudflare/.test(FIXED || ''), String(FIXED));

console.log('\n2. the ordinary day: the published address answers, and wins');
{
  const r2 = await page.evaluate(async ({ nu }) => {
    window.__world = { alive: [nu, HD_FIXED_BASE], published: nu,
                       saved: null, asked: [] };
    return window.__resolve();
  }, { nu: TUNNEL_NEW });
  ok('the published address is used', r2.base === TUNNEL_NEW, r2.base);
  ok('and the permanent name is not preferred over a deployment\'s own Pi',
     r2.base !== FIXED, r2.base);
}

console.log('\n3. the outage: the published address is dead, the fixed one is not');
{
  const r = await page.evaluate(async ({ dead }) => {
    window.__world = { alive: [HD_FIXED_BASE], published: dead,
                       saved: null, asked: [] };
    return window.__resolve();
  }, { dead: TUNNEL_OLD });
  ok('the dead published address is NOT used', r.base !== TUNNEL_OLD, r.base);
  ok('the permanent hostname is used instead', r.base === FIXED, r.base);
  ok('and the dead one was genuinely asked, not skipped on a guess',
     r.asked.includes(TUNNEL_OLD), JSON.stringify(r.asked));
}

console.log('\n4. everything is asked at once, not one timeout after another');
{
  const r = await page.evaluate(async ({ dead, mine }) => {
    window.__world = { alive: [], published: dead, saved: mine, asked: [] };
    const t0 = performance.now();
    // Each probe holds for 200ms. Three in series is 600, in parallel is 200.
    _hdAnswers = async (base) => {
      window.__world.asked.push(base);
      await new Promise(res => setTimeout(res, 200));
      return false;
    };
    const out = await window.__resolve();
    // Put the world-driven probe back. Leaving this always-false stub in place
    // made three later checks pass for the wrong reason: with nothing ever
    // answering, "the dead address was refused" is true because EVERY address
    // was refused, which proves nothing at all.
    _hdAnswers = window.__realAnswers;
    return { ms: performance.now() - t0, asked: out.asked, base: out.base };
  }, { dead: TUNNEL_OLD, mine: 'https://saved.example.com' });
  ok('all three candidates are tried', r.asked.length === 3,
     JSON.stringify(r.asked));
  ok('and in parallel: three 200ms probes take about 200ms, not 600',
     r.ms < 450, Math.round(r.ms) + 'ms');
  ok('and the world-driven probe is back for the checks below',
     await page.evaluate(() => _hdAnswers === window.__realAnswers));
}

console.log('\n5. when nothing answers it still names the address it was given');
{
  const r = await page.evaluate(async ({ dead }) => {
    window.__world = { alive: [], published: dead, saved: null, asked: [] };
    const out = await window.__resolve();
    _hdBase = out.base;
    return { base: out.base, why: _hdWhyUnreachable() };
  }, { dead: TUNNEL_OLD });
  ok('it hands back the published address rather than null',
     r.base === TUNNEL_OLD, r.base);
  ok('so the failure message can say WHICH address did not answer',
     (r.why.text || '').includes(TUNNEL_OLD), r.why.text);
}

console.log('\n6. a saved address is the last resort, and is cleared when wrong');
{
  const r = await page.evaluate(async ({ mine }) => {
    window.__world = { alive: [mine], published: null, saved: mine, asked: [] };
    return window.__resolve();
  }, { mine: 'https://my-own-pi.example.com' });
  ok('a saved address that answers is used when nothing else does',
     r.base === 'https://my-own-pi.example.com', r.base);

  const r2 = await page.evaluate(async ({ mine, nu }) => {
    window.__world = { alive: [nu, HD_FIXED_BASE], published: nu,
                       saved: mine, asked: [] };
    return window.__resolve();
  }, { mine: 'https://stale.example.com', nu: TUNNEL_NEW });
  ok('a stale saved address does not shadow a live published one',
     r2.base === TUNNEL_NEW, r2.base);
  ok('and it is deleted, so it cannot come back later', r2.saved === null,
     String(r2.saved));
}

console.log('\n7. the watcher cannot drag a working site onto a dead address');
{
  const r = await page.evaluate(async ({ dead, mine }) => {
    _hdBase = mine;
    _hdWatchBusy = false;
    window.__world = { alive: [mine], published: dead, saved: null, asked: [] };
    let applied = null;
    const realApply = _hdApplyNewBase;
    _hdApplyNewBase = (b) => { applied = b; return true; };
    await _hdPollAddress();
    _hdApplyNewBase = realApply;
    return { applied, base: _hdBase, asked: window.__world.asked };
  }, { dead: TUNNEL_OLD, mine: 'https://working.example.com' });
  ok('a newly published address that does not answer is refused',
     r.applied === null, String(r.applied));
  ok('and it was asked before being refused',
     r.asked.includes(TUNNEL_OLD), JSON.stringify(r.asked));
}

console.log('\n8. and it still follows a tunnel that really did move');
{
  const r = await page.evaluate(async ({ nu, mine }) => {
    _hdBase = mine;
    _hdWatchBusy = false;
    window.__world = { alive: [nu], published: nu, saved: null, asked: [] };
    let applied = null;
    const realApply = _hdApplyNewBase;
    _hdApplyNewBase = (b) => { applied = b; return true; };
    await _hdPollAddress();
    _hdApplyNewBase = realApply;
    return { applied };
  }, { nu: TUNNEL_NEW, mine: 'https://working.example.com' });
  ok('a live new address is followed, which is what the watcher is for',
     r.applied === TUNNEL_NEW, String(r.applied));
}

console.log('\n9. an address that dies WITHOUT the document changing is noticed');
{
  // The exact shape of the outage: the published address never changed, so the
  // watcher had nothing to react to, while the address everyone was on was
  // already dead.
  const r = await page.evaluate(async ({ dead }) => {
    _hdBase = dead;
    _hdHealthAt = 0;
    window.__world = { alive: [HD_FIXED_BASE], published: dead,
                       saved: null, asked: [] };
    _hdResolveCache = { at: 0, base: null, pr: null };
    let applied = null;
    const realApply = _hdApplyNewBase;
    _hdApplyNewBase = (b) => { applied = b; return true; };
    await _hdCheckCurrent();
    _hdApplyNewBase = realApply;
    return { applied, asked: window.__world.asked };
  }, { dead: TUNNEL_OLD });
  ok('the address in use is checked, not only the published one',
     r.asked.includes(TUNNEL_OLD), JSON.stringify(r.asked));
  ok('and when it has died the site moves itself to one that works',
     r.applied === FIXED, String(r.applied));
}

console.log('\n10. resolving is not repeated dozens of times a page load');
{
  const r = await page.evaluate(async ({ nu }) => {
    window.__world = { alive: [nu], published: nu, saved: null, asked: [] };
    _hdResolveCache = { at: 0, base: null, pr: null };
    const first = await _hdResolveBase(true);
    const n = window.__world.asked.length;
    // Twenty places ask for the address on a page load.
    for (let i = 0; i < 20; i++) await _hdResolveBase();
    return { first, probesForOne: n, total: window.__world.asked.length };
  }, { nu: TUNNEL_NEW });
  ok('twenty callers cost one resolve, not twenty',
     r.total === r.probesForOne,
     `${r.total} probes for 21 calls, ${r.probesForOne} for the first`);
}

console.log('\n11. nothing threw along the way');
ok('no uncaught errors at all', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
