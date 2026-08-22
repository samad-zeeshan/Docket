/**
 * Pick the four demo receipts from the recorded runs and write them, with small CORD images, to demo/v2.
 *
 * Runs locally, because it needs the datasets. Only CORD images are copied (CC BY 4.0). The SROIE pair is shown as values, not pictures.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import sharp from 'sharp';
import { LABELS, type PreparedReceipt } from '../eval/public/fetch';
import { RUNS, type RunLine } from '../eval/public/run-small';
import { perturb } from '../eval/public/perturb';
import { fieldCorrectness } from '../eval/v2/score-fields';
import { calibratedConfidence, reviewDecision, signalsFromEvidence, type CalibrationParams } from '../src/lib/calibrate';
import { deriveDocId } from '../src/lib/docid';
import type { Receipt } from '../src/lib/schema';
import calibration from '../src/lib/params/calibration.json';

const OUT = path.join(__dirname, 'v2');
const params = calibration as CalibrationParams;

function run(name: string): RunLine[] {
  return readFileSync(path.join(RUNS, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RunLine);
}

function view(line: RunLine, label: PreparedReceipt) {
  const pred = line.status === 'EXTRACTED' ? (line.receipt as Receipt) : undefined;
  const correct = fieldCorrectness(pred, label.label, label.fields);
  const signals = pred ? signalsFromEvidence(pred, { text: line.text!, tokenLogprobs: line.tokens?.map(([token, logprob]) => ({ token, logprob })), repaired: line.repaired ?? false }) : undefined;
  const conf = signals ? calibratedConfidence(params, signals) : {};
  const decision = signals ? reviewDecision(params, conf, signals) : { needsReview: false, reason: 'failed the schema gate' };
  return {
    id: line.id,
    variant: line.variant,
    status: line.status,
    receipt: pred ?? null,
    failureReason: line.failureReason ?? null,
    needsReview: line.status === 'EXTRACTED' ? decision.needsReview : null,
    reason: decision.reason,
    fields: label.fields.map((f) => ({
      field: f,
      predicted: pred ? (pred[f] ?? null) : null,
      label: label.label[f] ?? null,
      correct: correct[f] === 1,
      confidence: conf[f] === undefined ? null : Math.round(conf[f]! * 1000) / 1000,
    })),
  };
}

async function image(label: PreparedReceipt, variant: string, name: string): Promise<{ file: string; sha256: string }> {
  const bytes = await sharp(await perturb(readFileSync(label.image), variant)).resize({ width: 520, withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
  writeFileSync(path.join(OUT, name), bytes);
  return { file: `v2/${name}`, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const labels = new Map((JSON.parse(readFileSync(LABELS, 'utf8')) as PreparedReceipt[]).map((r) => [r.id, r]));
  const main = run('main').filter((l) => labels.get(l.id)!.source === 'cord' && labels.get(l.id)!.split === 'test');
  const views = main.map((l) => ({ l, v: view(l, labels.get(l.id)!) })).sort((a, b) => a.l.id.localeCompare(b.l.id));

  // Standard: every labelled field right and let through. Hard: at least one field
  // wrong. Prefer one the confidence caught, since that is the case the design is for.
  const standard = views.find(({ v }) => v.status === 'EXTRACTED' && v.fields.every((f) => f.correct) && !v.needsReview) ?? views.find(({ v }) => v.fields.every((f) => f.correct))!;
  const hard =
    views.find(({ v }) => v.status === 'EXTRACTED' && v.fields.some((f) => !f.correct) && v.needsReview && v.fields.length >= 3) ??
    views.find(({ v }) => v.fields.some((f) => !f.correct))!;

  const pert = run('perturb').filter((l) => l.variant === 'blur-3' && labels.get(l.id)!.source === 'cord').sort((a, b) => a.id.localeCompare(b.id));
  const blurred = pert.map((l) => ({ l, v: view(l, labels.get(l.id)!) })).find(({ v }) => v.fields.some((f) => !f.correct)) ?? { l: pert[0]!, v: view(pert[0]!, labels.get(pert[0]!.id)!) };

  const homogeneity = JSON.parse(readFileSync(path.join(__dirname, '..', 'eval', 'v2', 'data', 'homogeneity.json'), 'utf8')) as { pairs: { a: string; b: string; merchant: string; idsDiffer: boolean; swaps: string[] }[] };
  const byId = new Map(run('main').map((l) => [l.id, l]));
  const pair = homogeneity.pairs.find((p) => labels.get(p.a)!.label.total !== labels.get(p.b)!.label.total && byId.get(p.a) && byId.get(p.b))!;
  const etag = (id: string) => createHash('md5').update(readFileSync(labels.get(id)!.image)).digest('hex');

  const examples = {
    standard: { ...standard.v, image: await image(labels.get(standard.l.id)!, 'clean', 'standard.jpg') },
    hard: { ...hard.v, image: await image(labels.get(hard.l.id)!, 'clean', 'hard.jpg') },
    blurred: { ...blurred.v, image: await image(labels.get(blurred.l.id)!, 'blur-3', 'blurred.jpg') },
    pair: {
      merchant: pair.merchant,
      swaps: pair.swaps,
      items: [pair.a, pair.b].map((id) => ({
        ...view(byId.get(id)!, labels.get(id)!),
        docId: deriveDocId('ingest', 'upload/receipt.jpg', etag(id)),
      })),
    },
    attribution: 'Receipt images from CORD v2 (Park et al., NAVER Clova), CC BY 4.0, resized; the blurred one is blurred on purpose.',
  };
  writeFileSync(path.join(OUT, 'examples.json'), JSON.stringify(examples, null, 1) + '\n');
  console.log(`picked ${standard.l.id}, ${hard.l.id}, ${blurred.l.id} and the pair ${pair.a} ${pair.b}`);
}

if (require.main === module) void main();
