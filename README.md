# Inverse.Lua — real key store

A working storefront that takes **real payments** and delivers a **real key**
instantly. Card and Cash App go live through Stripe. The key is only released
after Stripe confirms the payment, server-side, so a key can never be claimed
without paying.

---

## What you need to get (the shopping list)

| # | Thing | Where | Cost |
|---|-------|-------|------|
| 1 | **A Stripe account** | [stripe.com](https://stripe.com) | Free to open; Stripe takes ~2.9% + 30¢ per sale |
| 2 | **A host to run the server** | [Railway](https://railway.app) or [Render](https://render.com) | Free tier to start |
| 3 | **A domain name** (optional) | [Namecheap](https://namecheap.com) / [Cloudflare](https://cloudflare.com) | ~$10/year |
| 4 | **Your actual Inverse.Lua keys** | You generate these | — |

That's it. You do **not** need to write any code — it's all here.

> ⚠️ **Before you rely on this:** Stripe (and Square/PayPal) review what you
> sell. Payment processors often **prohibit** game cheats, exploits, or script
> executors in their acceptable-use policies and can freeze funds or close the
> account if that's what this is. Read Stripe's Restricted Businesses list and
> Prohibited Products policy first. If card processors won't take it, a crypto
> processor (Coinbase Commerce / BTCPay) is the usual fallback — see the end.

---

## How it fits together

```
Buyer's browser ──► your site (this project)
                       │  POST /api/checkout
                       ▼
                 Stripe Checkout (buyer pays on Stripe's page)
                       │  webhook: "payment succeeded"
                       ▼
                 your server pulls ONE unused key → marks it sold
                       │
                       ▼
                 buyer returns, sees their key on-screen
```

---

## Setup — step by step

### 1. Get the code onto your computer
Unzip this folder. Open a terminal inside it. Make sure you have
[Node.js](https://nodejs.org) 18+ installed (`node --version` to check).

Install the dependencies:
```bash
npm install
```

### 2. Get your Stripe keys
1. Make a Stripe account.
2. Go to **Developers → API keys**. Copy your **Secret key** (`sk_test_…` while
   testing).

### 3. Make your settings file
Copy `.env.example` to `.env` and fill it in:
```bash
cp .env.example .env
```
- `STRIPE_SECRET_KEY` — the `sk_test_…` key from step 2
- `ADMIN_SECRET` — make up a long random password
- `PUBLIC_URL` — leave as `http://localhost:3000` for now
- Leave `STRIPE_WEBHOOK_SECRET` blank for local testing (step 6 explains it)

### 4. Load your keys
Put your real keys in a text file, one per line (see `keys-example.txt`), then:
```bash
node scripts/add-keys.js day   keys-day.txt
node scripts/add-keys.js week  keys-week.txt
node scripts/add-keys.js month keys-month.txt
```
Check stock any time:
```bash
node scripts/add-keys.js --stock
```

### 5. Run it locally
```bash
npm start
```
Open **http://localhost:3000**. Buy a key with Stripe's test card
`4242 4242 4242 4242`, any future date, any CVC. You'll be redirected to
Stripe, pay, come back, and your real key appears. 🎉

> Locally, the browser lookup fulfills the order directly from Stripe, so it
> works even without the webhook. In production you still want the webhook
> (step 6) so keys are delivered even if the buyer closes the tab.

### 6. Put it on the web (Railway — easiest)
1. Push this folder to a **GitHub** repo (or use Railway's "deploy from
   folder").
2. On [Railway](https://railway.app): **New Project → Deploy from GitHub**.
3. Add a **Volume** mounted at `/app/data` so your key database survives
   restarts (Settings → Volumes). *(Skip this and you lose your keys on every
   redeploy.)*
4. In **Variables**, add everything from your `.env`:
   `STRIPE_SECRET_KEY`, `ADMIN_SECRET`, and set `PUBLIC_URL` to the URL Railway
   gives you (e.g. `https://inverse-lua.up.railway.app`).
5. Deploy. Visit your URL.

Render is the same idea: New Web Service → connect repo → add a **Disk** at
`/app/data` → add the same environment variables → `npm start` as the start
command.

### 7. Turn on the Stripe webhook (so delivery is bulletproof)
1. Stripe Dashboard → **Developers → Webhooks → Add endpoint**.
2. Endpoint URL: `https://YOUR-URL/api/webhook`
3. Events to send: **`checkout.session.completed`**
4. Copy the **Signing secret** (`whsec_…`) and add it to your host's variables
   as `STRIPE_WEBHOOK_SECRET`. Redeploy.

### 8. Go live for real money
1. In Stripe, flip from **Test mode** to **Live mode** (top of dashboard) and
   complete account activation (business details, bank account).
2. Swap your `STRIPE_SECRET_KEY` for the **live** one (`sk_live_…`) and create a
   **live** webhook (repeat step 7 in live mode) for `STRIPE_WEBHOOK_SECRET`.
3. Point your domain at the host (each host has a "custom domain" setting) and
   update `PUBLIC_URL` to your domain.

Done — you're taking real payments.

---

## Managing the store

- **Add more keys:** `node scripts/add-keys.js week more-keys.txt`
- **Check stock:** `node scripts/add-keys.js --stock`
- **See recent orders:** visit `https://YOUR-URL/api/admin/orders` with the
  header `x-admin-secret: <your ADMIN_SECRET>` (use a tool like the browser
  extension "ModHeader", or `curl`).
- **Change prices:** edit `PRODUCTS` in `server.js` (amounts are in cents) and
  the display prices in `public/index.html` (`OPTIONS`). Keep them in sync.

If a buyer pays while you're out of stock, the order is logged with no key and
the server prints a loud `⚠️ OUT OF STOCK` line — restock and email them, or
refund from the Stripe dashboard.

---

## Adding the other payment methods later

The storefront already shows PayPal, Venmo, and Bitcoin as "unavailable". To
make them real:

- **PayPal + Venmo:** one integration via the **PayPal JavaScript SDK + Orders
  API** (Venmo is just a toggle on the same PayPal order, US mobile only). Add a
  `/api/paypal/*` pair of routes that create and capture an order, then call the
  same `fulfill()` logic. Remove `'paypal'`/`'venmo'` from `UNAVAILABLE` in
  `public/index.html`.
- **Bitcoin:** easiest is **Coinbase Commerce** (hosted charge + webhook) or
  self-hosted **BTCPay Server**. On their "confirmed" webhook, call `fulfill()`.
  Remove `'bitcoin'` from `UNAVAILABLE`.

The fulfillment code is written to be reused — each new processor just needs to
confirm payment and then hand its order to the same key-release step.

---

## Files

```
server.js            the backend: checkout, webhook, fulfillment, admin
db.js                the key + order database (SQLite)
scripts/add-keys.js  load keys / check stock from the terminal
public/index.html    the storefront
.env.example         copy to .env and fill in
keys-example.txt     the format for a key list
```
