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
function receiptText(receipt: Receipt, dateText?: string, taxLabel = 'Tax', tip?: number): string {
  const lines = [receipt.merchant, `Date: ${dateText ?? receipt.date}`, `Currency: ${receipt.currency}`, ''];
  for (const li of receipt.lineItems) {
    lines.push(`${li.description}  x${li.quantity}   ${li.amount.toFixed(2)}`);
  }
  lines.push('');
  if (receipt.subtotal !== undefined) lines.push(`Subtotal: ${receipt.subtotal.toFixed(2)}`);
  if (receipt.tax !== undefined) lines.push(`${taxLabel}: ${receipt.tax.toFixed(2)}`);
  if (tip !== undefined) lines.push(`Tip: ${tip.toFixed(2)}`);
  lines.push(`Total: ${receipt.total.toFixed(2)}`);
  if (receipt.paymentMethod) lines.push(`Paid: ${receipt.paymentMethod}`);
  return lines.join('\n');
}

// Hand-built hard cases. The base set is clean and USD; these push on the parts
// that break naive extractors: non-USD money, discount lines that go negative,
// a missing subtotal, foreign VAT wording, dates in odd formats, and a tip that
// makes subtotal plus tax not equal the total on purpose.
interface AdvSpec {
  category: string;
  merchant: string;
  currency: string;
  date: string; // ISO, the label truth
  dateText?: string; // how the date is printed on the receipt, if not ISO
  payment?: Receipt['paymentMethod'];
  lines: { description: string; quantity: number; unitPrice?: number; amount: number }[];
  taxRate?: number; // fraction of subtotal; omitted means no tax line
  taxLabel?: string; // printed label for the tax line
  subtotal?: boolean; // include the subtotal line, default true
  tip?: number; // added to the total but not itemized, so the total will not reconcile
}

const ADVERSARIAL: AdvSpec[] = [
  { category: 'multi-currency', merchant: 'Cafe Central', currency: 'EUR', date: '2025-02-10', payment: 'credit',
    lines: [{ description: 'Espresso', quantity: 1, unitPrice: 3.2, amount: 3.2 }, { description: 'Croissant', quantity: 1, unitPrice: 2.8, amount: 2.8 }], taxRate: 0.1 },
  { category: 'multi-currency', merchant: 'Thistle Grocers', currency: 'GBP', date: '2025-02-14', payment: 'debit',
    lines: [{ description: 'Tea box', quantity: 2, unitPrice: 2.5, amount: 5.0 }, { description: 'Biscuits', quantity: 1, unitPrice: 1.75, amount: 1.75 }], taxRate: 0.05 },
  { category: 'discount', merchant: 'Green Leaf Market', currency: 'USD', date: '2025-02-18', payment: 'credit',
    lines: [{ description: 'Milk 1gal', quantity: 1, unitPrice: 3.99, amount: 3.99 }, { description: 'Eggs dozen', quantity: 1, unitPrice: 4.49, amount: 4.49 }, { description: 'Member discount', quantity: 1, amount: -1.5 }], taxRate: 0.08 },
  { category: 'discount', merchant: 'City Bikes', currency: 'USD', date: '2025-02-22', payment: 'credit',
    lines: [{ description: 'Bike tube', quantity: 2, unitPrice: 9.0, amount: 18.0 }, { description: 'Coupon SAVE5', quantity: 1, amount: -5.0 }], taxRate: 0.08 },
  { category: 'no-subtotal', merchant: 'Sunrise Diner', currency: 'USD', date: '2025-02-26', payment: 'cash',
    lines: [{ description: 'Sandwich', quantity: 1, unitPrice: 7.5, amount: 7.5 }, { description: 'Orange juice', quantity: 1, unitPrice: 3.6, amount: 3.6 }], subtotal: false },
  { category: 'no-subtotal', merchant: 'Corner Grocery', currency: 'USD', date: '2025-03-02', payment: 'debit',
    lines: [{ description: 'Apples lb', quantity: 3, unitPrice: 1.89, amount: 5.67 }, { description: 'Trail mix', quantity: 1, unitPrice: 4.2, amount: 4.2 }], subtotal: false },
  { category: 'foreign-vat', merchant: 'London Books Ltd', currency: 'GBP', date: '2025-03-06', payment: 'credit',
    lines: [{ description: 'Paperback', quantity: 1, unitPrice: 12.99, amount: 12.99 }, { description: 'Notebook', quantity: 1, unitPrice: 5.0, amount: 5.0 }], taxRate: 0.2, taxLabel: 'VAT (20%)' },
  { category: 'foreign-vat', merchant: 'Berlin Elektronik', currency: 'EUR', date: '2025-03-10', payment: 'credit',
    lines: [{ description: 'AA Batteries', quantity: 1, unitPrice: 8.99, amount: 8.99 }, { description: 'Pen pack', quantity: 2, unitPrice: 2.75, amount: 5.5 }], taxRate: 0.19, taxLabel: 'VAT (19%)' },
  { category: 'odd-date', merchant: 'Metro Pharmacy', currency: 'USD', date: '2025-03-14', dateText: 'Mar 14, 2025', payment: 'debit',
    lines: [{ description: 'Shampoo', quantity: 1, unitPrice: 6.25, amount: 6.25 }], taxRate: 0.08 },
  { category: 'odd-date', merchant: 'Harbor Seafood', currency: 'USD', date: '2025-03-18', dateText: '18/03/2025', payment: 'credit',
    lines: [{ description: 'Sandwich', quantity: 1, unitPrice: 7.5, amount: 7.5 }, { description: 'Sparkling water', quantity: 2, unitPrice: 1.5, amount: 3.0 }], taxRate: 0.08 },
  { category: 'tip', merchant: 'Sunrise Diner', currency: 'USD', date: '2025-03-22', payment: 'credit',
    lines: [{ description: 'Sandwich', quantity: 1, unitPrice: 7.5, amount: 7.5 }, { description: 'Latte', quantity: 1, unitPrice: 4.5, amount: 4.5 }], taxRate: 0.08, tip: 2.4 },
  { category: 'tip', merchant: 'Blue Bottle Coffee', currency: 'USD', date: '2025-03-26', payment: 'credit',
    lines: [{ description: 'Sandwich', quantity: 2, unitPrice: 7.5, amount: 15.0 }, { description: 'Orange juice', quantity: 1, unitPrice: 3.6, amount: 3.6 }], taxRate: 0.08, tip: 3.72 },
];

function buildAdversarial(spec: AdvSpec): { receipt: Receipt; text: string } {
  const lineItems = spec.lines.map((l) => ({
    description: l.description,
    quantity: l.quantity,
    ...(l.unitPrice !== undefined ? { unitPrice: l.unitPrice } : {}),
    amount: round2(l.amount),
  }));
  const subtotal = round2(lineItems.reduce((s, li) => s + li.amount, 0));
  const withSub = spec.subtotal !== false;
  const tax = spec.taxRate !== undefined ? round2(subtotal * spec.taxRate) : undefined;
  const total = round2(subtotal + (tax ?? 0) + (spec.tip ?? 0));
  const draft = {
    merchant: spec.merchant,
    date: spec.date,
    currency: spec.currency,
    lineItems,
    ...(withSub ? { subtotal } : {}),
    ...(tax !== undefined ? { tax } : {}),
    total,
    ...(spec.payment ? { paymentMethod: spec.payment } : {}),
  };
  const receipt = ReceiptSchema.parse(draft);
  return { receipt, text: receiptText(receipt, spec.dateText, spec.taxLabel, spec.tip) };
}

function main(): void {
  mkdirSync(TEXT, { recursive: true });
  mkdirSync(LABELS, { recursive: true });
  const r = rng(0x5eed);
  const manifest: { id: string; text: string; label: string; category: string }[] = [];

  for (let i = 0; i < COUNT; i++) {
    const id = `r${String(i).padStart(2, '0')}`;
    const receipt = buildReceipt(r, i);
    writeFileSync(path.join(LABELS, `${id}.json`), JSON.stringify(receipt, null, 2));
    writeFileSync(path.join(TEXT, `${id}.txt`), receiptText(receipt));
    manifest.push({ id, text: `text/${id}.txt`, label: `labels/${id}.json`, category: 'standard' });
  }

  ADVERSARIAL.forEach((spec, i) => {
    const id = `r${String(COUNT + i).padStart(2, '0')}`;
    const { receipt, text } = buildAdversarial(spec);
    writeFileSync(path.join(LABELS, `${id}.json`), JSON.stringify(receipt, null, 2));
    writeFileSync(path.join(TEXT, `${id}.txt`), text);
    manifest.push({ id, text: `text/${id}.txt`, label: `labels/${id}.json`, category: spec.category });
  });

  writeFileSync(path.join(GOLDEN, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`generated ${COUNT} standard and ${ADVERSARIAL.length} adversarial golden receipts into ${GOLDEN}`);
}

main();
