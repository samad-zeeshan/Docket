import { describe, it, expect, vi, afterEach } from 'vitest';
import { LocalProvider } from '../src/lib/providers/local';
import { RECEIPT_JSON_SCHEMA } from '../src/lib/receipt-json-schema';

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const ok = {
  choices: [
    {
      message: { content: '{"total":5}' },
      logprobs: { content: [{ token: '{"', logprob: -0.1 }, { token: 'total', logprob: -0.2 }] },
    },
  ],
  usage: { prompt_tokens: 100, completion_tokens: 12 },
};

afterEach(() => vi.restoreAllMocks());

describe('LocalProvider', () => {
  it('asks for schema constrained output, no thinking, greedy decoding and logprobs', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(ok));
    await new LocalProvider('http://localhost:1234', 'qwen/qwen3.5-9b').complete({ system: 's', user: 'u' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:1234/v1/chat/completions');
    const body = JSON.parse(String(init!.body));
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'receipt', strict: true, schema: RECEIPT_JSON_SCHEMA } });
    expect(body.reasoning_effort).toBe('none');
    expect(body.temperature).toBe(0);
    expect(body.logprobs).toBe(true);
  });

  it('can run unconstrained, for the comparison that shows what the grammar buys', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(ok));
    await new LocalProvider('http://localhost:1234', 'm', { constrained: false }).complete({ system: 's', user: 'u' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)).response_format).toBeUndefined();
  });

  it('sends an image as a data url ahead of the text', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(ok));
    await new LocalProvider('http://h', 'm').complete({ system: 's', user: 'read it', images: [{ mediaType: 'image/jpeg', dataBase64: 'QUJD' }] });
    const content = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)).messages[1].content;
    expect(content[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } });
    expect(content[1]).toEqual({ type: 'text', text: 'read it' });
  });

  it('returns the text, token counts and per token logprobs', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(ok));
    const out = await new LocalProvider('http://h', 'm').complete({ system: 's', user: 'u' });
    expect(out).toMatchObject({ text: '{"total":5}', modelId: 'm', inputTokens: 100, outputTokens: 12 });
    expect(out.tokenLogprobs).toEqual([{ token: '{"', logprob: -0.1 }, { token: 'total', logprob: -0.2 }]);
  });

  it('throws on an HTTP error so the caller treats it as infrastructure, not bad data', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply({ error: 'boom' }, 500));
    await expect(new LocalProvider('http://h', 'm').complete({ system: 's', user: 'u' })).rejects.toThrow('500');
  });
});
