import { describe, expect, it } from 'vitest';

import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import {
  createAssistantMessage,
  createUserMessage,
  type Message,
  type ToolDescription,
} from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import {
  fullReasoningEchoRequired,
  ignoredSamplingParamsForModel,
  thinkingHistoryForModel,
} from '#/llm/modelFamily';
import { createOpenAIRequester } from '#/llm/requester/bases/openai/requester';
import type { LlmClientContext } from '#/llm/requester/requester';

const deepseekModel: LlmModel = {
  provider: 'deepseek',
  model: 'deepseek-v4-pro',
  capability: UNKNOWN_CAPABILITY,
  baseUrl: 'https://api.deepseek.test/v1',
};

const genericModel: LlmModel = {
  provider: 'openai',
  model: 'gpt-4o',
  capability: UNKNOWN_CAPABILITY,
  baseUrl: 'https://api.openai.test/v1',
};

const tool: ToolDescription = {
  name: 'read_file',
  description: 'Read a file',
  parameters: { type: 'object', properties: {} },
};

const chatCompletionChunks: readonly Record<string, unknown>[] = [
  {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'deepseek-v4-pro',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  },
];

function createAsyncStream<T>(chunks: readonly T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

function stubOpenAIClient(chunks: readonly Record<string, unknown>[]): {
  clientFactory: (request: LlmClientContext) => never;
  body: () => Record<string, unknown>;
} {
  const captured: Record<string, unknown>[] = [];
  return {
    clientFactory: () =>
      ({
        chat: {
          completions: {
            create: (params: Record<string, unknown>) => {
              captured.push(params);
              return {
                withResponse: async () => ({
                  data: createAsyncStream(chunks),
                  response: new Response(),
                }),
              };
            },
          },
        },
      }) as never,
    body: () => {
      const last = captured.at(-1);
      if (last === undefined) throw new Error('expected client to be called');
      return last;
    },
  };
}

interface WireMessage {
  readonly role?: string;
  readonly reasoning_content?: string;
  readonly tool_calls?: readonly unknown[];
}

function wireMessages(body: Record<string, unknown>): readonly WireMessage[] {
  return (body['messages'] ?? []) as readonly WireMessage[];
}

/**
 * An assistant turn that carries reasoning plus a tool call — the exact shape
 * DeepSeek requires to be replayed whenever the request carries tools.
 *
 * `hidden` is the part that discriminates: a visible think part is replayed by
 * the pre-existing machinery on every protocol, while a `hidden` one is
 * suppressed unless the family asks for the full echo. Testing with the hidden
 * part is therefore the only way this file actually exercises the new path.
 */
function assistantTurnWithHiddenReasoning(): Message {
  return createAssistantMessage([
    { type: 'think', think: 'visible thought' },
    { type: 'think', think: 'hidden thought', hidden: true },
  ]);
}

describe('fullReasoningEchoRequired', () => {
  it('requires the full echo for deepseek only when tools are present', () => {
    expect(fullReasoningEchoRequired('deepseek-v4-pro', true)).toBe(true);
    expect(fullReasoningEchoRequired('workbuddy/deepseek-v4.1-flash', true)).toBe(true);
    expect(fullReasoningEchoRequired('xopdeepseekv4pro', true)).toBe(true);
    expect(fullReasoningEchoRequired('deepseek-v4-pro', false)).toBe(false);
  });

  it('never requires it outside the deepseek family', () => {
    expect(fullReasoningEchoRequired('gpt-4o', true)).toBe(false);
    expect(fullReasoningEchoRequired('my-deepseek-clone', true)).toBe(false);
    expect(fullReasoningEchoRequired(undefined, true)).toBe(false);
  });

  it('declares the family history requirement as data, not as a trait hook', () => {
    expect(thinkingHistoryForModel('deepseek-v4-pro')?.fullEchoWithTools).toBe(true);
    expect(thinkingHistoryForModel('gpt-4o')).toBeUndefined();
  });
});

describe('deepseek reasoning replay on the wire', () => {
  it('replays a hidden reasoning part when the request carries tools', async () => {
    const client = stubOpenAIClient(chatCompletionChunks);
    const requester = createOpenAIRequester({ clientFactory: client.clientFactory });
    await requester.generate(
      { model: deepseekModel, tools: [tool] },
      {
        messages: [
          createUserMessage('start'),
          assistantTurnWithHiddenReasoning(),
          createUserMessage('continue'),
        ],
      },
      { signal: new AbortController().signal },
    );

    const assistant = wireMessages(client.body()).find((m) => m.role === 'assistant');
    expect(assistant?.reasoning_content).toContain('visible thought');
    // The hidden part is the one the family flag decides about.
    expect(assistant?.reasoning_content).toContain('hidden thought');
  });

  it('suppresses the hidden reasoning part when no tools are sent', async () => {
    const client = stubOpenAIClient(chatCompletionChunks);
    const requester = createOpenAIRequester({ clientFactory: client.clientFactory });
    await requester.generate(
      { model: deepseekModel },
      { messages: [createUserMessage('start'), assistantTurnWithHiddenReasoning()] },
      { signal: new AbortController().signal },
    );

    const assistant = wireMessages(client.body()).find((m) => m.role === 'assistant');
    // Without tools DeepSeek ignores prior reasoning, so there is no reason to
    // pay for it on the wire.
    expect(assistant?.reasoning_content ?? '').not.toContain('hidden thought');
  });

  it('does not ask for the full echo outside the deepseek family', () => {
    // A think part stamped with its own reasoning key is replayed by the
    // pre-existing stamped branch on every protocol, so this asserts the knob
    // that is new — the family-driven full echo — rather than the presence of
    // the field, which non-deepseek models already had.
    expect(fullReasoningEchoRequired('gpt-4o', true)).toBe(false);
    expect(thinkingHistoryForModel('gpt-4o')).toBeUndefined();
    expect(ignoredSamplingParamsForModel('gpt-4o')).toEqual([]);
  });
});

describe('ignoredSamplingParamsForModel', () => {
  it('lists the deepseek parameters that thinking mode ignores', () => {
    expect(ignoredSamplingParamsForModel('deepseek-v4-pro')).toEqual([
      'temperature',
      'presence_penalty',
      'frequency_penalty',
    ]);
  });

  it('is empty outside the deepseek family', () => {
    expect(ignoredSamplingParamsForModel('gpt-4o')).toEqual([]);
    expect(ignoredSamplingParamsForModel(undefined)).toEqual([]);
  });
});

describe('sampling parameters on the wire', () => {
  it('drops the parameters deepseek ignores while thinking', async () => {
    const client = stubOpenAIClient(chatCompletionChunks);
    const requester = createOpenAIRequester({ clientFactory: client.clientFactory });
    await requester.generate(
      {
        model: deepseekModel,
        extraParams: {
          openai: { temperature: 0.2, presence_penalty: 0.5, frequency_penalty: 0.5, top_p: 0.9 },
        },
      },
      { messages: [createUserMessage('hi')] },
      { signal: new AbortController().signal },
    );

    const body = client.body();
    expect(body['temperature']).toBeUndefined();
    expect(body['presence_penalty']).toBeUndefined();
    expect(body['frequency_penalty']).toBeUndefined();
    // top_p is honoured by deepseek (clamped to 0.95–1.0), so it must survive.
    expect(body['top_p']).toBe(0.9);
  });

  it('leaves the same parameters untouched for a non-deepseek model', async () => {
    const client = stubOpenAIClient(chatCompletionChunks);
    const requester = createOpenAIRequester({ clientFactory: client.clientFactory });
    await requester.generate(
      {
        model: genericModel,
        extraParams: { openai: { temperature: 0.2, presence_penalty: 0.5 } },
      },
      { messages: [createUserMessage('hi')] },
      { signal: new AbortController().signal },
    );

    const body = client.body();
    expect(body['temperature']).toBe(0.2);
    expect(body['presence_penalty']).toBe(0.5);
  });
});
