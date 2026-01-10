/**
 * Alarms, an SNS topic with an email subscription, a monthly budget, and a
 * dashboard for the whole pipeline. Every alarm here has an entry in RUNBOOK.md.
 */
import { Annotations, Duration, Stack } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
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

    // enforceSSL adds a topic policy denying any publish that is not over TLS.
    const topic = new sns.Topic(this, 'AlarmTopic', { displayName: 'docket-alarms', enforceSSL: true });

    // And attaching that policy is what breaks the alarms, so this grant is not
    // optional. A new topic has no resource policy of its own, and SNS falls back
    // to a default that lets the owning account publish. Attach any policy, for
    // any reason, and the default is gone. enforceSSL attaches one. CloudWatch is
    // then a stranger to this topic, so every alarm fires and none of them tell
    // anyone:
    //
    //   Failed to execute action arn:aws:sns:...:AlarmTopic. Received error:
    //   "CloudWatch Alarms is not authorized to perform: SNS:Publish"
    //
    // Which is worse than having no alarm, because the console still shows the
    // alarm going red and you believe the email is on its way. Found by reading
    // the alarm history after a real DLQ incident, not by any test.
    //
    // Scope it to alarms in this account so the topic cannot be used as a confused
    // deputy by another account's alarm.
    const stack = Stack.of(this);
    topic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchAlarmsToPublish',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [topic.topicArn],
        conditions: {
          StringEquals: { 'aws:SourceAccount': stack.account },
          ArnLike: { 'aws:SourceArn': `arn:${stack.partition}:cloudwatch:${stack.region}:${stack.account}:alarm:*` },
        },
      }),
    );

    // No email means alarms with nobody on the other end, which looks exactly
    // like alarms that work. The context key is namespaced, so a plain
    // --context alarmEmail=... is not a typo CDK will complain about, it is a key
    // nothing reads. Say so at synth rather than let the deploy look successful.
    if (props.alarmEmail) {
      topic.addSubscription(new subs.EmailSubscription(props.alarmEmail));
    } else {
      Annotations.of(this).addWarningV2(
        'docket:no-alarm-email',
        'No alarm email. Alarms will fire into a topic with no subscribers. Pass one with --context docket:alarmEmail=you@example.com',
      );
    }
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
    // Receipts the gate accepted whose own lines do not add up to their own
    // subtotal. Decision 5 ships this as a metric to be watched on real paper
    // before it becomes a gate, and a metric nobody can see is not watched.
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Line items not summing to subtotal',
        left: [metric('LineItemsMismatch', 'Sum')],
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
