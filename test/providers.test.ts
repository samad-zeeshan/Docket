import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { RecordedProvider, RecordingProvider, fixtureKey } from '../src/lib/providers/recorded';
import type { ModelProvider, ModelResult } from '../src/lib/providers/types';

const req = { system: 'sys', user: 'usr' };

class StubProvider implements ModelProvider {
  readonly name = 'stub';
  async complete(): Promise<ModelResult> {
    return { text: '{"ok":true}', modelId: 'stub', inputTokens: 1, outputTokens: 2 };
  }
}

describe('RecordedProvider', () => {
  it('replays a recorded fixture', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'docket-fix-'));
    const result: ModelResult = { text: 'X', modelId: 'm', inputTokens: 3, outputTokens: 4 };
    writeFileSync(path.join(dir, `${fixtureKey(req)}.json`), JSON.stringify(result));
    expect(await new RecordedProvider(dir).complete(req)).toEqual(result);
  });

  it('throws a clear error on a miss instead of calling out', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'docket-fix-'));
    await expect(new RecordedProvider(dir).complete(req)).rejects.toThrow('no recorded response');
  });
});

describe('RecordingProvider', () => {
  it('writes a fixture the recorded provider can replay', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'docket-rec-'));
    const written = await new RecordingProvider(new StubProvider(), dir).complete(req);
    expect(await new RecordedProvider(dir).complete(req)).toEqual(written);
  });
});
