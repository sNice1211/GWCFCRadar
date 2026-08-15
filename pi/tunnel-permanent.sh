#!/usr/bin/env bash
# Swaps the quick tunnel for a named one, so the address stops changing.
#
#     bash ~/GWCFCRadar/pi/tunnel-permanent.sh pi.yourdomain.com
#
# A quick tunnel is anonymous, which is why it is free and why it hands out a
# new random hostname every time it restarts. A named tunnel belongs to a
# Cloudflare account and keeps its hostname for good. It is also free, but it
# needs a domain on that account, because the hostname has to be a name
# Cloudflare is allowed to answer for.
#
# What you need first:
#   1. A Cloudflare account. Free.
#   2. A domain on it. If you already own one, move its nameservers to
#      Cloudflare in the dashboard. If you do not, the cheapest ones are a
#      few pounds a year, and Cloudflare itself sells them at cost.
#
# After this the Pi publishes the same address every time, so the site finds
# it after a reboot with nothing to do by hand.
set -euo pipefail

HOST="${1:-}"
NAME="${TUNNEL_NAME:-gwcfc}"

if [ -z "$HOST" ]; then
  cat <<'USAGE'
Give the hostname you want the Pi to answer on:

    bash ~/GWCFCRadar/pi/tunnel-permanent.sh pi.yourdomain.com

It has to be a subdomain of a domain that is on your Cloudflare account.
Anything works: pi., wx., radar., whatever you like.
USAGE
  exit 1
fi

say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32mok\033[0m %s\n' "$*"; }
note() { printf '      %s\n' "$*"; }

say "1. Cloudflare login"
# Opens a browser link and waits. On a headless Pi it prints a URL to paste
# into a browser on any machine, which is the usual case here.
if [ -f "$HOME/.cloudflared/cert.pem" ]; then
  ok "already logged in"
else
  note "A link will appear. Open it on any machine, pick your domain, approve."
  cloudflared tunnel login
  ok "logged in"
fi

say "2. The tunnel"
if cloudflared tunnel list 2>/dev/null | awk '{print $2}' | grep -qx "$NAME"; then
  ok "$NAME already exists"
else
  cloudflared tunnel create "$NAME"
  ok "created $NAME"
fi
UUID=$(cloudflared tunnel list | awk -v n="$NAME" '$2==n {print $1}' | head -1)
[ -n "$UUID" ] || { echo "could not find the tunnel id"; exit 1; }
note "id $UUID"

say "3. Point the hostname at it"
# Idempotent: re-running with the same hostname is fine, and with a different
# one adds a second route rather than breaking the first.
cloudflared tunnel route dns "$NAME" "$HOST" || \
  note "route already exists, which is fine"
ok "$HOST -> $NAME"

say "4. Config"
mkdir -p "$HOME/.cloudflared"
cat > "$HOME/.cloudflared/config.yml" <<YAML
tunnel: $UUID
credentials-file: $HOME/.cloudflared/$UUID.json

ingress:
  - hostname: $HOST
    service: http://localhost:8080
  # Everything else is refused rather than passed through, so this tunnel
  # exposes the one server and nothing else on the Pi.
  - service: http_status:404
YAML
ok "wrote ~/.cloudflared/config.yml"

say "5. Run it as a service"
# Replaces the quick-tunnel unit install.sh wrote. Same name, so nothing else
# has to learn about the change.
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/gwcfc-tunnel.service" <<UNIT
[Unit]
Description=Cloudflare named tunnel for GWCFC Radar
After=network-online.target

[Service]
ExecStart=$(command -v cloudflared) tunnel --config $HOME/.cloudflared/config.yml run $NAME
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now gwcfc-tunnel
ok "gwcfc-tunnel is running the named tunnel"

say "6. Tell the site, once"
# A named tunnel never changes, so this is written once rather than watched.
# The publisher keeps working either way; this just saves it the guesswork.
"$HOME/wxenv/bin/python" "$HOME/GWCFCRadar/pi/publish_url.py" \
  --set "https://$HOST" || note "publish failed, run publish_url.py --check"

echo
echo "=============================================================="
echo "  The Pi is now permanently at:"
echo "      https://$HOST"
echo
echo "  That address survives reboots, restarts and power cuts."
echo "  Check it with:"
echo "      curl -s https://$HOST/models/latest.json | head -c 200"
echo "=============================================================="
