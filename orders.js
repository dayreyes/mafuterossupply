// Orders.
//
// The important rule here: the SERVER prices the order. The old demo let the
// browser compute the total and post it, which means a customer could have
// bought an ounce for $1 by editing one number. The client now sends only what
// it picked — product id, weight index, quantity — and every dollar comes back
// out of the stored catalogue.
//
// Actions: place · mine · list · advance · stepBack · patch · cancel

import { route, ok, fail, unauthorized, str, num } from './lib/http.js';
import { read, write, mutate, KEYS } from './lib/store.js';
import { requireOwner, requireClient } from './lib/session.js';
import { defaultConfig, mileFee } from './lib/config.js';
import { sendAsync, orderText, lowStockText } from './lib/notify.js';

const money = (n) => '$' + Number(n).toLocaleString('en-US');
const today = () => new Date().toISOString().slice(0, 10);

const LOW_STOCK_AT = 3;

// Delivery capacity is derived from the orders actually taken today rather than
// a counter someone has to remember to reset.
const stopsToday = (orders) =>
  orders.filter((o) => o.mode === 'delivery' && !o.cancelled && String(o.at || '').slice(0, 10) === today()).length;

export default async (req) => route(req, {

  async place(body, req) {
    const session = await requireClient(req);
    if (!session) return unauthorized('Your session expired — enter your code again.');

    const cfg = await read(KEYS.config, defaultConfig());
    if (!cfg.setupComplete) return fail('This shop is not open yet.');

    const products = await read(KEYS.products, []);
    const lines = Array.isArray(body.items) ? body.items.slice(0, 40) : [];
    if (!lines.length) return fail('Your bag is empty.');

    // Price every line from the catalogue, and refuse anything out of stock.
    const priced = [];
    let subtotal = 0;
    for (const raw of lines) {
      const p = products.find((x) => x.id === str(raw.pid, 40) && x.active);
      if (!p) return fail('Something in your bag is no longer available.');
      const wIdx = num(raw.weightIdx, 0, p.weights.length - 1, 0);
      const qty = num(raw.qty, 1, 99, 1);
      const [label, unit] = p.weights[wIdx];
      if ((p.stock || 0) < qty) return fail(p.name + ' does not have that many left.');
      subtotal += unit * qty;
      priced.push({ pid: p.id, name: p.name, label, unit, qty, line: qty + '× ' + p.name + ' · ' + label, price: money(unit * qty) });
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

    const hold = mode === 'pickup' && !payment.fast ? cfg.holdMinutes : null;
    const counters = await read(KEYS.counters, { orderSeq: 1000 });
    const seq = (counters.orderSeq || 1000) + 1;
    await write(KEYS.counters, { ...counters, orderSeq: seq });

    const order = {
      id: 'o' + Date.now().toString(36),
      no: '#' + seq,
      client: session.name || 'Customer',
      clientCode: session.code || '',
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
      list.map((p) => {
        const taken = priced.filter((l) => l.pid === p.id).reduce((a, l) => a + l.qty, 0);
        if (!taken) return p;
        const left = Math.max(0, (p.stock || 0) - taken);
        if (left <= LOW_STOCK_AT) low.push({ name: p.name, left });
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
    const cfg = await read(KEYS.config, defaultConfig());
    return ok({ orders: orders.slice(0, 300), stops: stopsToday(orders), max: cfg.run.max });
  },

  async advance(body, req) {
    if (!(await requireOwner(req))) return unauthorized();
    const id = str(body.id, 40);
    const orders = await mutate(KEYS.orders, [], (list) =>
      list.map((o) => (o.id === id && !o.cancelled ? { ...o, step: Math.min(3, (o.step || 0) + 1) } : o))
    );
    return ok({ orders });
  },

  async stepBack(body, req) {
    if (!(await requireOwner(req))) return unauthorized();
    const id = str(body.id, 40);
    const orders = await mutate(KEYS.orders, [], (list) =>
      list.map((o) => (o.id === id ? { ...o, step: Math.max(0, (o.step || 0) - 1), cancelled: false } : o))
    );
    return ok({ orders });
  },

  // Owner confirming (or un-confirming) that payment landed.
  async patch(body, req) {
    if (!(await requireOwner(req))) return unauthorized();
    const id = str(body.id, 40);
    const orders = await mutate(KEYS.orders, [], (list) =>
      list.map((o) => (o.id === id ? { ...o, payOk: body.payOk === true } : o))
    );
    return ok({ orders });
  },

  // Cancelling returns the stock to the shelf — otherwise a few cancelled
  // orders silently make the shop look sold out.
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
    if (restore.length) {
      await mutate(KEYS.products, [], (list) =>
        list.map((p) => {
          const back = restore.filter((l) => l.pid === p.id).reduce((a, l) => a + l.qty, 0);
          return back ? { ...p, stock: (p.stock || 0) + back } : p;
        })
      );
    }
    return ok({ orders });
  }

});
