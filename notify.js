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

// Fire-and-forget: alerting must never delay or fail the customer's request.
export const sendAsync = (text) => { send(text).catch(() => {}); };

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
