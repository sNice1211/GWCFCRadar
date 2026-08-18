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
  // GET /poll   - run one poll now, for testing without waiting for the timer.
  //
  // /poll used to be open to anyone who knew the address, and a worker URL is
  // not a secret: it appears in logs, in the dashboard, and in anything that
  // ever linked it. Pressing it repeatedly makes this worker do real work
  // against Discord and Firestore on the owner's account, which is somebody
  // else spending your quota. It now needs POLL_SECRET, set with
  //     wrangler secret put POLL_SECRET
  // and passed as ?key=... or an X-Poll-Key header. With no secret set the
  // manual trigger is simply off; the cron timer above is unaffected either
  // way, so the bridge keeps working whatever you decide.
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
      const given = url.searchParams.get('key')
        || request.headers.get('X-Poll-Key') || '';
      if (!env.POLL_SECRET) {
        return json({ ok: false,
          error: 'manual polling is off: no POLL_SECRET is set on this worker' }, 503);
      }
      // Constant time, so the secret cannot be guessed one character at a
      // time by watching how long the answer takes.
      const a = new TextEncoder().encode(given);
      const b = new TextEncoder().encode(env.POLL_SECRET);
      let diff = a.length ^ b.length;
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        diff |= (a[i] || 0) ^ (b[i] || 0);
      }
      if (diff !== 0) return json({ ok: false, error: 'not authorised' }, 401);
      try { return json(await pollOnce(env)); }
      catch (e) { return json({ ok: false, error: e.message }, 500); }
    }
    return json({ ok: true, hint: 'try /health' });
  },
};
