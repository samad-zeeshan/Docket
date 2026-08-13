/**
 * Straight-through processing: at a confidence threshold, how many receipts pass with no person and how many of their fields are wrong.
 */
import { round } from './metrics';

export interface ScoredField {
  confidence: number;
  correct: number;
}

export interface ScoredDoc {
  id: string;
  // False when the schema gate refused the receipt. Such a receipt never passes
  // straight through, however the threshold is set.
  extracted: boolean;
  fields: ScoredField[];
}

export interface StpPoint {
  threshold: number;
  passed: number;
  stpRate: number;
  fields: number;
  fieldErrors: number;
  fieldErrorRate: number;
}

export function passes(doc: ScoredDoc, threshold: number): boolean {
  return doc.extracted && doc.fields.every((f) => f.confidence >= threshold);
}

export function stpAt(docs: ScoredDoc[], threshold: number): StpPoint {
  let passed = 0;
  let fields = 0;
  let errors = 0;
  for (const d of docs) {
    if (!passes(d, threshold)) continue;
    passed++;
    fields += d.fields.length;
    errors += d.fields.filter((f) => f.correct === 0).length;
  }
  return {
    threshold: round(threshold),
    passed,
    stpRate: docs.length ? round(passed / docs.length) : 0,
    fields,
    fieldErrors: errors,
    fieldErrorRate: fields ? round(errors / fields) : 0,
  };
}

export function stpCurve(docs: ScoredDoc[], thresholds: number[]): StpPoint[] {
  return thresholds.map((t) => stpAt(docs, t));
}

export function thresholdGrid(step = 0.005): number[] {
  const out: number[] = [];
  for (let t = 1; t >= -1e-9; t -= step) out.push(round(Math.max(0, t)));
  return out;
}

// Walk down from the strictest threshold and stop at the first one over budget.
// Taking the lowest threshold anywhere under budget would let a lucky dip deep in
// the grid set the operating point.
export function operatingPoint(docs: ScoredDoc[], alpha: number, thresholds = thresholdGrid()): StpPoint | undefined {
  let best: StpPoint | undefined;
  for (const t of [...thresholds].sort((a, b) => b - a)) {
    const p = stpAt(docs, t);
    if (p.fields === 0) continue;
    if (p.fieldErrorRate > alpha) break;
    best = p;
  }
  return best;
}
