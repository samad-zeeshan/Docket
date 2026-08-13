/**
 * The validity ladder from arXiv 2608.14639: the same accept rule under five guarantees, from none to one per document.
 *
 * Each rung picks a threshold on the validation split and is judged on the test split.
 */
import { clopperPearsonUpper, round } from './metrics';
import { operatingPoint, passes, stpAt, thresholdGrid, type ScoredDoc } from './stp';

export interface Rung {
  name: string;
  guarantee: string;
  threshold?: number;
  testCoverage: number;
  testRisk?: number;
  holdsOnTest?: boolean;
  certified: boolean;
  note?: string;
}

export interface Ladder {
  alpha: number;
  delta: number;
  rungs: Rung[];
  reached?: string;
}

function accepted(docs: ScoredDoc[], t: number): { k: number; n: number; docErr: number; docN: number; perDoc: [number, number][] } {
  let k = 0;
  let n = 0;
  let docErr = 0;
  let docN = 0;
  const perDoc: [number, number][] = [];
  for (const d of docs) {
    if (!passes(d, t) || d.fields.length === 0) continue;
    const e = d.fields.filter((f) => f.correct === 0).length;
    k += e;
    n += d.fields.length;
    docN++;
    if (e > 0) docErr++;
    perDoc.push([e, d.fields.length]);
  }
  return { k, n, docErr, docN, perDoc };
}

// Fields on one receipt fail together: a blurred photo gets several wrong at
// once. The design effect measures how much that shrinks the real sample size.
export function designEffect(perDoc: [number, number][]): number {
  const J = perDoc.length;
  const m = perDoc.reduce((a, [, n]) => a + n, 0);
  if (J < 2 || m === 0) return 1;
  const p = perDoc.reduce((a, [e]) => a + e, 0) / m;
  if (p === 0 || p === 1) return 1;
  const varCluster = (J / (J - 1)) * perDoc.reduce((a, [e, n]) => a + (e - p * n) ** 2, 0) / m ** 2;
  const varSrs = (p * (1 - p)) / m;
  return Math.max(1, varCluster / varSrs);
}

// Learn then Test with fixed sequence testing: walk down from the strictest
// threshold and keep going only while the upper bound stays under alpha.
function ltt(val: ScoredDoc[], alpha: number, bound: (t: number) => number): number | undefined {
  let best: number | undefined;
  for (const t of thresholdGrid()) {
    const a = accepted(val, t);
    if (a.n === 0) continue;
    if (bound(t) > alpha) break;
    best = t;
  }
  return best;
}

function judge(name: string, guarantee: string, test: ScoredDoc[], alpha: number, t: number | undefined, note?: string): Rung {
  if (t === undefined) return { name, guarantee, testCoverage: 0, certified: false, note: note ?? 'no threshold meets the bound, coverage is zero' };
  const p = stpAt(test, t);
  return {
    name,
    guarantee,
    threshold: t,
    testCoverage: p.stpRate,
    testRisk: p.fieldErrorRate,
    holdsOnTest: p.fieldErrorRate <= alpha,
    certified: p.passed > 0,
    note,
  };
}

export function validityLadder(val: ScoredDoc[], test: ScoredDoc[], alpha: number, delta: number): Ladder {
  const inSample = operatingPoint(test, alpha);
  const split = operatingPoint(val, alpha);
  const fieldIid = ltt(val, alpha, (t) => {
    const a = accepted(val, t);
    return clopperPearsonUpper(a.k, a.n, delta);
  });
  const cluster = ltt(val, alpha, (t) => {
    const a = accepted(val, t);
    const deff = designEffect(a.perDoc);
    return clopperPearsonUpper(Math.ceil(a.k / deff), Math.floor(a.n / deff), delta);
  });
  const docIid = ltt(val, alpha, (t) => {
    const a = accepted(val, t);
    return clopperPearsonUpper(a.docErr, a.docN, delta);
  });

  const rungs: Rung[] = [
    judge('in-sample', 'none: threshold chosen on the same receipts it is scored on', test, alpha, inSample?.threshold, 'optimistic by construction, shown for contrast'),
    judge('fit-val split', 'expected selective risk at most alpha, on average over splits, not a certificate', test, alpha, split?.threshold),
    judge('LTT field-iid', `field error at most alpha with probability ${1 - delta}, if fields were independent`, test, alpha, fieldIid),
    judge('LTT cluster-corrected', `as above, sample size shrunk by the measured design effect`, test, alpha, cluster),
    judge('LTT doc-iid', `share of passed receipts with any wrong field at most alpha, with probability ${1 - delta}`, test, alpha, docIid),
  ];
  // Rung 0 cannot be reached: it is there to show what the others cost.
  const reached = [...rungs.slice(1)].reverse().find((r) => r.certified && r.holdsOnTest);
  return { alpha, delta, rungs: rungs.map((r) => ({ ...r, testCoverage: round(r.testCoverage) })), reached: reached?.name };
}
