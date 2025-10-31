import { describe, it, expect, beforeEach } from 'vitest';
import type { SQSRecord } from 'aws-lambda';
import { processRecord } from '../src/handlers/ingest';
import type { DocumentStore } from '../src/lib/store';
import type { DocumentRecord } from '../src/lib/model';

class FakeStore implements DocumentStore {
  readonly items = new Map<string, DocumentRecord>();

  async putReceived(record: DocumentRecord): Promise<'created' | 'duplicate'> {
    if (this.items.has(record.docId)) return 'duplicate';
    this.items.set(record.docId, record);
    return 'created';
  }

  async get(docId: string): Promise<DocumentRecord | undefined> {
    return this.items.get(docId);
  }
}

function sqsRecord(key: string, etag: string): SQSRecord {
  const body = JSON.stringify({
    'detail-type': 'Object Created',
    source: 'aws.s3',
    detail: { bucket: { name: 'ingest' }, object: { key, etag } },
  });
  return { messageId: `${key}:${etag}`, body } as SQSRecord;
}

describe('ingest processRecord', () => {
  let store: FakeStore;
  beforeEach(() => {
    store = new FakeStore();
  });

  it('writes one RECEIVED record for a new upload', async () => {
    await processRecord(store, sqsRecord('a.pdf', 'e1'));
    expect(store.items.size).toBe(1);
    const rec = [...store.items.values()][0]!;
    expect(rec.status).toBe('RECEIVED');
    expect(rec.s3Key).toBe('a.pdf');
  });

  it('does not duplicate on redelivery of the same event', async () => {
    await processRecord(store, sqsRecord('a.pdf', 'e1'));
    await processRecord(store, sqsRecord('a.pdf', 'e1'));
    expect(store.items.size).toBe(1);
  });

  it('treats new content under the same key as a new document', async () => {
    await processRecord(store, sqsRecord('a.pdf', 'e1'));
    await processRecord(store, sqsRecord('a.pdf', 'e2'));
    expect(store.items.size).toBe(2);
  });
});
