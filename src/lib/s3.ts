/**
 * Fetch an object's bytes from S3. A failure here is infrastructure, not bad
 * data, so it throws and the message goes back to SQS for retry.
 */
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

export async function getObjectBytes(client: S3Client, bucket: string, key: string): Promise<Buffer> {
  const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!out.Body) throw new Error(`empty body for s3://${bucket}/${key}`);
  return Buffer.from(await out.Body.transformToByteArray());
}
