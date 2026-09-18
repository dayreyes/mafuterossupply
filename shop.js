// Shop configuration and catalogue.
//
// Reads are public (a customer needs the menu); every write requires an owner
// session. Actions: menu · config · saveConfig · saveProduct · removeProduct ·
// setStock · testTelegram

import { route, ok, fail, unauthorized, str, num } from './lib/http.js';
import { read, write, mutate, KEYS } from './lib/store.js';
import { requireOwner } from './lib/session.js';
import { defaultConfig, cleanConfig, cleanProduct, publicConfig, publicProduct, migrateProduct, shopOpen, loadConfig } from './lib/config.js';
import {
  send, configured as telegramConfigured,
  pushTo, pushConfigured, everyoneListening, listenerCount, newStrainMsg, openedMsg, runMsg
} from './lib/notify.js';


// A shop is "set up" only when a customer could actually complete an order:
// it has a name, at least one enabled payment method, and something to sell.
const isComplete = (cfg, products) =>
  !!cfg.shopName && cfg.payments.some((p) => p.enabled) && products.some((p) => p.active);

export default async (req) => route(req, {

  // What a customer sees: enabled payment methods, live zones, in-stock items.
  async menu() {
    const cfg = await loadConfig();
    const products = (await read(KEYS.products, [])).map(migrateProduct);
    const hours = shopOpen(cfg);
    return ok({
      config: publicConfig(cfg),
      // So the menu can say "closed, opens at 10:00" instead of letting someone
      // fill a bag and only find out when they try to send it.
      open: hours.open,
      opensAt: hours.opensAt || '',
      products: products.filter((p) => p.active).map(publicProduct)
    });
  },

  // The owner's full view, including hidden products and disabled methods.
  async config(body, req) {
    if (!(await requireOwner(req))) return unauthorized();
    const cfg = await loadConfig();
    const products = (await read(KEYS.products, [])).map(migrateProduct);
    return ok({
      config: cfg, products, telegram: telegramConfigured(),
      // Whether this shop can send at all, and how many people would hear it.
      // Without the VAPID keys the toggles are decoration, so the screen says so
      // rather than letting him switch on something that cannot send.
      pushReady: pushConfigured(),
      listeners: await listenerCount()
    });
  },

  async saveConfig(body, req) {
    if (!(await requireOwner(req))) return unauthorized();
    const current = await loadConfig();
    const products = await read(KEYS.products, []);
    const next = cleanConfig(body.config, current);
    next.setupComplete = isComplete(next, products);
    await write(KEYS.config, next);

    // Two transitions are genuine news; the rest of a settings save is not.
    //
    // Deliberately transitions, not states: saving the same settings twice must
    // not tell everybody the shop opened twice. And both are read from what
    // actually changed between the stored config and the new one, so a save
    // that touches only the fee ladder says nothing to anyone.
    const wasOpen = shopOpen(current).open;
    const nowOpen = shopOpen(next).open;
    const msgs = [];
    if (!wasOpen && nowOpen && next.notifs && next.notifs.opened) {
      msgs.push(openedMsg(next, next.hours && next.hours.on ? next.hours.close : ''));
    }
    const runWas = !!(current.run && current.run.on);
    const runNow = !!(next.run && next.run.on);
    if (!runWas && runNow && next.notifs && next.notifs.run) {
      msgs.push(runMsg(next, next.run.start + '\u2013' + next.run.end));
    }
    if (msgs.length) {
      const listeners = await everyoneListening();
      for (const m of msgs) await pushTo(listeners, m);
    }
    return ok({ config: next, listeners: await listenerCount() });
  },

  // Creates when there's no id, updates in place when there is.
  async saveProduct(body, req) {
    if (!(await requireOwner(req))) return unauthorized();
    const id = str(body.product && body.product.id, 40);
    let error = null;
    // Whether this was an insert, and what came out of it — needed after the
    // write to decide if there is any news to tell anyone.
    let isNew = false;
    let saved = null;
    const products = await mutate(KEYS.products, [], (raw) => {
      const list = raw.map(migrateProduct);
      const idx = id ? list.findIndex((p) => p.id === id) : -1;
      const built = cleanProduct(body.product || {}, idx > -1 ? idx : list.length, idx > -1 ? list[idx] : null);
      if (built.error) { error = built.error; return list; }
      saved = built.product;
      isNew = idx < 0;
      if (idx > -1) { const next = list.slice(); next[idx] = built.product; return next; }
      return list.concat([built.product]);
    });
    if (error) return fail(error);

    const cfg = await loadConfig();
    const complete = isComplete(cfg, products);
    if (complete !== cfg.setupComplete) await write(KEYS.config, { ...cfg, setupComplete: complete });
    // A strain landing on the menu is the one piece of shop news worth a
    // message. Only when it is genuinely new and visible: an edit to something
    // already listed is not news, and neither is one switched off.
    if (isNew && saved && saved.active !== false && cfg.notifs && cfg.notifs.newStrain) {
      await pushTo(await everyoneListening(), newStrainMsg(cfg, saved.name, saved.type));
    }
    return ok({ products });
  },

  // Show or hide without deleting. A tray he only cooks occasionally gets
  // switched off between times, keeping its prices and description for next
  // time; hidden items never reach the customer menu.
  async toggleProduct(body, req) {
    if (!(await requireOwner(req))) return unauthorized();
    const id = str(body.id, 40);
    const products = await mutate(KEYS.products, [], (raw) =>
      raw.map(migrateProduct).map((p) => (p.id === id ? { ...p, active: body.active === true } : p))
    );
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
    const products = await mutate(KEYS.products, [], (raw) =>
      raw.map(migrateProduct).map((p) => {
        if (p.id !== id) return p;
        const next = body.to !== undefined
          ? num(body.to, 0, 1000000, p.stock)
          : Math.max(0, (p.stock || 0) + num(body.delta, -100000, 100000, 0));
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
