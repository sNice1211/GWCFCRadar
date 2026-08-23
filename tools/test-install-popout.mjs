#!/usr/bin/env node
/*
 * Installing to a home screen, and popping the alert panels out.
 *
 *     node tools/test-install-popout.mjs
 *
 * Two features that fail quietly if they are wrong. A manifest with a bad
 * icon path does not error, the browser just never offers to install. A
 * pop-out that opens but never updates looks alive and shows yesterday's
 * warnings, which is worse than not opening at all.
 */

import { readFileSync, existsSync } from 'fs';
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
const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

// ── The manifest, read as a browser would ─────────────────────────────────
console.log('\n1. the app can be installed to a home screen');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const head = html.slice(0, 8000);

ok('the page links a web app manifest',
   /<link[^>]+rel="manifest"[^>]+href="\.\/manifest\.webmanifest"/.test(head));
ok('and the manifest file exists',
   existsSync(join(ROOT, 'manifest.webmanifest')));

let man = null;
try { man = JSON.parse(readFileSync(join(ROOT, 'manifest.webmanifest'), 'utf8')); }
catch (e) { /* reported below */ }
ok('the manifest is valid JSON', !!man);

if (man) {
  // The fields a browser actually requires before it will offer to install.
  ok('it has a name and a short name', !!man.name && !!man.short_name,
     `${man.name} / ${man.short_name}`);
  ok('short_name is short enough not to be truncated on a home screen',
     (man.short_name || '').length <= 12, man.short_name);
  ok('it opens without browser chrome', man.display === 'standalone', man.display);
  ok('it declares a start_url inside its own scope',
     !!man.start_url && !!man.scope, `${man.start_url} in ${man.scope}`);
  ok('the theme colour matches the page meta tag',
     man.theme_color === (/<meta name="theme-color" content="([^"]+)"/.exec(head) || [])[1],
     man.theme_color);

  const icons = man.icons || [];
  ok('it offers a 192 and a 512 icon',
     icons.some(i => i.sizes === '192x192') && icons.some(i => i.sizes === '512x512'),
     icons.map(i => i.sizes).join(' '));
  // Android crops any icon that is not declared maskable into a circle, which
  // eats the corners of a square logo. A maskable entry is what keeps the
  // logo whole inside the launcher's shape.
  ok('and a maskable one, so Android does not crop the logo',
     icons.some(i => String(i.purpose || '').includes('maskable')));

  const missing = icons.filter(i => !existsSync(join(ROOT, i.src.replace(/^\.\//, ''))));
  ok('every icon file it names is really there', missing.length === 0,
     missing.map(i => i.src).join(' '));

  const shortcutIcons = (man.shortcuts || []).flatMap(s => s.icons || []);
  const missingShort = shortcutIcons
    .filter(i => !existsSync(join(ROOT, i.src.replace(/^\.\//, ''))));
  ok('so is every shortcut icon', missingShort.length === 0,
     missingShort.map(i => i.src).join(' '));
  ok('the shortcuts point at panels the app knows',
     (man.shortcuts || []).every(s => /panel=(alerts|eas)/.test(s.url)),
     (man.shortcuts || []).map(s => s.url).join(' '));
}

// iOS ignores the manifest entirely and reads its own tags instead.
ok('iOS is told it may launch without Safari chrome',
   /<meta name="apple-mobile-web-app-capable" content="yes">/.test(head));
ok('iOS has an apple-touch-icon to put on the home screen',
   /<link rel="apple-touch-icon"[^>]+href="\.\/icons\/icon-192\.png"/.test(head));
ok('and a short title for under the icon',
   /<meta name="apple-mobile-web-app-title"/.test(head));

// The service worker has to let the manifest and icons through its cache.
const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
ok('the service worker caches the manifest and the icons',
   /webmanifest/.test(sw) && /\/icons\//.test(sw));

// ── The pop-out windows, driven in a real browser ─────────────────────────
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'],
});
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript',
      body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css',
      body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  return route.abort();
});
await page.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);

console.log('\n2. both panels carry a pop-out button');
{
  const btns = await page.evaluate(() => ({
    alerts: !!document.getElementById('alerts-pop'),
    eas: !!document.getElementById('eas-pop'),
    labelled: ['alerts-pop', 'eas-pop'].every(id => {
      const b = document.getElementById(id);
      return b && b.getAttribute('aria-label') && b.title;
    }),
    icon: !!document.querySelector('#alerts-pop use[href="#ic-external"]'),
    sprite: !!document.getElementById('ic-external'),
  }));
  ok('the warnings panel has one', btns.alerts);
  ok('the EAS panel has one', btns.eas);
  ok('both are labelled for a screen reader and on hover', btns.labelled);
  ok('the icon they use exists in the sprite', btns.sprite && btns.icon);
}

console.log('\n3. the pop-out opens and mirrors the panel');
{
  const r = await page.evaluate(async () => {
    // Put something known into the panel, then pop it out.
    const src = document.getElementById('alerts-panel-body');
    src.innerHTML = '<div class="a">FIRST WARNING</div>'
                  + '<div class="a">SECOND WARNING</div>';
    const cnt = document.getElementById('alerts-panel-count');
    if (cnt) cnt.textContent = '2 active';
    _popOutPanel('alerts');
    await new Promise(r2 => setTimeout(r2, 300));
    const w = _popWins.alerts && _popWins.alerts.win;
    if (!w) return { opened: false };
    const main = w.document.getElementById('pm');
    const first = { html: main.innerHTML, count: w.document.getElementById('pc').textContent };

    // Now change the panel the way a refresh would, and see if the window
    // follows without anyone asking it to.
    src.innerHTML = '<div class="a">THIRD WARNING</div>';
    if (cnt) cnt.textContent = '1 active';
    await new Promise(r2 => setTimeout(r2, 300));
    return {
      opened: true,
      firstHtml: first.html, firstCount: first.count,
      afterHtml: main.innerHTML, afterCount: w.document.getElementById('pc').textContent,
      title: w.document.title,
      styled: !!w.document.querySelector('style'),
      btnOpen: document.getElementById('alerts-pop').classList.contains('open'),
    };
  });
  ok('the window opens', r.opened);
  ok('it shows what the panel showed',
     /FIRST WARNING/.test(r.firstHtml || '') && /SECOND WARNING/.test(r.firstHtml || ''),
     r.firstHtml);
  ok('and the count with it', /2 active/.test(r.firstCount || ''), r.firstCount);
  ok('a later refresh reaches the window on its own',
     /THIRD WARNING/.test(r.afterHtml || '')
     && !/FIRST WARNING/.test(r.afterHtml || ''), r.afterHtml);
  ok('the count follows too', /1 active/.test(r.afterCount || ''), r.afterCount);
  ok('the window names itself so a pinned one is identifiable',
     /WX Alerts/.test(r.title || ''), r.title);
  ok('it carries its own styling, not the page\'s', r.styled);
  ok('the button shows that a pop-out is open', r.btnOpen);
}

console.log('\n4. pressing it again focuses rather than duplicating');
{
  const r = await page.evaluate(async () => {
    const before = _popWins.alerts && _popWins.alerts.win;
    _popOutPanel('alerts');
    await new Promise(r2 => setTimeout(r2, 150));
    return { same: (_popWins.alerts && _popWins.alerts.win) === before };
  });
  ok('the same window is reused', r.same);
}

console.log('\n5. closing it cleans up after itself');
{
  const r = await page.evaluate(async () => {
    const w = _popWins.alerts && _popWins.alerts.win;
    if (w) w.close();
    await new Promise(r2 => setTimeout(r2, 200));
    // The heartbeat notices a window closed by hand; force the check here.
    _popCleanup('alerts');
    return {
      gone: !_popWins.alerts,
      btn: document.getElementById('alerts-pop').classList.contains('open'),
    };
  });
  ok('the record of it is dropped', r.gone);
  ok('and the button stops claiming one is open', r.btn === false);
}

console.log('\n6. the two panels pop out independently');
{
  const r = await page.evaluate(async () => {
    document.getElementById('eas-panel-body').innerHTML = '<div>EAS ROW</div>';
    _popOutPanel('eas');
    await new Promise(r2 => setTimeout(r2, 300));
    const w = _popWins.eas && _popWins.eas.win;
    const out = {
      opened: !!w,
      html: w ? w.document.getElementById('pm').innerHTML : '',
      title: w ? w.document.title : '',
      alertsClosed: !_popWins.alerts,
    };
    if (w) w.close();
    _popCleanup('eas');
    return out;
  });
  ok('the EAS window opens on its own', r.opened);
  ok('with EAS content in it', /EAS ROW/.test(r.html || ''), r.html);
  ok('and its own title', /EAS Alerts/.test(r.title || ''), r.title);
  ok('without reopening the warnings one', r.alertsClosed);
}

console.log('\n7. nothing threw');
ok('no uncaught errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
