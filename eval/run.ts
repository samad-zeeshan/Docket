/**
 * Eval harness. Runs the extractor over the golden set through a chosen provider,
 * scores every field, prints a table, writes results, and exits nonzero under the
 * threshold so it can gate CI.
 *
 * Default provider is `recorded`, which replays committed fixtures. That is what
 * makes `npm run eval` deterministic and free. Set DOCKET_PROVIDER=bedrock to run
 * it against a live model on an account with access.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { createProvider } from '../src/lib/providers';
import { extractReceipt } from '../src/lib/extract';
import { checkLineItems, type Receipt } from '../src/lib/schema';
import { promptByVersion } from './prompts';
import { scoreReceipt, zeroScore, aggregate, SCORED_FIELDS, type ReceiptScore } from './score';
import { costUsd, percentile, priceFor, projectMonthly } from './cost';

const GOLDEN = path.join(__dirname, 'golden');
const RESULTS = path.join(__dirname, 'results');

interface ManifestEntry {
  id: string;
  text: string;
  label: string;
  category: string;
}

interface CategoryScore {
  category: string;
  n: number;
  accuracy: number;
}

interface CostReport {
  modelId: string;
  perReceiptUsd: number;
  monthlyAt1kPerDay: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  measured: boolean;
}

interface LatencyReport {
  p50: number;
  p95: number;
  measured: boolean;
}

function arg(name: string, fallback: string): string {
  const flag = process.argv.indexOf(`--${name}`);
  if (flag >= 0 && process.argv[flag + 1]) return process.argv[flag + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : fallback;
}

async function main(): Promise<void> {
  const providerKind = process.env.DOCKET_PROVIDER ?? 'recorded';
  const promptVersion = arg('prompt', 'v1');
  const threshold = Number(arg('threshold', '0.90'));
  const prompt = promptByVersion(promptVersion);
  const provider = createProvider({
    ...process.env,
    DOCKET_PROVIDER: providerKind,
    DOCKET_FIXTURES: process.env.DOCKET_FIXTURES ?? path.join(__dirname, 'fixtures'),
  });

  const manifest = JSON.parse(readFileSync(path.join(GOLDEN, 'manifest.json'), 'utf8')) as ManifestEntry[];

  const scores: ReceiptScore[] = [];
  const receipts: { id: string; category: string; status: string; score: number; latencyMs: number }[] = [];
  const latencies: number[] = [];
  const byCategory = new Map<string, ReceiptScore[]>();
  let failures = 0;
  let lineItemMismatches = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let modelId = '';

  for (const entry of manifest) {
    const label = JSON.parse(readFileSync(path.join(GOLDEN, entry.label), 'utf8')) as Receipt;
    const text = readFileSync(path.join(GOLDEN, entry.text), 'utf8');
    const outcome = await extractReceipt(provider, text, prompt);
    latencies.push(outcome.latencyMs);
    inputTokens += outcome.inputTokens;
    outputTokens += outcome.outputTokens;
    modelId = outcome.modelId;

    let score: ReceiptScore;
    if (outcome.status === 'EXTRACTED') {
      score = scoreReceipt(outcome.receipt, label);
      // A valid receipt whose lines do not add up to its own subtotal. The gate
      // cannot see this. Count it so a regression here is visible.
      const lines = checkLineItems(outcome.receipt);
      if (lines && !lines.reconciles) lineItemMismatches += 1;
    } else {
      score = zeroScore();
      failures += 1;
    }
    scores.push(score);

    let list = byCategory.get(entry.category);
    if (!list) byCategory.set(entry.category, (list = []));
    list.push(score);

    receipts.push({
      id: entry.id,
      category: entry.category,
      status: outcome.status,
      score: Number(score.score.toFixed(4)),
      latencyMs: outcome.latencyMs,
    });
  }

  const agg = aggregate(scores);
  const pass = agg.overall >= threshold;
  const live = providerKind !== 'recorded';

  const perCategory: CategoryScore[] = [...byCategory]
    .map(([category, catScores]) => ({ category, n: catScores.length, accuracy: Number(aggregate(catScores).overall.toFixed(4)) }))
    .sort((a, b) => a.category.localeCompare(b.category));

  const n = manifest.length || 1;
  const price = priceFor(modelId);
  const perReceiptUsd = costUsd({ inputTokens: inputTokens / n, outputTokens: outputTokens / n }, price);
  const cost: CostReport = {
    modelId,
    perReceiptUsd: Number(perReceiptUsd.toFixed(6)),
    monthlyAt1kPerDay: Number(projectMonthly(perReceiptUsd, 1000).toFixed(2)),
    avgInputTokens: Math.round(inputTokens / n),
    avgOutputTokens: Math.round(outputTokens / n),
    measured: live,
  };
  const latency: LatencyReport = { p50: percentile(latencies, 50), p95: percentile(latencies, 95), measured: live };

  printTable(providerKind, promptVersion, agg, threshold, pass, { failures, lineItemMismatches, perCategory, cost, latency });

  mkdirSync(RESULTS, { recursive: true });
  const outFile = path.join(RESULTS, `${providerKind}-${promptVersion}.json`);
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        provider: providerKind,
        prompt: promptVersion,
        threshold,
        overall: Number(agg.overall.toFixed(4)),
        pass,
        perField: agg.perField,
        perCategory,
        cost,
        latency,
        n: agg.n,
        failures,
        lineItemMismatches,
        note: live
          ? 'live provider run, token counts and latency are measured'
          : 'recorded provider, replaying real Bedrock responses captured by npm run eval:record. Token counts are the counts the model reported. Latency is replay time and is not reported.',
        receipts,
      },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${outFile}`);

  process.exit(pass ? 0 : 1);
}

function printTable(
  provider: string,
  promptVersion: string,
  agg: ReturnType<typeof aggregate>,
  threshold: number,
  pass: boolean,
  extra: {
    failures: number;
    lineItemMismatches: number;
    perCategory: CategoryScore[];
    cost: CostReport;
    latency: LatencyReport;
  },
): void {
  console.log(`\nDocket eval  provider=${provider}  prompt=${promptVersion}  n=${agg.n}\n`);
  for (const field of SCORED_FIELDS) {
    console.log(`  ${field.padEnd(16)}${agg.perField[field].toFixed(3)}`);
  }
  console.log(`  ${''.padEnd(16)}${'------'}`);
  console.log(
    `  ${'overall'.padEnd(16)}${agg.overall.toFixed(3)}   threshold ${threshold.toFixed(3)}   ${pass ? 'PASS' : 'FAIL'}`,
  );
  console.log(`  ${'failures'.padEnd(16)}${extra.failures}`);
  // Extractions the gate accepted whose own lines do not add up to their own
  // subtotal. Not a failure, but not right either.
  console.log(`  ${'line mismatch'.padEnd(16)}${extra.lineItemMismatches}`);

  console.log(`\n  by category`);
  for (const c of extra.perCategory) {
    console.log(`  ${c.category.padEnd(16)}${c.accuracy.toFixed(3)}   n=${c.n}`);
  }

  // The fixtures hold the token counts the live model actually reported, so the
  // cost is real either way. Only the latency below is a replay artifact.
  const tag = extra.cost.measured ? 'measured' : 'from the recorded live responses';
  console.log(`\n  cost (${tag})`);
  console.log(
    `  ${'per receipt'.padEnd(16)}$${extra.cost.perReceiptUsd.toFixed(6)}   (${extra.cost.avgInputTokens} in / ${extra.cost.avgOutputTokens} out tokens)`,
  );
  console.log(`  ${'at 1k/day'.padEnd(16)}$${extra.cost.monthlyAt1kPerDay.toFixed(2)} / month`);

  // Latency percentiles only mean something against a live model. On the recorded
  // provider they are replay time, so do not report them as real.
  if (extra.latency.measured) {
    console.log(`\n  latency`);
    console.log(`  ${'p50'.padEnd(16)}${extra.latency.p50} ms`);
    console.log(`  ${'p95'.padEnd(16)}${extra.latency.p95} ms`);
  }
}

void main();
