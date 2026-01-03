import { describe, it, expect } from 'vitest';
import { BedrockProvider, firstText } from '../src/lib/providers/bedrock';
import { createProvider } from '../src/lib/providers';
import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';

// Minimal fake that records the request body and returns a canned Bedrock reply.
function fakeClient(capture: { body?: string }): BedrockRuntimeClient {
  return {
    send: async (cmd: { input: { body: string } }) => {
      capture.body = cmd.input.body;
      return {
        body: new TextEncoder().encode(
          JSON.stringify({ content: [{ type: 'text', text: '{"ok":1}' }], usage: { input_tokens: 5, output_tokens: 6 } }),
        ),
      };
    },
  } as unknown as BedrockRuntimeClient;
}

describe('BedrockProvider', () => {
  it('sends a plain string user message on the text path and parses usage', async () => {
    const cap: { body?: string } = {};
    const provider = new BedrockProvider('m', fakeClient(cap));
    const res = await provider.complete({ system: 'sys', user: 'hello' });
    const body = JSON.parse(cap.body!);
    expect(body.messages[0].content).toBe('hello');
    expect(res).toEqual({ text: '{"ok":1}', modelId: 'm', inputTokens: 5, outputTokens: 6 });
  });

  it('leads with image blocks then the text on the vision path', async () => {
    const cap: { body?: string } = {};
    const provider = new BedrockProvider('m', fakeClient(cap));
    await provider.complete({ system: 'sys', user: 'read it', images: [{ mediaType: 'image/png', dataBase64: 'ZZ' }] });
    const content = JSON.parse(cap.body!).messages[0].content;
    expect(content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ZZ' } });
    expect(content[1]).toEqual({ type: 'text', text: 'read it' });
  });
});

describe('createProvider', () => {
  // The Lambda hands in an X-Ray wrapped client. If the factory quietly builds
  // its own instead, the model call disappears from the trace and nobody notices
  // until they are staring at a second of unexplained latency.
  it('uses the bedrock client it is given rather than making its own', async () => {
    const cap: { body?: string } = {};
    const provider = createProvider({ DOCKET_PROVIDER: 'bedrock' } as NodeJS.ProcessEnv, {
      bedrockClient: fakeClient(cap),
    });
    await provider.complete({ system: 'sys', user: 'hello' });
    expect(cap.body).toBeDefined();
    expect(JSON.parse(cap.body!).messages[0].content).toBe('hello');
  });
});

describe('firstText', () => {
  // A model with thinking on answers with a thinking block first. Reading index
  // zero would hand the schema gate an empty string and fail every extraction.
  it('skips a leading thinking block', () => {
    expect(firstText([{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: '{"ok":1}' }])).toBe('{"ok":1}');
  });

  it('reads a plain single text block', () => {
    expect(firstText([{ type: 'text', text: 'hello' }])).toBe('hello');
  });

  it('returns empty when there is no text block at all', () => {
    expect(firstText([{ type: 'thinking', thinking: 'hmm' }])).toBe('');
    expect(firstText(undefined)).toBe('');
    expect(firstText([])).toBe('');
  });
});
