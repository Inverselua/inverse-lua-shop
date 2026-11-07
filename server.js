// ─────────────────────────────────────────────────────────────
//  server.js — Inverse.Lua store backend.
//
//  WHAT IT DOES
//  1. Serves your storefront (the page in /public).
//  2. Creates a real Stripe Checkout Session when someone buys.
//  3. Listens for Stripe's "payment succeeded" webhook and hands
//     out one real key from inventory — server-side, so a key can
//     NEVER be claimed without a confirmed payment.
//  4. Lets the buyer's browser look up their key after returning.
//
//  THE GOLDEN RULE: the browser never decides that a payment happened.
//  Only Stripe does, and we only trust Stripe (via the webhook, or by
//  asking Stripe directly). The price is set here on the server too —
//  the browser only sends which option was chosen, never the amount.
// ─────────────────────────────────────────────────────────────

require('dotenv').config();
const express = require('express');
const path = require('path');
const Stripe = require('stripe');
const db = require('./db');

const {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  PUBLIC_URL = 'http://localhost:3000',
  ADMIN_SECRET,
  PORT = 3000,
} = process.env;

if (!STRIPE_SECRET_KEY) {
  console.error('\n  ✗ STRIPE_SECRET_KEY is missing. Copy .env.example to .env and fill it in.\n');
  process.exit(1);
}

const stripe = Stripe(STRIPE_SECRET_KEY);
const app = express();

// ── Products & prices live HERE, on the server. Never trust client prices. ──
const PRODUCTS = {
  day:   { name: 'Inverse.Lua — 1 Day Key',   amount: 299  }, // amounts in cents
  week:  { name: 'Inverse.Lua — 1 Week Key',  amount: 599  },
  month: { name: 'Inverse.Lua — 1 Month Key', amount: 1399 },
};

// ── Which payment methods are live. Stripe Checkout handles 'card' and
//    'cashapp' natively with one integration, so both are real.
//    PayPal / Venmo / Bitcoin need their own separate integrations — see README. ──
const METHOD_TO_STRIPE = {
  stripe:  ['card'],
  cashapp: ['cashapp'],
};

// ──────────────────────────────────────────────────────────────
//  IMPORTANT: the Stripe webhook needs the RAW request body to
//  verify its signature, so that route is mounted BEFORE express.json().
// ──────────────────────────────────────────────────────────────
app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    try {
      fulfill(session);
    } catch (e) {
      console.error('Fulfillment error in webhook:', e);
    }
  }
  res.json({ received: true });
});

// Everything else can parse JSON / serve files normally.
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ──────────────────────────────────────────────────────────────
//  Fulfillment — idempotent. Safe to call more than once for the
//  same session (webhook AND the browser lookup both call it); it
//  only ever hands out ONE key per order.
// ──────────────────────────────────────────────────────────────
function fulfill(session) {
  const sessionId = session.id;

  // Already fulfilled? Return the existing key.
  const existing = db.getOrder(sessionId);
  if (existing && existing.key_code) return existing;

  // Only fulfill genuinely paid sessions.
  if (session.payment_status !== 'paid') return existing || null;

  const duration = session.metadata?.duration;
  const method = session.metadata?.method || 'card';
  const email = session.customer_details?.email || session.metadata?.email || '';

  if (!PRODUCTS[duration]) {
    console.error('Paid session with unknown duration:', sessionId, duration);
    return null;
  }

  // Claim one key atomically.
  const code = db.claimKey(duration, sessionId);
  if (!code) {
    // Paid but we're out of stock — record the order with no key so it shows
    // up in your admin list, and alert yourself. You should refund or restock.
    db.saveOrder({ sessionId, email, duration, amount: session.amount_total, method, keyCode: null });
    console.error('⚠️  OUT OF STOCK — paid order with no key to give:', sessionId, duration, email);
    return db.getOrder(sessionId);
  }

  db.saveOrder({ sessionId, email, duration, amount: session.amount_total, method, keyCode: code });
  console.log(`✓ Fulfilled ${sessionId} — ${duration} → ${code} → ${email}`);
  return db.getOrder(sessionId);
}

// ──────────────────────────────────────────────────────────────
//  POST /api/checkout — create a Stripe Checkout Session.
//  Body: { option: 'day'|'week'|'month', email, method: 'stripe'|'cashapp' }
// ──────────────────────────────────────────────────────────────
app.post('/api/checkout', async (req, res) => {
  try {
    const { option, email, method } = req.body || {};
    const product = PRODUCTS[option];
    const stripeMethods = METHOD_TO_STRIPE[method];

    if (!product) return res.status(400).json({ error: 'Invalid product option.' });
    if (!stripeMethods) return res.status(400).json({ error: 'That payment method is not available yet.' });
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'A valid email is required.' });
    }

    // Don't take money we can't fulfill.
    if (db.availableCount(option) < 1) {
      return res.status(409).json({ error: 'Sorry — this key is out of stock right now.' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: email,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: product.name },
          unit_amount: product.amount,
        },
        quantity: 1,
      }],
      metadata: { duration: option, method: method, email },
      success_url: `${PUBLIC_URL}/?paid=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_URL}/?canceled=1`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: 'Could not start checkout. Please try again.' });
  }
});

// ──────────────────────────────────────────────────────────────
//  GET /api/order/:sessionId — the browser calls this after returning
//  from Stripe to fetch the key. Works even if the webhook hasn't fired
//  yet (or isn't configured): it asks Stripe directly and fulfills on
//  demand, idempotently.
// ──────────────────────────────────────────────────────────────
app.get('/api/order/:sessionId', async (req, res) => {
  try {
    const sessionId = req.params.sessionId;

    // Fast path: already fulfilled.
    let order = db.getOrder(sessionId);
    if (order && order.key_code) {
      return res.json({ status: 'complete', key: order.key_code, duration: order.duration, email: order.email });
    }

    // Ask Stripe whether this session is actually paid, then fulfill.
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status === 'paid') {
      order = fulfill(session);
      if (order && order.key_code) {
        return res.json({ status: 'complete', key: order.key_code, duration: order.duration, email: order.email });
      }
      // Paid but no key available.
      return res.json({ status: 'out_of_stock' });
    }

    // Not paid yet (or still processing, e.g. Cash App can take a moment).
    return res.json({ status: 'pending' });
  } catch (err) {
    console.error('Order lookup error:', err);
    res.status(500).json({ error: 'Could not look up your order.' });
  }
});

// Public stock, so the storefront can grey out sold-out options.
app.get('/api/stock', (req, res) => res.json(db.stock()));

// ──────────────────────────────────────────────────────────────
//  Admin — protected by the ADMIN_SECRET header. Load keys & check stock
//  without the command line if you prefer.
// ──────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (!ADMIN_SECRET || req.headers['x-admin-secret'] !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.post('/api/admin/keys', requireAdmin, (req, res) => {
  const { duration, codes } = req.body || {};
  if (!['day', 'week', 'month'].includes(duration) || !Array.isArray(codes)) {
    return res.status(400).json({ error: 'Send { duration: "day|week|month", codes: ["..."] }' });
  }
  const added = db.addKeys(duration, codes);
  res.json({ added, stock: db.stock() });
});

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const rows = db.db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 200').all();
  res.json(rows);
});

app.get('/api/admin/stock', requireAdmin, (req, res) => res.json(db.stock()));

app.listen(PORT, () => {
  console.log(`\n  Inverse.Lua store running → ${PUBLIC_URL}  (port ${PORT})\n`);
});
