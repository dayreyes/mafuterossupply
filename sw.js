// Service worker — offline shell for the installed app.
//
// Two rules, and the split matters:
//
//   * The page itself is NETWORK-FIRST. The old worker was cache-first on
//     index.html with a cache name that never changed, which meant a phone that
//     installed the app once would keep running that build forever — deploy a
//     fix and the owner's phone never sees it. Now a good network response
//     always wins and refreshes the cache; the cache is only the fallback for
//     genuinely being offline.
//   * Fonts, vendor scripts and styles are CACHE-FIRST. They are large and
//     effectively immutable, so serving them from disk is the whole point.
//
// API calls are never cached. Stale order and stock data would be worse than
// an honest error, so anything under /.netlify/ bypasses the worker entirely.

const VERSION = 'v3';
const SHELL = 'mafuteros-shell-' + VERSION;
const ASSETS = 'mafuteros-assets-' + VERSION;

const SHELL_URLS = ['./', './index.html', './manifest.webmanifest'];
const ASSET_URLS = [
  './styles.css',
  './support.js',
  './fonts.css',
  './caprasimo-latin.woff2',
  './caprasimo-latin-ext.woff2',
  './figtree-latin.woff2',
  './figtree-latin-ext.woff2',
  './react.production.min.js',
  './react-dom.production.min.js',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './icon-1024.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    // addAll rejects the whole install if any single request fails, which is
    // how the previous worker silently never installed at all: it listed
    // icons/ paths while the files sat in the project root. Cache items
    // individually so one missing asset can't take the app offline.
    const shell = await caches.open(SHELL);
    await Promise.all(SHELL_URLS.map((u) => shell.add(u).catch(() => {})));
    const assets = await caches.open(ASSETS);
    await Promise.all(ASSET_URLS.map((u) => assets.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = [SHELL, ASSETS];
    const keys = await caches.keys();
    const stale = keys.filter((k) => !keep.includes(k));
    await Promise.all(stale.map((k) => caches.delete(k)));
    await self.clients.claim();

    // Reload open pages when replacing an OLDER worker.
    //
    // The first worker was cache-first on index.html with a fixed cache name,
    // so a phone that installed it kept serving a days-old build no matter what
    // was deployed — the repo was current, the deploy was current, and the
    // screen was not. Taking over from any previous worker now refreshes what
    // is on screen, so nobody is left staring at a stale app.
    //
    // Guarded on there having been a stale cache to delete, so a first install
    // (nothing to replace) does not reload, and this cannot loop: by the time
    // the reload lands, this worker's caches are the only ones left.
    if (stale.length) {
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) {
        if ('navigate' in client) client.navigate(client.url).catch(() => {});
      }
    }
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Orders, stock and auth must always be live.
  if (url.pathname.startsWith('/.netlify/')) return;

  const isPage = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');

  if (isPage) {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(SHELL);
        cache.put('./index.html', fresh.clone()).catch(() => {});
        return fresh;
      } catch {
        return (await caches.match('./index.html')) ||
          new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } });
      }
    })());
    return;
  }

  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok) {
        const cache = await caches.open(ASSETS);
        cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    } catch {
      return new Response('', { status: 504 });
    }
  })());
});
