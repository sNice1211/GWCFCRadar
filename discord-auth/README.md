# Continue with Discord

Lets people create a radar account and sign in using Discord.

## Why a Worker is needed

Two things cannot happen in the browser:

1. **The client secret.** Discord gives back a one-time code, and swapping that
   code for the person's identity requires the application's client secret.
   Everything in the page is readable by anyone who opens it, and whoever has
   that secret can sign in as anybody. So the swap happens here instead.
2. **Firebase has no Discord provider.** The only way to turn "this is Discord
   user 123" into a real Firebase account is a *custom token*, which has to be
   signed with a service-account key. Also a secret, also here.

The account id is `discord:<discord user id>`. The Discord id never changes, so
the same person always lands on the same radar account, and someone renaming
their Discord account can never take over another account.

---

## Setup

### 1. Discord application

https://discord.com/developers/applications -> your app -> **OAuth2**

- Copy the **Client Secret** (Reset Secret if you have never seen it).
- Under **Redirects**, add exactly:
  `https://gwcfcradar-discord-auth.ralphies1005.workers.dev/callback`
  It must match `OAUTH_REDIRECT_URI` in `wrangler.toml` character for character,
  or Discord refuses the login.

### 2. Firebase service account

Firebase Console -> **gwcfc-radar** -> gear icon -> **Project settings** ->
**Service accounts** -> **Generate new private key**. A JSON file downloads.

You need two fields from it: `client_email` and `private_key`.

**This file can do anything to your Firebase project.** Do not commit it, do
not paste it into chat, and delete the download once the secrets are set.

### 3. Deploy

```bash
cd discord-auth
npx wrangler login
npx wrangler secret put DISCORD_CLIENT_SECRET     # from step 1
npx wrangler secret put FIREBASE_CLIENT_EMAIL     # client_email from the JSON
npx wrangler secret put FIREBASE_PRIVATE_KEY      # private_key from the JSON
npx wrangler deploy
```

For the private key, paste the whole thing including the
`-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines. Literal
`\n` sequences are handled, so pasting it straight out of the JSON works.

### 4. Check it

```
https://gwcfcradar-discord-auth.ralphies1005.workers.dev/health
```

`ok: true` and an empty `missing` list means all three secrets are set. It also
prints the redirect URI it will use and the allowed return addresses, which are
the two things most likely to be wrong.

Then open the site, **Sign In -> Discord -> Continue with Discord**.

---

## Adding your real domain later

Two places, and both are needed:

1. `ALLOWED_ORIGINS` in `wrangler.toml`, then redeploy.
2. Firebase Console -> **Authentication** -> **Settings** -> **Authorized
   domains**.

Miss the first and the Worker refuses to send people back. Miss the second and
Firebase refuses the sign-in once they arrive.

---

## If something goes wrong

The page shows the reason as a toast rather than failing silently.

**"That return address is not on the allow-list"**
The site's address is not in `ALLOWED_ORIGINS`. Origins only: scheme, host and
port, no path.

**"Discord refused the login. Check the client secret and redirect URI."**
Either the client secret is wrong, or the redirect URI registered on Discord
does not exactly match `OAUTH_REDIRECT_URI`.

**"The site could not create your session. The Firebase key may be wrong."**
`FIREBASE_PRIVATE_KEY` is not a valid PKCS#8 key, usually from a partial paste.
Set it again with the whole key including both header lines.

**"Login could not be verified"**
The state did not check out - usually a stale login left open for more than ten
minutes. Start again.

**Sign-in seems to work but the account never appears**
The domain is missing from Firebase's Authorized domains list.
