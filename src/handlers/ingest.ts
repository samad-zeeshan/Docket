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
import { checkLineItems } from '../lib/schema';
import { imageStats } from '../lib/imagestats';
import { routeFor, type RouterParams } from '../lib/router';
import { calibratedConfidence, reviewDecision, signalsFromEvidence, type CalibrationParams } from '../lib/calibrate';
import { promptSmall } from '../lib/prompt';
import { LocalProvider } from '../lib/providers/local';
import type { StoredRoute } from '../lib/model';
import calibrationJson from '../lib/params/calibration.json';
import routerJson from '../lib/params/router.json';
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
  // The large model, Claude on Bedrock. Every doubt in routing lands here.
  provider: ModelProvider;
  smallProvider?: ModelProvider;
  router?: RouterParams;
  calibration?: CalibrationParams;
  load(bucket: string, key: string): Promise<ExtractInput>;
}

export interface RecordResult {
  docId: string;
  status: 'EXTRACTED' | 'NEEDS_REVIEW' | 'FAILED' | 'SKIPPED';
  meta?: OutcomeMeta;
  route?: StoredRoute;
}

// The committed parameter files start empty and are filled by eval/v2. Empty
// means not fitted, and an unfitted router or calibrator must not be applied.
function fitted<T extends object>(params: T, key: keyof T): T | undefined {
  const v = params[key];
  return Array.isArray(v) ? (v.length > 0 ? params : undefined) : v && Object.keys(v).length > 0 ? params : undefined;
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
    const smallUrl = process.env.SMALL_MODEL_URL;
    cached = {
      store: new DynamoDocumentStore(requireEnv('TABLE_NAME'), ddb, process.env.REVIEW_TABLE_NAME),
      provider: createProvider(process.env, { bedrockClient: bedrock }),
      smallProvider: smallUrl ? new LocalProvider(smallUrl, process.env.SMALL_MODEL_ID ?? 'qwen/qwen3.5-9b') : undefined,
      router: fitted(routerJson as RouterParams, 'weights'),
      calibration: fitted(calibrationJson as CalibrationParams, 'fields'),
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
    const { outcome, route } = await extractRouted(deps, input);
    if (outcome.status === 'EXTRACTED') {
      // Scrub any PII the model echoed into a free-text field before it is stored.
      const { receipt, redactions } = redactReceipt(outcome.receipt);
      if (redactions.length > 0) {
        metrics.addMetric('PiiRedacted', MetricUnit.Count, redactions.length);
        log.info('redacted pii before store', { docId, kinds: [...new Set(redactions.map((r) => r.kind))] });
      }

      // The gate already passed. From here confidence only chooses between
      // EXTRACTED and NEEDS_REVIEW, and the calibrator was fitted on the small
      // model alone, so it is applied to that route and no other.
      const calibration = route === 'small' ? deps.calibration : undefined;
      const signals = signalsFromEvidence(outcome.receipt, outcome.evidence);
      const confidence = calibratedConfidence(calibration, signals);
      const decision = reviewDecision(calibration, confidence, signals);
      await deps.store.markExtracted(docId, receipt, metaOf(outcome), {
        route,
        confidence,
        needsReview: decision.needsReview,
        reason: decision.reason,
      });

      // The lines must add up to the subtotal. When they do not, the model
      // misread a line and the schema gate cannot tell, because the JSON is
      // valid. Record it and move on: a soft signal, not a gate.
      //
      // After the write, never before. The handler publishes buffered metrics in
      // a finally, so a metric added ahead of a throwing markExtracted is still
      // published, and then SQS redelivers a document still sitting at RECEIVED
      // and counts the same misread receipt again.
      const lines = checkLineItems(receipt);
      if (lines && !lines.reconciles) {
        metrics.addMetric('LineItemsMismatch', MetricUnit.Count, 1);
        log.warn('line items do not sum to the subtotal', { docId, delta: lines.delta });
      }

      const status = decision.needsReview ? 'NEEDS_REVIEW' : 'EXTRACTED';
      log.info('extracted', { docId, status, route, reason: decision.reason, latencyMs: outcome.latencyMs });
      return { docId, status, meta: metaOf(outcome), route };
    }
    await deps.store.markFailed(docId, outcome.failureReason, metaOf(outcome));
    log.warn('failed schema gate', { docId, reason: outcome.failureReason, route });
    return { docId, status: 'FAILED', meta: metaOf(outcome), route };
  } catch (err) {
    if (err instanceof ExtractionError) {
      await deps.store.markFailed(docId, err.message);
      log.warn('extraction failed', { docId, reason: err.message });
      return { docId, status: 'FAILED' };
    }
    throw err;
  }
}

// Photos go through the router. A small model answer that fails the gate is
// retried once on Claude, so routing can cost money but never a receipt. PDFs
// carry no image statistics and always take the large model.
async function extractRouted(deps: IngestDeps, input: ExtractInput): Promise<{ outcome: ExtractionOutcome; route: StoredRoute }> {
  if (input.kind !== 'image') return { outcome: await extractReceipt(deps.provider, input.text), route: 'large' };
  const first = input.images[0];
  const stats = first ? imageStats(Buffer.from(first.dataBase64, 'base64'), first.mediaType) : undefined;
  const decision = routeFor(stats, deps.router, deps.smallProvider !== undefined);
  if (decision.route === 'small' && deps.smallProvider) {
    const small = await extractReceiptFromImage(deps.smallProvider, input.images, promptSmall);
    if (small.status === 'EXTRACTED') return { outcome: small, route: 'small' };
    log.info('small model failed the gate, escalating', { reason: small.failureReason });
    return { outcome: await extractReceiptFromImage(deps.provider, input.images), route: 'small-escalated' };
  }
  return { outcome: await extractReceiptFromImage(deps.provider, input.images), route: 'large' };
}

// One place that turns a record outcome into metrics, so the counters cannot
// drift from what actually happened.
function emit(result: RecordResult): void {
  metrics.addMetric('DocumentsProcessed', MetricUnit.Count, 1);
  if (result.status === 'EXTRACTED' || result.status === 'NEEDS_REVIEW') metrics.addMetric('ExtractionSucceeded', MetricUnit.Count, 1);
  if (result.status === 'NEEDS_REVIEW') metrics.addMetric('NeedsReview', MetricUnit.Count, 1);
  if (result.route) metrics.addMetric(`Route_${result.route}`, MetricUnit.Count, 1);
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
