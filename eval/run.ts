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
import type { Receipt } from '../src/lib/schema';
import { promptByVersion } from './prompts';
import { scoreReceipt, zeroScore, aggregate, SCORED_FIELDS, type ReceiptScore } from './score';

const GOLDEN = path.join(__dirname, 'golden');
const RESULTS = path.join(__dirname, 'results');

interface ManifestEntry {
  id: string;
  text: string;
  label: string;
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
  const receipts: { id: string; status: string; score: number }[] = [];
  let failures = 0;
  let latencyMs = 0;
  let tokens = 0;

  for (const entry of manifest) {
    const label = JSON.parse(readFileSync(path.join(GOLDEN, entry.label), 'utf8')) as Receipt;
    const text = readFileSync(path.join(GOLDEN, entry.text), 'utf8');
    const outcome = await extractReceipt(provider, text, prompt);
    latencyMs += outcome.latencyMs;
    tokens += outcome.inputTokens + outcome.outputTokens;

    const score = outcome.status === 'EXTRACTED' ? scoreReceipt(outcome.receipt, label) : zeroScore();
    if (outcome.status !== 'EXTRACTED') failures += 1;
    scores.push(score);
    receipts.push({ id: entry.id, status: outcome.status, score: Number(score.score.toFixed(4)) });
  }

  const agg = aggregate(scores);
  const pass = agg.overall >= threshold;
  const live = providerKind !== 'recorded';

  printTable(providerKind, promptVersion, agg, threshold, pass, { failures, latencyMs, tokens, live });

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
        n: agg.n,
        failures,
        note: live ? 'live provider run' : 'recorded provider, fixtures are synthetic stand-ins for a model',
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
  extra: { failures: number; latencyMs: number; tokens: number; live: boolean },
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
  // Latency and token totals only mean something against a live model. On the
  // recorded provider they are replay artifacts, so do not report them as real.
  if (extra.live) {
    console.log(`  ${'latency total'.padEnd(16)}${extra.latencyMs} ms`);
    console.log(`  ${'tokens total'.padEnd(16)}${extra.tokens}`);
  }
}

void main();
