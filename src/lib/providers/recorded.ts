/**
 * Replay provider plus a recording wrapper. Fixtures are keyed by a hash of the
 * exact prompt, so a change to the prompt is a fixture miss, not a stale replay.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import type { ModelProvider, ModelRequest, ModelResult } from './types';

function sha(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function fixtureKey(request: ModelRequest): string {
  // Fold images into the key so a photo request records and replays correctly.
  // With no images this is byte-identical to the old text-only key, so existing
  // text fixtures still match.
  const imagePart =
    request.images && request.images.length > 0
      ? `\n----images----\n${request.images.map((i) => `${i.mediaType}:${sha(i.dataBase64)}`).join(',')}`
      : '';
  return sha(`${request.system}\n----\n${request.user}${imagePart}`).slice(0, 32);
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
