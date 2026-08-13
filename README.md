# Mafutero's Supply

An invite-only storefront: the owner runs their catalogue, stock, delivery run
and customer codes from their phone; customers get in with a 4-digit code, browse
the menu and place orders. Bilingual (Spanish / English), installable as a PWA.

**Deployment and first-run setup: [DEPLOY.md](DEPLOY.md).**

---

## How it fits together

A static front end plus a handful of Netlify Functions over Netlify Blobs. No
build step, no framework tooling — `index.html` is the app and is edited
directly.

Static assets sit at the repo root rather than in `fonts/`, `vendor/` and
`icons/`, and no two files anywhere share a name. That is deliberate: the site
is maintained through the GitHub web UI, which flattens dragged folders on some
browsers and silently renames the collisions. Only `netlify/functions` needs to
be nested, because that path is what tells Netlify where the backend lives.

```
index.html            The whole front end: markup template + application logic
support.js            dc-runtime — renders the {{ }} template with React (vendored, unmodified)
styles.css            Design-system tokens and component classes
fonts.css + *.woff2   Self-hosted Figtree + Caprasimo (no CDN, works offline)
react*.min.js         React 18.3.1 UMD (self-hosted for the same reason)
icon-*.png            PWA icons
sw.js                 Service worker: network-first page, cache-first assets
manifest.webmanifest  PWA manifest

netlify/functions/
  auth.js             status · setup · login · unlock · session · logout
  shop.js             menu · config · saveConfig · saveProduct · removeProduct · setStock · testTelegram
  orders.js           place · mine · list · advance · stepBack · patch · cancel
  signups.js          submit · list · approve · ignore
  codes.js            list · issue · revoke · remove
  lib/                store · session · http · config · invites · notify

dev-server.mjs        Local server: real functions, in-memory storage
test/                 Backend and view-layer tests
```

### The front end

`index.html` holds two things:

- an `<x-dc>` **template** — plain HTML with `{{ binding }}` interpolation,
  `<sc-if>` for conditionals and `<sc-for>` for lists;
- a `<script type="text/x-dc">` **logic class** — state, API calls, and one
  `renderVals()` method that returns every value the template binds to.

To change what's on screen, edit the markup. To change what it says, edit the
`COPY` object (both `es` and `en`). To change what a value *is*, edit
`renderVals()`.

### Rules the code sticks to

**The server prices every order.** The browser sends only what was picked —
product id, weight index, quantity — and the total is computed from the stored
catalogue. Nothing about money is trusted from the client.

**There is no demo mode.** If the backend can't be reached, the app says so and
lets nobody in. The prototype's fallback let any 4-digit code through whenever
the network hiccuped.

**Nothing is seeded.** A fresh deploy has no products, no zones, no payment
handles, no orders. Every figure on screen is derived from real data, and the
test suite fails the build if a number is typed into the markup.

**Customers see only their own data.** `orders.mine` filters by the code on the
session; owner endpoints require an owner session, checked per request.

---

## Working on it

```bash
npm install
npm run dev     # http://localhost:8888 — real functions, in-memory storage
npm test        # backend + view-layer tests
```

The dev server keeps everything in memory, so restarting gives you a fresh
unclaimed shop — which is the easiest way to re-test the first-run flow.

### Tests

`npm test` runs two suites, neither of which needs a network or a deploy:

- **`test/smoke.mjs`** drives the real function handlers through real `Request`
  objects against an in-memory store: setup, login, throttling, config
  validation, signup age checks, server-side pricing, stock movement, code
  revocation.
- **`test/bindings.mjs`** pulls the logic out of `index.html`, runs
  `renderVals()` across nine app states in both languages, and asserts that
  every `{{ binding }}` the template uses actually resolves — plus a guard
  against demo data or hardcoded figures creeping back in.

A missing binding renders as a visible grey placeholder in the real app, so the
second suite is what stops that reaching someone's phone.

### Security posture

The owner PIN is 6 digits, scrypt-hashed with a per-shop salt and compared in
constant time. Logging in mints an opaque random token — only its SHA-256 is
stored — so the PIN stops travelling after sign-in. Failed attempts are throttled
per IP *and* globally, because per-IP alone is defeated by rotating addresses.
Customer codes come from `crypto.randomInt`, not `Math.random`.

`netlify.toml` sets CSP, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`
and a `Permissions-Policy`. The functions send no CORS header, so no other
website can replay a stolen code against the shop.

---

## Licence

See [LICENSE](LICENSE).
