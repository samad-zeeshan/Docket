/**
 * The receipt shape as JSON Schema, handed to the local model so its decoder cannot emit anything else.
 *
 * The Zod gate still checks the result. A grammar fixes structure, not content, so a date can still come back as the wrong string.
 */

const money = { type: 'number' };

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
    subtotal: money,
    tax: money,
    total: money,
    paymentMethod: { type: 'string', enum: ['cash', 'credit', 'debit', 'gift_card', 'other'] },
    confidence: {
      type: 'object',
      properties: Object.fromEntries(
        ['merchant', 'date', 'currency', 'total', 'subtotal', 'tax', 'lineItems'].map((k) => [k, { type: 'number' }]),
      ),
      required: ['merchant', 'date', 'currency', 'total', 'lineItems'],
    },
  },
  required: ['merchant', 'date', 'currency', 'lineItems', 'total', 'confidence'],
} as const;
