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

export const SECTIONS = ['Flower', 'Indoors', 'Concentrated', 'Vapes', 'Edibles'];
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

// Weight tiers, per category.
//
// `grams` is what a sale actually takes off the shelf, which is the whole point
// of tracking stock in grams: selling an ounce has to remove 28, not 1. Vapes
// are counted in whole carts instead, so the unit is per category too.
// Starting points only. The owner can rename any row, change what it takes off
// stock, and add or remove rows — a 4g cart, a 10mg gummy and a tray of twelve
// do not fit a fixed weight ladder, and pretending otherwise is what forced
// "two separate products" workarounds.
export const TIERS = {
  Flower:       { unit: 'g',  tiers: [['3.5g', 3.5], ['7g', 7], ['1/2 oz', 14], ['1 oz', 28]] },
  Indoors:      { unit: 'g',  tiers: [['3.5g', 3.5], ['7g', 7], ['1/2 oz', 14], ['1 oz', 28]] },
  Concentrated: { unit: 'g',  tiers: [['1g', 1], ['3.5g', 3.5], ['7g', 7]] },
  Vapes:        { unit: 'ea', tiers: [['1g cart', 1], ['4g cart', 1], ['2 x 1g cart', 2]] },
  Edibles:      { unit: 'ea', tiers: [['1 piece', 1], ['4 pieces', 4], ['10 pieces', 10]] }
};

export const MAX_TIERS = 8;

export const tiersFor = (sec) => (TIERS[sec] || TIERS.Indoors).tiers;
export const unitFor = (sec) => (TIERS[sec] || TIERS.Indoors).unit;

// Which tier the owner types first. The rest are pre-filled from it as a
// starting point and stay editable, so an ounce deal can be priced below the
// multiplier instead of being locked to it.
// Flower now starts at 3.5g — an eighth is the smallest serving the shop
// actually deals in, and pricing a single gram off the same multiplier put the
// ladder out of step with how it is sold. A gram can still be added back as a
// row on any individual product.
export const BASE_INDEX = { Flower: 0, Indoors: 0, Concentrated: 0, Vapes: 0, Edibles: 0 };

const MULTIPLIERS = {
  Flower:       [1, 1.6, 3.2, 5.6],
  Indoors:      [1, 1.6, 3.2, 5.6],
  Concentrated: [1, 3, 5],
  Vapes:        [1, 3, 1.9],
  Edibles:      [1, 3.6, 8]
};

export const suggestPrices = (sec, base) =>
  (MULTIPLIERS[sec] || MULTIPLIERS.Indoors).map((m) => Math.max(1, Math.round(base * m)));

// Products saved before prices became per-tier carry `weights` ([label, price])
// and a stock number that counted items rather than grams. Convert on read so
// an existing shop keeps working; the stock figure is left alone because only
// the owner knows whether that 16 meant grams or jars.
export function migrateProduct(p) {
  if (!p || Array.isArray(p.tiers)) return p;
  const sec = SECTIONS.includes(p.sec) ? p.sec : 'Indoors';
  const spec = tiersFor(sec);
  const old = Array.isArray(p.weights) ? p.weights : [];
  const byLabel = new Map(old.map((w) => [w[0], w[1]]));
  const base = Number(p.price) || Number(old[0] && old[0][1]) || 1;
  const suggested = suggestPrices(sec, base);
  return {
    ...p,
    sec,
    unit: unitFor(sec),
    tiers: spec.map(([label, grams], i) => ({
      label,
      grams,
      price: Number(byLabel.get(label)) || suggested[i] || 1
    }))
  };
}

export function cleanProduct(inp, index = 0, existing = null) {
  const name = str(inp.name, 60);
  if (name.length < 2) return { error: 'name too short' };
  const sec = SECTIONS.includes(inp.sec) ? inp.sec : 'Indoors';
  const type = TYPES.includes(inp.type) ? inp.type : 'Hybrid';

  // Rows are the owner's: their label, their price, and how much each one takes
  // off the shelf. Validate raw values BEFORE clamping — num() would lift a 0
  // up to the minimum, turning "no price given" into a real product at $1.
  const given = Array.isArray(inp.tiers) ? inp.tiers : null;
  if (!given || !given.length) return { error: 'add at least one size' };
  if (given.length > MAX_TIERS) return { error: 'too many sizes' };

  const tiers = [];
  for (const raw of given) {
    if (!raw || typeof raw !== 'object') return { error: 'a size is missing' };
    const label = str(raw.label, 24);
    if (!label) return { error: 'a size needs a name' };
    const price = Number(raw.price);
    if (!Number.isFinite(price) || price < 1) return { error: 'a price is missing' };
    const grams = Number(raw.grams);
    if (!Number.isFinite(grams) || grams <= 0) return { error: 'a size needs an amount' };
    tiers.push({
      label,
      grams: num(grams, 0.01, 100000, 1),
      price: num(price, 1, 100000, 1)
    });
  }

  return {
    product: {
      id: (existing && existing.id) || 'p' + Date.now().toString(36) + index,
      name,
      sec,
      type,
      unit: unitFor(sec),
      thc: str(inp.thc, 12) || '\u2014',
      cbd: str(inp.cbd, 12) || '\u2014',
      bg: (existing && existing.bg) || STICKERS[index % STICKERS.length],
      notes: str(inp.note ?? inp.notes, 240),
      effects: Array.isArray(inp.effects) ? inp.effects.slice(0, 6).map((e) => str(e, 24)).filter(Boolean) : [],
      tiers,
      foot: str(inp.foot, 160),
      // Grams for flower and concentrates, whole items for everything else.
      stock: num(inp.stock, 0, 1000000, existing ? existing.stock : 0),
      // Occasional items — a tray he only cooks sometimes — are switched off
      // rather than deleted, so the recipe and prices survive until next time.
      active: inp.active !== false,
      at: (existing && existing.at) || new Date().toISOString()
    }
  };
}

// What a customer is allowed to see. Never leak internal bookkeeping.
export const publicProduct = (p) => ({
  id: p.id, name: p.name, sec: p.sec, type: p.type, thc: p.thc, cbd: p.cbd,
  bg: p.bg, notes: p.notes, effects: p.effects, tiers: p.tiers, unit: p.unit,
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
