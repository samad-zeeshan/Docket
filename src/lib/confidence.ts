/**
 * Raw per-field confidence signals: what the model says, how likely its own tokens were, and whether the numbers agree with each other.
 *
 * None of these is a probability yet. calibrate.ts turns them into one.
 */
import { checkLineItems, checkTotals, type Receipt } from './schema';
import type { TokenLogprob } from './providers/types';

export const CONFIDENCE_FIELDS = ['merchant', 'date', 'currency', 'total', 'subtotal', 'tax', 'lineItems'] as const;
export type ConfidenceField = (typeof CONFIDENCE_FIELDS)[number];

// Enough of ISO 4217 to cover what the pipeline has ever seen. An unknown code is
// a weak signal, not a rejection, so a short list costs little.
const KNOWN_CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'MYR', 'IDR', 'SGD', 'JPY', 'KRW', 'CNY', 'AUD', 'CAD', 'INR', 'THB', 'PHP', 'VND', 'HKD', 'CHF']);

type Spans = Partial<Record<string, [number, number]>>;

// A hand scanner rather than JSON.parse, because the logprobs are per token and
// the only way to line them up with a field is by character offset.
export function topLevelSpans(text: string): Spans {
  const spans: Spans = {};
  let i = text.indexOf('{');
  if (i < 0) return spans;
  let depth = 0;
  let key: string | undefined;
  let valueStart = -1;
  let expectKey = true;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      if (depth === 1 && expectKey) key = text.slice(start + 1, i);
      continue;
    }
    if (c === '{' || c === '[') depth++;
    if (c === '}' || c === ']') depth--;
    if (depth === 1 && c === ':' && key !== undefined) {
      expectKey = false;
      valueStart = i + 1;
      while (text[valueStart] === ' ' || text[valueStart] === '\n') valueStart++;
    }
    if ((depth === 1 && c === ',') || depth === 0) {
      if (key !== undefined && valueStart >= 0) {
        let end = i;
        while (end > valueStart && /\s/.test(text[end - 1]!)) end--;
        spans[key] = [valueStart, end];
      }
      key = undefined;
      valueStart = -1;
      expectKey = true;
      if (depth === 0) break;
    }
  }
  return spans;
}

// The least likely token inside a value. A mean hides the one digit the model
// was unsure about, and one wrong digit is the whole error on a total.
export function fieldLogprobs(text: string, tokens: TokenLogprob[]): Partial<Record<ConfidenceField, number>> {
  const spans = topLevelSpans(text);
  const out: Partial<Record<ConfidenceField, number>> = {};
  const offsets: [number, number, number][] = [];
  let at = 0;
  for (const t of tokens) {
    offsets.push([at, at + t.token.length, t.logprob]);
    at += t.token.length;
  }
  for (const field of CONFIDENCE_FIELDS) {
    const span = spans[field];
    if (!span) continue;
    let min = 0;
    let hit = false;
    for (const [s, e, lp] of offsets) {
      if (e > span[0] && s < span[1]) {
        min = hit ? Math.min(min, lp) : lp;
        hit = true;
      }
    }
    if (hit) out[field] = Math.exp(min);
  }
  return out;
}

export function verbalizedConfidence(text: string): Partial<Record<ConfidenceField, number>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  const conf = (parsed as { confidence?: Record<string, unknown> })?.confidence;
  if (!conf || typeof conf !== 'object') return {};
  const out: Partial<Record<ConfidenceField, number>> = {};
  for (const field of CONFIDENCE_FIELDS) {
    const v = conf[field];
    if (typeof v === 'number' && Number.isFinite(v)) out[field] = Math.min(1, Math.max(0, v));
  }
  return out;
}

export interface ValidatorSignals {
  totalsReconcile: number;
  linesReconcile: number;
  datePlausible: number;
  currencyKnown: number;
}

// 1 pass, 0 fail, 0.5 when the check has nothing to look at. A receipt with no
// subtotal has not passed the arithmetic check, and must not score as if it had.
export function validatorSignals(receipt: Receipt, now = new Date()): ValidatorSignals {
  const tri = (c: { reconciles: boolean } | undefined) => (c === undefined ? 0.5 : c.reconciles ? 1 : 0);
  const year = Number(receipt.date.slice(0, 4));
  return {
    totalsReconcile: tri(checkTotals(receipt)),
    linesReconcile: tri(checkLineItems(receipt)),
    datePlausible: year >= 2000 && year <= now.getUTCFullYear() + 1 ? 1 : 0,
    currencyKnown: KNOWN_CURRENCIES.has(receipt.currency) ? 1 : 0,
  };
}
