import { describe, it, expect } from 'vitest';
import { ReceiptSchema, checkTotals } from '../src/lib/schema';

const good = {
  merchant: 'Corner Store',
  date: '2025-01-02',
  currency: 'usd',
  lineItems: [{ description: 'Milk', amount: 3.5 }],
  subtotal: 3.5,
  tax: 0.3,
  total: 3.8,
};

describe('ReceiptSchema', () => {
  it('accepts a valid receipt and upper-cases the currency', () => {
    const parsed = ReceiptSchema.parse(good);
    expect(parsed.currency).toBe('USD');
  });

  it('defaults a missing line-item quantity to 1', () => {
    const parsed = ReceiptSchema.parse(good);
    expect(parsed.lineItems[0]!.quantity).toBe(1);
  });

  it('rejects a non-ISO date', () => {
    expect(ReceiptSchema.safeParse({ ...good, date: '01/02/2025' }).success).toBe(false);
  });

  it('rejects a missing total', () => {
    const { total: _total, ...noTotal } = good;
    expect(ReceiptSchema.safeParse(noTotal).success).toBe(false);
  });

  it('rejects an unknown payment method', () => {
    expect(ReceiptSchema.safeParse({ ...good, paymentMethod: 'crypto' }).success).toBe(false);
  });
});

describe('checkTotals', () => {
  it('reconciles subtotal + tax against total within a cent', () => {
    expect(checkTotals(ReceiptSchema.parse(good))).toEqual({ reconciles: true, delta: 0 });
  });

  it('flags a total that does not add up', () => {
    const off = checkTotals(ReceiptSchema.parse({ ...good, total: 9.99 }));
    expect(off?.reconciles).toBe(false);
  });

  it('returns undefined when there is no subtotal to check against', () => {
    const { subtotal: _subtotal, ...noSubtotal } = good;
    expect(checkTotals(ReceiptSchema.parse(noSubtotal))).toBeUndefined();
  });
});
