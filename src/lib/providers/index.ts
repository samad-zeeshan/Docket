/**
 * Provider factory. Chooses an implementation from the environment so the same
 * extraction code runs against Bedrock in Lambda and the recorded provider in CI.
 */
import type { ModelProvider } from './types';
import { BedrockProvider } from './bedrock';
import { AnthropicProvider } from './anthropic';
import { RecordedProvider, RecordingProvider } from './recorded';

export * from './types';
export { BedrockProvider, AnthropicProvider, RecordedProvider, RecordingProvider };

const DEFAULT_BEDROCK_MODEL = 'anthropic.claude-3-5-sonnet-20241022-v2:0';
const DEFAULT_ANTHROPIC_MODEL = 'claude-3-5-sonnet-20241022';

export function createProvider(env: NodeJS.ProcessEnv = process.env): ModelProvider {
  const fixtures = env.DOCKET_FIXTURES ?? 'eval/fixtures';
  const kind = env.DOCKET_PROVIDER ?? 'bedrock';
  switch (kind) {
    case 'bedrock': {
      const provider = new BedrockProvider(env.MODEL_ID ?? DEFAULT_BEDROCK_MODEL);
      return env.DOCKET_RECORD === '1' ? new RecordingProvider(provider, fixtures) : provider;
    }
    case 'anthropic': {
      const provider = new AnthropicProvider(env.MODEL_ID ?? DEFAULT_ANTHROPIC_MODEL);
      return env.DOCKET_RECORD === '1' ? new RecordingProvider(provider, fixtures) : provider;
    }
    case 'recorded':
      return new RecordedProvider(fixtures);
    default:
      throw new Error(`unknown DOCKET_PROVIDER ${kind}`);
  }
}
