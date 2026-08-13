import { describe, it, expect } from 'vitest';
import { ece, reliability, auroc, brier, clopperPearsonUpper } from '../eval/v2/metrics';
import { fitLogistic, fitIsotonic } from '../eval/v2/fit';
import { fieldCorrectness } from '../eval/v2/score-fields';
import { stpCurve, operatingPoint, type ScoredDoc } from '../eval/v2/stp';
import { validityLadder } from '../eval/v2/ladder';

describe('ece and reliability', () => {
  it('is zero when confidence equals accuracy in every bin', () => {
    const conf = [0.25, 0.25, 0.25, 0.25, 0.75, 0.75, 0.75, 0.75];
    const ok = [1, 0, 0, 0, 1, 1, 1, 0];
    expect(ece(conf, ok, 10)).toBeCloseTo(0);
  });

  it('is large for a model that is always sure and half wrong', () => {
    expect(ece([1, 1, 1, 1], [1, 0, 1, 0], 10)).toBeCloseTo(0.5);
  });

  it('reports count, mean confidence and accuracy per bin', () => {
    const bins = reliability([0.05, 0.95, 0.96], [0, 1, 0], 10);
    expect(bins.find((b) => b.n === 2)).toMatchObject({ meanConfidence: 0.955, accuracy: 0.5 });
  });
});

describe('auroc', () => {
  it('is 1 for perfect separation and 0.5 for none', () => {
    expect(auroc([0.9, 0.8, 0.2, 0.1], [1, 1, 0, 0])).toBe(1);
    expect(auroc([0.5, 0.5, 0.5, 0.5], [1, 0, 1, 0])).toBe(0.5);
  });

  it('is undefined when every example has the same label', () => {
    expect(auroc([0.1, 0.2], [1, 1])).toBeUndefined();
  });
});

describe('brier', () => {
  it('is the mean squared error of the confidence', () => {
    expect(brier([1, 0], [1, 1])).toBeCloseTo(0.5);
  });
});

describe('clopperPearsonUpper', () => {
  it('matches the rule of three for zero errors', () => {
    // With no errors the exact bound is 1 - delta^(1/n).
    expect(clopperPearsonUpper(0, 300, 0.05)).toBeCloseTo(1 - 0.05 ** (1 / 300), 6);
  });

  it('grows with the error count and shrinks with n', () => {
    expect(clopperPearsonUpper(5, 100, 0.05)).toBeGreaterThan(clopperPearsonUpper(1, 100, 0.05));
    expect(clopperPearsonUpper(5, 1000, 0.05)).toBeLessThan(clopperPearsonUpper(5, 100, 0.05));
    expect(clopperPearsonUpper(5, 100, 0.05)).toBeCloseTo(0.1023, 3);
  });

  it('is 1 when there is nothing to bound', () => {
    expect(clopperPearsonUpper(0, 0, 0.05)).toBe(1);
  });
});

describe('fitLogistic', () => {
  it('learns the sign of a feature that predicts the label', () => {
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 200; i++) {
      const x = (i % 20) / 20;
      X.push([1, x]);
      y.push(x > 0.5 ? 1 : i % 7 === 0 ? 1 : 0);
    }
    const w = fitLogistic(X, y);
    expect(w[1]!).toBeGreaterThan(2);
  });

  it('is deterministic', () => {
    const X = [[1, 0], [1, 1], [1, 0.5], [1, 0.2]];
    const y = [0, 1, 1, 0];
    expect(fitLogistic(X, y)).toEqual(fitLogistic(X, y));
  });
});

describe('fitIsotonic', () => {
  it('returns a non decreasing table', () => {
    const t = fitIsotonic([0.1, 0.2, 0.3, 0.4, 0.5, 0.6], [0, 1, 0, 1, 1, 1]);
    for (let i = 1; i < t.y.length; i++) expect(t.y[i]!).toBeGreaterThanOrEqual(t.y[i - 1]!);
    expect(t.y[t.y.length - 1]).toBe(1);
  });
});

describe('fieldCorrectness', () => {
  it('scores only labelled fields and treats a failed extraction as all wrong', () => {
    const label = { merchant: 'OJC MARKETING SDN BHD', date: '2019-01-15', total: 193 };
    const pred = { merchant: 'Ojc Marketing Sdn. Bhd.', date: '2019-01-15', currency: 'MYR', lineItems: [], total: 170 };
    expect(fieldCorrectness(pred, label, ['merchant', 'date', 'total'])).toEqual({ merchant: 1, date: 1, total: 0 });
    expect(fieldCorrectness(undefined, label, ['merchant', 'total'])).toEqual({ merchant: 0, total: 0 });
  });

  it('counts an absent subtotal right when the label is absent too', () => {
    const pred = { merchant: 'x', date: '2019-01-01', currency: 'IDR', lineItems: [{ description: 'A', quantity: 1, amount: 5 }], total: 5 };
    const label = { lineItems: [{ description: 'A', quantity: 1, amount: 5 }], total: 5 };
    expect(fieldCorrectness(pred, label, ['subtotal', 'lineItems'])).toEqual({ subtotal: 1, lineItems: 1 });
  });
});

function doc(id: string, conf: number, correct: number[]): ScoredDoc {
  return { id, extracted: true, fields: correct.map((c) => ({ confidence: conf, correct: c })) };
}

describe('stpCurve and operatingPoint', () => {
  const docs = [doc('a', 0.99, [1, 1]), doc('b', 0.9, [1, 1]), doc('c', 0.6, [1, 0]), doc('d', 0.3, [0, 0]), { id: 'e', extracted: false, fields: [] }];

  it('passes more receipts and makes more errors as the threshold drops', () => {
    const curve = stpCurve(docs, [0.95, 0.5, 0]);
    expect(curve.map((p) => p.stpRate)).toEqual([0.2, 0.6, 0.8]);
    expect(curve[0]!.fieldErrorRate).toBe(0);
    expect(curve[1]!.fieldErrorRate).toBeCloseTo(1 / 6);
  });

  it('never passes a receipt that failed the schema gate, whatever the threshold', () => {
    expect(stpCurve(docs, [0])[0]!.passed).toBe(4);
  });

  it('picks the lowest threshold whose error stays within budget', () => {
    const op = operatingPoint(docs, 0.01, [0.95, 0.85, 0.5, 0]);
    expect(op).toMatchObject({ threshold: 0.85 });
  });
});

describe('validityLadder', () => {
  it('reports each rung and the highest one that certifies coverage', () => {
    const val: ScoredDoc[] = [];
    const test: ScoredDoc[] = [];
    for (let i = 0; i < 400; i++) {
      const conf = (i % 100) / 100;
      const wrong = conf < 0.5 && i % 3 === 0 ? 0 : 1;
      val.push(doc(`v${i}`, conf, [wrong, 1, 1]));
      test.push(doc(`t${i}`, conf, [wrong, 1, 1]));
    }
    const ladder = validityLadder(val, test, 0.05, 0.1);
    expect(ladder.rungs.map((r) => r.name)).toEqual(['in-sample', 'fit-val split', 'LTT field-iid', 'LTT cluster-corrected', 'LTT doc-iid']);
    expect(ladder.reached).toBeDefined();
    for (const r of ladder.rungs) if (r.certified) expect(r.testRisk!).toBeLessThanOrEqual(0.05 + 0.02);
  });
});
