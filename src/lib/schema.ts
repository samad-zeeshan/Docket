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

export interface TotalsCheck {
  reconciles: boolean;
  delta: number;
}

// Arithmetic sanity, kept out of the schema on purpose. Tips, rounding, and
// discounts make a hard subtotal+tax==total rule reject valid receipts, so this
// is a soft signal for metrics and eval, never a gate.
export function checkTotals(receipt: Receipt): TotalsCheck | undefined {
  if (receipt.subtotal === undefined) return undefined;
  const tax = receipt.tax ?? 0;
  const delta = Math.round((receipt.subtotal + tax - receipt.total) * 100) / 100;
  return { reconciles: Math.abs(delta) <= 0.02, delta };
}
