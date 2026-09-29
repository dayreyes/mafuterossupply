// Mafupuntos.
//
// One point for every dollar spent. Nothing is redeemable yet — this earns and
// displays only, and the app says "rewards coming soon" rather than implying
// otherwise. That is deliberate: a balance is cheap to get right, and a
// redemption touches prices, stock and the money path all at once. It can come
// later without changing anything here.
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
// and the points go with it, because they were never anywhere else. It also
// backdates itself: this shop traded for a month before points existed, and
// every one of those orders counts the moment the feature ships, so a regular
// opens the app already holding a balance instead of being told to start again.
//
// The cost is a read of the order list to answer "how many points do I have",
// which is one blob fetch on a shop doing a few dozen orders a day.

export const PTS_PER_DOLLAR = 1;

// What a single order is worth.
//
// Floored per order rather than on the sum, so the balance always equals the
// rows shown under "how you earned them". A total that disagrees with the list
// adding up to it is the kind of thing that costs trust in the whole feature.
export const orderPoints = (o) =>
  Math.floor(((o.subtotal || 0) + (o.fee || 0)) * PTS_PER_DOLLAR);

// The fee earns points too, because it is money the customer actually handed
// over. Splitting it out would mean the balance never matches the totals on
// their own receipts, and "why did my $30 order give me 25 points" is not a
// conversation worth having over a delivery fee.

// Cancelled orders are worth nothing — the sale did not happen. Archived ones
// count, since archiving only tidies the queue.
const counts = (o, code) => o.clientCode === code && !o.cancelled;

export const pointsFor = (orders, code, carry = null) =>
  (orders || []).reduce((a, o) => a + (counts(o, code) ? orderPoints(o) : 0), 0) +
  ((carry && carry[code]) || 0);

// The one thing a derived balance cannot survive on its own.
//
// The order list is capped at 2000 and the oldest fall off the end. Everything
// else in this app is fine with that — the queue, the takings, the patterns all
// look at recent trading — but points are cumulative and for life, so an order
// ageing out would quietly take a customer's points with it. Their balance
// would go DOWN, months later, for no reason they could see.
//
// So the points on a dropped order are added to a carry-over the moment it is
// dropped, and every balance is the carry plus whatever is still in the list.
// The derivation still holds for every live order — cancel one and the points
// go with it — and the only stored number is for orders nobody can edit any
// more because they no longer exist.
export function addCarry(carry, dropped) {
  const out = { ...(carry || {}) };
  for (const o of dropped || []) {
    if (!o.clientCode || o.cancelled) continue;
    out[o.clientCode] = (out[o.clientCode] || 0) + orderPoints(o);
  }
  return out;
}

// The breakdown behind the number, newest first.
export const earnedRows = (orders, code) =>
  (orders || [])
    .filter((o) => counts(o, code))
    .map((o) => ({ no: o.no, at: o.at, points: orderPoints(o) }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));

// The ladder.
//
// Roughly four orders to the first rung at this shop's prices, which is close
// enough to reach that a new customer can see it, and far enough that it is not
// hit by accident on the first order.
export const MILESTONES = [100, 250, 500, 1000, 2500, 5000];

export const nextMilestone = (points) => MILESTONES.find((m) => m > points) || null;

// The rung an order just carried somebody past, if any.
//
// Only ever one message, even if a single large order clears two rungs at once
// — the highest one reached. Two notifications for one order reads as a bug,
// and the lower rung is not news once you are past it.
export function crossed(before, after) {
  const passed = MILESTONES.filter((m) => m > before && m <= after);
  return passed.length ? passed[passed.length - 1] : null;
}
