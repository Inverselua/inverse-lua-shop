#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
//  add-keys.js — load your real Inverse.Lua keys into the store,
//  or check how many are left.
//
//  USAGE:
//    node scripts/add-keys.js --stock
//        → prints how many unused keys you have per duration
//
//    node scripts/add-keys.js nova-day keys-day.txt
//        → loads every line of keys-day.txt as a 1-DAY key
//
//    node scripts/add-keys.js nova-week  KEY1 KEY2 KEY3
//        → loads the keys you type directly, as 1-WEEK keys
//
//  Product codes are listed in products.js (nova-day, nova-week, nova-month, fallen-standard)
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const db = require('../db');
const PRODUCTS = require('../products');
const SKUS = Object.keys(PRODUCTS);

const args = process.argv.slice(2);

if (args[0] === '--stock' || args[0] === 'stock') {
  const s = db.stock(SKUS);
  console.log('\n  In stock');
  console.log('  ────────');
  for (const sku of SKUS) console.log(`  ${PRODUCTS[sku].name.padEnd(28)} ${s[sku]}`);
  console.log('');
  process.exit(0);
}

const duration = args[0];
if (!PRODUCTS[duration]) {
  console.error('\n  ✗ First argument must be a product code: ' + SKUS.join(', '));
  console.error('    e.g.  node scripts/add-keys.js nova-week keys-week.txt\n');
  process.exit(1);
}

let codes = [];
const rest = args.slice(1);

// If the second argument is a file that exists, read keys from it (one per line).
if (rest.length === 1 && fs.existsSync(path.resolve(rest[0]))) {
  codes = fs.readFileSync(path.resolve(rest[0]), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
} else {
  // Otherwise treat the remaining arguments as literal keys.
  codes = rest;
}

if (!codes.length) {
  console.error('\n  ✗ No keys given. Pass a file or list keys after the duration.\n');
  process.exit(1);
}

const added = db.addKeys(duration, codes);
const skipped = codes.length - added;
console.log(`\n  ✓ Added ${added} "${duration}" key(s).`);
if (skipped > 0) console.log(`    (${skipped} skipped — already in the store.)`);
const s = db.stock(SKUS);
console.log(`  ${PRODUCTS[duration].name} now has ${s[duration]} in stock.\n`);
