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
| `VAPID_PUBLIC_KEY` | Optional | Lets the shop send automatic messages to customers. See below. |
| `VAPID_PRIVATE_KEY` | Optional | The other half of the pair. **This one is the password to send as your shop — never put it in the repo.** |
| `VAPID_CONTACT` | Optional | An email a push service can complain to. Never shown to a customer. |

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

## 4b. Automatic messages to customers (optional)

Separate from the Telegram alerts above: those go to the owner, these go to the
people buying. He writes none of them.

**Generate a key pair once**, on any machine with Node:

```
npx web-push generate-vapid-keys
```

Put the public key in `VAPID_PUBLIC_KEY`, the private one in
`VAPID_PRIVATE_KEY`, then redeploy. Until both are set the app says so on the
settings screen and offers customers nothing — it never shows a switch that
cannot work.

**Two switches have to agree before anything sends.** The owner picks which
kinds the shop sends at all (**Settings → Automatic messages**), and each
customer decides separately whether to receive any (**Profile → Want the heads
up?**). Neither can volunteer the other.

| Kind | When it fires | Who gets it |
|---|---|---|
| Something new landed | A strain is added to the menu — not edited, not hidden | Everyone opted in |
| We opened | The shop goes from closed to open | Everyone opted in |
| Delivery is rolling | Tonight's run is switched on | Everyone opted in |
| Their order moved | An order is accepted, packed or handed over | Only that customer |
| Something they buy is nearly gone | Stock drops low — off by default | Only people who have bought it before |

Deliberate limits, so people do not switch these off:

- An **edit** to an existing strain is not news, and neither is a hidden one.
- Saving settings twice does not announce opening twice — it fires on the
  transition, not the state.
- Advancing an order already at the last step sends nothing.
- "Nearly gone" never fires once it has actually run out; there is nothing to
  come in for.
- Revoking a code stops that person's messages along with everything else.

> **iPhone:** Safari only allows these once the app has been **added to the home
> screen**. In a normal tab there is no permission to grant, and the app says so
> rather than leaving a dead switch. Android and desktop Chrome work from a tab.

**What is not built yet:** a "closing soon" message. That needs something
running on a timer rather than reacting to an action, which is a scheduled
function — worth adding if the rest proves useful.

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

1. A new person opens it and fills in name, phone, address and date of birth.
   Under-21 is rejected — the age is recalculated on the server, so it can't be
   faked from the browser.
2. The request lands in the owner's **Codes** tab (and Telegram, if configured).
3. The owner taps **Give a code** and reads out the 4-digit code.
4. The customer enters that code and shops.

There's no ID upload. The link only goes to people he has already met, so a
photo of a licence sitting on a server is a liability with nothing to show for
it.

Two ways to take a code out of circulation, and they differ:

- **Revoke** turns it off. The code stops working, the customer stays in the
  list, their order history is kept. This is the usual one.
- **Delete** removes them entirely. Two taps, and it cannot be undone.

Each row shows what that customer has actually bought — **"4 orders · $215"**
with **"Last: Aug 27"** underneath — counted from the orders themselves.

Customers have a **Profile** tab of their own: their recent orders, and their
name, number and address to correct themselves. He was fixing misheard names
and wrong doors by hand — the person who knows the address is the one standing
at it. A customer can only ever reach their own record; the code is taken from
their session, never from what the app sends.

---

## 7. Store hours (not the same as the delivery run)

Two separate schedules doing different jobs:

- **Store hours** — **Settings → Store hours.** Whether the shop takes an order
  at all, pickup or delivery. Opening time, closing time, and which days. A
  closing time earlier than the opening time runs past midnight, so 6pm–2am is
  a normal Friday and the app says so out loud.
- **Delivery run** — **Settings → Delivery run.** The narrower window inside
  that, for when he is actually driving.

A delivery needs **both**: the shop open *and* the run on. A pickup needs only
the shop open. Neither setting stands in for the other.

Outside hours the menu says "The shop is closed — opens again at 10:00" and the
send button stops working. It is enforced on the server too, so nothing gets
slipped through at 3am by a browser that disagrees.

**Closed right now** underneath is the manual override for a day off; it
ignores the schedule until switched back.

Hours are **off by default**, which leaves the shop always-open exactly as
before.

---

## 8. What he paid, and profit

Each strain takes a **cost per gram** (or per unit) and a **supplier**, under
Stock → add or edit. Both were living on paper, which is why the app could
report takings but never margin.

- The form works out the margin as he types, so a cost that makes no sense is
  obvious before saving rather than a month later.
- Sales shows **Profit** under the takings figure, for whichever window is
  selected.
- Cost left blank is not treated as free. The app says "No cost recorded for X,
  so profit reads high" rather than reporting the whole sale as margin.
- **Neither cost nor supplier ever reaches a customer.** The menu sends an
  explicit allowlist of fields and they are not on it.

---

## 9. Reading the Sales screen

The money card switches between **Today / This week / This month**. Underneath:

| Block | What it is for |
|---|---|
| **Who owes you** | Named, with the amount and how long it has sat. Oldest first. |
| **Re-up soon** | Days of stock left at the pace it is actually selling — "19g on hand · 5.5g a day · 3 days left" — and who to get it from. |
| **Gone quiet** | Someone who bought more than once and then stopped, with their number. A one-off going quiet is not news; a regular is. |
| **Sitting there** | On the shelf, on the menu, untouched for three weeks. |
| **How the shop moves** | Busiest hours, busiest days, and which sizes people actually buy. |

Each block disappears when empty, so a quiet week is a short screen rather than
a wall of zeroes. Patterns stay hidden below five orders, because three orders
make a very confident chart out of nothing.

---

## 10. Cash versus paying up front

Not the same offer, and the app no longer pretends otherwise:

- **Cash** is **ASAP only**. Nothing is set aside for money that has not
  arrived, so it is come-and-get-it with the hold clock running. No time slots.
- **Zelle / Venmo / CashApp** — money already in hand — **can pick a time**, and
  that order is set aside under their name with no hold clock.

Enforced on the server, so it cannot be worked around from a browser.

---

## 11. Cancelling, archiving and deleting orders

Three buttons, three different things:

- **Cancel** (the round ✕) — stays on the books marked cancelled, and everything
  in it goes **back on the shelf**. Stops counting towards the day's money.
- **Archive** — appears once an order is finished or cancelled. Leaves the queue
  and the run but is still there under **View archived**, and still counts in
  takings. This is how the queue gets cleared without throwing away the record.
- **Delete** — gone for good, two taps. If it had not already been cancelled,
  its stock comes back first.

**Taken today** is money actually in hand. Anything still owed shows separately
as **Still to collect**, so the figure is never inflated by unpaid orders.

---

## Testing it

```bash
npm test
```

One file, `selftest.mjs`, at the repo root. It assembles the backend folder the
same way Netlify does at deploy time, then drives the real handlers against an
in-memory store — no network, no deploy, about 140 checks. It is a single flat
file on purpose: a `test/` folder does not survive the GitHub web uploader.

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
