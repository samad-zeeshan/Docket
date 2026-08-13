/**
 * Persistence port for document records plus its DynamoDB implementation.
 *
 * The port exists so handlers run against an in-memory fake in tests instead of
 * a real table, which is what keeps the unit suite free and deterministic.
 */
import { DynamoDBClient, ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { DocumentRecord, DocumentStatus, ExtractionMetadata, StoredRoute } from './model';
import type { ConfidenceField } from './confidence';
import type { Receipt } from './schema';

export const STATUS_INDEX = 'status-index';

// One place for the marshaller options so a caller can pass a tracer-wrapped base
// client without re-specifying them. removeUndefinedValues lets optional fields
// (subtotal, tax) be absent instead of blowing up the marshaller.
export function documentClient(base?: DynamoDBClient): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(base ?? new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
}

export interface ReviewInfo {
  route: StoredRoute;
  confidence: Partial<Record<ConfidenceField, number>>;
  needsReview: boolean;
  reason: string;
}

export interface DocumentStore {
  putReceived(record: DocumentRecord): Promise<'created' | 'duplicate'>;
  get(docId: string): Promise<DocumentRecord | undefined>;
  markExtracted(docId: string, receipt: Receipt, meta: ExtractionMetadata, review?: ReviewInfo): Promise<void>;
  markFailed(docId: string, reason: string, meta?: ExtractionMetadata): Promise<void>;
  listByStatus(status: DocumentStatus, limit: number): Promise<DocumentRecord[]>;
}

export class DynamoDocumentStore implements DocumentStore {
  private readonly client: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    client?: DynamoDBDocumentClient,
    private readonly reviewTableName?: string,
  ) {
    this.client = client ?? documentClient();
  }

  async putReceived(record: DocumentRecord): Promise<'created' | 'duplicate'> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: record,
          // Redelivery derives the same docId, so this conditional put makes the
          // second write a no-op instead of clobbering a later status.
          ConditionExpression: 'attribute_not_exists(docId)',
        }),
      );
      return 'created';
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return 'duplicate';
      throw err;
    }
  }

  async get(docId: string): Promise<DocumentRecord | undefined> {
    const out = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { docId } }));
    return out.Item as DocumentRecord | undefined;
  }

  async listByStatus(status: DocumentStatus, limit: number): Promise<DocumentRecord[]> {
    const out = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: STATUS_INDEX,
        KeyConditionExpression: '#s = :s',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':s': status },
        Limit: limit,
        // Newest first. The GSI sort key is receivedAt.
        ScanIndexForward: false,
      }),
    );
    return (out.Items ?? []) as DocumentRecord[];
  }

  async markExtracted(docId: string, receipt: Receipt, meta: ExtractionMetadata, review?: ReviewInfo): Promise<void> {
    const now = new Date().toISOString();
    const status = review?.needsReview ? 'NEEDS_REVIEW' : 'EXTRACTED';
    const update = {
      TableName: this.tableName,
      Key: { docId },
      UpdateExpression: review
        ? 'SET #s = :s, receipt = :r, meta = :m, updatedAt = :u, #route = :route, confidence = :c, reviewReason = :why REMOVE failureReason'
        : 'SET #s = :s, receipt = :r, meta = :m, updatedAt = :u REMOVE failureReason',
      ExpressionAttributeNames: (review ? { '#s': 'status', '#route': 'route' } : { '#s': 'status' }) as Record<string, string>,
      ExpressionAttributeValues: {
        ':s': status,
        ':r': receipt,
        ':m': meta,
        ':u': now,
        ...(review ? { ':route': review.route, ':c': review.confidence, ':why': review.reason } : {}),
      },
    };
    if (!review?.needsReview || !this.reviewTableName) {
      await this.client.send(new UpdateCommand(update));
      return;
    }
    // One transaction, so a receipt is never marked NEEDS_REVIEW without a queue
    // item for someone to pick up, or queued while its record still says RECEIVED.
    await this.client.send(
      new TransactWriteCommand({
        TransactItems: [
          { Update: update },
          { Put: { TableName: this.reviewTableName, Item: { docId, queuedAt: now, reason: review.reason, route: review.route } } },
        ],
      }),
    );
  }

  async markFailed(docId: string, reason: string, meta?: ExtractionMetadata): Promise<void> {
    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { docId },
        UpdateExpression: 'SET #s = :s, failureReason = :f, meta = :m, updatedAt = :u',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':s': 'FAILED',
          ':f': reason,
          ':m': meta ?? null,
          ':u': new Date().toISOString(),
        },
      }),
    );
  }
}
