// Customer signup requests — the public end of the shareable link.
//
// `submit` is the only endpoint in the app that takes input from someone with
// no code and no session, so it is the one most exposed to abuse: it is rate
// limited per IP, every field is length-capped, and the age check is redone
// here from the date of birth rather than trusting the `age` the browser sent.
//
// Actions: submit · list · approve · ignore

import { route, ok, fail, unauthorized, tooMany, clientIp, str } from './lib/http.js';
import { read, mutate, KEYS } from './lib/store.js';
import { requireOwner, checkThrottle, recordFailure } from './lib/auth.js';
import { defaultConfig } from './lib/shop.js';
import { mintCode } from './lib/codes.js';
import { sendAsync, signupText, codeText } from './lib/notify.js';

const MIN_AGE = 21;

// Accepts MM/DD/YYYY with any separator, which is what the form asks for.
function ageFrom(bday) {
  const m = /^(\d{1,2})\D(\d{1,2})\D(\d{4})$/.exec(String(bday || '').trim());
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  if (isNaN(d) || d.getMonth() !== Number(mm) - 1 || d.getDate() !== Number(dd)) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const md = now.getMonth() - d.getMonth();
  if (md < 0 || (md === 0 && now.getDate() < d.getDate())) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

export default async (req) => route(req, {

  async submit(body, req) {
    const ip = clientIp(req);
    const gate = await checkThrottle('signup', ip, false);
    if (!gate.allowed) return tooMany('Too many requests. Try again later.', gate.retryAfter);

    const cfg = await read(KEYS.config, defaultConfig());
    if (!cfg.setupComplete) return fail('This shop is not taking signups yet.');

    const name = str(body.name, 60);
    const phone = str(body.phone, 32);
    const addr = str(body.addr, 160);
    const pay = str(body.pay, 24);
    const age = ageFrom(body.bday);

    if (!name || !phone || !addr) return fail('Fill in your name, phone and address.');
    if (body.id !== true) return fail('Confirm you can show ID.');
    if (age === null) return fail('Enter your date of birth as MM/DD/YYYY.');
    if (age < MIN_AGE) return fail('You must be ' + MIN_AGE + ' or older.');

    // Meter every accepted submission against this IP's budget, but keep it out
    // of the global lock (see recordFailure) — signups are traffic, not guesses.
    await recordFailure('signup', ip, false);

    const request = {
      id: 's' + Date.now().toString(36),
      name, phone, addr, age,
      pay: (cfg.payments.find((p) => p.id === pay) || {}).label || '',
      at: new Date().toISOString()
    };

    await mutate(KEYS.signups, [], (list) => {
      // One open request per phone number, so a double-tap doesn't queue twice.
      if (list.some((r) => r.phone === phone)) return list;
      return [request].concat(list).slice(0, 500);
    });

    sendAsync(signupText({ ...request, when: 'just now' }));
    return ok();
  },

  async list(body, req) {
    if (!(await requireOwner(req))) return unauthorized();
    return ok({ signups: await read(KEYS.signups, []) });
  },

  // Approving turns a request into a live code the owner can read out.
  async approve(body, req) {
    if (!(await requireOwner(req))) return unauthorized();
    const id = str(body.id, 40);
    const list = await read(KEYS.signups, []);
    const hit = list.find((r) => r.id === id);
    if (!hit) return fail('That request is no longer there.');

    const { code, codes } = await mintCode(hit.name);
    const signups = await mutate(KEYS.signups, [], (all) => all.filter((r) => r.id !== id));
    sendAsync(codeText(hit.name, code));
    return ok({ code, codes, signups });
  },

  async ignore(body, req) {
    if (!(await requireOwner(req))) return unauthorized();
    const id = str(body.id, 40);
    const signups = await mutate(KEYS.signups, [], (all) => all.filter((r) => r.id !== id));
    return ok({ signups });
  }

});
