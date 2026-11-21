import { beforeEach, describe, expect, it, mock } from 'bun:test';

import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import type { LlmRequestEvent } from '#/llm/requester/requester';
import { createUserMessage, type AssistantMessage, type Message } from '@moonshot-ai/core/llm/message';

const constructor = mock();

let streamHandler: (params: unknown) => AsyncIterable<Record<string, unknown>> = async function* () {};

void mock.module('@google/genai', () => ({
  ApiError: class extends Error {},
  GoogleGenAI: class {
    readonly models = {
      generateContentStream: async (params: unknown) => streamHandler(params),
    };

    constructor(options: unknown) {
      constructor(options);
    }
  },
}));

const { createGoogleGenAIRequester } = await import('#/llm/requester/bases/google-genai/requester');

let captured: Record<string, unknown>[] = [];

type StreamResponse = readonly Record<string, unknown>[];

function chunksOf(responses: readonly StreamResponse[]): void {
  captured = [];
  let index = 0;
  streamHandler = (params) => {
    captured.push(params as Record<string, unknown>);
    const chunks = responses[index++] ?? [];
    return (async function* () {
      yield* chunks;
    })();
  };
}

function capturedContents(): readonly (Record<string, unknown>[] | undefined)[] {
  return captured.map((params) => params['contents'] as Record<string, unknown>[] | undefined);
}

async function constructClient(baseUrl: string, vertexai?: boolean): Promise<void> {
  const requester = createGoogleGenAIRequester({ vertexai });
  await requester.generate(
    {
      model: {
        provider: 'test',
        model: 'gemini-2.5-flash',
        baseUrl,
        apiKey: 'key',
        capability: UNKNOWN_CAPABILITY,
      },
    },
    { messages: [createUserMessage('hi')] },
    { signal: new AbortController().signal },
  );
}

describe('google-genai client base URL', () => {
  beforeEach(() => {
    constructor.mockClear();
  });

  it.each([
    ['https://gateway.example.test/v1beta', 'https://gateway.example.test/'],
    ['https://gateway.example.test/v1beta/', 'https://gateway.example.test/'],
    ['https://gateway.example.test/proxy/v1beta', 'https://gateway.example.test/proxy'],
    ['https://gateway.example.test', 'https://gateway.example.test'],
  ])('strips a trailing Gemini version from %s', async (baseUrl, expected) => {
    await constructClient(baseUrl);

    expect(constructor).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'key',
        httpOptions: { baseUrl: expected },
      }),
    );
  });

  it('strips the Vertex version instead of the Gemini version', async () => {
    await constructClient('https://gateway.example.test/v1beta1', true);

    expect(constructor).toHaveBeenCalledWith(
      expect.objectContaining({
        vertexai: true,
        httpOptions: { baseUrl: 'https://gateway.example.test/' },
      }),
    );
  });

  it('leaves an invalid base URL for the SDK to reject', async () => {
    await constructClient('not a url');

    expect(constructor).toHaveBeenCalledWith(
      expect.objectContaining({
        httpOptions: { baseUrl: 'not a url' },
      }),
    );
  });
});

describe('google-genai conversation replay', () => {
  beforeEach(() => {
    constructor.mockClear();
  });

  async function generate(
    modelName: string,
    messages: readonly Message[],
  ): Promise<LlmRequestEvent[]> {
    const events: LlmRequestEvent[] = [];
    const requester = createGoogleGenAIRequester();
    await requester.generate(
      { model: { provider: 'google', model: modelName, capability: UNKNOWN_CAPABILITY } },
      { messages: [...messages] },
      { signal: new AbortController().signal, onEvent: (event) => events.push(event) },
    );
    return events;
  }

  function partsOf(events: readonly LlmRequestEvent[]) {
    return events.flatMap((event) => (event.type === 'llm.streaming.part' ? [event.part] : []));
  }

  it('replays text signatures and matching native tool ids across two requests', async () => {
    chunksOf([
      [
        {
          candidates: [
            {
              content: {
                parts: [
                  { text: 'ORCHID', thoughtSignature: 'sig-text-1' },
                  { text: '-426', thoughtSignature: 'sig-text-2' },
                  { text: '', thoughtSignature: 'sig-text-end' },
                  {
                    functionCall: { id: 'call_weather', name: 'get_weather', args: { city: 'sf' } },
                    thoughtSignature: 'sig-tool',
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        },
      ],
    ]);

    const first = await generate('gemini-4-example', [
      { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
    ]);
    const parts = partsOf(first);
    expect(parts.filter((part) => part.type === 'text')).toEqual([
      { type: 'text', text: 'ORCHID', meta: { thought_signature_b64: 'sig-text-1' } },
      { type: 'text', text: '-426', meta: { thought_signature_b64: 'sig-text-2' } },
      { type: 'text', text: '', meta: { thought_signature_b64: 'sig-text-end' } },
    ]);
    const toolCalls = parts.filter((part) => part.type === 'function');
    const call = toolCalls[0];
    expect(call.rawId).toBe('call_weather');
    expect(call.id).not.toBe(call.rawId);

    const assistant: AssistantMessage = {
      role: 'assistant',
      content: parts.filter((part) => part.type === 'text'),
      toolCalls: toolCalls.map((part) => ({
        type: 'function',
        id: part.id,
        rawId: part.rawId,
        name: part.name,
        arguments: part.arguments ?? '{}',
        extras: part.extras,
      })),
    };
    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
      assistant,
      {
        role: 'tool',
        toolCallId: call.id,
        content: [
          { type: 'text', text: 'sunny' },
          { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'thanks' }] },
    ];

    chunksOf([[{ candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }] }]]);
    await generate('gemini-4-example', history);

    expect(capturedContents()[0]).toEqual([
      { role: 'user', parts: [{ text: 'weather?' }] },
      {
        role: 'model',
        parts: [
          { text: 'ORCHID', thoughtSignature: 'sig-text-1' },
          { text: '-426', thoughtSignature: 'sig-text-2' },
          { text: '', thoughtSignature: 'sig-text-end' },
          {
            functionCall: { id: 'call_weather', name: 'get_weather', args: { city: 'sf' } },
            thoughtSignature: 'sig-tool',
          },
        ],
      },
      {
        role: 'user',
        parts: [
          { text: 'thanks' },
          {
            functionResponse: {
              id: 'call_weather',
              name: 'get_weather',
              response: { output: 'sunny' },
              parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }],
            },
          },
        ],
      },
    ]);
  });

  it('keeps the legacy media placement and unsigned call ids for gemini-2.5', async () => {
    chunksOf([[{ candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }] }]]);
    await generate('gemini-2.5-flash', [
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ type: 'function', id: 'local_call', name: 'get_weather', arguments: '{}' }],
      },
      {
        role: 'tool',
        toolCallId: 'local_call',
        content: [
          { type: 'text', text: 'sunny' },
          { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ]);

    const contents = capturedContents()[0];
    expect(contents?.[0]).toEqual({
      role: 'model',
      parts: [{ functionCall: { id: undefined, name: 'get_weather', args: {} } }],
    });
    expect(contents?.[1]).toEqual({
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: undefined,
            name: 'get_weather',
            response: { output: 'sunny' },
            parts: undefined,
          },
        },
        { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
      ],
    });
  });

  it('nests only function-response media types for gemini-3 and keeps the rest outside', async () => {
    chunksOf([[{ candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }] }]]);
    await generate('gemini-3-pro-preview', [
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ type: 'function', id: 'local_call', name: 'read_media', arguments: '{}' }],
      },
      {
        role: 'tool',
        toolCallId: 'local_call',
        content: [
          { type: 'text', text: 'loaded' },
          { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
          { type: 'image_url', imageUrl: { url: 'data:image/gif;base64,BBBB' } },
          { type: 'audio_url', audioUrl: { url: 'data:audio/wav;base64,CCCC' } },
          { type: 'image_url', imageUrl: { url: 'https://example.com/a.webp' } },
        ],
      },
    ]);

    expect(capturedContents()[0]?.[1]).toEqual({
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: undefined,
            name: 'read_media',
            response: { output: 'loaded' },
            parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }],
          },
        },
        { inlineData: { mimeType: 'image/gif', data: 'BBBB' } },
        { inlineData: { mimeType: 'audio/wav', data: 'CCCC' } },
        { fileData: { fileUri: 'https://example.com/a.webp', mimeType: 'image/webp' } },
      ],
    });
  });
});
