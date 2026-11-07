#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
//  add-keys.js — load your real Inverse.Lua keys into the store,
//  or check how many are left.
//
//  USAGE:
//    node scripts/add-keys.js --stock
//        → prints how many unused keys you have per duration
//
//    node scripts/add-keys.js day keys-day.txt
//        → loads every line of keys-day.txt as a 1-DAY key
//
//    node scripts/add-keys.js week  KEY1 KEY2 KEY3
//        → loads the keys you type directly, as 1-WEEK keys
//
//  Durations are: day | week | month
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const db = require('../db');

const args = process.argv.slice(2);

if (args[0] === '--stock' || args[0] === 'stock') {
  const s = db.stock();
  console.log('\n  Keys in stock');
  console.log('  ─────────────');
  console.log(`  1 Day   : ${s.day}`);
  console.log(`  1 Week  : ${s.week}`);
  console.log(`  1 Month : ${s.month}\n`);
  process.exit(0);
}

const duration = args[0];
if (!['day', 'week', 'month'].includes(duration)) {
  console.error('\n  ✗ First argument must be: day, week, or month');
  console.error('    e.g.  node scripts/add-keys.js week keys-week.txt\n');
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
const s = db.stock();
console.log(`  Now in stock → day: ${s.day}, week: ${s.week}, month: ${s.month}\n`);
