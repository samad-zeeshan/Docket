/**
 * Read API over the documents table. Two routes, both revalidate against the
 * same schema before returning, so the API never serves a payload the gate
 * would reject.
 */
import type { APIGatewayProxyHandlerV2, APIGatewayProxyEventV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { ReceiptSchema } from '../lib/schema';
import { DynamoDocumentStore, documentClient, type DocumentStore } from '../lib/store';
import type { DocumentRecord, DocumentStatus } from '../lib/model';
import { log } from '../lib/log';
import { metrics, tracer } from '../lib/powertools';

const STATUSES: DocumentStatus[] = ['RECEIVED', 'EXTRACTED', 'FAILED'];
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface QueryRequest {
  route: 'get' | 'list' | 'unknown';
  docId?: string;
  status?: string;
  limit?: string;
}

export interface ApiResult {
  statusCode: number;
  body: unknown;
}

let defaultStore: DocumentStore | undefined;
function getStore(): DocumentStore {
  if (!defaultStore) {
    const ddb = documentClient(tracer.captureAWSv3Client(new DynamoDBClient({})));
    defaultStore = new DynamoDocumentStore(requireEnv('TABLE_NAME'), ddb);
  }
  return defaultStore;
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const result = await handleQuery(getStore(), toRequest(event));
  metrics.addMetric('ApiRequest', MetricUnit.Count, 1);
  if (result.statusCode >= 500) metrics.addMetric('ApiError', MetricUnit.Count, 1);
  metrics.publishStoredMetrics();
  return {
    statusCode: result.statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(result.body),
  };
};

export async function handleQuery(store: DocumentStore, req: QueryRequest): Promise<ApiResult> {
  if (req.route === 'get') {
    if (!req.docId) return error(400, 'missing docId');
    const record = await store.get(req.docId);
    if (!record) return { statusCode: 404, body: { error: 'document not found', docId: req.docId } };
    try {
      return { statusCode: 200, body: toDto(record) };
    } catch {
      // Stored payload no longer passes the gate. Refuse to serve it.
      log.error('stored receipt failed revalidation', { docId: req.docId });
      return error(500, 'stored payload failed validation');
    }
  }

  if (req.route === 'list') {
    if (!req.status || !STATUSES.includes(req.status as DocumentStatus)) {
      return error(400, `status must be one of ${STATUSES.join(', ')}`);
    }
    const records = await store.listByStatus(req.status as DocumentStatus, clampLimit(req.limit));
    const items: unknown[] = [];
    for (const record of records) {
      // Drop a bad record from a list rather than failing the whole response.
      try {
        items.push(toDto(record));
      } catch {
        log.warn('excluding record that failed revalidation', { docId: record.docId });
      }
    }
    return { statusCode: 200, body: { count: items.length, items } };
  }

  return error(404, 'not found');
}

function toRequest(event: APIGatewayProxyEventV2): QueryRequest {
  const routeKey = event.routeKey ?? '';
  if (routeKey.startsWith('GET /documents/{')) {
    return { route: 'get', docId: event.pathParameters?.docId };
  }
  if (routeKey === 'GET /documents') {
    const q = event.queryStringParameters ?? {};
    return { route: 'list', status: q.status, limit: q.limit };
  }
  return { route: 'unknown' };
}

// Curated view. Internal fields (bucket, etag) stay server-side, and a present
// receipt is re-parsed so a stored value that drifted from the schema throws.
function toDto(record: DocumentRecord): Record<string, unknown> {
  const base = {
    docId: record.docId,
    status: record.status,
    key: record.s3Key,
    receivedAt: record.receivedAt,
    updatedAt: record.updatedAt,
    meta: record.meta,
  };
  if (record.receipt) {
    const parsed = ReceiptSchema.parse(record.receipt);
    return { ...base, receipt: parsed };
  }
  return { ...base, failureReason: record.failureReason };
}

function clampLimit(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (Number.isNaN(n)) return DEFAULT_LIMIT;
  return Math.min(Math.max(n, 1), MAX_LIMIT);
}

function error(statusCode: number, message: string): ApiResult {
  return { statusCode, body: { error: message } };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env ${name}`);
  return value;
}
