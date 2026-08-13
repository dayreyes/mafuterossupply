// Shop configuration: the shape of it, its defaults, and validation.
//
// Everything the old demo hard-coded — shop name, Zelle/Venmo handles, the nine
// Tampa delivery zones, the mileage fee formula, the pickup address — lives
// here as owner-editable config instead. A brand new shop starts EMPTY: no
// products, no zones, no payment handles. Nothing fake ever reaches a customer.

import { str, num } from './http.js';

export const defaultConfig = () => ({
  shopName: '',
  pickupNote: '',
  // How customers reach the owner while they wait for a code. Was a phone
  // number and IG handle hard-coded into the Spanish copy.
  contact: '',
  payments: [
    { id: 'zelle', label: 'Zelle', handle: '', fast: true, enabled: false },
    { id: 'venmo', label: 'Venmo', handle: '', fast: true, enabled: false },
    { id: 'cash', label: 'Cash', labelEs: 'Efectivo', handle: '', fast: false, enabled: true }
  ],
  zones: [],
  run: { on: false, start: '18:00', end: '21:00', max: 15, zones: [] },
  // The demo's mileage ladder, now as numbers the owner can retune:
  // free under freeMiles, midFee out to midMiles, then farBase plus
  // farStepFee for every farStepMiles beyond midMiles.
  fees: { freeMiles: 5, midMiles: 10, midFee: 5, farBase: 6, farStepMiles: 5, farStepFee: 1 },
  holdMinutes: 30,
  setupComplete: false
});

export const SECTIONS = ['Flower', 'Indoors', 'Concentrated', 'Vapes'];
export const TYPES = ['Hybrid', 'Indica', 'Sativa', 'Cart'];
const STICKERS = ['#e1eecc', '#ffe1d0', '#ffc6a5', '#f0fae1'];

export const isTime = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));

export function cleanConfig(incoming, current) {
  const c = { ...defaultConfig(), ...current };
  const inp = incoming && typeof incoming === 'object' ? incoming : {};

  if (inp.shopName !== undefined) c.shopName = str(inp.shopName, 60);
  if (inp.pickupNote !== undefined) c.pickupNote = str(inp.pickupNote, 160);
  if (inp.contact !== undefined) c.contact = str(inp.contact, 120);
  if (inp.holdMinutes !== undefined) c.holdMinutes = num(inp.holdMinutes, 5, 240, c.holdMinutes);

  if (Array.isArray(inp.payments)) {
    c.payments = c.payments.map((p) => {
      const hit = inp.payments.find((x) => x && x.id === p.id);
      if (!hit) return p;
      return { ...p, handle: str(hit.handle, 60), enabled: hit.enabled === true };
    });
  }

  if (Array.isArray(inp.zones)) {
    c.zones = inp.zones
      .filter((z) => z && str(z.name, 60))
      .slice(0, 40)
      .map((z, i) => ({
        id: str(z.id, 24) || 'z' + i + '-' + Date.now().toString(36),
        name: str(z.name, 60),
        mi: num(z.mi, 0, 200, 5)
      }));
  }

  if (inp.run && typeof inp.run === 'object') {
    const r = inp.run;
    c.run = {
      on: r.on === true,
      start: isTime(r.start) ? r.start : c.run.start,
      end: isTime(r.end) ? r.end : c.run.end,
      max: num(r.max, 1, 200, c.run.max),
      // Only zones that actually exist can be switched on for the run.
      zones: Array.isArray(r.zones) ? r.zones.map((z) => str(z, 24)).filter((z) => c.zones.some((x) => x.id === z)) : []
    };
  } else {
    c.run = { ...c.run, zones: c.run.zones.filter((z) => c.zones.some((x) => x.id === z)) };
  }

  if (inp.fees && typeof inp.fees === 'object') {
    const f = inp.fees;
    c.fees = {
      freeMiles: num(f.freeMiles, 0, 200, c.fees.freeMiles),
      midMiles: num(f.midMiles, 0, 300, c.fees.midMiles),
      midFee: num(f.midFee, 0, 500, c.fees.midFee),
      farBase: num(f.farBase, 0, 500, c.fees.farBase),
      farStepMiles: num(f.farStepMiles, 1, 100, c.fees.farStepMiles),
      farStepFee: num(f.farStepFee, 0, 500, c.fees.farStepFee)
    };
  }

  // A shop counts as set up once it can actually take money and has something
  // to sell — checked by the caller, which knows the product count.
  return c;
}

export function mileFee(mi, fees) {
  const f = { ...defaultConfig().fees, ...fees };
  if (mi <= f.freeMiles) return 0;
  if (mi <= f.midMiles) return f.midFee;
  return f.farBase + Math.floor((mi - f.midMiles) / f.farStepMiles) * f.farStepFee;
}

// Price ladders are derived from one base price so the owner types a single
// number per product instead of four.
export function weightsFor(sec, base) {
  const b = Math.max(1, Math.round(base));
  if (sec === 'Concentrated') return [['1g', b], ['7g', b * 5]];
  if (sec === 'Vapes') return [['1 cart', b], ['4 carts', b * 3]];
  return [['3.5g', b], ['7g', Math.round(b * 1.6)], ['1/2 oz', Math.round(b * 3.2)], ['1 oz', Math.round(b * 5.6)]];
}

export function cleanProduct(inp, index = 0, existing = null) {
  const name = str(inp.name, 60);
  if (name.length < 2) return { error: 'name too short' };
  // Validate the raw value BEFORE clamping: num() would quietly lift a 0 (or a
  // negative) up to the minimum, so clamping first turns "no price given" into
  // a real product priced at $1.
  const rawPrice = Number(inp.price);
  if (!Number.isFinite(rawPrice) || rawPrice < 1) return { error: 'price required' };
  const price = num(rawPrice, 1, 100000, 1);
  const sec = SECTIONS.includes(inp.sec) ? inp.sec : 'Indoors';
  const type = TYPES.includes(inp.type) ? inp.type : 'Hybrid';
  return {
    product: {
      id: (existing && existing.id) || 'p' + Date.now().toString(36) + index,
      name,
      sec,
      type,
      thc: str(inp.thc, 12) || '—',
      cbd: str(inp.cbd, 12) || '—',
      bg: (existing && existing.bg) || STICKERS[index % STICKERS.length],
      notes: str(inp.note ?? inp.notes, 240),
      effects: Array.isArray(inp.effects) ? inp.effects.slice(0, 6).map((e) => str(e, 24)).filter(Boolean) : [],
      price,
      weights: weightsFor(sec, price),
      foot: str(inp.foot, 160),
      stock: num(inp.stock, 0, 100000, existing ? existing.stock : 0),
      active: inp.active !== false,
      at: (existing && existing.at) || new Date().toISOString()
    }
  };
}

// What a customer is allowed to see. Never leak stock counts of hidden items or
// internal bookkeeping.
export const publicProduct = (p) => ({
  id: p.id, name: p.name, sec: p.sec, type: p.type, thc: p.thc, cbd: p.cbd,
  bg: p.bg, notes: p.notes, effects: p.effects, weights: p.weights,
  foot: p.foot, stock: p.stock
});

export const publicConfig = (c) => ({
  shopName: c.shopName,
  pickupNote: c.pickupNote,
  contact: c.contact,
  payments: c.payments.filter((p) => p.enabled).map((p) => ({
    id: p.id, label: p.label, labelEs: p.labelEs, handle: p.handle, fast: p.fast
  })),
  zones: c.zones.filter((z) => c.run.zones.includes(z.id)),
  run: { on: c.run.on, start: c.run.start, end: c.run.end, max: c.run.max, zones: c.run.zones },
  fees: c.fees,
  holdMinutes: c.holdMinutes,
  setupComplete: c.setupComplete
});
