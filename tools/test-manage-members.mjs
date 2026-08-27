#!/usr/bin/env node
/*
 * Manage Members shows who each member actually is.
 *
 *     npm i playwright && node tools/test-manage-members.mjs
 *
 * The panel decides who gets to issue warnings to everybody, so the one thing
 * it has to do is say unambiguously WHO a row is. It did not: both the name
 * and the address ended in text-overflow: ellipsis inside a card capped at
 * 280px, so anything long was cut. Two people called Alex at the same company
 * are told apart by the end of the address, and the end is exactly what an
 * ellipsis eats.
 *
 * Measured rather than eyeballed. A screenshot cannot tell you that a string
 * is one pixel wider than its box; scrollWidth against clientWidth can, and
 * that is the difference between "looks fine on my long name" and "is fine".
 *
 * The old rules are put back mid-test to prove the fix is load-bearing. A
 * test that only checks the new state passes just as happily against a
 * stylesheet where nothing was ever wrong.
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
        getNorth:()=>38, getSouth:()=>33, contains:()=>true, pad(){return this;} });
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
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));

await page.addInitScript(LEAFLET_STUB);
await page.route('**://**', r =>
  r.request().url().startsWith('file://') ? r.continue() : r.abort());
await page.goto('file://' + join(ROOT, 'index.html'),
                { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);

// Three members chosen to be awkward on purpose: an ordinary one, one whose
// name and address are both long enough to have been cut before, and one with
// no address at all.
const LONG_EMAIL =
  'alexandra.featherstonehaugh@meteorological-services.example.org';
const LONG_NAME = 'Alexandra Featherstonehaugh-Cholmondeley';

await page.evaluate(({ LONG_EMAIL, LONG_NAME }) => {
  _currentUser = { uid: 'owner', email: 'ralphies1005@gmail.com',
                   isAnonymous: false };
  _staffUsers = [
    { uid: 'a1', name: 'Ralph', email: 'ralphies1005@gmail.com',
      avatarImage: '', emoji: '', staffRole: 'owner', forecaster: true },
    { uid: 'b2', name: LONG_NAME, email: LONG_EMAIL,
      avatarImage: '', emoji: '', staffRole: 'moderator', forecaster: false },
    { uid: 'c3', name: '(no name)', email: '',
      avatarImage: '', emoji: '', staffRole: 'member', forecaster: false },
  ];
  // The panel is only laid out when it is actually on screen, and a row that
  // is not laid out reports every width as zero, which reads as "nothing is
  // clipped" whatever the rules say. This is the check passing for the wrong
  // reason, and it cost a run to notice.
  document.getElementById('lqm-profile-overlay').classList.add('lqm-panel-open');
  document.getElementById('lqm-profile-guest').style.display = 'none';
  document.getElementById('lqm-profile-user').style.display = '';
  document.getElementById('lqm-view-profile').classList.remove('open');
  document.getElementById('lqm-view-staff').classList.add('open');
  document.getElementById('lqm-profile-overlay').classList.add('lqm-wide');
  _staffRenderList('');
}, { LONG_EMAIL, LONG_NAME });

// scrollWidth past clientWidth is text wider than its box; scrollHeight past
// clientHeight is text taller than its box. Either one is text the reader
// cannot see, whether or not an ellipsis is drawn to admit it.
const read = () => page.evaluate(() => {
  const cut = (el) => !el ? null : {
    text: el.textContent.trim(),
    cut: el.scrollWidth > el.clientWidth + 1
      || el.scrollHeight > el.clientHeight + 1,
  };
  const rows = [...document.querySelectorAll('.lqm-staff-row')];
  const ov = document.getElementById('lqm-profile-overlay');
  return {
    overlayW: Math.round(ov.getBoundingClientRect().width),
    laidOut: rows.every(r => r.getBoundingClientRect().height > 0),
    rows: rows.map(r => ({
      name: cut(r.querySelector('.lqm-staff-name')),
      email: cut(r.querySelector('.lqm-staff-email')),
      title: r.getAttribute('title') || '',
      h: Math.round(r.getBoundingClientRect().height),
      sideways: r.scrollWidth > r.clientWidth + 1,
    })),
  };
});

console.log('\n1. the panel is really on screen, so the measurements mean something');
const r = await read();
ok('no uncaught errors while starting', errors.length === 0, errors[0]);
ok('three member rows are drawn', r.rows.length === 3, r.rows.length);
ok('and they have real height, not zero', r.laidOut,
   JSON.stringify(r.rows.map(x => x.h)));

console.log('\n2. nothing is cut off');
r.rows.forEach((row, i) => {
  ok(`row ${i + 1}: the name is shown whole`, !row.name.cut, row.name.text);
  ok(`row ${i + 1}: the address is shown whole`, !row.email.cut, row.email.text);
});
ok('the long address is there in full, to its last character',
   r.rows[1].email.text === LONG_EMAIL, r.rows[1].email.text);
ok('and the long name is there in full',
   r.rows[1].name.text === LONG_NAME, r.rows[1].name.text);
ok('the row wrapped rather than growing a sideways scrollbar',
   !r.rows[1].sideways && r.rows[1].h > r.rows[0].h,
   JSON.stringify({ side: r.rows[1].sideways, h: r.rows[1].h }));

console.log('\n3. an account with no address says so, rather than showing a raw id');
ok('it is named as having no email', /no email/i.test(r.rows[2].email.text),
   r.rows[2].email.text);
ok('and the id is still there to identify them by',
   r.rows[2].email.text.includes('c3'), r.rows[2].email.text);

console.log('\n4. the whole identity is on the row itself, for hovering');
ok('name, address and id are all in the tooltip',
   r.rows[1].title.includes(LONG_NAME) && r.rows[1].title.includes(LONG_EMAIL)
   && r.rows[1].title.includes('b2'), r.rows[1].title);

console.log('\n5. the fix is load-bearing: the old rules really did cut it');
{
  const before = await page.evaluate(() => {
    const st = document.createElement('style');
    st.id = '__old';
    // Exactly what was there before: the narrow card and the ellipsis.
    st.textContent = `#lqm-profile-overlay.lqm-wide { max-width: 280px; }
      .lqm-staff-name, .lqm-staff-email {
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }`;
    document.head.appendChild(st);
    const el = document.querySelectorAll('.lqm-staff-row')[1];
    const n = el.querySelector('.lqm-staff-name');
    const e = el.querySelector('.lqm-staff-email');
    const out = { name: n.scrollWidth > n.clientWidth + 1,
                  email: e.scrollWidth > e.clientWidth + 1 };
    st.remove();
    return out;
  });
  ok('under the old rules the long name was cut', before.name);
  ok('and so was the long address', before.email);
}

console.log('\n6. the wide card belongs to this view and does not leak');
{
  const back = await page.evaluate(() => {
    lqmCloseStaffView();
    return {
      wide: document.getElementById('lqm-profile-overlay')
              .classList.contains('lqm-wide'),
      staffOpen: document.getElementById('lqm-view-staff')
              .classList.contains('open'),
    };
  });
  ok('leaving the members view narrows the card again', !back.wide);
  ok('and the view itself is closed', !back.staffOpen);
}

console.log('\n7. nothing threw along the way');
ok('no uncaught errors at all', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
