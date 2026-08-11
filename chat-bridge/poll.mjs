// GWCFC Radar - Discord to radar chat bridge (GitHub Actions driver)
//
// Same logic as the Cloudflare version, driven by a scheduled workflow instead
// so there is nothing to deploy: the repo runs it, and the only setup is two
// repository secrets.
//
// GitHub's shortest schedule is five minutes and busy periods can delay it
// further, so a Discord message reaches the map within about five minutes.
// Messages going the other way stay instant, because those do not pass through
// here at all.
import { pollOnce } from './bridge-core.mjs';

const env = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  CHAT_CHANNEL_ID: process.env.CHAT_CHANNEL_ID,
  FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID || 'gwcfc-radar',
  FIREBASE_API_KEY: process.env.FIREBASE_API_KEY || 'AIzaSyAAPuBJFlhBFPhqPGlrNnn_c0NZFRgZTI8',
};

if (!env.DISCORD_TOKEN || !env.CHAT_CHANNEL_ID) {
  console.error('Missing DISCORD_TOKEN or CHAT_CHANNEL_ID.');
  console.error('Add them under Settings -> Secrets and variables -> Actions.');
  process.exit(1);
}

try {
  const res = await pollOnce(env);
  console.log(JSON.stringify(res));
  // A failed poll exits non-zero so the run is visibly red in the Actions tab
  // rather than quietly doing nothing for days.
  if (!res.ok) process.exit(1);
} catch (e) {
  console.error('chat bridge failed:', e.message);
  process.exit(1);
}
