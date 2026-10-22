import { describe, expect, it } from 'bun:test';

import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import {
  createAssistantMessage,
  createUserMessage,
  type ToolDescription,
} from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import type { FormatRequestInput } from '#/llm/protocol/format';
import { prepareOpenAIRequest } from '#/llm/requester/bases/openai/requester';
import type { ResponseFormat } from '#/llm/response-format';

const DEEPSEEK = 'deepseek-v4.1-flash';
const OTHER = 'gpt-4o';

const readFileTool: ToolDescription = {
  name: 'read_file',
  description: 'Read a file from disk',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
};

const jsonSchemaFormat: ResponseFormat = {
  type: 'json_schema',
  jsonSchema: {
    name: 'answer',
    schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
    strict: true,
  },
};

function modelFor(name: string, maxContextSize?: number): LlmModel {
  return {
    provider: 'test',
    model: name,
    capability: UNKNOWN_CAPABILITY,
    baseUrl: 'https://example.test/v1',
    ...(maxContextSize === undefined ? {} : { maxContextSize }),
  };
}

interface ThinkingMetadata {
  readonly supportEfforts?: readonly string[];
  readonly defaultEffort?: string;
  readonly alwaysThinking?: boolean;
}

function thinkingModel(name: string, metadata: ThinkingMetadata): LlmModel {
  return {
    ...modelFor(name),
    capability: { ...UNKNOWN_CAPABILITY, thinking: true },
    ...metadata,
  } as LlmModel;
}

interface PrepareOverrides {
  readonly thinking?: FormatRequestInput['thinking'];
  readonly maxCompletionTokens?: number;
  readonly maxContextTokens?: number;
  readonly usedContextTokens?: number;
  readonly tools?: readonly ToolDescription[];
  readonly responseFormat?: ResponseFormat;
  readonly extraParams?: Record<string, unknown>;
  readonly maxContextSize?: number;
}

function requestBody(name: string, overrides: PrepareOverrides = {}): Record<string, unknown> {
  const { extraParams, maxContextSize, ...rest } = overrides;
  return prepareOpenAIRequest({
    model: modelFor(name, maxContextSize),
    messages: [createUserMessage('hi')],
    tools: rest.tools ?? [],
    ...rest,
    ...(extraParams === undefined ? {} : { extraParams: { openai: extraParams } }),
  }).params as unknown as Record<string, unknown>;
}

describe('deepseek family output cap', () => {
  it('declares the non-thinking tier when thinking is absent', () => {
    expect(requestBody(DEEPSEEK).max_tokens).toBe(8192);
  });

  it('declares the non-thinking tier for an explicit off effort', () => {
    expect(requestBody(DEEPSEEK, { thinking: { effort: 'off' } }).max_tokens).toBe(8192);
  });

  it('declares the thinking tier for every non-max effort', () => {
    expect(requestBody(DEEPSEEK, { thinking: { effort: 'low' } }).max_tokens).toBe(65536);
    expect(requestBody(DEEPSEEK, { thinking: { effort: 'medium' } }).max_tokens).toBe(65536);
    expect(requestBody(DEEPSEEK, { thinking: { effort: 'high' } }).max_tokens).toBe(65536);
  });

  it('declares the max-effort tier for max', () => {
    expect(requestBody(DEEPSEEK, { thinking: { effort: 'max' } }).max_tokens).toBe(131072);
  });

  it('declares the model default tier when the caller asks for on', () => {
    const body = prepareOpenAIRequest({
      model: thinkingModel(DEEPSEEK, {
        supportEfforts: ['low', 'high', 'max'],
        defaultEffort: 'max',
      }),
      messages: [createUserMessage('hi')],
      tools: [],
      thinking: { effort: 'on' },
    }).params as unknown as Record<string, unknown>;
    expect(body.max_tokens).toBe(131072);
  });

  it('declares the thinking tier for an always-thinking model with no explicit effort', () => {
    const body = prepareOpenAIRequest({
      model: thinkingModel(DEEPSEEK, { alwaysThinking: true }),
      messages: [createUserMessage('hi')],
      tools: [],
    }).params as unknown as Record<string, unknown>;
    expect(body.max_tokens).toBe(65536);
  });

  it('keeps an explicit caller cap instead of the family tier', () => {
    expect(requestBody(DEEPSEEK, { maxCompletionTokens: 1000 }).max_tokens).toBe(1000);
  });

  it('sends no cap at all when the caller explicitly asks for none', () => {
    const body = requestBody(DEEPSEEK, { maxCompletionTokens: 0 });
    expect(body.max_tokens).toBeUndefined();
    expect(body.max_completion_tokens).toBeUndefined();
  });

  it('clamps the tier to the remaining context window', () => {
    const body = requestBody(DEEPSEEK, { maxContextTokens: 10000, usedContextTokens: 9500 });
    expect(body.max_tokens).toBe(500);
  });

  it('sends no cap when the remaining window is exhausted', () => {
    for (const usedContextTokens of [10000, 11000]) {
      const body = requestBody(DEEPSEEK, { maxContextTokens: 10000, usedContextTokens });
      expect(body.max_tokens).toBeUndefined();
      expect(body.max_completion_tokens).toBeUndefined();
    }
  });

  it('sends no cap for an explicit caller budget when the window is exhausted', () => {
    const body = requestBody(DEEPSEEK, {
      maxCompletionTokens: 1000,
      maxContextTokens: 10000,
      usedContextTokens: 10000,
    });
    expect(body.max_tokens).toBeUndefined();
  });

  it('reads a zero window as unknown and clamps to the model window', () => {
    const body = requestBody(DEEPSEEK, {
      maxContextSize: 10000,
      maxContextTokens: 0,
      usedContextTokens: 9500,
    });
    expect(body.max_tokens).toBe(500);
  });

  it('clamps an explicit caller budget to the model window when the window is zero', () => {
    const body = requestBody(DEEPSEEK, {
      maxCompletionTokens: 5000,
      maxContextSize: 10000,
      maxContextTokens: 0,
      usedContextTokens: 9500,
    });
    expect(body.max_tokens).toBe(500);
  });

  it('keeps the max-effort tier at the chat-completions ceiling', () => {
    const body = requestBody(DEEPSEEK, {
      thinking: { effort: 'max' },
      maxContextTokens: 400000,
      usedContextTokens: 100000,
    });
    expect(body.max_tokens).toBe(131072);
  });

  it('prefers a provider trait over the family tier', () => {
    const body = prepareOpenAIRequest(
      { model: modelFor(DEEPSEEK), messages: [createUserMessage('hi')], tools: [] },
      { trait: { completionTokensWhenUnset: () => 4096 } },
    ).params as unknown as Record<string, unknown>;
    expect(body.max_tokens).toBe(4096);
  });

  it('adds no cap for models outside the family', () => {
    const body = requestBody(OTHER);
    expect(body.max_tokens).toBeUndefined();
    expect(body.max_completion_tokens).toBeUndefined();
  });
});

describe('deepseek response format suppression', () => {
  it('omits response_format when the request carries tools', () => {
    const body = requestBody(DEEPSEEK, {
      tools: [readFileTool],
      responseFormat: jsonSchemaFormat,
    });
    expect(body.response_format).toBeUndefined();
    expect(body.tools).toHaveLength(1);
  });

  it('keeps response_format when the request carries no tools', () => {
    const body = requestBody(DEEPSEEK, { responseFormat: jsonSchemaFormat });
    expect(body.response_format).toBeDefined();
  });

  it('keeps response_format for models outside the family', () => {
    const body = requestBody(OTHER, { tools: [readFileTool], responseFormat: jsonSchemaFormat });
    expect(body.response_format).toBeDefined();
  });

  it('suppresses a response_format injected through extra params', () => {
    const body = requestBody(DEEPSEEK, {
      tools: [readFileTool],
      extraParams: { response_format: { type: 'json_object' } },
    });
    expect(body.response_format).toBeUndefined();
  });

  it('keeps a response_format injected through extra params without tools', () => {
    const body = requestBody(DEEPSEEK, {
      extraParams: { response_format: { type: 'json_object' } },
    });
    expect(body.response_format).toEqual({ type: 'json_object' });
  });
});

describe('deepseek reasoning replay', () => {
  function hiddenReasoningBody(tools: readonly ToolDescription[]): Record<string, unknown> {
    return prepareOpenAIRequest({
      model: modelFor(DEEPSEEK),
      messages: [
        createUserMessage('hi'),
        createAssistantMessage([{ type: 'think', think: 'hidden-chain', hidden: true }]),
      ],
      tools,
    }).params as unknown as Record<string, unknown>;
  }

  it('replays hidden reasoning when the request carries tools', () => {
    expect(JSON.stringify(hiddenReasoningBody([readFileTool]).messages)).toContain('hidden-chain');
  });

  it('does not replay hidden reasoning when the request carries no tools', () => {
    expect(JSON.stringify(hiddenReasoningBody([]).messages)).not.toContain('hidden-chain');
  });
});

describe('deepseek ignored sampling parameters', () => {
  it('drops the parameters the family declares and keeps the rest', () => {
    const body = requestBody(DEEPSEEK, {
      extraParams: { temperature: 0.4, top_p: 0.9, presence_penalty: 0.2, frequency_penalty: 0.3 },
    });
    expect(body.temperature).toBeUndefined();
    expect(body.presence_penalty).toBeUndefined();
    expect(body.frequency_penalty).toBeUndefined();
    expect(body.top_p).toBe(0.9);
  });

  it('leaves a model outside the family untouched', () => {
    const body = requestBody(OTHER, { extraParams: { temperature: 0.4 } });
    expect(body.temperature).toBe(0.4);
  });
});
