#!/usr/bin/env bash
# Fix the Pi's way out to the internet, which is what has actually been wrong.
#
#     sudo bash ~/GWCFCRadar/pi/fixnet.sh
#
# Everything that failed today failed the same way underneath, and none of it
# was the Pi's own software:
#
#   git pull      curl 56, Recv failure
#   pip install   SSL: UNEXPECTED_EOF, piwheels connect timeout
#   cloudflared   "Cloudflare API: API Connection failed", precheck hard_fail
#   the address   Name or service not known, for a name Cloudflare had just made
#   cloudflare.com  the TLS handshake timed out
#
# Two things underneath all of that:
#
#   - a name server that does not answer reliably. "Name or service not known"
#     is not a wrong address, it is a question nobody answered, and every
#     other failure above is the same thing at a different layer.
#   - IPv4 out of this Pi appears to be broken while IPv6 works. cloudflared
#     said so twice ("Allow outbound TCP on port 7844") and then registered
#     its connection anyway over an IPv6 address, which is a contradiction
#     only if you assume both families work.
#
# So this sets a name server that does answer, and if IPv4 really is dead it
# tells cloudflared to stop trying to use it. Nothing here touches weather
# data or the repo.
set -uo pipefail

good() { printf '   \033[32mOK\033[0m   %s\n' "$*"; }
bad()  { printf '   \033[31mBAD\033[0m  %s\n' "$*"; }
note() { printf '        %s\n' "$*"; }
step() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

REAL_USER="${SUDO_USER:-$USER}"
REAL_HOME=$(getent passwd "$REAL_USER" | cut -d: -f6)
UNITS="$REAL_HOME/.config/systemd/user"

# Run a systemctl --user command as the real user even from under sudo, which
# is otherwise root's session and has none of these units in it.
as_user() {
  if [ "$(id -u)" = "0" ] && [ "$REAL_USER" != "root" ]; then
    su - "$REAL_USER" -c "$*"
  else
    eval "$*"
  fi
}

# A plain TCP connect, with no DNS involved, so this can tell "the network is
# broken" apart from "nobody answered the question".
reach() {   # host, port
  timeout 6 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null
}

step "1. Which way out actually works"
V4=0; V6=0
reach 1.1.1.1 443 && V4=1
reach 8.8.8.8 443 && V4=1
reach 2606:4700:4700::1111 443 && V6=1
[ "$V4" = 1 ] && good "IPv4 reaches the internet" || bad "IPv4 does NOT reach the internet"
[ "$V6" = 1 ] && good "IPv6 reaches the internet" || bad "IPv6 does NOT reach the internet"
if [ "$V4" = 0 ] && [ "$V6" = 0 ]; then
  bad "neither works, so this is the connection itself, not its settings"
  note "check the wifi or the cable, then run this again"
  exit 1
fi

step "2. Can this Pi look a name up"
BEFORE=1
getent hosts cloudflare.com >/dev/null 2>&1 || BEFORE=0
[ "$BEFORE" = 1 ] && good "names resolve right now" \
                  || bad "names do NOT resolve, which explains everything above"

step "3. Giving it name servers that answer"
# Written wherever this Pi actually keeps the setting, because guessing wrong
# means a change that survives until the next DHCP lease and no longer.
DONE=0
if command -v nmcli >/dev/null 2>&1 && systemctl is-active --quiet NetworkManager; then
  CON=$(nmcli -t -f NAME connection show --active 2>/dev/null | head -1)
  if [ -n "$CON" ]; then
    nmcli connection modify "$CON" ipv4.ignore-auto-dns yes \
          ipv4.dns "1.1.1.1 8.8.8.8" 2>/dev/null
    nmcli connection modify "$CON" ipv6.ignore-auto-dns yes \
          ipv6.dns "2606:4700:4700::1111 2001:4860:4860::8888" 2>/dev/null
    nmcli connection up "$CON" >/dev/null 2>&1
    good "NetworkManager connection '$CON' now uses 1.1.1.1 and 8.8.8.8"
    DONE=1
  fi
fi
if [ "$DONE" = 0 ] && systemctl is-active --quiet systemd-resolved; then
  mkdir -p /etc/systemd/resolved.conf.d
  cat > /etc/systemd/resolved.conf.d/gwcfc.conf <<'EOF'
[Resolve]
DNS=1.1.1.1 8.8.8.8 2606:4700:4700::1111
FallbackDNS=9.9.9.9
EOF
  systemctl restart systemd-resolved
  good "systemd-resolved now uses 1.1.1.1 and 8.8.8.8"
  DONE=1
fi
if [ "$DONE" = 0 ]; then
  # The last resort, and the one that does not survive a reboot on its own.
  # dhcpcd reads this file if it is there, which is what makes it stick.
  if [ -d /etc/dhcpcd.conf ] || [ -f /etc/dhcpcd.conf ]; then
    grep -q "^static domain_name_servers" /etc/dhcpcd.conf 2>/dev/null || \
      printf '\nstatic domain_name_servers=1.1.1.1 8.8.8.8\n' >> /etc/dhcpcd.conf
    good "dhcpcd.conf now asks for 1.1.1.1 and 8.8.8.8"
  fi
  printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\nnameserver 2606:4700:4700::1111\n' \
    > /etc/resolv.conf
  good "/etc/resolv.conf written directly"
  DONE=1
fi

step "4. Did that help"
sleep 2
AFTER=1
getent hosts cloudflare.com >/dev/null 2>&1 || AFTER=0
[ "$AFTER" = 1 ] && good "names resolve now" || bad "names still do not resolve"

step "5. The tunnel"
# cloudflared tries IPv4 first and its own prechecks failed on it twice, then
# it registered over IPv6 anyway. Left alone it keeps trying the broken family
# on every reconnect, and every reconnect rolls a brand new address that the
# site cannot keep up with. If IPv4 really is dead, saying so once is worth
# more than any amount of retrying.
DROPIN="$UNITS/gwcfc-tunnel.service.d"
if [ "$V4" = 0 ] && [ "$V6" = 1 ]; then
  mkdir -p "$DROPIN"
  EXEC=$(as_user "systemctl --user show gwcfc-tunnel -p ExecStart --value" 2>/dev/null)
  # ExecStart= on its own line clears the inherited one; systemd refuses to
  # add a second without it.
  cat > "$DROPIN/edge.conf" <<'EOF'
[Service]
ExecStart=
ExecStart=/usr/local/bin/cloudflared tunnel --protocol http2 --edge-ip-version 6 --url http://localhost:8080
EOF
  chown -R "$REAL_USER" "$DROPIN" 2>/dev/null
  good "told cloudflared to use IPv6 only, since IPv4 is what is broken"
  note "delete $DROPIN/edge.conf to undo this"
  as_user "systemctl --user daemon-reload"
elif [ -f "$DROPIN/edge.conf" ] && [ "$V4" = 1 ]; then
  rm -f "$DROPIN/edge.conf"
  as_user "systemctl --user daemon-reload"
  good "IPv4 works again, so the IPv6-only override was removed"
else
  good "both families work, so cloudflared is left as it is"
fi
as_user "systemctl --user restart gwcfc-tunnel gwcfc-publish"
good "tunnel and publisher restarted"

printf '\n   Now run:  gwfix\n'
printf '   The tunnel needs a minute to be given a new address.\n\n'
