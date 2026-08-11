// Asturio Discord bot
//
// Runs on your laptop and answers weather questions in Discord using the same
// Asturio brain the website uses: it POSTs to the existing Cloudflare Worker,
// so there is no Gemini key on this machine. The only secret here is the
// Discord bot token, and that is read from the environment, never from source.
//
// Before answering it pulls live NWS alerts and SPC storm reports, the same
// sources the map uses, so replies are grounded in what is actually happening
// rather than model recall.

import {
  Client, GatewayIntentBits, Partials, Events,
  REST, Routes, SlashCommandBuilder,
} from 'discord.js';
import { findUserByLinkCode, findUserByDiscordId, patchUser, addChatMessage } from './firestore.mjs';

const TOKEN     = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID  = process.env.DISCORD_GUILD_ID || '';       // optional
const AI_WORKER = process.env.ASTURIO_WORKER
               || 'https://asturio-ai.ralphies1005.workers.dev';
const SITE_URL  = 'https://ralphhtml.github.io/GWCFCRadar/';

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

function systemPrompt(alerts, reports) {
  return `You are Asturio AI, the weather assistant for GWCFC Radar (${SITE_URL}), answering in a Discord chat.

TIME: ${new Date().toUTCString()}

=== ACTIVE NWS ALERTS ===
${alerts}

=== ${reports} ===

Rules:
- Answer in plain Discord text. Short paragraphs, no tables, no headers.
- Keep it under about 250 words unless asked for detail.
- Ground answers in the live data above. If it does not cover the question, say what you do not know rather than guessing.
- You are in Discord, not on the map, so you cannot see the user's screen, toggle layers or move the map. If they want that, point them at the site.
- Never invent a warning, a watch or a storm report that is not listed above. People may act on this.`;
}

async function askAsturio(question, history = []) {
  const [alerts, reports] = await Promise.all([fetchAlerts(), fetchStormReports()]);
  const contents = [
    ...history,
    { role: 'user', parts: [{ text: question }] },
  ];
  const res = await fetch(AI_WORKER, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt(alerts, reports) }] },
      contents,
    }),
    signal: withTimeout(45000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Worker HTTP ${res.status}`);
  if (!data.candidates?.length) {
    const block = data.promptFeedback?.blockReason;
    throw new Error(block ? `Blocked by safety filter: ${block}` : 'No response from Asturio.');
  }
  const cand = data.candidates[0];
  return cand.content?.parts?.[0]?.text
      || (cand.finishReason && cand.finishReason !== 'STOP' ? `[Stopped: ${cand.finishReason}]` : 'No response.');
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
    if (i.commandName === 'link') {
      const code = i.options.getString('code', true).trim().toUpperCase();
      await i.deferReply({ ephemeral: true });   // the code is a credential, keep it out of the channel
      const found = await findUserByLinkCode(code);
      if (!found)        return i.editReply('No account is waiting on that code. Generate a fresh one in your profile on the site.');
      if (found.expired) return i.editReply('That code has expired. Codes last 10 minutes, so generate a new one.');
      await patchUser(found.uid, {
        discordId: i.user.id,
        discordTag: i.user.username,
        // Clear the code so it cannot be claimed twice.
        discordLinkCode: '',
        discordLinkExpires: 0,
      });
      return i.editReply('Linked. Your Discord chats with Asturio now save to your GWCFC Radar account, and your saved chats are available here.');
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
      // A linked account carries its history in, so follow-up questions work.
      const prior = await loadHistory(i.user.id).catch(() => ({ uid: null, history: [], chats: [] }));
      const answer = await askAsturio(q, prior.history);
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
    const prior = await loadHistory(m.author.id).catch(() => ({ uid: null, history: [], chats: [] }));
    const answer = await askAsturio(q, prior.history);
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
