import { describe, expect, it } from 'bun:test';

import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import { createUserMessage } from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import type { FormatRequestInput } from '#/llm/protocol/format';
import { prepareOpenAIRequest } from '#/llm/requester/bases/openai/requester';

const DEEPSEEK = 'deepseek-v4.1-flash';

function modelFor(name: string): LlmModel {
  return {
    provider: 'test',
    model: name,
    capability: UNKNOWN_CAPABILITY,
    baseUrl: 'https://example.test/v1',
  };
}

function body(
  overrides: Partial<FormatRequestInput> = {},
  firstText = 'hi',
): Record<string, unknown> {
  return prepareOpenAIRequest({
    model: modelFor(DEEPSEEK),
    messages: [createUserMessage(firstText)],
    tools: [],
    ...overrides,
  }).params as unknown as Record<string, unknown>;
}

describe('determinism option', () => {
  it('adds an integer seed when enabled', () => {
    expect(Number.isInteger(body({ determinism: {} }).seed)).toBe(true);
  });

  it('leaves the request untouched when disabled', () => {
    expect(body().seed).toBeUndefined();
  });

  it('derives the same seed for the same model and first message', () => {
    expect(body({ determinism: {} }).seed).toBe(body({ determinism: {} }).seed);
  });

  it('derives a different seed for a different first message', () => {
    expect(body({ determinism: {} }, 'alpha').seed).not.toBe(
      body({ determinism: {} }, 'beta').seed,
    );
  });

  it('honours an explicit seed', () => {
    expect(body({ determinism: { seed: 7 } }).seed).toBe(7);
  });

  it('keeps the seed in thinking mode while temperature stays stripped', () => {
    const thinkingOn = body({ determinism: {}, thinking: { effort: 'high' } });
    expect(Number.isInteger(thinkingOn.seed)).toBe(true);
    expect(thinkingOn.temperature).toBeUndefined();
  });

  it('adds no seed when only thinking is requested', () => {
    expect(body({ thinking: { effort: 'high' } }).seed).toBeUndefined();
  });
});
