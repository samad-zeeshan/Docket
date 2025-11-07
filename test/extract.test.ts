import { describe, it, expect } from 'vitest';
import { extractReceipt } from '../src/lib/extract';
import { ScriptedProvider, validReceiptJson } from './helpers';

const brokenJson = '{ not json';
const wrongShape = JSON.stringify({ merchant: 'X' }); // missing total, date, currency

describe('extractReceipt', () => {
  it('extracts on the first valid response and sums tokens', async () => {
    const provider = new ScriptedProvider([validReceiptJson]);
    const outcome = await extractReceipt(provider, 'text');
    expect(outcome.status).toBe('EXTRACTED');
    expect(provider.calls.length).toBe(1);
    expect(outcome.inputTokens).toBe(10);
    expect(outcome.outputTokens).toBe(20);
  });

  it('strips a ```json fence the model added anyway', async () => {
    const provider = new ScriptedProvider(['```json\n' + validReceiptJson + '\n```']);
    const outcome = await extractReceipt(provider, 'text');
    expect(outcome.status).toBe('EXTRACTED');
  });

  it('repairs once and succeeds, counting both calls', async () => {
    const provider = new ScriptedProvider([wrongShape, validReceiptJson]);
    const outcome = await extractReceipt(provider, 'text');
    expect(outcome.status).toBe('EXTRACTED');
    expect(provider.calls.length).toBe(2);
    expect(outcome.outputTokens).toBe(40);
    // The repair prompt must carry the validation errors back to the model.
    expect(provider.calls[1]!.user).toContain('did not pass validation');
  });

  it('marks FAILED with a reason after the repair also fails', async () => {
    const provider = new ScriptedProvider([brokenJson, wrongShape]);
    const outcome = await extractReceipt(provider, 'text');
    expect(outcome.status).toBe('FAILED');
    expect(provider.calls.length).toBe(2);
    if (outcome.status === 'FAILED') expect(outcome.failureReason).toBeTruthy();
  });
});
