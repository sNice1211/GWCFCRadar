#!/usr/bin/env node
/*
 * Mints fresh Discord webhooks for the site's chat bridge and feedback form,
 * ON the Pi, and writes their URLs straight into ~/.gwcfc_webhooks.json,
 * which pi/serve.py's relay reads and nothing serves.
 *
 *     cd ~/GWCFCRadar && node services/bot/make-webhooks.mjs <feedback-channel-id> [chat-channel-id]
 *
 * The whole point is that the new URLs never appear anywhere a person or a
 * page can read them: not printed to this terminal, not pasted into chat,
 * not committed. To Discord a webhook URL is the entire credential, and the
 * old ones were compromised precisely because they were written into the
 * public page. This script also deletes the compromised webhook by id, so
 * the spammer's copy of the old URL dies even if it was not deleted by hand.
 *
 * Needs: services/bot/.env with DISCORD_TOKEN (and CHAT_CHANNEL_ID if the
 * chat channel id is not passed as the second argument), and the bot must
 * have the Manage Webhooks permission in both channels.
 */

import { readFileSync, writeFileSync, chmodSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import os from 'os';

// The webhook that was leaked in the page source and abused. Deleted on
// every run; a 404 just means it is already gone.
const COMPROMISED_WEBHOOK_ID = '1536447010092224553';

const HERE = dirname(fileURLToPath(import.meta.url));

// The bot reads .env through its service unit; this one-shot script reads
// the same file directly so it works from a bare shell too.
function loadEnv() {
  const out = { ...process.env };
  try {
    for (const line of readFileSync(join(HERE, '.env'), 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !(m[1] in process.env)) out[m[1]] = m[2];
    }
  } catch (e) {}
  return out;
}

const env = loadEnv();
const TOKEN = env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error('No DISCORD_TOKEN in services/bot/.env, cannot talk to Discord.');
  process.exit(1);
}

const feedbackChannel = process.argv[2];
const chatChannel = process.argv[3] || env.CHAT_CHANNEL_ID;
if (!feedbackChannel) {
  console.error('Usage: node services/bot/make-webhooks.mjs <feedback-channel-id> [chat-channel-id]');
  process.exit(1);
}
if (!chatChannel) {
  console.error('No chat channel: pass it as the second argument or set CHAT_CHANNEL_ID in .env.');
  process.exit(1);
}

const API = 'https://discord.com/api/v10';
const HEADERS = { Authorization: `Bot ${TOKEN}`, 'Content-Type': 'application/json' };

// 401 and 403 are different problems and pointing at the wrong one wastes
// a person's time in the middle of an incident: 401 means Discord rejected
// the TOKEN itself (stale after a reset, or pasted with quotes/spaces),
// 403 means the token is fine but the bot lacks Manage Webhooks there.
function explainAuth(status) {
  if (status === 401) {
    return 'HTTP 401: the DISCORD_TOKEN in services/bot/.env is not valid. '
      + 'If you reset the token in the Developer Portal, paste the NEW one '
      + 'into .env (no quotes, no spaces) and run this again.';
  }
  if (status === 403) {
    return 'HTTP 403: the token works but the bot lacks the Manage Webhooks '
      + 'permission in that channel. Grant it, then run this again.';
  }
  return null;
}

async function killCompromised() {
  const r = await fetch(`${API}/webhooks/${COMPROMISED_WEBHOOK_ID}`,
                        { method: 'DELETE', headers: HEADERS });
  if (r.ok) console.log('Deleted the compromised webhook. Its leaked URL is now dead.');
  else if (r.status === 404) console.log('The compromised webhook is already gone. Good.');
  else console.warn(`Could not delete the compromised webhook (${explainAuth(r.status) || 'HTTP ' + r.status}). `
                  + 'It can also be deleted by hand: Server Settings -> Integrations -> Webhooks.');
}

async function mint(channelId, name) {
  const r = await fetch(`${API}/channels/${channelId}/webhooks`, {
    method: 'POST', headers: HEADERS,
    body: JSON.stringify({ name }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    const why = explainAuth(r.status)
      || `HTTP ${r.status} ${body.slice(0, 200)}`;
    throw new Error(`creating "${name}" in channel ${channelId} failed: ${why}`);
  }
  const w = await r.json();
  if (!w.id || !w.token) throw new Error(`Discord returned no token for "${name}"`);
  return `https://discord.com/api/webhooks/${w.id}/${w.token}`;
}

try {
  await killCompromised();
  const chatUrl = await mint(chatChannel, 'GWCFC Chat Bridge');
  const feedbackUrl = await mint(feedbackChannel, 'GWCFC Feedback');
  const file = join(os.homedir(), '.gwcfc_webhooks.json');
  writeFileSync(file, JSON.stringify({ chat: chatUrl, feedback: feedbackUrl }, null, 2) + '\n');
  chmodSync(file, 0o600);
  // Deliberately NOT printing the URLs: the file is the only place they live.
  console.log(`Two fresh webhooks minted and written to ${file} (mode 600).`);
  console.log('Restart the file server so the relay is live:');
  console.log('  systemctl --user restart gwcfc-serve');
} catch (e) {
  console.error(String(e.message || e));
  process.exit(1);
}
