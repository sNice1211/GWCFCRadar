#!/usr/bin/env node
/*
 * Pinging people from the radar chat, driven in a real browser, no network.
 *
 *     node tools/test-chat-pings.mjs
 *
 * Typing @ in the composer opens a list of people. Picking one puts their
 * name in the message and remembers their Discord id; on send, that name is
 * rewritten as <@id> on the copy Discord receives, and the ids travel to the
 * Pi as a separate list. The Pi turns that list into allowed_mentions.users,
 * which is the only reason the token in the text raises a notification.
 *
 * The things worth being careful about, and why each has checks here:
 *
 *   1. A ping is a notification on somebody else's phone. So the list the
 *      browser sends has to be the people actually named in the message as
 *      it finally reads, not everyone who was ever picked while typing.
 *      Section 4 deletes a name after picking it and checks the ping goes
 *      with it.
 *   2. Display names are arbitrary text. "A.B(x)" is a legal Discord name
 *      and a broken regex, so section 3 pings somebody called that.
 *   3. An email address contains an @ and is not a mention. Section 2.
 *   4. Enter means "take the highlighted name" while the picker is open and
 *      "send" when it is not. Getting that backwards sends half a name.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('playwright is not installed, skipping. npm i playwright');
  process.exit(0);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript',
      body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css',
      body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  return route.abort();
});
await page.goto('file://' + join(ROOT, 'index.html'),
                { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);

// A roster and a chat window, planted directly. The point of these tests is
// the mention machinery, not Firestore, so the two things Firestore would
// have supplied are supplied here instead.
const seed = () => page.evaluate(() => {
  _mentionRoster = [
    { id: '100000000000000001', name: 'Dan',        avatar: '' },
    { id: '100000000000000002', name: 'Danielle',   avatar: '' },
    { id: '100000000000000003', name: 'Storm Chaser Dan', avatar: '' },
    { id: '100000000000000004', name: 'A.B(x)',     avatar: '' },
  ];
  _mentionRosterAt = Date.now();          // stops it trying to fetch
  _mentionPicked = [];
  _chatMsgs = [
    { name: 'Ellie', text: 'hi', ts: Date.now() - 5000, source: 'discord',
      discordId: '100000000000000009' },
    { name: 'MapOnlyPerson', text: 'hello', ts: Date.now() - 4000, source: 'radar',
      uid: 'someone-else' },
  ];
});

// Type into the composer the way a person does, so oninput actually fires.
async function type(text) {
  await page.evaluate(t => {
    const i = document.getElementById('lqm-chat-input');
    i.disabled = false;
    i.value = t;
    i.setSelectionRange(t.length, t.length);
  }, text);
  await page.evaluate(() => _mentionOnInput());
  await page.waitForTimeout(60);
}
const picker = () => page.evaluate(() => {
  const box = document.getElementById('lqm-chat-mentions');
  return {
    open: box.classList.contains('open'),
    names: [...box.querySelectorAll('.chat-mname')].map(e => e.textContent),
    tags: [...box.querySelectorAll('.chat-mwhere')].map(e => e.textContent),
    sel: [...box.querySelectorAll('.chat-mrow')].findIndex(e => e.classList.contains('on')),
  };
});

console.log('\n1. the page boots and the composer has a picker');
{
  ok('no page errors on boot', errors.length === 0, errors[0]);
  const r = await page.evaluate(() => ({
    box: !!document.getElementById('lqm-chat-mentions'),
    hint: (document.getElementById('lqm-chat-input') || {}).placeholder || '',
  }));
  ok('the picker element exists', r.box);
  ok('and the composer says pinging is possible', /@/.test(r.hint), r.hint);
}

console.log('\n2. typing @ opens it, and an email address does not');
{
  await seed();
  await type('hey @dan');
  let p = await picker();
  ok('the picker opens on @', p.open, JSON.stringify(p));
  ok('and it matches on what was typed',
     p.names.includes('Dan') && p.names.includes('Danielle'), p.names.join(','));
  ok('an exact prefix sorts above a mid-string match',
     p.names[0] === 'Dan' || p.names[0] === 'Danielle', p.names.join(','));

  await type('mail me at bob@example.com');
  p = await picker();
  ok('an @ inside a word is not a mention', !p.open, JSON.stringify(p));

  await type('hi @storm chaser');
  p = await picker();
  ok('a name with spaces in it is still findable',
     p.open && p.names.includes('Storm Chaser Dan'), p.names.join(','));

  await type('@a b c d e f');
  p = await picker();
  ok('but it gives up before eating a whole sentence', !p.open, JSON.stringify(p));
}

console.log('\n3. who is offered, and whether the ping will actually land');
{
  await seed();
  await type('@');
  const p = await picker();
  ok('people from the chat window are offered as well as the roster',
     p.names.includes('Ellie'), p.names.join(','));
  ok('somebody with a Discord id is marked as reachable there',
     p.tags.some(t => /PINGS DISCORD/.test(t)), p.tags.join(','));
  // Naming somebody who has never linked Discord is allowed, and says so
  // rather than promising a notification that cannot happen.
  await type('@MapOnly');
  const q = await picker();
  ok('and somebody without one is marked map-only rather than promised a ping',
     q.names.includes('MapOnlyPerson') && q.tags.some(t => /MAP ONLY/.test(t)),
     q.names.join(',') + ' / ' + q.tags.join(','));
}

console.log('\n4. keyboard: arrows move, enter picks rather than sends');
{
  await seed();
  await type('hey @dan');
  const before = await picker();
  await page.evaluate(() => _mentionOnKeydown({
    key: 'ArrowDown', preventDefault() {} }));
  const moved = await picker();
  ok('down moves the highlight', moved.sel === (before.sel + 1) % moved.names.length,
     `${before.sel} -> ${moved.sel}`);
  const r = await page.evaluate(() => {
    let sent = false;
    const realSend = window.chatSend;
    window.chatSend = () => { sent = true; };
    _mentionOnKeydown({ key: 'Enter', preventDefault() {} });
    window.chatSend = realSend;
    return { sent, value: document.getElementById('lqm-chat-input').value,
             picked: _mentionPicked.slice() };
  });
  ok('enter with the picker open does NOT send', r.sent === false, String(r.sent));
  ok('it completes the name instead', /@Danielle /.test(r.value), r.value);
  ok('and remembers the id behind it',
     r.picked.length === 1 && r.picked[0].id === '100000000000000002',
     JSON.stringify(r.picked));

  const s = await page.evaluate(() => {
    let sent = false;
    const realSend = window.chatSend;
    window.chatSend = () => { sent = true; };
    _mentionClose();
    _mentionOnKeydown({ key: 'Enter', preventDefault() {} });
    window.chatSend = realSend;
    return sent;
  });
  ok('with the picker closed, enter sends as it always did', s === true, String(s));
}

console.log('\n5. the message that goes to Discord');
{
  const r = await page.evaluate(() => {
    const picked = [{ id: '100000000000000001', name: 'Dan' }];
    return {
      plain: _mentionToDiscord('hey @Dan look at this', picked),
      twice: _mentionToDiscord('@Dan and @Dan again', picked),
      // A display name that is also a regex. Unescaped, this either throws
      // or matches the wrong thing, and either way the ping is wrong.
      regex: _mentionToDiscord('hi @A.B(x) there',
        [{ id: '100000000000000004', name: 'A.B(x)' }]),
      // Case is not something people are careful about when typing a name.
      cased: _mentionToDiscord('hey @dan', picked),
      untouched: _mentionToDiscord('nobody named here', picked),
    };
  });
  ok('the name becomes the token that actually pings',
     r.plain === 'hey <@100000000000000001> look at this', r.plain);
  ok('every occurrence is converted, not just the first',
     r.twice === '<@100000000000000001> and <@100000000000000001> again', r.twice);
  ok('a name full of regex characters converts correctly',
     r.regex === 'hi <@100000000000000004> there', r.regex);
  ok('and typing the name in lower case still pings',
     r.cased === 'hey <@100000000000000001>', r.cased);
  ok('text naming nobody is left exactly as written',
     r.untouched === 'nobody named here', r.untouched);
}

console.log('\n6. a name deleted after picking does not ping');
{
  const r = await page.evaluate(() => {
    _mentionPicked = [{ id: '100000000000000001', name: 'Dan' },
                      { id: '100000000000000002', name: 'Danielle' }];
    return {
      both: _mentionsInText('@Dan and @Danielle look'),
      // Picked, then thought better of it and deleted the name again.
      one:  _mentionsInText('@Danielle look'),
      none: _mentionsInText('changed my mind entirely'),
    };
  });
  ok('names still in the message all ping', r.both.length === 2, JSON.stringify(r.both));
  ok('a name deleted from the message stops pinging',
     r.one.length === 1 && r.one[0].name === 'Danielle', JSON.stringify(r.one));
  ok('and a message with every name removed pings nobody',
     r.none.length === 0, JSON.stringify(r.none));
}

console.log('\n6b. one name inside another does not ping the wrong person');
{
  // The worst thing this feature could do is notify somebody who was never
  // named. "Danielle" contains "Dan", so a plain substring match pings Dan
  // every time anyone talks to Danielle, and he has no way to tell why.
  const r = await page.evaluate(() => {
    _mentionPicked = [{ id: '100000000000000001', name: 'Dan' },
                      { id: '100000000000000002', name: 'Danielle' }];
    return {
      onlyLong: _mentionsInText('@Danielle are you there').map(p => p.name),
      onlyShort: _mentionsInText('@Dan are you there').map(p => p.name),
      punctuated: _mentionsInText('@Dan! look').map(p => p.name),
      atEnd: _mentionsInText('thanks @Dan').map(p => p.name),
      discord: _mentionToDiscord('@Danielle hello',
        [{ id: '100000000000000001', name: 'Dan' },
         { id: '100000000000000002', name: 'Danielle' }]),
      chip: _mentionDecorate('@Danielle hello',
        [{ id: '100000000000000001', name: 'Dan' },
         { id: '100000000000000002', name: 'Danielle' }], false),
    };
  });
  ok('naming Danielle does NOT also ping Dan',
     r.onlyLong.length === 1 && r.onlyLong[0] === 'Danielle', r.onlyLong.join(','));
  ok('naming Dan pings only Dan',
     r.onlyShort.length === 1 && r.onlyShort[0] === 'Dan', r.onlyShort.join(','));
  ok('a name followed by punctuation still counts',
     r.punctuated.join(',') === 'Dan', r.punctuated.join(','));
  ok('and a name at the very end of the message still counts',
     r.atEnd.join(',') === 'Dan', r.atEnd.join(','));
  ok('the Discord copy points at Danielle, not at Dan with letters left over',
     r.discord === '<@100000000000000002> hello', r.discord);
  ok('and the chip on the map wraps the whole name',
     /<span class="chat-mention">@Danielle<\/span>/.test(r.chip), r.chip);
}

console.log('\n7. one message cannot ping a crowd');
{
  const r = await page.evaluate(() => {
    _mentionPicked = [];
    // Built by string concatenation, NOT by adding to 1e17. A Discord id is
    // past Number.MAX_SAFE_INTEGER, so 100000000000000000 + 1 is still
    // 100000000000000000 and every "different" id would be the same one.
    const idOf = i => '10000000000000' + String(1000 + i);
    _mentionRoster = Array.from({ length: 30 }, (_, i) => ({
      id: idOf(i), name: 'P' + i, avatar: '' }));
    _mentionRosterAt = Date.now();
    const input = document.getElementById('lqm-chat-input');
    input.disabled = false;
    // Pick person after person, past the cap.
    for (let i = 0; i < 20; i++) {
      input.value = (input.value || '') + '@';
      input.setSelectionRange(input.value.length, input.value.length);
      _mentionList = [{ id: idOf(i), name: 'P' + i,
                        avatar: '', where: 'discord' }];
      _mentionAnchor = input.value.length - 1;
      _mentionOpen = true;
      _mentionChoose(0);
    }
    const text = input.value;
    input.value = '';
    return { picked: _mentionPicked.length, inText: _mentionsInText(text).length };
  });
  ok('the picker stops remembering past the cap', r.picked === 8, String(r.picked));
  ok('and the list that goes out is capped too', r.inText <= 8, String(r.inText));
}

console.log('\n8. being pinged is visible on the map, not only in Discord');
{
  const r = await page.evaluate(() => {
    _aiSyncProfileData = { discordId: '100000000000000007' };
    const mine = { name: 'Ellie', text: 'hey @Me look', ts: Date.now(),
                   mentions: [{ id: '100000000000000007', name: 'Me' }] };
    const theirs = { name: 'Ellie', text: 'hey @Dan look', ts: Date.now(),
                     mentions: [{ id: '100000000000000001', name: 'Dan' }] };
    const plain = { name: 'Ellie', text: 'no ping here', ts: Date.now() };
    return {
      hitMe: _mentionHitsMe(mine),
      hitThem: _mentionHitsMe(theirs),
      hitNone: _mentionHitsMe(plain),
      decoMine: _mentionDecorate('hey @Me look', mine.mentions, true),
      decoTheirs: _mentionDecorate('hey @Dan look', theirs.mentions, false),
    };
  });
  ok('a ping aimed at this account is recognised', r.hitMe === true, String(r.hitMe));
  ok('one aimed at somebody else is not', r.hitThem === false, String(r.hitThem));
  ok('and a message with no mentions at all is not', r.hitNone === false, String(r.hitNone));
  ok('your own ping is drawn in the gold this page uses for "about you"',
     /chat-mention me/.test(r.decoMine), r.decoMine);
  ok('somebody else being pinged is still a chip, just not gold',
     /chat-mention"/.test(r.decoTheirs) && !/ me"/.test(r.decoTheirs), r.decoTheirs);
}

console.log('\n9. a name is text, not markup');
{
  const r = await page.evaluate(() => {
    // A Discord display name can contain anything. It reaches this page
    // through Firestore, which nobody trusts, so the decoration must run
    // over already-escaped text and never reintroduce a tag.
    const nasty = '<img src=x onerror=alert(1)>';
    const escaped = _escapeHtml('hey @' + nasty);
    return {
      out: _mentionDecorate(escaped, [{ id: '1', name: nasty }], false),
      escaped,
    };
  });
  // The test is not "the word onerror is absent": as escaped TEXT it is
  // harmless and it should still be readable in the message. The test is
  // that the only real tag in the output is the chip this code added.
  const tags = (r.out.match(/<[a-zA-Z/][^>]*>/g) || []);
  ok('the only live tag is the chip this code added itself',
     tags.every(t => /^<\/?span/.test(t)), tags.join(' '));
  ok('the attacker tag came through as text, not markup',
     r.out.includes('&lt;img') && !r.out.includes('<img'), r.out.slice(0, 90));
}

console.log('\n10. the ping notice while the chat is closed');
{
  const r = await page.evaluate(() => {
    _aiSyncProfileData = { discordId: '100000000000000007' };
    document.getElementById('lqm-chat-overlay')?.classList.remove('lqm-panel-open');
    const toasts = [];
    const real = window.showToast;
    window.showToast = (m) => toasts.push(m);
    const ping = (t) => ({ name: 'Ellie', text: 'oi', ts: t,
      mentions: [{ id: '100000000000000007', name: 'Me' }] });

    _chatPingSeen = 0;
    _chatMsgs = [ping(1000), ping(2000)];
    _chatNoticePings();                  // first snapshot: history, not news
    const afterFirst = toasts.length;

    _chatMsgs = [ping(1000), ping(2000), ping(3000)];
    _chatNoticePings();                  // a genuinely new one
    const afterNew = toasts.length;

    _chatNoticePings();                  // the same snapshot again
    const afterRepeat = toasts.length;

    document.getElementById('lqm-chat-overlay')?.classList.add('lqm-panel-open');
    _chatMsgs = [...(_chatMsgs), ping(4000)];
    _chatNoticePings();                  // pinged, but already looking at it
    const afterOpen = toasts.length;

    document.getElementById('lqm-chat-overlay')?.classList.remove('lqm-panel-open');
    window.showToast = real;
    return { afterFirst, afterNew, afterRepeat, afterOpen, toasts };
  });
  ok('opening the page does not announce yesterday\'s pings',
     r.afterFirst === 0, String(r.afterFirst));
  ok('a new ping is announced', r.afterNew === 1, String(r.afterNew));
  ok('and the same one is not announced twice',
     r.afterRepeat === 1, String(r.afterRepeat));
  ok('nothing is said while the chat is already on screen',
     r.afterOpen === 1, String(r.afterOpen));
  ok('the notice names who did it', /Ellie/.test(r.toasts[0] || ''), r.toasts[0]);
}

console.log('\n11. what actually goes out over the relay');
{
  const r = await page.evaluate(async () => {
    let sent = null;
    const realRelay = window._relayPost;
    window._relayPost = async (kind, payload) => { sent = { kind, payload }; };
    await _chatPostToDiscord('Ralph', 'hey <@100000000000000001> look',
      [{ id: '100000000000000001', name: 'Dan' }]);
    window._relayPost = realRelay;
    return sent;
  });
  ok('it goes to the chat door', r && r.kind === 'chat', JSON.stringify(r && r.kind));
  ok('the ids travel as a plain list beside the text',
     Array.isArray(r.payload.mentions)
     && r.payload.mentions[0] === '100000000000000001',
     JSON.stringify(r.payload.mentions));
  ok('the sender is named so the channel reads as people, not a bot',
     /Ralph/.test(r.payload.username), r.payload.username);
  ok('and the text carries the token Discord needs to render the ping',
     /<@100000000000000001>/.test(r.payload.content), r.payload.content);

  const none = await page.evaluate(async () => {
    let sent = null;
    const realRelay = window._relayPost;
    window._relayPost = async (kind, payload) => { sent = { kind, payload }; };
    await _chatPostToDiscord('Ralph', 'just talking', []);
    window._relayPost = realRelay;
    return sent;
  });
  ok('a message pinging nobody sends an empty list, not junk',
     Array.isArray(none.payload.mentions) && none.payload.mentions.length === 0,
     JSON.stringify(none.payload.mentions));
}

console.log('\n12. still no page errors after all of that');
ok('the whole run stayed clean', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
