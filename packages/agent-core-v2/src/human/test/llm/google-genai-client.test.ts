import { beforeEach, describe, expect, it, mock } from 'bun:test';

import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import { createUserMessage } from '#/llm/message';

const constructor = mock();

void mock.module('@google/genai', () => ({
  ApiError: class extends Error {},
  GoogleGenAI: class {
    readonly models = {
      generateContentStream: async () => [],
    };

    constructor(options: unknown) {
      constructor(options);
    }
  },
}));

const { createGoogleGenAIRequester } = await import('#/llm/requester/bases/google-genai/requester');

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
