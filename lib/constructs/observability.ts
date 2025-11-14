/**
 * Alarms, an SNS topic with an email subscription, a monthly budget, and a
 * dashboard for the whole pipeline. Every alarm here has an entry in RUNBOOK.md.
 */
import { Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import type { IngestPipeline } from './pipeline';
import type { QueryApi } from './api';

export interface ObservabilityProps {
  ingest: IngestPipeline;
  api: QueryApi;
  alarmEmail?: string;
}

const NAMESPACE = 'Docket';
const INGEST_DIMS = { service: 'ingest' };

export class Observability extends Construct {
  constructor(scope: Construct, id: string, props: ObservabilityProps) {
    super(scope, id);
    const { ingest, api } = props;

    const topic = new sns.Topic(this, 'AlarmTopic', { displayName: 'docket-alarms' });
    if (props.alarmEmail) topic.addSubscription(new subs.EmailSubscription(props.alarmEmail));
    const notify = new SnsAction(topic);

    // DLQ depth > 0. A poison message is never routine, so alarm on the first one.
    const dlqDepth = ingest.deadLetterQueue.metricApproximateNumberOfMessagesVisible({
      period: Duration.minutes(1),
      statistic: 'Maximum',
    });
    new cloudwatch.Alarm(this, 'DlqNotEmpty', {
      metric: dlqDepth,
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'A message reached the ingest DLQ.',
    }).addAlarmAction(notify);

    // Sustained errors: at least one in each of three 5-minute windows, so a
    // single blip that SQS already retried does not page anyone.
    const ingestErrors = ingest.ingestFn.metricErrors({ period: Duration.minutes(5), statistic: 'Sum' });
    new cloudwatch.Alarm(this, 'IngestErrors', {
      metric: ingestErrors,
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Ingest Lambda erroring across three windows.',
    }).addAlarmAction(notify);

    // Backlog aging past 5 minutes means the consumer is not keeping up.
    const queueAge = ingest.queue.metricApproximateAgeOfOldestMessage({
      period: Duration.minutes(1),
      statistic: 'Maximum',
    });
    new cloudwatch.Alarm(this, 'QueueAge', {
      metric: queueAge,
      threshold: Duration.minutes(5).toSeconds(),
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Ingest queue oldest message aging past 5 minutes.',
    }).addAlarmAction(notify);

    // $10/month ceiling. Budgets emails subscribers directly, so no SNS topic
    // policy is needed for this one.
    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: { budgetType: 'COST', timeUnit: 'MONTHLY', budgetLimit: { amount: 10, unit: 'USD' } },
      notificationsWithSubscribers: props.alarmEmail
        ? [
            {
              notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 80 },
              subscribers: [{ subscriptionType: 'EMAIL', address: props.alarmEmail }],
            },
            {
              notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 100 },
              subscribers: [{ subscriptionType: 'EMAIL', address: props.alarmEmail }],
            },
          ]
        : undefined,
    });

    this.buildDashboard(ingest, api, { dlqDepth, ingestErrors, queueAge });
  }

  private buildDashboard(
    ingest: IngestPipeline,
    api: QueryApi,
    infra: { dlqDepth: cloudwatch.IMetric; ingestErrors: cloudwatch.IMetric; queueAge: cloudwatch.IMetric },
  ): void {
    const metric = (metricName: string, statistic: string) =>
      new cloudwatch.Metric({
        namespace: NAMESPACE,
        metricName,
        dimensionsMap: INGEST_DIMS,
        statistic,
        period: Duration.minutes(5),
      });

    const succeeded = metric('ExtractionSucceeded', 'Sum');
    const failed = metric('ExtractionFailed', 'Sum');
    const successRate = new cloudwatch.MathExpression({
      expression: '100 * s / (s + f)',
      usingMetrics: { s: succeeded, f: failed },
      label: 'Extraction success rate %',
      period: Duration.minutes(5),
    });

    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', { dashboardName: 'docket-pipeline' });
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Queue depth and age',
        left: [ingest.queue.metricApproximateNumberOfMessagesVisible(), infra.queueAge],
        right: [infra.dlqDepth],
      }),
      new cloudwatch.GraphWidget({
        title: 'Ingest errors and duration',
        left: [infra.ingestErrors],
        right: [ingest.ingestFn.metricDuration({ statistic: 'p95' })],
      }),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({ title: 'Extraction outcomes', left: [succeeded, failed] }),
      new cloudwatch.SingleValueWidget({ title: 'Success rate', metrics: [successRate] }),
      new cloudwatch.GraphWidget({ title: 'Extraction p95 latency (ms)', left: [metric('ExtractionLatency', 'p95')] }),
      new cloudwatch.GraphWidget({
        title: 'Token spend proxy',
        left: [metric('InputTokens', 'Sum'), metric('OutputTokens', 'Sum')],
      }),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Query API',
        left: [api.queryFn.metricInvocations(), api.queryFn.metricErrors()],
        right: [api.queryFn.metricDuration({ statistic: 'p95' })],
      }),
    );
  }
}
