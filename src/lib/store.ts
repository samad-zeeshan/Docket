/**
 * Persistence port for document records plus its DynamoDB implementation.
 *
 * The port exists so handlers run against an in-memory fake in tests instead of
 * a real table, which is what keeps the unit suite free and deterministic.
 */
import { DynamoDBClient, ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { DocumentRecord, DocumentStatus, ExtractionMetadata } from './model';
import type { Receipt } from './schema';

export const STATUS_INDEX = 'status-index';

export interface DocumentStore {
  putReceived(record: DocumentRecord): Promise<'created' | 'duplicate'>;
  get(docId: string): Promise<DocumentRecord | undefined>;
  markExtracted(docId: string, receipt: Receipt, meta: ExtractionMetadata): Promise<void>;
  markFailed(docId: string, reason: string, meta?: ExtractionMetadata): Promise<void>;
  listByStatus(status: DocumentStatus, limit: number): Promise<DocumentRecord[]>;
}

export class DynamoDocumentStore implements DocumentStore {
  private readonly client: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    client?: DynamoDBDocumentClient,
  ) {
    // removeUndefinedValues so optional fields (subtotal, tax) that came back
    // undefined do not blow up the marshaller.
    this.client =
      client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
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

  async markExtracted(docId: string, receipt: Receipt, meta: ExtractionMetadata): Promise<void> {
    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { docId },
        UpdateExpression:
          'SET #s = :s, receipt = :r, meta = :m, updatedAt = :u REMOVE failureReason',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':s': 'EXTRACTED',
          ':r': receipt,
          ':m': meta,
          ':u': new Date().toISOString(),
        },
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
