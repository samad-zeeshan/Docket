/**
 * The DynamoDB item shape for one document as it moves through the pipeline.
 * The extraction fields are absent until the extractor runs.
 */
import type { Receipt } from './schema';
import type { ConfidenceField } from './confidence';

// NEEDS_REVIEW passed the schema gate like EXTRACTED. The difference is only that
// a person should look before anyone relies on it.
export type DocumentStatus = 'RECEIVED' | 'EXTRACTED' | 'NEEDS_REVIEW' | 'FAILED';

export type StoredRoute = 'small' | 'large' | 'small-escalated';

export interface ExtractionMetadata {
  modelId: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface DocumentRecord {
  docId: string;
  status: DocumentStatus;
  s3Bucket: string;
  s3Key: string;
  etag: string;
  receivedAt: string;
  updatedAt?: string;
  receipt?: Receipt;
  failureReason?: string;
  meta?: ExtractionMetadata;
  route?: StoredRoute;
  confidence?: Partial<Record<ConfidenceField, number>>;
  reviewReason?: string;
}
