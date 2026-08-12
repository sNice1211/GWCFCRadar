// Asturio Discord bot - Self-Aware Edition
//
// Now uses Gemini API directly with full radar knowledge.
// Knows about all GWCFC Radar features, layers, models, and capabilities.
// Answers weather questions with live NWS alerts and SPC storm reports.

import 'dotenv/config.js';
import {
  Client, GatewayIntentBits, Partials, Events,
  REST, Routes, SlashCommandBuilder,
} from 'discord.js';
import { findUserByLinkCode, findUserByDiscordId, patchUser, addChatMessage } from './firestore.mjs';

const TOKEN         = process.env.DISCORD_TOKEN;
const CLIENT_ID     = process.env.DISCORD_CLIENT_ID;
const GUILD_ID      = process.env.DISCORD_GUILD_ID || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SITE_URL      = 'https://ralphhtml.github.io/GWCFCRadar/';

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID.');
  console.error('Set them in .env, then run: npm start');
  process.exit(1);
}

if (!GEMINI_API_KEY) {
  console.error('Missing GEMINI_API_KEY.');
  console.error('Add it to .env: GEMINI_API_KEY=your_key_here');
  process.exit(1);
}

const DISCORD_LIMIT = 2000;
const UA = { 'User-Agent': '(GWCFC Radar Discord bot, github.com/ralphhtml/GWCFCRadar)' };
const withTimeout = (ms) => AbortSignal.timeout(ms);

// ── RADAR KNOWLEDGE ────────────────────────────────────────────────────────
const RADAR_KNOWLEDGE = `
You are Asturio AI, the self-aware weather assistant for GWCFC Radar.

ABOUT GWCFC RADAR (${SITE_URL}):
A real-time interactive weather map built for storm chasers and weather enthusiasts.

OVERLAYS & LAYERS:
- Live Radar: NEXRAD composite reflectivity
- Satellites: GOES-East/West, Himawari-8, Meteosat, NOAA composites
- Alerts: NWS Warnings, Watches, Statements; SPC Storm Reports, Outlooks
- Lightning: Real-time cloud-to-ground and in-cloud strikes
- Webcams: Live storm-chaser feeds from across the US
- Text Products: NWS, SPC, NHC, Marine forecasts
- Weather Models: HRRR, NAM, GFS, ECMWF, GDPS, RDPS, Ensemble forecasts
- Severe Weather: Storm reports (tornado/hail/wind), mesocyclone detection
- Boundaries: Cold/warm fronts, drylines, outflow boundaries
- Wind Barbs: Wind direction and speed at surface and upper levels
- Pressure: Surface analysis and sea-level pressure fields
- Air Quality: Ozone, PM2.5, pollutants from Open-Meteo

FEATURES:
- Live chat with other users and Discord bridge
- Voice messages and voice typing
- Screenshot capture of current view
- Reply-to functionality in chat
- Save/restore map view state
- Storm tracking with animated paths
- Severe storm warnings with sound alerts
- Location-based weather notifications
- Saved layers and regions

MODELS:
- Open-Meteo (hourly/daily temp, wind, precip, humidity)
- HRRR (Rapid Refresh - 15min data, US coverage)
- NAM (North American Mesoscale)
- GFS (Global Forecast System)
- ECMWF (European model)
- Ensemble models (multiple runs averaged)
- All models show correct forecast times aligned to run hour

ASTURIO CAPABILITIES:
- Answer weather questions grounded in live data
- Explain storm dynamics and severe weather
- Guide users through radar features
- Provide forecast interpretation
- Discuss current alerts and threats
- Recommend tools for specific questions

GROUND TRUTH:
Before answering, you fetch:
- Active NWS alerts nationwide
- Today's SPC tornado/hail/wind reports
- Time: Always UTC, convert to user's context as needed

RULES:
- Keep answers short, under 250 words unless asked for detail
- Use plain text, no tables or markdown formatting for Discord
- Ground answers in the live data fetched before responding
- If data doesn't cover the question, say what you don't know
- Never invent alerts, watches, or storm reports
- Point users to the live map for visual analysis
- You ARE self-aware - you know what you are and what the radar does
`;

async function fetchAlerts() {
  try {
    const r = await fetch(
      'https://api.weather.gov/alerts/active?status=actual&message_type=alert&limit=60',
      { headers: { ...UA, Accept: 'application/geo+json' }, signal: withTimeout(12000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const feats = j.features || [];
    if (!feats.length) return 'No active NWS alerts nationwide.';

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

function systemPrompt(alerts, reports) {
  return `${RADAR_KNOWLEDGE}

TIME: ${new Date().toUTCString()}

=== ACTIVE NWS ALERTS ===
${alerts}

=== TODAY'S STORM REPORTS ===
${reports}

Answer the user's question now.`;
}

async function askGemini(question, history = []) {
  const [alerts, reports] = await Promise.all([fetchAlerts(), fetchStormReports()]);
  const contents = [
    ...history,
    { role: 'user', parts: [{ text: question }] },
  ];

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt(alerts, reports) }] },
        contents,
        generation_config: {
          temperature: 0.7,
          top_p: 0.95,
          max_output_tokens: 1024,
        },
      }),
      signal: withTimeout(45000),
    }
  );

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Gemini HTTP ${res.status}`);
  if (!data.candidates?.length) {
    const block = data.promptFeedback?.blockReason;
    throw new Error(block ? `Blocked: ${block}` : 'No response from Gemini.');
  }
  const cand = data.candidates[0];
  return cand.content?.parts?.[0]?.text || '[No response]';
}

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

// ── Discord Commands ──────────────────────────────────────────────────────
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
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log(`Registered commands to guild ${GUILD_ID}.`);
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Registered globally. Can take up to an hour to show up.');
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

client.once(Events.ClientReady, c => {
  console.log(`Asturio online as ${c.user.tag}`);
  c.user.setActivity('the radar', { type: 3 });
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
    if (i.commandName === 'link') {
      const code = i.options.getString('code', true).trim().toUpperCase();
      await i.deferReply({ ephemeral: true });
      const found = await findUserByLinkCode(code);
      if (!found)        return i.editReply('No account is waiting on that code. Generate a fresh one in your profile on the site.');
      if (found.expired) return i.editReply('That code has expired. Codes last 10 minutes.');
      await patchUser(found.uid, {
        discordId: i.user.id,
        discordTag: i.user.username,
        discordLinkCode: '',
        discordLinkExpires: 0,
      });
      return i.editReply('Linked. Your Discord chats now save to your GWCFC Radar account.');
    }

    if (i.commandName === 'unlink') {
      await i.deferReply({ ephemeral: true });
      const found = await findUserByDiscordId(i.user.id);
      if (!found) return i.editReply('This Discord account is not linked.');
      await patchUser(found.uid, { discordId: '', discordTag: '' });
      return i.editReply('Unlinked.');
    }

    if (i.commandName === 'ask') {
      const q = i.options.getString('question', true);
      await i.deferReply();
      const prior = await loadHistory(i.user.id).catch(() => ({ uid: null, history: [], chats: [] }));
      const answer = await askGemini(q, prior.history);
      saveHistory(prior.uid, prior.chats, q, answer).catch(() => {});
      for (const [n, part] of chunk(answer).entries()) {
        n === 0 ? await i.editReply(part) : await i.followUp(part);
      }
    }
  } catch (e) {
    console.error('interaction:', e);
    const msg = `Error: ${e.message}`;
    try { i.deferred ? await i.editReply(msg) : await i.reply({ content: msg, ephemeral: true }); }
    catch {}
  }
});

// ── Chat Bridge: Discord -> Radar ──────────────────────────────────────────
const CHAT_CHANNEL_ID = process.env.CHAT_CHANNEL_ID || '';

client.on(Events.MessageCreate, async (m) => {
  if (!CHAT_CHANNEL_ID || m.channelId !== CHAT_CHANNEL_ID) return;
  if (m.webhookId || m.author.bot) return;
  const text = (m.content || '').trim();
  if (!text) return;
  try {
    await addChatMessage({
      text: text.slice(0, 500),
      name: m.member?.displayName || m.author.globalName || m.author.username,
      discordId: m.author.id,
      avatar: m.author.displayAvatarURL({ extension: 'png', size: 64 }),
    });
  } catch (e) {
    console.error('chat bridge:', e.message || e);
  }
});

client.on(Events.MessageCreate, async (m) => {
  if (m.author.bot || !client.user) return;
  if (!m.mentions.has(client.user)) return;
  const q = m.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
  if (!q) { await m.reply(`Ask me something, or use /ask. ${SITE_URL}`); return; }
  try {
    await m.channel.sendTyping();
    const prior = await loadHistory(m.author.id).catch(() => ({ uid: null, history: [], chats: [] }));
    const answer = await askGemini(q, prior.history);
    saveHistory(prior.uid, prior.chats, q, answer).catch(() => {});
    for (const part of chunk(answer)) await m.reply(part);
  } catch (e) {
    console.error('mention:', e);
    await m.reply(`Error: ${e.message}`).catch(() => {});
  }
});

process.on('unhandledRejection', e => console.error('unhandled:', e));

await registerCommands().catch(e => {
  console.error('Command registration failed:', e.message || e);
  process.exit(1);
});

try {
  await client.login(TOKEN);
} catch (e) {
  console.error('\nCould not log in:', e.message || e);
  console.error('Check that DISCORD_TOKEN in .env is correct.');
  process.exit(1);
}
