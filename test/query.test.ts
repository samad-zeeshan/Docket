import { describe, it, expect, beforeEach } from 'vitest';
import { handleQuery } from '../src/handlers/query';
import { FakeStore } from './helpers';
import type { DocumentRecord } from '../src/lib/model';

const extracted: DocumentRecord = {
  docId: 'doc-1',
  status: 'EXTRACTED',
  s3Bucket: 'ingest',
  s3Key: 'a.pdf',
  etag: 'e1',
  receivedAt: '2025-03-01T10:00:00.000Z',
  updatedAt: '2025-03-01T10:00:05.000Z',
  receipt: {
    merchant: 'Blue Bottle',
    date: '2025-03-01',
    currency: 'USD',
    lineItems: [{ description: 'Latte', quantity: 1, amount: 5.5 }],
    total: 5.5,
  },
  meta: { modelId: 'm', promptVersion: 'v1', inputTokens: 1, outputTokens: 2, latencyMs: 900 },
};

describe('query handler', () => {
  let store: FakeStore;
  beforeEach(() => {
    store = new FakeStore();
    store.items.set(extracted.docId, extracted);
  });

  it('returns 200 with the receipt and hides internal fields', async () => {
    const res = await handleQuery(store, { route: 'get', docId: 'doc-1' });
    expect(res.statusCode).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.receipt).toBeTruthy();
    expect(body.s3Bucket).toBeUndefined();
    expect(body.etag).toBeUndefined();
  });

  it('returns 404 for an unknown id', async () => {
    const res = await handleQuery(store, { route: 'get', docId: 'nope' });
    expect(res.statusCode).toBe(404);
  });

  it('lists by status', async () => {
    const res = await handleQuery(store, { route: 'list', status: 'EXTRACTED' });
    expect(res.statusCode).toBe(200);
    expect((res.body as { count: number }).count).toBe(1);
  });

  it('rejects an unknown status with 400', async () => {
    const res = await handleQuery(store, { route: 'list', status: 'BOGUS' });
    expect(res.statusCode).toBe(400);
  });

  it('refuses to serve a stored payload that no longer passes the gate', async () => {
    // Simulate drift: an EXTRACTED record whose receipt is missing required fields.
    store.items.set('bad', { ...extracted, docId: 'bad', receipt: { merchant: 'x' } as never });
    const res = await handleQuery(store, { route: 'get', docId: 'bad' });
    expect(res.statusCode).toBe(500);
  });

  it('drops an invalid record from a list rather than failing it', async () => {
    store.items.set('bad', { ...extracted, docId: 'bad', receipt: { merchant: 'x' } as never });
    const res = await handleQuery(store, { route: 'list', status: 'EXTRACTED' });
    expect(res.statusCode).toBe(200);
    expect((res.body as { count: number }).count).toBe(1);
  });
});
