/**
 * Primary provider: Anthropic Claude on Amazon Bedrock in us-east-1.
 */
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import type { ModelProvider, ModelRequest, ModelResult } from './types';
import { userContent } from './content';

// Bedrock pins the Anthropic wire version separately from the model id.
const ANTHROPIC_VERSION = 'bedrock-2023-05-31';

export class BedrockProvider implements ModelProvider {
  readonly name = 'bedrock';
  private readonly client: BedrockRuntimeClient;

  constructor(
    private readonly modelId: string,
    client?: BedrockRuntimeClient,
  ) {
    // The SDK retries throttling and 5xx on its own. Three attempts is enough to
    // ride out a blip without holding an SQS message past its visibility window.
    this.client = client ?? new BedrockRuntimeClient({ maxAttempts: 3 });
  }

  async complete(request: ModelRequest): Promise<ModelResult> {
    const body = {
      anthropic_version: ANTHROPIC_VERSION,
      max_tokens: request.maxTokens ?? 1024,
      system: request.system,
      messages: [{ role: 'user', content: userContent(request) }],
    };

    const out = await this.client.send(
      new InvokeModelCommand({
        modelId: this.modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(body),
      }),
    );

    const payload = JSON.parse(new TextDecoder().decode(out.body));
    return {
      text: firstText(payload.content),
      modelId: this.modelId,
      inputTokens: payload.usage?.input_tokens ?? 0,
      outputTokens: payload.usage?.output_tokens ?? 0,
    };
  }
}

// A reply does not always lead with its text. A model with thinking turned on
// puts a thinking block first, and reading index 0 would then hand the schema
// gate an empty string. Take the first text block instead.
export function firstText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  for (const block of content as { type?: string; text?: string }[]) {
    if (block?.type === 'text' && typeof block.text === 'string') return block.text;
  }
  return '';
}
