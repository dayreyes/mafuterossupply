// Customer access codes — owner only, every action.
//
// Actions: list · issue · revoke · remove (owner)
//          me · saveMe · notify (the customer's own record)

import { route, ok, fail, unauthorized, str } from './lib/http.js';
import { read, mutate, KEYS } from './lib/store.js';
import { requireOwner, requireClient } from './lib/session.js';
import { mintCode, withHistory } from './lib/invites.js';
import { sendAll, codeText, pushConfigured, pushPublicKey } from './lib/notify.js';
import { pointsFor, earnedRows, nextMilestone, expiresAt, pointsValue,
  tierAt, gramsInWindow, TIERS, TIER_DAYS,
  DOLLARS_PER_POINT, POINT_VALUE, EXPIRE_DAYS } from './lib/points.js';

// What a customer may see of their own record, and nothing of anyone else's.
const publicSelf = (c) => ({
  name: c.name || '', phone: c.phone || '', addr: c.addr || '', code: c.code,
  favs: Array.isArray(c.favs) ? c.favs : [],
  // Whether they asked for automatic messages, and whether THIS device is
  // registered — two different things: saying yes on a phone does not sign up
  // a laptop, and the switch is meaningless if no device is subscribed.
  notify: c.notify === true,
  devices: Array.isArray(c.push) ? c.push.length : 0
});

const MAX_DEVICES = 5;
const MAX_FAVS = 60;

// Where they stand, and what it would take to climb.
//
// The next tier is given as GRAMS still needed rather than as a threshold,
// because "42g" means nothing to somebody holding a phone and "another half
// ounce" means everything.
const tierBlock = (orders, code) => {
  const grams = gramsInWindow(orders, code);
  const tier = tierAt(orders, code);
  const next = TIERS.find((t) => t.grams > grams) || null;
  return {
    tier: tier.name,
    tierId: tier.id,
    tierMult: tier.mult,
    tierGrams: Math.round(grams * 10) / 10,
    tierDays: TIER_DAYS,
    nextTier: next ? next.name : '',
    nextTierGrams: next ? Math.round((next.grams - grams) * 10) / 10 : 0
  };
};

export default async (req) => route(req, {

  // The customer's own record.
  //
  // Guarded by a CLIENT session and scoped to the code that session was opened
  // with, so the only record reachable here is the caller's own — a customer
  // cannot name someone else's code and read their address.
  async me(body, req) {
    const session = await requireClient(req);
    if (!session) return unauthorized('Your session expired — enter your code again.');
    const mine = (await read(KEYS.codes, [])).find((c) => c.code === session.code);
    if (!mine) return fail('That code is no longer active.');
    // Their points and the orders behind them, counted fresh. The rows are the
    // customer's own orders only — the filter is on the session's code, so
    // there is nothing here to scope wrong.
    const orders = await read(KEYS.orders, []);
    const points = pointsFor(orders, session.code);
    const goal = nextMilestone(points);
    return ok({
      profile: publicSelf(mine),
      points,
      worth: pointsValue(points),
      perPoint: DOLLARS_PER_POINT,
      pointValue: POINT_VALUE,
      expireDays: EXPIRE_DAYS,
      expiresAt: expiresAt(orders, session.code),
      goal,
      toGo: goal ? goal - points : 0,
      earned: earnedRows(orders, session.code).slice(0, 20),
      ...tierBlock(orders, session.code)
    });
  },

  // The owner checking somebody's claim.
  //
  // He could already see the total on the Codes screen, which is enough to
  // disagree with a customer and not enough to settle it. This is the working:
  // the same rows the customer sees on their own phone, from the same
  // function, so the two cannot tell different stories.
  async history(body, req) {
    if (!(await requireOwner(req))) return unauthorized();
    const code = str(body.code, 16);
    const row = (await read(KEYS.codes, [])).find((c) => c.code === code);
    if (!row) return fail('No such code.');
    const orders = await read(KEYS.orders, []);
    const points = pointsFor(orders, code);
    return ok({
      name: row.name || '',
      code,
      points,
      worth: pointsValue(points),
      expiresAt: expiresAt(orders, code),
      earned: earnedRows(orders, code).slice(0, 40),
      ...tierBlock(orders, code)
    });
  },

  // The customer switching automatic messages on or off, and registering the
  // device that will receive them.
  //
  // A subscription is per device, which is why the switch and the device list
  // are separate: somebody says yes on their phone, then opens the shop on a
  // laptop, and the laptop has to register itself before it can be reached.
  // The endpoint is opaque to us — it is a URL at whichever push service the
  // browser uses, and it is the only thing that identifies the device.
  async notify(body, req) {
    const session = await requireClient(req);
    if (!session) return unauthorized('Your session expired — enter your code again.');
    if (!pushConfigured()) return fail('This shop is not set up to send messages.');

    const wants = body.on === true;
    const sub = body.sub && typeof body.sub === 'object' ? body.sub : null;
    // Shape-check rather than trust: a malformed subscription would fail on
    // every future send instead of being refused once, here.
    const endpoint = sub ? str(sub.endpoint, 500) : '';
    const p256dh = sub && sub.keys ? str(sub.keys.p256dh, 200) : '';
    const authKey = sub && sub.keys ? str(sub.keys.auth, 100) : '';
    if (sub && !(/^https:\/\//.test(endpoint) && p256dh && authKey)) {
      return fail('That device could not be registered.');
    }

    let found = false;
    const codes = await mutate(KEYS.codes, [], (list) =>
      list.map((c) => {
        if (c.code !== session.code) return c;
        found = true;
        let push = Array.isArray(c.push) ? c.push.slice() : [];
        if (sub) {
          // Same device registering again must not stack up duplicates.
          push = push.filter((x) => x.endpoint !== endpoint);
          push.unshift({ endpoint, keys: { p256dh, auth: authKey }, at: new Date().toISOString() });
          push = push.slice(0, MAX_DEVICES);
        }
        // Switching off drops the devices too. Keeping them would mean an
        // "off" that still holds live subscriptions, which is the sort of
        // thing that turns into an unwanted message after a deploy.
        if (!wants) push = [];
        return { ...c, notify: wants, push };
      })
    );
    if (!found) return fail('That code is no longer active.');
    return ok({ profile: publicSelf(codes.find((c) => c.code === session.code)) });
  },

  // Favourites.
  //
  // Kept against the code on the server rather than in the phone's storage,
  // which is what the prototype does: a customer who taps the heart on their
  // phone and then opens the shop on a laptop should still see it. Scoped to
  // the session's own code like everything else here, so the only list anyone
  // can touch is their own.
  //
  // Capped, because this is a free-text-ish list a client supplies and an
  // uncapped one is a way to make the codes blob grow without limit.
  async fav(body, req) {
    const session = await requireClient(req);
    if (!session) return unauthorized('Your session expired — enter your code again.');
    const pid = str(body.pid, 24);
    if (!pid) return fail('No strain given.');
    const on = body.on === true;

    let found = false;
    const codes = await mutate(KEYS.codes, [], (list) =>
      list.map((c) => {
        if (c.code !== session.code) return c;
        found = true;
        const had = Array.isArray(c.favs) ? c.favs.filter((x) => x !== pid) : [];
        return { ...c, favs: on ? [pid].concat(had).slice(0, MAX_FAVS) : had };
      })
    );
    if (!found) return fail('That code is no longer active.');
    return ok({ favs: publicSelf(codes.find((c) => c.code === session.code)).favs });
  },

  // The browser needs the shop's public key to subscribe at all.
  async pushKey(body, req) {
    const session = await requireClient(req);
    if (!session) return unauthorized();
    return ok({ configured: pushConfigured(), key: pushPublicKey() });
  },

  // Customers correcting their own details.
  //
  // Only the three fields they own: what to call them, the number to reach them
  // on, and where to drive. Never the code, never active, never anything the
  // owner controls — and the code being written is taken from the session, not
  // from the request body, so a forged body cannot redirect the write.
  async saveMe(body, req) {
    const session = await requireClient(req);
    if (!session) return unauthorized('Your session expired — enter your code again.');

    const name = str(body.name, 60);
    if (name.length < 2) return fail('Put a name he will recognise.');
    const phone = str(body.phone, 32);
    const addr = str(body.addr, 160);

    let found = false;
    const codes = await mutate(KEYS.codes, [], (list) =>
      list.map((c) => {
        if (c.code !== session.code) return c;
        found = true;
        return { ...c, name, phone, addr };
      })
    );
    if (!found) return fail('That code is no longer active.');
    const mine = codes.find((c) => c.code === session.code);
    return ok({ profile: publicSelf(mine) });
  },

  async list(body, req) {
    if (!(await requireOwner(req))) return unauthorized();
    return ok({ codes: await withHistory(await read(KEYS.codes, [])) });
  },

  async issue(body, req) {
    if (!(await requireOwner(req))) return unauthorized();
    const name = str(body.name, 60);
    const { code, codes } = await mintCode(name);
    await sendAll(codeText(name || 'New customer', code));
    return ok({ code, codes: await withHistory(codes) });
  },

  // Revoking is a flag rather than a delete so the owner keeps the history of
  // who had access and how much they ordered.
  async revoke(body, req) {
    if (!(await requireOwner(req))) return unauthorized();
    const code = str(body.code, 16);
    let found = false;
    const codes = await mutate(KEYS.codes, [], (list) =>
      list.map((c) => {
        if (c.code !== code) return c;
        found = true;
        return { ...c, active: body.active === true };
      })
    );
    if (!found) return fail('No such code.');
    return ok({ codes: await withHistory(codes) });
  },

  async remove(body, req) {
    if (!(await requireOwner(req))) return unauthorized();
    const code = str(body.code, 16);
    const codes = await mutate(KEYS.codes, [], (list) => list.filter((c) => c.code !== code));
    return ok({ codes: await withHistory(codes) });
  }

});
