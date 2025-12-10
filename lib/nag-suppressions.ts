/**
 * Every cdk-nag finding we accept on purpose, with the reason we accept it.
 *
 * Suppressions are granular: each one names the exact finding via `appliesTo`,
 * so a new wildcard or a new managed policy added later still fails the synth.
 * A blanket rule suppression would silently swallow the next mistake.
 */
import type { Stack } from 'aws-cdk-lib';
import { NagSuppressions } from 'cdk-nag';

const LAMBDA_BASIC_EXEC = 'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole';

// X-Ray's write actions carry no resource-level permissions, so the only policy
// AWS accepts is a wildcard resource. This is the documented shape.
const XRAY_WILDCARD = {
  id: 'AwsSolutions-IAM5',
  reason:
    'X-Ray PutTraceSegments and PutTelemetryRecords do not support resource-level permissions, so AWS requires Resource: *. Scope is limited to those two actions.',
  appliesTo: ['Resource::*'],
};

const managedPolicy = (fn: string) => ({
  id: 'AwsSolutions-IAM4',
  reason: `AWSLambdaBasicExecutionRole is the CDK default for ${fn}. It grants only CloudWatch Logs create and put on the function's own log group.`,
  appliesTo: [LAMBDA_BASIC_EXEC],
});

const pinnedRuntime = (fn: string) => ({
  id: 'AwsSolutions-L1',
  reason: `${fn} pins Node 20 on purpose so a deploy is reproducible rather than tracking whatever "latest" points at. Bumping the runtime is a deliberate, tested change.`,
});

export function applyNagSuppressions(docket: Stack, cicd: Stack): void {
  // The access log bucket cannot log to itself.
  NagSuppressions.addResourceSuppressionsByPath(docket, '/Docket/Ingest/AccessLogsBucket/Resource', [
    {
      id: 'AwsSolutions-S1',
      reason: 'This is the server access log bucket for the ingest bucket. Pointing it at itself would create a logging loop.',
    },
  ]);

  NagSuppressions.addResourceSuppressionsByPath(docket, '/Docket/Ingest/IngestFn/Resource', [pinnedRuntime('The ingest function')]);
  NagSuppressions.addResourceSuppressionsByPath(docket, '/Docket/Api/QueryFn/Resource', [pinnedRuntime('The query function')]);

  NagSuppressions.addResourceSuppressionsByPath(docket, '/Docket/Ingest/IngestFn/ServiceRole/Resource', [
    managedPolicy('the ingest function'),
  ]);
  NagSuppressions.addResourceSuppressionsByPath(docket, '/Docket/Api/QueryFn/ServiceRole/Resource', [
    managedPolicy('the query function'),
  ]);
  NagSuppressions.addResourceSuppressionsByPath(
    docket,
    '/Docket/BucketNotificationsHandler050a0587b7544547bf325f094a3db834/Role/Resource',
    [managedPolicy('the CDK-owned bucket notifications handler')],
  );

  // The ingest function's policy. Every wildcard here is either required by the
  // service or is itself the scoping mechanism.
  NagSuppressions.addResourceSuppressionsByPath(docket, '/Docket/Ingest/IngestFn/ServiceRole/DefaultPolicy/Resource', [
    XRAY_WILDCARD,
    {
      id: 'AwsSolutions-IAM5',
      reason:
        'grantRead on the ingest bucket. Reading an uploaded object requires an object-level wildcard because the key is chosen by the uploader, and the List and GetBucket actions are how the SDK resolves the object.',
      appliesTo: [
        'Action::s3:GetBucket*',
        'Action::s3:GetObject*',
        'Action::s3:List*',
        'Resource::<IngestIngestBucketFAE28AA6.Arn>/*',
      ],
    },
    {
      id: 'AwsSolutions-IAM5',
      reason: 'grantReadWriteData must cover the table and its GSIs. An index ARN is a child of the table ARN, so the wildcard is the index set, not an extra table.',
      appliesTo: ['Resource::<IngestDocumentsTable9B06F738.Arn>/index/*'],
    },
    {
      id: 'AwsSolutions-IAM5',
      reason:
        'The wildcard IS the scoping. bedrock:InvokeModel is restricted to the anthropic model family in one region, rather than the bedrock:* on every model that the default grant would give.',
      appliesTo: ['Resource::arn:aws:bedrock:us-east-1::foundation-model/anthropic.*'],
    },
  ]);

  NagSuppressions.addResourceSuppressionsByPath(docket, '/Docket/Api/QueryFn/ServiceRole/DefaultPolicy/Resource', [
    XRAY_WILDCARD,
    {
      id: 'AwsSolutions-IAM5',
      reason: 'grantReadData must cover the status-index GSI, whose ARN is a child of the table ARN. The query route reads through that index.',
      appliesTo: ['Resource::<IngestDocumentsTable9B06F738.Arn>/index/*'],
    },
  ]);

  // The deploy role assumes the CDK bootstrap roles, whose names carry a
  // generated qualifier, so they cannot be named exactly at synth time.
  NagSuppressions.addResourceSuppressionsByPath(cicd, '/DocketCicd/DeployRole/DefaultPolicy/Resource', [
    {
      id: 'AwsSolutions-IAM5',
      reason:
        'The GitHub deploy role must assume the CDK bootstrap roles (cdk-<qualifier>-deploy-role, -file-publishing-role, and so on). Their names include a bootstrap qualifier that is not known at synth time, so the prefix is the tightest possible scope.',
      appliesTo: ['Resource::arn:aws:iam::<AWS::AccountId>:role/cdk-*'],
    },
  ]);
}
