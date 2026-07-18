/**
 * Synthetic canary. On every schedule tick it uploads one known receipt to the
 * ingest bucket and checks the pipeline stored the golden result back for it,
 * then emits a single CloudWatch pass/fail metric that an alarm watches.
 *
 * The bytes are deterministic and the key is fixed, so the S3 etag, and through
 * it the docId, is stable. After the first run the upload is a duplicate the
 * pipeline dedupes rather than a fresh model call. That is what keeps a 15
 * minute cadence at pennies a month: the model runs once, then every later tick
 * just re-reads the stored record and confirms it is still intact. A table
 * reset re-primes on the next tick, which re-exercises real extraction end to
 * end. See RUNBOOK.md, alarm CanaryFailing.
 */
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { makeReceiptPdf } from '../lib/receipt-pdf';
import { deriveDocId } from '../lib/docid';
import { documentClient, DynamoDocumentStore } from '../lib/store';
import type { Receipt } from '../lib/schema';
import { logger, metrics } from '../lib/powertools';

// One fixed object, uploaded to one fixed key every run. The CDK grant is scoped
// to this exact key, so keep the two in step.
const CANARY_KEY = 'canary/golden-receipt.pdf';

// The known receipt and the values the pipeline must store back for it. This is
// the golden the canary asserts against, kept beside the code that uploads it.
// Chosen clean and unambiguous so the model reads it the same way every time.
const GOLDEN_LINES = [
  'Blue Bottle Coffee',
  'Date: 2025-01-05',
  'Currency: USD',
  'Latte x2 9.00',
  'Bagel x1 3.25',
  'Subtotal: 12.25',
  'Tax: 0.98',
  'Total: 13.23',
  'Paid: credit',
];
const GOLDEN = { merchant: 'Blue Bottle Coffee', date: '2025-01-05', currency: 'USD', total: 13.23 };

const POLL_MS = 3000;
const POLL_BUDGET_MS = 45_000;

export const handler = async (): Promise<void> => {
  const bucket = requireEnv('BUCKET_NAME');
  const table = requireEnv('TABLE_NAME');
  const s3 = new S3Client({});
  const store = new DynamoDocumentStore(table, documentClient(new DynamoDBClient({})));

  let pass = 0;
  try {
    const put = await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: CANARY_KEY,
        Body: makeReceiptPdf(GOLDEN_LINES),
        ContentType: 'application/pdf',
      }),
    );
    const etag = (put.ETag ?? '').replace(/"/g, '');
    const docId = deriveDocId(bucket, CANARY_KEY, etag);

    // Wait out a first-run extraction; a steady-state tick finds it already there.
    const deadline = Date.now() + POLL_BUDGET_MS;
    let record = await store.get(docId);
    while ((!record || record.status === 'RECEIVED') && Date.now() < deadline) {
      await sleep(POLL_MS);
      record = await store.get(docId);
    }

    if (record?.status === 'EXTRACTED' && record.receipt && matchesGolden(record.receipt)) {
      pass = 1;
      logger.info('canary pass', { docId, latencyMs: record.meta?.latencyMs });
    } else {
      logger.error('canary fail', {
        docId,
        status: record?.status,
        stored: record?.receipt,
        reason: record?.failureReason,
      });
    }
  } catch (err) {
    logger.error('canary error', { error: err instanceof Error ? err.message : String(err) });
  } finally {
    // One datapoint per run: 1 pass, 0 fail. The CanaryFailing alarm watches this.
    metrics.addMetric('CanaryPass', MetricUnit.Count, pass);
    metrics.publishStoredMetrics();
  }
};

// Assert the fields the model reads deterministically off clean text: who, when,
// the currency, and the money. Amounts compare in integer cents.
function matchesGolden(r: Receipt): boolean {
  return (
    r.merchant.trim().toLowerCase() === GOLDEN.merchant.toLowerCase() &&
    r.date === GOLDEN.date &&
    r.currency === GOLDEN.currency &&
    Math.round(r.total * 100) === Math.round(GOLDEN.total * 100)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env ${name}`);
  return value;
}
