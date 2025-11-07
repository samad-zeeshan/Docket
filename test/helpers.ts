// Shared test doubles. Kept out of the handlers so nothing test-only ships in a
// Lambda bundle.
import type { SQSRecord } from 'aws-lambda';
import type { DocumentStore } from '../src/lib/store';
import type { DocumentRecord, ExtractionMetadata } from '../src/lib/model';
import type { ModelProvider, ModelRequest, ModelResult } from '../src/lib/providers/types';
import type { Receipt } from '../src/lib/schema';

export class FakeStore implements DocumentStore {
  readonly items = new Map<string, DocumentRecord>();

  async putReceived(record: DocumentRecord): Promise<'created' | 'duplicate'> {
    if (this.items.has(record.docId)) return 'duplicate';
    this.items.set(record.docId, record);
    return 'created';
  }

  async get(docId: string): Promise<DocumentRecord | undefined> {
    return this.items.get(docId);
  }

  async markExtracted(docId: string, receipt: Receipt, meta: ExtractionMetadata): Promise<void> {
    const existing = this.items.get(docId);
    if (existing) this.items.set(docId, { ...existing, status: 'EXTRACTED', receipt, meta });
  }

  async markFailed(docId: string, reason: string, meta?: ExtractionMetadata): Promise<void> {
    const existing = this.items.get(docId);
    if (existing) this.items.set(docId, { ...existing, status: 'FAILED', failureReason: reason, meta });
  }
}

// Returns each scripted response once, so a test can drive first-try success or
// a repair round.
export class ScriptedProvider implements ModelProvider {
  readonly name = 'scripted';
  private index = 0;
  readonly calls: ModelRequest[] = [];

  constructor(private readonly responses: string[]) {}

  async complete(request: ModelRequest): Promise<ModelResult> {
    this.calls.push(request);
    const text = this.responses[this.index++] ?? '{}';
    return { text, modelId: 'scripted-model', inputTokens: 10, outputTokens: 20 };
  }
}

export function sqsRecord(key: string, etag: string, bucket = 'ingest'): SQSRecord {
  const body = JSON.stringify({
    'detail-type': 'Object Created',
    source: 'aws.s3',
    detail: { bucket: { name: bucket }, object: { key, etag } },
  });
  return { messageId: `${key}:${etag}`, body } as SQSRecord;
}

export const validReceiptJson = JSON.stringify({
  merchant: 'Blue Bottle Coffee',
  date: '2025-03-14',
  currency: 'USD',
  lineItems: [{ description: 'Latte', quantity: 1, amount: 5.5 }],
  subtotal: 5.5,
  tax: 0.5,
  total: 6.0,
  paymentMethod: 'credit',
});
