/**
 * Persistence port for document records plus its DynamoDB implementation.
 *
 * The port exists so handlers run against an in-memory fake in tests instead of
 * a real table, which is what keeps the unit suite free and deterministic.
 */
import { DynamoDBClient, ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { DocumentRecord } from './model';

export interface DocumentStore {
  putReceived(record: DocumentRecord): Promise<'created' | 'duplicate'>;
  get(docId: string): Promise<DocumentRecord | undefined>;
}

export class DynamoDocumentStore implements DocumentStore {
  private readonly client: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    client?: DynamoDBDocumentClient,
  ) {
    this.client = client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
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
}
