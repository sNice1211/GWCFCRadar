#!/usr/bin/env bash
# Works out why the site cannot read the Pi.
#
#     bash ~/GWCFCRadar/pi/diagnose.sh
#
# Checks the chain in order, because a failure early on explains every symptom
# after it. Send the whole output back.

DATA="$HOME/wxdata"
PORT=8080

hdr() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
good(){ printf '   \033[32mOK\033[0m   %s\n' "$*"; }
bad() { printf '   \033[31mBAD\033[0m  %s\n' "$*"; }
note(){ printf '        %s\n' "$*"; }

hdr "1. Are the files built?"
if [ -f "$DATA/models/latest.json" ] && [ -s "$DATA/models/latest.json" ]; then
  good "latest.json exists, $(wc -c < "$DATA/models/latest.json") bytes"
  python3 -c "
import json
d=json.load(open('$DATA/models/latest.json'))
for k,v in (d.get('models') or {}).items():
    print(f'        {k:8} run {v.get(\"run\")}  fields: {\",\".join(v.get(\"fields\") or [])}')
if d.get('sounding'): print(f'        sounding run {d[\"sounding\"][\"run\"]}')
" 2>/dev/null || bad "latest.json is not valid JSON"
else
  bad "no latest.json (or it is empty). Run: systemctl --user start gwcfc-models"
fi
note "disk: $(du -sh "$DATA/models" 2>/dev/null | cut -f1 || echo 0)"

hdr "2. Who is answering on port $PORT?"
# The important one. If the plain python http.server is still holding this
# port, the CORS-enabled server could not bind, and a browser will refuse to
# read anything from the tunnel even though the files are right there.
HOLDER=$(ss -lptn "sport = :$PORT" 2>/dev/null | tail -n +2)
if [ -z "$HOLDER" ]; then
  bad "nothing is listening on $PORT"
else
  note "$HOLDER"
  if echo "$HOLDER" | grep -q "serve.py"; then
    good "the CORS server has the port"
  else
    bad "something else holds $PORT, most likely a plain 'python3 -m http.server'"
    note "that one sends no CORS header, so the browser refuses to read it."
    note "FIX:  pkill -f 'http.server $PORT'"
    note "      systemctl --user restart gwcfc-serve"
  fi
fi

hdr "3. Does it send the header a browser needs?"
H=$(curl -s -D - -o /dev/null --max-time 15 "http://localhost:$PORT/models/latest.json" 2>/dev/null)
CODE=$(printf '%s' "$H" | head -1)
note "$CODE"
if printf '%s' "$H" | grep -qi 'access-control-allow-origin'; then
  good "Access-Control-Allow-Origin is present"
else
  bad "no Access-Control-Allow-Origin. The browser will block every read."
  note "FIX:  pkill -f 'http.server $PORT'; systemctl --user restart gwcfc-serve"
fi

hdr "4. Services"
for u in gwcfc-serve gwcfc-tunnel gwcfc-publish gwcfc-models.timer; do
  st=$(systemctl --user is-active "$u" 2>/dev/null)
  [ "$st" = "active" ] && good "$u ($st)" || bad "$u ($st)"
done

hdr "5. The address"
URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$HOME/tunnel.log" 2>/dev/null | tail -1)
if [ -n "$URL" ]; then
  good "tunnel: $URL"
  PUB=$(curl -s --max-time 20 "https://firestore.googleapis.com/v1/projects/gwcfc-radar/databases/(default)/documents/piEndpoint/models" \
        | python3 -c "import json,sys; print(json.load(sys.stdin).get('fields',{}).get('url',{}).get('stringValue',''))" 2>/dev/null)
  note "site is told: ${PUB:-nothing}"
  [ "$PUB" = "$URL" ] && good "they match" || bad "they do NOT match; restart gwcfc-publish"
else
  bad "no address in ~/tunnel.log"
fi

hdr "6. End to end, the way the browser does it"
if [ -n "$URL" ]; then
  OUT=$(curl -s -D - -o /tmp/_d.json --max-time 25 -H "Origin: https://ralphhtml.github.io" "$URL/models/latest.json" 2>/dev/null)
  printf '        %s\n' "$(printf '%s' "$OUT" | head -1)"
  if printf '%s' "$OUT" | grep -qi 'access-control-allow-origin' && [ -s /tmp/_d.json ]; then
    good "the site can read this"
    head -c 200 /tmp/_d.json; echo
  else
    bad "the site cannot read this through the tunnel"
    printf '%s' "$OUT" | grep -iE '^(HTTP|content-type|access-control)' | sed 's/^/        /'
  fi
fi

echo
echo "=============================================================="
echo "Send all of this back."
echo "=============================================================="
