// Posts a new order (or a signup request) to El Mafu's Telegram.
// Env vars required: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
const TG = 'https://api.telegram.org/bot';

const ok = (body) => ({
  statusCode: 200,
  headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  body: JSON.stringify(body)
});

async function send(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return { sent: false, reason: 'missing env' };
  const res = await fetch(TG + token + '/sendMessage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true })
  });
  const json = await res.json().catch(() => ({}));
  return { sent: !!json.ok, reason: json.description || '' };
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function orderText(o) {
  const lines = (o.items || []).map(i => '  • ' + esc(i.line) + '  ' + esc(i.price)).join('\n');
  return [
    '<b>ORDEN NUEVA ' + esc(o.no) + '</b>',
    esc(o.client) + ' · ' + esc(o.when),
    '',
    lines,
    '',
    '<b>Total:</b> ' + esc(o.total),
    '<b>Pago:</b> ' + esc(o.pay) + (o.payOk ? ' (pagado)' : ' (sin confirmar)'),
    '<b>Entrega:</b> ' + esc(o.where),
    o.hold ? '<b>Hold:</b> ' + o.hold + ' min' : ''
  ].filter(Boolean).join('\n');
}

function signupText(r) {
  return [
    '<b>CLIENTE NUEVO</b>',
    esc(r.name) + ' · ' + esc(r.age) + ' años',
    'Tel: ' + esc(r.phone),
    'Dir: ' + esc(r.addr),
    'Paga con: ' + esc(r.pay),
    esc(r.when)
  ].join('\n');
}

export default async (req) => {
  if (req.method === 'OPTIONS') return ok({ ok: true });
  if (req.method !== 'POST') return ok({ ok: false, error: 'POST only' });
  let body = {};
  try { body = await req.json(); } catch (e) {}
  const kind = body.kind || 'order';
  const text = kind === 'signup' ? signupText(body.data || {})
    : kind === 'code' ? '<b>CÓDIGO EMITIDO</b>\n' + esc(body.data && body.data.name) + ' → ' + esc(body.data && body.data.code)
    : orderText(body.data || {});
  const r = await send(text);
  return ok({ ok: r.sent, reason: r.reason });
};
