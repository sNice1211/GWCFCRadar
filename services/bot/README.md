# Asturio Discord Bot

Runs Asturio AI in Discord from your laptop. It uses the **same Cloudflare Worker
the website uses**, so there's no Gemini API key on your machine, the only
secret you need is a Discord bot token.

Before answering, it pulls live **NWS alerts** and **SPC storm reports** (the same
sources the map uses) so replies are grounded in what's actually happening rather
than the model's recall.

---

## One-time setup

### 1. Install Node

Needs **Node 20.6 or newer** (for built-in `.env` support). Check:

```bash
node -v
```

If it's older or missing, get it from https://nodejs.org (take the LTS build).

### 2. Create the Discord application

1. Go to https://discord.com/developers/applications → **New Application**
2. Name it *Asturio*, hit Create
3. **General Information** → copy the **Application ID**, that's your `DISCORD_CLIENT_ID`
4. **Bot** (left sidebar) → **Reset Token** → copy it, that's your `DISCORD_TOKEN`
   - This is shown **once**. If you lose it, reset again.
5. Still on **Bot**, scroll to **Privileged Gateway Intents** and turn on
   **MESSAGE CONTENT INTENT**. Without it, @mentioning the bot won't work
   (slash commands still will).

### 3. Invite it to your server

**Installation** (left sidebar) → under *Install Link* pick **Discord Provided Link**,
set scopes `bot` and `applications.commands`, and permissions:
**Send Messages**, **Read Message History**, **Use Slash Commands**.
Open the generated link and pick your server.

### 4. Configure

```bash
cd bot
cp .env.example .env
```

Open `.env` and paste in your token and application ID.

Also set `DISCORD_GUILD_ID` to your server's ID, with it, slash commands appear
**instantly**; without it, Discord can take up to an hour to publish them.
To get it: Discord Settings → Advanced → **Developer Mode** on, then right-click
your server icon → **Copy Server ID**.

`.env` is already in `.gitignore`. Don't commit it.

### 5. Install and run

```bash
npm install
npm start
```

You should see:

```
Registered /ask and /alerts to guild 123...
Asturio online as Asturio#1234
```

Leave the terminal open, the bot is only online while it's running.
`Ctrl+C` stops it.

---

## Using it

| | |
|---|---|
| `/ask <question>` | Ask anything weather-related |
| `/alerts` | Nationwide NWS alert summary |
| `@Asturio <question>` | Same as `/ask`, just by mention |

Answers take a few seconds because it fetches live data first, so the bot defers
the reply, that's the "thinking" state, not a hang.

---

## If something goes wrong

**`Missing DISCORD_TOKEN or DISCORD_CLIENT_ID`**
You haven't created `.env`, or it's not in the `services/bot/` folder. Step 4.

**`Could not log in: No Description`**
Discord's unhelpful way of saying the token is wrong. Reset it in the portal and
paste the new one, resetting invalidates the old token immediately.

**Slash commands don't show up**
Either you registered globally (up to an hour) or the bot was invited without the
`applications.commands` scope. Set `DISCORD_GUILD_ID` and restart, and re-invite
with both scopes if needed.

**Bot ignores @mentions but slash commands work**
**MESSAGE CONTENT INTENT** is off. Step 2.5.

**`NWS alerts unavailable`**
api.weather.gov is down or rate-limiting. The bot still answers, just without that
context, it's deliberately non-fatal.

---

## Keeping it running

Closing the terminal kills the bot. To keep it up on your laptop:

```bash
npx pm2 start "npm start" --name asturio
npx pm2 logs asturio      # watch output
npx pm2 stop asturio      # stop it
```

For genuine 24/7 uptime it wants a machine that's always on, a small VPS, or a
Raspberry Pi. The same files work anywhere Node runs.

## If the Gemini key is refused

    Gemini key refused, switching to the shared worker for the rest of
    this session.

That is not fatal. There are two ways to ask: a `GEMINI_API_KEY` of your own,
or the same Cloudflare Worker the website uses, which needs no key. If Google
refuses the key, the bot says so once and uses the worker from then on, so the
bot keeps answering.

To use your own key instead, the message says what to change: on the key at
console.cloud.google.com/apis/credentials, set API restrictions to "Gemini
API". Google will not let one key hold Gemini alongside other APIs, so Gemini
needs its own.

The distinction matters: a refused key is worth falling back from, but a quota
message or a retired model name would fail exactly the same way through the
worker, so those are reported rather than retried.

## /map only offers what the site has

    node tools/extract-map-options.js

Reads `index.html` and writes `services/bot/map-options.json`: every layer, overlay,
basemap, satellite band and product family the site really offers. The command
is built from that file, so the two cannot drift apart. Typed by hand they
already had: the command offered six radar products where the page shows five,
and eight satellite bands where the page has sixteen.

The generator keeps only what a visitor can actually click. The dual polarity
radar products sit in the page commented out, so they are absent here too. A
command that offered them would promise a picture nobody can see.

Run it after adding a layer, an overlay or a product to the site, then restart
the bot so the command re-registers.

    node services/bot/test-map-command.mjs

Builds the real command and checks it against Discord's own limits, which are
otherwise discovered at startup when registration fails and the bot is already
down. Also checks it against the site: every family reached an option, nothing
hidden is on the menu, and no completion is a value Discord would refuse.

Lists too long for Discord's 25 fixed choices, and anything taking several
values at once, complete as you type instead. Completion finishes the value
after the last comma and hands back everything before it untouched.

Anything the site does not have is refused with a note saying so, rather than
quietly producing a picture without it. Silently ignoring a name is how someone
ends up believing a layer is on when it never was.

## The bot's face

It wears `assets/img/asturio-ai-512.png`: the site's own AI logo, the
concentric rings, lit as an instrument with falling code behind it. The bot
shares a brain and a name with the assistant in the app, so it shares a face
rather than answering as the default grey circle with a letter in it.

    node tools/make-asturio-avatar.mjs

Rebuilds both the SVG and the PNG from `tools/make-asturio-avatar.mjs`. Run it
if the site's logo or palette changes, then restart the bot. The generator is
seeded, so re-running it with nothing changed produces the same bytes and shows
no diff.

The bot uploads the picture on start, but only when it differs from the one it
last sent, which it records in `services/bot/.avatar-stamp` (ignored by git).
That is not tidiness: Discord limits how often a bot may change its avatar, in
the region of twice an hour, so a bot that re-uploads on every restart gets
refused and then cannot change it when it matters.

A refusal is logged and shrugged off. A weather bot that will not answer
because it could not change its profile picture is worse than one with the
wrong picture.

    node tools/test-asturio-avatar.mjs

Checks the picture is square, 512, and small enough to upload; that the
generator is deterministic; that the mark uses the site's own palette, read out
of `index.html` rather than repeated, so it cannot drift off-brand; and that
the upload is skipped when nothing changed.
