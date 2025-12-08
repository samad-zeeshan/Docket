/**
 * End-to-end integration against LocalStack: a real S3 object read by a real S3
 * client, and the RECEIVED then EXTRACTED writes plus the idempotency conditional
 * put against real DynamoDB. The unit suite fakes both; this proves the wiring.
 *
 * Skipped unless RUN_INTEGRATION=1, so the default `npm test` needs no Docker.
 * Bring the backend up first: `docker compose -f docker-compose.localstack.yml up`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteBucketCommand,
} from '@aws-sdk/client-s3';
import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { documentClient, DynamoDocumentStore } from '../../src/lib/store';
import { getObjectBytes } from '../../src/lib/s3';
import { processRecord, type IngestDeps } from '../../src/handlers/ingest';
import { deriveDocId } from '../../src/lib/docid';
import { ScriptedProvider, sqsRecord, validReceiptJson } from '../helpers';

const RUN = process.env.RUN_INTEGRATION === '1';
const endpoint = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';
const config = { region: 'us-east-1', endpoint, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } };

// Unique names per run so a leftover from a crashed run does not collide.
const suffix = String(Date.now());
const bucket = `docket-int-${suffix}`;
const table = `docket-int-${suffix}`;

describe.skipIf(!RUN)('pipeline integration (LocalStack)', () => {
  const s3 = new S3Client({ ...config, forcePathStyle: true });
  const ddb = new DynamoDBClient(config);
  const store = new DynamoDocumentStore(table, documentClient(ddb));

  beforeAll(async () => {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await ddb.send(
      new CreateTableCommand({
        TableName: table,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          { AttributeName: 'docId', AttributeType: 'S' },
          { AttributeName: 'status', AttributeType: 'S' },
          { AttributeName: 'receivedAt', AttributeType: 'S' },
        ],
        KeySchema: [{ AttributeName: 'docId', KeyType: 'HASH' }],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'status-index',
            KeySchema: [
              { AttributeName: 'status', KeyType: 'HASH' },
              { AttributeName: 'receivedAt', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
      }),
    );
    await waitUntilTableExists({ client: ddb, maxWaitTime: 30 }, { TableName: table });
  }, 60_000);

  afterAll(async () => {
    // Best effort teardown so a failing assertion does not leak resources.
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
      await ddb.send(new DeleteTableCommand({ TableName: table }));
    } catch {
      /* ignore */
    }
  }, 30_000);

  const key = 'receipts/int-0001.pdf';

  // The handler reads real bytes from S3; extraction is stubbed so the test needs
  // no model, which keeps the focus on the S3 and DynamoDB wiring.
  function deps(): IngestDeps {
    return {
      store,
      provider: new ScriptedProvider([validReceiptJson]),
      load: async (b, k) => ({ kind: 'pdf', text: (await getObjectBytes(s3, b, k)).toString('utf8') }),
    };
  }

  it('ingests an S3 object into DynamoDB and is idempotent on redelivery', async () => {
    const put = await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: 'RECEIPT TEXT for integration' }));
    const etag = (put.ETag ?? '').replace(/"/g, '');
    const expectedDocId = deriveDocId(bucket, key, etag);
    const event = sqsRecord(key, etag, bucket);

    const first = await processRecord(deps(), event);
    expect(first.status).toBe('EXTRACTED');
    expect(first.docId).toBe(expectedDocId);

    const stored = await store.get(expectedDocId);
    expect(stored?.status).toBe('EXTRACTED');
    expect(stored?.receipt?.merchant).toBe('Blue Bottle Coffee');

    // Redelivery of the same event must not reprocess: the conditional put on a
    // real table is what enforces it.
    const second = await processRecord(deps(), event);
    expect(second.status).toBe('SKIPPED');
  }, 30_000);
});
