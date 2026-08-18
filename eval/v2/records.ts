/**
 * Join raw small model runs with labels and image statistics into the per field records that CI replays.
 *
 * Needs the datasets in .cache, so it runs locally. Its output under eval/v2/data is committed and holds no receipt images or labels.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { LABELS, type PreparedReceipt } from '../public/fetch';
import { RUNS, perturbationSubset, type RunLine } from '../public/run-small';
import { fieldCorrectness } from './score-fields';
import { scoreReceipt } from '../score';
import { imageStats, type ImageStats } from '../../src/lib/imagestats';
import { signalsFromEvidence, type Signals } from '../../src/lib/calibrate';
import { deriveDocId } from '../../src/lib/docid';
import { CONFIDENCE_FIELDS } from '../../src/lib/confidence';
import type { Receipt } from '../../src/lib/schema';
import type { LabelField } from '../public/map';

export const DATA = path.join(__dirname, 'data');
const GOLDEN = path.join(__dirname, '..', 'golden');

export interface V2Record {
  id: string;
  source: string;
  split: string;
  variant: string;
  status: 'EXTRACTED' | 'FAILED';
  repaired: boolean;
  inputTokens: number;
  outputTokens: number;
  seconds: number;
  correct: Partial<Record<LabelField | 'currency', number>>;
  // The golden slice is scored with the v1 metric too, so it lines up with the
  // Claude numbers: line items as F1, not all or nothing.
  goldenScore?: Record<string, number>;
  signals?: Signals;
  stats?: ImageStats;
}

function readRun(name: string): RunLine[] {
  const file = path.join(RUNS, `${name}.jsonl`);
  if (!existsSync(file)) return [];
  // Last write wins, so a receipt re-run after a crash replaces its earlier line.
  const byKey = new Map<string, RunLine>();
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    const r = JSON.parse(l) as RunLine;
    byKey.set(`${r.id}|${r.variant}`, r);
  }
  return [...byKey.values()].sort((a, b) => (a.id + a.variant).localeCompare(b.id + b.variant));
}

function signalsOf(line: RunLine): Signals | undefined {
  if (line.status !== 'EXTRACTED' || !line.receipt || !line.text) return undefined;
  const s = signalsFromEvidence(line.receipt as Receipt, {
    text: line.text,
    tokenLogprobs: line.tokens?.map(([token, logprob]) => ({ token, logprob })),
    repaired: line.repaired ?? false,
  });
  // Four decimals is plenty and keeps the committed files diffable.
  const r = (o: Partial<Record<string, number>>) =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round((v ?? 0) * 1e4) / 1e4]));
  return { ...s, verbalized: r(s.verbalized), logprob: r(s.logprob) };
}

function base(line: RunLine) {
  return {
    variant: line.variant,
    status: line.status,
    repaired: line.repaired ?? false,
    inputTokens: line.inputTokens,
    outputTokens: line.outputTokens,
    seconds: Math.round(line.seconds * 10) / 10,
  };
}

function publicRecords(set: string, labels: Map<string, PreparedReceipt>, withStats: boolean): V2Record[] {
  return readRun(set).map((line) => {
    const label = labels.get(line.id)!;
    const pred = line.status === 'EXTRACTED' ? (line.receipt as Receipt) : undefined;
    return {
      id: line.id,
      source: label.source,
      split: label.split,
      ...base(line),
      correct: fieldCorrectness(pred, label.label, label.fields),
      signals: signalsOf(line),
      stats: withStats && line.variant === 'clean' ? imageStats(readFileSync(label.image), 'image/jpeg') : undefined,
    };
  });
}

function goldenRecords(set: string): V2Record[] {
  return readRun(set).map((line) => {
    const gold = JSON.parse(readFileSync(path.join(GOLDEN, 'labels', `${line.id}.json`), 'utf8')) as Receipt;
    const pred = line.status === 'EXTRACTED' ? (line.receipt as Receipt) : undefined;
    const score = pred ? scoreReceipt(pred, gold).fields : undefined;
    const correct: V2Record['correct'] = {};
    for (const f of CONFIDENCE_FIELDS) correct[f] = score ? (score[f] === 1 ? 1 : 0) : 0;
    return {
      id: line.id,
      source: 'golden',
      split: 'golden',
      ...base(line),
      correct,
      goldenScore: score ? { ...score } : undefined,
      signals: signalsOf(line),
    };
  });
}

export interface HomogeneityPair {
  a: string;
  b: string;
  merchant: string;
  idsDiffer: boolean;
  swaps: string[];
}

// Near identical receipts: same SROIE merchant, same template. The content
// derived id must tell them apart, and no field may come back with the other
// receipt's value in it (arXiv 2606.25343).
function homogeneity(labels: PreparedReceipt[], main: RunLine[]): { pairs: HomogeneityPair[]; reencodedSameId: boolean } {
  const pred = new Map(main.filter((l) => l.status === 'EXTRACTED').map((l) => [l.id, l.receipt as Receipt]));
  const byMerchant = new Map<string, PreparedReceipt[]>();
  for (const r of labels) {
    if (r.source !== 'sroie' || !r.label.merchant) continue;
    const key = r.label.merchant.toUpperCase().replace(/[^A-Z0-9]/g, '');
    byMerchant.set(key, [...(byMerchant.get(key) ?? []), r]);
  }
  const pairs: HomogeneityPair[] = [];
  const etag = (file: string) => createHash('md5').update(readFileSync(file)).digest('hex');
  for (const group of [...byMerchant.values()].filter((g) => g.length >= 2).sort((x, y) => y.length - x.length)) {
    const sorted = [...group].sort((x, y) => x.id.localeCompare(y.id));
    for (let i = 0; i + 1 < sorted.length; i += 2) {
      const a = sorted[i]!;
      const b = sorted[i + 1]!;
      const idA = deriveDocId('ingest', 'upload/receipt.jpg', etag(a.image));
      const idB = deriveDocId('ingest', 'upload/receipt.jpg', etag(b.image));
      const swaps: string[] = [];
      const pa = pred.get(a.id);
      const pb = pred.get(b.id);
      for (const f of ['date', 'total'] as const) {
        const la = a.label[f];
        const lb = b.label[f];
        if (la === undefined || lb === undefined || la === lb) continue;
        if (pa && pa[f] === lb && pa[f] !== la) swaps.push(`${a.id}.${f}`);
        if (pb && pb[f] === la && pb[f] !== lb) swaps.push(`${b.id}.${f}`);
      }
      pairs.push({ a: a.id, b: b.id, merchant: a.label.merchant!, idsDiffer: idA !== idB, swaps });
    }
  }
  // The id hashes the bytes, so the same paper photographed or re-saved twice is
  // two documents. That is a known limit of the design, measured here, not fixed.
  const one = labels.find((r) => r.source === 'sroie')!;
  const reencoded = Buffer.concat([readFileSync(one.image), Buffer.from([0])]);
  const reencodedSameId =
    deriveDocId('ingest', 'upload/receipt.jpg', etag(one.image)) ===
    deriveDocId('ingest', 'upload/receipt.jpg', createHash('md5').update(reencoded).digest('hex'));
  return { pairs, reencodedSameId };
}

function writeJsonl(name: string, rows: unknown[]): void {
  writeFileSync(path.join(DATA, name), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

export function main(): void {
  mkdirSync(DATA, { recursive: true });
  const all = JSON.parse(readFileSync(LABELS, 'utf8')) as PreparedReceipt[];
  const labels = new Map(all.map((r) => [r.id, r]));
  writeJsonl('main.jsonl', publicRecords('main', labels, true));
  writeJsonl('perturb.jsonl', publicRecords('perturb', labels, false));
  writeJsonl('unconstrained.jsonl', publicRecords('unconstrained', labels, false));
  writeJsonl('golden.jsonl', goldenRecords('golden'));
  writeJsonl('golden-unconstrained.jsonl', goldenRecords('golden-unconstrained'));
  const subset = perturbationSubset(all).map((r) => r.id);
  writeFileSync(path.join(DATA, 'perturb-subset.json'), JSON.stringify(subset, null, 1) + '\n');
  writeFileSync(path.join(DATA, 'homogeneity.json'), JSON.stringify(homogeneity(all, readRun('main')), null, 1) + '\n');
  // The raw answers, without token probabilities, so anyone with the datasets can
  // rescore without a GPU. Same content the model wrote, nothing from the labels.
  for (const set of ['main', 'perturb', 'unconstrained', 'golden', 'golden-unconstrained']) {
    writeJsonl(`responses-${set}.jsonl`, readRun(set).map((l) => ({ id: l.id, variant: l.variant, text: l.text ?? null, failureReason: l.failureReason ?? null })));
  }
  console.log(`wrote records to ${DATA}`);
}

if (require.main === module) main();
