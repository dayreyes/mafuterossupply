// Request/response helpers shared by every function.
//
// Netlify Functions v2: the handler receives a Request and MUST return a
// Response. (The old demo code used the v2 signature but returned the v1
// `{statusCode, body}` Lambda shape, which never would have worked.)
//
// No CORS headers by design — the app is served from the same origin as its
// functions, so an `access-control-allow-origin: *` would only let any other
// website on the internet replay a stolen client code against this shop.

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff'
};

export const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });

export const ok = (body = {}) => json({ ok: true, ...body });
export const fail = (error, status = 200, extra = {}) => json({ ok: false, error, ...extra }, status);

// Deliberately a 200 with ok:false for expected outcomes (bad PIN, bad code) so
// the client can show a message; real HTTP errors are reserved for transport
// and programming faults.
export const badRequest = (error) => fail(error, 400);
export const unauthorized = (error = 'not authorized') => fail(error, 401);
export const tooMany = (error, retryAfter) =>
  fail(error, 429, retryAfter ? { 'retry-after': String(retryAfter) } : {});

export async function readBody(req) {
  try {
    const body = await req.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  } catch {
    return {};
  }
}

// Netlify sits behind a proxy, so the socket address is useless — x-nf-client-connection-ip
// is the one Netlify sets itself and a client cannot forge. x-forwarded-for is a
// fallback for `netlify dev` and is only trusted for rate-limit bucketing, never auth.
export function clientIp(req) {
  const h = req.headers;
  return h.get('x-nf-client-connection-ip') ||
    (h.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown';
}

export const str = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);
export const num = (v, min, max, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
};

// Router for the `{ action: '...' }` request bodies the app sends.
export async function route(req, handlers) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (req.method !== 'POST') return fail('POST only', 405);
  const body = await readBody(req);
  const handler = handlers[body.action];
  if (!handler) return badRequest('unknown action');
  try {
    return await handler(body, req);
  } catch (err) {
    console.error('[' + body.action + ']', err);
    // Checked by name rather than instanceof so this module stays free of a
    // circular import back into store.js.
    if (err && err.name === 'StorageDown') {
      return fail('Storage is unavailable — the shop cannot save right now. See DEPLOY.md.', 503);
    }
    return fail('server error', 500);
  }
}
