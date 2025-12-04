import { describe, it, expect } from 'vitest';
import { BedrockProvider } from '../src/lib/providers/bedrock';
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
