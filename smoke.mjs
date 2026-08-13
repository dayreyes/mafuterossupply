// End-to-end smoke test of the whole function layer.
//
// Run with `npm test`. It drives the real handlers through real Request objects
// against an in-memory store, so it covers routing, auth, validation, pricing
// and stock without needing a deployed site or a network.
//
//   node --test is deliberately not used: this suite is meant to be readable by
//   whoever inherits the shop, and a flat list of ok/FAIL lines does that job.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { __setStoreFactory } from '../netlify/functions/lib/store.js';

// In-memory stand-in for Netlify Blobs.
const mem = new Map();
__setStoreFactory(() => ({
  async get(key, opts) {
    const v = mem.get(key);
    if (v === undefined) return null;
    return opts && opts.type === 'json' ? JSON.parse(v) : v;
  },
  async set(key, val) { mem.set(key, String(val)); },
  async setJSON(key, val) { mem.set(key, JSON.stringify(val)); }
}));

const B = join(dirname(fileURLToPath(import.meta.url)), '..', 'netlify', 'functions') + '/';
const auth = (await import(B + 'auth.js')).default;
const shop = (await import(B + 'shop.js')).default;
const orders = (await import(B + 'orders.js')).default;
const signups = (await import(B + 'signups.js')).default;
const codes = (await import(B + 'codes.js')).default;

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + JSON.stringify(extra) : '')); }
};

const call = async (fn, body, token, ip = '1.2.3.4') => {
  const headers = { 'content-type': 'application/json', 'x-nf-client-connection-ip': ip };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fn(new Request('https://shop.test/.netlify/functions/x', {
    method: 'POST', headers, body: JSON.stringify(body)
  }));
  return { status: res.status, body: await res.json() };
};

console.log('\n— setup & auth —');
let r = await call(auth, { action: 'status' });
check('status: unconfigured', r.body.ok && !r.body.configured && r.body.storage, r.body);
check('status: owner PIN is 6 digits', r.body.ownerPinLength === 6);

r = await call(auth, { action: 'setup', pin: '1234' });
check('setup: rejects 4-digit PIN', !r.body.ok, r.body);
r = await call(auth, { action: 'setup', pin: '111111' });
check('setup: rejects repeated digits', !r.body.ok, r.body);
r = await call(auth, { action: 'setup', pin: '123456' });
check('setup: rejects sequential run', !r.body.ok, r.body);

r = await call(auth, { action: 'setup', pin: '481902', shopName: "Mafutero's Supply" });
check('setup: accepts a good PIN', r.body.ok && r.body.token, r.body);
const ownerToken = r.body.token;

r = await call(auth, { action: 'setup', pin: '999111' });
check('setup: refuses a second claim', !r.body.ok, r.body);

r = await call(auth, { action: 'login', pin: '000000' });
check('login: wrong PIN rejected', !r.body.ok, r.body);
r = await call(auth, { action: 'login', pin: '481902' });
check('login: right PIN issues a token', r.body.ok && r.body.token, r.body);

r = await call(shop, { action: 'config' });
check('owner endpoint refuses anonymous', r.status === 401, r);

console.log('\n— config & catalogue —');
r = await call(shop, {
  action: 'saveConfig',
  config: {
    shopName: "Mafutero's Supply",
    payments: [{ id: 'zelle', handle: '(813) 555-0100', enabled: true }, { id: 'cash', enabled: true }],
    zones: [{ name: 'Seminole Heights', mi: 5 }, { name: 'Brandon', mi: 12 }]
  }
}, ownerToken);
check('saveConfig: stores zones', r.body.ok && r.body.config.zones.length === 2, r.body);
const zoneIds = r.body.config.zones.map((z) => z.id);

r = await call(shop, {
  action: 'saveConfig',
  config: { run: { on: true, start: '18:00', end: '21:00', max: 15, zones: zoneIds.concat(['bogus-zone']) } }
}, ownerToken);
check('saveConfig: drops unknown run zones', r.body.config.run.zones.length === 2, r.body.config.run);
check('setupComplete false with no products', r.body.config.setupComplete === false, r.body.config);

r = await call(shop, { action: 'saveProduct', product: { name: 'A', price: 40 } }, ownerToken);
check('saveProduct: rejects short name', !r.body.ok, r.body);
r = await call(shop, { action: 'saveProduct', product: { name: 'Bolo Runtz', price: 0 } }, ownerToken);
check('saveProduct: rejects zero price', !r.body.ok, r.body);

r = await call(shop, {
  action: 'saveProduct',
  product: { name: 'Bolo Runtz', sec: 'Indoors', type: 'Hybrid', price: 25, stock: 10, thc: '29%' }
}, ownerToken);
check('saveProduct: creates', r.body.ok && r.body.products.length === 1, r.body);
const pid = r.body.products[0].id;
check('saveProduct: derives a weight ladder', r.body.products[0].weights.length === 4, r.body.products[0].weights);

r = await call(shop, { action: 'menu' });
check('menu: public, no token needed', r.body.ok && r.body.products.length === 1, r.body);
check('menu: setupComplete now true', r.body.config.setupComplete === true, r.body.config);

console.log('\n— signups & codes —');
r = await call(signups, { action: 'submit', name: 'Kiko', phone: '813-555-0188', addr: '4120 E Fowler', bday: '01/02/2010', id: true, pay: 'zelle' });
check('signup: under 21 rejected', !r.body.ok, r.body);
r = await call(signups, { action: 'submit', name: 'Kiko', phone: '813-555-0188', addr: '4120 E Fowler', bday: '01/02/1995', id: false, pay: 'zelle' });
check('signup: unchecked ID rejected', !r.body.ok, r.body);
r = await call(signups, { action: 'submit', name: 'Kiko', phone: '813-555-0188', addr: '4120 E Fowler', bday: '01/02/1995', id: true, pay: 'zelle' });
check('signup: valid accepted', r.body.ok, r.body);

r = await call(signups, { action: 'list' }, ownerToken);
check('signup: owner sees the request', r.body.signups.length === 1, r.body);
const sid = r.body.signups[0].id;
check('signup: age computed server-side', r.body.signups[0].age >= 30, r.body.signups[0]);

r = await call(signups, { action: 'approve', id: sid }, ownerToken);
check('approve: mints a 4-digit code', r.body.ok && /^\d{4}$/.test(r.body.code), r.body);
const clientCode = r.body.code;
check('approve: clears the request', r.body.signups.length === 0, r.body);

r = await call(auth, { action: 'unlock', code: '0000' === clientCode ? '1111' : '0000' }, null, '9.9.9.9');
check('unlock: wrong code rejected', !r.body.ok, r.body);
r = await call(auth, { action: 'unlock', code: clientCode }, null, '5.5.5.5');
check('unlock: right code issues a client token', r.body.ok && r.body.token, r.body);
const clientToken = r.body.token;

console.log('\n— orders —');
r = await call(orders, { action: 'place', items: [{ pid, weightIdx: 0, qty: 1 }], mode: 'pickup', pay: 'cash' });
check('place: refuses without a session', r.status === 401, r);

r = await call(orders, {
  action: 'place', items: [{ pid, weightIdx: 0, qty: 1, unit: 1, price: '$1' }],
  mode: 'pickup', pay: 'cash', slot: '8:15pm'
}, clientToken);
check('place: succeeds', r.body.ok, r.body);
check('place: server prices it, ignoring client numbers', r.body.order.total === '$25', r.body.order);
check('place: cash pickup gets a hold', r.body.order.hold === 30, r.body.order);

r = await call(shop, { action: 'menu' });
check('place: decremented stock 10 -> 9', r.body.products[0].stock === 9, r.body.products[0]);

r = await call(orders, { action: 'place', items: [{ pid, weightIdx: 0, qty: 999 }], mode: 'pickup', pay: 'cash' }, clientToken);
check('place: refuses more than stock', !r.body.ok, r.body);

r = await call(orders, { action: 'place', items: [{ pid, weightIdx: 3, qty: 1 }], mode: 'delivery', pay: 'zelle', zone: zoneIds[1], slot: '8:30pm' }, clientToken);
check('place: delivery priced with mileage fee', r.body.ok && r.body.order.fee === 6, r.body.order);
check('place: 1oz ladder = 25*5.6 = 140', r.body.order.subtotal === 140, r.body.order);

r = await call(orders, { action: 'list' }, ownerToken);
check('list: owner sees both orders', r.body.orders.length === 2, r.body.orders.length);
check('list: stops counted for today', r.body.stops === 1, r.body);
const oid = r.body.orders[0].id;

r = await call(orders, { action: 'cancel', id: oid }, ownerToken);
check('cancel: marks cancelled', r.body.orders[0].cancelled === true, r.body.orders[0]);
r = await call(shop, { action: 'menu' });
check('cancel: returns stock to the shelf', r.body.products[0].stock === 9, r.body.products[0]);

r = await call(orders, { action: 'mine' }, clientToken);
check('mine: customer sees only their own', r.body.orders.length === 2, r.body.orders.length);

console.log('\n— throttling —');
let blocked = false;
for (let i = 0; i < 12; i++) {
  const t = await call(auth, { action: 'login', pin: '000001' }, null, '7.7.7.7');
  if (t.status === 429) { blocked = true; break; }
}
check('login: locks out after repeated failures', blocked);

r = await call(auth, { action: 'login', pin: '481902' }, null, '4.4.4.4');
check('login: a different IP still works', r.body.ok, r.body);

console.log('\n— codes —');
r = await call(codes, { action: 'issue', name: 'Walk-in' }, ownerToken);
check('issue: mints a code', r.body.ok && /^\d{4}$/.test(r.body.code), r.body);
r = await call(codes, { action: 'revoke', code: clientCode, active: false }, ownerToken);
check('revoke: flips active', r.body.ok, r.body);
r = await call(auth, { action: 'unlock', code: clientCode }, null, '6.6.6.6');
check('revoke: revoked code no longer unlocks', !r.body.ok, r.body);

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
