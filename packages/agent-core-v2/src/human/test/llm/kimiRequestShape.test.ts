import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import { createUserMessage, type ToolDescription } from '#/llm/message';
import type { LlmModel } from '@moonshot-ai/core/llm/model';
import {
  kimiAnthropicTrait,
  kimiConnection,
  kimiOpenAITrait,
  kimiResponsesTrait,
} from '#/llm-kimi/trait';
import {
  createAnthropicRequester,
  prepareAnthropicRequest,
} from '#/llm/requester/bases/anthropic/requester';
import {
  createOpenAIResponsesRequester,
  prepareOpenAIResponsesRequest,
} from '#/llm/requester/bases/openai-responses/requester';
import { createOpenAIRequester, prepareOpenAIRequest } from '#/llm/requester/bases/openai/requester';
import type { LlmRequestEvent } from '#/llm/requester/requester';

import { startMockUpstream, type MockUpstream } from '../../../../test/helpers/mockUpstream';

const TOOLS: readonly ToolDescription[] = [
  {
    name: 'Read',
    description: 'read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  },
  {
    name: '$web_search',
    description: 'search the web',
    parameters: { type: 'object', properties: {} },
  },
];

function model(overrides: Partial<LlmModel> = {}): LlmModel {
  return {
    provider: 'kimi',
    model: 'kimi-mock',
    capability: UNKNOWN_CAPABILITY,
    baseUrl: 'https://example.test/v1',
    maxContextSize: 200_000,
    ...overrides,
  };
}

interface OpenAIBodyOptions {
  readonly trait?: boolean;
  readonly effort?: 'off' | 'high';
  readonly keep?: 'all';
  readonly maxCompletionTokens?: number;
  readonly usedContextTokens?: number;
  readonly cacheKey?: string;
  readonly tools?: readonly ToolDescription[];
}

function openAIBody(options: OpenAIBodyOptions = {}): Record<string, unknown> {
  const request = prepareOpenAIRequest(
    {
      model: model(),
      messages: [createUserMessage('hi')],
      tools: options.tools ?? [],
      maxContextTokens: 200_000,
      ...(options.effort === undefined
        ? {}
        : { thinking: { effort: options.effort, keep: options.keep } }),
      ...(options.maxCompletionTokens === undefined
        ? {}
        : { maxCompletionTokens: options.maxCompletionTokens }),
      ...(options.usedContextTokens === undefined
        ? {}
        : { usedContextTokens: options.usedContextTokens }),
      ...(options.cacheKey === undefined ? {} : { cacheKey: options.cacheKey }),
    },
    options.trait === true ? { trait: kimiOpenAITrait } : undefined,
  );
  return request.params as unknown as Record<string, unknown>;
}

function anthropicBody(trait: boolean, effort: 'off' | 'high'): Record<string, unknown> {
  const request = prepareAnthropicRequest(
    {
      model: model(),
      messages: [createUserMessage('hi')],
      tools: [],
      maxContextTokens: 200_000,
      thinking: { effort },
    },
    trait ? { trait: kimiAnthropicTrait } : undefined,
  );
  return request.params as unknown as Record<string, unknown>;
}

function responsesBody(trait: boolean, usedContextTokens: number): Record<string, unknown> {
  const request = prepareOpenAIResponsesRequest(
    {
      model: model(),
      messages: [createUserMessage('hi')],
      tools: [],
      maxContextTokens: 200_000,
      usedContextTokens,
    },
    trait ? { trait: kimiResponsesTrait } : undefined,
  );
  return request.params as unknown as Record<string, unknown>;
}

describe('kimi request shape on the openai transport', () => {
  it('declares thinking as an object instead of reasoning_effort', () => {
    expect(openAIBody({ effort: 'high', keep: 'all' }).reasoning_effort).toBe('high');
    expect(openAIBody({ trait: true, effort: 'high', keep: 'all' }).thinking).toEqual({
      type: 'enabled',
      effort: 'high',
      keep: 'all',
    });
    expect(openAIBody({ trait: true, effort: 'high' }).reasoning_effort).toBeUndefined();
  });

  it('turns an off effort into a disabled thinking block', () => {
    expect(openAIBody({ trait: true, effort: 'off' }).thinking).toEqual({ type: 'disabled' });
  });

  it('sends max_completion_tokens capped at the provider ceiling', () => {
    expect(openAIBody({ maxCompletionTokens: 4096 }).max_tokens).toBe(4096);
    expect(openAIBody({ trait: true, maxCompletionTokens: 4096 }).max_completion_tokens).toBe(4096);
    expect(
      openAIBody({ trait: true, usedContextTokens: 50_000 }).max_completion_tokens,
    ).toBe(131_072);
  });

  it('marks a dollar-prefixed tool as a builtin function', () => {
    const vanilla = openAIBody({ tools: TOOLS }).tools as { type: string; function: { name: string } }[];
    const kimi = openAIBody({ trait: true, tools: TOOLS }).tools as {
      type: string;
      function: { name: string };
    }[];
    expect(vanilla.map((tool) => `${tool.type}:${tool.function.name}`)).toEqual([
      'function:Read',
      'function:$web_search',
    ]);
    expect(kimi.map((tool) => `${tool.type}:${tool.function.name}`)).toEqual([
      'function:Read',
      'builtin_function:$web_search',
    ]);
  });

  it('carries the cache key as prompt_cache_key', () => {
    expect(openAIBody({ trait: true, cacheKey: 'sess-1' }).prompt_cache_key).toBe('sess-1');
  });
});

describe('kimi request shape on the anthropic transport', () => {
  it('replaces the adaptive thinking block with an explicit enabled or disabled one', () => {
    expect(anthropicBody(false, 'high').thinking).toMatchObject({ type: 'adaptive' });
    expect(anthropicBody(true, 'high').thinking).toEqual({ type: 'enabled' });
    expect(anthropicBody(true, 'off').thinking).toEqual({ type: 'disabled' });
    expect(anthropicBody(true, 'off').output_config).toBeUndefined();
  });

  it('keeps the effort in output_config for an enabled effort', () => {
    const body = anthropicBody(true, 'high');
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.output_config).toEqual({ effort: 'high' });
  });
});

describe('kimi request shape on the responses transport', () => {
  it('derives max_output_tokens from the context window when none is requested', () => {
    expect(responsesBody(false, 50_000).max_output_tokens).toBeUndefined();
    expect(responsesBody(true, 50_000).max_output_tokens).toBe(150_000);
  });
});

describe('kimi traits stream through a real socket', () => {
  let upstream: MockUpstream;

  beforeAll(() => {
    upstream = startMockUpstream({ kind: 'text', chunks: ['Hel', 'lo'] });
  });

  afterAll(async () => {
    await upstream.close();
  });

  const variants: readonly {
    readonly name: string;
    readonly create: () => ReturnType<typeof createOpenAIRequester>;
  }[] = [
    {
      name: 'openai',
      create: () => createOpenAIRequester({ trait: kimiOpenAITrait, connection: kimiConnection }),
    },
    {
      name: 'anthropic',
      create: () =>
        createAnthropicRequester({ trait: kimiAnthropicTrait, connection: kimiConnection }),
    },
    {
      name: 'responses',
      create: () =>
        createOpenAIResponsesRequester({ trait: kimiResponsesTrait, connection: kimiConnection }),
    },
  ];

  const describeVariant = (variant: (typeof variants)[number]): void => {
    it(`streams text through the ${variant.name} transport`, async () => {
      upstream.requests.length = 0;
      const events: LlmRequestEvent[] = [];
      await variant.create().generate(
        { model: model({ model: 'mock-model', baseUrl: upstream.baseUrl, apiKey: 'k' }), tools: [] },
        { messages: [createUserMessage('hi')] },
        { signal: new AbortController().signal, onEvent: (event) => events.push(event) },
      );
      const text = events
        .map((event) =>
          event.type === 'llm.streaming.part' && event.part.type === 'text' ? event.part.text : '',
        )
        .join('');
      expect(text).toBe('Hello');
      expect(events.at(-1)).toMatchObject({ type: 'llm.done' });
      expect(upstream.requests).toHaveLength(1);
    });
  };

  for (const variant of variants) describeVariant(variant);
});
