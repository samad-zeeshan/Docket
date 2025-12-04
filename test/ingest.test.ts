import { describe, it, expect, beforeEach } from 'vitest';
import { processRecord, type IngestDeps } from '../src/handlers/ingest';
import { ExtractionError } from '../src/lib/extract';
import { FakeStore, ScriptedProvider, sqsRecord, validReceiptJson } from './helpers';

function deps(over: Partial<IngestDeps> = {}): IngestDeps {
  return {
    store: new FakeStore(),
    provider: new ScriptedProvider([validReceiptJson]),
    load: async () => ({ kind: 'pdf', text: 'RECEIPT TEXT' }),
    ...over,
  };
}

describe('ingest processRecord', () => {
  let d: IngestDeps;
  beforeEach(() => {
    d = deps();
  });

  it('writes RECEIVED then EXTRACTED for a good receipt', async () => {
    await processRecord(d, sqsRecord('a.pdf', 'e1'));
    const store = d.store as FakeStore;
    expect(store.items.size).toBe(1);
    const rec = [...store.items.values()][0]!;
    expect(rec.status).toBe('EXTRACTED');
    expect(rec.receipt?.merchant).toBe('Blue Bottle Coffee');
    expect(rec.meta?.modelId).toBe('scripted-model');
  });

  it('does not duplicate or reprocess a redelivered, already-extracted event', async () => {
    const provider = new ScriptedProvider([validReceiptJson, validReceiptJson]);
    d = deps({ provider });
    await processRecord(d, sqsRecord('a.pdf', 'e1'));
    await processRecord(d, sqsRecord('a.pdf', 'e1'));
    expect((d.store as FakeStore).items.size).toBe(1);
    // Only the first delivery should have called the model.
    expect(provider.calls.length).toBe(1);
  });

  it('marks FAILED without throwing when a PDF cannot be parsed', async () => {
    d = deps({
      load: async () => {
        throw new ExtractionError('pdf parse failed: corrupt');
      },
    });
    const result = await processRecord(d, sqsRecord('bad.pdf', 'e1'));
    expect(result.status).toBe('FAILED');
    const rec = [...(d.store as FakeStore).items.values()][0]!;
    expect(rec.status).toBe('FAILED');
    expect(rec.failureReason).toContain('pdf parse failed');
  });

  it('routes an image object through the vision path', async () => {
    const provider = new ScriptedProvider([validReceiptJson]);
    d = deps({ provider, load: async () => ({ kind: 'image', images: [{ mediaType: 'image/png', dataBase64: 'AAAA' }] }) });
    const result = await processRecord(d, sqsRecord('photo.png', 'e1'));
    expect(result.status).toBe('EXTRACTED');
    // The provider was handed the image, not text.
    expect(provider.calls[0]!.images?.[0]?.mediaType).toBe('image/png');
  });

  it('scrubs PII from an extracted receipt before it is stored', async () => {
    const withCard = JSON.stringify({
      merchant: 'Corner Grocery 4111 1111 1111 1111',
      date: '2025-03-14',
      currency: 'USD',
      lineItems: [{ description: 'Milk', quantity: 1, amount: 3.99 }],
      total: 3.99,
    });
    d = deps({ provider: new ScriptedProvider([withCard]) });
    await processRecord(d, sqsRecord('c.pdf', 'e1'));
    const rec = [...(d.store as FakeStore).items.values()][0]!;
    expect(rec.status).toBe('EXTRACTED');
    expect(rec.receipt?.merchant).toBe('Corner Grocery [card ending 1111]');
  });

  it('rethrows infrastructure errors so SQS retries into the DLQ', async () => {
    d = deps({
      load: async () => {
        throw new Error('S3 AccessDenied');
      },
    });
    await expect(processRecord(d, sqsRecord('x.pdf', 'e1'))).rejects.toThrow('AccessDenied');
    // The record was still written as RECEIVED before the failure.
    const rec = [...(d.store as FakeStore).items.values()][0]!;
    expect(rec.status).toBe('RECEIVED');
  });
});
