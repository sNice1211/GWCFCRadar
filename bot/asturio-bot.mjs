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
import { existsSync } from 'node:fs';
import { getLinkCode, claimLinkCode, findUserByDiscordId, patchUser, addChatMessage, getUser } from './firestore.mjs';

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

  const linked = await findUserByDiscordId(user.id).catch(() => null);
  if (linked) {
    ctx.radarLinked = true;
    const profile = await getUser(linked.uid).catch(() => null);
    if (profile) {
      ctx.radarProfile = {
        name: profile.displayName || '',
        region: profile.homeRegion || '',
      };
    }
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
A live interactive weather map for storm chasers and weather watchers. Radar and
MRMS, satellite, NWS alerts, lightning and thunder tracking, webcams, model data
(HRRR, NAM, GFS, ECMWF), soundings, SPC outlooks and storm reports, boundaries,
wind and wave particles, air quality, and a live chat that is bridged with this
Discord server, so messages here appear on the map and the other way round.

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

async function askAsturio(question, ctx, history = []) {
  const [alerts, reports] = await Promise.all([fetchAlerts(), fetchStormReports()]);
  const contents = [
    ...history,
    { role: 'user', parts: [{ text: question }] },
  ];
  const endpoint = GEMINI_API_KEY
    ? `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`
    : AI_WORKER;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt({ alerts, reports, ...ctx }) }] },
      contents,
      // Google Search grounding. Without it the model answers weather questions
      // from training data that is months stale, which for this subject is worse
      // than useless. With it, anything outside the feeds above is looked up.
      tools: [{ google_search: {} }],
    }),
    signal: withTimeout(60000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(explainApiError(data?.error?.message) || `Asturio HTTP ${res.status}`);
  if (!data.candidates?.length) {
    const block = data.promptFeedback?.blockReason;
    throw new Error(block ? `Blocked by safety filter: ${block}` : 'No response from Asturio.');
  }
  const cand = data.candidates[0];
  return cand.content?.parts?.[0]?.text
      || (cand.finishReason && cand.finishReason !== 'STOP' ? `[Stopped: ${cand.finishReason}]` : 'No response.');
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
const AI_SYNC_MAX_TURNS = 40;
const DISCORD_CHAT_NAME = 'Discord';

function discordChatFrom(chats) {
  const list = Array.isArray(chats) ? chats : [];
  const idx = list.findIndex(c => c && c.name === DISCORD_CHAT_NAME);
  return { list, idx };
}

async function loadHistory(discordId) {
  const found = await findUserByDiscordId(discordId).catch(() => null);
  if (!found) return { uid: null, history: [], chats: [] };
  const { list, idx } = discordChatFrom(found.data.asturioChats);
  const hist = idx >= 0 ? (list[idx].history || []) : [];
  return {
    uid: found.uid,
    chats: list,
    history: hist.map(m => ({ role: m.role === 'model' ? 'model' : 'user', parts: [{ text: String(m.text ?? '') }] })),
  };
}

async function saveHistory(uid, chats, question, answer) {
  if (!uid) return;
  const { list, idx } = discordChatFrom(chats);
  const turns = (idx >= 0 ? (list[idx].history || []) : []).concat(
    { role: 'user',  text: String(question).slice(0, 6000) },
    { role: 'model', text: String(answer).slice(0, 6000) },
  ).slice(-AI_SYNC_MAX_TURNS);

  const entry = { id: idx >= 0 ? list[idx].id : 9001, name: DISCORD_CHAT_NAME, history: turns };
  const next = idx >= 0 ? list.map((c, i) => (i === idx ? entry : c)) : [...list, entry];
  await patchUser(uid, { asturioChats: next }).catch(e => console.warn('save history:', e.message));
}

// ── Discord ───────────────────────────────────────────────────────────────
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
  new SlashCommandBuilder()
    .setName('map')
    .setDescription('Post a picture of the radar map')
    .addStringOption(o => o.setName('place')
      .setDescription('Where to look')
      .addChoices(...Object.keys(PLACES).map(k => ({ name: k, value: k }))))
    .addStringOption(o => o.setName('layers')
      .setDescription('Comma separated, e.g. nexrad,tornado,lightning'))
    .addStringOption(o => o.setName('overlays')
      .setDescription('Comma separated, e.g. alerts,spc-outlook,wind-particles'))
    .addStringOption(o => o.setName('basemap')
      .setDescription('Basemap style')
      .addChoices(
        { name: 'satellite', value: 'satellite' },
        { name: 'dark',      value: 'dark' },
        { name: 'light',     value: 'light' },
        { name: 'topo',      value: 'topo' },
      ))
    // Only what the radar sub-bubbles actually offer. The dual-pol products are
    // commented out of that row, so offering them would promise a picture the
    // app cannot draw.
    .addStringOption(o => o.setName('product')
      .setDescription('Radar product. Switches radar on by itself')
      .addChoices(
        { name: 'reflectivity',       value: 'ref' },
        { name: 'velocity',           value: 'vel' },
        { name: 'MRMS 1km',           value: 'mrms' },
        { name: 'hydrometeor class',  value: 'hc' },
        { name: 'storm accumulation', value: 'accum' },
        { name: 'one hour accum',     value: 'boha' },
      ))
    .addStringOption(o => o.setName('satellite')
      .setDescription('GOES band. Switches satellite on by itself')
      .addChoices(
        { name: 'clean IR (ch13)',        value: 'ch13' },
        { name: 'red visible (ch02)',     value: 'ch02' },
        { name: 'mid water vapor (ch09)', value: 'ch09' },
        { name: 'upper water vapor (ch08)', value: 'ch08' },
        { name: 'shortwave IR (ch07)',    value: 'ch07' },
        { name: 'cloud top temp (ch11)',  value: 'ch11' },
        { name: 'fire temp (ch12)',       value: 'ch12' },
        { name: 'snow and ice (ch05)',    value: 'ch05' },
      ))
    .addStringOption(o => o.setName('wind')
      .setDescription('Wind product, e.g. wind-surface'))
    .addStringOption(o => o.setName('temperature')
      .setDescription('Temperature product, e.g. air-temp or dew-point'))
    .addStringOption(o => o.setName('waves')
      .setDescription('Wave product, e.g. wave-height, wave-period, swell-height'))
    .addStringOption(o => o.setName('air')
      .setDescription('Air quality product, e.g. us-aqi, pm2_5, ozone'))
    .addStringOption(o => o.setName('pressure')
      .setDescription('Pressure product, e.g. sea-level'))
    .addNumberOption(o => o.setName('lat').setDescription('Latitude, overrides place'))
    .addNumberOption(o => o.setName('lon').setDescription('Longitude, overrides place'))
    .addIntegerOption(o => o.setName('zoom').setDescription('Zoom, 3 to 12')),
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
        // The command calls it satellite because that is what a person asking
        // for one would say; the page calls it satproduct.
        satproduct:  i.options.getString('satellite'),
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
      await i.deferReply({ ephemeral: true });
      const found = await findUserByDiscordId(i.user.id);
      if (!found) return i.editReply('This Discord account is not linked to anything.');
      await patchUser(found.uid, { discordId: '', discordTag: '' });
      return i.editReply('Unlinked. Chats here are no longer saved to your account.');
    }

    if (i.commandName === 'ask') {
      const q = i.options.getString('question', true);
      // Answers take several seconds, well past Discord's 3 second window.
      await i.deferReply();
      const [user, recent, prior] = await Promise.all([
        getUserContext(i.user, i.guild),
        getRecentMessages(i.channel),
        loadHistory(i.user.id).catch(() => ({ uid: null, history: [], chats: [] })),
      ]);
      const answer = await askAsturio(q, { user, server: serverContextOf(i.guild), recent }, prior.history);
      saveHistory(prior.uid, prior.chats, q, answer).catch(() => {});
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
      loadHistory(m.author.id).catch(() => ({ uid: null, history: [], chats: [] })),
    ]);
    const answer = await askAsturio(q, { user, server: serverContextOf(m.guild), recent }, prior.history);
    saveHistory(prior.uid, prior.chats, q, answer).catch(() => {});
    for (const part of chunk(answer)) await m.reply(part);
  } catch (e) {
    console.error('mention:', e);
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
