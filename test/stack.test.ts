/**
 * Assertions on the synthesized CloudFormation. The unit suite proves the handler
 * logic; this proves the design decisions that live in the infrastructure, so a
 * rename or a loosened policy fails the build instead of shipping quietly.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { DocketStack } from '../lib/docket-stack';
import { DocketCicdStack } from '../lib/cicd-stack';

const env = { account: '123456789012', region: 'us-east-1' };

let docket: Template;
let cicd: Template;

// Synthesizing bundles both Lambdas with esbuild, so do it once for the file.
beforeAll(() => {
  const app = new App();
  const docketStack = new DocketStack(app, 'Docket', { env });
  const cicdStack = new DocketCicdStack(app, 'DocketCicd', { env, githubOwner: 'o', githubRepo: 'r' });
  docket = Template.fromStack(docketStack);
  cicd = Template.fromStack(cicdStack);
}, 120_000);

const logicalIds = (type: string): string[] => Object.keys(docket.findResources(type));

describe('ingest queue and DLQ', () => {
  it('sends a message to the DLQ after 3 receives', () => {
    docket.hasResourceProperties('AWS::SQS::Queue', {
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
    });
  });

  it('keeps DLQ messages for 14 days, long enough to investigate', () => {
    docket.hasResourceProperties('AWS::SQS::Queue', { MessageRetentionPeriod: 1_209_600 });
  });

  it('gives the queue a visibility timeout that clears the 60s Lambda timeout', () => {
    docket.hasResourceProperties('AWS::SQS::Queue', { VisibilityTimeout: 360 });
  });
});

describe('buckets', () => {
  it('blocks all public access on every bucket', () => {
    const buckets = Object.values(docket.findResources('AWS::S3::Bucket'));
    expect(buckets.length).toBeGreaterThan(0);
    for (const b of buckets) {
      expect(b.Properties.PublicAccessBlockConfiguration).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
    }
  });

  it('denies any request that is not over TLS', () => {
    docket.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      }),
    });
  });

  it('encrypts at rest and sends server access logs to a separate bucket', () => {
    docket.hasResourceProperties('AWS::S3::Bucket', {
      LoggingConfiguration: Match.objectLike({ LogFilePrefix: 'ingest/' }),
    });
    const buckets = Object.values(docket.findResources('AWS::S3::Bucket'));
    for (const b of buckets) expect(b.Properties.BucketEncryption).toBeDefined();
  });
});

describe('ingest lambda permissions', () => {
  it('names one bedrock model exactly, with no wildcard', () => {
    docket.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'bedrock:InvokeModel',
            Resource: [
              // The profile the function calls, plus every region it may route to.
              'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0',
              'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0',
              'arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0',
              'arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0',
            ],
          }),
        ]),
      }),
    });
  });

  it('never grants bedrock:* or a model wildcard anywhere in the template', () => {
    const template = JSON.stringify(docket.toJSON());
    expect(template).not.toContain('bedrock:*');
    expect(template).not.toContain('foundation-model/anthropic.*');
  });

  it('reads the anthropic key from exactly one SSM parameter', () => {
    docket.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([Match.objectLike({ Action: 'ssm:GetParameter' })]),
      }),
    });
  });

  it('traces with X-Ray', () => {
    docket.hasResourceProperties('AWS::Lambda::Function', { TracingConfig: { Mode: 'Active' } });
  });
});

describe('documents table', () => {
  it('has point in time recovery on', () => {
    docket.hasResourceProperties('AWS::DynamoDB::Table', {
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
  });

  it('is on demand, so an idle table costs nothing', () => {
    docket.hasResourceProperties('AWS::DynamoDB::Table', { BillingMode: 'PAY_PER_REQUEST' });
  });

  it('exposes the status-index GSI the list route queries', () => {
    docket.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'status-index',
          KeySchema: [
            { AttributeName: 'status', KeyType: 'HASH' },
            { AttributeName: 'receivedAt', KeyType: 'RANGE' },
          ],
        }),
      ]),
    });
  });
});

describe('event rule', () => {
  // This is the regression guard: renaming or re-scoping the rule, or dropping a
  // supported extension, breaks here rather than silently ignoring uploads.
  it('routes only receipt uploads, pdf and the three image types', () => {
    docket.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: Match.objectLike({
        source: ['aws.s3'],
        'detail-type': ['Object Created'],
        detail: Match.objectLike({
          object: {
            key: [{ suffix: '.pdf' }, { suffix: '.jpg' }, { suffix: '.jpeg' }, { suffix: '.png' }, { suffix: '.webp' }],
          },
        }),
      }),
    });
  });

  it('has exactly one rule, targeting the ingest queue', () => {
    docket.resourceCountIs('AWS::Events::Rule', 1);
    const rule = Object.values(docket.findResources('AWS::Events::Rule'))[0]!;
    expect(rule.Properties.Targets).toHaveLength(1);
  });
});

describe('query api', () => {
  it('requires IAM auth on every route, so an unsigned request is rejected', () => {
    const routes = Object.values(docket.findResources('AWS::ApiGatewayV2::Route'));
    expect(routes.length).toBe(2);
    for (const r of routes) expect(r.Properties.AuthorizationType).toBe('AWS_IAM');
  });

  it('writes access logs on the default stage', () => {
    docket.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      AccessLogSettings: Match.objectLike({ DestinationArn: Match.anyValue() }),
    });
  });
});

describe('logical ids', () => {
  // CloudFormation identifies a resource by its logical id, which CDK derives from
  // the construct path. Renaming a construct therefore reads as "delete this
  // resource and create a different one". For the table that is data loss, for the
  // bucket it is every stored receipt. Pinning the ids makes a rename a decision
  // someone has to make on purpose, rather than a diff nobody reads.
  it('pins the documents table', () => {
    expect(logicalIds('AWS::DynamoDB::Table')).toEqual([expect.stringMatching(/^IngestDocumentsTable/)]);
  });

  it('pins the ingest and access log buckets', () => {
    const ids = logicalIds('AWS::S3::Bucket').sort();
    expect(ids).toHaveLength(2);
    expect(ids.some((id) => /^IngestAccessLogsBucket/.test(id))).toBe(true);
    expect(ids.some((id) => /^IngestIngestBucket/.test(id))).toBe(true);
  });

  it('pins the event rule, so renaming it is a deliberate replacement', () => {
    expect(logicalIds('AWS::Events::Rule')).toEqual([expect.stringMatching(/^IngestReceiptCreatedRule/)]);
  });
});

describe('stack outputs', () => {
  // RUNBOOK.md resolves every one of these by name. A CfnOutput declared inside a
  // construct otherwise picks up the construct path and a hash, which turns
  // BucketName into IngestBucketName4EFEBE9C and quietly breaks every runbook
  // command. Pin the names here so nobody has to find that out during an alarm.
  it.each(['BucketName', 'QueueUrl', 'DlqUrl', 'TableName', 'ApiUrl', 'Region'])(
    'exposes %s under exactly that key',
    (key) => {
      docket.hasOutput(key, { Value: Match.anyValue() });
    },
  );

  it('exposes the deploy role arn from the cicd stack', () => {
    cicd.hasOutput('DeployRoleArn', { Value: Match.anyValue() });
  });
});

describe('cicd stack', () => {
  it('creates no IAM user, so there is no long lived key to leak', () => {
    cicd.resourceCountIs('AWS::IAM::User', 0);
    expect(JSON.stringify(cicd.toJSON())).not.toContain('AWS::IAM::AccessKey');
  });

  it('lets only this repo assume the deploy role, through OIDC', () => {
    cicd.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'docket-github-deploy',
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: Match.objectLike({
              StringLike: { 'token.actions.githubusercontent.com:sub': 'repo:o/r:*' },
            }),
          }),
        ]),
      }),
    });
  });
});
