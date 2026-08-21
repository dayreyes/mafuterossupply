// Customer access codes — owner only, every action.
//
// Actions: list · issue · revoke · remove

import { route, ok, fail, unauthorized, str } from './lib/http.js';
import { read, mutate, KEYS } from './lib/store.js';
import { requireOwner } from './lib/session.js';
import { mintCode } from './lib/invites.js';
import { sendAll, codeText } from './lib/notify.js';

export default async (req) => route(req, {

  async list(body, req) {
    if (!(await requireOwner(req))) return unauthorized();
    return ok({ codes: await read(KEYS.codes, []) });
  },

  async issue(body, req) {
    if (!(await requireOwner(req))) return unauthorized();
    const name = str(body.name, 60);
    const { code, codes } = await mintCode(name);
    await sendAll(codeText(name || 'New customer', code));
    return ok({ code, codes });
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
    return ok({ codes });
  },

  async remove(body, req) {
    if (!(await requireOwner(req))) return unauthorized();
    const code = str(body.code, 16);
    const codes = await mutate(KEYS.codes, [], (list) => list.filter((c) => c.code !== code));
    return ok({ codes });
  }

});
