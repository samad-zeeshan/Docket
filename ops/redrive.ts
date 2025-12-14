#!/usr/bin/env node
/**
 * Move messages out of the ingest dead letter queue back onto the source queue.
 *
 * Uses SQS's native message move task rather than a hand rolled receive and
 * re-send loop: a loop that dies halfway through has already deleted some
 * messages from the DLQ and not yet delivered them anywhere.
 *
 * Redriving is safe to run without thinking, because document ids are content
 * addressed and the first write is a conditional put, so a redelivered event that
 * already succeeded is skipped. See docs/adr/0001-content-addressed-doc-ids.md.
 *
 *   npm run redrive -- --dlq <url> --dry-run     # look, move nothing
 *   npm run redrive -- --dlq <url>               # move them back
 *   npm run redrive -- --dlq <url> --max-velocity 10
 */
import {
  SQSClient,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  StartMessageMoveTaskCommand,
  ListMessageMoveTasksCommand,
} from '@aws-sdk/client-sqs';

export interface QueueState {
  arn: string;
  visible: number;
  inFlight: number;
}

export async function queueState(sqs: SQSClient, dlqUrl: string): Promise<QueueState> {
  const out = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: dlqUrl,
      AttributeNames: ['QueueArn', 'ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  const attrs = out.Attributes ?? {};
  if (!attrs.QueueArn) throw new Error(`could not read QueueArn for ${dlqUrl}`);
  return {
    arn: attrs.QueueArn,
    visible: Number(attrs.ApproximateNumberOfMessages ?? 0),
    inFlight: Number(attrs.ApproximateNumberOfMessagesNotVisible ?? 0),
  };
}

export interface PeekedMessage {
  messageId: string;
  body: string;
}

// Look without consuming. VisibilityTimeout 0 hands the messages straight back,
// so a dry run does not hide anything from the real move that follows.
export async function peek(sqs: SQSClient, dlqUrl: string, limit = 5): Promise<PeekedMessage[]> {
  const out = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: dlqUrl,
      MaxNumberOfMessages: Math.min(limit, 10),
      VisibilityTimeout: 0,
      WaitTimeSeconds: 1,
    }),
  );
  return (out.Messages ?? []).map((m) => ({ messageId: m.MessageId ?? '(no id)', body: m.Body ?? '' }));
}

// With no DestinationArn, SQS moves each message back to the queue it originally
// came from, which is exactly what a redrive means.
export async function startRedrive(sqs: SQSClient, dlqArn: string, maxVelocity?: number): Promise<string> {
  const out = await sqs.send(
    new StartMessageMoveTaskCommand({
      SourceArn: dlqArn,
      ...(maxVelocity ? { MaxNumberOfMessagesPerSecond: maxVelocity } : {}),
    }),
  );
  if (!out.TaskHandle) throw new Error('SQS did not return a task handle for the move');
  return out.TaskHandle;
}

export interface RedriveResult {
  status: string;
  moved: number;
  failureReason?: string;
}

export interface WaitOptions {
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

export async function waitForRedrive(sqs: SQSClient, dlqArn: string, options: WaitOptions = {}): Promise<RedriveResult> {
  const attempts = options.attempts ?? 60;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let i = 0; i < attempts; i++) {
    const out = await sqs.send(new ListMessageMoveTasksCommand({ SourceArn: dlqArn, MaxResults: 1 }));
    const task = out.Results?.[0];
    const status = task?.Status ?? 'UNKNOWN';
    const moved = Number(task?.ApproximateNumberOfMessagesMoved ?? 0);
    if (TERMINAL.has(status)) {
      return { status, moved, ...(task?.FailureReason ? { failureReason: task.FailureReason } : {}) };
    }
    await sleep(2000);
  }
  return { status: 'TIMED_OUT', moved: 0 };
}

function arg(name: string): string | undefined {
  const flag = process.argv.indexOf(`--${name}`);
  if (flag >= 0 && process.argv[flag + 1]) return process.argv[flag + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}

const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const dlqUrl = arg('dlq') ?? process.env.DOCKET_DLQ_URL;
  if (!dlqUrl) {
    console.error('usage: npm run redrive -- --dlq <dlq-url> [--dry-run] [--max-velocity N]');
    console.error('   or: DOCKET_DLQ_URL=<dlq-url> npm run redrive');
    process.exit(2);
  }

  const sqs = new SQSClient({});
  const state = await queueState(sqs, dlqUrl);
  console.log(`\ndlq ${state.arn}`);
  console.log(`  ${state.visible} visible, ${state.inFlight} in flight`);

  if (state.visible === 0) {
    console.log('\nnothing to redrive.');
    return;
  }

  if (hasFlag('dry-run')) {
    const sample = await peek(sqs, dlqUrl);
    console.log(`\ndry run, moving nothing. first ${sample.length} of ${state.visible}:`);
    for (const m of sample) {
      console.log(`  ${m.messageId}  ${m.body.slice(0, 110).replace(/\s+/g, ' ')}`);
    }
    console.log('\nfix the root cause first, then re-run without --dry-run.');
    return;
  }

  const velocity = arg('max-velocity');
  const handle = await startRedrive(sqs, state.arn, velocity ? Number(velocity) : undefined);
  console.log(`\nstarted move task ${handle.slice(0, 24)}...`);

  const result = await waitForRedrive(sqs, state.arn);
  console.log(`  status ${result.status}, moved ${result.moved}`);
  if (result.failureReason) console.log(`  reason ${result.failureReason}`);
  if (result.status !== 'COMPLETED') process.exit(1);
}

// Guarded so the functions above can be imported by tests without running the CLI.
if (require.main === module) void main();
