import { describe, it, expect } from 'vitest';
import { topLevelSpans, fieldLogprobs, verbalizedConfidence, validatorSignals, CONFIDENCE_FIELDS } from '../src/lib/confidence';
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

describe('topLevelSpans', () => {
  it('finds where each top level value starts and ends, ignoring nested keys', () => {
    const text = '{"merchant": "Sh\\"op", "lineItems": [{"total": 1}], "total": 3.3}';
    const spans = topLevelSpans(text);
    expect(text.slice(spans.merchant![0], spans.merchant![1])).toBe('"Sh\\"op"');
    expect(text.slice(spans.lineItems![0], spans.lineItems![1])).toBe('[{"total": 1}]');
    expect(text.slice(spans.total![0], spans.total![1])).toBe('3.3');
  });

  it('returns nothing for text that is not a JSON object', () => {
    expect(topLevelSpans('nope')).toEqual({});
  });
});

describe('fieldLogprobs', () => {
  it('takes the least likely token inside each value', () => {
    const tokens = [
      { token: '{"total": ', logprob: -0.01 },
      { token: '12', logprob: -0.5 },
      { token: '.5', logprob: -2 },
      { token: ', "date": "', logprob: -0.01 },
      { token: '2025', logprob: -0.1 },
      { token: '"}', logprob: -0.01 },
    ];
    const text = tokens.map((t) => t.token).join('');
    const out = fieldLogprobs(text, tokens);
    expect(out.total).toBeCloseTo(Math.exp(-2));
    expect(out.date).toBeCloseTo(Math.exp(-0.1));
    expect(out.merchant).toBeUndefined();
  });
});

describe('verbalizedConfidence', () => {
  it('reads the confidence object and clamps it to 0..1', () => {
    expect(verbalizedConfidence('{"total": 1, "confidence": {"total": 1.4, "date": -1, "merchant": 0.7}}')).toEqual({
      total: 1,
      date: 0,
      merchant: 0.7,
    });
  });

  it('returns an empty map when the model gave none', () => {
    expect(verbalizedConfidence('{"total": 1}')).toEqual({});
    expect(verbalizedConfidence('garbage')).toEqual({});
  });
});

describe('validatorSignals', () => {
  it('passes a receipt whose numbers agree', () => {
    const v = validatorSignals(receipt);
    expect(v).toMatchObject({ totalsReconcile: 1, linesReconcile: 1, datePlausible: 1, currencyKnown: 1 });
  });

  it('flags totals and lines that disagree', () => {
    const v = validatorSignals({ ...receipt, total: 9, lineItems: [{ description: 'A', quantity: 1, amount: 5 }] });
    expect(v.totalsReconcile).toBe(0);
    expect(v.linesReconcile).toBe(0);
  });

  it('marks a check it cannot run as unknown, not as a pass', () => {
    const { subtotal: _s, ...noSub } = receipt;
    const v = validatorSignals(noSub as Receipt);
    expect(v.totalsReconcile).toBe(0.5);
    expect(v.linesReconcile).toBe(0.5);
  });

  it('flags a date far from the present and an unknown currency', () => {
    const v = validatorSignals({ ...receipt, date: '1999-01-01', currency: 'XYZ' });
    expect(v.datePlausible).toBe(0);
    expect(v.currencyKnown).toBe(0);
  });
});

describe('CONFIDENCE_FIELDS', () => {
  it('covers every field the public sets can score', () => {
    expect(CONFIDENCE_FIELDS).toEqual(['merchant', 'date', 'currency', 'total', 'subtotal', 'tax', 'lineItems']);
  });
});
