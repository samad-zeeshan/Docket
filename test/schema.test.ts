import { describe, it, expect } from 'vitest';
import { ReceiptSchema, checkLineItems, checkTotals } from '../src/lib/schema';

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

// A stationery receipt whose lines add up: 12.24 + 9.00 + 4.50 = 25.74.
const stationery = {
  merchant: 'Paper Lane',
  date: '2025-11-14',
  currency: 'USD',
  lineItems: [
    { description: 'Notebook', amount: 12.24 },
    { description: 'Pen Set', amount: 9.0 },
    { description: 'Bookmark Set', quantity: 3, unitPrice: 1.5, amount: 4.5 },
  ],
  subtotal: 25.74,
  tax: 2.06,
  total: 27.8,
};

describe('checkLineItems', () => {
  it('reconciles the line amounts against the subtotal', () => {
    expect(checkLineItems(ReceiptSchema.parse(stationery))).toEqual({ reconciles: true, delta: 0 });
  });

  // The reason this check exists. A live model read "Bookmark Set x3 4.50" and
  // took 4.50 as the price of one rather than the total of three, so it wrote
  // 13.50. Every other check in the pipeline was happy with that receipt.
  it('catches a line the model multiplied by the quantity when it should not have', () => {
    const misread = ReceiptSchema.parse({
      ...stationery,
      lineItems: [
        { description: 'Notebook', amount: 12.24 },
        { description: 'Pen Set', amount: 9.0 },
        { description: 'Bookmark Set', quantity: 3, unitPrice: 4.5, amount: 13.5 },
      ],
    });

    expect(checkLineItems(misread)).toEqual({ reconciles: false, delta: 9 });
    // And the point: nothing else in the pipeline sees it. The shape is legal, so
    // the schema gate passes, and subtotal + tax still equals total.
    expect(ReceiptSchema.safeParse(misread).success).toBe(true);
    expect(checkTotals(misread)?.reconciles).toBe(true);
  });

  it('treats a discount as a negative line rather than an error', () => {
    const discounted = ReceiptSchema.parse({
      ...stationery,
      lineItems: [...stationery.lineItems, { description: 'Coupon', amount: -5 }],
      subtotal: 20.74,
      tax: 1.66,
      total: 22.4,
    });
    expect(checkLineItems(discounted)?.reconciles).toBe(true);
  });

  it('allows a cent of rounding', () => {
    const rounded = ReceiptSchema.parse({ ...stationery, subtotal: 25.75 });
    expect(checkLineItems(rounded)).toEqual({ reconciles: true, delta: -0.01 });
  });

  // A cent, and not a cent more. checkTotals allows two because subtotal and tax
  // are rounded separately; the lines and the subtotal are one rounding.
  it('does not allow two cents, which would swallow a small misread', () => {
    const off = ReceiptSchema.parse({ ...stationery, subtotal: 25.72 });
    expect(checkLineItems(off)).toEqual({ reconciles: false, delta: 0.02 });
  });

  it('returns undefined when there is no subtotal to check against', () => {
    const { subtotal: _subtotal, ...noSubtotal } = stationery;
    expect(checkLineItems(ReceiptSchema.parse(noSubtotal))).toBeUndefined();
  });

  // A receipt with a subtotal and no itemized lines is not a misread receipt. An
  // empty list sums to zero, which disagrees with every subtotal, so checking it
  // would flag every totals-only slip that ever reaches the pipeline.
  it('returns undefined when there are no lines to add up', () => {
    const totalsOnly = ReceiptSchema.parse({ ...stationery, lineItems: [] });
    expect(checkLineItems(totalsOnly)).toBeUndefined();
  });
});
