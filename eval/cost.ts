/**
 * Turn token counts into money and latency samples into percentiles, so the eval
 * can report what a run costs and how slow the tail is, not just how accurate it
 * is. Prices are on-demand Bedrock rates in USD per million tokens; update them
 * here if the model or region changes.
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelPrice {
  inPerM: number;
  outPerM: number;
}

// Claude Haiku 4.5 on Bedrock, us-east-1 on-demand. A single source of truth so
// a price change is a one-line edit. The two ids are the same model: the first is
// the Bedrock inference profile, the second is the direct API name.
export const PRICES: Record<string, ModelPrice> = {
  'us.anthropic.claude-haiku-4-5-20251001-v1:0': { inPerM: 1, outPerM: 5 },
  'claude-haiku-4-5': { inPerM: 1, outPerM: 5 },
};

export const DEFAULT_PRICE: ModelPrice = { inPerM: 1, outPerM: 5 };

export function priceFor(modelId: string): ModelPrice {
  return PRICES[modelId] ?? DEFAULT_PRICE;
}

// Cost of one extraction, in dollars. Kept in dollars, not cents, because the
// per-receipt number is fractions of a cent and rounding early would hide it.
export function costUsd(usage: TokenUsage, price: ModelPrice = DEFAULT_PRICE): number {
  return (usage.inputTokens * price.inPerM + usage.outputTokens * price.outPerM) / 1_000_000;
}

// Cost to run N documents a day for a 30 day month.
export function projectMonthly(perReceiptUsd: number, perDay: number): number {
  return perReceiptUsd * perDay * 30;
}

// Nearest-rank percentile. Small sample sizes make interpolation noise, so this
// picks an actual observed value rather than blending two.
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx]!;
}
