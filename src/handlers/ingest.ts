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
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { deriveDocId } from '../lib/docid';
import { parseS3Event } from '../lib/events';
import { getObjectBytes } from '../lib/s3';
import { extractText } from '../lib/pdf';
import {
  extractReceipt,
  extractReceiptFromImage,
  ExtractionError,
  type ExtractionOutcome,
  type OutcomeMeta,
} from '../lib/extract';
import { redactReceipt } from '../lib/redact';
import { createProvider } from '../lib/providers';
import { DynamoDocumentStore, documentClient, type DocumentStore } from '../lib/store';
import type { ImageInput, ModelProvider } from '../lib/providers/types';
import { log } from '../lib/log';
import { metrics, tracer } from '../lib/powertools';

// What a stored object yields once loaded: born-digital text from a PDF, or the
// image bytes from a photo. processRecord routes on this instead of on the key.
export type ExtractInput = { kind: 'pdf'; text: string } | { kind: 'image'; images: ImageInput[] };

// Object key extension to the media type Bedrock expects for the image.
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export interface IngestDeps {
  store: DocumentStore;
  provider: ModelProvider;
  load(bucket: string, key: string): Promise<ExtractInput>;
}

export interface RecordResult {
  docId: string;
  status: 'EXTRACTED' | 'FAILED' | 'SKIPPED';
  meta?: OutcomeMeta;
}

let cached: IngestDeps | undefined;

// Built lazily so importing this module in tests never needs env or AWS clients.
function getDeps(): IngestDeps {
  if (!cached) {
    // Wrap the SDK clients so S3, DynamoDB, and Bedrock calls show up as X-Ray
    // subsegments, which is what gives the one-document trace from read to write.
    //
    // Bedrock especially. It is the slowest call in the pipeline by a wide margin,
    // so an untraced client leaves a second of silence in the middle of the trace
    // exactly where an operator is looking for the answer.
    const s3 = tracer.captureAWSv3Client(new S3Client({}));
    const ddb = documentClient(tracer.captureAWSv3Client(new DynamoDBClient({})));
    const bedrock = tracer.captureAWSv3Client(new BedrockRuntimeClient({ maxAttempts: 3 }));
    cached = {
      store: new DynamoDocumentStore(requireEnv('TABLE_NAME'), ddb),
      provider: createProvider(process.env, { bedrockClient: bedrock }),
      load: async (bucket, key) => {
        const bytes = await getObjectBytes(s3, bucket, key);
        const ext = key.toLowerCase().split('.').pop() ?? '';
        if (ext === 'pdf') {
          try {
            return { kind: 'pdf', text: await extractText(bytes) };
          } catch (err) {
            // A PDF we cannot read is bad data, not an outage. Mark it terminal so
            // it lands as FAILED instead of cycling into the DLQ.
            throw new ExtractionError(`pdf parse failed: ${messageOf(err)}`);
          }
        }
        const mediaType = IMAGE_MEDIA_TYPES[ext];
        if (mediaType) return { kind: 'image', images: [{ mediaType, dataBase64: bytes.toString('base64') }] };
        throw new ExtractionError(`unsupported file type .${ext}`);
      },
    };
  }
  return cached;
}

export const handler: SQSHandler = async (event) => {
  const deps = getDeps();
  const failures: SQSBatchItemFailure[] = [];
  try {
    for (const record of event.Records) {
      try {
        emit(await processRecord(deps, record));
      } catch (err) {
        // Infrastructure error. Fail just this message so its siblings still ack.
        metrics.addMetric('IngestError', MetricUnit.Count, 1);
        log.error('ingest record failed', { messageId: record.messageId, err: messageOf(err) });
        failures.push({ itemIdentifier: record.messageId });
      }
    }
  } finally {
    metrics.publishStoredMetrics();
  }
  return { batchItemFailures: failures };
};

export async function processRecord(deps: IngestDeps, record: SQSRecord): Promise<RecordResult> {
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
      return { docId, status: 'SKIPPED' };
    }
  }

  try {
    const input = await deps.load(s3obj.bucket, s3obj.key);
    const outcome =
      input.kind === 'image'
        ? await extractReceiptFromImage(deps.provider, input.images)
        : await extractReceipt(deps.provider, input.text);
    if (outcome.status === 'EXTRACTED') {
      // Scrub any PII the model echoed into a free-text field before it is stored.
      const { receipt, redactions } = redactReceipt(outcome.receipt);
      if (redactions.length > 0) {
        metrics.addMetric('PiiRedacted', MetricUnit.Count, redactions.length);
        log.info('redacted pii before store', { docId, kinds: [...new Set(redactions.map((r) => r.kind))] });
      }
      await deps.store.markExtracted(docId, receipt, metaOf(outcome));
      log.info('extracted', { docId, latencyMs: outcome.latencyMs, outputTokens: outcome.outputTokens });
      return { docId, status: 'EXTRACTED', meta: metaOf(outcome) };
    }
    await deps.store.markFailed(docId, outcome.failureReason, metaOf(outcome));
    log.warn('failed schema gate', { docId, reason: outcome.failureReason });
    return { docId, status: 'FAILED', meta: metaOf(outcome) };
  } catch (err) {
    if (err instanceof ExtractionError) {
      await deps.store.markFailed(docId, err.message);
      log.warn('extraction failed', { docId, reason: err.message });
      return { docId, status: 'FAILED' };
    }
    throw err;
  }
}

// One place that turns a record outcome into metrics, so the counters cannot
// drift from what actually happened.
function emit(result: RecordResult): void {
  metrics.addMetric('DocumentsProcessed', MetricUnit.Count, 1);
  if (result.status === 'EXTRACTED') metrics.addMetric('ExtractionSucceeded', MetricUnit.Count, 1);
  if (result.status === 'FAILED') metrics.addMetric('ExtractionFailed', MetricUnit.Count, 1);
  if (result.meta) {
    metrics.addMetric('ExtractionLatency', MetricUnit.Milliseconds, result.meta.latencyMs);
    metrics.addMetric('InputTokens', MetricUnit.Count, result.meta.inputTokens);
    metrics.addMetric('OutputTokens', MetricUnit.Count, result.meta.outputTokens);
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
