/**
 * Build synthetic stand-in responses for the golden set.
 *
 * DO NOT RUN THIS. The committed fixtures are real Bedrock responses, captured
 * with `npm run eval:record`. This script overwrites them with the gold label
 * plus injected errors, which silently turns the eval back into a test of the
 * harness rather than a measurement of the model.
 *
 * It is kept because it is how the fixtures were bootstrapped before there was
 * an AWS account to record against, and because a contributor without Bedrock
 * access needs some way to get a green `npm run eval`. If you run it, say so,
 * and do not let the result reach main.
 *
 * Guarded by DOCKET_ALLOW_SYNTHETIC=1 so it cannot be run by accident.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fixtureKey } from '../../src/lib/providers/recorded';
import { evalPrompts } from '../prompts';
import type { Prompt } from '../../src/lib/prompt';
import type { Receipt } from '../../src/lib/schema';

const GOLDEN = path.join(__dirname, '..', 'golden');
const FIXTURES = path.join(__dirname, '..', 'fixtures');
const MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function corruptV1(label: Receipt, idx: number): Receipt {
  const r = structuredClone(label);
  if (idx % 8 === 3) r.total = round2(label.total + 1);
  if (idx % 8 === 5) r.merchant = `${label.merchant} Inc`;
  if (idx % 11 === 0 && r.lineItems.length > 1) r.lineItems = r.lineItems.slice(0, -1);
  return r;
}

function corruptV2(label: Receipt, idx: number): Receipt {
  const r = corruptV1(label, idx);
  if (idx % 5 === 0 && r.tax !== undefined) r.tax = 0;
  if (idx % 6 === 0 && r.lineItems[0]) r.lineItems[0].amount = round2(r.lineItems[0].amount + 0.5);
  return r;
}

function corruptBroken(label: Receipt, idx: number): Receipt {
  const r = structuredClone(label);
  r.merchant = idx % 2 === 0 ? 'Store' : 'Unknown';
  r.total = round2(label.total * 1.2);
  if (r.lineItems.length > 1) r.lineItems = r.lineItems.slice(0, Math.ceil(r.lineItems.length / 2));
  if (idx % 3 === 0 && r.subtotal !== undefined) r.subtotal = round2(label.total * 1.2);
  return r;
}

function corrupt(version: string, label: Receipt, idx: number): Receipt {
  if (version === 'v1') return corruptV1(label, idx);
  if (version === 'v2') return corruptV2(label, idx);
  return corruptBroken(label, idx);
}

async function main(): Promise<void> {
  if (process.env.DOCKET_ALLOW_SYNTHETIC !== '1') {
    console.error('refusing to overwrite the recorded Bedrock fixtures with synthetic ones.');
    console.error('re-record them with `npm run eval:record`, or set DOCKET_ALLOW_SYNTHETIC=1 if you know why.');
    process.exit(2);
  }

  mkdirSync(FIXTURES, { recursive: true });
  const manifest = JSON.parse(readFileSync(path.join(GOLDEN, 'manifest.json'), 'utf8')) as {
    id: string;
    text: string;
    label: string;
  }[];

  let written = 0;
  for (let idx = 0; idx < manifest.length; idx++) {
    const item = manifest[idx]!;
    const label = JSON.parse(readFileSync(path.join(GOLDEN, item.label), 'utf8')) as Receipt;
    // Key off the exact text the eval will feed the provider.
    const text = readFileSync(path.join(GOLDEN, item.text), 'utf8');

    for (const [version, prompt] of Object.entries(evalPrompts) as [string, Prompt][]) {
      const responseJson = JSON.stringify(corrupt(version, label, idx));
      const key = fixtureKey({ system: prompt.system, user: prompt.buildUser(text) });
      const fixture = {
        text: responseJson,
        modelId: MODEL_ID,
        inputTokens: Math.round((prompt.system.length + text.length) / 4),
        outputTokens: Math.round(responseJson.length / 4),
      };
      writeFileSync(path.join(FIXTURES, `${key}.json`), JSON.stringify(fixture, null, 2));
      written += 1;
    }
  }

  const total = readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).length;
  console.log(`wrote ${written} fixtures (${total} files) into ${FIXTURES}`);
}

void main();
