/**
 * SQS consumer for S3 upload events. Writes a RECEIVED stub, extracts the
 * receipt behind the schema gate, and records EXTRACTED or FAILED.
 *
 * Error split: bad data (corrupt PDF, schema miss) becomes FAILED and is done.
 * Infrastructure errors (S3, model 5xx) throw so SQS retries and the DLQ stays
 * meaningful.
 */
import type { SQSHandler, SQSRecord, SQSBatchItemFailure } from 'aws-lambda';
import { S3Client } from '@aws-sdk/client-s3';
import { deriveDocId } from '../lib/docid';
import { parseS3Event } from '../lib/events';
import { getObjectBytes } from '../lib/s3';
import { extractText } from '../lib/pdf';
import { extractReceipt, ExtractionError, type ExtractionOutcome, type OutcomeMeta } from '../lib/extract';
import { createProvider } from '../lib/providers';
import { DynamoDocumentStore, type DocumentStore } from '../lib/store';
import type { ModelProvider } from '../lib/providers/types';
import { log } from '../lib/log';

export interface IngestDeps {
  store: DocumentStore;
  provider: ModelProvider;
  getText(bucket: string, key: string): Promise<string>;
}

let cached: IngestDeps | undefined;

// Built lazily so importing this module in tests never needs env or AWS clients.
function getDeps(): IngestDeps {
  if (!cached) {
    const s3 = new S3Client({});
    cached = {
      store: new DynamoDocumentStore(requireEnv('TABLE_NAME')),
      provider: createProvider(),
      getText: async (bucket, key) => {
        const bytes = await getObjectBytes(s3, bucket, key);
        try {
          return await extractText(bytes);
        } catch (err) {
          // A PDF we cannot read is bad data, not an outage. Mark it terminal so
          // it lands as FAILED instead of cycling into the DLQ.
          throw new ExtractionError(`pdf parse failed: ${messageOf(err)}`);
        }
      },
    };
  }
  return cached;
}

export const handler: SQSHandler = async (event) => {
  const deps = getDeps();
  const failures: SQSBatchItemFailure[] = [];
  for (const record of event.Records) {
    try {
      await processRecord(deps, record);
    } catch (err) {
      log.error('ingest record failed', { messageId: record.messageId, err: messageOf(err) });
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
};

export async function processRecord(deps: IngestDeps, record: SQSRecord): Promise<void> {
  const s3obj = parseS3Event(record.body);
  const docId = deriveDocId(s3obj.bucket, s3obj.key, s3obj.etag);

  const put = await deps.store.putReceived({
    docId,
    status: 'RECEIVED',
    s3Bucket: s3obj.bucket,
    s3Key: s3obj.key,
    etag: s3obj.etag,
    receivedAt: new Date().toISOString(),
  });

  if (put === 'duplicate') {
    const existing = await deps.store.get(docId);
    // Reprocess only if a prior attempt died at RECEIVED. An EXTRACTED or FAILED
    // item is a true redelivery and must not be redone.
    if (existing && existing.status !== 'RECEIVED') {
      log.info('already processed, skipping', { docId, status: existing.status });
      return;
    }
  }

  try {
    const text = await deps.getText(s3obj.bucket, s3obj.key);
    const outcome = await extractReceipt(deps.provider, text);
    if (outcome.status === 'EXTRACTED') {
      await deps.store.markExtracted(docId, outcome.receipt, metaOf(outcome));
      log.info('extracted', { docId, latencyMs: outcome.latencyMs, outputTokens: outcome.outputTokens });
    } else {
      await deps.store.markFailed(docId, outcome.failureReason, metaOf(outcome));
      log.warn('failed schema gate', { docId, reason: outcome.failureReason });
    }
  } catch (err) {
    if (err instanceof ExtractionError) {
      await deps.store.markFailed(docId, err.message);
      log.warn('extraction failed', { docId, reason: err.message });
      return;
    }
    throw err;
  }
}

function metaOf(outcome: ExtractionOutcome): OutcomeMeta {
  return {
    modelId: outcome.modelId,
    promptVersion: outcome.promptVersion,
    inputTokens: outcome.inputTokens,
    outputTokens: outcome.outputTokens,
    latencyMs: outcome.latencyMs,
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env ${name}`);
  return value;
}
