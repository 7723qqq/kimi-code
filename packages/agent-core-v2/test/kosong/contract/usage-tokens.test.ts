import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isNativeToolsLoaded, tryNativeEstimateTokensBatch } from '#/_base/native-tools';
import type { Message } from '#/kosong/contract/message';
import {
  estimateTokens,
  estimateTokensForContentPart,
  estimateTokensForMessage,
  estimateTokensForMessages,
  estimateTokensForTools,
  MEDIA_TOKEN_ESTIMATE,
} from '#/kosong/contract/tokens';
import { addUsage, emptyUsage, grandTotal, inputTotal } from '#/kosong/contract/usage';

const { batchSpy } = vi.hoisted(() => ({
  batchSpy: vi.fn<(texts: readonly string[]) => number | undefined>(),
}));

vi.mock('#/_base/native-tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/_base/native-tools')>();
  batchSpy.mockImplementation(actual.tryNativeEstimateTokensBatch);
  return {
    ...actual,
    tryNativeEstimateTokensBatch: batchSpy,
  };
});

describe('TokenUsage aggregation', () => {
  it('emptyUsage is all zeros', () => {
    expect(emptyUsage()).toEqual({
      inputOther: 0,
      output: 0,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
  });

  it('addUsage sums every counter', () => {
    const a = { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 };
    const b = { inputOther: 10, output: 20, inputCacheRead: 30, inputCacheCreation: 40 };
    expect(addUsage(a, b)).toEqual({
      inputOther: 11,
      output: 22,
      inputCacheRead: 33,
      inputCacheCreation: 44,
    });
  });

  it('inputTotal sums all input counters, grandTotal adds output', () => {
    const usage = { inputOther: 5, output: 7, inputCacheRead: 11, inputCacheCreation: 13 };
    expect(inputTotal(usage)).toBe(29);
    expect(grandTotal(usage)).toBe(36);
  });
});

describe('estimateTokens', () => {
  it('estimates ASCII at four characters per token', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('estimates non-ASCII at one token per character', () => {
    expect(estimateTokens('你好')).toBe(2);
    expect(estimateTokens('ab你')).toBe(2);
  });
});

describe('estimateTokensForMessage(s)', () => {
  it('counts role, content, and tool calls', () => {
    const message: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'abcd' }],
      toolCalls: [{ type: 'function', id: 'c1', name: 'tool', arguments: '{}' }],
    };
    const expected =
      estimateTokens('assistant') +
      estimateTokens('abcd') +
      estimateTokens('tool') +
      estimateTokens('"{}"');
    expect(estimateTokensForMessage(message)).toBe(expected);
  });

  it('sums messages and memoizes per message object', () => {
    const message: Message = {
      role: 'user',
      content: [{ type: 'text', text: 'hello world' }],
      toolCalls: [],
    };
    const first = estimateTokensForMessage(message);
    message.content.push({ type: 'text', text: 'mutated after the fact' });
    expect(estimateTokensForMessage(message)).toBe(first);
    expect(estimateTokensForMessages([message, message])).toBe(first * 2);
  });

  it('counts media parts with the flat media estimate', () => {
    expect(
      estimateTokensForContentPart({
        type: 'image_url',
        imageUrl: { url: 'data:image/png;base64,AAAA' },
      }),
    ).toBe(MEDIA_TOKEN_ESTIMATE);
    expect(
      estimateTokensForContentPart({
        type: 'video_url',
        videoUrl: { url: 'data:video/mp4;base64,AAAA' },
      }),
    ).toBe(MEDIA_TOKEN_ESTIMATE);
    expect(estimateTokensForContentPart({ type: 'think', think: 'abcd' })).toBe(1);
  });

  it('memoizes per message across repeated estimateTokensForMessages calls', () => {
    const messages = mixedMessages();
    const first = estimateTokensForMessages(messages);
    const second = estimateTokensForMessages(messages);
    expect(second).toBe(first);
    messages[0]!.content.push({ type: 'text', text: 'mutated after the fact' });
    messages[1]!.toolCalls.push({
      type: 'function',
      id: 'c2',
      name: 'mutated_call',
      arguments: '{}',
    });
    expect(estimateTokensForMessages(messages)).toBe(first);
  });

  it('never routes messages through native batch estimation', () => {
    batchSpy.mockClear();
    estimateTokensForMessages(mixedMessages());
    expect(batchSpy).not.toHaveBeenCalled();
  });
});

describe('estimateTokensForTools', () => {
  beforeEach(() => {
    batchSpy.mockClear();
  });

  it('counts name, description, and serialized parameters', () => {
    const tool = { name: 'read', description: 'Read a file', parameters: { type: 'object' } };
    const expected =
      estimateTokens(tool.name) +
      estimateTokens(tool.description) +
      estimateTokens(JSON.stringify(tool.parameters));
    expect(estimateTokensForTools([tool])).toBe(expected);
  });

  it('prefers the native batch path when available and falls back when not', () => {
    const tools = [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }];
    const expected =
      estimateTokens(tools[0]!.name) +
      estimateTokens(tools[0]!.description) +
      estimateTokens(JSON.stringify(tools[0]!.parameters));
    batchSpy.mockReturnValueOnce(4242);
    expect(estimateTokensForTools(tools)).toBe(4242);
    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(estimateTokensForTools(tools)).toBe(expected);
    expect(batchSpy).toHaveBeenCalledTimes(2);
    batchSpy.mockReturnValueOnce(undefined);
    expect(estimateTokensForTools(tools)).toBe(expected);
  });

  it('does not batch an empty tool list', () => {
    expect(estimateTokensForTools([])).toBe(0);
    expect(batchSpy).not.toHaveBeenCalled();
  });
});

function mixedMessages(): Message[] {
  return [
    {
      role: 'user',
      content: [{ type: 'text', text: 'hello world 你好，世界！' }],
      toolCalls: [],
    },
    {
      role: 'assistant',
      content: [
        { type: 'think', think: 'reasoning 步骤 with emoji 👋' },
        { type: 'text', text: 'const x = await fetch(url);' },
      ],
      toolCalls: [
        { type: 'function', id: 'c1', name: 'read_file', arguments: '{"path":"src/a.ts"}' },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
        { type: 'text', text: 'describe this 🎉' },
      ],
      toolCalls: [],
    },
  ];
}

describe.skipIf(!isNativeToolsLoaded())('native batch token estimation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('tryNativeEstimateTokensBatch sums texts exactly like the JS heuristic', () => {
    const texts = [
      'hello world',
      '你好，世界！',
      '👋🎉 emoji mix',
      'const x = await fetch(url);',
      '',
      'abcde',
    ];
    const expected = texts.reduce((sum, text) => sum + estimateTokens(text), 0);
    expect(tryNativeEstimateTokensBatch(texts)).toBe(expected);
  });

  it('estimateTokensForTools equals the per-tool JS path', () => {
    const tools = [
      { name: 'read', description: '读取文件内容', parameters: { type: 'object' } },
      { name: 'bash', description: 'Run a shell command 🚀', parameters: { type: 'string' } },
    ];
    const expected = tools.reduce(
      (sum, tool) =>
        sum +
        estimateTokens(tool.name) +
        estimateTokens(tool.description) +
        estimateTokens(JSON.stringify(tool.parameters)),
      0,
    );
    expect(estimateTokensForTools(tools)).toBe(expected);
  });
});

describe('token estimation fallback', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns JS heuristic totals when native tools are force-disabled', () => {
    vi.stubEnv('KIMI_NATIVE_TOOLS_FORCE_JS', '1');
    expect(tryNativeEstimateTokensBatch(['hello world'])).toBeUndefined();

    const message: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'abcd' }],
      toolCalls: [{ type: 'function', id: 'c1', name: 'tool', arguments: '{}' }],
    };
    const expectedMessage =
      estimateTokens('assistant') +
      estimateTokens('abcd') +
      estimateTokens('tool') +
      estimateTokens('"{}"');
    expect(estimateTokensForMessages([message])).toBe(expectedMessage);

    const tool = { name: 'read', description: 'Read a file', parameters: { type: 'object' } };
    const expectedTool =
      estimateTokens(tool.name) +
      estimateTokens(tool.description) +
      estimateTokens(JSON.stringify(tool.parameters));
    expect(estimateTokensForTools([tool])).toBe(expectedTool);
  });

  it('native and fallback paths produce identical totals', () => {
    const messages = mixedMessages();
    const withNative = estimateTokensForMessages(messages);
    vi.stubEnv('KIMI_NATIVE_TOOLS_FORCE_JS', '1');
    const forced = estimateTokensForMessages(messages);
    expect(forced).toBe(withNative);
  });
});
