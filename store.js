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
