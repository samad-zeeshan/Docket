/**
 * A stack output with the name you asked for.
 *
 * A CfnOutput declared inside a construct has the construct path and a hash
 * folded into its logical id, and the logical id is what becomes the output key.
 * `new CfnOutput(this, 'BucketName')` inside the Ingest construct therefore ends
 * up as `IngestBucketName4EFEBE9C`, which nothing looking the name up can find.
 *
 * The runbook, the deploy notes, and any operator reading these by name all
 * depend on stable keys, so pin the logical id to the name.
 */
import { CfnOutput } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

export function stackOutput(scope: Construct, name: string, value: string): void {
  new CfnOutput(scope, name, { value }).overrideLogicalId(name);
}
