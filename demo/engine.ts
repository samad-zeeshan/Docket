/**
 * The golden set eval for the demo page, on the recorded provider so it runs with no AWS account.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createProvider } from '../src/lib/providers';
import { extractReceipt } from '../src/lib/extract';
import { scoreReceipt, zeroScore, aggregate, type ReceiptScore } from '../eval/score';
import { checkLineItems, type Receipt } from '../src/lib/schema';

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
