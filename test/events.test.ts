import { describe, it, expect } from 'vitest';
import { parseS3Event } from '../src/lib/events';

function envelope(key: string, etag: string): string {
  return JSON.stringify({
    'detail-type': 'Object Created',
    source: 'aws.s3',
    detail: { bucket: { name: 'ingest' }, object: { key, etag, size: 100 } },
  });
}

describe('parseS3Event', () => {
  it('pulls bucket, key, and etag out of the envelope', () => {
    expect(parseS3Event(envelope('receipts/a.pdf', '"e1"'))).toEqual({
      bucket: 'ingest',
      key: 'receipts/a.pdf',
      etag: '"e1"',
      size: 100,
    });
  });

  it('throws on a malformed event so it can go to the DLQ', () => {
    expect(() => parseS3Event('{}')).toThrow();
  });
});
