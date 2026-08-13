// GWCFC Radar - Discord to radar chat bridge (shared core)
// ---------------------------------------------------------------------------
// The website posts its own messages straight to a Discord webhook, which is
// the easy direction. This file is the hard one: getting what people type in
// Discord back onto the map.
//
// A webhook cannot do it. A webhook only posts INTO a channel; Discord gives it
// no way to read one. The usual answer is a gateway bot holding an open
// connection, but that means a process running somewhere forever.
//
// So instead this wakes on a timer, asks Discord's REST API "anything
// new in this channel since the last message I saw?", and writes whatever it
// finds into the same Firestore collection the website is already listening to.
// Something else runs it on a schedule; there is nothing to keep alive.
//
// This file is the logic only. It is driven by either worker.js (Cloudflare,
// one-minute timer) or poll.mjs (GitHub Actions, five-minute timer). Both call
// pollOnce(env) with the same shape of settings, so the behaviour is identical
// wherever it runs.
//
// The trade-off is latency: the schedule sets how quickly a Discord message
// reaches the map. Messages going the other way are instant, because those do
// not pass through here at all.
//
// It needs a bot TOKEN, but not a bot PROCESS. A token is enough to call the
// REST API. The bot must be in the server and able to see the channel, but it
// never has to be online.

const DISCORD_API = 'https://discord.com/api/v10';
const MAX_PER_POLL = 50;        // Discord's page size; also caps a burst
const MAX_TEXT = 500;

function firestoreBase(projectId) {
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
}

// Same approach the bot in bot/ uses: sign in anonymously with the public web
// API key rather than carrying a service-account key. The Worker then has
// exactly the access an ordinary visitor has, and no more, so the worst case if
// this Worker leaked is what any visitor could already do.
async function idToken(env) {
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${env.FIREBASE_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ returnSecureToken: true }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || `firebase auth HTTP ${r.status}`);
  return j.idToken;
}

const sv = v =>
  v === null || v === undefined ? { nullValue: null }
  : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v })
  : typeof v === 'boolean' ? { booleanValue: v }
  : { stringValue: String(v) };

async function fsFetch(env, token, path, init = {}) {
  const r = await fetch(`${firestoreBase(env.FIREBASE_PROJECT_ID)}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(j?.error?.message || `firestore HTTP ${r.status}`);
    // Carry the status and Google's own status name. Callers that want to
    // treat one failure differently (a missing document is normal on a first
    // run) should not have to pattern-match English prose to do it: Firestore
    // words that message "... not found." with a space, so a check for
    // NOT_FOUND never matched it and the first run always threw.
    err.status = r.status;
    err.firestoreStatus = j?.error?.status || '';
    throw err;
  }
  return j;
}

// Where the bridge remembers how far it got. Kept in Firestore rather than KV
// so this Worker needs no extra Cloudflare resources to be provisioned.
async function readCursor(env, token) {
  try {
    const doc = await fsFetch(env, token, '/chatBridge/state');
    return doc?.fields?.lastMessageId?.stringValue || '';
  } catch (e) {
    // No cursor yet means this is the first run, which is not a failure: start
    // from the beginning. Judged on the status rather than the wording, since
    // the wording is "not found." with a space and does not match NOT_FOUND.
    if (e.status === 404 || e.firestoreStatus === 'NOT_FOUND'
        || /\bnot[_ ]found\b/i.test(e.message || '')) return '';
    throw e;
  }
}
async function writeCursor(env, token, id) {
  return fsFetch(env, token, '/chatBridge/state?updateMask.fieldPaths=lastMessageId&updateMask.fieldPaths=updatedAt', {
    method: 'PATCH',
    body: JSON.stringify({ fields: { lastMessageId: sv(id), updatedAt: sv(Date.now()) } }),
  });
}

async function addChatMessage(env, token, m) {
  return fsFetch(env, token, '/chat', {
    method: 'POST',
    body: JSON.stringify({
      fields: {
        text: sv(String(m.content || '').slice(0, MAX_TEXT)),
        name: sv(m.member?.nick || m.author?.global_name || m.author?.username || 'Discord user'),
        source: sv('discord'),
        discordId: sv(m.author?.id || ''),
        avatar: sv(m.author?.avatar
          ? `https://cdn.discordapp.com/avatars/${m.author.id}/${m.author.avatar}.png?size=64`
          : ''),
        // Discord snowflake ids encode their own creation time, which is more
        // accurate than "when this Worker happened to wake up".
        ts: sv(Number((BigInt(m.id) >> 22n) + 1420070400000n)),
      },
    }),
  });
}

export async function pollOnce(env) {
  if (!env.DISCORD_TOKEN || !env.CHAT_CHANNEL_ID) {
    return { ok: false, reason: 'DISCORD_TOKEN or CHAT_CHANNEL_ID not set' };
  }
  const token = await idToken(env);
  const cursor = await readCursor(env, token);

  // Without a cursor this is the first ever run. Take only the newest message
  // and record it, rather than importing the channel's entire backlog onto the
  // map the moment the bridge is switched on.
  const qs = cursor ? `after=${cursor}&limit=${MAX_PER_POLL}` : `limit=1`;
  const r = await fetch(`${DISCORD_API}/channels/${env.CHAT_CHANNEL_ID}/messages?${qs}`, {
    headers: { Authorization: `Bot ${env.DISCORD_TOKEN}`, 'User-Agent': 'GWCFCRadar-ChatBridge/1.0' },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    return { ok: false, reason: `discord HTTP ${r.status} ${body.slice(0, 200)}` };
  }
  const batch = await r.json();
  if (!Array.isArray(batch) || !batch.length) return { ok: true, relayed: 0, cursor };

  // Discord returns newest first; relaying in reverse keeps the map's order the
  // same as the channel's.
  const ordered = batch.slice().reverse();
  const newest = ordered[ordered.length - 1].id;

  let relayed = 0;
  if (cursor) {
    for (const m of ordered) {
      // Messages the website sent arrive here as webhook posts. Relaying those
      // would copy every website message back onto the map a second time, so
      // this check is what stops the bridge feeding itself.
      if (m.webhook_id) continue;
      if (m.author?.bot) continue;
      if (!String(m.content || '').trim()) continue;   // attachment-only
      try { await addChatMessage(env, token, m); relayed++; }
      catch (e) { console.log('relay failed for', m.id, e.message); }
    }
  }
  // Cursor advances past everything seen, including skipped messages, so the
  // same batch is never re-scanned.
  await writeCursor(env, token, newest);
  return { ok: true, relayed, cursor: newest };
}
