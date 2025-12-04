/**
 * Turn receipt text into a schema-valid Receipt, or a FAILED outcome with a
 * reason. Never trusts the model: every response goes through the Zod gate, and
 * a bad response gets exactly one repair attempt before it is marked FAILED.
 */
import { ReceiptSchema, type Receipt } from './schema';
import { activePrompt, type Prompt } from './prompt';
import type { ImageInput, ModelProvider, ModelRequest } from './providers/types';

// Thrown for bad data we do not want retried. Marked terminal so the handler
// records FAILED instead of letting SQS redeliver it into the DLQ.
export class ExtractionError extends Error {
  readonly terminal = true;
}

export interface OutcomeMeta {
  modelId: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

// Discriminated so callers narrow on status instead of asserting receipt exists.
export type ExtractionOutcome =
  | (OutcomeMeta & { status: 'EXTRACTED'; receipt: Receipt })
  | (OutcomeMeta & { status: 'FAILED'; failureReason: string });

// Default image prompts. Kept here so a plain Prompt (which only defines the text
// builders) still works on the image path without every prompt spelling these out.
const DEFAULT_IMAGE_USER = 'This is a photo of a single retail receipt. Extract it as JSON. Return the JSON now.';
function defaultImageRepair(previous: string, error: string): string {
  return [
    'Your previous output did not pass validation.',
    `Validation errors:\n${error}`,
    `Your previous output:\n${previous}`,
    'Return corrected JSON only, from the same receipt image.',
  ].join('\n\n');
}

// Extract from born-digital receipt text.
export async function extractReceipt(
  provider: ModelProvider,
  text: string,
  prompt: Prompt = activePrompt,
): Promise<ExtractionOutcome> {
  return runExtraction(
    provider,
    prompt,
    { system: prompt.system, user: prompt.buildUser(text) },
    (previous, error) => ({ system: prompt.system, user: prompt.buildRepair(text, previous, error) }),
  );
}

// Extract from a receipt photo. Same gate and repair contract as the text path,
// just an image-led request instead of text.
export async function extractReceiptFromImage(
  provider: ModelProvider,
  images: ImageInput[],
  prompt: Prompt = activePrompt,
): Promise<ExtractionOutcome> {
  const user = prompt.buildUserImage?.() ?? DEFAULT_IMAGE_USER;
  return runExtraction(
    provider,
    prompt,
    { system: prompt.system, user, images },
    (previous, error) => ({
      system: prompt.system,
      user: prompt.buildRepairImage?.(previous, error) ?? defaultImageRepair(previous, error),
      images,
    }),
  );
}

// The shared spine: one call, the Zod gate, exactly one repair pass, then an
// outcome. The two entry points differ only in how they build the requests.
async function runExtraction(
  provider: ModelProvider,
  prompt: Prompt,
  firstRequest: ModelRequest,
  buildRepair: (previous: string, error: string) => ModelRequest,
): Promise<ExtractionOutcome> {
  const started = Date.now();
  let inputTokens = 0;
  let outputTokens = 0;

  const first = await provider.complete(firstRequest);
  inputTokens += first.inputTokens;
  outputTokens += first.outputTokens;
  const modelId = first.modelId;

  let parsed = validate(first.text);

  // One repair pass. The model sees its own output and the exact Zod errors,
  // which fixes most near-misses without a second full guess.
  if (!parsed.ok) {
    const repair = await provider.complete(buildRepair(first.text, parsed.error));
    inputTokens += repair.inputTokens;
    outputTokens += repair.outputTokens;
    parsed = validate(repair.text);
  }

  const base = {
    modelId,
    promptVersion: prompt.version,
    inputTokens,
    outputTokens,
    latencyMs: Date.now() - started,
  };

  if (!parsed.ok) {
    return { status: 'FAILED', failureReason: parsed.error, ...base };
  }
  return { status: 'EXTRACTED', receipt: parsed.value, ...base };
}

type Validated = { ok: true; value: Receipt } | { ok: false; error: string };

function validate(modelText: string): Validated {
  let json: unknown;
  try {
    json = JSON.parse(stripFences(modelText));
  } catch {
    return { ok: false, error: 'model did not return valid JSON' };
  }
  const result = ReceiptSchema.safeParse(json);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, error: formatIssues(result.error.issues) };
}

// Models sometimes wrap JSON in a ```json fence despite being told not to.
function stripFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (fenced?.[1] ?? text).trim();
}

function formatIssues(issues: { path: (string | number)[]; message: string }[]): string {
  return issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}
