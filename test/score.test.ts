import { describe, it, expect } from 'vitest';
import { scoreReceipt, lineItemF1, aggregate, zeroScore } from '../eval/score';
import type { Receipt } from '../src/lib/schema';

const gold: Receipt = {
  merchant: 'Blue Bottle Coffee',
  date: '2025-03-01',
  currency: 'USD',
  lineItems: [
    { description: 'Latte', quantity: 1, amount: 4.5 },
    { description: 'Bagel', quantity: 1, amount: 3.25 },
  ],
  subtotal: 7.75,
  tax: 0.62,
  total: 8.37,
  paymentMethod: 'credit',
};

describe('scoreReceipt', () => {
  it('scores a perfect extraction 1.0', () => {
    expect(scoreReceipt(structuredClone(gold), gold).score).toBe(1);
  });

  it('normalizes merchant casing and trailing punctuation', () => {
    const pred = { ...structuredClone(gold), merchant: 'blue bottle coffee.' };
    expect(scoreReceipt(pred, gold).fields.merchant).toBe(1);
  });

  it('allows a cent of drift on money but not more', () => {
    expect(scoreReceipt({ ...structuredClone(gold), total: 8.38 }, gold).fields.total).toBe(1);
    expect(scoreReceipt({ ...structuredClone(gold), total: 8.5 }, gold).fields.total).toBe(0);
  });

  it('scores a missing optional field against a present one as wrong', () => {
    const { tax: _tax, ...noTax } = structuredClone(gold);
    expect(scoreReceipt(noTax as Receipt, gold).fields.tax).toBe(0);
  });
});

describe('lineItemF1', () => {
  it('is 1.0 for an exact match regardless of order', () => {
    const reversed = [...gold.lineItems].reverse();
    expect(lineItemF1(reversed, gold.lineItems)).toBe(1);
  });

  it('penalizes a missing line', () => {
    expect(lineItemF1([gold.lineItems[0]!], gold.lineItems)).toBeCloseTo(0.667, 2);
  });

  it('penalizes an extra hallucinated line', () => {
    const extra = [...gold.lineItems, { description: 'Cookie', quantity: 1, amount: 2 }];
    expect(lineItemF1(extra, gold.lineItems)).toBeCloseTo(0.8, 2);
  });
});

describe('aggregate', () => {
  it('averages receipt scores and reports per field', () => {
    const agg = aggregate([scoreReceipt(structuredClone(gold), gold), zeroScore()]);
    expect(agg.overall).toBe(0.5);
    expect(agg.n).toBe(2);
    expect(agg.perField.merchant).toBe(0.5);
  });
});
