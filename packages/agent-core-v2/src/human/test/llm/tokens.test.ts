import { describe, expect, it } from 'vitest';

import type { ContentPart } from '#/llm/message';
import { imagePricingForModel } from '#/llm/modelFamily';
import {
  estimateTokens,
  estimateTokensForContentPart,
  estimateTokensForContentParts,
  estimateTokensForMessage,
  estimateTokensForMessages,
  estimateTokensForTools,
  MEDIA_TOKEN_ESTIMATE,
} from '#/llm/tokens';

const plainTextMessage = { role: 'user', content: [{ type: 'text', text: 'Hello world' }] };

const toolCallMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'ok' }],
  toolCalls: [
    { type: 'function' as const, id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' },
    { type: 'function' as const, id: 'c2', name: 'list_dir', arguments: null },
  ],
};

const imageMessage = {
  role: 'user',
  content: [{ type: 'image_url' as const, imageUrl: { url: 'data:image/png;base64,AAAA' } }],
};

const mixedMessage = {
  role: 'assistant',
  content: [
    { type: 'think' as const, think: 'reasoning here' },
    { type: 'text' as const, text: 'final answer' },
    { type: 'image_url' as const, imageUrl: { url: 'https://x/y.png' } },
  ],
  toolCalls: [{ type: 'function' as const, id: 'c3', name: 'grep', arguments: '{"q":"x"}' }],
};

describe('unified estimator matches the pre-convergence adapter figures', () => {
  it('keeps the adapter baseline for text-only and image messages', () => {
    expect(estimateTokensForMessage(plainTextMessage)).toBe(4);
    expect(estimateTokensForMessage(imageMessage)).toBe(2001);
  });

  it('keeps the adapter baseline for tool-call messages', () => {
    expect(estimateTokensForMessage(toolCallMessage)).toBe(16);
    expect(estimateTokensForMessage(mixedMessage)).toBe(2015);
  });

  it('stringifies tool arguments, matching the adapter implementation', () => {
    const expected =
      estimateTokens('assistant') +
      estimateTokens('ok') +
      estimateTokens('read_file') +
      estimateTokens(JSON.stringify('{"path":"a.ts"}')) +
      estimateTokens('list_dir') +
      estimateTokens(JSON.stringify(null));
    expect(estimateTokensForMessage(toolCallMessage)).toBe(expected);
  });

  it('counts non-assistant toolCalls, matching the adapter implementation', () => {
    const nonAssistant = {
      role: 'user',
      content: [{ type: 'text' as const, text: 'x' }],
      toolCalls: [{ type: 'function' as const, id: 'c9', name: 'abc', arguments: '{}' }],
    };
    expect(estimateTokensForMessage(nonAssistant)).toBe(
      estimateTokens('user') +
        estimateTokens('x') +
        estimateTokens('abc') +
        estimateTokens(JSON.stringify('{}')),
    );
  });
});

describe('documented divergence from the former context-usage implementation', () => {
  it('includes tool-call tokens for non-assistant roles where the old context-usage estimator skipped them', () => {
    const nonAssistant = {
      role: 'user',
      content: [{ type: 'text' as const, text: 'x' }],
      toolCalls: [{ type: 'function' as const, id: 'c9', name: 'abc', arguments: '{}' }],
    };
    expect(estimateTokensForMessage(nonAssistant)).toBeGreaterThan(
      estimateTokens('user') + estimateTokens('x'),
    );
  });

  it('stringifies null arguments instead of treating them as empty', () => {
    const withNull = {
      role: 'assistant',
      content: [{ type: 'text' as const, text: 'ok' }],
      toolCalls: [{ type: 'function' as const, id: 'c1', name: 'list_dir', arguments: null }],
    };
    const base =
      estimateTokens('assistant') + estimateTokens('ok') + estimateTokens('list_dir');
    expect(estimateTokensForMessage(withNull)).toBe(base + estimateTokens(JSON.stringify(null)));
    expect(estimateTokensForMessage(withNull)).toBe(base + 1);
  });
});

describe('estimator surface', () => {
  it('exposes the same helpers the adapter module did', () => {
    expect(typeof estimateTokens).toBe('function');
    expect(typeof estimateTokensForMessages).toBe('function');
    expect(typeof estimateTokensForMessage).toBe('function');
    expect(typeof estimateTokensForContentParts).toBe('function');
    expect(typeof estimateTokensForContentPart).toBe('function');
    expect(typeof estimateTokensForTools).toBe('function');
    expect(MEDIA_TOKEN_ESTIMATE).toBe(2000);
  });

  it('sums messages and tools', () => {
    expect(estimateTokensForMessages([plainTextMessage, plainTextMessage])).toBe(8);
    expect(
      estimateTokensForTools([{ name: 'read', description: 'Read a file', parameters: {} }]),
    ).toBeGreaterThan(0);
  });

  it('keeps the fixed media estimate without pricing', () => {
    const audio: ContentPart = { type: 'audio_url', audioUrl: { url: 'data:audio/mp3;base64,AA' } };
    const video: ContentPart = { type: 'video_url', videoUrl: { url: 'data:video/mp4;base64,AA' } };
    expect(estimateTokensForContentPart(audio)).toBe(MEDIA_TOKEN_ESTIMATE);
    expect(estimateTokensForContentPart(video)).toBe(MEDIA_TOKEN_ESTIMATE);
  });

  it('keeps a large data URL bounded instead of counting base64 as text', () => {
    const part: ContentPart = {
      type: 'image_url',
      imageUrl: { url: `data:image/png;base64,${'A'.repeat(4_000_000)}` },
    };
    expect(estimateTokensForContentPart(part)).toBe(MEDIA_TOKEN_ESTIMATE);
    expect(estimateTokensForContentPart(part)).toBeLessThan(50_000);
  });
});

describe('family image pricing', () => {
  it('uses the family fallback for image parts when pricing is supplied', () => {
    const pricing = imagePricingForModel('deepseek-flash');
    expect(pricing).toBeDefined();
    const part: ContentPart = {
      type: 'image_url',
      imageUrl: { url: 'data:image/png;base64,AAAA' },
    };
    expect(estimateTokensForContentPart(part, pricing)).toBe(pricing!.fallbackTokens);
    expect(estimateTokensForContentParts([part], pricing)).toBe(pricing!.fallbackTokens);
    expect(estimateTokensForMessage(imageMessage, pricing)).toBe(
      estimateTokens('user') + pricing!.fallbackTokens,
    );
  });

  it('leaves audio and video at the fixed estimate even with pricing', () => {
    const pricing = imagePricingForModel('deepseek-flash');
    const audio: ContentPart = { type: 'audio_url', audioUrl: { url: 'data:audio/mp3;base64,AA' } };
    expect(estimateTokensForContentPart(audio, pricing)).toBe(MEDIA_TOKEN_ESTIMATE);
  });

  it('does not memoize pricing-aware estimates onto the shared message cache', () => {
    const pricing = imagePricingForModel('deepseek-flash');
    const message = {
      role: 'user',
      content: [{ type: 'image_url' as const, imageUrl: { url: 'data:image/png;base64,AAAA' } }],
    };
    expect(estimateTokensForMessage(message, pricing)).toBe(estimateTokens('user') + 1024);
    expect(estimateTokensForMessage(message)).toBe(2001);
    expect(estimateTokensForMessage(message, pricing)).toBe(estimateTokens('user') + 1024);
  });
});

describe('deepseek vision formula', () => {
  const pricing = imagePricingForModel('deepseek-v4-pro')!;

  function imagePart(width: number, height: number): ContentPart {
    return {
      type: 'image_url',
      imageUrl: { url: 'data:image/png;base64,AAAA', dimensions: { width, height } },
    };
  }

  it('floors a small image to the scale-up floor, not the flat fallback', () => {
    const tokens = estimateTokensForContentPart(imagePart(200, 200), pricing);
    expect(tokens).toBe(169);
    expect(tokens).toBe(
      estimateTokensForContentPart(imagePart(512, 512), pricing),
    );
    expect(tokens * 5).toBeLessThan(pricing.fallbackTokens);
  });

  it('grows with dimensions and stays aspect-preserving', () => {
    const square = estimateTokensForContentPart(imagePart(512, 512), pricing);
    const wide = estimateTokensForContentPart(imagePart(1024, 512), pricing);
    expect(square).toBe(169);
    expect(wide).toBe(338);
    expect(wide).toBeGreaterThan(square);
    expect(wide).toBeLessThan(pricing.tokenCap);
  });

  it('caps very large images at the token cap', () => {
    const tokens = estimateTokensForContentPart(imagePart(8000, 6000), pricing);
    expect(tokens).toBeLessThanOrEqual(pricing.tokenCap);
    expect(tokens).toBeGreaterThan(pricing.tokenCap / 2);
  });

  it('falls back when dimensions are absent or degenerate', () => {
    expect(estimateTokensForContentPart({ type: 'image_url', imageUrl: { url: 'x' } }, pricing)).toBe(
      pricing.fallbackTokens,
    );
    expect(estimateTokensForContentPart(imagePart(0, 100), pricing)).toBe(pricing.fallbackTokens);
    expect(estimateTokensForContentPart(imagePart(100, -1), pricing)).toBe(pricing.fallbackTokens);
  });

  it('prices a message image through the formula when dimensions are known', () => {
    const message = { role: 'user', content: [imagePart(200, 200)] };
    expect(estimateTokensForMessage(message, pricing)).toBe(estimateTokens('user') + 169);
  });

  it('keeps the fallback and the cap as independent knobs', () => {
    // Both values are 1024 today. They mean different things — the fallback
    // applies when dimensions are unknown, the cap bounds the grid solve — so a
    // single endpoint change must not be able to move both. This pins the
    // behaviour rather than the numbers: if either constant changes, the effect
    // it has must stay confined to its own path.
    const changedFallback = { ...pricing, fallbackTokens: 4096 };
    expect(estimateTokensForContentPart({ type: 'image_url', imageUrl: { url: 'x' } }, changedFallback)).toBe(4096);
    expect(estimateTokensForContentPart(imagePart(200, 200), changedFallback)).toBe(169);

    const changedCap = { ...pricing, tokenCap: 2048 };
    expect(estimateTokensForContentPart(imagePart(200, 200), changedCap)).toBe(169);
    expect(estimateTokensForContentPart(imagePart(8000, 6000), changedCap)).toBeLessThanOrEqual(2048);
  });

  it('records the calibration error against the measured endpoint', () => {
    // The figures in the family constant's doc comment came from a live endpoint
    // and are known to be approximations. Pinning the deltas here means a future
    // change to the formula has to acknowledge the measurement it contradicts.
    const measured: readonly (readonly [number, number, number])[] = [
      [200, 200, 185],
      [512, 512, 185],
      [1024, 1024, 653],
      [1024, 512, 341],
    ];
    for (const [width, height, actual] of measured) {
      const formula = estimateTokensForContentPart(imagePart(width, height), pricing);
      expect(formula).toBeLessThanOrEqual(actual);
      expect(actual - formula).toBeLessThanOrEqual(28);
    }
  });
});
