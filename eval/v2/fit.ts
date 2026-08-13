/**
 * Fit the per field calibrators: L2 regularised logistic regression, then isotonic regression on a separate split.
 */
import type { IsotonicTable } from '../../src/lib/calibrate';

// Newton steps with a fixed count and a small ridge, so the fit is identical on
// every machine and never blows up on a feature that separates perfectly.
export function fitLogistic(X: number[][], y: number[], l2 = 1, steps = 25): number[] {
  const d = X[0]?.length ?? 0;
  const w = new Array<number>(d).fill(0);
  for (let s = 0; s < steps; s++) {
    const g = new Array<number>(d).fill(0);
    const H = Array.from({ length: d }, () => new Array<number>(d).fill(0));
    for (let i = 0; i < X.length; i++) {
      const x = X[i]!;
      const p = 1 / (1 + Math.exp(-x.reduce((a, v, j) => a + v * w[j]!, 0)));
      const r = p - y[i]!;
      const q = p * (1 - p);
      for (let j = 0; j < d; j++) {
        g[j]! += r * x[j]!;
        for (let k = 0; k < d; k++) H[j]![k]! += q * x[j]! * x[k]!;
      }
    }
    // The bias stays out of the ridge so the base rate is not pulled to one half.
    for (let j = 1; j < d; j++) {
      g[j]! += l2 * w[j]!;
      H[j]![j]! += l2;
    }
    H[0]![0]! += 1e-6;
    const step = solve(H, g);
    for (let j = 0; j < d; j++) w[j]! -= step[j]!;
  }
  return w.map((v) => Math.round(v * 1e6) / 1e6);
}

function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    [M[c], M[p]] = [M[p]!, M[c]!];
    const piv = M[c]![c]! || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]! / piv;
      for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  return M.map((row, i) => row[n]! / (M[i]![i]! || 1e-12));
}

// Pool adjacent violators. Knots sit at block means so prediction can interpolate
// between them instead of jumping in steps.
export function fitIsotonic(score: number[], y: number[]): IsotonicTable {
  const order = score.map((s, i) => [s, y[i]!] as const).sort((a, b) => a[0] - b[0]);
  const blocks: { sx: number; sy: number; n: number }[] = [];
  const mean = (b: { sy: number; n: number }) => b.sy / b.n;
  for (const [s, v] of order) {
    blocks.push({ sx: s, sy: v, n: 1 });
    while (blocks.length > 1 && mean(blocks[blocks.length - 2]!) > mean(blocks[blocks.length - 1]!)) {
      const b = blocks.pop()!;
      const a = blocks[blocks.length - 1]!;
      a.sx += b.sx;
      a.sy += b.sy;
      a.n += b.n;
    }
  }
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return { x: blocks.map((b) => r(b.sx / b.n)), y: blocks.map((b) => r(b.sy / b.n)) };
}
