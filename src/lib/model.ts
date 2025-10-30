/**
 * The DynamoDB item shape for one document as it moves through the pipeline.
 */

export type DocumentStatus = 'RECEIVED' | 'EXTRACTED' | 'FAILED';

export interface DocumentRecord {
  docId: string;
  status: DocumentStatus;
  s3Bucket: string;
  s3Key: string;
  etag: string;
  receivedAt: string;
}
