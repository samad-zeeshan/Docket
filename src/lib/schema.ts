/**
 * The receipt schema. This is the contract shared by the extractor, the eval,
 * and the API. Nothing leaves the pipeline without passing it.
 */
import { z } from 'zod';

export const LineItemSchema = z.object({
  description: z.string().min(1),
  // Receipts often omit an explicit quantity for single items, so default to 1
  // rather than reject.
  quantity: z.number().positive().default(1),
  unitPrice: z.number().nonnegative().optional(),
  // Line total. Can be negative for a discount or coupon line.
  amount: z.number(),
});

export const ReceiptSchema = z.object({
  merchant: z.string().min(1),
  // Normalized to ISO 8601. The model does the format conversion, the gate only
  // accepts the normalized form so downstream code never parses locale dates.
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((d) => !Number.isNaN(Date.parse(d)), 'not a real calendar date'),
  // ISO 4217, upper-cased here so 'usd' and 'USD' compare equal in the eval.
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .transform((c) => c.toUpperCase()),
  lineItems: z.array(LineItemSchema),
  subtotal: z.number().nonnegative().optional(),
  tax: z.number().nonnegative().optional(),
  total: z.number(),
  paymentMethod: z.enum(['cash', 'credit', 'debit', 'gift_card', 'other']).optional(),
});

export type LineItem = z.infer<typeof LineItemSchema>;
export type Receipt = z.infer<typeof ReceiptSchema>;

// The result of an arithmetic check. Both checks below answer the same question
// about two numbers the model wrote down separately, so they answer it in the
// same shape.
export interface ReconcileCheck {
  reconciles: boolean;
  delta: number;
}

export type TotalsCheck = ReconcileCheck;
export type LineItemsCheck = ReconcileCheck;

// checkTotals allows two cents: subtotal and tax are each rounded on the paper,
// so the sum can be off by a cent from either. checkLineItems allows one, because
// the lines and the subtotal are the same rounding, done once.
const TOTALS_TOLERANCE = 0.02;
const LINE_ITEMS_TOLERANCE = 0.01;

// Round to cents before comparing so float noise never decides the answer. Do it
// once, here, rather than twice at the call sites.
function reconcile(actual: number, expected: number, tolerance: number): ReconcileCheck {
  const delta = Math.round((actual - expected) * 100) / 100;
  return { reconciles: Math.abs(delta) <= tolerance, delta };
}

// Arithmetic sanity, kept out of the schema on purpose. Tips, rounding, and
// discounts make a hard subtotal+tax==total rule reject valid receipts, so this
// is a soft signal for metrics and eval, never a gate.
export function checkTotals(receipt: Receipt): TotalsCheck | undefined {
  if (receipt.subtotal === undefined) return undefined;
  const tax = receipt.tax ?? 0;
  return reconcile(receipt.subtotal + tax, receipt.total, TOTALS_TOLERANCE);
}

// The line amounts must add up to the subtotal. Unlike checkTotals this is not a
// property of a particular receipt, it is what subtotal means: the sum of the
// lines, before tax and before any tip. Discounts hold too, because a discount is
// a line with a negative amount.
//
// It exists because a real model, on a real receipt, read "Bookmark Set x3 4.50"
// and took 4.50 as the price of one rather than the total of three, then wrote
// 13.50. Nothing else in the pipeline could see it. The JSON was valid, so the
// schema gate passed. Subtotal plus tax still equalled the total, so checkTotals
// passed. Only the lines disagreed with the subtotal.
//
// Two receipts it cannot speak for, and returns undefined rather than guess:
// one with no subtotal, and one with no itemized lines at all. An empty list
// sums to zero, which disagrees with every subtotal, and the model that wrote
// no lines misread nothing.
//
// It does assume the line amounts are net of tax. On a VAT receipt that prints
// gross lines above a net subtotal, this fires on correct extraction. That is
// the known false positive, and the reason it stays soft.
//
// Soft, like checkTotals. A metric, not a gate. See docs/decisions.md.
export function checkLineItems(receipt: Receipt): LineItemsCheck | undefined {
  if (receipt.subtotal === undefined || receipt.lineItems.length === 0) return undefined;
  const sum = receipt.lineItems.reduce((total, item) => total + item.amount, 0);
  return reconcile(sum, receipt.subtotal, LINE_ITEMS_TOLERANCE);
}
