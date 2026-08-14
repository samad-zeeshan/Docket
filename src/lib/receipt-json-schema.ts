/**
 * The receipt shape as JSON Schema, handed to the local model so its decoder cannot emit anything else.
 *
 * The Zod gate still checks the result. A grammar fixes structure, not content, so a date can still come back as the wrong string.
 */

const money = { type: 'number' };
// Optional money fields are required but nullable. Left optional, a grammar lets
// a 9B model skip straight from lineItems to total, and it did on 40 of 42
// golden receipts. Forcing the key makes it write a value or say null.
const maybeMoney = { type: ['number', 'null'] };

export const RECEIPT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    merchant: { type: 'string' },
    date: { type: 'string' },
    currency: { type: 'string' },
    lineItems: {
      type: 'array',
      items: {
        type: 'object',
        properties: { description: { type: 'string' }, quantity: { type: 'number' }, amount: money },
        required: ['description', 'quantity', 'amount'],
      },
    },
    subtotal: maybeMoney,
    tax: maybeMoney,
    total: money,
    paymentMethod: { type: ['string', 'null'], enum: ['cash', 'credit', 'debit', 'gift_card', 'other', null] },
    confidence: {
      type: 'object',
      properties: Object.fromEntries(
        ['merchant', 'date', 'currency', 'total', 'subtotal', 'tax', 'lineItems'].map((k) => [k, { type: 'number' }]),
      ),
      required: ['merchant', 'date', 'currency', 'total', 'subtotal', 'tax', 'lineItems'],
    },
  },
  required: ['merchant', 'date', 'currency', 'lineItems', 'subtotal', 'tax', 'total', 'paymentMethod', 'confidence'],
} as const;
