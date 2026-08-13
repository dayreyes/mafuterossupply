// Owner and customer authentication.
//
// Actions: status · setup · login · unlock · session · logout

import { route, ok, fail, tooMany, clientIp, str } from './lib/http.js';
import { read, write, mutate, available, KEYS } from './lib/store.js';
import { defaultConfig } from './lib/config.js';
import {
  OWNER_PIN_LEN, CLIENT_CODE_LEN, hashPin, verifyPin, isOwnerPin, isClientCode,
  createSession, readSession, destroySession, bearer,
  checkThrottle, recordFailure, recordSuccess
} from './lib/session.js';
import { timingSafeEqual } from 'node:crypto';

const eq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

// Escape hatch for a forgotten PIN: set OWNER_PIN in the Netlify dashboard and
// it logs in regardless of what's stored. Unset it again once you've recovered.
const envPin = () => str(process.env.OWNER_PIN, 32);

async function configured() {
  const auth = await read(KEYS.auth, null);
  return !!(auth && auth.hash) || !!envPin();
}

export default async (req) => route(req, {

  // Public health check the app calls on boot to decide which screen to show.
  async status() {
    if (!(await available())) {
      return ok({
        backend: true, storage: false, configured: false,
        error: 'Netlify Blobs is not available for this site — see DEPLOY.md.'
      });
    }
    const cfg = await read(KEYS.config, defaultConfig());
    const products = await read(KEYS.products, []);
    return ok({
      backend: true,
      storage: true,
      configured: await configured(),
      setupComplete: !!cfg.setupComplete,
      needsSetupCode: !!process.env.SETUP_CODE,
      shopName: cfg.shopName || '',
      hasProducts: products.length > 0,
      ownerPinLength: OWNER_PIN_LEN,
      clientCodeLength: CLIENT_CODE_LEN,
      telegram: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID)
    });
  },

  // First run only: claim the shop by choosing the owner PIN.
  //
  // This is the one genuinely dangerous endpoint — whoever reaches a freshly
  // deployed site first would own it. Two guards: it refuses the moment a PIN
  // exists, and if SETUP_CODE is set in the Netlify env it must be presented
  // here. Setting SETUP_CODE before the first deploy is the recommended path
  // and DEPLOY.md says so.
  async setup(body, req) {
    const ip = clientIp(req);
    const gate = await checkThrottle('setup', ip);
    if (!gate.allowed) return tooMany('Too many attempts. Try again shortly.', gate.retryAfter);

    if (await configured()) return fail('This shop is already set up.');

    const required = str(process.env.SETUP_CODE, 128);
    if (required && !eq(required, str(body.setupCode, 128))) {
      await recordFailure('setup', ip);
      return fail('Wrong setup code.');
    }

    const pin = str(body.pin, 16);
    if (!isOwnerPin(pin)) return fail('The owner PIN must be ' + OWNER_PIN_LEN + ' digits.');
    if (/^(\d)\1+$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) {
      return fail('Pick a less guessable PIN — not all the same digit or a straight run.');
    }

    await write(KEYS.auth, hashPin(pin));
    await recordSuccess('setup', ip);
    const cfg = await read(KEYS.config, defaultConfig());
    if (body.shopName) await write(KEYS.config, { ...cfg, shopName: str(body.shopName, 60) });

    const session = await createSession('owner');
    return ok({ configured: true, ...session });
  },

  // Owner PIN -> session token.
  async login(body, req) {
    const ip = clientIp(req);
    const gate = await checkThrottle('owner', ip);
    if (!gate.allowed) {
      return tooMany(
        gate.global
          ? 'Too many failed attempts on this shop. Locked for a few minutes.'
          : 'Too many attempts. Try again in a few minutes.',
        gate.retryAfter
      );
    }

    const pin = str(body.pin, 16);
    const stored = await read(KEYS.auth, null);
    const override = envPin();
    const good = (override && eq(override, pin)) || verifyPin(pin, stored);

    if (!good) {
      await recordFailure('owner', ip);
      return fail('That PIN did not work.');
    }
    await recordSuccess('owner', ip);
    const session = await createSession('owner');
    return ok({ role: 'owner', ...session });
  },

  // Customer code -> session token. Also bumps the code's usage counters so the
  // owner can see who is actually active.
  async unlock(body, req) {
    const ip = clientIp(req);
    const gate = await checkThrottle('client', ip);
    if (!gate.allowed) return tooMany('Too many attempts. Try again in a few minutes.', gate.retryAfter);

    const code = str(body.code, 16);
    if (!isClientCode(code)) {
      await recordFailure('client', ip);
      return fail('That code did not work.');
    }

    let hit = null;
    await mutate(KEYS.codes, [], (list) => {
      hit = list.find((c) => c.code === code && c.active) || null;
      if (hit) {
        hit.uses = (hit.uses || 0) + 1;
        hit.lastSeen = new Date().toISOString();
      }
      return list;
    });

    if (!hit) {
      await recordFailure('client', ip);
      return fail('That code did not work.');
    }
    await recordSuccess('client', ip);
    const session = await createSession('client', { name: hit.name || '', code: hit.code });
    return ok({ role: 'client', name: hit.name || '', ...session });
  },

  // Lets the app restore a session after a reload instead of asking again.
  async session(body, req) {
    const s = await readSession(bearer(req));
    if (!s) return fail('no session');
    return ok({ role: s.role, name: s.name || '' });
  },

  async logout(body, req) {
    await destroySession(bearer(req));
    return ok();
  }

});
