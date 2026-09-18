// Optional Telegram alerts.
//
// Configured entirely by environment variables in the Netlify dashboard, never
// by anything committed to this repo:
//
//   TELEGRAM_BOT_TOKEN   from @BotFather when you create the bot
//   TELEGRAM_CHAT_ID     the chat the alerts land in — see DEPLOY.md, BotFather
//                        does not give you this and it's the step people miss
//
// Alerts are a convenience, not the source of truth: orders and signups are
// already persisted before this is called, so a missing token, a revoked bot or
// a Telegram outage can never lose an order. Every failure is swallowed and
// logged, and `send` never throws into a request path.

const API = 'https://api.telegram.org/bot';

export const configured = () =>
  !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);

export async function send(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) {
    return { sent: false, reason: 'Telegram is not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)' };
  }
  try {
    const res = await fetch(API + token + '/sendMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chat,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      }),
      signal: AbortSignal.timeout(8000)
    });
    const body = await res.json().catch(() => ({}));
    if (!body.ok) console.warn('[telegram]', body.description || res.status);
    return { sent: body.ok === true, reason: body.description || '' };
  } catch (err) {
    console.warn('[telegram]', err.message);
    return { sent: false, reason: err.message };
  }
}

// Alerts MUST be awaited before the handler returns its response.
//
// This was fire-and-forget, on the reasoning that alerting should never delay a
// customer's request. That reasoning is wrong here, and the bug it caused is
// the worst kind: the owner set Telegram up, the "Send a test" button worked,
// and then no real order ever produced a message.
//
// The test button worked because it awaits. Everything else did not. Netlify
// runs these on Lambda, and Lambda FREEZES the execution environment the moment
// the response is returned — a promise still in flight is suspended and usually
// dropped. So the POST to Telegram was created and then killed before it left
// the machine, silently, every single time.
//
// Awaiting costs a couple of hundred milliseconds on the request. `send` never
// throws, swallows every error, and gives up after 8 seconds, so the worst case
// is a slightly slower confirmation screen — not a lost order, and not a lost
// alert.
export async function sendAll(texts) {
  const list = (Array.isArray(texts) ? texts : [texts]).filter(Boolean);
  if (!list.length) return;
  await Promise.allSettled(list.map((t) => send(t)));
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function orderText(o, shopName) {
  const lines = (o.items || []).map((i) => '  • ' + esc(i.line) + '  ' + esc(i.price)).join('\n');
  return [
    '<b>NEW ORDER ' + esc(o.no) + '</b>' + (shopName ? ' · ' + esc(shopName) : ''),
    esc(o.client) + ' · ' + esc(o.when),
    '',
    lines,
    '',
    '<b>Total:</b> ' + esc(o.total),
    '<b>Pay:</b> ' + esc(o.payLabel) + (o.payOk ? ' (paid)' : ' (unconfirmed)'),
    '<b>Fulfilment:</b> ' + esc(o.where),
    o.hold ? '<b>Hold:</b> ' + esc(o.hold) + ' min' : ''
  ].filter(Boolean).join('\n');
}

export const signupText = (r) => [
  '<b>NEW CUSTOMER REQUEST</b>',
  esc(r.name) + ' · ' + esc(r.age) + ' years old',
  'Phone: ' + esc(r.phone),
  'Address: ' + esc(r.addr),
  'Pays with: ' + esc(r.pay),
  esc(r.when),
  '',
  'Approve them in the app to send a code.'
].join('\n');

export const codeText = (name, code) =>
  '<b>CODE ISSUED</b>\n' + esc(name) + ' → <code>' + esc(code) + '</code>';

export const lowStockText = (name, left) =>
  '<b>LOW STOCK</b>\n' + esc(name) + ' is down to ' + esc(left) + '.';

// Worth its own alert rather than "down to 0g": the shelf is empty and the
// strain has stopped being orderable, which is the thing he needs to act on.
export const soldOutText = (name) =>
  '<b>SOLD OUT</b>\n' + esc(name) + ' is finished. Restock it or switch it off.';

// The owner is usually the one cancelling, so this is not news to him — it is
// news to whoever else is holding the shop's phone, and it is the record that
// the goods went back on the shelf.
export const cancelText = (o) =>
  '<b>ORDER CANCELLED ' + esc(o.no) + '</b>\n' +
  esc(o.client) + ' · ' + esc(o.total) + '\nStock has gone back on the shelf.';

export const removedText = (o, restored) =>
  '<b>ORDER DELETED ' + esc(o.no) + '</b>\n' +
  esc(o.client) + ' · ' + esc(o.total) + '\n' +
  (restored ? 'Stock has gone back on the shelf.' : 'It was already cancelled, so stock was not changed again.');

// Money actually landing is the one payment event worth interrupting someone
// for — it is what turns a promised order into a collected one.
export const paidText = (o) =>
  '<b>PAYMENT CONFIRMED ' + esc(o.no) + '</b>\n' + esc(o.client) + ' · ' + esc(o.total);

// ════════════════════════════════════════════════════════════════════════════
// Automatic messages to CUSTOMERS
//
// The Telegram alerts above go to the owner's own chat. These go out to the
// people buying, over Web Push, and they are a different problem: the owner
// writes nothing, so every message has to be worth receiving on its own or the
// whole thing gets muted.
//
// Two gates, both of which must say yes: the shop has the kind switched on,
// and that customer asked for messages. Neither party can volunteer the other.
//
// VAPID keys live in the Netlify environment, never in the repo — the private
// key is what authorises sending as this shop. With no keys configured nothing
// is attempted and nothing breaks; the app simply does not offer the opt-in.
// ════════════════════════════════════════════════════════════════════════════

import webpush from 'web-push';
import { read, mutate, KEYS } from './store.js';

export const pushConfigured = () =>
  !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);

export const pushPublicKey = () => str(process.env.VAPID_PUBLIC_KEY, 200);

let vapidReady = false;
function armVapid() {
  if (vapidReady || !pushConfigured()) return pushConfigured();
  webpush.setVapidDetails(
    // A mailto is required by the spec so a push service can complain to
    // somebody. It never reaches a customer.
    'mailto:' + (process.env.VAPID_CONTACT || 'shop@example.invalid'),
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  vapidReady = true;
  return true;
}

// Sends to every device on every code given, and forgets the dead ones.
//
// A subscription dies when the app is uninstalled or the browser drops it, and
// the push service answers 404 or 410 to say so permanently. Those are pruned
// on the spot: left alone they accumulate for months and every send drags a
// growing tail of certain failures behind it.
export async function pushTo(codeList, message) {
  if (!armVapid() || !codeList || !codeList.length) return { sent: 0, pruned: 0 };
  const wanted = new Set(codeList);
  const all = await read(KEYS.codes, []);
  const targets = all.filter((c) => wanted.has(c.code) && c.active === true &&
    c.notify === true && Array.isArray(c.push) && c.push.length);
  if (!targets.length) return { sent: 0, pruned: 0 };

  const body = JSON.stringify(message);
  const dead = [];
  let sent = 0;
  await Promise.allSettled(targets.flatMap((c) => (c.push || []).map(async (sub) => {
    try {
      await webpush.sendNotification(sub, body, { TTL: 3600 });
      sent += 1;
    } catch (err) {
      const code = err && err.statusCode;
      if (code === 404 || code === 410) dead.push({ code: c.code, endpoint: sub.endpoint });
      else console.warn('[push]', code || (err && err.message));
    }
  })));

  if (dead.length) {
    await mutate(KEYS.codes, [], (list) => list.map((c) => {
      const gone = dead.filter((d) => d.code === c.code).map((d) => d.endpoint);
      if (!gone.length) return c;
      return { ...c, push: (c.push || []).filter((s) => !gone.includes(s.endpoint)) };
    }));
  }
  return { sent, pruned: dead.length };
}

// Everybody who has asked for messages. Used for shop-wide news.
export async function everyoneListening() {
  const all = await read(KEYS.codes, []);
  return all.filter((c) => c.active === true && c.notify === true &&
    Array.isArray(c.push) && c.push.length).map((c) => c.code);
}

// How many customers would receive something, for the owner's settings screen.
export async function listenerCount() {
  return (await everyoneListening()).length;
}

// ── what the messages say ───────────────────────────────────────────────────
// Short, specific, and never a nudge for its own sake. "Something new" with no
// name is the kind of message that gets notifications switched off for good.
const shopName = (cfg) => (cfg && cfg.shopName) || 'the shop';

export const newStrainMsg = (cfg, name, from) => ({
  kind: 'newStrain',
  title: shopName(cfg),
  body: name + ' just landed' + (from ? ' \u00b7 from ' + from : '') + '.',
  tag: 'new-' + name
});

export const openedMsg = (cfg, until) => ({
  kind: 'opened',
  title: shopName(cfg) + ' is open',
  body: until ? 'Taking orders until ' + until + '.' : 'Taking orders now.',
  tag: 'opened'
});

export const runMsg = (cfg, window) => ({
  kind: 'run',
  title: 'Delivery is rolling',
  body: window ? 'Out on the run ' + window + '.' : 'Out on the run tonight.',
  tag: 'run'
});

export const orderStatusMsg = (order, label) => ({
  kind: 'orderStatus',
  title: 'Order ' + order.no,
  body: label,
  tag: 'order-' + order.no
});

export const lowStockCustomerMsg = (name, left) => ({
  kind: 'lowStock',
  title: name + ' is nearly gone',
  body: 'Down to ' + left + '. Worth getting in before it goes.',
  tag: 'low-' + name
});
