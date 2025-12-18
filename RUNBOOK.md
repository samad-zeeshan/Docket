# Runbook

What to do when an alarm fires. Every alarm in the stack has an entry here.

Alarms notify the SNS topic `docket-alarms`, which emails whatever address is set
in `cdk.json` under `docket:alarmEmail`.

Start by resolving the resource names. Everything below uses them.

```bash
aws cloudformation describe-stacks --stack-name Docket \
  --query 'Stacks[0].Outputs' --output table

export BUCKET=$(aws cloudformation describe-stacks --stack-name Docket --query "Stacks[0].Outputs[?OutputKey=='BucketName'].OutputValue" --output text)
export QUEUE=$(aws cloudformation describe-stacks --stack-name Docket --query "Stacks[0].Outputs[?OutputKey=='QueueUrl'].OutputValue" --output text)
export DLQ=$(aws cloudformation describe-stacks --stack-name Docket --query "Stacks[0].Outputs[?OutputKey=='DlqUrl'].OutputValue" --output text)
export TABLE=$(aws cloudformation describe-stacks --stack-name Docket --query "Stacks[0].Outputs[?OutputKey=='TableName'].OutputValue" --output text)
```

A helper, since several commands need the function name:

```bash
export FN=$(aws lambda list-functions \
  --query "Functions[?starts_with(FunctionName, 'Docket-IngestIngestFn')].FunctionName | [0]" --output text)
```

## Alarm: DlqNotEmpty

**What it means.** A message failed three times and landed in the dead letter
queue. This is always an infrastructure problem, never bad data. A receipt that
fails the schema check is recorded as `FAILED` and never reaches this queue. So
look at S3 access, the model endpoint, or a recent deploy.

**First three commands.**

```bash
# 1. How many are there, and what does one look like? This does not delete it.
aws sqs get-queue-attributes --queue-url "$DLQ" --attribute-names ApproximateNumberOfMessages
aws sqs receive-message --queue-url "$DLQ" --max-number-of-messages 1 --visibility-timeout 0

# 2. Why is the function throwing? Look for the last ERROR line.
aws logs tail /aws/lambda/$FN --since 1h --filter-pattern ERROR

# 3. Is the model reachable, and has access been granted?
aws bedrock list-foundation-models --by-provider anthropic --query 'modelSummaries[0].modelId'
```

**Fix the cause, then move the messages back.** Once the real problem is sorted
out, for example Bedrock access granted or S3 permissions restored, put the
messages back on the source queue:

```bash
npm run redrive -- --dlq "$DLQ" --dry-run   # shows the depth and a sample, moves nothing
npm run redrive -- --dlq "$DLQ"             # moves them, then waits for it to finish
```

Always dry run first. It prints the queue depth and the first few message bodies,
which is usually enough to confirm you fixed the right thing. Add
`--max-velocity N` to slow the move down if the source queue feeds something
downstream that should not be flooded.

You have recovered when the dead letter queue drains to zero and the reprocessed
documents reach `EXTRACTED`. This is safe to run because document ids come from
content, so an event that already succeeded is skipped rather than done twice.
See [docs/decisions.md](docs/decisions.md).

## Alarm: IngestErrors

**What it means.** The ingest function threw in three five minute windows in a
row. Usually the same root cause as the dead letter queue alarm, caught earlier,
before three retries are used up.

**First three commands.**

```bash
aws logs tail /aws/lambda/$FN --since 30m --filter-pattern ERROR

aws sqs get-queue-attributes --queue-url "$QUEUE" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible

aws cloudwatch get-metric-statistics --namespace AWS/Lambda --metric-name Errors \
  --dimensions Name=FunctionName,Value=$FN \
  --start-time $(date -u -d '1 hour ago' +%FT%TZ) --end-time $(date -u +%FT%TZ) \
  --period 300 --statistics Sum
```

If the error is temporary, such as throttling, the SQS retry usually clears it
and nothing reaches the dead letter queue. If it came from a bad deploy, roll
back. See the last section.

## Alarm: QueueAge

**What it means.** The oldest message has been waiting more than five minutes.
The consumer is either falling behind or stuck.

**First three commands.**

```bash
aws sqs get-queue-attributes --queue-url "$QUEUE" \
  --attribute-names ApproximateAgeOfOldestMessage ApproximateNumberOfMessages

# Is the function being throttled? The concurrency cap is 5 on purpose.
aws cloudwatch get-metric-statistics --namespace AWS/Lambda --metric-name Throttles \
  --dimensions Name=FunctionName,Value=$FN \
  --start-time $(date -u -d '30 minutes ago' +%FT%TZ) --end-time $(date -u +%FT%TZ) \
  --period 300 --statistics Sum

aws logs tail /aws/lambda/$FN --since 15m
```

If this is a real spike in traffic, raise `maxConcurrency` on the SQS event
source in `lib/constructs/pipeline.ts` and deploy. Remember what you are trading.
The queue drains faster and the model bill goes up.

## Budget: 10 dollars a month

**What it means.** Actual spend passed 80 percent of the 10 dollar budget, or the
forecast passed 100 percent. It is almost always model calls.

**First three commands.**

```bash
aws ce get-cost-and-usage \
  --time-period Start=$(date -u +%Y-%m-01),End=$(date -u +%F) \
  --granularity MONTHLY --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE

# Our own token counter, as a stand in for model spend.
aws cloudwatch get-metric-statistics --namespace Docket --metric-name OutputTokens \
  --dimensions Name=service,Value=ingest \
  --start-time $(date -u -d '1 day ago' +%FT%TZ) --end-time $(date -u +%FT%TZ) \
  --period 3600 --statistics Sum

aws dynamodb scan --table-name "$TABLE" --select COUNT
```

If the spend is unexpected, an upload loop is the usual culprit. Check the bucket
for a flood of objects, and confirm that duplicate uploads are being collapsed
rather than extracted again.

## Rolling back a deploy

A `cdk deploy` that fails rolls itself back through CloudFormation. To undo a
deploy that succeeded but shipped a bug, deploy the previous commit:

```bash
git checkout <previous-good-sha>
npm ci
npx cdk deploy Docket --require-approval never
git checkout main
```

The stack is the source of truth, so this puts every resource back to the earlier
template. Nothing is ever edited by hand in the console.
