/**
 * SQS consumer for S3 upload events. Writes a RECEIVED stub per document and
 * relies on a conditional put so redelivered events do not duplicate.
 */
import type { SQSHandler, SQSRecord, SQSBatchItemFailure } from 'aws-lambda';
import { deriveDocId } from '../lib/docid';
import { parseS3Event } from '../lib/events';
import { DynamoDocumentStore, type DocumentStore } from '../lib/store';
import { log } from '../lib/log';

let defaultStore: DocumentStore | undefined;

// Lazy so importing this module in tests never needs TABLE_NAME or a real client.
function getStore(): DocumentStore {
  if (!defaultStore) defaultStore = new DynamoDocumentStore(requireEnv('TABLE_NAME'));
  return defaultStore;
}

export const handler: SQSHandler = async (event) => {
  const store = getStore();
  const failures: SQSBatchItemFailure[] = [];
  for (const record of event.Records) {
    try {
      await processRecord(store, record);
    } catch (err) {
      // Fail only this message. Partial batch response keeps the siblings from
      // being retried and reprocessed just because one of them threw.
      log.error('ingest record failed', { messageId: record.messageId, err: String(err) });
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
};

export async function processRecord(store: DocumentStore, record: SQSRecord): Promise<void> {
  const s3 = parseS3Event(record.body);
  const docId = deriveDocId(s3.bucket, s3.key, s3.etag);
  const result = await store.putReceived({
    docId,
    status: 'RECEIVED',
    s3Bucket: s3.bucket,
    s3Key: s3.key,
    etag: s3.etag,
    receivedAt: new Date().toISOString(),
  });
  if (result === 'duplicate') {
    log.info('duplicate event ignored', { docId });
    return;
  }
  log.info('document received', { docId, s3Key: s3.key });
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env ${name}`);
  return value;
}
