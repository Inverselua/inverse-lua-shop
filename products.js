// ─────────────────────────────────────────────────────────────
//  products.js — every item the store sells, in one place.
//  The key on the left is the product code (SKU). Amounts are in cents.
//  To change a price, edit it here AND the display price in public/index.html.
//  To add a product, add a line here and an option in public/index.html.
// ─────────────────────────────────────────────────────────────
module.exports = {
  'nova-day':        { name: 'NovaClient — 1 Day Key',    amount: 299,  noun: 'key' },
  'nova-week':       { name: 'NovaClient — 1 Week Key',   amount: 599,  noun: 'key' },
  'nova-month':      { name: 'NovaClient — 1 Month Key',  amount: 1399, noun: 'key' },
  'fallen-standard': { name: 'Fallen Account — Standard', amount: 215,  noun: 'account' },
};
