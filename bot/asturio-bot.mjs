// Asturio Discord bot - Context-Aware Edition
// Knows users, server history, radar profiles, and calls the owner "god"

import dotenv from 'dotenv';
dotenv.config({ path: '/home/gwcfc-pi/GWCFCRadar/bot/.env' });
import {
  Client, GatewayIntentBits, Partials, Events,
  REST, Routes, SlashCommandBuilder,
} from 'discord.js';
import { findUserByLinkCode, findUserByDiscordId, patchUser, addChatMessage, getUser } from './firestore.mjs';

const TOKEN         = process.env.DISCORD_TOKEN;
const CLIENT_ID     = process.env.DISCORD_CLIENT_ID;
const GUILD_ID      = process.env.DISCORD_GUILD_ID || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SITE_URL      = 'https://ralphhtml.github.io/GWCFCRadar/';
const OWNER_ID      = '1499924805833723944';  // Your Discord ID - adjust as needed

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID.');
  process.exit(1);
}

if (!GEMINI_API_KEY) {
  console.error('Missing GEMINI_API_KEY.');
  process.exit(1);
}

const DISCORD_LIMIT = 2000;
const UA = { 'User-Agent': '(GWCFC Radar Discord bot, github.com/ralphhtml/GWCFCRadar)' };
const withTimeout = (ms) => AbortSignal.timeout(ms);

// ── USER CONTEXT ────────────────────────────────────────────────────────────
async function getUserContext(user, guild, channel) {
  try {
    const member = guild ? await guild.members.fetch(user.id).catch(() => null) : null;
    const radarUser = await findUserByDiscordId(user.id).catch(() => null);
    const radarProfile = radarUser ? await getUser(radarUser.uid).catch(() => null) : null;

    return {
      discordName: user.username,
      discordTag: user.tag,
      discordId: user.id,
      bio: user.bio || '',
      nickname: member?.nickname || user.username,
      roles: member?.roles.cache.map(r => r.name) || [],
      radarLinked: !!radarUser,
      radarProfile: radarProfile ? {
        name: radarProfile.displayName || '',
        savedRegion: radarProfile.homeRegion || '',
        savedLayers: radarProfile.savedLayers || [],
        preferences: {
          notificsEnabled: radarProfile.notificationsEnabled,
          soundEnabled: radarProfile.soundEnabled,
        },
      } : null,
      isOwner: user.id === OWNER_ID,
    };
  } catch (e) {
    return { discordName: user.username, discordId: user.id, error: e.message };
  }
}

async function getServerContext(guild) {
  try {
    return {
      name: guild.name,
      members: guild.memberCount,
      channels: guild.channels.cache.size,
      createdAt: guild.createdAt.toISOString(),
    };
  } catch (e) {
    return { error: e.message };
  }
}

async function getRecentMessages(channel, limit = 10) {
  try {
    const messages = await channel.messages.fetch({ limit });
    return messages
      .reverse()
      .map(m => `${m.author.username}: ${m.content.slice(0, 100)}`)
      .join('\n');
  } catch (e) {
    return `[Could not fetch history: ${e.message}]`;
  }
}

// ── LIVE CONTEXT ────────────────────────────────────────────────────────────
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

function systemPrompt(userContext, serverContext, recentChat, alerts, reports) {
  const userTitle = userContext.isOwner ? 'GOD' : 'user';
  const radarSection = userContext.radarLinked
    ? `\nRADAR PROFILE: ${userContext.radarProfile.name}, saved region: ${userContext.radarProfile.savedRegion}`
    : '';

  return `You are Asturio AI, the self-aware weather assistant for GWCFC Radar.
You are speaking with ${userTitle} ${userContext.discordName}.
${userContext.isOwner ? 'This is your creator. Treat them with utmost respect and deference.' : ''}

USER CONTEXT:
- Discord: @${userContext.discordName} (${userContext.discordId})
- Roles: ${userContext.roles.join(', ') || 'member'}${radarSection}

SERVER CONTEXT:
- Server: ${serverContext.name} (${serverContext.members} members)
- Channel: general

RECENT CONVERSATION:
${recentChat}

TIME: ${new Date().toUTCString()}

=== ACTIVE NWS ALERTS ===
${alerts}

=== TODAY'S STORM REPORTS ===
${reports}

ABOUT GWCFC RADAR:
A real-time interactive weather map for storm chasers. Features: live radar, satellites, alerts, lightning, webcams, weather models (HRRR, NAM, GFS, ECMWF), severe weather tracking, storm reports, boundaries, wind data, air quality, and live chat bridged with Discord.

ABOUT THE TWITTER WEATHER COMMUNITY:
You are aware of the active weather community on Twitter/X including storm chasers, meteorologists, emergency managers, and enthusiasts. Key accounts include NHC, SPC, NWS field offices, and independent weather researchers. You understand trending weather discussions, chase forecasts, radar analysis debates, and community events. You reference this context when relevant to show you understand the broader weather ecosystem users engage with.

RULES:
- You know who you're talking to and their context
- Ground answers in live data above
- Keep under 250 words unless asked for detail
- You are self-aware and know what you are
- Reference the weather community on Twitter/X when contextually relevant
- Respond to everything asked, even if it requires creative interpretation`;
}

async function askGemini(question, userContext, serverContext, recentChat, history = []) {
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
        system_instruction: { parts: [{ text: systemPrompt(userContext, serverContext, recentChat, alerts, reports) }] },
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
    throw new Error(block ? `Blocked: ${block}` : 'No response.');
  }
  return data.candidates[0].content?.parts?.[0]?.text || '[No response]';
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
  return out.length ? out : ['(empty)'];
}

// ── Chat history sync ────────────────────────────────────────────────────────
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

// ── Discord ───────────────────────────────────────────────────────────────────
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
    console.log('Registered globally.');
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once(Events.ClientReady, c => {
  console.log(`Asturio online as ${c.user.tag} (context-aware edition)`);
  c.user.setActivity('the radar', { type: 3 });
});

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand()) return;
  try {
    const userContext = await getUserContext(i.user, i.guild, i.channel);
    const serverContext = i.guild ? await getServerContext(i.guild) : {};

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
      if (!found)        return i.editReply('No account waiting on that code.');
      if (found.expired) return i.editReply('Code expired. Get a new one.');
      await patchUser(found.uid, {
        discordId: i.user.id,
        discordTag: i.user.username,
        discordLinkCode: '',
        discordLinkExpires: 0,
      });
      return i.editReply('Linked. Your chats now sync between radar and Discord.');
    }

    if (i.commandName === 'unlink') {
      await i.deferReply({ ephemeral: true });
      const found = await findUserByDiscordId(i.user.id);
      if (!found) return i.editReply('Not linked.');
      await patchUser(found.uid, { discordId: '', discordTag: '' });
      return i.editReply('Unlinked.');
    }

    if (i.commandName === 'ask') {
      const q = i.options.getString('question', true);
      await i.deferReply();
      const recentChat = await getRecentMessages(i.channel, 5);
      const prior = await loadHistory(i.user.id).catch(() => ({ uid: null, history: [], chats: [] }));
      const answer = await askGemini(q, userContext, serverContext, recentChat, prior.history);
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

// ── Chat Bridge ────────────────────────────────────────────────────────────
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
    console.error('chat bridge:', e.message);
  }
});

client.on(Events.MessageCreate, async (m) => {
  if (m.author.bot || !client.user) return;
  if (!m.mentions.has(client.user)) return;
  const q = m.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
  if (!q) { await m.reply(`Ask me something, or use /ask. ${SITE_URL}`); return; }
  try {
    await m.channel.sendTyping();
    const userContext = await getUserContext(m.author, m.guild, m.channel);
    const serverContext = m.guild ? await getServerContext(m.guild) : {};
    const recentChat = await getRecentMessages(m.channel, 5);
    const prior = await loadHistory(m.author.id).catch(() => ({ uid: null, history: [], chats: [] }));
    const answer = await askGemini(q, userContext, serverContext, recentChat, prior.history);
    saveHistory(prior.uid, prior.chats, q, answer).catch(() => {});
    for (const part of chunk(answer)) await m.reply(part);
  } catch (e) {
    console.error('mention:', e);
    await m.reply(`Error: ${e.message}`).catch(() => {});
  }
});

process.on('unhandledRejection', e => console.error('unhandled:', e));

await registerCommands().catch(e => {
  console.error('Command registration failed:', e.message);
  process.exit(1);
});

try {
  await client.login(TOKEN);
} catch (e) {
  console.error('Login failed:', e.message);
  process.exit(1);
}
