import { describe, it, expect } from 'vitest';
import jpeg from 'jpeg-js';
import { processRecord, type IngestDeps } from '../src/handlers/ingest';
import type { CalibrationParams } from '../src/lib/calibrate';
import type { RouterParams } from '../src/lib/router';
import { DynamoDocumentStore } from '../src/lib/store';
import { FakeStore, ScriptedProvider, sqsRecord, validReceiptJson } from './helpers';

function photo(): string {
  const w = 64;
  const h = 128;
  const data = Buffer.alloc(w * h * 4, 255);
  for (let y = 10; y < h; y += 12) for (let x = 5; x < w - 5; x++) data.fill(0, (y * w + x) * 4, (y * w + x) * 4 + 3);
  return Buffer.from(jpeg.encode({ data, width: w, height: h }, 90).data).toString('base64');
}

// Always small: a large positive bias and nothing else.
const alwaysSmall: RouterParams = {
  model: 't',
  mean: new Array(8).fill(0),
  std: new Array(8).fill(1),
  weights: [10, 0, 0, 0, 0, 0, 0, 0, 0],
  threshold: 0.5,
};

// Calibrated confidence follows the verbalized total.
function calibration(threshold: number): CalibrationParams {
  const w = new Array(11).fill(0);
  w[1] = 20;
  w[0] = -10;
  return { model: 't', threshold, fields: { total: { weights: w, isotonic: { x: [], y: [] } } } };
}

function withConf(total: number): string {
  return JSON.stringify({ ...JSON.parse(validReceiptJson), confidence: { total } });
}

const meta = { modelId: 'm', promptVersion: 'v', inputTokens: 1, outputTokens: 1, latencyMs: 1 };

function deps(over: Partial<IngestDeps>): IngestDeps {
  return {
    store: new FakeStore(),
    provider: new ScriptedProvider([validReceiptJson]),
    load: async () => ({ kind: 'image', images: [{ mediaType: 'image/jpeg', dataBase64: photo() }] }),
    ...over,
  };
}

describe('confidence and review in the pipeline', () => {
  it('stores the route and per field confidence alongside the record', async () => {
    const small = new ScriptedProvider([withConf(0.99)]);
    const d = deps({ smallProvider: small, router: alwaysSmall, calibration: calibration(0.5) });
    const result = await processRecord(d, sqsRecord('p.jpg', 'e1'));
    const rec = [...(d.store as FakeStore).items.values()][0]!;
    expect(result.status).toBe('EXTRACTED');
    expect(rec.route).toBe('small');
    expect(rec.confidence?.total).toBeGreaterThan(0.9);
    expect(small.calls).toHaveLength(1);
  });

  it('marks NEEDS_REVIEW and queues the receipt when a field is under the threshold', async () => {
    const d = deps({ smallProvider: new ScriptedProvider([withConf(0.2)]), router: alwaysSmall, calibration: calibration(0.5) });
    const result = await processRecord(d, sqsRecord('p.jpg', 'e1'));
    const store = d.store as FakeStore;
    const rec = [...store.items.values()][0]!;
    expect(result.status).toBe('NEEDS_REVIEW');
    expect(rec.status).toBe('NEEDS_REVIEW');
    expect(rec.receipt?.merchant).toBe('Blue Bottle Coffee');
    expect(rec.reviewReason).toContain('total');
    expect(store.reviewQueue.map((q) => q.docId)).toEqual([rec.docId]);
  });

  it('never lets confidence rescue a response the schema gate refused', async () => {
    const bad = JSON.stringify({ merchant: 'X', confidence: { total: 1 } });
    const d = deps({
      smallProvider: new ScriptedProvider([bad, bad]),
      provider: new ScriptedProvider([bad, bad]),
      router: alwaysSmall,
      calibration: calibration(0),
    });
    const result = await processRecord(d, sqsRecord('p.jpg', 'e1'));
    expect(result.status).toBe('FAILED');
    expect((d.store as FakeStore).reviewQueue).toHaveLength(0);
  });

  it('escalates to the large model when the small model fails the gate', async () => {
    const bad = '{"merchant":"X"}';
    const large = new ScriptedProvider([validReceiptJson]);
    const d = deps({ smallProvider: new ScriptedProvider([bad, bad]), provider: large, router: alwaysSmall, calibration: calibration(0.5) });
    const result = await processRecord(d, sqsRecord('p.jpg', 'e1'));
    const rec = [...(d.store as FakeStore).items.values()][0]!;
    expect(result.status).toBe('EXTRACTED');
    expect(rec.route).toBe('small-escalated');
    expect(large.calls).toHaveLength(1);
  });

  it('uses the large model when no small model is configured', async () => {
    const d = deps({ provider: new ScriptedProvider([validReceiptJson]), router: alwaysSmall, calibration: calibration(0.5) });
    await processRecord(d, sqsRecord('p.jpg', 'e1'));
    expect([...(d.store as FakeStore).items.values()][0]!.route).toBe('large');
  });

  it('reviews a large model receipt whose totals do not reconcile, since that path has no calibrator', async () => {
    const tipped = JSON.stringify({ ...JSON.parse(validReceiptJson), total: 7.2 });
    const d = deps({ provider: new ScriptedProvider([tipped]) });
    const result = await processRecord(d, sqsRecord('p.jpg', 'e1'));
    expect(result.status).toBe('NEEDS_REVIEW');
  });
});

describe('DynamoDocumentStore review queue', () => {
  it('writes the record and the queue item in one transaction', async () => {
    const sent: any[] = [];
    const client = { send: async (cmd: any) => (sent.push(cmd), {}) } as any;
    const store = new DynamoDocumentStore('docs', client, 'queue');
    await store.markExtracted('d1', JSON.parse(validReceiptJson), meta, {
      route: 'small',
      confidence: { total: 0.2 },
      needsReview: true,
      reason: 'total low',
    });
    expect(sent).toHaveLength(1);
    const items = sent[0].input.TransactItems;
    expect(items[0].Update.ExpressionAttributeValues[':s']).toBe('NEEDS_REVIEW');
    expect(items[1].Put).toMatchObject({ TableName: 'queue', Item: { docId: 'd1', reason: 'total low' } });
  });

  it('writes a plain update when no review is needed', async () => {
    const sent: any[] = [];
    const client = { send: async (cmd: any) => (sent.push(cmd), {}) } as any;
    await new DynamoDocumentStore('docs', client, 'queue').markExtracted('d1', JSON.parse(validReceiptJson), meta, {
      route: 'large',
      confidence: {},
      needsReview: false,
      reason: 'ok',
    });
    expect(sent[0].input.ExpressionAttributeValues[':s']).toBe('EXTRACTED');
    expect(sent[0].input.ExpressionAttributeValues[':route']).toBe('large');
  });
});
