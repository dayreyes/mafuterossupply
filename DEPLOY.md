# Deploying Mafutero's Supply

Follow this once, in order. Steps 1–3 take about ten minutes; step 5 is done by
the shop owner on their phone.

---

## 1. Pick a setup code first

The very first person to open a freshly deployed site is offered the "set up
your shop" screen — that's how the owner claims it. Until they do, anyone who
finds the URL could claim it instead.

Set a setup code **before** the first deploy and only someone who knows it can
claim the shop. Do this in step 3 (`SETUP_CODE`). It's one extra field the owner
types once and then never again.

If you skip it, the shop is claimable by whoever loads it first — so claim it
yourself within a minute of deploying and hand the PIN to the owner.

---

## 1b. Getting the files into GitHub without git

If you're working from a browser rather than a computer with git, upload through
**Add file → Upload files** on the repo page.

Everything except the backend lives at the repo root, so those files can simply
be dragged in. The backend is the one part that must be nested, and dragging a
folder is unreliable — some browsers flatten it and rename the collisions to
`auth (1).js`. Do it this way instead, which cannot flatten:

1. **Add file → Create new file.** In the filename box type:
   `netlify/functions/lib/http.js` — typing `/` creates the folders as you go.
2. Paste the contents of that file, then **Commit**.
3. Now the folders exist. Click into `netlify/functions/`, use **Add file →
   Upload files**, and drag in the five loose files: `auth.js`, `shop.js`,
   `orders.js`, `signups.js`, `codes.js`.
4. Click into `netlify/functions/lib/` and upload the remaining five:
   `session.js`, `config.js`, `invites.js`, `store.js`, `notify.js`.

No two files in the project share a name, so nothing can be uploaded into the
wrong folder without it being obvious.

**Check before deploying:** the repo file list should show a `netlify` folder,
and `netlify/functions` should contain exactly five `.js` files plus a `lib`
folder. Loose files left over at the root from an earlier attempt are harmless
— Netlify only treats `netlify/functions/*` as backend code — but they can be
deleted for tidiness.

---

## 2. Connect the repo to Netlify

1. Sign in at [app.netlify.com](https://app.netlify.com).
2. **Add new site → Import an existing project → GitHub**.
3. Pick `dayreyes/mafuterossupply`.
4. Leave the build settings alone — `netlify.toml` already sets them:
   - Build command: *(empty)*
   - Publish directory: `.`
   - Functions directory: `netlify/functions`
5. **Deploy site.**

Netlify gives the site a free HTTPS URL like `random-name-123.netlify.app`.
Rename it to something readable under **Site configuration → Site details →
Change site name** — `mafuteros-supply.netlify.app`, say.

**You do not need to buy a domain.** The free subdomain is permanent and its
certificate is automatic. Customers never type this address anyway: they get the
signup link handed to them (Settings → Signup link → Copy), so a custom domain
would only change what the link looks like in a text message. If you ever do
want one, add it under **Domain management** — but nothing here depends on it.

> This app cannot run on **GitHub Pages**. Pages serves static files only, so
> there is no server to hold the PIN, the catalogue or the orders — the app
> would correctly report that it can't reach the shop, and nobody could sign in,
> owner included. If you turned Pages on while experimenting, turn it off.

Every push to the branch redeploys automatically.

### Storage

Persistence uses **Netlify Blobs**, which is enabled automatically for sites
deployed this way — there's nothing to switch on. `@netlify/blobs` is already in
`package.json` and Netlify installs it during deploy.

To confirm it's working, open:

```
https://YOUR-SITE.netlify.app/.netlify/functions/auth
```

with a POST, or just check the app: if storage is unavailable the app shows a
"cannot save right now" screen instead of letting anyone in. It never silently
falls back to a fake mode.

> Blobs only works on a **deployed** site. Opening `index.html` from your
> desktop won't work — use `npm run dev` for local work (see below).

---

## 3. Environment variables

**Site configuration → Environment variables → Add a variable.**
Add these, then **trigger a redeploy** (env changes need one to take effect).

| Variable | Required | What it's for |
|---|---|---|
| `SETUP_CODE` | Strongly recommended | Gate on the one-time "claim this shop" screen. Any phrase you like. Can be deleted after the owner has set up. |
| `TELEGRAM_BOT_TOKEN` | Optional | Order and signup alerts. From @BotFather. |
| `TELEGRAM_CHAT_ID` | Optional | Where alerts are sent. See below. |
| `OWNER_PIN` | Emergency only | Overrides the stored PIN so a locked-out owner can get back in. Delete it again straight after. |

**Never commit any of these to the repo.** They live only in the Netlify
dashboard.

---

## 4. Telegram alerts (optional)

The app works fully without this. Alerts are a convenience — orders and signups
are already saved before any message is sent, so a broken bot can't lose an
order.

You already have the bot token from **@BotFather**. The part BotFather does
*not* give you is the **chat ID**, which is what actually routes the message.

1. **Message your own bot first.** In Telegram, search its `@username`, open it
   and tap **Start**. A bot cannot message you until you've messaged it — this
   is the step most people miss.
2. In a browser, open (with your real token):
   ```
   https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
   ```
3. Find this in the JSON:
   ```json
   "chat": { "id": 123456789, "first_name": "...", "type": "private" }
   ```
   That number is `TELEGRAM_CHAT_ID`.
4. Put both values in Netlify env vars and redeploy.
5. In the app: **Settings → Telegram alerts → Send a test**. A message should
   arrive within a second. If it doesn't, the app shows Telegram's own reason.

**If `getUpdates` returns an empty list**, you haven't messaged the bot yet — do
step 1 again.

**To send alerts to a group** instead of a private chat: create the group, add
the bot to it, send any message in the group, then re-open `getUpdates`. The
group's id is **negative** (e.g. `-1001234567890`) — include the minus sign.

---

## 5. First run — the owner sets up the shop

Send the owner the site URL and have them do this on their phone:

1. Open the link → choose a language.
2. Tap **PIN del dueño / Owner PIN**.
3. Type a **6-digit PIN**. Not a birthday, not `123456` — the app rejects
   repeated digits and straight runs. This PIN is the only thing protecting
   every customer's name, phone and address, so it should be written down
   somewhere safe and not shared.
4. Fill in the shop name (and the setup code from step 1, if you set one).
5. Repeat the PIN → **Create the shop.**

They land straight in **Settings**. Before the shop can take an order they need:

- **Shop name** — shown to customers.
- **How you get paid** — switch on Zelle / Venmo / Cash and fill in the handle
  for each. A method that's off is never offered to customers.
- **Areas** — add each delivery area with its distance in miles, then tap it to
  put it *in the run*. Areas that aren't in the run are invisible to customers.
- **Delivery run** — on/off, the daily window, and the maximum number of stops.
- **Delivery fees** — free up to X miles, a flat fee out to Y miles, then a
  step beyond that.
- **Stock tab** — add strains. Each one takes a name and a base price; the other
  weights are worked out from it automatically.

The shop only becomes orderable once it has a name, at least one payment method
switched on, and at least one product. Until then customers see "not open yet".

---

## 6. Handing out the signup link

**Settings → Signup link → Copy.** That link is the whole customer funnel:

1. A new person opens it and fills in name, phone, address, date of birth and
   ticks the ID confirmation. Under-21 is rejected — the age is recalculated on
   the server, so it can't be faked from the browser.
2. The request lands in the owner's **Codes** tab (and Telegram, if configured).
3. The owner taps **Give a code** and reads out the 4-digit code.
4. The customer enters that code and shops.

Codes can be revoked at any time from the same tab; a revoked code stops working
immediately, and the order history for that customer is kept.

---

## Running it locally

```bash
npm install
npm run dev          # http://localhost:8888
npm test             # backend + view-layer tests
```

The dev server runs the real functions in-process against **in-memory** storage.
Restart it to get a fresh, unclaimed shop — handy for re-testing the setup flow.

```bash
SETUP_CODE=letmein npm run dev            # test the setup gate
TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... npm run dev   # test real alerts
```

---

## Troubleshooting

**"Could not reach the shop"** — the functions aren't deployed. Check the deploy
log for `netlify/functions` and confirm `netlify.toml` is at the repo root.

**"Storage is unavailable"** — Blobs isn't reachable. This usually means the site
wasn't deployed through Netlify's Git integration, or the deploy failed to
install `@netlify/blobs`. Redeploy from the dashboard.

**Owner locked out** — set `OWNER_PIN` to a 6-digit number in the env vars,
redeploy, sign in with it, then delete the variable again.

**Too many failed attempts** — brute-force protection. It clears itself after
about 15 minutes; a correct PIN resets it immediately.

**Owner set the shop up on the wrong site / wants to start over** — there's no
"reset" button by design. Delete the Blobs store from **Site configuration →
Blobs**, or deploy to a fresh site.

---

## A note on the data this holds

The shop stores customers' real names, phone numbers and home addresses, plus
their order history. That's why the owner PIN is six digits rather than four,
why the PIN is hashed rather than stored, why sessions expire after 12 hours,
and why the API sends no `access-control-allow-origin` header.

Two things worth telling the owner plainly:

- **The PIN is the whole lock.** Anyone with it can read every customer's
  address. It shouldn't be reused from anything else, or shared.
- **Signing out matters** on a shared or lost phone — the session token lives in
  the browser until it expires or they sign out.

Whether the operation itself needs a licence, age-verification records, or tax
reporting is a question for the owner and their lawyer, not something the
software decides. The app records what it's told to record and nothing more.
