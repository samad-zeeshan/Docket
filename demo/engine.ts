/**
 * Offline demo engine: the catalog, per-sample extraction, the two scenarios, and
 * the full eval, all on the recorded provider so they run with no AWS account.
 * Shared by the local server and the static-site build so both show identical
 * data. Uploads are not here, they live in the server because they need a model.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createProvider } from '../src/lib/providers';
import { extractReceipt } from '../src/lib/extract';
import { deriveDocId } from '../src/lib/docid';
import { scoreReceipt, zeroScore, aggregate, type ReceiptScore } from '../eval/score';
import { checkLineItems, type Receipt } from '../src/lib/schema';
import type { ModelProvider, ModelResult } from '../src/lib/providers/types';

const ROOT = path.join(__dirname, '..');
const GOLDEN = path.join(ROOT, 'eval', 'golden');

export const providerName = process.env.DOCKET_PROVIDER ?? 'recorded';
export const provider = createProvider({
  ...process.env,
  DOCKET_PROVIDER: providerName,
  DOCKET_FIXTURES: process.env.DOCKET_FIXTURES ?? path.join(ROOT, 'eval', 'fixtures'),
});

interface ManifestEntry {
  id: string;
  text: string;
  label: string;
  category: string;
}

const manifest = JSON.parse(readFileSync(path.join(GOLDEN, 'manifest.json'), 'utf8')) as ManifestEntry[];

function labelOf(id: string): Receipt {
  return JSON.parse(readFileSync(path.join(GOLDEN, 'labels', `${id}.json`), 'utf8')) as Receipt;
}

function textOf(entry: ManifestEntry): string {
  return readFileSync(path.join(GOLDEN, entry.text), 'utf8');
}

// The receipt strip. Only what the UI needs to render a chip.
export function catalog() {
  return manifest.map((m) => {
    const label = labelOf(m.id);
    return {
      id: m.id,
      merchant: label.merchant,
      date: label.date,
      currency: label.currency,
      total: label.total,
      items: label.lineItems.length,
      category: m.category,
    };
  });
}

export async function extractOne(id: string) {
  const entry = manifest.find((m) => m.id === id);
  if (!entry) throw new Error(`unknown id ${id}`);
  const text = textOf(entry);
  const label = labelOf(id);
  const outcome = await extractReceipt(provider, text);
  // A demo docId, derived the same way the pipeline does, just off a stable key.
  const docId = deriveDocId('docket-demo', `${id}.pdf`, id);

  const scored = outcome.status === 'EXTRACTED' ? scoreReceipt(outcome.receipt, label) : zeroScore();
  return {
    id,
    provider: providerName,
    promptVersion: outcome.promptVersion,
    docId,
    status: outcome.status,
    text,
    label,
    receipt: outcome.status === 'EXTRACTED' ? outcome.receipt : null,
    failureReason: outcome.status === 'FAILED' ? outcome.failureReason : null,
    latencyMs: outcome.latencyMs,
    inputTokens: outcome.inputTokens,
    outputTokens: outcome.outputTokens,
    fields: scored.fields,
    score: scored.score,
    // The check that needs no answer key. It is what catches r37, and the static
    // site is built from here, so without this the hosted demo shows every check
    // the pipeline runs except the one the docs point at.
    lines: outcome.status === 'EXTRACTED' ? (checkLineItems(outcome.receipt) ?? null) : null,
  };
}

// Stands in for a model that returns data missing required fields, so the
// scenario can show the schema gate refusing bad output.
class RejectingProvider implements ModelProvider {
  readonly name = 'demo-stub';
  async complete(): Promise<ModelResult> {
    return { text: '{ "merchant": "Corner Grocery", "items": 3 }', modelId: 'demo-stub', inputTokens: 44, outputTokens: 12 };
  }
}

export async function scenario(kind: string) {
  if (kind === 'rejected') {
    const entry = manifest.find((m) => m.id === 'r02')!;
    const text = textOf(entry);
    const outcome = await extractReceipt(new RejectingProvider(), text);
    return {
      kind,
      status: outcome.status,
      failureReason: outcome.status === 'FAILED' ? outcome.failureReason : null,
      badOutput: '{ "merchant": "Corner Grocery", "items": 3 }',
      text,
    };
  }
  if (kind === 'idempotent') {
    const base = await extractOne('r02');
    // The same two-write check the pipeline does with a conditional put: the
    // second write for a docId that already exists is a no-op.
    const seen = new Set<string>();
    const first = seen.has(base.docId) ? 'duplicate' : (seen.add(base.docId), 'created');
    const second = seen.has(base.docId) ? 'duplicate' : (seen.add(base.docId), 'created');
    return { kind, docId: base.docId, merchant: base.label.merchant, receipt: base.receipt, text: base.text, first, second };
  }
  throw new Error(`unknown scenario ${kind}`);
}

export async function evalAll() {
  const scores: ReceiptScore[] = [];
  const byCategory = new Map<string, ReceiptScore[]>();
  let failures = 0;
  // Extractions the gate accepted whose own lines do not add up to their own
  // subtotal. Reported alongside failures, as eval/run.ts does, so the demo and
  // the CLI report the same numbers.
  let lineItemMismatches = 0;
  for (const m of manifest) {
    const label = labelOf(m.id);
    const outcome = await extractReceipt(provider, textOf(m));
    const score = outcome.status === 'EXTRACTED' ? scoreReceipt(outcome.receipt, label) : zeroScore();
    if (outcome.status === 'EXTRACTED') {
      const lines = checkLineItems(outcome.receipt);
      if (lines && !lines.reconciles) lineItemMismatches += 1;
    } else {
      failures += 1;
    }
    scores.push(score);
    let list = byCategory.get(m.category);
    if (!list) byCategory.set(m.category, (list = []));
    list.push(score);
  }
  const agg = aggregate(scores);
  const perCategory = [...byCategory]
    .map(([category, s]) => ({ category, n: s.length, accuracy: Number(aggregate(s).overall.toFixed(4)) }))
    .sort((a, b) => a.category.localeCompare(b.category));
  return {
    provider: providerName,
    n: agg.n,
    overall: agg.overall,
    perField: agg.perField,
    perCategory,
    failures,
    lineItemMismatches,
    threshold: 0.9,
  };
}
