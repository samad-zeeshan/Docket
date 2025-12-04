/**
 * Defense in depth for the little PII a receipt can carry. The schema is minimal
 * on purpose, no cardholder name and no card field, but a model can still echo a
 * card number, an email, or a phone into a free-text field like the merchant or a
 * line item description. This scrubs those out of an extracted receipt before it
 * is persisted, so a full card number never lands in the store.
 */
import type { Receipt } from './schema';

export type PiiKind = 'card' | 'email' | 'phone';

export interface Redaction {
  field: string;
  kind: PiiKind;
}

// A run of 13 to 19 digits, optionally split by spaces or dashes, is a candidate
// card number. A Luhn check then filters out long numbers that are not cards, so
// an order id or a long reference is left alone.
const CARD = /\b\d(?:[ -]?\d){12,18}\b/g;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// A loose North American phone: 10+ digits grouped by space, dot, or dash, with
// an optional country code and parentheses. Bounded by non-digits so it does not
// bite into a longer number.
const PHONE = /(?<!\d)(?:\+?\d{1,2}[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}(?!\d)/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// Scrub one string. Email first, then card, then phone: an email can contain
// digits, and a card run can look phone-ish, so the more specific pattern wins.
export function redactText(input: string): { text: string; kinds: PiiKind[] } {
  const kinds = new Set<PiiKind>();
  let text = input;

  text = text.replace(EMAIL, () => {
    kinds.add('email');
    return '[email redacted]';
  });

  text = text.replace(CARD, (match) => {
    const digits = match.replace(/[ -]/g, '');
    if (digits.length < 13 || digits.length > 19 || !luhnValid(digits)) return match;
    kinds.add('card');
    return `[card ending ${digits.slice(-4)}]`;
  });

  text = text.replace(PHONE, (match) => {
    if (match.replace(/\D/g, '').length < 10) return match;
    kinds.add('phone');
    return '[phone redacted]';
  });

  return { text, kinds: [...kinds] };
}

// Scrub the free-text fields of a receipt. Returns the same object when nothing
// matched so an untouched receipt is not needlessly copied.
export function redactReceipt(receipt: Receipt): { receipt: Receipt; redactions: Redaction[] } {
  const redactions: Redaction[] = [];

  const merchant = redactText(receipt.merchant);
  for (const kind of merchant.kinds) redactions.push({ field: 'merchant', kind });

  const lineItems = receipt.lineItems.map((li, i) => {
    const desc = redactText(li.description);
    for (const kind of desc.kinds) redactions.push({ field: `lineItems[${i}].description`, kind });
    return desc.text === li.description ? li : { ...li, description: desc.text };
  });

  if (redactions.length === 0) return { receipt, redactions };
  return { receipt: { ...receipt, merchant: merchant.text, lineItems }, redactions };
}
