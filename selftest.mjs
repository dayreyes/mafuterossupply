// The whole test suite, in one file.
//
// One file on purpose. This shop is maintained through the GitHub web uploader,
// which flattens dragged folders and renames the collisions, so a `test/`
// directory does not survive the trip — the previous suite reached the repo as
// two stale files and `npm test` quietly did nothing for a month. A single
// file at the root can be dragged in like any other and cannot be mangled.
//
//   npm test
//
// It assembles netlify/functions/ from the flat root files exactly the way
// netlify.toml does at deploy time, then exercises the real handlers through
// real Request objects against an in-memory store. No network, no deploy.

import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const F = join(root, 'netlify', 'functions');
mkdirSync(join(F, 'lib'), { recursive: true });
for (const f of ['auth', 'shop', 'orders', 'signups', 'codes']) {
  if (existsSync(join(root, f + '.js'))) copyFileSync(join(root, f + '.js'), join(F, f + '.js'));
}
for (const f of ['session', 'config', 'invites', 'http', 'store', 'notify']) {
  if (existsSync(join(root, f + '.js'))) copyFileSync(join(root, f + '.js'), join(F, 'lib', f + '.js'));
}

const B = F + '/';
const { __setStoreFactory } = await import(B + 'lib/store.js');
const auth = (await import(B + 'auth.js')).default;
const shop = (await import(B + 'shop.js')).default;
const orders = (await import(B + 'orders.js')).default;
const codes = (await import(B + 'codes.js')).default;
const signups = (await import(B + 'signups.js')).default;
const cfgLib = await import(B + 'lib/config.js');

let pass = 0, fail = 0;
const ck = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra).slice(0, 300))); }
};
const section = (s) => console.log('\n— ' + s + ' —');

// A fresh, empty shop for each suite.
let mem;
function reset() {
  mem = new Map();
  __setStoreFactory(() => ({
    async get(k, o) { const v = mem.get(k); if (v === undefined) return null; return o && o.type === 'json' ? JSON.parse(v) : v; },
    async set(k, v) { mem.set(k, String(v)); },
    async setJSON(k, v) { mem.set(k, JSON.stringify(v)); }
  }));
}
const call = async (fn, body, tok) => {
  const h = { 'content-type': 'application/json', 'x-nf-client-connection-ip': '1.1.1.1' };
  if (tok) h.authorization = 'Bearer ' + tok;
  return (await fn(new Request('https://s.test/x', { method: 'POST', headers: h, body: JSON.stringify(body) }))).json();
};

// Boilerplate every suite needs: a claimed shop with one strain on the shelf.
async function openShop(config = {}, product = {}) {
  reset();
  const su = await call(auth, { action: 'setup', pin: '481902', shopName: 'T' });
  await call(shop, {
    action: 'saveConfig',
    config: { shopName: 'T', payments: [{ id: 'zelle', handle: 'x', enabled: true }, { id: 'cash', enabled: true }], ...config }
  }, su.token);
  await call(shop, {
    action: 'saveProduct',
    product: { name: 'Gelato 33', sec: 'Indoors', stock: 500, tiers: [{ label: '3.5g', grams: 3.5, price: 25 }], ...product }
  }, su.token);
  const pid = (await call(shop, { action: 'menu' })).products[0].id;
  const asCustomer = async (name = 'A') => {
    const c = await call(codes, { action: 'issue', name }, su.token);
    return (await call(auth, { action: 'unlock', code: c.code })).token;
  };
  return { token: su.token, pid, asCustomer };
}

// ════════════════════════════════════════════════════════════════════════════
// Store hours are not delivery hours
//
// Two separate schedules that were being conflated. STORE hours decide whether
// the shop takes an order at all — the owner was leaving it open around the
// clock because after a long day he is not thinking about the app, so people
// ordered at 3am expecting an answer. The DELIVERY run is a narrower window
// inside that, for when he is actually driving.
//
// A delivery therefore needs both: the shop open, and the run on. Pickup only
// needs the shop open. Neither setting may silently stand in for the other.
// ════════════════════════════════════════════════════════════════════════════
async function storeHours() {
  section('store hours close the shop on their own');
  const { shopOpen } = cfgLib;
  const at = (iso) => new Date(iso);
  // Friday 6pm–2am, Puerto Rico. 00:00Z is 8pm Friday AST.
  const late = { hours: { on: true, open: '18:00', close: '02:00', days: [5], tz: 'America/Puerto_Rico', paused: false } };
  ck('open during the window', shopOpen(late, at('2026-09-12T00:00:00Z')).open === true);
  ck('a close after midnight still belongs to that night',
    shopOpen(late, at('2026-09-12T05:00:00Z')).open === true);
  ck('shut once the window ends', shopOpen(late, at('2026-09-12T07:00:00Z')).open === false);
  ck('shut on a day it does not open', shopOpen(late, at('2026-09-10T00:00:00Z')).open === false);
  ck('and it says when it opens again', shopOpen(late, at('2026-09-10T00:00:00Z')).opensAt === '18:00');
  ck('paused overrides an open window',
    shopOpen({ hours: { ...late.hours, paused: true } }, at('2026-09-12T00:00:00Z')).open === false);
  ck('hours switched off means always open',
    shopOpen({ hours: { on: false } }, at('2026-09-12T07:00:00Z')).open === true);
  ck('a broken timezone does not take the shop down',
    typeof shopOpen({ hours: { ...late.hours, tz: 'Not/AZone' } }, at('2026-09-12T00:00:00Z')).open === 'boolean');

  section('the shop refuses orders while closed');
  // Closed every day but Sunday, so a Saturday order is out of hours.
  const shut = { hours: { on: true, open: '10:00', close: '12:00', days: [0], tz: 'UTC', paused: false } };
  let s = await openShop(shut);
  let t = await s.asCustomer();
  let r = await call(orders, { action: 'place', items: [{ pid: s.pid, weightIdx: 0, qty: 1 }], mode: 'pickup', pay: 'cash' }, t);
  ck('an order out of hours is refused', r.ok === false, r);
  ck('and the refusal names the opening time', /10:00/.test(r.error || ''), r.error);
  ck('the menu says the shop is shut', (await call(shop, { action: 'menu' })).open === false);

  const openNow = { hours: { on: true, open: '00:00', close: '23:59', days: [0, 1, 2, 3, 4, 5, 6], tz: 'UTC', paused: false } };
  s = await openShop(openNow);
  t = await s.asCustomer();
  r = await call(orders, { action: 'place', items: [{ pid: s.pid, weightIdx: 0, qty: 1 }], mode: 'pickup', pay: 'cash' }, t);
  ck('an order inside hours goes through', r.ok === true, r);
  ck('and the menu says so', (await call(shop, { action: 'menu' })).open === true);

  section('delivery hours are a separate thing again');
  // Shop open all day; delivery run switched OFF.
  s = await openShop({ ...openNow, zones: [{ name: 'Heights', mi: 4 }] });
  const cfg = (await call(shop, { action: 'config' }, s.token)).config;
  const zid = cfg.zones[0].id;
  await call(shop, { action: 'saveConfig', config: { ...cfg, run: { on: false, start: '18:00', end: '21:00', max: 15, zones: [zid] } } }, s.token);
  t = await s.asCustomer();
  r = await call(orders, { action: 'place', items: [{ pid: s.pid, weightIdx: 0, qty: 1 }], mode: 'delivery', zone: zid, pay: 'cash' }, t);
  ck('an open shop with the run off still refuses delivery', r.ok === false, r);
  r = await call(orders, { action: 'place', items: [{ pid: s.pid, weightIdx: 0, qty: 1 }], mode: 'pickup', pay: 'cash' }, t);
  ck('but takes the pickup', r.ok === true, r);

  // Run on, shop shut.
  s = await openShop({ ...shut, zones: [{ name: 'Heights', mi: 4 }] });
  const cfg2 = (await call(shop, { action: 'config' }, s.token)).config;
  const zid2 = cfg2.zones[0].id;
  await call(shop, { action: 'saveConfig', config: { ...cfg2, run: { on: true, start: '00:00', end: '23:59', max: 15, zones: [zid2] } } }, s.token);
  t = await s.asCustomer();
  r = await call(orders, { action: 'place', items: [{ pid: s.pid, weightIdx: 0, qty: 1 }], mode: 'delivery', zone: zid2, pay: 'cash' }, t);
  ck('a shut shop refuses delivery even with the run on', r.ok === false, r);
  ck('and it is the shop that says no, not the run', /closed/i.test(r.error || ''), r.error);
}


// ════════════════════════════════════════════════════════════════════════════
// Cost, and the profit it makes possible
//
// What he paid was living on paper, so the app could report takings and never
// margin. Cost is per gram — the same measure as stock — so a line costs
// cost x grams x qty. It must never reach a customer.
// ════════════════════════════════════════════════════════════════════════════
async function costAndProfit() {
  section('cost and supplier are the owner’s, not the customer’s');
  const s = await openShop({}, { cost: 4, supplier: 'Rico' });
  const mine = (await call(shop, { action: 'config' }, s.token)).products[0];
  ck('cost is stored', mine.cost === 4, mine.cost);
  ck('supplier is stored', mine.supplier === 'Rico', mine.supplier);
  const theirs = (await call(shop, { action: 'menu' })).products[0];
  ck('the menu never carries cost', !('cost' in theirs), Object.keys(theirs));
  ck('nor the supplier', !('supplier' in theirs), Object.keys(theirs));

  section('editing a strain does not wipe what it cost');
  await call(shop, { action: 'saveProduct', product: { id: mine.id, name: 'Gelato 33', sec: 'Indoors', stock: 90, tiers: mine.tiers, cost: 4, supplier: 'Rico' } }, s.token);
  const again = (await call(shop, { action: 'config' }, s.token)).products[0];
  ck('cost survives an edit', again.cost === 4, again.cost);
  ck('and so does the supplier', again.supplier === 'Rico', again.supplier);

  section('no cost recorded is not the same as free');
  const t = await openShop({}, { cost: 0 });
  const nocost = (await call(shop, { action: 'config' }, t.token)).products[0];
  ck('an unpriced strain reads zero, not a guess', nocost.cost === 0, nocost.cost);
}

// ════════════════════════════════════════════════════════════════════════════
// Cash is now; paying up front is what buys a time
// ════════════════════════════════════════════════════════════════════════════
async function pickupTerms() {
  section('cash pickup is ASAP whatever the browser asks for');
  const s = await openShop({ holdMinutes: 30 });
  const buy = async (pay, slot) => {
    const t = await s.asCustomer();
    return (await call(orders, { action: 'place', items: [{ pid: s.pid, weightIdx: 0, qty: 1 }], mode: 'pickup', pay, slot }, t)).order;
  };
  let o = await buy('cash', '8:30pm');
  ck('the slot is forced to ASAP', o.slot === 'ASAP', o.slot);
  ck('and it reads that way on the order', /ASAP/.test(o.where) && !/8:30/.test(o.where), o.where);
  ck('cash keeps the hold clock', o.hold === 30 && o.holdUntil > Date.now(), o.hold);

  section('money already in hand can pick a time');
  o = await buy('zelle', '8:30pm');
  ck('the time is kept', o.slot === '8:30pm', o.slot);
  ck('with no hold clock, because it is paid for', o.hold === null && o.holdUntil === null, o.hold);

  for (const [pay, slot] of [['cash', '6:30pm'], ['zelle', 'ASAP'], ['zelle', '7:30pm']]) {
    const r = await buy(pay, slot);
    ck(pay + ' + ' + slot + ': never both held and timed', !(r.hold && r.slot !== 'ASAP'), { slot: r.slot, hold: r.hold });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Cancel, archive, delete — and money in hand versus money promised
// ════════════════════════════════════════════════════════════════════════════
async function archiveDelete() {
  const s = await openShop({}, { stock: 100, tiers: [{ label: '3.5g', grams: 3.5, price: 25 }, { label: '1 oz', grams: 28, price: 140 }] });
  const t = await s.asCustomer('A');
  await call(orders, { action: 'place', items: [{ pid: s.pid, weightIdx: 1, qty: 1 }], mode: 'pickup', pay: 'cash' }, t);

  section('cancelling returns the stock and says so');
  ck('an ounce left the shelf', (await call(shop, { action: 'menu' })).products[0].stock === 72);
  let list = await call(orders, { action: 'list' }, s.token);
  const oid = list.orders[0].id;
  let r = await call(orders, { action: 'cancel', id: oid }, s.token);
  ck('the refreshed catalogue comes back with it', !!r.products, Object.keys(r));
  ck('and the stock on it is restored', r.products[0].stock === 100, r.products[0].stock);

  section('takings are money in hand, not money promised');
  const t2 = await s.asCustomer('B');
  await call(orders, { action: 'place', items: [{ pid: s.pid, weightIdx: 0, qty: 1 }], mode: 'pickup', pay: 'zelle', slot: 'ASAP' }, t2);
  list = await call(orders, { action: 'list' }, s.token);
  ck('unpaid counts as owed', list.takings.collected === 0 && list.takings.pending === 25, list.takings);
  const unpaid = list.orders.find(o => !o.cancelled).id;
  await call(orders, { action: 'patch', id: unpaid, payOk: true }, s.token);
  list = await call(orders, { action: 'list' }, s.token);
  ck('confirming payment banks it', list.takings.collected === 25 && list.takings.pending === 0, list.takings);

  section('archive keeps the record, delete does not');
  r = await call(orders, { action: 'archive', id: unpaid, archived: true }, s.token);
  ck('archiving flags without deleting', r.orders.find(o => o.id === unpaid).archived === true);
  list = await call(orders, { action: 'list' }, s.token);
  ck('an archived order still counts in takings', list.takings.collected === 25, list.takings);
  const before = (await call(shop, { action: 'menu' })).products[0].stock;
  r = await call(orders, { action: 'remove', id: oid }, s.token);
  ck('deleting an already-cancelled order removes it', !r.orders.some(o => o.id === oid));
  ck('without crediting the same goods twice', r.products[0].stock === before, { before, after: r.products[0].stock });
  r = await call(orders, { action: 'remove', id: 'nope' }, s.token);
  ck('deleting something gone is refused cleanly', r.ok === false, r);

  section('codes can be deleted, not only revoked');
  const c = await call(codes, { action: 'issue', name: 'Gone' }, s.token);
  const n = (await call(codes, { action: 'list' }, s.token)).codes.length;
  r = await call(codes, { action: 'revoke', code: c.code, active: false }, s.token);
  ck('revoking keeps the row', r.codes.length === n && r.codes.find(x => x.code === c.code).active === false);
  r = await call(codes, { action: 'remove', code: c.code }, s.token);
  ck('deleting removes it outright', r.codes.length === n - 1 && !r.codes.some(x => x.code === c.code));
  ck('and a deleted code no longer opens the door',
    (await call(auth, { action: 'unlock', code: c.code })).ok === false);
}

// ════════════════════════════════════════════════════════════════════════════
// Alerts actually leave the machine
//
// These do not check that send was CALLED — they check it had FINISHED by the
// time the handler returned. Alerts were fired and forgotten, and Lambda
// freezes the instant a response is returned, so the POST to Telegram was
// started and dropped. The stubbed fetch below resolves on a timer: anything
// not awaited is still in flight when the response lands.
// ════════════════════════════════════════════════════════════════════════════
async function alerts() {
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_CHAT_ID = '123456';
  const delivered = [];
  let inFlight = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes('api.telegram.org')) throw new Error('unexpected host: ' + url);
    inFlight++;
    await new Promise(r => setTimeout(r, 30));
    inFlight--;
    delivered.push(JSON.parse(opts.body).text);
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const during = async (fn) => { const from = delivered.length; await fn(); return delivered.slice(from); };
  const sent = (msgs, re) => msgs.some(m => re.test(m));

  const s = await openShop({}, { stock: 40 });
  section('nothing is left in flight when a handler returns');
  let msgs = await during(() => call(codes, { action: 'issue', name: 'Ana' }, s.token));
  ck('a code being issued alerts before the response', sent(msgs, /CODE ISSUED/), msgs);
  ck('and no request is still hanging', inFlight === 0, inFlight);

  section('the order alert, which is the one that was broken');
  const t = await s.asCustomer();
  msgs = await during(() => call(orders, { action: 'place', items: [{ pid: s.pid, weightIdx: 0, qty: 1 }], mode: 'pickup', pay: 'cash' }, t));
  ck('THE ORDER ALERT ARRIVES', sent(msgs, /NEW ORDER/), msgs);
  ck('with the total on it', sent(msgs, /\$25/), msgs);

  section('stock warnings, and the events that had no alert at all');
  const t3 = await s.asCustomer();
  await call(orders, { action: 'place', items: [{ pid: s.pid, weightIdx: 0, qty: 1 }], mode: 'pickup', pay: 'cash' }, t3);
  const t4 = await s.asCustomer();
  msgs = await during(() => call(orders, { action: 'place', items: [{ pid: s.pid, weightIdx: 0, qty: 8 }], mode: 'pickup', pay: 'cash' }, t4));
  ck('running low or out is flagged', sent(msgs, /LOW STOCK|SOLD OUT/), msgs);

  const live = (await call(orders, { action: 'list' }, s.token)).orders.find(o => !o.cancelled);
  msgs = await during(() => call(orders, { action: 'patch', id: live.id, payOk: true }, s.token));
  ck('confirming a payment alerts', sent(msgs, /PAYMENT CONFIRMED/), msgs);
  msgs = await during(() => call(orders, { action: 'patch', id: live.id, payOk: true }, s.token));
  ck('confirming twice does not alert twice', msgs.length === 0, msgs);
  msgs = await during(() => call(orders, { action: 'cancel', id: live.id }, s.token));
  ck('cancelling alerts', sent(msgs, /ORDER CANCELLED/), msgs);
  msgs = await during(() => call(orders, { action: 'remove', id: live.id }, s.token));
  ck('deleting alerts', sent(msgs, /ORDER DELETED/), msgs);

  section('with Telegram switched off, everything still works');
  delete process.env.TELEGRAM_BOT_TOKEN;
  const quiet = await during(() => call(codes, { action: 'issue', name: 'Nobody' }, s.token));
  ck('no alert is attempted', quiet.length === 0, quiet);
  ck('and the action still succeeded',
    (await call(codes, { action: 'list' }, s.token)).codes.some(x => x.name === 'Nobody'));
  globalThis.fetch = realFetch;
  delete process.env.TELEGRAM_CHAT_ID;
}

// ════════════════════════════════════════════════════════════════════════════
// What a customer has actually bought
//
// The Codes screen showed `uses` — how many times a code was typed into the
// lock screen — under the heading "Orders". Sessions last weeks, so a customer
// with four orders read as one.
// ════════════════════════════════════════════════════════════════════════════
async function customerHistory() {
  const s = await openShop({}, { stock: 900 });
  const c1 = await call(codes, { action: 'issue', name: 'papant' }, s.token);
  const t1 = (await call(auth, { action: 'unlock', code: c1.code })).token;
  for (let i = 0; i < 4; i++) {
    await call(orders, { action: 'place', items: [{ pid: s.pid, weightIdx: 0, qty: 1 }], mode: 'pickup', pay: 'cash' }, t1);
  }
  const row = async (code) => (await call(codes, { action: 'list' }, s.token)).codes.find(c => c.code === code);

  section('four orders from one sign-in');
  let r = await row(c1.code);
  ck('all four are counted', r.orders === 4, { orders: r.orders, uses: r.uses });
  ck('and it is not just counting sign-ins', r.uses === 1 && r.orders !== r.uses, { uses: r.uses, orders: r.orders });
  ck('with what they spent', r.spent === 100, r.spent);
  ck('and when they last bought', !!r.lastOrder, r.lastOrder);

  section('archiving tidies the queue; cancelling undoes the sale');
  const list = (await call(orders, { action: 'list' }, s.token)).orders.filter(o => o.clientCode === c1.code);
  await call(orders, { action: 'archive', id: list[0].id, archived: true }, s.token);
  r = await row(c1.code);
  ck('an archived order still counts', r.orders === 4 && r.spent === 100, { orders: r.orders, spent: r.spent });
  await call(orders, { action: 'cancel', id: list[1].id }, s.token);
  r = await row(c1.code);
  ck('a cancelled one stops counting', r.orders === 3 && r.spent === 75, { orders: r.orders, spent: r.spent });
  await call(orders, { action: 'remove', id: list[2].id }, s.token);
  r = await row(c1.code);
  ck('and so does a deleted one', r.orders === 2 && r.spent === 50, { orders: r.orders, spent: r.spent });

  section('customers are counted separately');
  const c2 = await call(codes, { action: 'issue', name: 'Tito' }, s.token);
  const t2 = (await call(auth, { action: 'unlock', code: c2.code })).token;
  await call(orders, { action: 'place', items: [{ pid: s.pid, weightIdx: 0, qty: 1 }], mode: 'pickup', pay: 'cash' }, t2);
  ck('the new customer has one', (await row(c2.code)).orders === 1);
  ck('and the first is untouched', (await row(c1.code)).orders === 2);
  const fresh = await call(codes, { action: 'issue', name: 'Nobody' }, s.token);
  const never = await row(fresh.code);
  ck('someone who never ordered reads zero', never.orders === 0 && never.lastOrder === '', never);
  ck('the figures come back on every codes response',
    fresh.codes.find(c => c.code === c1.code).orders === 2);
}

// ════════════════════════════════════════════════════════════════════════════
// The storage diagnostic, and what it may not say
//
// GET .../auth?diag=1 separates a store that cannot be opened from a reachable
// one holding an unreadable record — they look identical from outside and need
// opposite responses. It has no authentication, because signing in is one of
// the things that breaks, so it must never emit a stored value.
// ════════════════════════════════════════════════════════════════════════════
async function diagnose() {
  const diag = async () => (await auth(new Request('https://s.test/.netlify/functions/auth?diag=1'))).json();

  section('a reachable store with one corrupt record');
  reset();
  mem.set('config', '{"shopName":"Mafuteros","phone":"8135550100","setup');
  mem.set('products', '[]');
  let d = await diag();
  ck('the store opens and the probe passes', d.opened === true && d.probe === 'ok', d.probe);
  const cfg = d.keys.find(k => k.key === 'config');
  ck('the broken record is named', cfg && cfg.readable === false, cfg);
  ck('and says it is a JSON problem, not an outage', /not valid JSON/.test(cfg.error || ''), cfg.error);
  ck('healthy records are marked readable', d.keys.find(k => k.key === 'products').readable === true);

  section('it never leaks what is in the records');
  const dump = JSON.stringify(d);
  ck('no shop name', !dump.includes('Mafuteros'));
  ck('no phone number', !dump.includes('8135550100'));
  ck('sizes are reported, not contents', typeof cfg.bytes === 'number' && cfg.bytes > 0, cfg.bytes);

  section('a store that cannot be opened at all');
  __setStoreFactory(() => { throw new Error('The environment has not been configured to use Netlify Blobs'); });
  d = await diag();
  ck('reports it could not open', d.opened === false, d);
  ck('and passes the real reason through', /not been configured/.test(d.probe || ''), d.probe);
  ck('without inventing key results', d.keys.length === 0, d.keys);

  section('GET-only, and the API is undisturbed');
  reset();
  mem.set('config', '{}');
  const post = await call(auth, { action: 'status' });
  ck('POST still routes normally', post.ok === true && post.backend === true, post);
  ck('a GET without ?diag is refused',
    (await auth(new Request('https://s.test/.netlify/functions/auth'))).status === 405);
}

// ════════════════════════════════════════════════════════════════════════════
// The view layer, without a browser
//
// Pulls the logic out of index.html, runs renderVals() across the app's states
// in both languages, and asserts every {{ binding }} the template asks for
// actually gets a value. A missing one renders as a grey placeholder on
// somebody's phone.
//
// It also guards the failure that has now shipped three times: a single-braced
// interpolation. `{ x }` is not a binding — it is invalid CSS the browser
// discards, leaving the element at its default, with no error anywhere. That
// left the archive toggle dead, the delivery-run panel permanently visible,
// and "View archived" showing on shops with nothing archived.
// ════════════════════════════════════════════════════════════════════════════
async function viewLayer() {
  const { readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const template = html.slice(html.indexOf('<x-dc>'), html.indexOf('</x-dc>'));
  const script = /<script type="text\/x-dc" data-dc-script>([\s\S]*?)<\/script>/.exec(html)[1];

  section('nothing is half-bound');
  const halfBound = template.match(/(?<!\{)\{\s*[a-zA-Z_$][\w$.]*\s*\}(?!\})/g) || [];
  ck('every interpolation uses double braces', halfBound.length === 0, halfBound);

  const loopVars = new Set([...template.matchAll(/as="([A-Za-z0-9_]+)"/g)].map(m => m[1]));
  const wanted = new Set();
  for (const m of template.matchAll(/\{\{([^}]*)\}\}/g)) {
    const head = m[1].trim().split('.')[0].split('(')[0].trim();
    if (head && !/^\d/.test(head) && head !== 'true' && head !== 'false') wanted.add(head);
  }
  for (const v of loopVars) wanted.delete(v);
  const loopFields = {};
  for (const m of template.matchAll(/<sc-for list="\{\{\s*([A-Za-z0-9_.]+)\s*\}\}"\s+as="([A-Za-z0-9_]+)"([\s\S]*?)<\/sc-for>/g)) {
    const [, list, as, bodyText] = m;
    const fields = new Set();
    for (const f of bodyText.matchAll(new RegExp('\\{\\{\\s*' + as + '\\.([A-Za-z0-9_]+)', 'g'))) fields.add(f[1]);
    const key = list.split('.').pop();
    loopFields[key] = new Set([...(loopFields[key] || []), ...fields]);
  }

  class DCLogic {
    constructor() { this.props = {}; }
    setState(patch) { Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch); }
  }
  const sandbox = {
    DCLogic, console,
    location: { protocol: 'https:', origin: 'https://s.test', pathname: '/', href: 'https://s.test/' },
    navigator: {},
    document: { createElement: () => ({ style: {}, setAttribute() {} }), body: { appendChild() {}, removeChild() {} } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true }) }),
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Promise, Error, isNaN, Set, Map, Intl
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(script + '\n;globalThis.__Component = Component;', sandbox);
  const Component = sandbox.__Component;

  const ago = (days, hour = 20) => {
    const d = new Date(Date.now() - days * 86400000);
    d.setHours(hour, 15, 0, 0);
    return d.toISOString();
  };
  const CFG = {
    shopName: 'S', pickupNote: 'n', contact: 'c',
    payments: [
      { id: 'zelle', label: 'Zelle', handle: 'h', fast: true },
      { id: 'cash', label: 'Cash', labelEs: 'Efectivo', handle: '', fast: false }
    ],
    zones: [{ id: 'z1', name: 'Heights', mi: 5 }],
    run: { on: true, start: '18:00', end: '21:00', max: 15, zones: ['z1'] },
    fees: { freeMiles: 5, midMiles: 10, midFee: 5, farBase: 6, farStepMiles: 5, farStepFee: 1 },
    hours: { on: true, open: '12:00', close: '23:00', days: [0, 1, 2, 3, 4, 5, 6], paused: false },
    holdMinutes: 30, setupComplete: true
  };
  const prod = (id, name, cost, stock) => ({
    id, name, sec: 'Indoors', type: 'Hybrid', thc: '22%', cbd: '—', bg: '#ffc6a5',
    notes: 'n', effects: [], unit: 'g', supplier: 'Rico', cost, stock, active: true, at: ago(30),
    tiers: [{ label: '3.5g', grams: 3.5, price: 25 }, { label: '1 oz', grams: 28, price: 140 }],
    foot: ''
  });
  const ord = (id, no, days, step, payOk, label, grams, price) => ({
    id, no, client: 'papant', clientCode: '4417', at: ago(days), mode: 'pickup',
    pay: 'cash', payLabel: 'Cash', payOk, hold: 30, holdUntil: null, slot: 'ASAP',
    zone: '', where: 'Pickup ASAP',
    items: [{ pid: 'p1', name: 'Gelato 33', label, unit: price, grams, qty: 1, line: '1x Gelato 33', price: '$' + price }],
    subtotal: price, fee: 0, total: '$' + price, step, cancelled: false
  });
  const PRODUCTS = [prod('p1', 'Gelato 33', 4, 19), prod('p2', 'Jelly donut', 0, 140)];
  const ORDERS = [
    ord('o1', '#1001', 0, 3, true, '3.5g', 3.5, 25),
    ord('o2', '#1002', 1, 3, true, '1 oz', 28, 140),
    ord('o3', '#1003', 2, 1, false, '3.5g', 3.5, 25),
    ord('o4', '#1004', 9, 3, true, '3.5g', 3.5, 25),
    ord('o5', '#1005', 20, 3, true, '3.5g', 3.5, 25)
  ];
  const CODES = [{
    id: 'c1', name: 'papant', code: '4417', active: true, uses: 1,
    phone: '813-555-0100', orders: 4, spent: 215, lastOrder: ago(20)
  }];
  const owner = (extra) => (s) => Object.assign(s, {
    role: 'owner', backend: 'ready', cfg: CFG, products: PRODUCTS, orders: ORDERS,
    codes: CODES, signups: [], takings: { collected: 25, pending: 25, count: 1 }
  }, extra);
  const scenarios = {
    'dash / today': owner({ screen: 'dash', window: 'today' }),
    'dash / week': owner({ screen: 'dash', window: 'week' }),
    'dash / month': owner({ screen: 'dash', window: 'month' }),
    'dash / nothing yet': (s) => Object.assign(s, { screen: 'dash', role: 'owner', backend: 'ready', cfg: CFG, products: [], orders: [], codes: [], takings: null }),
    'queue': owner({ screen: 'queue' }),
    'queue / archived': owner({ screen: 'queue', showArchived: true }),
    'stock': owner({ screen: 'inv' }),
    'stock / adding': owner({ screen: 'inv', showAdd: true }),
    'codes': owner({ screen: 'codes' }),
    'settings': owner({ screen: 'settings', telegram: true }),
    'menu / open': (s) => Object.assign(s, { screen: 'home', role: 'client', backend: 'ready', cfg: CFG, products: PRODUCTS, shopOpen: true }),
    'menu / shut': (s) => Object.assign(s, { screen: 'home', role: 'client', backend: 'ready', cfg: CFG, products: PRODUCTS, shopOpen: false, opensAt: '12:00' }),
    'bag / cash': (s) => Object.assign(s, { screen: 'bag', role: 'client', backend: 'ready', cfg: CFG, products: PRODUCTS, pay: 'cash', mode: 'pickup', cart: [{ pid: 'p1', name: 'Gelato 33', label: '3.5g', price: 25, grams: 3.5, qty: 1, weightIdx: 0, bg: '#ffc6a5', initials: 'G3' }] }),
    'bag / prepaid': (s) => Object.assign(s, { screen: 'bag', role: 'client', backend: 'ready', cfg: CFG, products: PRODUCTS, pay: 'zelle', mode: 'pickup', cart: [{ pid: 'p1', name: 'Gelato 33', label: '3.5g', price: 25, grams: 3.5, qty: 1, weightIdx: 0, bg: '#ffc6a5', initials: 'G3' }] }),
    'first run': (s) => Object.assign(s, { screen: 'setup', backend: 'setup', needsSetupCode: true, setup: { shopName: '', setupCode: '', pin: '481902', pin2: '', stage: 'confirm', err: '' } }),
    'backend down': (s) => Object.assign(s, { screen: 'down', backend: 'down', fatal: 'nope' })
  };

  section('every binding resolves, in both languages');
  for (const lang of ['es', 'en']) {
    for (const [name, mutate] of Object.entries(scenarios)) {
      let vals;
      const c = new Component();
      c.state = JSON.parse(JSON.stringify(c.state));
      try { mutate(c.state); c.state.lang = lang; vals = c.renderVals(); }
      catch (err) { ck(lang + ' / ' + name + ': renders', false, err.message); continue; }
      const missing = [...wanted].filter(k => !(k in vals));
      ck(lang + ' / ' + name, missing.length === 0, missing);
      const rowProblems = [];
      for (const [list, fields] of Object.entries(loopFields)) {
        const rows = vals[list];
        if (!Array.isArray(rows) || !rows.length) continue;
        for (const f of fields) if (!(f in rows[0])) rowProblems.push(list + '.' + f);
      }
      if (rowProblems.length) ck(lang + ' / ' + name + ': loop rows', false, rowProblems);
    }
  }

  section('the dashboard reads the month back correctly');
  const c = new Component();
  c.state = JSON.parse(JSON.stringify(c.state));
  scenarios['dash / month'](c.state);
  c.state.lang = 'en';
  const v = c.renderVals();
  // Banked: o1 3.5g, o2 28g, o4 3.5g, o5 3.5g = 38.5g at $4 = $154 of goods
  // against $215 taken. o3 is unpaid and must not appear in either.
  ck('takings cover the window', v.takenToday === '$215', v.takenToday);
  ck('profit is takings minus what the goods cost', v.profitValue === '$61', v.profitValue);
  ck('payment mix is scoped to the window too', v.payMix.length === 1 && v.payMix[0].value === '$215', v.payMix);
  ck('the unpaid order shows under who owes', v.owedRows.length === 1 && v.owedRows[0].amount === '$25', v.owedRows);
  ck('a strain with no cost is called out rather than counted as margin',
    /Jelly donut/.test(v.costGapNote) || v.costGapNote === '', v.costGapNote);
  ck('re-up works from the pace it is actually selling at',
    v.reupRows.length === 1 && /days left/.test(v.reupRows[0].days), v.reupRows);
  ck('and names who to get it from', /Rico/.test(v.reupRows[0].from), v.reupRows[0].from);
  ck('a regular gone quiet is listed', v.quietRows.length === 1 && v.quietRows[0].name === 'papant', v.quietRows);
  ck('dead stock is listed', v.deadRows.some(r => r.name === 'Jelly donut'), v.deadRows);
  ck('sizes add up to the whole', v.sizeRows.length === 2, v.sizeRows);

  section('a quiet shop shows a short screen, not a wall of zeroes');
  const q = new Component();
  q.state = JSON.parse(JSON.stringify(q.state));
  scenarios['dash / nothing yet'](q.state);
  q.state.lang = 'en';
  const qv = q.renderVals();
  ck('no owed block', qv.owedDisplay === 'none', qv.owedDisplay);
  ck('no re-up block', qv.reupDisplay === 'none', qv.reupDisplay);
  ck('no gone-quiet block', qv.quietDisplay === 'none', qv.quietDisplay);
  ck('no dead-stock block', qv.deadDisplay === 'none', qv.deadDisplay);
  ck('patterns stay hidden until there is enough trading', qv.patternsDisplay === 'none', qv.patternsDisplay);

  section('no demo residue, no numbers typed into the markup');
  const banned = [
    ['badgeDemo', /badgeDemo/],
    ['a hardcoded Zelle handle', /656\)\s*247-1884/],
    ['seeded strain names', /Frosted Bananas|Packman|Slurricane|Candy Fumes/],
    ['a frozen "now"', /new Date\(2026/],
    ['prototype start props', /startInOwnerView|startUnlocked/],
    ['demo backend state', /backend:\s*'demo'/]
  ];
  for (const [what, re] of banned) ck('index.html has no ' + what, !re.test(html));
  const literals = template.replace(/<[^>]+>/g, ' ').split(' ')
    .map(x => x.trim())
    .filter(x => x && !x.includes('{{'))
    .filter(x => /\$[\d,]+|\b\d{2,}\b|\b\d+\s*(oz|g|mi|min)\b/.test(x))
    .filter(x => x !== '00:00');
  ck('no figures typed straight into the markup', literals.length === 0, literals);
}

// ════════════════════════════════════════════════════════════════════════════
// Ids are unique, including within the same millisecond
//
// Records were identified by `prefix + Date.now().toString(36)`, so two created
// in the same millisecond shared an id. Orders made that silently destructive:
// cancelling one cancelled its twin, deleting one deleted both, and only one of
// the pair ever had its stock returned — so stock and takings drifted away from
// reality with nothing on screen to explain it.
//
// This is the shape of the bug that found it: four orders in a tight loop, then
// cancel exactly one.
// ════════════════════════════════════════════════════════════════════════════
async function uniqueIds() {
  section('ids do not collide');
  const s = await openShop({}, { stock: 900 });
  const t = await s.asCustomer('papant');
  for (let i = 0; i < 8; i++) {
    await call(orders, { action: 'place', items: [{ pid: s.pid, weightIdx: 0, qty: 1 }], mode: 'pickup', pay: 'cash' }, t);
  }
  const all = (await call(orders, { action: 'list' }, s.token)).orders;
  const ids = all.map(o => o.id);
  ck('eight orders placed back to back all have their own id',
    new Set(ids).size === ids.length, ids);

  section('so cancelling one order cancels one order');
  const target = all[3];
  await call(orders, { action: 'cancel', id: target.id }, s.token);
  const after = (await call(orders, { action: 'list' }, s.token)).orders;
  ck('exactly one is cancelled', after.filter(o => o.cancelled).length === 1,
    after.filter(o => o.cancelled).map(o => o.no));
  ck('and it is the one that was asked for',
    after.find(o => o.id === target.id).cancelled === true);
  ck('the goods come back once, not twice or not at all',
    (await call(shop, { action: 'menu' })).products[0].stock === 900 - 3.5 * 7,
    (await call(shop, { action: 'menu' })).products[0].stock);

  section('and deleting one deletes one');
  const live = after.find(o => !o.cancelled);
  await call(orders, { action: 'remove', id: live.id }, s.token);
  const left = (await call(orders, { action: 'list' }, s.token)).orders;
  ck('one fewer order, not two', left.length === after.length - 1, { before: after.length, after: left.length });

  section('the same for codes, products and signups');
  const issued = [];
  for (let i = 0; i < 6; i++) issued.push((await call(codes, { action: 'issue', name: 'C' + i }, s.token)).code);
  const rows = (await call(codes, { action: 'list' }, s.token)).codes;
  ck('every code row has its own id', new Set(rows.map(c => c.id)).size === rows.length, rows.map(c => c.id));
  ck('and its own code', new Set(issued).size === issued.length, issued);
  for (let i = 0; i < 4; i++) {
    await call(shop, { action: 'saveProduct', product: { name: 'Strain ' + i, sec: 'Indoors', stock: 10, tiers: [{ label: '3.5g', grams: 3.5, price: 25 }] } }, s.token);
  }
  const prods = (await call(shop, { action: 'config' }, s.token)).products;
  ck('every product has its own id', new Set(prods.map(p => p.id)).size === prods.length, prods.map(p => p.id));
}

// ════════════════════════════════════════════════════════════════════════════
for (const suite of [storeHours, costAndProfit, pickupTerms, archiveDelete, alerts, customerHistory, uniqueIds, diagnose, viewLayer]) {
  await suite();
}
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
