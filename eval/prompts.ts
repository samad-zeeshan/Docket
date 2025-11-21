/**
 * Prompt registry for the eval. v1 is the shipped prompt. v2 is a candidate kept
 * for the version comparison. broken is deliberately bad, used to prove the gate
 * actually fails when accuracy drops.
 */
import { activePrompt, type Prompt } from '../src/lib/prompt';

const SHAPE = `{ "merchant", "date" (YYYY-MM-DD), "currency", "lineItems":[{"description","quantity","amount"}], "subtotal"?, "tax"?, "total", "paymentMethod"? }`;

// Candidate revision: terser, leans on the model to infer the format rules v1
// spells out. The eval exists to decide whether that tradeoff is worth it.
const promptV2: Prompt = {
  version: 'v2',
  system: `Extract this receipt as JSON matching ${SHAPE}. Numbers only for money. Return JSON, nothing else.`,
  buildUser: (text) => `${text}\n\nJSON:`,
  buildRepair: (text, previous, error) =>
    `That JSON was invalid (${error}). Previous: ${previous}\n\nReceipt:\n${text}\n\nFixed JSON:`,
};

// Underspecified on purpose. No format rules, no "numbers only", so the recorded
// responses drift enough to drop below the gate.
const promptBroken: Prompt = {
  version: 'broken',
  system: 'Read the receipt and return some JSON with the details.',
  buildUser: (text) => text,
  buildRepair: (text) => text,
};

export const evalPrompts: Record<string, Prompt> = {
  v1: activePrompt,
  v2: promptV2,
  broken: promptBroken,
};

export function promptByVersion(version: string): Prompt {
  const prompt = evalPrompts[version];
  if (!prompt) throw new Error(`unknown prompt version ${version}, expected one of ${Object.keys(evalPrompts).join(', ')}`);
  return prompt;
}
