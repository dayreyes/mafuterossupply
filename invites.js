// Customer access codes.
//
// These are door keys, so they come from crypto.randomInt rather than
// Math.random — a Math.random sequence is reconstructable from a couple of
// observed codes, which for a shop that hands out codes one at a time is a
// realistic way to guess the next one.

import { randomInt } from 'node:crypto';
import { read, mutate, KEYS } from './store.js';
import { str } from './http.js';
import { CLIENT_CODE_LEN } from './session.js';

export const genCode = () =>
  String(randomInt(0, 10 ** CLIENT_CODE_LEN)).padStart(CLIENT_CODE_LEN, '0');

// Mints a unique, active code and returns it with the updated list.
// Keeps the customer's phone and address alongside the code.
//
// Approving used to delete the signup request and store the name alone, which
// left the owner with a delivery run and nowhere to drive to. This is a
// delivery shop: the address IS the record.
export async function mintCode(name, contact = {}) {
  let code = '';
  const codes = await mutate(KEYS.codes, [], (list) => {
    do { code = genCode(); } while (list.some((c) => c.code === code));
    return [{
      id: 'c' + Date.now().toString(36),
      name: str(name, 60),
      phone: str(contact.phone, 32),
      addr: str(contact.addr, 160),
      age: Number.isFinite(Number(contact.age)) ? Number(contact.age) : null,
      code,
      active: true,
      uses: 0,
      issued: new Date().toISOString()
    }].concat(list);
  });
  return { code, codes };
}

// What a customer has actually bought, counted from the orders themselves.
//
// The Codes screen showed `uses` under the heading "Orders". `uses` counts how
// many times a code was typed into the lock screen — and sessions last weeks,
// so a regular signs in once and then orders from the same session for a month.
// Somebody with four orders sat there reading "Orders: 1", which made the whole
// screen useless for telling a regular from a stranger.
//
// Counted fresh from the order list on every read rather than kept as a running
// tally on the code, because a tally drifts: delete an order, archive one, and
// a counter that was incremented at checkout is quietly wrong forever with
// nothing to reconcile it against.
//
// Cancelled orders are left out — the sale did not happen — while archived ones
// count, since archiving only tidies the queue.
export async function withHistory(codes) {
  const orders = await read(KEYS.orders, []);
  const byCode = new Map();
  for (const o of orders) {
    if (!o.clientCode || o.cancelled) continue;
    const row = byCode.get(o.clientCode) || { orders: 0, spent: 0, lastOrder: '' };
    row.orders += 1;
    row.spent += (o.subtotal || 0) + (o.fee || 0);
    if (!row.lastOrder || String(o.at) > row.lastOrder) row.lastOrder = String(o.at || '');
    byCode.set(o.clientCode, row);
  }
  return codes.map((c) => ({
    ...c,
    ...(byCode.get(c.code) || { orders: 0, spent: 0, lastOrder: '' })
  }));
}
