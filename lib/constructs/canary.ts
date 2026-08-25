/**
 * Synthetic canary: a scheduled Lambda that drops one known receipt into the
 * ingest bucket every 15 minutes and alarms if the pipeline does not store the
 * golden result back. It uploads through the real bucket, so it exercises the
 * same S3 -> EventBridge -> SQS -> Lambda -> DynamoDB path a real upload takes,
 * not a shortcut around it.
 */
import { Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as sns from 'aws-cdk-lib/aws-sns';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime, Architecture } from 'aws-cdk-lib/aws-lambda';
import * as path from 'node:path';
import type { IngestPipeline } from './pipeline';

const HANDLERS = path.join(__dirname, '..', '..', 'src', 'handlers');

// Must match CANARY_KEY in src/handlers/canary.ts. The write grant is scoped to
// this exact object, so the canary can put nothing else in the ingest bucket.
const CANARY_KEY = 'canary/golden-receipt.pdf';

export interface CanaryProps {
  ingest: IngestPipeline;
  alarmTopic: sns.ITopic;
}

export class Canary extends Construct {
  constructor(scope: Construct, id: string, props: CanaryProps) {
    super(scope, id);
    const { ingest, alarmTopic } = props;

    const fn = new NodejsFunction(this, 'CanaryFn', {
      entry: path.join(HANDLERS, 'canary.ts'),
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(60),
      memorySize: 256,
      environment: {
        BUCKET_NAME: ingest.bucket.bucketName,
        TABLE_NAME: ingest.table.tableName,
        POWERTOOLS_SERVICE_NAME: 'canary',
        LOG_LEVEL: 'INFO',
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node20',
        externalModules: ['@aws-sdk/*'],
      },
    });

    // Least privilege, and named exactly so there is no wildcard to suppress:
    // write the one canary object, and read one item back by primary key. The
    // canary reads by docId, never through the status GSI, so no index grant.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: [ingest.bucket.arnForObjects(CANARY_KEY)],
      }),
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem'],
        resources: [ingest.table.tableArn],
      }),
    );

    // Every 15 minutes. No async retry, so a failing tick is one datapoint, not
    // three retries that each re-prime the model on a table that is down.
    new events.Rule(this, 'Schedule', {
      schedule: events.Schedule.rate(Duration.minutes(15)),
      targets: [new targets.LambdaFunction(fn, { retryAttempts: 0 })],
    });

    // 1 = pass, 0 = fail, emitted once per run. Minimum over the window catches a
    // single 0. Missing data breaches too: a canary that has stopped reporting is
    // itself a failure, indistinguishable to a reader from a passing one.
    const pass = new cloudwatch.Metric({
      namespace: 'Docket',
      metricName: 'CanaryPass',
      dimensionsMap: { service: 'canary' },
      statistic: 'Minimum',
      period: Duration.minutes(15),
    });
    new cloudwatch.Alarm(this, 'CanaryFailing', {
      metric: pass,
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      alarmDescription:
        'Synthetic canary failed or stopped reporting: the pipeline did not store the golden receipt. See the README, section When an alarm fires.',
    }).addAlarmAction(new SnsAction(alarmTopic));
  }
}
