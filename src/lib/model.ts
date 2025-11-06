/**
 * The DynamoDB item shape for one document as it moves through the pipeline.
 * The extraction fields are absent until the extractor runs.
 */
import type { Receipt } from './schema';

export type DocumentStatus = 'RECEIVED' | 'EXTRACTED' | 'FAILED';

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
}
