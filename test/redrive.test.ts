import { describe, it, expect } from 'vitest';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { queueState, peek, startRedrive, waitForRedrive } from '../ops/redrive';

interface Command {
  constructor: { name: string };
  input: Record<string, unknown>;
}

// Records every command and answers from a name-keyed script, so a test can
// assert both what we asked SQS and how we read the answer.
class FakeSqs {
  readonly sent: Command[] = [];
  private calls = 0;

  constructor(private readonly script: Record<string, unknown | ((n: number) => unknown)>) {}

  async send(command: Command): Promise<unknown> {
    this.sent.push(command);
    const entry = this.script[command.constructor.name];
    if (typeof entry === 'function') return entry(this.calls++);
    return entry ?? {};
  }

  as(): SQSClient {
    return this as unknown as SQSClient;
  }

  named(name: string): Command | undefined {
    return this.sent.find((c) => c.constructor.name === name);
  }
}

const noSleep = async (): Promise<void> => undefined;

describe('queueState', () => {
  it('reads the arn and both depths', async () => {
    const sqs = new FakeSqs({
      GetQueueAttributesCommand: {
        Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:1:dlq', ApproximateNumberOfMessages: '7', ApproximateNumberOfMessagesNotVisible: '2' },
      },
    });
    expect(await queueState(sqs.as(), 'url')).toEqual({ arn: 'arn:aws:sqs:us-east-1:1:dlq', visible: 7, inFlight: 2 });
  });

  it('throws when the queue has no arn, rather than moving nothing quietly', async () => {
    const sqs = new FakeSqs({ GetQueueAttributesCommand: { Attributes: {} } });
    await expect(queueState(sqs.as(), 'url')).rejects.toThrow('could not read QueueArn');
  });
});

describe('peek', () => {
  it('leaves messages visible so a dry run hides nothing', async () => {
    const sqs = new FakeSqs({ ReceiveMessageCommand: { Messages: [{ MessageId: 'm1', Body: 'hello' }] } });
    const out = await peek(sqs.as(), 'url');
    expect(out).toEqual([{ messageId: 'm1', body: 'hello' }]);
    expect(sqs.named('ReceiveMessageCommand')!.input.VisibilityTimeout).toBe(0);
  });
});

describe('startRedrive', () => {
  it('moves messages back to their source queue and returns the task handle', async () => {
    const sqs = new FakeSqs({ StartMessageMoveTaskCommand: { TaskHandle: 'handle-1' } });
    expect(await startRedrive(sqs.as(), 'arn:dlq')).toBe('handle-1');
    const input = sqs.named('StartMessageMoveTaskCommand')!.input;
    expect(input.SourceArn).toBe('arn:dlq');
    // No DestinationArn: SQS returns each message to where it came from.
    expect(input.DestinationArn).toBeUndefined();
    expect(input.MaxNumberOfMessagesPerSecond).toBeUndefined();
  });

  it('passes a velocity cap through when one is given', async () => {
    const sqs = new FakeSqs({ StartMessageMoveTaskCommand: { TaskHandle: 'h' } });
    await startRedrive(sqs.as(), 'arn:dlq', 10);
    expect(sqs.named('StartMessageMoveTaskCommand')!.input.MaxNumberOfMessagesPerSecond).toBe(10);
  });

  it('throws when SQS returns no task handle', async () => {
    const sqs = new FakeSqs({ StartMessageMoveTaskCommand: {} });
    await expect(startRedrive(sqs.as(), 'arn:dlq')).rejects.toThrow('did not return a task handle');
  });
});

describe('waitForRedrive', () => {
  it('polls until the task completes and reports how many moved', async () => {
    const sqs = new FakeSqs({
      ListMessageMoveTasksCommand: (n: number) =>
        n === 0
          ? { Results: [{ Status: 'RUNNING', ApproximateNumberOfMessagesMoved: 1 }] }
          : { Results: [{ Status: 'COMPLETED', ApproximateNumberOfMessagesMoved: 3 }] },
    });
    expect(await waitForRedrive(sqs.as(), 'arn:dlq', { sleep: noSleep })).toEqual({ status: 'COMPLETED', moved: 3 });
  });

  it('surfaces the failure reason instead of reporting success', async () => {
    const sqs = new FakeSqs({
      ListMessageMoveTasksCommand: { Results: [{ Status: 'FAILED', ApproximateNumberOfMessagesMoved: 0, FailureReason: 'AccessDenied' }] },
    });
    expect(await waitForRedrive(sqs.as(), 'arn:dlq', { sleep: noSleep })).toEqual({
      status: 'FAILED',
      moved: 0,
      failureReason: 'AccessDenied',
    });
  });

  it('gives up rather than polling forever', async () => {
    const sqs = new FakeSqs({ ListMessageMoveTasksCommand: { Results: [{ Status: 'RUNNING' }] } });
    const result = await waitForRedrive(sqs.as(), 'arn:dlq', { attempts: 3, sleep: noSleep });
    expect(result.status).toBe('TIMED_OUT');
    expect(sqs.sent.filter((c) => c.constructor.name === 'ListMessageMoveTasksCommand')).toHaveLength(3);
  });
});
