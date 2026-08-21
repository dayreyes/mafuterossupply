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
