/**
 * Build the v2 results from the committed records: calibration, straight-through curve and ladder, routing and cost, robustness.
 *
 * Deterministic and offline. With --check it rebuilds everything and fails if any committed result or parameter file differs.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { DATA, type V2Record } from './records';
import { auroc, brier, ece, reliability, round } from './metrics';
import { fitIsotonic, fitLogistic } from './fit';
import { operatingPoint, stpAt, stpCurve, thresholdGrid, type ScoredDoc } from './stp';
import { validityLadder } from './ladder';
import { lineChart, reliabilityDiagram } from './svg';
import { allVariants } from '../public/perturb';
import { fieldFeatures, fusedScore, isotonicPredict, type CalibrationParams, type FieldCalibrator } from '../../src/lib/calibrate';
import { routerFeatures, routerScore, type RouterParams } from '../../src/lib/router';
import type { ConfidenceField } from '../../src/lib/confidence';
import { RecordedProvider } from '../../src/lib/providers/recorded';
import { extractReceipt } from '../../src/lib/extract';
import { promptV1 } from '../../src/lib/prompt';
import { scoreReceipt, zeroScore, aggregate, type ReceiptScore } from '../score';
import { costUsd, priceFor } from '../cost';
import type { Receipt } from '../../src/lib/schema';

const ROOT = path.join(__dirname, '..', '..');
const RESULTS = path.join(ROOT, 'eval', 'results');
const PARAMS = path.join(ROOT, 'src', 'lib', 'params');
const SMALL_MODEL = 'qwen/qwen3.5-9b (Q6_K, LM Studio)';
const ALPHAS = [0.01, 0.05, 0.1];
const DELTA = 0.1;
const FIELDS: ConfidenceField[] = ['merchant', 'date', 'total', 'subtotal', 'tax', 'lineItems'];

function readJsonl(name: string): V2Record[] {
  const file = path.join(DATA, name);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as V2Record);
}

const labelled = (r: V2Record) => Object.keys(r.correct) as ConfidenceField[];

// ---------- calibration ----------

interface FieldRow {
  field: ConfidenceField;
  n: { fit: number; val: number; test: number };
  testAccuracy: number;
  verbalized: { ece: number; auroc: number | null; brier: number };
  logprob: { ece: number; auroc: number | null; brier: number };
  calibrated: { ece: number; auroc: number | null; brier: number };
  reliabilityVerbalized: ReturnType<typeof reliability>;
  reliabilityCalibrated: ReturnType<typeof reliability>;
}

function metricSet(conf: number[], y: number[]) {
  return { ece: round(ece(conf, y)), auroc: auroc(conf, y) === undefined ? null : round(auroc(conf, y)!), brier: round(brier(conf, y)) };
}

function fitCalibrators(main: V2Record[]): { params: CalibrationParams['fields']; rows: FieldRow[] } {
  const params: CalibrationParams['fields'] = {};
  const rows: FieldRow[] = [];
  for (const field of FIELDS) {
    const use = (split: string) => main.filter((r) => r.split === split && r.status === 'EXTRACTED' && r.signals && r.correct[field] !== undefined);
    const fit = use('fit');
    const val = use('val');
    const test = use('test');
    if (fit.length < 30) continue;
    const X = (rs: V2Record[]) => rs.map((r) => fieldFeatures(field, r.signals!));
    const Y = (rs: V2Record[]) => rs.map((r) => r.correct[field]!);
    const weights = fitLogistic(X(fit), Y(fit));
    const partial: FieldCalibrator = { weights, isotonic: { x: [], y: [] } };
    // Isotonic on val, not fit. Refitting on the rows that trained the weights is
    // the score-refit leakage 2608.14639 names as its second failure mode.
    const isotonic = fitIsotonic(X(val).map((x) => fusedScore(partial, x)), Y(val));
    const cal: FieldCalibrator = { weights, isotonic };
    params[field] = cal;
    const yTest = Y(test);
    const calibrated = X(test).map((x) => isotonicPredict(isotonic, fusedScore(cal, x)));
    const verbal = test.map((r) => r.signals!.verbalized[field] ?? 0.5);
    const lp = test.map((r) => r.signals!.logprob[field] ?? 0.5);
    rows.push({
      field,
      n: { fit: fit.length, val: val.length, test: test.length },
      testAccuracy: round(yTest.reduce((a, b) => a + b, 0) / (yTest.length || 1)),
      verbalized: metricSet(verbal, yTest),
      logprob: metricSet(lp, yTest),
      calibrated: metricSet(calibrated, yTest),
      reliabilityVerbalized: reliability(verbal, yTest),
      reliabilityCalibrated: reliability(calibrated, yTest),
    });
  }
  return { params, rows };
}

// ---------- straight-through ----------

type Scorer = (r: V2Record, f: ConfidenceField) => number;

// Two decision rules. Conditioned: a receipt is judged on the fields calibrated
// for its document type, which needs the type to be known. Pooled: judged on every
// calibrated field, which is what the pipeline does today. Errors are always
// counted on the labelled fields.
function docs(records: V2Record[], score: Scorer, pooled = false): ScoredDoc[] {
  return records.map((r) => {
    const ok = r.status === 'EXTRACTED' && r.signals !== undefined;
    return {
      id: r.id,
      extracted: ok,
      fields: ok ? labelled(r).map((f) => ({ confidence: score(r, f), correct: r.correct[f]! })) : [],
      decision: ok && pooled ? Math.min(...FIELDS.map((f) => score(r, f))) : undefined,
    };
  });
}

// A field without a calibrator does not take part in the decision, so it scores 1
// rather than blocking every receipt.
function calibratedScorer(params: CalibrationParams['fields']): Scorer {
  return (r, f) => {
    const cal = params[f];
    if (!cal) return 1;
    return r.signals ? isotonicPredict(cal.isotonic, fusedScore(cal, fieldFeatures(f, r.signals))) : 0;
  };
}

const verbalScorer: Scorer = (r, f) => r.signals?.verbalized[f] ?? 0;

function stpSection(main: V2Record[], params: CalibrationParams['fields']) {
  const val = main.filter((r) => r.split === 'val');
  const test = main.filter((r) => r.split === 'test');
  const cal = calibratedScorer(params);
  const coarse = thresholdGrid(0.005);
  const operating = ALPHAS.map((alpha) => {
    const chosen = operatingPoint(docs(val, cal), alpha);
    const baseline = operatingPoint(docs(val, verbalScorer), alpha);
    return {
      alpha,
      threshold: chosen?.threshold ?? null,
      test: chosen ? stpAt(docs(test, cal), chosen.threshold) : null,
      bySource: Object.fromEntries(
        ['sroie', 'cord'].map((s) => [s, chosen ? stpAt(docs(test.filter((r) => r.source === s), cal), chosen.threshold) : null]),
      ),
      verbalizedBaseline: { threshold: baseline?.threshold ?? null, test: baseline ? stpAt(docs(test, verbalScorer), baseline.threshold) : null },
    };
  });
  const pooled = ALPHAS.map((alpha) => {
    const chosen = operatingPoint(docs(val, cal, true), alpha);
    return { alpha, threshold: chosen?.threshold ?? null, test: chosen ? stpAt(docs(test, cal, true), chosen.threshold) : null };
  });
  return {
    alphaForPipeline: 0.01,
    split: { val: val.length, test: test.length },
    schemaFailuresTest: test.filter((r) => r.status === 'FAILED').length,
    curveCalibrated: stpCurve(docs(test, cal), coarse),
    curveVerbalized: stpCurve(docs(test, verbalScorer), coarse),
    operating,
    pooled,
    ladder: ALPHAS.map((alpha) => validityLadder(docs(val, cal), docs(test, cal), alpha, DELTA)),
  };
}

// ---------- routing and cost ----------

// Claude's cost on a photo is estimated, not measured: Bedrock credentials were
// not available for the public sets. Image tokens follow Anthropic's published
// rule of width times height over 750, plus v1's recorded text path averages.
const V1_PROMPT_TOKENS = 311;
const V1_OUTPUT_TOKENS = 182;
const HAIKU = priceFor('us.anthropic.claude-haiku-4-5-20251001-v1:0');

function claudeImageCost(r: V2Record): number {
  const px = (r.stats?.width ?? 0) * (r.stats?.height ?? 0);
  return costUsd({ inputTokens: px / 750 + V1_PROMPT_TOKENS, outputTokens: V1_OUTPUT_TOKENS }, HAIKU);
}

const sufficed = (r: V2Record) => r.status === 'EXTRACTED' && labelled(r).every((f) => r.correct[f] === 1);

function fitRouter(main: V2Record[]): RouterParams {
  const fit = main.filter((r) => r.split === 'fit' && r.stats);
  const F = fit.map((r) => routerFeatures(r.stats!));
  const d = F[0]!.length;
  const mean = Array.from({ length: d }, (_, j) => round(F.reduce((a, x) => a + x[j]!, 0) / F.length, 6));
  const std = Array.from({ length: d }, (_, j) => round(Math.sqrt(F.reduce((a, x) => a + (x[j]! - mean[j]!) ** 2, 0) / F.length) || 1, 6));
  const X = F.map((x) => [1, ...x.map((v, j) => (v - mean[j]!) / std[j]!)]);
  const weights = fitLogistic(X, fit.map((r) => (sufficed(r) ? 1 : 0)));
  const params: RouterParams = { model: SMALL_MODEL, mean, std, weights, threshold: 0.5 };
  // Threshold on val: the most accurate cut, ties to the higher one so doubt
  // resolves to the large model.
  const val = main.filter((r) => r.split === 'val' && r.stats);
  let best = { t: 0.5, acc: -1 };
  for (const t of thresholdGrid(0.01)) {
    const acc = val.filter((r) => (routerScore(params, r.stats!) >= t) === sufficed(r)).length / (val.length || 1);
    if (acc > best.acc) best = { t, acc };
  }
  return { ...params, threshold: best.t };
}

function routingSection(main: V2Record[], router: RouterParams, goldenPaths: unknown, uncon: V2Record[]) {
  const test = main.filter((r) => r.split === 'test' && r.stats);
  const score = test.map((r) => routerScore(router, r.stats!));
  const label: number[] = test.map((r) => (sufficed(r) ? 1 : 0));
  const routedSmall = test.filter((_, i) => score[i]! >= router.threshold);
  const routedLarge = test.filter((_, i) => score[i]! < router.threshold);
  const acc = test.filter((r, i) => (score[i]! >= router.threshold) === sufficed(r)).length / (test.length || 1);
  const fieldErr = (rs: V2Record[]) => {
    const all = rs.flatMap((r) => labelled(r).map((f) => r.correct[f]!));
    return all.length ? round(1 - all.reduce((a, b) => a + b, 0) / all.length) : null;
  };
  const claudePer1k = round((test.reduce((a, r) => a + claudeImageCost(r), 0) / (test.length || 1)) * 1000);
  const escalations = routedSmall.filter((r) => r.status === 'FAILED');
  const routedCost = round(((routedLarge.length + escalations.length) / (test.length || 1)) * claudePer1k);
  const smallTokens = main.filter((r) => r.variant === 'clean');
  const sub = new Set(uncon.map((r) => r.id));
  const constrainedOnSub = main.filter((r) => sub.has(r.id));
  return {
    smallModel: SMALL_MODEL,
    router: {
      testN: test.length,
      smallSufficesRate: round(label.reduce((a, b) => a + b, 0) / (label.length || 1)),
      accuracy: round(acc),
      auroc: auroc(score, label) === undefined ? null : round(auroc(score, label)!),
      threshold: router.threshold,
      routedSmallShare: round(routedSmall.length / (test.length || 1)),
      fieldErrorRoutedSmall: fieldErr(routedSmall),
      fieldErrorRoutedLarge: fieldErr(routedLarge),
      escalatedOnGateFailure: escalations.length,
    },
    cost: {
      note: 'Claude cost on photos is an estimate from Anthropic image token rule and v1 recorded averages. The small model has no API cost; its token counts are measured.',
      claudeEstimatePer1k: claudePer1k,
      routedEstimatePer1k: routedCost,
      smallApiPer1k: 0,
      smallAvgInputTokens: Math.round(smallTokens.reduce((a, r) => a + r.inputTokens, 0) / (smallTokens.length || 1)),
      smallAvgOutputTokens: Math.round(smallTokens.reduce((a, r) => a + r.outputTokens, 0) / (smallTokens.length || 1)),
    },
    paths: goldenPaths,
    constrainedVsUnconstrained: {
      n: uncon.length,
      constrained: validity(constrainedOnSub),
      unconstrained: validity(uncon),
    },
  };
}

function validity(rs: V2Record[]) {
  const n = rs.length || 1;
  const all = rs.flatMap((r) => labelled(r).map((f) => r.correct[f]!));
  return {
    schemaValidFirstTry: round(rs.filter((r) => r.status === 'EXTRACTED' && !r.repaired).length / n),
    schemaValidAfterRepair: round(rs.filter((r) => r.status === 'EXTRACTED').length / n),
    contentAccuracy: all.length ? round(all.reduce((a, b) => a + b, 0) / all.length) : null,
  };
}

async function goldenPaths() {
  const golden = path.join(ROOT, 'eval', 'golden');
  const manifest = JSON.parse(readFileSync(path.join(golden, 'manifest.json'), 'utf8')) as { id: string; text: string; label: string }[];
  const provider = new RecordedProvider(path.join(ROOT, 'eval', 'fixtures'));
  const claude: ReceiptScore[] = [];
  let firstTry = 0;
  let valid = 0;
  for (const m of manifest) {
    const o = await extractReceipt(provider, readFileSync(path.join(golden, m.text), 'utf8'), promptV1);
    const gold = JSON.parse(readFileSync(path.join(golden, m.label), 'utf8')) as Receipt;
    claude.push(o.status === 'EXTRACTED' ? scoreReceipt(o.receipt, gold) : zeroScore());
    if (o.status === 'EXTRACTED') {
      valid++;
      if (!o.evidence.repaired) firstTry++;
    }
  }
  const summarize = (rs: V2Record[]) => {
    const scores: ReceiptScore[] = rs.map((r) =>
      r.goldenScore ? { fields: r.goldenScore as ReceiptScore['fields'], score: Object.values(r.goldenScore).reduce((a, b) => a + b, 0) / Object.values(r.goldenScore).length } : zeroScore(),
    );
    const agg = aggregate(scores);
    return {
      n: rs.length,
      schemaValidFirstTry: round(rs.filter((r) => r.status === 'EXTRACTED' && !r.repaired).length / (rs.length || 1)),
      schemaValidAfterRepair: round(rs.filter((r) => r.status === 'EXTRACTED').length / (rs.length || 1)),
      overall: round(agg.overall),
      perField: Object.fromEntries(Object.entries(agg.perField).map(([k, v]) => [k, round(v)])),
    };
  };
  const agg = aggregate(claude);
  return {
    slice: 'the 42 hand checked golden receipts, text path',
    claudeHaikuRecorded: {
      n: manifest.length,
      schemaValidFirstTry: round(firstTry / manifest.length),
      schemaValidAfterRepair: round(valid / manifest.length),
      overall: round(agg.overall),
      perField: Object.fromEntries(Object.entries(agg.perField).map(([k, v]) => [k, round(v)])),
    },
    smallConstrained: summarize(readJsonl('golden.jsonl')),
    smallUnconstrained: summarize(readJsonl('golden-unconstrained.jsonl')),
  };
}

// ---------- perturbation and homogeneity ----------

function perturbationSection(main: V2Record[], pert: V2Record[], params: CalibrationParams['fields'], threshold: number | null) {
  const subset = JSON.parse(readFileSync(path.join(DATA, 'perturb-subset.json'), 'utf8')) as string[];
  const inSubset = new Set(subset);
  const cal = calibratedScorer(params);
  const summarize = (variant: string, rs: V2Record[]) => {
    const perField: Record<string, number | null> = {};
    for (const f of FIELDS) {
      const v = rs.filter((r) => r.correct[f] !== undefined).map((r) => r.correct[f]!);
      perField[f] = v.length ? round(v.reduce((a, b) => a + b, 0) / v.length) : null;
    }
    const all = rs.flatMap((r) => labelled(r).map((f) => r.correct[f]!));
    return {
      variant,
      n: rs.length,
      schemaFailures: rs.filter((r) => r.status === 'FAILED').length,
      fieldAccuracy: all.length ? round(all.reduce((a, b) => a + b, 0) / all.length) : null,
      perField,
      stp: threshold === null ? null : stpAt(docs(rs, cal), threshold),
    };
  };
  const clean = main.filter((r) => inSubset.has(r.id));
  const variants = [summarize('clean', clean), ...allVariants().map((v) => summarize(v, pert.filter((r) => r.variant === v)))];
  const homogeneity = JSON.parse(readFileSync(path.join(DATA, 'homogeneity.json'), 'utf8')) as {
    pairs: { idsDiffer: boolean; identicalFiles: boolean; bothRun: boolean; swaps: string[] }[];
    reencodedSameId: boolean;
  };
  return {
    subsetSize: subset.length,
    threshold,
    variants,
    homogeneity: {
      pairs: homogeneity.pairs.length,
      identicalFilePairs: homogeneity.pairs.filter((p) => p.identicalFiles).length,
      idsDistinct: homogeneity.pairs.filter((p) => p.idsDiffer).length,
      distinctFilesSharingId: homogeneity.pairs.filter((p) => !p.identicalFiles && !p.idsDiffer).length,
      pairsCheckedForSwaps: homogeneity.pairs.filter((p) => p.bothRun).length,
      pairsWithSwaps: homogeneity.pairs.filter((p) => p.swaps.length > 0).length,
      swaps: homogeneity.pairs.flatMap((p) => p.swaps),
      reencodedSamePaperGetsSameId: homogeneity.reencodedSameId,
    },
  };
}

// ---------- figures ----------

const COLORS = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2'];

function figures(cal: FieldRow[], stp: ReturnType<typeof stpSection>, pert: ReturnType<typeof perturbationSection>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of cal) {
    out[`reliability-${row.field}.svg`] = reliabilityDiagram(
      `${row.field}: calibrated confidence on the test split (ECE ${row.calibrated.ece})`,
      row.reliabilityCalibrated,
      '#2563eb',
    );
    out[`reliability-${row.field}-verbalized.svg`] = reliabilityDiagram(
      `${row.field}: what the model says, uncalibrated (ECE ${row.verbalized.ece})`,
      row.reliabilityVerbalized,
      '#dc2626',
    );
  }
  const curve = (pts: typeof stp.curveCalibrated) => pts.map((p) => [p.stpRate, p.fieldErrorRate] as [number, number]);
  out['stp-curve.svg'] = lineChart(
    'Straight-through share against field error, test split',
    'share of receipts with no human',
    'field error among them',
    [
      { name: 'calibrated', points: curve(stp.curveCalibrated), color: '#2563eb' },
      { name: 'model says', points: curve(stp.curveVerbalized), color: '#dc2626', dashed: true },
    ],
    1,
    Math.max(0.05, ...stp.curveVerbalized.map((p) => p.fieldErrorRate)),
  );
  const kinds = ['blur', 'rotate', 'crop', 'dark', 'jpeg'];
  const clean = pert.variants[0]!;
  out['perturbation.svg'] = lineChart(
    `Field accuracy as damage grows, ${pert.subsetSize} receipt subset`,
    'damage level (0 is clean)',
    'field accuracy',
    kinds.map((k, i) => ({
      name: k,
      color: COLORS[i]!,
      points: [0, 1, 2, 3].map((l) => [l, (l === 0 ? clean : pert.variants.find((v) => v.variant === `${k}-${l}`))?.fieldAccuracy ?? 0] as [number, number]),
    })),
    3,
    1,
  );
  return out;
}

// ---------- main ----------

export async function build(): Promise<Record<string, string>> {
  const main = readJsonl('main.jsonl');
  const pert = readJsonl('perturb.jsonl');
  const uncon = readJsonl('unconstrained.jsonl');
  const { params: fields, rows } = fitCalibrators(main);
  const stp = stpSection(main, fields);
  // The pipeline pools every calibrated field, so its threshold comes from the
  // pooled rule. With none meeting 1 percent on val, nothing may pass unreviewed,
  // and the threshold is 1, above any calibrated score.
  const pipelineOp = stp.operating.find((o) => o.alpha === stp.alphaForPipeline)!;
  const threshold = stp.pooled.find((o) => o.alpha === stp.alphaForPipeline)!.threshold ?? 1;
  const router = fitRouter(main);
  const calibration = {
    model: SMALL_MODEL,
    fitOn: 'fit split for the logistic fusion, val split for isotonic, test split for every number below',
    receipts: { total: main.length, sroie: main.filter((r) => r.source === 'sroie').length, cord: main.filter((r) => r.source === 'cord').length },
    schemaFailures: main.filter((r) => r.status === 'FAILED').length,
    fields: rows,
  };
  const pertSection = perturbationSection(main, pert, fields, pipelineOp.threshold);
  const out: Record<string, string> = {
    [path.join(RESULTS, 'calibration.json')]: calibration as unknown as string,
    [path.join(RESULTS, 'stp.json')]: stp as unknown as string,
    [path.join(RESULTS, 'routing.json')]: routingSection(main, router, await goldenPaths(), uncon) as unknown as string,
    [path.join(RESULTS, 'perturbation.json')]: pertSection as unknown as string,
    [path.join(PARAMS, 'calibration.json')]: { model: SMALL_MODEL, threshold, fields } as unknown as string,
    [path.join(PARAMS, 'router.json')]: router as unknown as string,
  };
  for (const [k, v] of Object.entries(out)) out[k] = JSON.stringify(v, null, 1) + '\n';
  for (const [name, svg] of Object.entries(figures(rows, stp, pertSection))) out[path.join(RESULTS, name)] = svg + '\n';
  return out;
}

async function main(): Promise<void> {
  const files = await build();
  if (process.argv.includes('--check')) {
    const drift = Object.entries(files).filter(([f, text]) => !existsSync(f) || readFileSync(f, 'utf8').replace(/\r\n/g, '\n') !== text);
    for (const [f] of drift) console.error(`drift: ${path.relative(ROOT, f)} does not match what the records produce`);
    if (drift.length) process.exit(1);
    console.log(`v2 results match the records (${Object.keys(files).length} files)`);
    return;
  }
  for (const [f, text] of Object.entries(files)) writeFileSync(f, text);
  console.log(`wrote ${Object.keys(files).length} files`);
}

if (require.main === module) void main();
