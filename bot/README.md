# Asturio Discord Bot

Runs Asturio AI in Discord from your laptop. It uses the **same Cloudflare Worker
the website uses**, so there's no Gemini API key on your machine — the only
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
3. **General Information** → copy the **Application ID** — that's your `DISCORD_CLIENT_ID`
4. **Bot** (left sidebar) → **Reset Token** → copy it — that's your `DISCORD_TOKEN`
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

Also set `DISCORD_GUILD_ID` to your server's ID — with it, slash commands appear
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

Leave the terminal open — the bot is only online while it's running.
`Ctrl+C` stops it.

---

## Using it

| | |
|---|---|
| `/ask <question>` | Ask anything weather-related |
| `/alerts` | Nationwide NWS alert summary |
| `@Asturio <question>` | Same as `/ask`, just by mention |

Answers take a few seconds because it fetches live data first, so the bot defers
the reply — that's the "thinking" state, not a hang.

---

## If something goes wrong

**`Missing DISCORD_TOKEN or DISCORD_CLIENT_ID`**
You haven't created `.env`, or it's not in the `bot/` folder. Step 4.

**`Could not log in: No Description`**
Discord's unhelpful way of saying the token is wrong. Reset it in the portal and
paste the new one — resetting invalidates the old token immediately.

**Slash commands don't show up**
Either you registered globally (up to an hour) or the bot was invited without the
`applications.commands` scope. Set `DISCORD_GUILD_ID` and restart, and re-invite
with both scopes if needed.

**Bot ignores @mentions but slash commands work**
**MESSAGE CONTENT INTENT** is off. Step 2.5.

**`NWS alerts unavailable`**
api.weather.gov is down or rate-limiting. The bot still answers, just without that
context — it's deliberately non-fatal.

---

## Keeping it running

Closing the terminal kills the bot. To keep it up on your laptop:

```bash
npx pm2 start "npm start" --name asturio
npx pm2 logs asturio      # watch output
npx pm2 stop asturio      # stop it
```

For genuine 24/7 uptime it wants a machine that's always on — a small VPS, or a
Raspberry Pi. The same files work anywhere Node runs.
