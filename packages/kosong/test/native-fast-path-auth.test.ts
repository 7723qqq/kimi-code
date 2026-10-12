import { describe, expect, it, vi } from 'vitest';

import type { Message } from '#/message';
import { AnthropicChatProvider } from '#/providers/anthropic';
import { OpenAILegacyChatProvider } from '#/providers/openai-legacy';

/**
 * The Rust native fast-path must authenticate with the SAME credential the SDK
 * path would use: the per-request `auth` when the caller supplied one, the
 * constructor key otherwise. Getting this wrong bills the wrong account and
 * silently drops per-request headers, and only shows up when the native addon
 * happens to be loadable.
 */
const captured: Record<string, unknown>[] = [];

/** Stand-in stream so the provider stops at the native branch. */
function stubStream(): Record<string, unknown> {
  return {
    id: 'native-stub',
    usage: null,
    finishReason: null,
    rawFinishReason: null,
    async *[Symbol.asyncIterator]() {},
  };
}

vi.mock('../src/providers/native-stream', async () => {
  const actual = await vi.importActual<typeof import('../src/providers/native-stream')>(
    '../src/providers/native-stream',
  );
  return {
    ...actual,
    tryNativeLlmStream: (config: Record<string, unknown>) => {
      captured.push(config);
      return stubStream();
    },
    tryNativeLlmStreamIncremental: (config: Record<string, unknown>) => {
      captured.push(config);
      return stubStream();
    },
  };
});

const history: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
];

function lastConfig(): Record<string, unknown> {
  const config = captured.at(-1);
  if (config === undefined) throw new Error('native path was not reached');
  return config;
}

describe('native fast-path credentials', () => {
  it('anthropic uses the per-request key and headers over the constructor ones', async () => {
    captured.length = 0;
    const provider = new AnthropicChatProvider({
      model: 'claude-sonnet-4-5',
      apiKey: 'ctor-key',
      defaultMaxTokens: 1024,
      stream: true,
    });

    await provider.generate('', [], history, {
      auth: { apiKey: 'per-request-key', headers: { 'x-extra': '1' } },
    });

    expect(lastConfig()['apiKey']).toBe('per-request-key');
    expect(lastConfig()['extraHeaders']).toEqual(
      expect.arrayContaining([{ key: 'x-extra', value: '1' }]),
    );
  });

  it('anthropic falls back to the constructor key when no auth is passed', async () => {
    captured.length = 0;
    const provider = new AnthropicChatProvider({
      model: 'claude-sonnet-4-5',
      apiKey: 'ctor-key',
      defaultMaxTokens: 1024,
      stream: true,
    });

    await provider.generate('', [], history);

    expect(lastConfig()['apiKey']).toBe('ctor-key');
  });

  it('openai-legacy uses the per-request key and headers', async () => {
    captured.length = 0;
    const provider = new OpenAILegacyChatProvider({
      model: 'gpt-4.1',
      apiKey: 'ctor-key',
      stream: true,
      defaultHeaders: { 'x-default': 'a' },
    });

    await provider.generate('', [], history, {
      auth: { apiKey: 'per-request-key', headers: { 'x-extra': '1' } },
    });

    expect(lastConfig()['apiKey']).toBe('per-request-key');
    expect(lastConfig()['extraHeaders']).toEqual(
      expect.arrayContaining([
        { key: 'x-default', value: 'a' },
        { key: 'x-extra', value: '1' },
      ]),
    );
  });
});
