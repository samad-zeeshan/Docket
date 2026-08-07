/**
 * Small model path: a vision model behind an OpenAI compatible endpoint, such as LM Studio on a workstation.
 */
import type { ModelProvider, ModelRequest, ModelResult, TokenLogprob } from './types';
import { RECEIPT_JSON_SCHEMA } from '../receipt-json-schema';

export interface LocalOptions {
  // Off only for the comparison run that measures what the grammar buys.
  constrained?: boolean;
}

export class LocalProvider implements ModelProvider {
  readonly name = 'local';

  constructor(
    private readonly baseUrl: string,
    private readonly modelId: string,
    private readonly options: LocalOptions = {},
  ) {}

  async complete(request: ModelRequest): Promise<ModelResult> {
    const user =
      request.images && request.images.length > 0
        ? [
            ...request.images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mediaType};base64,${i.dataBase64}` } })),
            { type: 'text', text: request.user },
          ]
        : request.user;
    const body: Record<string, unknown> = {
      model: this.modelId,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: user },
      ],
      max_tokens: request.maxTokens ?? 1500,
      temperature: 0,
      // Qwen 3.5 thinks by default and spends the whole token budget doing it.
      // LM Studio honours reasoning_effort, and ignores chat_template_kwargs.
      reasoning_effort: 'none',
      logprobs: true,
    };
    if (this.options.constrained !== false) {
      body.response_format = { type: 'json_schema', json_schema: { name: 'receipt', strict: true, schema: RECEIPT_JSON_SCHEMA } };
    }
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`local model returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const payload = (await res.json()) as {
      choices: { message: { content: string }; logprobs?: { content?: TokenLogprob[] } | null }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = payload.choices[0];
    return {
      text: choice?.message.content ?? '',
      modelId: this.modelId,
      inputTokens: payload.usage?.prompt_tokens ?? 0,
      outputTokens: payload.usage?.completion_tokens ?? 0,
      tokenLogprobs: choice?.logprobs?.content?.map(({ token, logprob }) => ({ token, logprob })),
    };
  }
}
