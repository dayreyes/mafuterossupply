// PIN hashing, session tokens and brute-force throttling.
//
// A numeric PIN is the entire access control for this shop, so the details
// matter more than usual:
//
//  * The PIN is never stored. We keep a scrypt hash with a per-shop random salt
//    and compare in constant time, so a leaked blob store doesn't hand over the
//    owner's PIN (or one they reuse elsewhere).
//  * The owner PIN is 6 digits, not 4. A 4-digit space is 10k combinations,
//    which is thin for the account that can see every customer's name, phone
//    and home address. Client codes stay 4 digits: they're low-value,
//    individually revocable, and rate-limited the same way.
//  * After login the PIN stops travelling. The old demo code kept the PIN in
//    memory and re-sent it with every single request; now a login mints an
//    opaque random token and only its SHA-256 is stored, so the blob store
//    can't be used to mint sessions either.
//  * Throttling is per-IP AND global. Per-IP alone is defeated by rotating
//    addresses, which is cheap; the global counter means the whole 10^6 space
//    can't be walked no matter how many IPs an attacker has.

import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { read, write, mutate, KEYS } from './store.js';

export const OWNER_PIN_LEN = 6;
export const CLIENT_CODE_LEN = 4;

const SESSION_TTL = { owner: 12 * 60 * 60 * 1000, client: 30 * 24 * 60 * 60 * 1000 };

// Per-IP: 8 tries per 15 minutes. Global: 25 consecutive failures locks all
// login attempts for 15 minutes, doubling up to an hour for a sustained attack.
const IP_LIMIT = 8;
const IP_WINDOW = 15 * 60 * 1000;
const GLOBAL_LIMIT = 25;
const GLOBAL_BASE_LOCK = 15 * 60 * 1000;
const GLOBAL_MAX_LOCK = 60 * 60 * 1000;

const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

// ── PIN ──────────────────────────────────────────────────────────────────────

export function hashPin(pin) {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: scryptSync(String(pin), salt, 64).toString('hex'), at: new Date().toISOString() };
}

export function verifyPin(pin, rec) {
  if (!rec || !rec.salt || !rec.hash) return false;
  const attempt = scryptSync(String(pin), rec.salt, 64);
  const stored = Buffer.from(rec.hash, 'hex');
  return attempt.length === stored.length && timingSafeEqual(attempt, stored);
}

export const isOwnerPin = (v) => new RegExp('^\\d{' + OWNER_PIN_LEN + '}$').test(String(v || ''));
export const isClientCode = (v) => new RegExp('^\\d{' + CLIENT_CODE_LEN + '}$').test(String(v || ''));

// ── Sessions ─────────────────────────────────────────────────────────────────

export async function createSession(role, meta = {}) {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  await mutate(KEYS.sessions, {}, (all) => {
    const live = {};
    for (const [k, v] of Object.entries(all)) if (v && v.exp > now) live[k] = v;
    live[sha256(token)] = { role, ...meta, exp: now + SESSION_TTL[role], at: now };
    return live;
  });
  return { token, expiresIn: Math.floor(SESSION_TTL[role] / 1000) };
}

export async function readSession(token) {
  if (!token) return null;
  const all = await read(KEYS.sessions, {});
  const s = all[sha256(token)];
  if (!s || s.exp <= Date.now()) return null;
  return s;
}

export async function destroySession(token) {
  if (!token) return;
  await mutate(KEYS.sessions, {}, (all) => {
    const next = { ...all };
    delete next[sha256(token)];
    return next;
  });
}

export const bearer = (req) => (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();

// Guard used by every owner-only endpoint.
export async function requireOwner(req) {
  const s = await readSession(bearer(req));
  return s && s.role === 'owner' ? s : null;
}

export async function requireClient(req) {
  const s = await readSession(bearer(req));
  return s && (s.role === 'client' || s.role === 'owner') ? s : null;
}

// ── Throttling ───────────────────────────────────────────────────────────────

// Returns { allowed, retryAfter } in seconds. Call before checking a secret.
// `respectGlobal` mirrors `countGlobal` in recordFailure: non-secret buckets
// neither feed the global lock nor are held by it.
export async function checkThrottle(bucket, ip, respectGlobal = true) {
  const now = Date.now();
  const t = await read(KEYS.throttle, {});
  const g = t.__global || { fails: 0, strikes: 0, until: 0 };
  if (respectGlobal && g.until > now) {
    return { allowed: false, retryAfter: Math.ceil((g.until - now) / 1000), global: true };
  }
  const key = bucket + ':' + ip;
  const e = t[key];
  if (e && e.until > now) return { allowed: false, retryAfter: Math.ceil((e.until - now) / 1000) };
  return { allowed: true, retryAfter: 0 };
}

// `countGlobal` is false for buckets that meter ordinary traffic rather than
// guesses at a secret — public signups, say. Letting those touch the global
// counter would mean a busy afternoon of legitimate signups could lock the
// owner out of their own login.
export async function recordFailure(bucket, ip, countGlobal = true) {
  const now = Date.now();
  await mutate(KEYS.throttle, {}, (t) => {
    const next = {};
    // Drop entries that have aged out, so this blob can't grow without bound.
    for (const [k, v] of Object.entries(t)) {
      if (k === '__global') continue;
      if (v && (v.until > now || now - v.first < IP_WINDOW)) next[k] = v;
    }
    const key = bucket + ':' + ip;
    const e = next[key] && now - next[key].first < IP_WINDOW ? next[key] : { n: 0, first: now, until: 0 };
    e.n += 1;
    if (e.n >= IP_LIMIT) e.until = now + IP_WINDOW;
    next[key] = e;

    const g = t.__global && t.__global.until <= now ? t.__global : (t.__global || { fails: 0, strikes: 0, until: 0 });
    if (countGlobal) {
      g.fails = (g.fails || 0) + 1;
      if (g.fails >= GLOBAL_LIMIT) {
        g.strikes = (g.strikes || 0) + 1;
        g.until = now + Math.min(GLOBAL_MAX_LOCK, GLOBAL_BASE_LOCK * Math.pow(2, g.strikes - 1));
        g.fails = 0;
      }
    }
    next.__global = g;
    return next;
  });
}

// A correct PIN clears that IP's strikes and the global counter — an owner who
// fat-fingers their PIN twice a day should never drift into a lockout.
export async function recordSuccess(bucket, ip) {
  await mutate(KEYS.throttle, {}, (t) => {
    const next = { ...t };
    delete next[bucket + ':' + ip];
    next.__global = { fails: 0, strikes: 0, until: 0 };
    return next;
  });
}
