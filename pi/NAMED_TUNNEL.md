# Give the Pi a permanent address

A quick tunnel (`cloudflared tunnel --url ...`) invents a brand new random
address every time it starts, and it also reconnects on its own after a
network blip and takes another one. Nothing on the Pi is broken when that
happens, but the site is looking at the old address, so the map goes quiet
and feedback stops sending until somebody notices and republishes.

A **named tunnel** fixes that for good: one address, chosen once, that never
changes. Same free Cloudflare account, same `cloudflared` already installed.

You need a domain whose DNS is on Cloudflare. If `gwcfc.net` is already
there, you are ready; the address below can be any subdomain you like, for
example `pi.gwcfc.net`.

---

## One-time setup, about ten minutes

**1. Sign cloudflared in to your account.**

```
cloudflared tunnel login
```

It prints a link. Open it on any device, sign in, and pick the domain you
want to use. It writes a certificate to `~/.cloudflared/cert.pem`.

**2. Create the tunnel.** The name is yours; `gwcfc` is fine.

```
cloudflared tunnel create gwcfc
```

This prints a tunnel ID and writes credentials to
`~/.cloudflared/<TUNNEL-ID>.json`. **That file is a secret**: anyone holding
it can serve traffic as your tunnel. It stays on the Pi and never goes in
the repo.

**3. Point a name at it.** Replace the hostname with the one you want:

```
cloudflared tunnel route dns gwcfc pi.gwcfc.net
```

**4. Write the config.** `nano ~/.cloudflared/config.yml`, and put in
exactly this, with your own tunnel name and hostname:

```yaml
tunnel: gwcfc
credentials-file: /home/gwcfc-pi/.cloudflared/gwcfc.json

ingress:
  - hostname: pi.gwcfc.net
    service: http://localhost:8080
  - service: http_status:404
```

The credentials file is the one step 2 printed. If its name is a long ID
rather than `gwcfc.json`, use the name it actually wrote.

**5. Stop the quick tunnel and run this one instead.**

```
pkill -f 'cloudflared tunnel'
systemctl --user stop gwcfc-tunnel 2>/dev/null
nohup cloudflared tunnel run gwcfc > ~/tunnel.log 2>&1 &
sleep 8
curl -s -o /dev/null -w "%{http_code}\n" https://pi.gwcfc.net/models/latest.json
```

`200` means the permanent address is live.

**6. Tell the site, once and for all.**

```
cd ~/GWCFCRadar && python3 pi/publish_url.py --set https://pi.gwcfc.net
```

`--set` pins it: the publisher stops reading the tunnel log entirely,
because there is no longer a moving address to chase.

**7. Make it survive reboots.** The `nohup` above dies with your login
session. Give it a service instead:

```
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/gwcfc-tunnel.service <<'EOF'
[Unit]
Description=GWCFC named Cloudflare tunnel
After=network-online.target

[Service]
ExecStart=/usr/local/bin/cloudflared tunnel run gwcfc
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now gwcfc-tunnel
loginctl enable-linger $USER
```

`enable` is what makes it start at boot and `linger` is what lets it run
while nobody is logged in. Both are needed; enabling only one is the
classic way to end up with a tunnel that works until the next reboot.

**Check it:**

```
systemctl --user status gwcfc-tunnel --no-pager | head -5
```

---

## After this

- The address never changes again, so `publish_url.py --watch` has nothing
  to do. Leaving it running is harmless; it sees the pin and stops there.
- If you ever go back to a quick tunnel: `python3 pi/publish_url.py --unpin`.
- Keep `~/.cloudflared/*.json` and `~/.cloudflared/cert.pem` on the Pi only.
  Same rule as the webhook file and `.env`: if it would let a stranger act
  as you, it does not belong in the repo.
