import { describe, expect, it } from 'vitest';

import type { Message } from '#/message';
import {
  estimateTokens,
  estimateTokensForContentPart,
  estimateTokensForMessage,
  estimateTokensForMessages,
  estimateTokensForTools,
  MEDIA_TOKEN_ESTIMATE,
} from '#/tokens';

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
    // Serialized tool-call arguments are estimated with the implementation's
    // JSON formula: raw heuristic estimate × 1.3, rounded up.
    const expected =
      estimateTokens('assistant') +
      estimateTokens('abcd') +
      estimateTokens('tool') +
      Math.ceil(estimateTokens('{}') * 1.3);
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
});

describe('estimateTokensForTools', () => {
  it('counts name, description, and serialized parameters', () => {
    const tool = { name: 'read', description: 'Read a file', parameters: { type: 'object' } };
    // estimateTokensForTools applies the JSON ×1.3 multiplier to the summed
    // token estimate of the whole batch, then rounds up.
    const expected = Math.ceil(
      (estimateTokens(tool.name) +
        estimateTokens(tool.description) +
        estimateTokens(JSON.stringify(tool.parameters))) *
        1.3,
    );
    expect(estimateTokensForTools([tool])).toBe(expected);
  });
});
