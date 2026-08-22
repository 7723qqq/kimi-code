import { describe, expect, it, vi, beforeEach } from 'vitest';

import { APIProviderRateLimitError } from '#/kosong/contract/errors';
import type { Message } from '#/kosong/contract/message';
import type { StreamedMessage } from '#/kosong/contract/provider';
import {
  convertGoogleGenAIError,
  GoogleGenAIChatProvider,
  GoogleGenAIStreamedMessage,
} from '#/kosong/provider/bases/google-genai/google-genai';

const FakeAntigravityChatProvider = vi.hoisted(() => {
  class FakeAntigravityChatProvider {
    static readonly instances: Array<{
      options: unknown;
      generateCalls: number;
    }> = [];

    readonly options: unknown;

    constructor(options: unknown) {
      this.options = options;
      FakeAntigravityChatProvider.instances.push({ options, generateCalls: 0 });
    }

    async generate(): Promise<StreamedMessage> {
      const entry =
        FakeAntigravityChatProvider.instances[FakeAntigravityChatProvider.instances.length - 1];
      if (entry !== undefined) {
        entry.generateCalls += 1;
      }
      return (async function* () {})() as unknown as StreamedMessage;
    }
  }
  return FakeAntigravityChatProvider;
});

vi.mock('#/kosong/provider/bases/antigravity/antigravity', () => ({
  AntigravityChatProvider: FakeAntigravityChatProvider,
  detectAntigravityBinary: () => '/usr/local/bin/agy',
}));

async function* chunkStream(chunks: readonly Record<string, unknown>[]) {
  yield* chunks;
}

async function consume(message: GoogleGenAIStreamedMessage): Promise<void> {
  for await (const _part of message) {
    void _part;
  }
}

describe('GoogleGenAIStreamedMessage streaming usage', () => {
  it('keeps the prompt-side usage when the final chunk only reports output', async () => {
    const message = new GoogleGenAIStreamedMessage(
      chunkStream([
        {
          usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 30 },
        },
        {
          candidates: [{ content: { parts: [{ text: 'pong' }] } }],
        },
        {
          usageMetadata: { candidatesTokenCount: 5 },
        },
      ]),
      true,
    );

    await consume(message);

    expect(message.usage).toEqual({
      inputOther: 70,
      output: 5,
      inputCacheRead: 30,
      inputCacheCreation: 0,
    });
  });

  it('only overrides the components a chunk actually reports', async () => {
    const message = new GoogleGenAIStreamedMessage(
      chunkStream([
        {
          usageMetadata: {
            promptTokenCount: 200,
            cachedContentTokenCount: 40,
            candidatesTokenCount: 0,
          },
        },
        { usageMetadata: { candidatesTokenCount: 12 } },
      ]),
      true,
    );

    await consume(message);

    expect(message.usage).toEqual({
      inputOther: 160,
      output: 12,
      inputCacheRead: 40,
      inputCacheCreation: 0,
    });
  });

  it('stays null while no chunk carries usage metadata', async () => {
    const message = new GoogleGenAIStreamedMessage(
      chunkStream([{ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }]),
      true,
    );

    await consume(message);

    expect(message.usage).toBeNull();
  });
});

describe('GoogleGenAIStreamedMessage non-stream usage', () => {
  it('maps the full usage metadata in one pass', async () => {
    const message = new GoogleGenAIStreamedMessage(
      {
        candidates: [{ content: { parts: [{ text: 'pong' }] } }],
        usageMetadata: {
          promptTokenCount: 100,
          cachedContentTokenCount: 30,
          candidatesTokenCount: 5,
        },
      },
      false,
    );

    await consume(message);

    expect(message.usage).toEqual({
      inputOther: 70,
      output: 5,
      inputCacheRead: 30,
      inputCacheCreation: 0,
    });
  });
});

function userMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [] };
}

function fakeModelsClient(): never {
  async function* emptyStream() {}
  return {
    models: {
      generateContentStream: () => Promise.resolve(emptyStream()),
      generateContent: () => Promise.resolve({}),
    },
  } as never;
}

describe('convertGoogleGenAIError', () => {
  it('classifies non-ApiError errors carrying a numeric code by status', () => {
    const error = Object.assign(new Error('quota exceeded'), { code: 429 });
    expect(convertGoogleGenAIError(error)).toBeInstanceOf(APIProviderRateLimitError);
  });

  it('falls back to a generic ChatProviderError when no code is present', () => {
    expect(convertGoogleGenAIError(new Error('mystery failure')).name).toBe('ChatProviderError');
  });
});

describe('GoogleGenAIChatProvider OAuth client construction', () => {
  it('authenticates ya29 tokens via Authorization Bearer and never sends an API key', () => {
    const provider = new GoogleGenAIChatProvider({
      model: 'gemini-2.5-flash',
      apiKey: 'ya29.test-token',
    });

    const client = (provider as any)._client as {
      apiKey: string;
      httpOptions: { headers: Record<string, string> };
    };

    expect(client.httpOptions.headers['Authorization']).toBe('Bearer ya29.test-token');
    expect(client.httpOptions.headers['x-goog-api-key']).toBe('');
    expect(client.apiKey.length).toBeGreaterThan(0);
  });
});

describe('GoogleGenAIChatProvider antigravity fallback', () => {
  const ENV_KEYS = ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] as const;

  beforeEach(() => {
    FakeAntigravityChatProvider.instances.length = 0;
  });

  function withoutCredentialEnv(run: () => Promise<void>): Promise<void> {
    const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
    return run().finally(() => {
      for (const [key, value] of saved) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });
  }

  it('routes credential-less providers to antigravity and reuses one instance across turns', async () => {
    await withoutCredentialEnv(async () => {
      const provider = new GoogleGenAIChatProvider({ model: 'gemini-2.5-flash' });

      await provider.generate('', [], [userMessage('q1')]);
      await provider.generate('', [], [userMessage('q1'), userMessage('q2')]);

      expect(FakeAntigravityChatProvider.instances).toHaveLength(1);
      expect(FakeAntigravityChatProvider.instances[0]!.generateCalls).toBe(2);
      expect(FakeAntigravityChatProvider.instances[0]!.options).toMatchObject({
        model: 'gemini-2.5-flash',
      });
    });
  });

  it('never hijacks OAuth users even when no other credential is configured', async () => {
    await withoutCredentialEnv(async () => {
      const provider = new GoogleGenAIChatProvider({
        model: 'gemini-2.5-flash',
        apiKey: 'ya29.test-token',
        clientFactory: () => fakeModelsClient(),
      });

      await provider.generate('', [], [userMessage('q1')]);

      expect(FakeAntigravityChatProvider.instances).toHaveLength(0);
    });
  });

  it('never hijacks vertexai users', async () => {
    await withoutCredentialEnv(async () => {
      const provider = new GoogleGenAIChatProvider({
        model: 'gemini-2.5-flash',
        vertexai: true,
        project: 'test-project',
        location: 'us-central1',
        clientFactory: () => fakeModelsClient(),
      });

      await provider.generate('', [], [userMessage('q1')]);

      expect(FakeAntigravityChatProvider.instances).toHaveLength(0);
    });
  });
});
