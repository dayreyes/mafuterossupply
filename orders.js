// Orders.
//
// The important rule here: the SERVER prices the order. The old demo let the
// browser compute the total and post it, which means a customer could have
// bought an ounce for $1 by editing one number. The client now sends only what
// it picked — product id, weight index, quantity — and every dollar comes back
// out of the stored catalogue.
//
// Actions: place · mine · list · advance · stepBack · patch · cancel ·
//          archive · remove

import { route, ok, fail, unauthorized, str, num } from './lib/http.js';
import { read, write, mutate, KEYS } from './lib/store.js';
import { requireOwner, requireClient } from './lib/session.js';
import { defaultConfig, mileFee, migrateProduct } from './lib/config.js';
import { sendAsync, orderText, lowStockText } from './lib/notify.js';

const money = (n) => '$' + Number(n).toLocaleString('en-US');
const today = () => new Date().toISOString().slice(0, 10);

// "Low" means something different per unit: three grams of flower is almost
// gone, three carts is a normal shelf.
const lowStockAt = (unit) => (unit === 'ea' ? 3 : 7);

// Money in hand, as opposed to money promised.
//
// The dashboard used to count every order that had not been cancelled, so an
// order sitting unpaid in the queue was already reported as cash taken. An app
// payment counts once the owner confirms it landed; a cash order counts once it
// has actually been handed over.
const collected = (o) => !o.cancelled && (o.payOk === true || (o.step || 0) >= 3);
const pending = (o) => !o.cancelled && !collected(o);
const fmtStock = (n, unit) => (unit === 'ea' ? String(n) : (Math.round(n * 10) / 10) + 'g');

// Delivery capacity is derived from the orders actually taken today rather than
// a counter someone has to remember to reset.
const stopsToday = (orders) =>
  orders.filter((o) => o.mode === 'delivery' && !o.cancelled && String(o.at || '').slice(0, 10) === today()).length;

// Today's delivery run, grouped so he drives one area at a time.
//
// Orders arrive in the sequence they were placed, which sends him back and
// forth across town. Stops are grouped by area and the areas ordered by
// distance, nearest first, so a run is one outward sweep rather than a
// zigzag. Within an area the original order is kept, which roughly follows
// the promised time slots.
//
// Deliberately not a real route optimiser: that needs a maps API, a paid key,
// and every customer's home address handed to a third party. Grouping by area
// removes the crossing-town problem, which is the expensive part.
function buildRun(orders, cfg) {
  const day = today();
  const live = orders.filter((o) =>
    o.mode === 'delivery' && !o.cancelled && !o.archived && (o.step || 0) < 3 &&
    String(o.at || '').slice(0, 10) === day);

  const zones = cfg.zones || [];
  const byZone = new Map();
  for (const o of live) {
    const zone = zones.find((z) => z.id === o.zone);
    const key = zone ? zone.id : '__none';
    if (!byZone.has(key)) {
      byZone.set(key, { id: key, name: zone ? zone.name : '—', mi: zone ? zone.mi : 9999, stops: [] });
    }
    byZone.get(key).stops.push({
      id: o.id, no: o.no, client: o.client, addr: o.addr || '', phone: o.phone || '',
      slot: o.slot || '', total: o.total, step: o.step || 0,
      paid: o.payOk === true, payLabel: o.payLabel || ''
    });
  }

  const legs = [...byZone.values()].sort((a, b) => a.mi - b.mi);
  legs.forEach((leg) => leg.stops.reverse());  // oldest order first within an area
  return { legs, stops: live.length, miles: legs.length ? Math.max(...legs.map((l) => l.mi)) : 0 };
}

// Everything the owner's screen derives from the order list: the queue, the
// run, today's capacity and today's money.
//
// Every action that touches an order returns this whole picture, because every
// one of them can move more than the order itself — confirming a payment moves
// the day's takings, finishing a delivery removes a stop from the run. The
// screen used to get back only the order list, so those numbers sat wrong until
// something else forced a reload.
async function snapshot(orders) {
  const cfg = await read(KEYS.config, defaultConfig());
  const day = today();
  const todays = orders.filter((o) => String(o.at || '').slice(0, 10) === day);
  return {
    orders: orders.slice(0, 300),
    stops: stopsToday(orders),
    max: cfg.run.max,
    run: buildRun(orders, cfg),
    // Split deliberately: what is banked, and what is still owed.
    takings: {
      collected: todays.filter(collected).reduce((a, o) => a + (o.subtotal || 0) + (o.fee || 0), 0),
      pending: todays.filter(pending).reduce((a, o) => a + (o.subtotal || 0) + (o.fee || 0), 0),
      count: todays.filter(collected).length
    }
  };
}

// Puts an order's goods back on the shelf. Used by both cancelling and
// deleting, so the two can never drift apart.
async function returnStock(items) {
  if (!items || !items.length) return read(KEYS.products, []);
  return mutate(KEYS.products, [], (list) =>
    list.map(migrateProduct).map((p) => {
      const back = items.filter((l) => l.pid === p.id)
        .reduce((a, l) => a + (l.grams != null ? l.grams * l.qty : l.qty), 0);
      return back ? { ...p, stock: (p.stock || 0) + back } : p;
    })
  );
}

export default async (req) => route(req, {

  async place(body, req) {
    const session = await requireClient(req);
    if (!session) return unauthorized('Your session expired — enter your code again.');

    const cfg = await read(KEYS.config, defaultConfig());
    if (!cfg.setupComplete) return fail('This shop is not open yet.');

    const products = (await read(KEYS.products, [])).map(migrateProduct);
    const lines = Array.isArray(body.items) ? body.items.slice(0, 40) : [];
    if (!lines.length) return fail('Your bag is empty.');

    // Price every line from the catalogue, and refuse anything out of stock.
    const priced = [];
    let subtotal = 0;
    // Stock is held in grams (or whole carts for vapes), so a line takes
    // tier.grams x qty off the shelf — an ounce removes 28, not 1. Totals per
    // product are summed first, so 3.5g + 1g of the same strain is checked as
    // 4.5g against what is actually there.
    const needed = {};
    for (const raw of lines) {
      const p = products.find((x) => x.id === str(raw.pid, 40) && x.active);
      if (!p) return fail('Something in your bag is no longer available.');
      const tIdx = num(raw.weightIdx, 0, p.tiers.length - 1, 0);
      const qty = num(raw.qty, 1, 99, 1);
      const tier = p.tiers[tIdx];
      needed[p.id] = (needed[p.id] || 0) + tier.grams * qty;
      if ((p.stock || 0) < needed[p.id]) {
        return fail(p.name + ' only has ' + fmtStock(p.stock || 0, p.unit) + ' left.');
      }
      subtotal += tier.price * qty;
      priced.push({
        pid: p.id, name: p.name, label: tier.label, unit: tier.price,
        grams: tier.grams, qty,
        line: qty + '× ' + p.name + ' · ' + tier.label,
        price: money(tier.price * qty)
      });
    }

    const mode = body.mode === 'delivery' ? 'delivery' : 'pickup';
    const payment = cfg.payments.find((x) => x.id === str(body.pay, 24) && x.enabled);
    if (!payment) return fail('Pick a payment method.');

    const orders = await read(KEYS.orders, []);
    let fee = 0;
    let where = '';
    let zoneId = '';
    const slot = str(body.slot, 40);

    if (mode === 'delivery') {
      if (!cfg.run.on) return fail('Delivery is off today.');
      if (stopsToday(orders) >= cfg.run.max) return fail('Delivery is full today — pickup only.');
      const zone = cfg.zones.find((z) => z.id === str(body.zone, 24) && cfg.run.zones.includes(z.id));
      if (!zone) return fail('Pick a delivery area.');
      zoneId = zone.id;
      fee = mileFee(zone.mi, cfg.fees);
      where = zone.name + (slot ? ' · ' + slot : '');
    } else {
      where = 'Pickup' + (slot ? ' ' + slot : '');
    }

    // Snapshot the customer's contact details onto the order. The owner needs
    // them in hand to actually drive the run, and a later change of address
    // must not rewrite where an earlier order was sent.
    const customer = (await read(KEYS.codes, [])).find((x) => x.code === session.code) || {};

    const hold = mode === 'pickup' && !payment.fast ? cfg.holdMinutes : null;
    const counters = await read(KEYS.counters, { orderSeq: 1000 });
    const seq = (counters.orderSeq || 1000) + 1;
    await write(KEYS.counters, { ...counters, orderSeq: seq });

    const order = {
      id: 'o' + Date.now().toString(36),
      no: '#' + seq,
      client: session.name || customer.name || 'Customer',
      clientCode: session.code || '',
      phone: customer.phone || '',
      addr: mode === 'delivery' ? (customer.addr || '') : '',
      at: new Date().toISOString(),
      mode,
      pay: payment.id,
      payLabel: payment.label,
      payOk: false,
      hold,
      holdUntil: hold ? Date.now() + hold * 60 * 1000 : null,
      slot,
      zone: zoneId,
      where,
      items: priced,
      subtotal,
      fee,
      total: money(subtotal + fee),
      step: 0,
      cancelled: false
    };

    await mutate(KEYS.orders, [], (list) => [order].concat(list).slice(0, 2000));

    // Commit the stock only once the order is safely stored.
    const low = [];
    await mutate(KEYS.products, [], (list) =>
      list.map(migrateProduct).map((p) => {
        const taken = needed[p.id] || 0;
        if (!taken) return p;
        const left = Math.max(0, (p.stock || 0) - taken);
        if (left <= lowStockAt(p.unit)) low.push({ name: p.name, left: fmtStock(left, p.unit) });
        return { ...p, stock: left };
      })
    );

    sendAsync(orderText({ ...order, when: 'just now' }, cfg.shopName));
    for (const l of low) sendAsync(lowStockText(l.name, l.left));

    return ok({ order });
  },

  // A customer only ever sees their own orders.
  async mine(body, req) {
    const session = await requireClient(req);
    if (!session) return unauthorized();
    const orders = await read(KEYS.orders, []);
    return ok({ orders: orders.filter((o) => o.clientCode && o.clientCode === session.code).slice(0, 50) });
  },

  async list(body, req) {
    if (!(await requireOwner(req))) return unauthorized();
    const orders = await read(KEYS.orders, []);
    return ok(await snapshot(orders));
  },

  async advance(body, req) {
    if (!(await requireOwner(req))) return unauthorized();
    const id = str(body.id, 40);
    const orders = await mutate(KEYS.orders, [], (list) =>
      list.map((o) => (o.id === id && !o.cancelled ? { ...o, step: Math.min(3, (o.step || 0) + 1) } : o))
    );
    return ok(await snapshot(orders));
  },

  async stepBack(body, req) {
    if (!(await requireOwner(req))) return unauthorized();
    const id = str(body.id, 40);
    const orders = await mutate(KEYS.orders, [], (list) =>
      list.map((o) => (o.id === id ? { ...o, step: Math.max(0, (o.step || 0) - 1), cancelled: false } : o))
    );
    return ok(await snapshot(orders));
  },

  // Owner confirming (or un-confirming) that payment landed. This is what moves
  // an order from "still to collect" into the day's takings.
  async patch(body, req) {
    if (!(await requireOwner(req))) return unauthorized();
    const id = str(body.id, 40);
    const orders = await mutate(KEYS.orders, [], (list) =>
      list.map((o) => (o.id === id ? { ...o, payOk: body.payOk === true } : o))
    );
    return ok(await snapshot(orders));
  },

  // Cancelling returns the stock to the shelf — otherwise a few cancelled
  // orders silently make the shop look sold out.
  // Cancel: the order stays on the books, marked cancelled, and its goods go
  // back on the shelf. Returns the refreshed catalogue as well — the screen was
  // only updating the order list, so stock came back server-side while the
  // Stock tab carried on showing the old number until a reload.
  async cancel(body, req) {
    if (!(await requireOwner(req))) return unauthorized();
    const id = str(body.id, 40);
    let restore = [];
    const orders = await mutate(KEYS.orders, [], (list) =>
      list.map((o) => {
        if (o.id !== id || o.cancelled) return o;
        restore = o.items || [];
        return { ...o, cancelled: true, payOk: false };
      })
    );
    const products = await returnStock(restore);
    return ok({ ...(await snapshot(orders)), products });
  },

  // Archive: done with, out of the way, still counted. The queue fills up with
  // finished orders otherwise, and deleting them to tidy up would throw away
  // the record of what was sold.
  async archive(body, req) {
    if (!(await requireOwner(req))) return unauthorized();
    const id = str(body.id, 40);
    const orders = await mutate(KEYS.orders, [], (list) =>
      list.map((o) => (o.id === id ? { ...o, archived: body.archived !== false } : o))
    );
    return ok(await snapshot(orders));
  },

  // Delete: gone for good. Stock only comes back if it had not already been
  // returned by a cancel, otherwise deleting a cancelled order would credit the
  // same goods to the shelf twice.
  async remove(body, req) {
    if (!(await requireOwner(req))) return unauthorized();
    const id = str(body.id, 40);
    const all = await read(KEYS.orders, []);
    const target = all.find((o) => o.id === id);
    if (!target) return fail('That order is no longer there.');

    const orders = await mutate(KEYS.orders, [], (list) => list.filter((o) => o.id !== id));
    const products = target.cancelled
      ? (await read(KEYS.products, [])).map(migrateProduct)
      : await returnStock(target.items || []);
    return ok({ ...(await snapshot(orders)), products });
  }

});
