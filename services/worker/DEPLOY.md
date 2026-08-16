# Deploy the radar worker

One-time setup (free Cloudflare account required):

```bash
cd worker
npm install
npx wrangler login        # opens browser to auth with Cloudflare
npx wrangler deploy       # deploys to workers.dev
```

The deploy command prints your worker URL, e.g.:
  https://gwcfcradar-radar.YOUR_SUBDOMAIN.workers.dev

Paste that URL into index.html where it says RADAR_WORKER_URL.

## Test it
https://gwcfcradar-radar.YOUR_SUBDOMAIN.workers.dev/radar?station=KLTX&product=cc
https://gwcfcradar-radar.YOUR_SUBDOMAIN.workers.dev/radar?station=KLTX&product=zdr&debug
