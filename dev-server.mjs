// Local dev server — `npm run dev`, then open http://localhost:8888
//
// Serves the static site and runs the real Netlify functions in-process against
// an in-memory store, so the whole app can be exercised end to end without a
// Netlify account, a deploy, or the Netlify CLI. Data lives in memory only and
// disappears when you stop the server, which is what you want while poking at
// the setup flow: restart to get a fresh, unclaimed shop.
//
// Set TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID in your shell first if you want to
// test real alerts; otherwise alerts are skipped and logged.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { __setStoreFactory } from './netlify/functions/lib/store.js';

const root = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8888);

const mem = new Map();
__setStoreFactory(() => ({
  async get(key, opts) {
    const v = mem.get(key);
    if (v === undefined) return null;
    return opts && opts.type === 'json' ? JSON.parse(v) : v;
  },
  async set(key, val) { mem.set(key, String(val)); },
  async setJSON(key, val) { mem.set(key, JSON.stringify(val)); }
}));

const functions = {};
for (const name of ['auth', 'shop', 'orders', 'signups', 'codes']) {
  functions[name] = (await import('./netlify/functions/' + name + '.js')).default;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml'
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  const fnMatch = /^\/\.netlify\/functions\/([a-z]+)$/.exec(url.pathname);
  if (fnMatch) {
    const fn = functions[fnMatch[1]];
    if (!fn) { res.writeHead(404).end('no such function'); return; }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(url.href, {
      method: req.method,
      headers: { ...req.headers, 'x-nf-client-connection-ip': req.socket.remoteAddress || '127.0.0.1' },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks)
    });
    try {
      const out = await fn(request);
      const body = Buffer.from(await out.arrayBuffer());
      res.writeHead(out.status, Object.fromEntries(out.headers)).end(body);
    } catch (err) {
      console.error(err);
      res.writeHead(500, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: false, error: String(err && err.message) }));
    }
    return;
  }

  // Static files, with the path confined to the project directory.
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel.endsWith('/')) rel += 'index.html';
  const file = join(root, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(root)) { res.writeHead(403).end('nope'); return; }
  try {
    const buf = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store'
    }).end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}).listen(PORT, () => {
  console.log('Mafutero\'s Supply dev server → http://localhost:' + PORT);
  console.log('In-memory storage: restart for a fresh, unclaimed shop.');
  if (process.env.SETUP_CODE) console.log('SETUP_CODE is set — first-run setup will ask for it.');
});
