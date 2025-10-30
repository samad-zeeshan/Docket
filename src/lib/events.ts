/**
 * Pull the S3 object coordinates out of an EventBridge "Object Created" event.
 */
import { z } from 'zod';

const S3ObjectCreated = z.object({
  detail: z.object({
    bucket: z.object({ name: z.string() }),
    object: z.object({
      key: z.string(),
      etag: z.string(),
      size: z.number().optional(),
    }),
  }),
});

export interface S3Object {
  bucket: string;
  key: string;
  etag: string;
  size?: number;
}

// EventBridge delivers the raw object key. This is the one behavior difference
// from the legacy S3 notification, which URL encodes the key, so there is no
// decode step here.
export function parseS3Event(body: string): S3Object {
  const event = S3ObjectCreated.parse(JSON.parse(body));
  const { bucket, object } = event.detail;
  return { bucket: bucket.name, key: object.key, etag: object.etag, size: object.size };
}
