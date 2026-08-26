// Persistence on Netlify Blobs.
//
// Every read goes through a default so a fresh, never-configured shop returns
// empty collections rather than throwing. Writes are last-write-wins: this is a
// single-owner shop where the only concurrent writers are the owner's phone and
// a customer placing an order, so a compare-and-swap layer would cost more than
// it buys. `mutate()` at least keeps each read-modify-write in one place.
//
// If Blobs is genuinely unavailable the functions must NOT silently pretend to
// work — the old demo code fell back to "no persistence" and carried on, which
// is exactly how a shop ends up losing orders. We surface it instead.

import { getStore } from '@netlify/blobs';

const STORE = 'mafuteros';

// Strong consistency, deliberately.
//
// Netlify Blobs is EVENTUALLY consistent by default, which broke sign-in
// outright: logging in writes the new session, and the four requests that fire
// immediately afterwards could read a copy of the sessions blob that did not
// have it yet. The owner signed in successfully and was told "session expired"
// in the same breath, and every write after that failed the same way.
//
// The same hazard applies to everything else here — save a strain, reload,
// and the catalogue read could still be the old one. This shop does a handful
// of requests a day, so the extra read latency costs nothing next to being
// correct.
const CONSISTENCY = 'strong';

let _store = null;
let _factory = () => getStore({ name: STORE, consistency: CONSISTENCY });

function store() {
  if (!_store) _store = _factory();
  return _store;
}

// Test seam. The suite in test/ swaps in an in-memory store so the whole
// function layer can be exercised without a deployed site. Deliberately a
// function call rather than an environment flag, so there is no way to switch
// production persistence off by setting a variable in the dashboard.
export function __setStoreFactory(factory) {
  _factory = factory;
  _store = null;
}

export class StorageDown extends Error {
  constructor(cause) {
    super('storage unavailable');
    this.name = 'StorageDown';
    this.cause = cause;
  }
}

export async function available() {
  try {
    await store().get('__probe');
    return true;
  } catch {
    return false;
  }
}

// A readable answer to "why is the shop down?".
//
// The health probe reads a raw value while every real read parses JSON, so the
// two can disagree — a reachable store with one unreadable record looks exactly
// like a dead store from the outside, and the difference decides whether the fix
// is "wait" or "repair that record". Chasing that distinction through a phone
// screen full of truncated log lines is miserable, so this reports it directly.
//
// Names and error text only. No stored values ever leave here: what is in these
// records is customers' names, phones and addresses.
export async function diagnose() {
  const out = { store: STORE, consistency: CONSISTENCY, opened: false, probe: null, keys: [] };
  try {
    store();
    out.opened = true;
  } catch (err) {
    out.probe = 'could not open the store: ' + (err && err.message);
    return out;
  }
  try {
    await store().get('__probe');
    out.probe = 'ok';
  } catch (err) {
    out.probe = 'failed: ' + (err && err.message);
    return out;
  }
  for (const key of Object.values(KEYS)) {
    const row = { key };
    try {
      const raw = await store().get(key);
      row.exists = raw != null;
      row.bytes = raw == null ? 0 : String(raw).length;
    } catch (err) {
      row.readable = false;
      row.error = 'raw read failed: ' + (err && err.message);
      out.keys.push(row);
      continue;
    }
    try {
      await store().get(key, { type: 'json' });
      row.readable = true;
    } catch (err) {
      row.readable = false;
      row.error = 'not valid JSON: ' + (err && err.message);
    }
    out.keys.push(row);
  }
  return out;
}

export async function read(key, dflt) {
  try {
    const v = await store().get(key, { type: 'json' });
    return v == null ? dflt : v;
  } catch (err) {
    throw new StorageDown(err);
  }
}

export async function write(key, value) {
  try {
    await store().setJSON(key, value);
  } catch (err) {
    throw new StorageDown(err);
  }
}

// Read, transform, write. Returns whatever the transform returned so callers
// can hand the updated value straight back to the client.
export async function mutate(key, dflt, fn) {
  const current = await read(key, dflt);
  const next = await fn(current);
  await write(key, next === undefined ? current : next);
  return next === undefined ? current : next;
}

export const KEYS = {
  auth: 'auth',
  config: 'config',
  products: 'products',
  orders: 'orders',
  signups: 'signups',
  codes: 'codes',
  sessions: 'sessions',
  throttle: 'throttle',
  counters: 'counters'
};
