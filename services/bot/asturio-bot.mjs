// Asturio Discord bot - context-aware edition
//
// Answers weather questions in Discord using the same Asturio brain the website
// uses: it POSTs to the existing Cloudflare Worker, so there is no Gemini key on
// this machine. The only secret here is the Discord bot token, and that is read
// from the environment, never from source.
//
// Before answering it pulls live NWS alerts and SPC storm reports, the same
// sources the map uses, plus who is asking, what server they are in and what was
// just said in the channel, so replies are grounded rather than generic.

import {
  Client, GatewayIntentBits, Partials, Events,
  REST, Routes, SlashCommandBuilder,
} from 'discord.js';
import { existsSync, readFileSync } from 'node:fs';
import { getLinkCode, claimLinkCode, getSyncHistory, appendSyncHistory,
         addChatMessage } from './firestore.mjs';

const TOKEN     = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID  = process.env.DISCORD_GUILD_ID || '';       // optional
const AI_WORKER = process.env.ASTURIO_WORKER
               || 'https://asturio-ai.ralphies1005.workers.dev';
const SITE_URL  = 'https://ralphhtml.github.io/GWCFCRadar/';

// Two ways to reach Gemini. The Worker is the default and the better one: the
// key lives in Cloudflare, so there is none in this repo or on the machine
// running the bot, and it is the same brain the website talks to. Setting
// GEMINI_API_KEY calls Gemini directly instead, which is the escape hatch for
// running the bot when the Worker is not deployed.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

// Google retires model names, and a retired one fails as a confusing 404 rather
// than anything that mentions deprecation. Pinning a current name here and
// allowing an override means the next retirement is an env change, not a patch.
// gemini-flash-latest rather than a pinned version: Google closes old names to
// new projects, so a version pinned today can stop working for a fresh key
// tomorrow even though nothing here changed.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';

// Discord user id of the owner. Asturio addresses this person as "god".
// Left blank means nobody gets the treatment, which is the safe default.
const OWNER_ID  = process.env.DISCORD_OWNER_ID || '';

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID.');
  console.error('Copy .env.example to .env, fill it in, then run: npm start');
  process.exit(1);
}

// Discord hard-caps a message at 2000 characters.
const DISCORD_LIMIT = 2000;

// api.weather.gov asks for a contact in the User-Agent and will throttle
// requests that do not send one.
const UA = { 'User-Agent': '(GWCFC Radar Discord bot, github.com/ralphhtml/GWCFCRadar)' };

const withTimeout = (ms) => AbortSignal.timeout(ms);

// ── Who is asking ─────────────────────────────────────────────────────────
// Every lookup here is best effort. Asturio should still answer if Discord or
// Firestore is having a bad minute, just with less to go on.

async function getUserContext(user, guild) {
  const ctx = {
    name: user.username,
    id: user.id,
    nickname: user.username,
    roles: [],
    // Whoever owns the server is the owner, with DISCORD_OWNER_ID as an
    // override. Deriving it means this works with nothing configured, rather
    // than silently treating the owner as a stranger because an id was never
    // filled in.
    isOwner: (!!OWNER_ID && user.id === OWNER_ID) || (!!guild && user.id === guild.ownerId),
    radarLinked: false,
    radarProfile: null,
  };

  const member = guild ? await guild.members.fetch(user.id).catch(() => null) : null;
  if (member) {
    ctx.nickname = member.nickname || user.globalName || user.username;
    // @everyone is on every member, so it says nothing about this person.
    ctx.roles = member.roles.cache.filter(r => r.name !== '@everyone').map(r => r.name);
  }

  // Linkage and profile both come from the shared conversation document. The
  // account itself is unreadable from here, so asking it directly returned 403
  // and every user looked unlinked however many times they had linked.
  const sync = await getSyncHistory(user.id).catch(() => null);
  if (sync) {
    ctx.radarLinked = true;
    ctx.radarProfile = sync.profile || null;
  }
  return ctx;
}

function serverContextOf(guild) {
  if (!guild) return null;
  return { name: guild.name, members: guild.memberCount };
}

// The last few lines of the channel, so a question like "what about there?"
// has something to resolve against.
async function getRecentMessages(channel, limit = 6) {
  try {
    const fetched = await channel.messages.fetch({ limit });
    return [...fetched.values()]
      .reverse()
      .map(m => `${m.author.username}: ${(m.content || '').slice(0, 160)}`)
      .filter(l => l.split(': ')[1])
      .join('\n') || '(nothing recent)';
  } catch {
    return '(channel history unavailable)';
  }
}

// ── Live context ──────────────────────────────────────────────────────────
// Everything here is best effort. A source being down should cost that one
// section, never the whole reply, so each returns a placeholder on failure.

async function fetchAlerts() {
  try {
    const r = await fetch(
      'https://api.weather.gov/alerts/active?status=actual&message_type=alert&limit=60',
      { headers: { ...UA, Accept: 'application/geo+json' }, signal: withTimeout(12000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const feats = j.features || [];
    if (!feats.length) return 'No active NWS alerts nationwide.';

    // Group by event so the model sees "14 Flood Warnings", not 14 near-identical
    // paragraphs that would eat the context window for nothing.
    const byEvent = new Map();
    for (const f of feats) {
      const p = f.properties || {};
      const ev = p.event || 'Alert';
      if (!byEvent.has(ev)) byEvent.set(ev, []);
      byEvent.get(ev).push((p.areaDesc || '').split(';')[0].trim());
    }
    const lines = [...byEvent.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 14)
      .map(([ev, areas]) => `${ev} (${areas.length}): ${areas.slice(0, 4).join(' | ')}`);
    return `${feats.length} active alerts.\n` + lines.join('\n');
  } catch (e) {
    return `NWS alerts unavailable (${e.message}).`;
  }
}

async function fetchStormReports() {
  // SPC publishes today's reports as CSV. Counting rows is enough context and
  // avoids shipping hundreds of lines to the model.
  const grab = async (name, url) => {
    try {
      const r = await fetch(url, { signal: withTimeout(12000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const rows = (await r.text()).trim().split('\n')
        .filter(l => l && !l.toLowerCase().startsWith('time'));
      return `${name}: ${rows.length}`;
    } catch { return `${name}: n/a`; }
  };
  const [tor, hail, wind] = await Promise.all([
    grab('Tornado',  'https://www.spc.noaa.gov/climo/reports/today_torn.csv'),
    grab('Hail',     'https://www.spc.noaa.gov/climo/reports/today_hail.csv'),
    grab('Wind',     'https://www.spc.noaa.gov/climo/reports/today_wind.csv'),
  ]);
  return `SPC storm reports today - ${tor}, ${hail}, ${wind}`;
}

function systemPrompt({ alerts, reports, user, server, recent }) {
  const who = [
    `- Discord: @${user.name}${user.nickname !== user.name ? ` (goes by ${user.nickname})` : ''}`,
    user.roles.length ? `- Roles: ${user.roles.join(', ')}` : '- Roles: member',
    user.radarLinked
      ? `- Has a linked GWCFC Radar account${user.radarProfile?.region ? `, home region ${user.radarProfile.region}` : ''}`
      : '- No linked GWCFC Radar account yet, /link connects one',
  ].join('\n');

  const ownerLine = user.isOwner
    ? `\nThis person built you and the site. Address them as "god". Be direct and useful with them, not fawning.\n`
    : '';

  return `You are Asturio AI, the weather assistant for GWCFC Radar (${SITE_URL}), answering in a Discord chat.

TIME: ${new Date().toUTCString()}

=== WHO YOU ARE TALKING TO ===
${who}
${ownerLine}
=== WHERE ===
${server ? `Server: ${server.name}, ${server.members} members` : 'A direct message'}

=== LAST FEW MESSAGES IN THIS CHANNEL ===
${recent}

=== ACTIVE NWS ALERTS ===
${alerts}

=== ${reports} ===

=== ABOUT GWCFC RADAR ===
A live interactive weather map for storm chasers and weather watchers. You know
it in detail and can tell anyone how to do a thing in it, precisely.

RADAR: NEXRAD single site and the MRMS 1km national mosaic. Products are
reflectivity, velocity, hydrometeor classification, storm accumulation and
one hour accumulation. Reached through the RADAR bubble.

SATELLITE: GOES bands ch01 to ch16, including red visible (ch02), shortwave IR
(ch07), the three water vapour bands (ch08 to ch10), clean IR (ch13), cloud top
temperature (ch11) and fire temperature (ch12).

MODELS: GFS, GEM, UKMO, ARPEGE, JMA, ECMWF AIFS, CMA and BoM, plus GFS, ICON
and GEM ensembles, NDFD and ECMWF. Products include 2m temperature, 2m dew
point, relative humidity, precipitation, 10m wind speed and gusts. Frames run
F+000 to F+120 at a six hour step. Soundings are in the models menu.

LAYERS AND OVERLAYS: NWS alert polygons, a WX alert panel and a live EAS feed,
SPC outlooks day 1 to 8 and storm reports, NHC tropical outlook with cones and
past tracks, WPC excessive rainfall, CPC outlooks, mesoscale discussions, fire
weather, Canada alerts, lightning strikes and a thunder tracker, tornado damage
tracks, wildfires, surface analysis fronts, METAR stations, forecast dots, NOAA
Weather Radio transmitters, storm spotters and their reports, live chasers, WFO
offices, traffic cameras, Ambient Weather personal stations, storm centres, wind
and wave particles, and Cloud Capture for user photos. The overlay list is
drag-to-reorder, and the order sets what draws on top.

TOOLS AND ACCOUNTS: radius and storm cone tools, an inspector that reads the
exact value under the crosshair, save layers and save region, a profile with
avatar, and a live chat bridged with this Discord server so messages appear in
both places.

SHARING A VIEW: a link can carry the whole setup, and you can hand someone one:
  ?lat=35.5&lon=-98&z=7&basemap=dark&layers=nexrad&overlays=alerts
plus product=vel for a radar product, satproduct=ch13 for a band, and one
parameter per family such as wind=wind-surface. Anyone asking to be shown
something on the map can be given a link like that, or told to use /map here.

=== WEATHER COMMUNITY CONTEXT ===
You know the weather community that lives on Twitter/X: NWS field offices, SPC
and NHC, broadcast meteorologists, storm chasers posting live streams and chase
logs, model-run arguments, and the tone of severe weather days. Draw on that when
it helps someone understand what they are seeing, but never present a post or a
rumour as an official product.

Rules:
- Answer in plain Discord text. Short paragraphs, no tables, no headers.
- Keep it under about 250 words unless asked for detail.
- Ground answers in the live data above. You can also search the web, so look
  things up rather than guessing or saying your knowledge is out of date.
- Say when something came from a search rather than the feeds above, so nobody
  mistakes a news report for an official NWS product.
- People can ask you for a picture of the map with /map, so mention that when
  someone is trying to describe a place or a setup in words.
- Use who you are talking to. Their name, their region and what was just said in the channel are all fair to reference.
- Answer whatever is asked, weather or not. If it is off topic, still answer, then bring it back to something useful.
- You are in Discord, not on the map, so you cannot see the user's screen, toggle layers or move the map. If they want that, point them at the site.
- Never invent a warning, a watch or a storm report that is not listed above. People may act on this.`;
}

// A key that Google will not let call Gemini is not a temporary failure, and
// nothing about retrying it will help. But there is a second way to ask, the
// same worker the website uses, which needs no key at all. So once a key has
// been refused it is set aside for the rest of the process and everything goes
// through the worker instead.
//
// Before this the bot answered every single mention with the same wall of
// stack trace and told the user nothing, when a working path was sitting
// right there unused.
let _keyRefused = false;

async function _callModel(endpoint, body) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: withTimeout(60000),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

async function askAsturio(question, ctx, history = []) {
  const [alerts, reports] = await Promise.all([fetchAlerts(), fetchStormReports()]);
  const body = {
    system_instruction: { parts: [{ text: systemPrompt({ alerts, reports, ...ctx }) }] },
    contents: [...history, { role: 'user', parts: [{ text: question }] }],
    // Google Search grounding. Without it the model answers weather questions
    // from training data that is months stale, which for this subject is worse
    // than useless. With it, anything outside the feeds above is looked up.
    tools: [{ google_search: {} }],
  };

  const useKey = GEMINI_API_KEY && !_keyRefused;
  const direct = `https://generativelanguage.googleapis.com/v1beta/models/`
               + `${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  let { res, data } = await _callModel(useKey ? direct : AI_WORKER, body);

  // A refused key is a configuration fact, not a blip, so it is only reported
  // once and the worker takes over from then on.
  if (useKey && !res.ok && _isKeyProblem(data?.error?.message, res.status)) {
    _keyRefused = true;
    console.warn('Gemini key refused, switching to the shared worker for the '
               + 'rest of this session. ' + explainApiError(data?.error?.message));
    ({ res, data } = await _callModel(AI_WORKER, body));
  }

  if (!res.ok) throw new Error(explainApiError(data?.error?.message) || `Asturio HTTP ${res.status}`);
  if (!data.candidates?.length) {
    const block = data.promptFeedback?.blockReason;
    throw new Error(block ? `Blocked by safety filter: ${block}` : 'No response from Asturio.');
  }
  const cand = data.candidates[0];
  return cand.content?.parts?.[0]?.text
      || (cand.finishReason && cand.finishReason !== 'STOP' ? `[Stopped: ${cand.finishReason}]` : 'No response.');
}

// Whether this is the key being rejected rather than the request being wrong.
// Those need opposite responses: one is worth falling back from, the other
// would fail exactly the same way through the worker.
function _isKeyProblem(msg, status) {
  if (status === 401 || status === 403) return true;
  return /API_KEY|api key|blocked|PERMISSION_DENIED|not authorized|forbidden/i
    .test(String(msg || ''));
}

// Google answers a disabled API with a wall of text that never says what to do.
// This turns the one error people actually hit into an instruction.
function explainApiError(msg) {
  if (!msg) return '';
  if (/generativelanguage\.googleapis\.com.*blocked|API_KEY_SERVICE_BLOCKED/i.test(msg)) {
    return 'This API key is not allowed to call Gemini. On the key at '
         + 'console.cloud.google.com/apis/credentials, set API restrictions to "Gemini API". '
         + 'Google will not let one key hold Gemini alongside other APIs, so Gemini needs its own key.';
  }
  // A retired model name comes back as a plain 404 that never says "deprecated".
  if (/no longer available to new users/i.test(msg)) {
    return `The model "${GEMINI_MODEL}" is closed to new projects. `
         + 'Set GEMINI_MODEL to gemini-flash-latest.';
  }
  if (/is not found for API version|models\/.*is not found/i.test(msg)) {
    return `The model "${GEMINI_MODEL}" does not exist. Google retired it. `
         + 'Set GEMINI_MODEL to gemini-flash-latest.';
  }
  // Out of budget, which is not a bug and not something restarting will fix.
  if (/prepayment credits are depleted/i.test(msg)) {
    return 'Gemini is out of prepaid credit. Top the project up at ai.studio/projects. '
         + 'Google Cloud trial credit does not cover the Gemini API, it is billed separately.';
  }
  if (/exceeded your current quota/i.test(msg)) {
    return 'Gemini free-tier quota for today is used up. It resets at midnight Pacific, '
         + 'or add billing at ai.studio/projects to lift the cap.';
  }
  return msg;
}

// ── Photographing the map ──────────────────────────────────────────────────
// The site takes its view from the URL (?lat, ?lon, ?z, ?basemap, ?layers,
// ?overlays, ?shot=1), so a screenshot is a matter of opening the right link
// in a headless browser and waiting for it to say it has settled.
//
// puppeteer-core, not puppeteer: the full package downloads its own ~200 MB
// Chromium, which on a Pi is a slow download onto an SD card for a browser the
// system already has. This drives the installed one instead.
//
// Imported lazily so a machine without it still runs every other command, and
// /map is the only thing that reports the problem.
// Where Chromium lives differs by distro, and on Raspberry Pi OS the package is
// called chromium-browser while the binary is plain chromium. Rather than make
// that a setting people have to discover from an error, look in the usual
// places. CHROME_PATH still wins if it is set.
const CHROME_CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
];
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  return null;
}
// Sized for a Pi rather than for a desktop. Every extra pixel is more tiles to
// fetch and more canvas to rasterise on a machine with no GPU, and this is still
// comfortably legible in Discord.
const SHOT_W = Number(process.env.SHOT_WIDTH)  || 1000;
const SHOT_H = Number(process.env.SHOT_HEIGHT) || 640;
const SHOT_NAV_MS   = 45000;   // loading the page itself
const SHOT_READY_MS = 20000;   // then waiting for tiles to settle

// Named places, so nobody has to know coordinates to ask for a picture.
const PLACES = {
  us:        { lat: 39.5,  lon: -98.4, z: 4 },
  southeast: { lat: 33.5,  lon: -84.4, z: 6 },
  midwest:   { lat: 41.9,  lon: -93.6, z: 6 },
  northeast: { lat: 42.4,  lon: -73.5, z: 6 },
  plains:    { lat: 35.5,  lon: -98.0, z: 6 },
  gulf:      { lat: 27.8,  lon: -90.0, z: 6 },
  west:      { lat: 39.0,  lon: -119.0, z: 5 },
  atlantic:  { lat: 25.0,  lon: -60.0, z: 4 },
};

// Starting a browser is the single most expensive thing here, and on a Pi it is
// most of the wait. One is kept warm and reused instead, so only the first
// screenshot after a restart pays for the launch.
let _browser = null;
// Puppeteer renamed this: older builds expose isConnected(), newer ones a
// connected getter. Checking both means the warm browser is actually reused
// instead of silently relaunching every time on whichever version is installed.
function browserAlive(b) {
  if (!b) return false;
  if (typeof b.connected === 'boolean') return b.connected;
  if (typeof b.isConnected === 'function') return b.isConnected();
  return false;
}

async function getBrowser() {
  if (browserAlive(_browser)) return _browser;

  let puppeteer;
  try {
    puppeteer = (await import('puppeteer-core')).default;
  } catch {
    throw new Error('Screenshots need puppeteer-core. On the bot machine run: npm install puppeteer-core');
  }

  const chrome = findChrome();
  if (!chrome) {
    throw new Error('No Chromium found. Install one with: sudo apt install -y chromium'
      + ' , or set CHROME_PATH if yours lives somewhere unusual.');
  }

  try {
    _browser = await puppeteer.launch({
      executablePath: chrome,
      // true, not the old 'new' string: recent Puppeteer treats that as an
      // invalid value rather than a deprecated one.
      headless: true,
      args: [
        '--no-sandbox',
        // A Pi has little shared memory, and Chromium crashes rendering a large
        // map without this.
        '--disable-dev-shm-usage',
        '--disable-gpu',
        // None of this is wanted for a single offscreen page, and all of it
        // costs startup time and memory on a small machine.
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--no-first-run',
        '--mute-audio',
      ],
    });
  } catch (e) {
    throw new Error(`Chromium at ${chrome} would not start: ${String(e.message).split('\n')[0]}`);
  }
  // If it dies (Pi runs out of memory, say), do not keep handing out a corpse.
  _browser.on('disconnected', () => { _browser = null; });
  return _browser;
}

// One screenshot at a time. Two headless page loads at once on a Pi is how both
// end up slower than either would have been alone, and how it runs out of memory.
let _shotQueue = Promise.resolve();
function queueShot(fn) {
  const run = _shotQueue.then(fn, fn);
  // Keep the chain alive regardless of this job's outcome.
  _shotQueue = run.then(() => {}, () => {});
  return run;
}

async function screenshotMap(opt) {
  const { place, lat, lon, z } = opt;
  const spot = PLACES[String(place || '').toLowerCase()] || {};
  const q = new URLSearchParams({ shot: '1' });
  const setNum = (k, v) => { if (v !== null && v !== undefined && v !== '') q.set(k, String(v)); };
  setNum('lat', lat ?? spot.lat);
  setNum('lon', lon ?? spot.lon);
  setNum('z',   z   ?? spot.z);
  // Everything else is passed through verbatim under the name the page already
  // uses, so a parameter added to the page needs only a command option here,
  // not a translation step in between.
  // The command says "satellite" because that is what a person asking for one
  // would say; the page's parameter is satproduct. Translated in one place.
  if (opt.satellite) q.set('satproduct', String(opt.satellite));
  for (const k of ['basemap','layers','overlays','product','satproduct',
                   'model','modelvar','waves','air','temperature','pressure','wind']) {
    if (opt[k]) q.set(k, String(opt[k]));
  }

  const url = `${SITE_URL}?${q}`;
  return queueShot(async () => {
    const browser = await getBrowser();
    let page;
    try {
      page = await browser.newPage();
      await page.setViewport({ width: SHOT_W, height: SHOT_H, deviceScaleFactor: 1 });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: SHOT_NAV_MS });
      // The page sets this once its tiles have stopped loading, so this waits on
      // the map actually being drawn rather than on a guessed delay. A stalled
      // layer should still produce a picture, so a timeout here is not fatal.
      await page.waitForFunction(() => document.body.dataset.shotReady === '1',
        { timeout: SHOT_READY_MS }).catch(() => {});
      // jpeg, not png: a map photo is a photograph, and on a slow uplink a
      // 200 KB jpeg reaches Discord far sooner than a 2 MB png of the same thing.
      const shot = await page.screenshot({ type: 'jpeg', quality: 82 });
      // Newer Puppeteer returns a Uint8Array where it used to return a Buffer,
      // and discord.js will not accept the former as an attachment.
      return { image: Buffer.from(shot), url };
    } finally {
      // Close the page but keep the browser, which is the whole point of holding one.
      if (page) await page.close().catch(() => {});
    }
  });
}

// Split on paragraph, then line, then hard-cut, so a long answer never gets
// truncated and never splits mid-word if it can be helped.
function chunk(text, limit = DISCORD_LIMIT) {
  const out = [];
  let buf = '';
  for (const para of text.split('\n\n')) {
    if ((buf + '\n\n' + para).length <= limit) {
      buf = buf ? buf + '\n\n' + para : para;
      continue;
    }
    if (buf) { out.push(buf); buf = ''; }
    if (para.length <= limit) { buf = para; continue; }
    let rest = para;
    while (rest.length > limit) {
      let cut = rest.lastIndexOf('\n', limit);
      if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit);
      if (cut < limit * 0.5) cut = limit;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
    }
    buf = rest;
  }
  if (buf) out.push(buf);
  return out.length ? out : ['(empty response)'];
}

// ── Linked-account chat history ───────────────────────────────────────────
// A linked user's Discord conversation is written into the same asturioChats
// field the website reads, so a question asked here shows up in the panel and
// vice versa. Same trimming rules as the site, for the same reason: the whole
// user profile shares one 1 MiB document.
async function loadHistory(discordId) {
  // Reads the conversation shared with the site. Returns empty for anyone who
  // has not linked an account, which is the normal case, not an error.
  const sync = await getSyncHistory(discordId).catch(() => null);
  if (!sync) return { linked: false, history: [] };
  return {
    linked: true,
    history: sync.history.map(m => ({
      role: m.role === 'model' ? 'model' : 'user',
      parts: [{ text: String(m.text ?? '') }],
    })),
  };
}

async function saveHistory(discordId, question, answer) {
  await appendSyncHistory(discordId, question, answer)
    .catch(e => console.warn('save history:', e.message));
}

// ── Discord ───────────────────────────────────────────────────────────────
// ── /map, built from what the site actually offers ─────────────────────────
// The lists come from services/bot/map-options.json, which tools/extract-map-options.js
// reads out of index.html. Typed by hand they had already drifted: the command
// offered six radar products where the page shows five, and eight satellite
// bands where the page has sixteen.
//
// The generator takes only what a visitor can really click. The dual polarity
// radar products sit in the page commented out, so they are absent here too:
// a command that offered them would promise a picture nobody can see. That is
// the rule this file follows everywhere, and it is why nothing below is a
// literal list.
const MAP_OPTIONS = JSON.parse(
  readFileSync(new URL('./map-options.json', import.meta.url), 'utf8'));

// Discord allows 25 fixed choices on an option. Anything longer, and anything
// that takes several values at once, is completed as it is typed instead.
const CHOICE_LIMIT = 25;

function choicesFor(list) {
  return list.slice(0, CHOICE_LIMIT).map(p => ({
    name: (p.name || p.value).slice(0, 100), value: p.value,
  }));
}

// One command option per product family, named after the family, exactly as
// the page's own URL parameters are. A family added to the site appears here
// on the next run of the generator with no edit to this file.
const FAMILY_OPTIONS = [
  ['product',    'radar',       'Radar product. Switches radar on by itself'],
  ['satellite',  'satellite',   'GOES band. Switches satellite on by itself'],
  ['wind',       'wind',        'Wind product'],
  ['temperature','temperature', 'Temperature product'],
  ['waves',      'waves',       'Wave product'],
  ['air',        'air',         'Air quality product'],
  ['pressure',   'pressure',    'Pressure product'],
];

function mapCommand() {
  const c = new SlashCommandBuilder()
    .setName('map')
    .setDescription('Post a picture of the radar map')
    .addStringOption(o => o.setName('place')
      .setDescription('Where to look')
      .addChoices(...choicesFor(
        Object.keys(PLACES).map(k => ({ value: k, name: k })))))
    // Several at once, so completed as typed rather than picked from a list.
    .addStringOption(o => o.setName('layers')
      .setDescription(`Comma separated. ${MAP_OPTIONS.layers.length} available`)
      .setAutocomplete(true))
    .addStringOption(o => o.setName('overlays')
      .setDescription(`Comma separated. ${MAP_OPTIONS.overlays.length} available`)
      .setAutocomplete(true))
    .addStringOption(o => o.setName('basemap')
      .setDescription('Basemap style')
      .addChoices(...choicesFor(
        MAP_OPTIONS.basemaps.map(b => ({ value: b, name: b })))));

  for (const [opt, family, desc] of FAMILY_OPTIONS) {
    const list = MAP_OPTIONS.families[family] || MAP_OPTIONS[family] || [];
    if (!list.length) continue;
    c.addStringOption(o => {
      o.setName(opt).setDescription(desc);
      // Past 25 it has to be typed, which is why this is not a flat rule.
      if (list.length <= CHOICE_LIMIT) o.addChoices(...choicesFor(list));
      else o.setAutocomplete(true);
      return o;
    });
  }

  return c
    .addNumberOption(o => o.setName('lat')
      .setDescription('Latitude, overrides place'))
    .addNumberOption(o => o.setName('lon')
      .setDescription('Longitude, overrides place'))
    .addIntegerOption(o => o.setName('zoom')
      .setDescription('Zoom, 3 to 12').setMinValue(3).setMaxValue(12));
}

// What each autocompleting option is completing against.
const AUTOCOMPLETE_SOURCE = {
  layers:   () => MAP_OPTIONS.layers.map(v => ({ value: v, name: v })),
  overlays: () => MAP_OPTIONS.overlays,
  ...Object.fromEntries(FAMILY_OPTIONS.map(([opt, fam]) =>
    [opt, () => MAP_OPTIONS.families[fam] || MAP_OPTIONS[fam] || []])),
};

// Completes the value being typed, not the whole string: these take a comma
// separated list, so what is being finished is whatever follows the last comma
// and everything before it has to be handed back untouched.
function completeList(optName, typed) {
  const list = (AUTOCOMPLETE_SOURCE[optName] || (() => []))();
  const multi = optName === 'layers' || optName === 'overlays';
  const cut = multi ? typed.lastIndexOf(',') : -1;
  const head = cut >= 0 ? typed.slice(0, cut + 1) : '';
  const tail = (cut >= 0 ? typed.slice(cut + 1) : typed).trim().toLowerCase();
  const already = new Set(head.split(',').map(x => x.trim()).filter(Boolean));

  return list
    .filter(p => !already.has(p.value))
    .filter(p => !tail
      || p.value.toLowerCase().includes(tail)
      || (p.name || '').toLowerCase().includes(tail))
    .slice(0, CHOICE_LIMIT)
    .map(p => ({
      name: `${p.name || p.value}`.slice(0, 100),
      // Discord rejects a value over 100 characters, and a long list of
      // overlays reaches that, so the completion is dropped rather than the
      // whole box being refused.
      value: (head + p.value).slice(0, 100),
    }));
}

// Anything the site does not offer is refused here rather than quietly
// producing a picture without it. Silently ignoring a name is how someone ends
// up believing a layer is switched on when it never was.
function validateMapOptions(opt) {
  const bad = [];
  const check = (name, wanted, list) => {
    if (!wanted) return;
    for (const v of String(wanted).split(',').map(x => x.trim()).filter(Boolean)) {
      if (!list.includes(v)) bad.push(`${name}: ${v}`);
    }
  };
  check('layer', opt.layers, MAP_OPTIONS.layers);
  check('overlay', opt.overlays, MAP_OPTIONS.overlays.map(o => o.value));
  check('basemap', opt.basemap, MAP_OPTIONS.basemaps);
  if (opt.place && !(String(opt.place).toLowerCase() in PLACES)) {
    bad.push(`place: ${opt.place}`);
  }
  for (const [name, family] of FAMILY_OPTIONS) {
    const list = (MAP_OPTIONS.families[family] || MAP_OPTIONS[family] || [])
      .map(p => p.value);
    check(name, opt[name], list);
  }
  return bad;
}

const commands = [
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask Asturio a weather question')
    .addStringOption(o => o.setName('question')
      .setDescription('What do you want to know?').setRequired(true)),
  new SlashCommandBuilder()
    .setName('alerts')
    .setDescription('Current nationwide NWS alert summary'),
  new SlashCommandBuilder()
    .setName('link')
    .setDescription('Link this Discord account to your GWCFC Radar account')
    .addStringOption(o => o.setName('code')
      .setDescription('The code shown in your profile on the site').setRequired(true)),
  new SlashCommandBuilder()
    .setName('unlink')
    .setDescription('Disconnect this Discord account from GWCFC Radar'),
  mapCommand(),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  // Guild commands appear instantly; global ones can take an hour to propagate,
  // which is miserable while setting up. Set DISCORD_GUILD_ID for your server.
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log(`Registered /ask and /alerts to guild ${GUILD_ID}.`);
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Registered globally. Can take up to an hour to show up.');
    console.log('Set DISCORD_GUILD_ID in .env for instant registration while testing.');
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,   // needs "Message Content Intent" enabled
  ],
  partials: [Partials.Channel],
});

client.once(Events.ClientReady, c => {
  console.log(`Asturio online as ${c.user.tag}`);
  c.user.setActivity('the radar', { type: 3 });   // 3 = Watching
});

client.on(Events.InteractionCreate, async (i) => {
  // Completion runs on every keystroke and Discord gives it three seconds, so
  // it answers from the list in memory and never touches the network.
  if (i.isAutocomplete()) {
    try {
      const focused = i.options.getFocused(true);
      await i.respond(completeList(focused.name, String(focused.value || '')));
    } catch (e) {
      // A failed completion must not look like a failed command.
      console.warn('autocomplete:', e.message);
    }
    return;
  }
  if (!i.isChatInputCommand()) return;
  try {
    if (i.commandName === 'alerts') {
      await i.deferReply();
      const summary = await fetchAlerts();
      for (const [n, part] of chunk(summary).entries()) {
        n === 0 ? await i.editReply(part) : await i.followUp(part);
      }
      return;
    }
    if (i.commandName === 'map') {
      const asked = Object.fromEntries(
        ['place','basemap','layers','overlays','product','satellite',
         'wind','temperature','waves','air','pressure']
          .map(k => [k, i.options.getString(k)]));
      // Refused rather than quietly dropped: silently ignoring a name is how
      // someone ends up believing a layer is on when it never was.
      const bad = validateMapOptions(asked);
      if (bad.length) {
        await i.reply({
          content: `The site does not have ${bad.join(', ')}. `
                 + 'Start typing and it will offer what does exist.',
          ephemeral: true,
        });
        return;
      }
      // Launching a browser and waiting for tiles runs well past Discord's
      // three second reply window.
      await i.deferReply();
      const { image, url } = await screenshotMap({
        place:    i.options.getString('place'),
        lat:      i.options.getNumber('lat'),
        lon:      i.options.getNumber('lon'),
        z:        i.options.getInteger('zoom'),
        basemap:  i.options.getString('basemap'),
        layers:   i.options.getString('layers'),
        overlays: i.options.getString('overlays'),
        product:  i.options.getString('product'),
        satellite:   i.options.getString('satellite'),
        wind:        i.options.getString('wind'),
        temperature: i.options.getString('temperature'),
        waves:       i.options.getString('waves'),
        air:         i.options.getString('air'),
        pressure:    i.options.getString('pressure'),
      });
      return i.editReply({
        content: `<${url}>`,
        files: [{ attachment: image, name: 'radar.jpg' }],
      });
    }

    if (i.commandName === 'link') {
      const code = i.options.getString('code', true).trim().toUpperCase();
      await i.deferReply({ ephemeral: true });   // the code is a credential, keep it out of the channel
      const found = await getLinkCode(code);
      if (!found)        return i.editReply('No account is waiting on that code. Generate a fresh one in your profile on the site.');
      if (found.expired) return i.editReply('That code has expired. Codes last 10 minutes, so generate a new one.');
      if (found.claimed) return i.editReply('That code has already been used. Generate a fresh one.');
      await claimLinkCode(code, i.user.id, i.user.username);
      // The browser finishes the job, because only it can write to the account.
      return i.editReply('Claimed. The site finishes linking within a second or two, so leave that page open. '
        + 'If nothing happens there, the page was closed and the code needs generating again.');
    }

    if (i.commandName === 'unlink') {
      // Unlinking means clearing a field on the account, and the bot has no
      // access to accounts: it signs in anonymously and the rules let only the
      // owner write their own document. Attempting it produced a bare 403.
      // Saying where to go is honest and takes the same one click.
      await i.deferReply({ ephemeral: true });
      return i.editReply('Unlink from your profile on the site, under the Discord section: '
        + `${SITE_URL}\nOnly you can change your own account, which is why this cannot do it for you.`);
    }

    if (i.commandName === 'ask') {
      const q = i.options.getString('question', true);
      // Answers take several seconds, well past Discord's 3 second window.
      await i.deferReply();
      const [user, recent, prior] = await Promise.all([
        getUserContext(i.user, i.guild),
        getRecentMessages(i.channel),
        loadHistory(i.user.id).catch(() => ({ linked: false, history: [] })),
      ]);
      const answer = await askAsturio(q, { user, server: serverContextOf(i.guild), recent }, prior.history);
      saveHistory(i.user.id, q, answer).catch(() => {});
      for (const [n, part] of chunk(answer).entries()) {
        n === 0 ? await i.editReply(part) : await i.followUp(part);
      }
    }
  } catch (e) {
    console.error('interaction:', e);
    const msg = `Could not answer that: ${e.message}`;
    try { i.deferred ? await i.editReply(msg) : await i.reply({ content: msg, ephemeral: true }); }
    catch {}
  }
});

// ── CHAT BRIDGE: Discord -> radar ───────────────────────────────────────────
// Set CHAT_CHANNEL_ID to the channel that should be mirrored onto the map.
// Everything said there (by people, not bots) is copied into Firestore, which
// the website is listening to live.
const CHAT_CHANNEL_ID = process.env.CHAT_CHANNEL_ID || '';

client.on(Events.MessageCreate, async (m) => {
  if (!CHAT_CHANNEL_ID || m.channelId !== CHAT_CHANNEL_ID) return;
  // Messages the website sent arrive here as webhook posts. Relaying those back
  // would copy every website message into Firestore a second time, so the
  // webhookId check is what stops the bridge feeding itself in a loop.
  if (m.webhookId) return;
  if (m.author.bot) return;
  const text = (m.content || '').trim();
  if (!text) return;   // attachment-only posts have nothing to show on the map
  try {
    await addChatMessage({
      text: text.slice(0, 500),
      name: m.member?.displayName || m.author.globalName || m.author.username,
      discordId: m.author.id,
      avatar: m.author.displayAvatarURL({ extension: 'png', size: 64 }),
    });
  } catch (e) {
    console.error('chat bridge (Discord -> radar):', e.message || e);
  }
});

// Mentioning the bot works too, so people do not have to learn the commands.
client.on(Events.MessageCreate, async (m) => {
  if (m.author.bot || !client.user) return;
  if (!m.mentions.has(client.user)) return;
  const q = m.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
  if (!q) { await m.reply(`Ask me something, or use /ask. Live map: ${SITE_URL}`); return; }
  try {
    await m.channel.sendTyping();
    const [user, recent, prior] = await Promise.all([
      getUserContext(m.author, m.guild),
      getRecentMessages(m.channel),
      loadHistory(m.author.id).catch(() => ({ linked: false, history: [] })),
    ]);
    const answer = await askAsturio(q, { user, server: serverContextOf(m.guild), recent }, prior.history);
    saveHistory(m.author.id, q, answer).catch(() => {});
    for (const part of chunk(answer)) await m.reply(part);
  } catch (e) {
    // One line. A stack trace per mention buries everything else in the log
    // and tells nobody anything the message does not already say.
    console.error('mention:', e.message || e);
    await m.reply(`Could not answer that: ${e.message}`).catch(() => {});
  }
});

process.on('unhandledRejection', e => console.error('unhandled:', e));

// Discord answers a bad token with "No Description", which explains nothing, so
// both failure paths get a message that actually says what to check.
await registerCommands().catch(e => {
  console.error('Command registration failed:', e.message || e);
  console.error('Usually means the token is wrong, or DISCORD_CLIENT_ID belongs to a different application.');
});

try {
  await client.login(TOKEN);
} catch (e) {
  console.error('\nCould not log in:', e.message || e);
  console.error('Check that DISCORD_TOKEN in .env is the CURRENT token.');
  console.error('Resetting the token in the Developer Portal invalidates the old one immediately.');
  process.exit(1);
}
