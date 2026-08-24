// Panel picture-in-picture: the EAS, WX alerts and navigation panels can
// float over other apps as a live little window, phone included. The floating
// window is a video fed from a canvas the app repaints, because a phone will
// not float a DOM window but will float a video.
//
//   node tools/test-pip.mjs
import { chromium } from '/tmp/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + String(extra).slice(0, 300) + '>' : '')); }
};

console.log('\n1. the source');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
ok('no em dash anywhere in the page', !html.includes('—'));
ok('all three panels grew a float button',
   /id="alerts-pip"/.test(html) && /id="eas-pip"/.test(html) && /id="nav-pip"/.test(html));
ok('each button hands off to the one shared engine',
   [...html.matchAll(/_pipToggle\('(alerts|eas|nav)'\)/g)].length === 3);

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'],
});
const ctx = await browser.newContext();
await ctx.addInitScript(() => {
  try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {}
  // Stand in for the browser's PiP plumbing: real PiP needs a human tap and
  // a compositor, neither of which a headless test has. The canvas, the
  // stream and the video are all real; only the final hand-off is spied.
  Object.defineProperty(document, 'pictureInPictureEnabled', { get: () => true });
  window.__pipReq = 0; window.__pipExit = 0; window.__pipEl = null;
  HTMLVideoElement.prototype.requestPictureInPicture = function () {
    window.__pipReq++; window.__pipEl = this; return Promise.resolve({});
  };
  document.exitPictureInPicture = () => {
    window.__pipExit++; window.__pipEl = null; return Promise.resolve();
  };
  Object.defineProperty(document, 'pictureInPictureElement',
    { get: () => window.__pipEl });
});
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

console.log('\n2. buttons show when the browser can float');
{
  const r = await page.evaluate(() => ({
    supported: _pipSupported(),
    shown: ['alerts-pip', 'eas-pip', 'nav-pip'].map(id => {
      const b = document.getElementById(id);
      return b && b.style.display !== 'none';
    }),
  }));
  ok('support is detected through the stub', r.supported);
  ok('all three buttons are visible', r.shown.every(Boolean), JSON.stringify(r.shown));
}

console.log('\n3. each panel reads out as rows');
{
  const r = await page.evaluate(() => {
    document.getElementById('alerts-panel-body').innerHTML =
      '<div class="alert-card tor"><div class="alert-event"><span>Tornado Warning</span>'
      + '<span class="alert-event-time">until 5:30 PM</span></div>'
      + '<div class="alert-area">Highlands County, FL</div></div>'
      + '<div class="alert-card tstm"><div class="alert-event"><span>Severe Thunderstorm Warning</span></div>'
      + '<div class="alert-area">Polk County, FL</div></div>';
    document.getElementById('eas-panel-body').innerHTML =
      '<div class="eas-card" style="border-left-color: rgb(255, 0, 0);">'
      + '<div class="eas-type"><span><span class="eas-type-badge">TOR</span>&nbsp;WXR · KIEC/FM</span></div>'
      + '<div class="eas-translation">A tornado warning has been issued for Highlands County.</div>'
      + '<div class="eas-meta"><span>012055</span></div></div>';
    const alerts = _pipRows('alerts');
    const eas = _pipRows('eas');
    const navEmpty = _pipRows('nav');
    document.getElementById('nav-turn').style.display = 'flex';
    document.getElementById('nav-turn-arrow').textContent = '➡';
    document.getElementById('nav-turn-main').textContent = 'In 500 ft, turn right onto Ocean Blvd';
    document.getElementById('nav-turn-sub').textContent = '12 min · 8 mi · arrive 5:04 PM';
    const nav = _pipRows('nav');
    return { alerts, eas, navEmpty, nav };
  });
  ok('two warnings become two rows, worst words first',
     r.alerts.length === 2 && r.alerts[0].title === 'Tornado Warning'
       && r.alerts[0].tag === 'until 5:30 PM'
       && r.alerts[0].body === 'Highlands County, FL',
     JSON.stringify(r.alerts));
  ok('the tornado row wears the tornado colour, not a default',
     !!r.alerts[0].color && r.alerts[0].color.toLowerCase() !== '#ff5555',
     r.alerts[0].color);
  ok('an EAS card carries its header, message and colour',
     r.eas.length === 1 && /TOR/.test(r.eas[0].title)
       && /tornado warning/i.test(r.eas[0].body)
       && r.eas[0].color === 'rgb(255, 0, 0)',
     JSON.stringify(r.eas));
  ok('navigation with nothing going on says nothing',
     r.navEmpty.length === 0, JSON.stringify(r.navEmpty));
  ok('a live turn banner becomes the big top row',
     r.nav.length >= 1 && r.nav[0].big === true
       && /turn right onto Ocean Blvd/.test(r.nav[0].title)
       && /arrive 5:04 PM/.test(r.nav[0].body),
     JSON.stringify(r.nav));
}

console.log('\n4. the floating window opens, switches, and closes');
{
  const a = await page.evaluate(async () => {
    await _pipToggle('eas');
    return {
      req: window.__pipReq,
      which: _pip && _pip.which,
      videoLive: !!(_pip && _pip.video.srcObject && document.body.contains(_pip.video)),
      timer: !!(_pip && _pip.timer),
      btnLit: document.getElementById('eas-pip').classList.contains('open'),
      painted: (() => {
        const d = _pip.ctx.getImageData(0, 0, 720, 120).data;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 60 || d[i + 1] > 60) return true;
        return false;
      })(),
    };
  });
  ok('opening asks the browser for picture in picture',
     a.req === 1 && a.which === 'eas', JSON.stringify(a));
  ok('a live canvas-fed video is playing behind it', a.videoLive && a.timer);
  ok('the canvas really has the panel drawn on it', a.painted);
  ok('the button lights while its panel floats', a.btnLit);

  const b = await page.evaluate(async () => {
    await _pipToggle('alerts');
    return {
      which: _pip && _pip.which, req: window.__pipReq,
      videos: document.querySelectorAll('body > video').length,
      easLit: document.getElementById('eas-pip').classList.contains('open'),
      alertsLit: document.getElementById('alerts-pip').classList.contains('open'),
    };
  });
  ok('asking for a different panel switches the window over',
     b.which === 'alerts' && b.req === 2 && b.easLit === false && b.alertsLit === true,
     JSON.stringify(b));
  ok('the old feed is torn down, not left running', b.videos === 1, String(b.videos));

  const c = await page.evaluate(async () => {
    await _pipToggle('alerts');
    return { gone: _pip === null, exit: window.__pipExit,
             videos: document.querySelectorAll('body > video').length,
             lit: document.getElementById('alerts-pip').classList.contains('open') };
  });
  ok('the same button again closes it',
     c.gone && c.exit >= 1 && c.videos === 0 && !c.lit, JSON.stringify(c));

  const d = await page.evaluate(async () => {
    await _pipToggle('nav');
    const open = _pip && _pip.which === 'nav';
    // The person closes it from the window's own X: the browser fires
    // leavepictureinpicture and the app must notice and clean up.
    _pip.video.dispatchEvent(new Event('leavepictureinpicture'));
    return { open, gone: _pip === null,
             videos: document.querySelectorAll('body > video').length };
  });
  ok('navigation floats too, and the window\'s own X cleans up',
     d.open && d.gone && d.videos === 0, JSON.stringify(d));
}

console.log('\n5. nothing threw');
ok('no uncaught page errors', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
