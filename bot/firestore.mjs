// Minimal Firestore REST client for the bot.
//
// The bot talks to Firestore over REST rather than the Admin SDK on purpose: the
// Admin SDK needs a service-account key file, which is a far more dangerous
// secret to have sitting on a laptop than the public web config already shipped
// in index.html. Here the bot signs in anonymously with that same public config,
// exactly as a browser visitor does, and gets no more access than one.
//
// That does mean writes are governed by whatever Firestore rules the project
// has. If they are tightened to "a user may only write their own document",
// linking will start failing with PERMISSION_DENIED and this will need a
// narrowly-scoped Cloud Function instead. Better to fail loudly then than to
// keep a service-account key on a laptop now.

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'gwcfc-radar';
const API_KEY    = process.env.FIREBASE_API_KEY    || 'AIzaSyAAPuBJFlhBFPhqPGlrNnn_c0NZFRgZTI8';

const DOCS = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

let _idToken = null;
let _tokenExpires = 0;

async function idToken() {
  if (_idToken && Date.now() < _tokenExpires - 60000) return _idToken;
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ returnSecureToken: true }) });
  const j = await r.json();
  if (!r.ok) {
    const m = j?.error?.message || `auth HTTP ${r.status}`;
    // Google reports a switched-off API as a wall of text that never says what
    // to do about it, and this is the one failure people actually hit.
    if (/identitytoolkit.*blocked|API_KEY_SERVICE_BLOCKED/i.test(m)) {
      throw new Error('Firebase sign-in is switched off for this Google Cloud project. Enable "Identity Toolkit API" at '
        + `console.cloud.google.com/apis/library/identitytoolkit.googleapis.com?project=${PROJECT_ID}`);
    }
    throw new Error(m);
  }
  _idToken = j.idToken;
  _tokenExpires = Date.now() + (Number(j.expiresIn || 3600) * 1000);
  return _idToken;
}

async function call(path, init = {}) {
  const t = await idToken();
  const r = await fetch(`${DOCS}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}`, ...(init.headers || {}) },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || `Firestore HTTP ${r.status}`);
  return j;
}

// ── Firestore's typed value format ──
function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string')  return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number')  return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v))       return { arrayValue: { values: v.map(toValue) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toValue(x)])) } };
}
function fromValue(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue'  in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue'  in v) return v.doubleValue;
  if ('nullValue'    in v) return null;
  if ('arrayValue'   in v) return (v.arrayValue.values || []).map(fromValue);
  if ('mapValue'     in v) return fromFields(v.mapValue.fields || {});
  return null;
}
function fromFields(f) {
  return Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, fromValue(v)]));
}

// ── Linking ─────────────────────────────────────────────────────────────────
// This used to search the whole users collection for a code, which the rules
// refuse: users/{uid} is readable only by the account it belongs to, and this
// bot is an anonymous visitor. It could not have worked.
//
// Instead the browser leaves a scratch document naming the account that is
// waiting, and the bot only says who ran /link. The browser, which IS the
// owner, copies the result onto the account and deletes the scratch doc. The
// bot never reads or writes an account.

export async function getLinkCode(code) {
  let doc;
  try {
    doc = await call(`/discordLinks/${encodeURIComponent(code)}`);
  } catch (e) {
    if (/404|NOT_FOUND/i.test(e.message)) return null;
    throw e;
  }
  const data = fromFields(doc.fields);
  if (!data.uid) return null;
  const expired = !data.expires || Date.now() > Number(data.expires);
  return { code, data, expired, claimed: !!data.discordId };
}

// Adds only the Discord identity. uid and expires are left untouched, and the
// rules enforce that, so a claim cannot be repointed at a different account.
export async function claimLinkCode(code, discordId, discordTag) {
  const mask = ['discordId', 'discordTag', 'claimedAt']
    .map(k => `updateMask.fieldPaths=${k}`).join('&');
  return call(`/discordLinks/${encodeURIComponent(code)}?${mask}`, {
    method: 'PATCH',
    body: JSON.stringify({
      fields: {
        discordId:  toValue(String(discordId)),
        discordTag: toValue(String(discordTag || '')),
        claimedAt:  toValue(Date.now()),
      },
    }),
  });
}

export async function findUserByDiscordId(discordId) {
  const res = await call(':runQuery', {
    method: 'POST',
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'users' }],
        where: { fieldFilter: { field: { fieldPath: 'discordId' }, op: 'EQUAL', value: { stringValue: discordId } } },
        limit: 1,
      },
    }),
  });
  const row = (Array.isArray(res) ? res : []).find(r => r.document);
  if (!row) return null;
  return { uid: row.document.name.split('/').pop(), data: fromFields(row.document.fields) };
}

// updateMask keeps this a partial write. Without it Firestore replaces the whole
// document, which would wipe the user's profile, saved layers and everything else.
export async function patchUser(uid, fields) {
  const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  return call(`/users/${uid}?${mask}`, {
    method: 'PATCH',
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, toValue(v)])) }),
  });
}

// ── Live chat bridge ────────────────────────────────────────────────────────
// A Discord webhook can only post INTO Discord; there is no way to read a
// channel with one. So the website posts to the webhook directly, and this is
// the other direction: the bot sees a Discord message and drops it into the
// same Firestore collection the website is already listening to, which is what
// makes the two halves a single conversation.
//
// createDocument rather than PATCH, because each message is a new document and
// Firestore generates the id.
export async function addChatMessage({ text, name, discordId, avatar }) {
  return call('/chat', {
    method: 'POST',
    body: JSON.stringify({
      fields: Object.fromEntries(Object.entries({
        text,
        name,
        source: 'discord',
        discordId: discordId || '',
        avatar: avatar || '',
        // Client-side milliseconds rather than a server timestamp: the website
        // orders on this field, and it needs a value the instant the document
        // lands rather than one that is briefly null.
        ts: Date.now(),
      }).map(([k, v]) => [k, toValue(v)])),
    }),
  });
}

export async function getUser(uid) {
  try {
    const doc = await call(`/users/${uid}`);
    return fromFields(doc.fields);
  } catch (e) {
    if (/404|NOT_FOUND/i.test(e.message)) return null;
    throw e;
  }
}
