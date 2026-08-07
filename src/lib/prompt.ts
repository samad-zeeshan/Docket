/**
 * The extraction prompt and its version. The version rides on every record so an
 * eval can compare two prompt revisions over the same golden set.
 */

export interface Prompt {
  version: string;
  system: string;
  buildUser(text: string): string;
  buildRepair(text: string, previous: string, error: string): string;
  // Optional overrides for the image path. When absent, the extractor uses a
  // sensible default, so a prompt only defines these if it wants to tune them.
  buildUserImage?(): string;
  buildRepairImage?(previous: string, error: string): string;
}

const SHAPE = `{
  "merchant": string,
  "date": "YYYY-MM-DD",
  "currency": "ISO 4217 code, e.g. USD",
  "lineItems": [{ "description": string, "quantity": number, "unitPrice"?: number, "amount": number }],
  "subtotal"?: number,
  "tax"?: number,
  "total": number,
  "paymentMethod"?: "cash" | "credit" | "debit" | "gift_card" | "other"
}`;

export const promptV1: Prompt = {
  version: 'v1',
  system: [
    'You extract structured data from a single retail receipt.',
    'Return only a JSON object, no prose and no code fences, matching:',
    SHAPE,
    'Rules:',
    '- Money is plain numbers, no currency symbols or thousands separators.',
    '- Convert any date format to YYYY-MM-DD.',
    '- Omit optional fields you cannot find. Never invent a value.',
    '- lineItems.amount is the line total, negative for discounts.',
  ].join('\n'),
  buildUser: (text) => `Receipt text:\n\n${text}\n\nReturn the JSON now.`,
  buildRepair: (text, previous, error) =>
    [
      'Your previous output did not pass validation.',
      `Validation errors:\n${error}`,
      `Your previous output:\n${previous}`,
      `Receipt text:\n\n${text}`,
      'Return corrected JSON only.',
    ].join('\n\n'),
};

// The small model path. It asks for a confidence per field, which v1 cannot do
// without changing its hash and orphaning every recorded Bedrock response.
export const promptSmall: Prompt = {
  version: 'small-v1',
  system: [
    'You extract structured data from a single retail receipt.',
    'Return only a JSON object matching:',
    SHAPE,
    'plus "confidence": an object giving, for merchant, date, currency, total, subtotal, tax and lineItems,',
    'the probability from 0 to 1 that the value you wrote is exactly right.',
    'Rules:',
    '- Money is plain numbers in the receipt currency, no symbols and no thousands separators.',
    '- Convert any date format to YYYY-MM-DD. Day first unless the receipt is clearly American.',
    '- merchant is the shop or company that issued the receipt, not the cashier or the customer.',
    '- Omit optional fields you cannot find. Never invent a value.',
    '- lineItems.amount is the line total, negative for discounts.',
  ].join('\n'),
  buildUser: promptV1.buildUser,
  buildRepair: promptV1.buildRepair,
  buildUserImage: () => 'This is a photo of a single retail receipt. Extract it as JSON. Return the JSON now.',
};

export const activePrompt = promptV1;
