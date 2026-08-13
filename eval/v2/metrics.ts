/**
 * Calibration and ranking metrics: ECE, reliability bins, Brier, AUROC, and an exact binomial upper bound.
 */

export interface ReliabilityBin {
  lo: number;
  hi: number;
  n: number;
  meanConfidence: number;
  accuracy: number;
}

export function reliability(conf: number[], correct: number[], bins = 10): ReliabilityBin[] {
  const out: ReliabilityBin[] = [];
  for (let b = 0; b < bins; b++) {
    const lo = b / bins;
    const hi = (b + 1) / bins;
    let n = 0;
    let c = 0;
    let a = 0;
    conf.forEach((p, i) => {
      // The last bin is closed so a confidence of exactly 1 is counted.
      if (p >= lo && (p < hi || (b === bins - 1 && p <= hi))) {
        n++;
        c += p;
        a += correct[i]!;
      }
    });
    out.push({ lo, hi, n, meanConfidence: n ? round(c / n) : 0, accuracy: n ? round(a / n) : 0 });
  }
  return out;
}

export function ece(conf: number[], correct: number[], bins = 10): number {
  if (conf.length === 0) return 0;
  return reliability(conf, correct, bins).reduce((acc, b) => acc + (b.n / conf.length) * Math.abs(b.meanConfidence - b.accuracy), 0);
}

export function brier(conf: number[], correct: number[]): number {
  if (conf.length === 0) return 0;
  return conf.reduce((acc, p, i) => acc + (p - correct[i]!) ** 2, 0) / conf.length;
}

// Rank based, with ties counted as half, so a score that says 0.9 for everything
// gets 0.5 and not whatever the sort order happens to give it.
export function auroc(score: number[], label: number[]): number | undefined {
  const nPos = label.filter((y) => y === 1).length;
  const nNeg = label.length - nPos;
  if (nPos === 0 || nNeg === 0) return undefined;
  const all = score.map((s, i) => ({ s, y: label[i] === 1 })).sort((a, b) => a.s - b.s);
  let rankSum = 0;
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j < all.length && all[j]!.s === all[i]!.s) j++;
    const avgRank = (i + j + 1) / 2;
    for (let k = i; k < j; k++) if (all[k]!.y) rankSum += avgRank;
    i = j;
  }
  return (rankSum - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

function lgamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  x -= 1;
  let a = c[0]!;
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i]! / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function binomCdf(k: number, n: number, p: number): number {
  if (p <= 0) return 1;
  if (p >= 1) return k >= n ? 1 : 0;
  let s = 0;
  for (let i = 0; i <= k; i++) {
    s += Math.exp(lgamma(n + 1) - lgamma(i + 1) - lgamma(n - i + 1) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  }
  return Math.min(1, s);
}

// One sided exact upper bound on an error rate after k errors in n trials: the p
// at which seeing k or fewer has probability delta. Found by bisection.
export function clopperPearsonUpper(k: number, n: number, delta: number): number {
  if (n <= 0 || k >= n) return 1;
  let lo = k / n;
  let hi = 1;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (binomCdf(k, n, mid) > delta) lo = mid;
    else hi = mid;
  }
  return hi;
}

export function round(x: number, places = 4): number {
  const f = 10 ** places;
  return Math.round(x * f) / f;
}
