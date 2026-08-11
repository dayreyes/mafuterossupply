// Client codes. Persists to Netlify Blobs when available; falls back to env vars.
// Env: OWNER_PIN (four digits) · CLIENT_CODES (optional "4417,8802,1190")
// Actions: status · setup {pin} · owner {pin} · validate {code} · list {pin} · issue {pin,name,code?} · revoke {pin,code,active}

const ok = (body) => ({
  statusCode: 200,
  headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  body: JSON.stringify(body)
});

// Lazy + optional: a zip/drag deploy has no node_modules, so this import can fail.
// When it does the function still answers, just without persistence.
let _store; let _tried = false;
async function store() {
  if (_tried) return _store;
  _tried = true;
  try {
    const mod = await import('@netlify/blobs');
    _store = mod.getStore('mafuteros-codes');
  } catch (e) { _store = null; }
  return _store;
}

const envCodes = () => String(process.env.CLIENT_CODES || '')
  .split(/[,\s]+/).filter(Boolean)
  .map(c => ({ id: 'env-' + c, name: '', code: c, active: true, uses: 0, env: true }));

async function load() {
  const s = await store();
  const saved = s ? (await s.get('codes', { type: 'json' })) || [] : [];
  return saved.concat(envCodes().filter(e => !saved.some(x => x.code === e.code)));
}
async function save(list) {
  const s = await store();
  if (s) await s.setJSON('codes', list.filter(c => !c.env));
  return !!s;
}

async function storedPin() {
  if (process.env.OWNER_PIN) return String(process.env.OWNER_PIN);
  const s = await store();
  return s ? (await s.get('ownerPin')) || '' : '';
}
const isOwner = async (pin) => { const p = await storedPin(); return !!p && String(pin) === String(p); };
const gen = () => String(Math.floor(1000 + Math.random() * 8999));

export default async (req) => {
  if (req.method === 'OPTIONS') return ok({ ok: true });

  const persists = !!(await store());

  if (req.method !== 'POST') {
    // Plain browser visit — a readable health check.
    return ok({
      ok: true, functions: 'live', persistence: persists ? 'blobs' : 'none',
      ownerPin: (await storedPin()) ? 'set' : 'not set',
      clientCodes: (await load()).length,
      hint: persists ? 'Ready.' : 'Blobs unavailable — deploy from Git, or set OWNER_PIN and CLIENT_CODES env vars.'
    });
  }

  let body = {};
  try { body = await req.json(); } catch (e) {}
  const action = body.action;

  if (action === 'status') {
    const p = await storedPin();
    return ok({ ok: true, backend: true, configured: !!p, persists });
  }

  if (action === 'setup') {
    if (process.env.OWNER_PIN) return ok({ ok: false, error: 'PIN is set by the OWNER_PIN env var' });
    if (!persists) return ok({ ok: false, error: 'No storage. Set OWNER_PIN in Netlify env vars.' });
    if (await storedPin()) return ok({ ok: false, error: 'already configured' });
    const pin = String(body.pin || '');
    if (!/^\d{4}$/.test(pin)) return ok({ ok: false, error: 'need four digits' });
    await (await store()).set('ownerPin', pin);
    return ok({ ok: true, configured: true });
  }

  if (action === 'owner') {
    const good = await isOwner(body.pin);
    return ok({ ok: good, role: good ? 'owner' : null });
  }

  if (action === 'validate') {
    const list = await load();
    const hit = list.find(c => c.code === String(body.code) && c.active);
    if (hit && !hit.env) {
      hit.uses = (hit.uses || 0) + 1;
      hit.lastSeen = new Date().toISOString();
      await save(list);
    }
    return ok({ ok: !!hit, name: hit ? hit.name : null });
  }

  if (!(await isOwner(body.pin))) return ok({ ok: false, error: 'bad pin' });

  if (action === 'list') return ok({ ok: true, codes: await load(), persists });

  if (action === 'issue') {
    const list = await load();
    let code = String(body.code || gen());
    while (list.some(c => c.code === code)) code = gen();
    const entry = { id: Date.now(), name: body.name || '', code, active: true, uses: 0, issued: new Date().toISOString() };
    const wrote = await save([entry].concat(list));
    return ok({ ok: true, code: entry, persists: wrote });
  }

  if (action === 'revoke') {
    const list = await load();
    const hit = list.find(c => c.code === String(body.code));
    if (hit) hit.active = body.active === true;
    await save(list);
    return ok({ ok: !!hit, codes: list });
  }

  return ok({ ok: false, error: 'unknown action' });
};
