/**
 * Turn receipt text into a schema-valid Receipt, or a FAILED outcome with a
 * reason. Never trusts the model: every response goes through the Zod gate, and
 * a bad response gets exactly one repair attempt before it is marked FAILED.
 */
import { ReceiptSchema, type Receipt } from './schema';
import { activePrompt, type Prompt } from './prompt';
import type { ModelProvider } from './providers/types';

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

export async function extractReceipt(
  provider: ModelProvider,
  text: string,
  prompt: Prompt = activePrompt,
): Promise<ExtractionOutcome> {
  const started = Date.now();
  let inputTokens = 0;
  let outputTokens = 0;

  const first = await provider.complete({ system: prompt.system, user: prompt.buildUser(text) });
  inputTokens += first.inputTokens;
  outputTokens += first.outputTokens;
  const modelId = first.modelId;

  let parsed = validate(first.text);

  // One repair pass. The model sees its own output and the exact Zod errors,
  // which fixes most near-misses without a second full guess.
  if (!parsed.ok) {
    const repair = await provider.complete({
      system: prompt.system,
      user: prompt.buildRepair(text, first.text, parsed.error),
    });
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
