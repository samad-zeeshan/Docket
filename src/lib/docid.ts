/**
 * Derive a stable document id from where an object lives and what it contains.
 */
import { createHash } from 'node:crypto';

// The etag is the content fingerprint, so folding it in means re-uploading the
// same bytes to the same key is a true no-op, while new bytes under that key
// become a new document. That is exactly the idempotency the pipeline wants.
export function deriveDocId(bucket: string, key: string, etag: string): string {
  const normalizedEtag = etag.replace(/"/g, '');
  return createHash('sha256').update(`${bucket}/${key}:${normalizedEtag}`).digest('hex');
}
