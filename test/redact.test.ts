import { describe, it, expect } from 'vitest';
import { redactText, redactReceipt } from '../src/lib/redact';
import type { Receipt } from '../src/lib/schema';

describe('redactText', () => {
  it('masks a Luhn-valid card, keeping the last four', () => {
    const { text, kinds } = redactText('paid with 4111 1111 1111 1111 today');
    expect(text).toBe('paid with [card ending 1111] today');
    expect(kinds).toContain('card');
  });

  it('leaves a long non-card number alone', () => {
    const { text, kinds } = redactText('order 1111111111111111 shipped');
    expect(text).toBe('order 1111111111111111 shipped');
    expect(kinds).toEqual([]);
  });

  it('masks an email address', () => {
    const { text, kinds } = redactText('receipt to jane.doe@example.com');
    expect(text).toBe('receipt to [email redacted]');
    expect(kinds).toContain('email');
  });

  it('masks a phone number', () => {
    const { text, kinds } = redactText('call 587-986-9077 for returns');
    expect(text).toBe('call [phone redacted] for returns');
    expect(kinds).toContain('phone');
  });

  it('is a no-op on clean text', () => {
    expect(redactText('Blue Bottle Coffee').kinds).toEqual([]);
  });
});

const clean: Receipt = {
  merchant: 'Blue Bottle Coffee',
  date: '2025-03-14',
  currency: 'USD',
  lineItems: [{ description: 'Latte', quantity: 1, amount: 5.5 }],
  total: 5.5,
};

describe('redactReceipt', () => {
  it('returns the same object when there is nothing to scrub', () => {
    const out = redactReceipt(clean);
    expect(out.receipt).toBe(clean);
    expect(out.redactions).toEqual([]);
  });

  it('scrubs a card in the merchant and an email in a line item', () => {
    const dirty: Receipt = {
      ...clean,
      merchant: 'Store 4111 1111 1111 1111',
      lineItems: [{ description: 'invoice sent to a@b.com', quantity: 1, amount: 5.5 }],
    };
    const { receipt, redactions } = redactReceipt(dirty);
    expect(receipt.merchant).toBe('Store [card ending 1111]');
    expect(receipt.lineItems[0]!.description).toBe('invoice sent to [email redacted]');
    expect(redactions).toEqual([
      { field: 'merchant', kind: 'card' },
      { field: 'lineItems[0].description', kind: 'email' },
    ]);
  });

  it('keeps the scrubbed receipt schema-valid', () => {
    const dirty: Receipt = { ...clean, merchant: '4111 1111 1111 1111' };
    const { receipt } = redactReceipt(dirty);
    expect(receipt.merchant.length).toBeGreaterThan(0);
  });
});
