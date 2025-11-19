/**
 * Score one extracted receipt against its gold label. Scalar fields are
 * normalized exact match, line items are set F1 so order and extra or missing
 * lines are all penalized the right way.
 */
import type { LineItem, Receipt } from '../src/lib/schema';

export const SCORED_FIELDS = [
  'merchant',
  'date',
  'currency',
  'total',
  'subtotal',
  'tax',
  'paymentMethod',
  'lineItems',
] as const;

export type ScoredField = (typeof SCORED_FIELDS)[number];
export type FieldScores = Record<ScoredField, number>;

export interface ReceiptScore {
  fields: FieldScores;
  score: number;
}

// Casing, spacing, and trailing punctuation vary between a receipt and a label
// without being wrong, so normalize them away before comparing merchant text.
function normText(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,]/g, '')
    .trim();
}

// Compare in integer cents. Subtracting floats (8.38 - 8.37) does not land on
// 0.01, so a direct tolerance check would reject a value that is a cent off.
function moneyEqual(a: number, b: number): boolean {
  return Math.abs(Math.round(a * 100) - Math.round(b * 100)) <= 1;
}

function optionalNumber(a: number | undefined, b: number | undefined): number {
  if (a === undefined && b === undefined) return 1;
  if (a === undefined || b === undefined) return 0;
  return moneyEqual(a, b) ? 1 : 0;
}

function optionalExact<T>(a: T | undefined, b: T | undefined): number {
  if (a === undefined && b === undefined) return 1;
  if (a === undefined || b === undefined) return 0;
  return a === b ? 1 : 0;
}

// A predicted line matches a gold line when the description normalizes equal and
// the amount is within a cent. Greedy one-to-one, so duplicates are not double
// counted.
export function lineItemF1(predicted: LineItem[], gold: LineItem[]): number {
  if (predicted.length === 0 && gold.length === 0) return 1;
  const used = new Array<boolean>(gold.length).fill(false);
  let truePositives = 0;
  for (const p of predicted) {
    const idx = gold.findIndex(
      (g, i) => !used[i] && normText(g.description) === normText(p.description) && moneyEqual(g.amount, p.amount),
    );
    if (idx >= 0) {
      used[idx] = true;
      truePositives += 1;
    }
  }
  const precision = predicted.length ? truePositives / predicted.length : 0;
  const recall = gold.length ? truePositives / gold.length : 0;
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

export function scoreReceipt(predicted: Receipt, gold: Receipt): ReceiptScore {
  const fields: FieldScores = {
    merchant: normText(predicted.merchant) === normText(gold.merchant) ? 1 : 0,
    date: predicted.date === gold.date ? 1 : 0,
    currency: predicted.currency === gold.currency ? 1 : 0,
    total: moneyEqual(predicted.total, gold.total) ? 1 : 0,
    subtotal: optionalNumber(predicted.subtotal, gold.subtotal),
    tax: optionalNumber(predicted.tax, gold.tax),
    paymentMethod: optionalExact(predicted.paymentMethod, gold.paymentMethod),
    lineItems: lineItemF1(predicted.lineItems, gold.lineItems),
  };
  return { fields, score: mean(Object.values(fields)) };
}

// An extraction that failed the gate scores zero everywhere. Kept here so the
// harness and the tests agree on what a miss is worth.
export function zeroScore(): ReceiptScore {
  const fields = Object.fromEntries(SCORED_FIELDS.map((f) => [f, 0])) as FieldScores;
  return { fields, score: 0 };
}

export interface Aggregate {
  overall: number;
  perField: FieldScores;
  n: number;
}

export function aggregate(scores: ReceiptScore[]): Aggregate {
  const perField = Object.fromEntries(
    SCORED_FIELDS.map((f) => [f, mean(scores.map((s) => s.fields[f]))]),
  ) as FieldScores;
  return { overall: mean(scores.map((s) => s.score)), perField, n: scores.length };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
