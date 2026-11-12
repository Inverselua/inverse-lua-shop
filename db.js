// ─────────────────────────────────────────────────────────────
//  db.js — the key vault.
//
//  Uses SQLite (a single file on disk). This is simple and works
//  great on hosts with a persistent disk (Railway, Render, Fly).
//
//  ⚠️  It does NOT work on serverless hosts (Vercel/Netlify functions)
//      because their filesystem is wiped between requests. If you
//      deploy there, swap this file for a Postgres version — the
//      function names below are the only thing the rest of the app
//      depends on, so keep those the same.
// ─────────────────────────────────────────────────────────────

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// Keep the DB file in ./data so hosts can mount a persistent volume there.
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'store.db'));
db.pragma('journal_mode = WAL');

// ---- Schema ----
db.exec(`
  CREATE TABLE IF NOT EXISTS keys (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    duration   TEXT    NOT NULL,                 -- product code (SKU), see products.js
    code       TEXT    NOT NULL UNIQUE,          -- the actual license key
    status     TEXT    NOT NULL DEFAULT 'available', -- 'available' | 'sold'
    order_id   TEXT,                             -- which order claimed it
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS orders (
    session_id TEXT    PRIMARY KEY,              -- Stripe Checkout Session id
    email      TEXT,
    duration   TEXT,
    amount     INTEGER,                          -- cents
    method     TEXT,
    key_code   TEXT,                             -- the delivered key (null until fulfilled)
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_keys_lookup ON keys (duration, status);
`);

// ---- Key inventory ----

// Add one or more keys for a duration. Ignores duplicates. Returns count added.
function addKeys(duration, codes) {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO keys (duration, code, status, created_at)
     VALUES (?, ?, 'available', ?)`
  );
  const now = Date.now();
  const tx = db.transaction((list) => {
    let n = 0;
    for (const code of list) {
      const info = insert.run(duration, String(code).trim(), now);
      n += info.changes;
    }
    return n;
  });
  return tx(codes.filter(Boolean));
}

// How many unused keys are available per duration.
function stock(skus = []) {
  const rows = db.prepare(
    `SELECT duration, COUNT(*) AS n FROM keys WHERE status = 'available' GROUP BY duration`
  ).all();
  const out = {};
  for (const sku of skus) out[sku] = 0;
  for (const r of rows) out[r.duration] = r.n;
  return out;
}

function availableCount(duration) {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM keys WHERE duration = ? AND status = 'available'`
  ).get(duration);
  return row ? row.n : 0;
}

// Atomically claim one available key for an order. Returns the code, or null
// if none are left. Safe against two orders grabbing the same key.
const claimKey = db.transaction((duration, orderId) => {
  const row = db.prepare(
    `SELECT id, code FROM keys
     WHERE duration = ? AND status = 'available'
     ORDER BY id LIMIT 1`
  ).get(duration);
  if (!row) return null;
  db.prepare(
    `UPDATE keys SET status = 'sold', order_id = ? WHERE id = ?`
  ).run(orderId, row.id);
  return row.code;
});

// ---- Orders ----

function getOrder(sessionId) {
  return db.prepare(`SELECT * FROM orders WHERE session_id = ?`).get(sessionId);
}

function saveOrder({ sessionId, email, duration, amount, method, keyCode }) {
  db.prepare(
    `INSERT OR REPLACE INTO orders (session_id, email, duration, amount, method, key_code, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(sessionId, email, duration, amount, method, keyCode, Date.now());
}

module.exports = {
  db,
  addKeys,
  stock,
  availableCount,
  claimKey,
  getOrder,
  saveOrder,
};
