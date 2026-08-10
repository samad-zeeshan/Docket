/**
 * Turn raw confidence signals into a calibrated probability per field, and decide whether a receipt needs a person.
 *
 * The weights and tables come from eval/v2, fitted on held out receipts. This file only applies them.
 */
import type { Receipt } from './schema';
import type { Evidence } from './extract';
import {
  CONFIDENCE_FIELDS,
  fieldLogprobs,
  validatorSignals,
  verbalizedConfidence,
  type ConfidenceField,
  type ValidatorSignals,
} from './confidence';

export interface Signals {
  verbalized: Partial<Record<ConfidenceField, number>>;
  logprob: Partial<Record<ConfidenceField, number>>;
  present: Partial<Record<ConfidenceField, boolean>>;
  validators: ValidatorSignals;
  repaired: boolean;
}

export interface IsotonicTable {
  x: number[];
  y: number[];
}

export interface FieldCalibrator {
  weights: number[];
  isotonic: IsotonicTable;
}

export interface CalibrationParams {
  model: string;
  threshold: number;
  fields: Partial<Record<ConfidenceField, FieldCalibrator>>;
}

export const FEATURE_NAMES = [
  'bias', 'verbalized', 'verbalizedMissing', 'logprob', 'logprobMissing', 'present',
  'totalsReconcile', 'linesReconcile', 'datePlausible', 'currencyKnown', 'repaired',
] as const;

export function signalsFromEvidence(receipt: Receipt, evidence: Pick<Evidence, 'text' | 'tokenLogprobs' | 'repaired'>): Signals {
  const present: Partial<Record<ConfidenceField, boolean>> = {};
  for (const f of CONFIDENCE_FIELDS) present[f] = receipt[f] !== undefined;
  return {
    verbalized: verbalizedConfidence(evidence.text),
    logprob: evidence.tokenLogprobs ? fieldLogprobs(evidence.text, evidence.tokenLogprobs) : {},
    present,
    validators: validatorSignals(receipt),
    repaired: evidence.repaired,
  };
}

// A missing signal gets a neutral value plus a flag, so the fit can learn what
// absence means instead of reading it as a confident zero.
export function fieldFeatures(field: ConfidenceField, s: Signals): number[] {
  const v = s.verbalized[field];
  const lp = s.logprob[field];
  return [
    1,
    v ?? 0.5,
    v === undefined ? 1 : 0,
    lp === undefined ? 0 : Math.log(Math.max(lp, 1e-6)),
    lp === undefined ? 1 : 0,
    s.present[field] ? 1 : 0,
    s.validators.totalsReconcile,
    s.validators.linesReconcile,
    s.validators.datePlausible,
    s.validators.currencyKnown,
    s.repaired ? 1 : 0,
  ];
}

export function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

export function isotonicPredict(t: IsotonicTable, x: number): number {
  const n = t.x.length;
  if (n === 0) return x;
  if (x <= t.x[0]!) return t.y[0]!;
  if (x >= t.x[n - 1]!) return t.y[n - 1]!;
  let i = 1;
  while (t.x[i]! < x) i++;
  const x0 = t.x[i - 1]!;
  const x1 = t.x[i]!;
  const w = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
  return t.y[i - 1]! + w * (t.y[i]! - t.y[i - 1]!);
}

export function fusedScore(cal: FieldCalibrator, features: number[]): number {
  return sigmoid(features.reduce((acc, x, i) => acc + x * (cal.weights[i] ?? 0), 0));
}

export function calibratedConfidence(params: CalibrationParams | undefined, s: Signals): Partial<Record<ConfidenceField, number>> {
  const out: Partial<Record<ConfidenceField, number>> = {};
  if (!params) return out;
  for (const field of CONFIDENCE_FIELDS) {
    const cal = params.fields[field];
    if (cal) out[field] = isotonicPredict(cal.isotonic, fusedScore(cal, fieldFeatures(field, s)));
  }
  return out;
}

export interface ReviewDecision {
  needsReview: boolean;
  reason: string;
}

// Confidence decides review, never correctness. Everything reaching here has
// already passed the schema gate, and nothing in this function can reject it.
export function reviewDecision(
  params: CalibrationParams | undefined,
  confidence: Partial<Record<ConfidenceField, number>>,
  s: Signals,
): ReviewDecision {
  const scored = Object.entries(confidence) as [ConfidenceField, number][];
  if (params && scored.length > 0) {
    const [field, lowest] = scored.reduce((a, b) => (b[1] < a[1] ? b : a));
    return lowest < params.threshold
      ? { needsReview: true, reason: `${field} confidence ${lowest.toFixed(3)} under ${params.threshold}` }
      : { needsReview: false, reason: `lowest field ${field} at ${lowest.toFixed(3)}` };
  }
  // No calibrator for this route, which is the Claude path today: Bedrock gives
  // no token probabilities and v1 asks for no confidence. Only arithmetic is left.
  if (s.validators.totalsReconcile === 0) return { needsReview: true, reason: 'totals do not reconcile' };
  if (s.validators.linesReconcile === 0) return { needsReview: true, reason: 'line items do not sum to the subtotal' };
  if (s.validators.datePlausible === 0) return { needsReview: true, reason: 'implausible date' };
  return { needsReview: false, reason: 'no calibrator, arithmetic checks pass' };
}
