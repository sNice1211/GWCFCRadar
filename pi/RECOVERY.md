# Pi Recovery Guide

Your Pi's SD card failed or was physically damaged. The good news: **all your code is on GitHub** and the weather data rebuilds itself. This guide walks you through a full recovery from scratch.

## What You Need

- **New SD card** (A2-rated or high-endurance 64GB+; SanDisk Extreme or Kingston Canvas Go Plus recommended)
- **SD card reader** (USB adapter works fine)
- **Raspberry Pi Imager** (download from https://www.raspberrypi.com/software/)
- **Your old Raspberry Pi** (the hardware is fine)
- **Your Discord webhook URLs** (from the developer portal)
- **Your Ambient Weather API credentials** (from the AWN website)

## Step 1: Flash a Fresh OS onto the New SD Card

1. Insert the new SD card into your card reader on your computer
2. Open Raspberry Pi Imager
3. Click "Choose Device" and select your exact Pi model (likely Raspberry Pi 4 Model B or Pi 5)
4. Click "Choose OS" and select "Raspberry Pi OS (64-bit)" (the full desktop version)
5. Click "Storage" and select your SD card (triple-check you pick the right one)
6. Click the settings icon (gear) in the bottom right:
   - Set hostname to something (e.g., `weather-pi`)
   - Enable SSH (set username and password)
   - Configure WiFi if your Pi will use WiFi
   - Set timezone to your local timezone
7. Click "Write" and wait for it to complete and verify

## Step 2: Boot the Pi and Connect

1. Insert the SD card into your Pi
2. Connect power (the green light will blink during startup, takes about 60 seconds)
3. Once it boots, SSH in from any computer on your network:
   ```bash
   ssh <username>@<hostname>.local
   # or if that doesn't work:
   ssh <username>@<pi-ip-address>
   ```

## Step 3: Clone the Repo and Run Setup

```bash
# Clone the repo to your home directory
git clone https://github.com/ralphhtml/GWCFCRadar.git ~/GWCFCRadar

# Run the installer (this takes 10-20 minutes and will ask for your password)
bash ~/GWCFCRadar/pi/install.sh
```

The installer will:
- Install system packages (takes a few minutes)
- Build a Python virtual environment with all the weather libraries
- Create four systemd services that start on boot
- Register the weather pipelines as hourly/every-5-minute/every-10-minute jobs

**When it finishes**, it will say:
```
   If anything above is still BAD, the full report is:
     bash ~/GWCFCRadar/pi/doctor.sh
```

If you see all "OK" results, you're good. If there are "BAD" results, run that doctor.sh command for more details.

## Step 4: Add the Discord Webhook URLs

The Discord relay needs two webhook URLs: one for chat and one for feedback. These URLs live on the Pi (not in the repo, because anyone who reads a webhook URL can post to that channel).

1. Get your webhook URLs from Discord (server settings → integrations → webhooks)
2. Create the file `~/.gwcfc_webhooks.json` on the Pi:
   ```bash
   cat > ~/.gwcfc_webhooks.json << 'EOF'
   {
     "chat": "https://discord.com/api/webhooks/YOUR_CHAT_WEBHOOK_URL",
     "feedback": "https://discord.com/api/webhooks/YOUR_FEEDBACK_WEBHOOK_URL"
   }
   EOF
   ```
   Replace the URLs with your actual webhook URLs from Discord.

3. Lock it down (so only you can read it):
   ```bash
   chmod 600 ~/.gwcfc_webhooks.json
   ```

## Step 5: Add the Ambient Weather Credentials

If you use Ambient Weather stations on the site:

1. Get your API key and application key from your Ambient Weather account
2. Create the file `~/.gwcfc_ambient.json` on the Pi:
   ```bash
   cat > ~/.gwcfc_ambient.json << 'EOF'
   {
     "apiKey": "YOUR_API_KEY",
     "applicationKey": "YOUR_APPLICATION_KEY"
   }
   EOF
   ```
3. Lock it down:
   ```bash
   chmod 600 ~/.gwcfc_ambient.json
   ```

## Step 6: Verify Everything is Working

### Check the services are running:
```bash
systemctl --user status gwcfc-serve
systemctl --user status gwcfc-tunnel
systemctl --user status gwcfc-publish
systemctl --user status gwcfc-models.timer
systemctl --user status gwcfc-radar.timer
systemctl --user status gwcfc-sat.timer
```

All should show "active (running)" or "active (elapsed)" for timers.

### Check the tunnel is connected:
```bash
bash ~/GWCFCRadar/pi/doctor.sh
```

This will print a detailed report. Look for:
- The public tunnel URL (something like `https://calm-river-fried-1234.trycloudflare.com`)
- "Registered tunnel connection" in the cloudflared log
- "HTTP 200" when fetching the tunnel address

### Watch the publisher:
```bash
journalctl --user -u gwcfc-publish -f
```

You should see messages like "watching; the site is on http://127.0.0.1:8080" every 20 seconds, and "watching; published to https://..." when it finds a new address.

### Check the radar data is flowing:
```bash
journalctl --user -u gwcfc-radar -f
```

You should see messages every 5 minutes with radar update info.

## If Something Goes Wrong

The recovery script is your friend:
```bash
bash ~/GWCFCRadar/pi/fix.sh
```

This will:
- Pull the latest code from GitHub
- Install any missing Python packages
- Restart the services that hold code in memory
- Run the tunnel doctor to diagnose any issues
- Tell you exactly what is wrong if the tunnel is still not working

**You can run this as many times as you want.** It's safe and idempotent.

## What Gets Rebuilt Automatically

You don't need to do anything for these. The timers handle them:

- **Weather models** (hourly): GFS, NAM, HRRR - these download and render automatically
- **Radar data** (every 5 minutes): Level 2 and Level 3 NEXRAD mosaics
- **Satellite imagery** (every 10 minutes): GOES-16/17 RGB composites
- **Cyclone data** (daily): DeepMind/NWP model cyclone tracks
- **Code updates** (hourly): The Pi pulls the latest from GitHub automatically

Weather data only keeps 3 days of history by default (to fit on a smaller SD card). The first radar and satellite images will appear after their first timer runs.

## Troubleshooting

### "Tunnel is stuck at 'preparing'"
The tunnel prepared but never sent "Registered tunnel connection". This usually means:
- Home network is blocking port 7844 outbound (ISP/home router filter)
- DNS is broken (can't reach Cloudflare's edge)

Run `bash ~/GWCFCRadar/pi/fixnet.sh` (with `sudo`) to diagnose.

### "Tunnel says it's connected but site doesn't load"
The tunnel says it's connected, but your address doesn't answer. This could be:
- The HTTP server (gwcfc-serve) crashed
- A firewall rule is blocking localhost:8080
- The Python code has an error

Run `bash ~/GWCFCRadar/pi/doctor.sh` to see the exact error.

### "Site loads but no data (blank graphs)"
The services are running but no data has been fetched yet. This is normal:
- First radar image appears 5 minutes after boot
- First satellite image appears 10 minutes after boot
- First forecast models appear 1 hour after boot

Check `journalctl --user -u gwcfc-radar -f` to watch the pipeline work.

## Recovering from a Partial Failure

If only one piece is broken (e.g., just the tunnel, just the radar), you can restart just that service:

```bash
# Restart just the tunnel (gets a new address, will show in 30 seconds)
systemctl --user restart gwcfc-tunnel

# Restart just the radar pipeline
systemctl --user restart gwcfc-radar

# Restart just the satellite pipeline
systemctl --user restart gwcfc-sat

# Run just the models pipeline (normally hourly)
systemctl --user start gwcfc-models
```

## One More Thing

If this guide didn't work or you hit something unexpected, you can ask for help:

1. Run `bash ~/GWCFCRadar/pi/doctor.sh` and paste the full output
2. Share it with the person helping you (it prints no secrets)

The doctor output tells the exact story of what is and isn't working.

Good luck! Your Pi will be back up and running data in about 15 minutes from the time you insert the new SD card.
