import { describe, it, expect } from 'vitest';
import { fieldFeatures, calibratedConfidence, reviewDecision, signalsFromEvidence, isotonicPredict, type CalibrationParams } from '../src/lib/calibrate';
import type { Receipt } from '../src/lib/schema';

const receipt: Receipt = {
  merchant: 'Shop',
  date: '2025-01-02',
  currency: 'USD',
  lineItems: [{ description: 'A', quantity: 1, amount: 3 }],
  subtotal: 3,
  tax: 0.3,
  total: 3.3,
};

const text = JSON.stringify({ ...receipt, confidence: { total: 0.9, merchant: 0.2 } });

// One weight on verbalized confidence and nothing else, with an identity table.
function params(threshold: number): CalibrationParams {
  const w = new Array(11).fill(0);
  w[1] = 8;
  w[0] = -4;
  return {
    model: 'test',
    threshold,
    fields: {
      total: { weights: w, isotonic: { x: [0, 1], y: [0, 1] } },
      merchant: { weights: w, isotonic: { x: [0, 1], y: [0, 1] } },
    },
  };
}

describe('isotonicPredict', () => {
  it('interpolates between knots and clamps outside them', () => {
    const t = { x: [0.2, 0.6], y: [0.1, 0.9] };
    expect(isotonicPredict(t, 0.4)).toBeCloseTo(0.5);
    expect(isotonicPredict(t, 0)).toBe(0.1);
    expect(isotonicPredict(t, 1)).toBe(0.9);
  });
});

describe('signalsFromEvidence', () => {
  it('collects verbalized scores, presence and validators', () => {
    const s = signalsFromEvidence(receipt, { text, repaired: false });
    expect(s.verbalized.total).toBe(0.9);
    expect(s.present.total).toBe(true);
    expect(s.validators.totalsReconcile).toBe(1);
    expect(s.logprob).toEqual({});
  });
});

describe('fieldFeatures', () => {
  it('marks a missing signal instead of pretending it was confident', () => {
    const s = signalsFromEvidence(receipt, { text, repaired: true });
    const f = fieldFeatures('date', s);
    expect(f[0]).toBe(1);
    expect(f[2]).toBe(1);
    expect(f[4]).toBe(1);
    expect(f[10]).toBe(1);
  });
});

describe('calibratedConfidence', () => {
  it('scores only the fields it has a calibrator for', () => {
    const c = calibratedConfidence(params(0.5), signalsFromEvidence(receipt, { text, repaired: false }));
    expect(Object.keys(c).sort()).toEqual(['merchant', 'total']);
    expect(c.total!).toBeGreaterThan(c.merchant!);
  });
});

describe('reviewDecision', () => {
  it('sends a receipt to review when its least confident field is under the threshold', () => {
    const s = signalsFromEvidence(receipt, { text, repaired: false });
    const d = reviewDecision(params(0.5), calibratedConfidence(params(0.5), s), s);
    expect(d.needsReview).toBe(true);
    expect(d.reason).toContain('merchant');
  });

  it('lets a receipt through when every calibrated field clears the threshold', () => {
    const s = signalsFromEvidence(receipt, { text: JSON.stringify({ ...receipt, confidence: { total: 0.95, merchant: 0.95 } }), repaired: false });
    const d = reviewDecision(params(0.5), calibratedConfidence(params(0.5), s), s);
    expect(d.needsReview).toBe(false);
  });

  it('falls back to the arithmetic checks when there is no calibrator, as on the Claude path', () => {
    const bad = { ...receipt, total: 99 };
    const s = signalsFromEvidence(bad, { text: JSON.stringify(bad), repaired: false });
    const d = reviewDecision(undefined, {}, s);
    expect(d.needsReview).toBe(true);
    expect(d.reason).toContain('totals');
    const good = signalsFromEvidence(receipt, { text: JSON.stringify(receipt), repaired: false });
    expect(reviewDecision(undefined, {}, good).needsReview).toBe(false);
  });
});
