// Customer access codes.
//
// These are door keys, so they come from crypto.randomInt rather than
// Math.random — a Math.random sequence is reconstructable from a couple of
// observed codes, which for a shop that hands out codes one at a time is a
// realistic way to guess the next one.

import { randomInt } from 'node:crypto';
import { mutate, KEYS } from './store.js';
import { str } from './http.js';
import { CLIENT_CODE_LEN } from './auth.js';

export const genCode = () =>
  String(randomInt(0, 10 ** CLIENT_CODE_LEN)).padStart(CLIENT_CODE_LEN, '0');

// Mints a unique, active code and returns it with the updated list.
export async function mintCode(name) {
  let code = '';
  const codes = await mutate(KEYS.codes, [], (list) => {
    do { code = genCode(); } while (list.some((c) => c.code === code));
    return [{
      id: 'c' + Date.now().toString(36),
      name: str(name, 60),
      code,
      active: true,
      uses: 0,
      issued: new Date().toISOString()
    }].concat(list);
  });
  return { code, codes };
}
