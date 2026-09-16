// Customer access codes — owner only, every action.
//
// Actions: list · issue · revoke · remove (owner)
//          me · saveMe (the customer's own record)

import { route, ok, fail, unauthorized, str } from './lib/http.js';
import { read, mutate, KEYS } from './lib/store.js';
import { requireOwner, requireClient } from './lib/session.js';
import { mintCode, withHistory } from './lib/invites.js';
import { sendAll, codeText } from './lib/notify.js';

// What a customer may see of their own record, and nothing of anyone else's.
const publicSelf = (c) => ({
  name: c.name || '', phone: c.phone || '', addr: c.addr || '', code: c.code
});

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
    return ok({ profile: publicSelf(mine) });
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
