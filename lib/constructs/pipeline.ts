/**
 * The ingest pipeline: an S3 bucket that fans object-created events through
 * EventBridge into an SQS queue, drained by the ingest Lambda into DynamoDB.
 */
import { Duration, RemovalPolicy, Stack, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime, Architecture, Tracing } from 'aws-cdk-lib/aws-lambda';
import * as path from 'node:path';

const HANDLERS = path.join(__dirname, '..', '..', 'src', 'handlers');

// Default Bedrock model. Overridable per environment, but pinned here so a deploy
// is reproducible instead of tracking whatever "latest" points at.
//
// This is a cross region inference profile, not a bare foundation model id.
// Current Claude models on Bedrock cannot be invoked on demand by their bare id;
// the profile routes each call to whichever US region has capacity. Haiku is the
// cheapest model that reads a receipt well, and it accepts images, which the
// photo path needs.
const MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

// The foundation model the profile fronts, and the regions it may route to.
// Invoking through a profile is authorized against both the profile and the
// underlying model in every region it can land in.
const MODEL_FAMILY = 'anthropic.claude-haiku-4-5-20251001-v1:0';
const PROFILE_REGIONS = ['us-east-1', 'us-east-2', 'us-west-2'];

// The fallback provider reads its key from this SecureString. CDK never sees the
// value, the operator sets it out of band with `aws ssm put-parameter`.
const ANTHROPIC_KEY_PARAM = '/docket/anthropic-api-key';

export class IngestPipeline extends Construct {
  readonly bucket: s3.Bucket;
  readonly queue: sqs.Queue;
  readonly deadLetterQueue: sqs.Queue;
  readonly table: dynamodb.Table;
  readonly ingestFn: NodejsFunction;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // Server access logs for the ingest bucket. Kept in a separate bucket because
    // a bucket cannot log to itself, and expired on the same 30 day clock.
    const accessLogsBucket = new s3.Bucket(this, 'AccessLogsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: Duration.days(30) }],
    });

    this.bucket = new s3.Bucket(this, 'IngestBucket', {
      // EventBridge notifications, not bucket notifications. One bus for every
      // downstream rule and content based key filtering come with it.
      eventBridgeEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: 'ingest/',
      // Demo stack, so it is fine to empty and delete the bucket on teardown.
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: Duration.days(30) }],
    });

    this.table = new dynamodb.Table(this, 'DocumentsTable', {
      partitionKey: { name: 'docId', type: dynamodb.AttributeType.STRING },
      // On-demand billing so an idle stack costs nothing, per the cost ceiling.
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // Backs the list-by-status API route. Sorted by receivedAt so the query can
    // return newest first without a client-side sort.
    this.table.addGlobalSecondaryIndex({
      indexName: 'status-index',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'receivedAt', type: dynamodb.AttributeType.STRING },
    });

    this.deadLetterQueue = new sqs.Queue(this, 'IngestDlq', {
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });

    this.ingestFn = new NodejsFunction(this, 'IngestFn', {
      entry: path.join(HANDLERS, 'ingest.ts'),
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(60),
      memorySize: 512,
      tracing: Tracing.ACTIVE,
      environment: {
        TABLE_NAME: this.table.tableName,
        DOCKET_PROVIDER: 'bedrock',
        MODEL_ID,
        ANTHROPIC_KEY_PARAM,
        POWERTOOLS_SERVICE_NAME: 'ingest',
        LOG_LEVEL: 'INFO',
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node20',
        // The v3 SDK ships in the Node 20 runtime, so bundling it just bloats
        // the artifact. Everything else gets bundled.
        externalModules: ['@aws-sdk/*'],
      },
    });

    // Visibility timeout has to clear the Lambda timeout with headroom or SQS
    // redelivers a message the function is still working on. 60s x 6 = 360s.
    this.queue = new sqs.Queue(this, 'IngestQueue', {
      visibilityTimeout: Duration.seconds(360),
      enforceSSL: true,
      deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount: 3 },
    });

    this.table.grantReadWriteData(this.ingestFn);
    this.bucket.grantRead(this.ingestFn);

    // Primary path: invoke Claude on Bedrock. Named exactly, with no wildcard.
    // The function may call this one model through its inference profile and
    // nothing else, which is as tight as this grant gets.
    this.ingestFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:${Stack.of(this).region}:${Stack.of(this).account}:inference-profile/${MODEL_ID}`,
          ...PROFILE_REGIONS.map((region) => `arn:aws:bedrock:${region}::foundation-model/${MODEL_FAMILY}`),
        ],
      }),
    );

    // Fallback path: read the API key from SSM. One parameter, decrypt included.
    this.ingestFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [`arn:aws:ssm:${Stack.of(this).region}:${Stack.of(this).account}:parameter${ANTHROPIC_KEY_PARAM}`],
      }),
    );

    this.ingestFn.addEventSource(
      new SqsEventSource(this.queue, {
        batchSize: 10,
        reportBatchItemFailures: true,
        // Bound how many documents extract at once so model spend stays capped.
        maxConcurrency: 5,
      }),
    );

    // Only receipt uploads reach the queue: born-digital PDFs and receipt photos.
    // Anything else, a .txt or a stray upload, matches nothing and never fires the
    // pipeline. The handler routes on the same extensions.
    new events.Rule(this, 'ReceiptCreatedRule', {
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: { name: [this.bucket.bucketName] },
          object: {
            key: [{ suffix: '.pdf' }, { suffix: '.jpg' }, { suffix: '.jpeg' }, { suffix: '.png' }, { suffix: '.webp' }],
          },
        },
      },
      targets: [new targets.SqsQueue(this.queue)],
    });

    // Physical names for the runbook and the demo path.
    new CfnOutput(this, 'BucketName', { value: this.bucket.bucketName });
    new CfnOutput(this, 'QueueUrl', { value: this.queue.queueUrl });
    new CfnOutput(this, 'DlqUrl', { value: this.deadLetterQueue.queueUrl });
    new CfnOutput(this, 'TableName', { value: this.table.tableName });
  }
}
