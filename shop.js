// Shop configuration and catalogue.
//
// Reads are public (a customer needs the menu); every write requires an owner
// session. Actions: menu · config · saveConfig · saveProduct · removeProduct ·
// setStock · testTelegram

import { route, ok, fail, unauthorized, str, num } from './lib/http.js';
import { read, write, mutate, KEYS } from './lib/store.js';
import { requireOwner } from './lib/auth.js';
import { defaultConfig, cleanConfig, cleanProduct, publicConfig, publicProduct } from './lib/shop.js';
import { send, configured as telegramConfigured } from './lib/notify.js';

const loadConfig = () => read(KEYS.config, defaultConfig());

// A shop is "set up" only when a customer could actually complete an order:
// it has a name, at least one enabled payment method, and something to sell.
const isComplete = (cfg, products) =>
  !!cfg.shopName && cfg.payments.some((p) => p.enabled) && products.some((p) => p.active);

export default async (req) => route(req, {

  // What a customer sees: enabled payment methods, live zones, in-stock items.
  async menu() {
    const cfg = await loadConfig();
    const products = await read(KEYS.products, []);
    return ok({
      config: publicConfig(cfg),
      products: products.filter((p) => p.active).map(publicProduct)
    });
  },

  // The owner's full view, including hidden products and disabled methods.
  async config(body, req) {
    if (!(await requireOwner(req))) return unauthorized();
    const cfg = await loadConfig();
    const products = await read(KEYS.products, []);
    return ok({ config: cfg, products, telegram: telegramConfigured() });
  },

  async saveConfig(body, req) {
    if (!(await requireOwner(req))) return unauthorized();
    const current = await loadConfig();
    const products = await read(KEYS.products, []);
    const next = cleanConfig(body.config, current);
    next.setupComplete = isComplete(next, products);
    await write(KEYS.config, next);
    return ok({ config: next });
  },

  // Creates when there's no id, updates in place when there is.
  async saveProduct(body, req) {
    if (!(await requireOwner(req))) return unauthorized();
    const id = str(body.product && body.product.id, 40);
    let error = null;
    const products = await mutate(KEYS.products, [], (list) => {
      const idx = id ? list.findIndex((p) => p.id === id) : -1;
      const built = cleanProduct(body.product || {}, idx > -1 ? idx : list.length, idx > -1 ? list[idx] : null);
      if (built.error) { error = built.error; return list; }
      if (idx > -1) { const next = list.slice(); next[idx] = built.product; return next; }
      return list.concat([built.product]);
    });
    if (error) return fail(error);

    const cfg = await loadConfig();
    const complete = isComplete(cfg, products);
    if (complete !== cfg.setupComplete) await write(KEYS.config, { ...cfg, setupComplete: complete });
    return ok({ products });
  },

  async removeProduct(body, req) {
    if (!(await requireOwner(req))) return unauthorized();
    const id = str(body.id, 40);
    const products = await mutate(KEYS.products, [], (list) => list.filter((p) => p.id !== id));
    return ok({ products });
  },

  // Relative adjustment (delta) or absolute (to) — the owner dashboard uses
  // delta for the +/- buttons and absolute when typing a count.
  async setStock(body, req) {
    if (!(await requireOwner(req))) return unauthorized();
    const id = str(body.id, 40);
    const products = await mutate(KEYS.products, [], (list) =>
      list.map((p) => {
        if (p.id !== id) return p;
        const next = body.to !== undefined
          ? num(body.to, 0, 100000, p.stock)
          : Math.max(0, (p.stock || 0) + num(body.delta, -10000, 10000, 0));
        return { ...p, stock: next };
      })
    );
    return ok({ products });
  },

  // Powers the "send a test message" button in owner settings, so the owner can
  // prove the Telegram wiring works without waiting for a real order.
  async testTelegram(body, req) {
    if (!(await requireOwner(req))) return unauthorized();
    if (!telegramConfigured()) {
      return fail('Telegram is not configured. Add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in Netlify, then redeploy.');
    }
    const cfg = await loadConfig();
    const r = await send('<b>Test alert</b>\nAlerts are working for ' + (cfg.shopName || 'your shop') + '.');
    return r.sent ? ok({ sent: true }) : fail(r.reason || 'Telegram refused the message.');
  }

});
