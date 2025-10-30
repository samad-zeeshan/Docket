/**
 * The ingest pipeline: an S3 bucket that fans object-created events through
 * EventBridge into an SQS queue, drained by the ingest Lambda into DynamoDB.
 */
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime, Architecture } from 'aws-cdk-lib/aws-lambda';
import * as path from 'node:path';

const HANDLERS = path.join(__dirname, '..', '..', 'src', 'handlers');

export class IngestPipeline extends Construct {
  readonly bucket: s3.Bucket;
  readonly queue: sqs.Queue;
  readonly deadLetterQueue: sqs.Queue;
  readonly table: dynamodb.Table;
  readonly ingestFn: NodejsFunction;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, 'IngestBucket', {
      // EventBridge notifications, not bucket notifications. One bus for every
      // downstream rule and content based key filtering come with it.
      eventBridgeEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
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
      environment: { TABLE_NAME: this.table.tableName },
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

    this.ingestFn.addEventSource(
      new SqsEventSource(this.queue, {
        batchSize: 10,
        reportBatchItemFailures: true,
        // Bound how many documents extract at once so model spend stays capped.
        maxConcurrency: 5,
      }),
    );

    // Only .pdf object-created events reach the queue. A .txt upload matches
    // nothing here and never fires the pipeline.
    new events.Rule(this, 'PdfCreatedRule', {
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: { name: [this.bucket.bucketName] },
          object: { key: [{ suffix: '.pdf' }] },
        },
      },
      targets: [new targets.SqsQueue(this.queue)],
    });
  }
}
