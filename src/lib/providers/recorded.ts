/**
 * Replay provider plus a recording wrapper. Fixtures are keyed by a hash of the
 * exact prompt, so a change to the prompt is a fixture miss, not a stale replay.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import type { ModelProvider, ModelRequest, ModelResult } from './types';

export function fixtureKey(request: ModelRequest): string {
  return createHash('sha256').update(`${request.system}\n----\n${request.user}`).digest('hex').slice(0, 32);
}

export class RecordedProvider implements ModelProvider {
  readonly name = 'recorded';

  constructor(private readonly dir: string) {}

  async complete(request: ModelRequest): Promise<ModelResult> {
    const file = path.join(this.dir, `${fixtureKey(request)}.json`);
    if (!existsSync(file)) {
      // Loud on a miss rather than falling through to a network call. That is
      // what keeps CI deterministic and offline.
      throw new Error(
        `no recorded response at ${file}. Record with DOCKET_PROVIDER=bedrock DOCKET_RECORD=1 npm run eval`,
      );
    }
    return JSON.parse(readFileSync(file, 'utf8')) as ModelResult;
  }
}

export class RecordingProvider implements ModelProvider {
  readonly name: string;

  constructor(
    private readonly inner: ModelProvider,
    private readonly dir: string,
  ) {
    this.name = `recording(${inner.name})`;
  }

  async complete(request: ModelRequest): Promise<ModelResult> {
    const result = await this.inner.complete(request);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(path.join(this.dir, `${fixtureKey(request)}.json`), JSON.stringify(result, null, 2));
    return result;
  }
}
