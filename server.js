// Inverse.Lua store backend — Stripe checkout + instant key delivery + email.
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
  RESEND_API_KEY,
  FROM_EMAIL = 'Inverse.Lua <onboarding@resend.dev>',
} = process.env;

if (!STRIPE_SECRET_KEY) {
  console.error('\n  STRIPE_SECRET_KEY is missing.\n');
  process.exit(1);
}

const stripe = Stripe(STRIPE_SECRET_KEY);
const app = express();

const PRODUCTS = {
  day:   { name: 'Inverse.Lua — 1 Day Key',   amount: 299  },
  week:  { name: 'Inverse.Lua — 1 Week Key',  amount: 599  },
  month: { name: 'Inverse.Lua — 1 Month Key', amount: 1399 },
};

// Stripe webhook needs the RAW body, so this route comes BEFORE express.json().
app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  if (event.type === 'checkout.session.completed') {
    try { fulfill(event.data.object); } catch (e) { console.error('Fulfillment error:', e); }
  }
  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DURATION_NAMES = { day: '1 Day Key', week: '1 Week Key', month: '1 Month Key' };

async function sendKeyEmail(email, duration, code, amount, orderId) {
  if (!RESEND_API_KEY || !email) return;
  const label = DURATION_NAMES[duration] || 'Key';
  const price = '$' + ((amount || 0) / 100).toFixed(2);
  const date = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: email,
        subject: `Your Inverse.Lua ${label} + receipt`,
        html: `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;color:#14161c">
          <h2 style="margin:0 0 4px">Thanks for your purchase</h2>
          <p style="color:#565b67;margin:0 0 18px">Here's your key and receipt. Keep this email for your records.</p>
          <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px">
            <tr><td style="padding:7px 0;color:#565b67">Product</td><td style="padding:7px 0;text-align:right;font-weight:600">Inverse.Lua — ${label}</td></tr>
            <tr><td style="padding:7px 0;color:#565b67">Amount paid</td><td style="padding:7px 0;text-align:right;font-weight:600">${price}</td></tr>
            <tr><td style="padding:7px 0;color:#565b67">Order</td><td style="padding:7px 0;text-align:right;font-family:monospace">${orderId}</td></tr>
            <tr><td style="padding:7px 0;color:#565b67">Date</td><td style="padding:7px 0;text-align:right">${date}</td></tr>
          </table>
          <p style="color:#565b67;margin:0 0 6px;font-size:14px">Your key:</p>
          <p style="font-family:monospace;font-size:18px;font-weight:700;background:#f4f4f5;padding:14px 16px;border-radius:8px;letter-spacing:1px;word-break:break-all;margin:0 0 14px">${code}</p>
          <p style="color:#565b67;font-size:14px">Paste this key into Inverse.Lua to activate.</p>
        </div>`,
      }),
    });
    if (!res.ok) console.error('Email send failed:', res.status, await res.text());
    else console.log(`Key + receipt emailed to ${email}`);
  } catch (e) {
    console.error('Email send error:', e.message);
  }
}

// Idempotent: only ever hands out ONE key per paid order.
function fulfill(session) {
  const sessionId = session.id;
  const existing = db.getOrder(sessionId);
  if (existing && existing.key_code) return existing;
  if (session.payment_status !== 'paid') return existing || null;

  const duration = session.metadata?.duration;
  const method = session.metadata?.method || 'card';
  const email = session.customer_details?.email || session.metadata?.email || '';
  if (!PRODUCTS[duration]) { console.error('Unknown duration:', sessionId, duration); return null; }

  const code = db.claimKey(duration, sessionId);
  if (!code) {
    db.saveOrder({ sessionId, email, duration, amount: session.amount_total, method, keyCode: null });
    console.error('OUT OF STOCK — paid order with no key:', sessionId, duration, email);
    return db.getOrder(sessionId);
  }
  db.saveOrder({ sessionId, email, duration, amount: session.amount_total, method, keyCode: code });
  console.log(`Fulfilled ${sessionId} — ${duration} -> ${code} -> ${email}`);
  sendKeyEmail(email, duration, code, session.amount_total, sessionId);
  return db.getOrder(sessionId);
}

app.post('/api/checkout', async (req, res) => {
  try {
    const { option, email, method } = req.body || {};
    const product = PRODUCTS[option];
    const methodAllowed = ['stripe', 'cashapp'].includes(method);
    if (!product) return res.status(400).json({ error: 'Invalid product option.' });
    if (!methodAllowed) return res.status(400).json({ error: 'That payment method is not available yet.' });
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'A valid email is required.' });
    }
    if (db.availableCount(option) < 1) {
      return res.status(409).json({ error: 'Sorry — this key is out of stock right now.' });
    }
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      managed_payments: { enabled: false },
      payment_method_types: method === 'cashapp' ? ['cashapp'] : ['card'],
      customer_email: email,
      line_items: [{
        price_data: { currency: 'usd', product_data: { name: product.name }, unit_amount: product.amount },
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

app.get('/api/order/:sessionId', async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    let order = db.getOrder(sessionId);
    if (order && order.key_code) {
      return res.json({ status: 'complete', key: order.key_code, duration: order.duration, email: order.email });
    }
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status === 'paid') {
      order = fulfill(session);
      if (order && order.key_code) {
        return res.json({ status: 'complete', key: order.key_code, duration: order.duration, email: order.email });
      }
      return res.json({ status: 'out_of_stock' });
    }
    return res.json({ status: 'pending' });
  } catch (err) {
    console.error('Order lookup error:', err);
    res.status(500).json({ error: 'Could not look up your order.' });
  }
});

app.get('/api/stock', (req, res) => res.json(db.stock()));

function requireAdmin(req, res, next) {
  if (!ADMIN_SECRET || req.headers['x-admin-secret'] !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.post('/api/admin/keys', requireAdmin, (req, res) => {
  const { duration, codes } = req.body || {};
  if (!['day', 'week', 'month'].includes(duration) || !Array.isArray(codes)) {
    return res.status(400).json({ error: 'Send { duration, codes: [...] }' });
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
  console.log(`\n  Inverse.Lua store running -> ${PUBLIC_URL}  (port ${PORT})\n`);
});
