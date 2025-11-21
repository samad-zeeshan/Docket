/**
 * Generate the synthetic golden set: canonical receipt text plus gold labels.
 *
 * Labels are free because we generate to the schema, which keeps the set license
 * clean. The eval reads the text, not a PDF: pdf-parse (the runtime reader) is
 * unreliable on synthetic PDFs, and fixing the text isolates extraction quality
 * from PDF-parsing quirks, which is what an eval should measure. Generation is
 * seeded so the set is stable and a regeneration is a clean diff.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { ReceiptSchema, type Receipt } from '../../src/lib/schema';

const COUNT = 30;
const GOLDEN = path.join(__dirname, '..', 'golden');
const TEXT = path.join(GOLDEN, 'text');
const LABELS = path.join(GOLDEN, 'labels');

// mulberry32. A tiny seeded PRNG so the golden set is deterministic.
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MERCHANTS = [
  'Blue Bottle Coffee', 'Corner Grocery', 'Trader Vics Hardware', 'Sunrise Diner',
  'Metro Pharmacy', 'The Book Nook', 'Pacific Fuel', 'Green Leaf Market',
  'City Bikes', 'Harbor Seafood',
];
const ITEMS: [string, number][] = [
  ['Latte', 4.5], ['Bagel', 3.25], ['Milk 1gal', 3.99], ['Eggs dozen', 4.49],
  ['AA Batteries', 8.99], ['Notebook', 5.0], ['Pen pack', 2.75], ['Apples lb', 1.89],
  ['Sandwich', 7.5], ['Orange juice', 3.6], ['Shampoo', 6.25], ['Paperback', 12.99],
  ['Trail mix', 4.2], ['Sparkling water', 1.5], ['Bike tube', 9.0],
];
const CURRENCIES = ['USD', 'USD', 'USD', 'EUR', 'GBP'];
const PAYMENTS: Receipt['paymentMethod'][] = ['credit', 'debit', 'cash', 'gift_card', undefined];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isoDate(dayOffset: number): string {
  return new Date(Date.UTC(2025, 0, 5) + dayOffset * 86_400_000).toISOString().slice(0, 10);
}

function pick<T>(r: () => number, arr: T[]): T {
  return arr[Math.floor(r() * arr.length)]!;
}

function buildReceipt(r: () => number, idx: number): Receipt {
  const lineCount = 1 + Math.floor(r() * 4);
  const lineItems = Array.from({ length: lineCount }, () => {
    const [description, unitPrice] = pick(r, ITEMS);
    const quantity = 1 + Math.floor(r() * 3);
    return { description, quantity, unitPrice, amount: round2(unitPrice * quantity) };
  });
  const subtotal = round2(lineItems.reduce((s, li) => s + li.amount, 0));
  const tax = round2(subtotal * 0.08);
  const total = round2(subtotal + tax);
  const paymentMethod = pick(r, PAYMENTS);
  const draft = {
    merchant: pick(r, MERCHANTS),
    date: isoDate(idx * 2),
    currency: pick(r, CURRENCIES),
    lineItems,
    subtotal,
    tax,
    total,
    ...(paymentMethod ? { paymentMethod } : {}),
  };
  // Parse so the label is exactly what the schema accepts (currency cased).
  return ReceiptSchema.parse(draft);
}

// The text a born-digital receipt for this label would carry.
function receiptText(receipt: Receipt): string {
  const lines = [receipt.merchant, `Date: ${receipt.date}`, `Currency: ${receipt.currency}`, ''];
  for (const li of receipt.lineItems) {
    lines.push(`${li.description}  x${li.quantity}   ${li.amount.toFixed(2)}`);
  }
  lines.push('');
  if (receipt.subtotal !== undefined) lines.push(`Subtotal: ${receipt.subtotal.toFixed(2)}`);
  if (receipt.tax !== undefined) lines.push(`Tax: ${receipt.tax.toFixed(2)}`);
  lines.push(`Total: ${receipt.total.toFixed(2)}`);
  if (receipt.paymentMethod) lines.push(`Paid: ${receipt.paymentMethod}`);
  return lines.join('\n');
}

function main(): void {
  mkdirSync(TEXT, { recursive: true });
  mkdirSync(LABELS, { recursive: true });
  const r = rng(0x5eed);
  const manifest: { id: string; text: string; label: string }[] = [];

  for (let i = 0; i < COUNT; i++) {
    const id = `r${String(i).padStart(2, '0')}`;
    const receipt = buildReceipt(r, i);
    writeFileSync(path.join(LABELS, `${id}.json`), JSON.stringify(receipt, null, 2));
    writeFileSync(path.join(TEXT, `${id}.txt`), receiptText(receipt));
    manifest.push({ id, text: `text/${id}.txt`, label: `labels/${id}.json` });
  }

  writeFileSync(path.join(GOLDEN, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`generated ${COUNT} golden receipts into ${GOLDEN}`);
}

main();
