# Discord to radar chat bridge

Carries messages typed in your Discord channel onto the map's Live Chat panel.

Nothing runs on your computer. Cloudflare wakes this on a timer, checks the
channel for anything new, and writes it where the website can see it.

## Why this exists

Messages go **map to Discord** through a webhook, which is instant and needs
none of this.

Coming **back** is the hard direction. A Discord webhook only posts *into* a
channel; Discord gives it no way to read one. There is no setting for this - it
is what a webhook is. The usual answer is a gateway bot holding a permanently
open connection, which means a process running somewhere forever.

This Worker avoids that by asking Discord's REST API "anything new since the
last message I saw?" once a minute. It needs a bot **token**, but never a
running bot.

**The one trade-off:** a Discord message takes up to ~60 seconds to reach the
map, because one minute is the shortest timer Cloudflare offers. Map to Discord
stays instant.

---

## Two ways to run it, pick one

|  | Setup | Delay |
|---|---|---|
| **GitHub Actions** (easiest) | Add 2 repository secrets. Nothing to deploy. | up to ~5 min |
| **Cloudflare Worker** | 4 commands, needs a Cloudflare account | up to ~1 min |

Both run the same code (`bridge-core.mjs`). Start with Actions; move to the
Worker later if five minutes feels too slow.

Either way you need the bot token and channel id below first.

---

## Setup

### 1. A bot that can see the channel

If you already set up the Asturio bot, reuse that token and skip to step 2 -
just make sure the bot has been invited to the server and can see the chat
channel. It does **not** need to be running.

Otherwise: https://discord.com/developers/applications -> New Application ->
**Bot** -> Reset Token, and copy it. Invite it with the `bot` scope and the
**View Channel** and **Read Message History** permissions.

### 2. The channel id

Discord Settings -> Advanced -> **Developer Mode** on. Then right-click the
channel you want mirrored -> **Copy Channel ID**.

Use the same channel the website's webhook posts to, or the two halves of the
conversation end up in different places.

### 3a. Run it with GitHub Actions (no deploy)

On GitHub: the repo -> **Settings** -> **Secrets and variables** -> **Actions**
-> **New repository secret**. Add two:

| Name | Value |
|---|---|
| `DISCORD_TOKEN` | the bot token |
| `CHAT_CHANNEL_ID` | the channel id |

That is the whole setup. `.github/workflows/discord-chat-bridge.yml` already
runs every five minutes.

To check it now instead of waiting: **Actions** tab -> **Discord chat bridge**
-> **Run workflow**. Post something in the channel first, then open the run's
log. `{"ok":true,"relayed":1,...}` means it worked and the message is on the
map.

### 3b. Or deploy it to Cloudflare (faster)

```bash
cd chat-bridge
npx wrangler login
npx wrangler secret put DISCORD_TOKEN      # paste the bot token
npx wrangler secret put CHAT_CHANNEL_ID    # paste the channel id
npx wrangler deploy
```

Secrets are stored by Cloudflare and are not in this repo. Do not put them in
`wrangler.toml`.

The deploy prints a URL. `/health` shows whether it is configured, and `/poll`
runs a check immediately instead of waiting for the timer:

```
https://gwcfcradar-chat-bridge.YOUR-SUBDOMAIN.workers.dev/health
https://gwcfcradar-chat-bridge.YOUR-SUBDOMAIN.workers.dev/poll
```

If you use both, turn one off - two pollers share one cursor and will fight
over which messages have already been relayed.

**The first run relays nothing on purpose.** With no record of where it got to,
it takes only the newest message id and starts from there, so switching the
bridge on does not dump the channel's entire history onto the map.

---

## Firestore rules

This writes to the `chat` and `chatBridge` collections. Publish the rules in
`FIRESTORE_RULES.txt` or every write is refused and `/poll` reports a permission
error.

---

## If something goes wrong

**`/poll` says `discord HTTP 401`**
Wrong or reset token. Reset it in the Developer Portal and `wrangler secret put
DISCORD_TOKEN` again.

**`/poll` says `discord HTTP 403`**
The bot is not in the server, or cannot see that channel. Re-invite it with
**View Channel** and **Read Message History**.

**`/poll` says `discord HTTP 404`**
The channel id is wrong - that is a channel id, not a server id.

**`relayed: 0` and messages are definitely there**
Bot messages, webhook posts and attachment-only posts are skipped on purpose.
Webhook posts are skipped because those *are* the website's own messages coming
back round, and relaying them would copy every message twice.

**Permission errors mentioning Firestore**
`FIRESTORE_RULES.txt` has not been published yet.
