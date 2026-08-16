// GWCFC Radar - "Continue with Discord" (Cloudflare Worker)
// ---------------------------------------------------------------------------
// Why this cannot be done in the page:
//
//  1. Exchanging Discord's login code for an identity requires the client
//     SECRET. Anything in the page is readable, and whoever reads that secret
//     can sign in as anybody, so it has to happen somewhere the visitor cannot
//     see. That is here.
//  2. Firebase has no Discord provider. The only way to turn "this is Discord
//     user 123" into a real Firebase account is a custom token, which must be
//     signed with a service-account key. Also a secret, also here.
//
// The flow:
//   page  -> /login          this Worker sends the visitor to Discord
//   user  -> Discord         they approve
//   Discord -> /callback     with a one-time code
//   here  -> Discord         swap code for identity, using the secret
//   here  -> page            redirect back with a short-lived Firebase token
//   page  -> signInWithCustomToken()
//
// The Firebase uid is "discord:<their discord id>", so the same Discord account
// always lands on the same radar account, and a changed username or email
// cannot take over someone else's.

const DISCORD_API = 'https://discord.com/api/v10';
const TOKEN_TTL = 3600;
const STATE_TTL_MS = 10 * 60 * 1000;   // a login not finished in 10 min is stale

// ── small encoding helpers ──────────────────────────────────────────────────
const enc = new TextEncoder();
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlStr = s => b64url(enc.encode(s));
function b64urlDecode(s) {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  return atob(pad + '='.repeat((4 - pad.length % 4) % 4));
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

// Constant-time compare, so a mismatched signature cannot be narrowed down by
// timing how long the rejection took.
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── state: ties the callback to the request that started it ─────────────────
// Signed rather than stored, so the Worker keeps no session of its own. Carries
// where to return to, which is verified against the allow-list on the way back
// as well as on the way out - otherwise this would be an open redirect handing
// a login token to whoever asked.
async function makeState(env, redirect) {
  const body = b64urlStr(JSON.stringify({ r: redirect, t: Date.now(), n: crypto.randomUUID() }));
  return `${body}.${await hmac(env.DISCORD_CLIENT_SECRET, body)}`;
}
async function readState(env, state) {
  const [body, sig] = String(state || '').split('.');
  if (!body || !sig) throw new Error('missing state');
  if (!safeEqual(sig, await hmac(env.DISCORD_CLIENT_SECRET, body))) throw new Error('bad state signature');
  const data = JSON.parse(b64urlDecode(body));
  if (!data.t || Date.now() - data.t > STATE_TTL_MS) throw new Error('login took too long, start again');
  return data;
}

function allowedRedirect(env, url) {
  const list = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  try {
    const u = new URL(url);
    return list.some(o => u.origin === o) ? u.toString() : null;
  } catch { return null; }
}

// ── Firebase custom token ───────────────────────────────────────────────────
// A JWT signed with the service account's private key. Firebase accepts it in
// exchange for a real session, which is what makes the Discord identity a
// first-class account rather than a second login system bolted alongside.
function pemToPkcs8(pem) {
  const b64 = String(pem).replace(/-----[^-]+-----/g, '').replace(/\\n/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

async function firebaseCustomToken(env, uid, claims) {
  const key = await crypto.subtle.importKey('pkcs8', pemToPkcs8(env.FIREBASE_PRIVATE_KEY),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64urlStr(JSON.stringify({
    iss: env.FIREBASE_CLIENT_EMAIL,
    sub: env.FIREBASE_CLIENT_EMAIL,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now,
    exp: now + TOKEN_TTL,
    uid,
    claims,
  }));
  const sig = b64url(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${header}.${payload}`)));
  return `${header}.${payload}.${sig}`;
}

// ── routes ──────────────────────────────────────────────────────────────────
function redirectUri(env, request) {
  return env.OAUTH_REDIRECT_URI || new URL('/callback', request.url).toString();
}

async function handleLogin(env, request, url) {
  const wanted = url.searchParams.get('redirect') || '';
  const redirect = allowedRedirect(env, wanted);
  if (!redirect) return new Response('That return address is not on the allow-list.', { status: 400 });
  const auth = new URL('https://discord.com/oauth2/authorize');
  auth.searchParams.set('client_id', env.DISCORD_CLIENT_ID);
  auth.searchParams.set('redirect_uri', redirectUri(env, request));
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('scope', 'identify email');
  auth.searchParams.set('state', await makeState(env, redirect));
  auth.searchParams.set('prompt', 'consent');
  return Response.redirect(auth.toString(), 302);
}

// Errors go back to the page as a readable reason rather than a blank Worker
// error page, because this runs in the middle of someone signing in.
function bounceError(redirect, message) {
  const to = new URL(redirect);
  to.hash = 'discord_error=' + encodeURIComponent(message);
  return Response.redirect(to.toString(), 302);
}

async function handleCallback(env, request, url) {
  let state;
  try { state = await readState(env, url.searchParams.get('state')); }
  catch (e) { return new Response(`Login could not be verified: ${e.message}`, { status: 400 }); }

  const redirect = allowedRedirect(env, state.r);
  if (!redirect) return new Response('That return address is not on the allow-list.', { status: 400 });

  const denied = url.searchParams.get('error');
  if (denied) return bounceError(redirect, denied === 'access_denied' ? 'You cancelled the Discord login.' : denied);

  const code = url.searchParams.get('code');
  if (!code) return bounceError(redirect, 'Discord did not send a login code.');

  // Swap the one-time code for an access token. This is the step that needs
  // the client secret and therefore cannot happen in the page.
  const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(env, request),
    }),
  });
  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => '');
    console.log('discord token exchange failed', tokenRes.status, body.slice(0, 300));
    return bounceError(redirect, 'Discord refused the login. Check the client secret and redirect URI.');
  }
  const token = await tokenRes.json();

  const meRes = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!meRes.ok) return bounceError(redirect, 'Could not read your Discord profile.');
  const me = await meRes.json();
  if (!me.id) return bounceError(redirect, 'Discord did not return an account id.');

  // Keyed on the Discord id, which never changes, rather than on the username
  // or email, which do. Otherwise renaming an account could collide with
  // somebody else's.
  const uid = `discord:${me.id}`;
  const avatar = me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=128` : '';
  let custom;
  try {
    custom = await firebaseCustomToken(env, uid, {
      discordId: me.id,
      discordTag: me.username || '',
    });
  } catch (e) {
    console.log('custom token signing failed:', e.message);
    return bounceError(redirect, 'The site could not create your session. The Firebase key may be wrong.');
  }

  const to = new URL(redirect);
  // In the fragment, not the query: fragments are not sent to servers and stay
  // out of proxy and referrer logs. The page clears it immediately.
  to.hash = new URLSearchParams({
    discord_token: custom,
    discord_name: me.global_name || me.username || '',
    discord_email: me.email || '',
    discord_avatar: avatar,
  }).toString();
  return Response.redirect(to.toString(), 302);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const missing = ['DISCORD_CLIENT_ID','DISCORD_CLIENT_SECRET','FIREBASE_CLIENT_EMAIL','FIREBASE_PRIVATE_KEY']
      .filter(k => !env[k]);

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        ok: missing.length === 0,
        missing,
        allowedOrigins: String(env.ALLOWED_ORIGINS || '').split(',').filter(Boolean),
        redirectUri: redirectUri(env, request),
      }, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }
    if (missing.length) return new Response(`Not configured yet. Missing: ${missing.join(', ')}`, { status: 500 });
    if (url.pathname === '/login')    return handleLogin(env, request, url);
    if (url.pathname === '/callback') return handleCallback(env, request, url);
    return new Response('GWCFC Radar Discord auth. Try /health.', { status: 404 });
  },
};
