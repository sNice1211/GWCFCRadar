// GWCFC Radar - Discord to radar chat bridge (Cloudflare Worker driver)
//
// The logic lives in bridge-core.mjs so that this and the GitHub Actions
// version in poll.mjs cannot drift apart. This file only decides when to run
// it and what to answer over HTTP.
//
// Cloudflare's shortest cron is one minute, which is the latency floor for a
// Discord message reaching the map here.
import { pollOnce } from './bridge-core.mjs';

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollOnce(env).then(
      res => console.log('chat bridge:', JSON.stringify(res)),
      err => console.log('chat bridge failed:', err.message)
    ));
  },

  // GET /health - is it configured
  // GET /poll   - run one poll now, for testing without waiting for the timer
  async fetch(request, env) {
    const url = new URL(request.url);
    const json = (o, s = 200) => new Response(JSON.stringify(o, null, 2),
      { status: s, headers: { 'Content-Type': 'application/json' } });

    if (url.pathname === '/health') {
      return json({
        ok: true,
        discordTokenSet: !!env.DISCORD_TOKEN,
        channelIdSet: !!env.CHAT_CHANNEL_ID,
        firebaseProject: env.FIREBASE_PROJECT_ID || null,
      });
    }
    if (url.pathname === '/poll') {
      try { return json(await pollOnce(env)); }
      catch (e) { return json({ ok: false, error: e.message }, 500); }
    }
    return json({ ok: true, hint: 'try /health or /poll' });
  },
};
