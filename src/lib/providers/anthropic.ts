/**
 * Fallback provider: the direct Anthropic API. Exists so a slow Bedrock access
 * ticket never blocks the pipeline. The key comes from SSM in AWS, never a
 * long-lived env secret baked into the function.
 */
import Anthropic from '@anthropic-ai/sdk';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { ModelProvider, ModelRequest, ModelResult } from './types';

let cachedKey: string | undefined;

// Prefer a local env key (used by the eval on a laptop). In Lambda there is no
// env key, so read the SecureString parameter once and cache it for the life of
// the container.
async function resolveApiKey(): Promise<string> {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  if (cachedKey) return cachedKey;
  const name = process.env.ANTHROPIC_KEY_PARAM;
  if (!name) throw new Error('no ANTHROPIC_API_KEY and no ANTHROPIC_KEY_PARAM set');
  const out = await new SSMClient({}).send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const value = out.Parameter?.Value;
  if (!value) throw new Error(`SSM parameter ${name} is empty`);
  cachedKey = value;
  return value;
}

export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic';

  constructor(private readonly modelId: string) {}

  async complete(request: ModelRequest): Promise<ModelResult> {
    const client = new Anthropic({ apiKey: await resolveApiKey(), maxRetries: 3 });
    const message = await client.messages.create({
      model: this.modelId,
      max_tokens: request.maxTokens ?? 1024,
      system: request.system,
      messages: [{ role: 'user', content: request.user }],
    });

    const block = message.content[0];
    return {
      text: block && block.type === 'text' ? block.text : '',
      modelId: this.modelId,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    };
  }
}
