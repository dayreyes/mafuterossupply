// Mafupuntos.
//
// POINTS ARE DERIVED, NEVER STORED.
//
// The obvious design is a running total on each code, incremented at checkout.
// It is also the one that goes wrong, in exactly the way the order counter
// already went wrong in this app: `uses` was incremented on sign-in and read as
// "orders", and once it disagreed with reality there was nothing to reconcile
// it against. A stored balance is worse, because it is the customer's money in
// all but name — cancel an order and the points stay, delete one and they stay,
// restore a backup and they are whatever they were at the snapshot.
//
// Reading them from the orders means the balance cannot drift. Cancel an order
// and the points go with it, because they were never anywhere else.
//
// The cost is a read of the order list to answer "how many points do I have",
// which is one blob fetch on a shop doing a few dozen orders a day.

// ── the three numbers that decide what this costs ───────────────────────────
//
// Everything about the economics is here, because the economics are the part
// most likely to change and the part most expensive to get wrong.
//
// An eighth earns a point and a point is a dollar off. Four percent at the
// base, and one sentence at a door.
//
// THE TIER IS WHAT ACTUALLY MOVES THE NEEDLE, and it is measured in GRAMS,
// not in purchases. Counting purchases rewards frequency: eight separate
// eighths would outrank one ounce, which is backwards for a shop that would
// rather sell the ounce. Grams count what left the shelf, so buying bigger
// climbs faster — one ounce moves you as far as eight eighths, in one go.
//
// Ninety days, so a quiet fortnight does not demote anybody, and so the tier
// means "how you have been buying lately" rather than "what you did once".
export const DOLLARS_PER_POINT = 25;   // an eighth earns a point
export const POINT_VALUE = 1;          // a point is a dollar off
export const EXPIRE_DAYS = 30;
export const TIER_DAYS = 90;

// Thresholds in grams: an ounce and a half, and three and a half ounces.
export const TIERS = [
  { id: 'mafutero', name: 'Mafutero', grams: 0,   mult: 1 },
  { id: 'veterano', name: 'Veterano', grams: 42,  mult: 2 },
  { id: 'patron',   name: 'Patr\u00f3n',   grams: 98,  mult: 3 }
];

const EXPIRE_MS = EXPIRE_DAYS * 24 * 60 * 60 * 1000;

// What a single order is worth.
//
// Floored per order rather than on the sum, so the balance always equals the
// rows shown under "how you earned them". A total that disagrees with the list
// adding up to it is the kind of thing that costs trust in the whole feature.
const TIER_MS = TIER_DAYS * 24 * 60 * 60 * 1000;

// How much actually left the shelf on an order.
export const orderGrams = (o) =>
  (o.items || []).reduce((a, i) => a + (Number(i.grams) || 0) * (Number(i.qty) || 0), 0);

// Grams bought in the window ending at `at` — which is how the tier is read
// both for "what are they now" and for "what were they when they ordered".
export function gramsInWindow(orders, code, at = new Date()) {
  const end = at.getTime();
  return (orders || []).reduce((a, o) => {
    if (o.clientCode !== code || o.cancelled) return a;
    const t = new Date(o.at || 0).getTime();
    return t <= end && end - t <= TIER_MS ? a + orderGrams(o) : a;
  }, 0);
}

export const tierForGrams = (g) =>
  TIERS.slice().reverse().find((t) => g >= t.grams) || TIERS[0];

export const tierAt = (orders, code, at = new Date()) =>
  tierForGrams(gramsInWindow(orders, code, at));

// What a single order is worth, at the tier its owner held when they placed
// it. Not the tier they hold today: an order's value must never change after
// the fact, or the breakdown stops matching the receipts and a customer who
// drops a tier watches old points evaporate.
export const orderPoints = (o, mult = 1) =>
  Math.floor(((o.subtotal || 0) + (o.fee || 0)) / DOLLARS_PER_POINT) * mult;

// The fee earns points too, because it is money the customer actually handed
// over. Splitting it out would mean the balance never matches the totals on
// their own receipts.

// Cancelled orders are worth nothing — the sale did not happen. Archived ones
// count, since archiving only tidies the queue.
const counts = (o, code) => o.clientCode === code && !o.cancelled;

// ── what a tier is actually worth, beyond earning faster ────────────────────
//
// Kept here rather than scattered through the handlers, so "what does Patron
// get" has one answer that can be read in one place.
export const PERKS = {
  mafutero: { holdMinutes: 30, bakersDozen: false, queueFirst: false },
  veterano: { holdMinutes: 60, bakersDozen: false, queueFirst: false },
  patron:   { holdMinutes: 60, bakersDozen: true,  queueFirst: true }
};

export const perksFor = (tierId) => PERKS[tierId] || PERKS.mafutero;

// ── expiry ──────────────────────────────────────────────────────────────────
//
// "A month without ordering and you start again." Expressed as a gap, not as
// a clock on each point, which is what makes it survive being derived.
//
// Walking newest-first and stopping at the first gap longer than the window
// gets both halves right at once: if the newest order is older than a month
// nothing counts at all, and if somebody disappeared for six weeks in the
// middle of their history, everything before that gap is gone and everything
// after it is not.
//
// The naive version — "return 0 if their last order is old" — looks the same
// until a lapsed customer orders again, at which point their whole expired
// history springs back. Points cannot un-expire.
export function livingOrders(orders, code, now = new Date()) {
  const mine = (orders || []).filter((o) => counts(o, code))
    .sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
  const out = [];
  let prev = now.getTime();
  for (const o of mine) {
    const at = new Date(o.at || 0).getTime();
    if (prev - at > EXPIRE_MS) break;
    out.push(o);
    prev = at;
  }
  return out;
}

export const pointsFor = (orders, code, now = new Date()) =>
  livingOrders(orders, code, now)
    .reduce((a, o) => a + orderPoints(o, tierAt(orders, code, new Date(o.at)).mult), 0);

// What the balance is worth in money.
export const pointsValue = (points) => points * POINT_VALUE;

// The breakdown behind the number, newest first — which is also what the owner
// checks a customer's claim against.
export const earnedRows = (orders, code, now = new Date()) =>
  livingOrders(orders, code, now).map((o) => {
    const t = tierAt(orders, code, new Date(o.at));
    return { no: o.no, at: o.at, points: orderPoints(o, t.mult), tier: t.name, mult: t.mult };
  });

// When the balance goes, if nothing else is bought.
export function expiresAt(orders, code, now = new Date()) {
  const live = livingOrders(orders, code, now);
  if (!live.length) return null;
  return new Date(new Date(live[0].at).getTime() + EXPIRE_MS).toISOString();
}

// ── the ladder ──────────────────────────────────────────────────────────────
//
// A free eighth at twenty-five, then again. At the base tier that is
// twenty-five eighths; at Patr\u00f3n it is eight and a bit, which is the tier
// doing its job.
export const MILESTONES = [25, 50, 100, 200];

export const nextMilestone = (points) => MILESTONES.find((m) => m > points) || null;

// The rung an order just carried somebody past, if any.
//
// Only ever one message, even if a single large order clears two rungs at once
// — the highest one reached. Two notifications for one order reads as a bug.
export function crossed(before, after) {
  const passed = MILESTONES.filter((m) => m > before && m <= after);
  return passed.length ? passed[passed.length - 1] : null;
}

// The 2000-order cap used to need a carry-over here, so that points on an
// order ageing off the end of the list were not silently lost. Expiry makes
// that impossible to reach: nothing older than thirty days can still be in a
// living chain, and an order old enough to fall off a 2000-row list is far
// older than that. The carry is gone rather than kept as a comfort.
