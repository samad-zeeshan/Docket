import { describe, it, expect } from 'vitest';
import { deriveDocId } from '../src/lib/docid';

describe('deriveDocId', () => {
  it('is stable for the same bucket, key, and etag', () => {
    expect(deriveDocId('b', 'receipts/x.pdf', 'abc')).toBe(deriveDocId('b', 'receipts/x.pdf', 'abc'));
  });

  it('ignores the quotes S3 wraps around etags', () => {
    expect(deriveDocId('b', 'k', '"abc"')).toBe(deriveDocId('b', 'k', 'abc'));
  });

  it('changes when the content changes', () => {
    expect(deriveDocId('b', 'k', 'abc')).not.toBe(deriveDocId('b', 'k', 'def'));
  });

  it('changes when the key changes', () => {
    expect(deriveDocId('b', 'a.pdf', 'e')).not.toBe(deriveDocId('b', 'z.pdf', 'e'));
  });
});
