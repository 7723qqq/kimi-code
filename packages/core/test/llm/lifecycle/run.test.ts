// Historical coverage: PR #101 (stream timing), PR #1448 (request trace), PR #3624 (retry lifecycle), PR #4820 (DI-free LLM core).
import { describe, expect, it } from 'bun:test';

import { anthropicProtocol } from '#/llm/builtin/protocol/anthropic/index';
import { openAIProtocol } from '#/llm/builtin/protocol/openai/index';
import { kimiOpenAIProtocol } from '#/llm/builtin/provider/kimi/protocol';
import {
  createAssistantMessage,
  createToolMessage,
  createUserMessage,
} from '#/llm/message';
import { setLog } from '#/utils/log';

import {
  asyncChunks,
  doneOutcome,
  openAIChunk,
  openAICompletion,
  runGenerate,
  testModule,
} from '../harness';

describe('LLM run boundaries', () => {
  it('as an event consumer, I want streaming and replay to share message semantics and ordered run events', async () => {
    const finish = { finishReason: 'tool_calls', rawFinishReason: 'tool_calls' } as const;
    const toolCall = {
      type: 'function',
      id: 'call_1',
      function: { name: 'weather', arguments: '{}' },
    };
    const usage = {
      prompt_tokens: 8,
      completion_tokens: 2,
      total_tokens: 10,
      prompt_tokens_details: { cached_tokens: 0 },
    };
    const chunks = [
      openAIChunk({ role: 'assistant', content: 'hello' }, { id: 'msg-1' }),
      openAIChunk({ tool_calls: [{ index: 0, ...toolCall }] }),
      openAIChunk({}, { finishReason: 'tool_calls', usage }),
    ];
    const protocol = {
      ...openAIProtocol,
      sendStream: async () => ({
        body: asyncChunks(chunks),
        headers: { 'x-request-id': 'req-success' },
      }),
      send: async () => ({
        body: openAICompletion(
          { content: 'hello', tool_calls: [toolCall] },
          { id: 'msg-1', finishReason: 'tool_calls', usage },
        ),
        headers: { 'x-request-id': 'req-success' },
      }),
    };

    const streamed = await runGenerate(protocol, {
      module: testModule({
        profile: {
          systemPrompt: 'system',
          tools: [{ name: 'weather', description: 'weather', parameters: { type: 'object' } }],
        },
      }),
    });
    const done = doneOutcome(streamed.outcome);
    expect(done.message).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      toolCalls: [{
        type: 'function',
        id: 'call_1',
        name: 'weather',
        arguments: '{}',
      }],
      attributes: {
        source: 'llm',
        model: { provider: 'test', model: 'test-model' },
        finish,
        messageId: 'msg-1',
      },
    });
    expect(done.usage).toMatchObject({ inputOther: 8, output: 2 });
    expect(done.requestId).toBe('req-success');
    expect(done.timing).toMatchObject({
      firstTokenLatencyMs: expect.any(Number),
      streamDurationMs: expect.any(Number),
    });
    expect(streamed.events.map((event) => event.type)).toEqual([
      'llm.started',
      'llm.requested',
      'llm.delta.response_header',
      'llm.delta.request_id',
      'llm.delta.message_id',
      'llm.delta.part',
      'llm.delta.part',
      'llm.delta.usage',
      'llm.delta.tool_call_end',
      'llm.delta.finish',
      'llm.delta.timing',
      'llm.ended',
    ]);
    expect(streamed.events[0]).toMatchObject({
      type: 'llm.started',
      provider: 'test',
      model: 'test-model',
      systemPromptHash: expect.any(String),
      toolsHash: expect.any(String),
      messageCount: 1,
    });
    expect(streamed.events[0]).not.toHaveProperty('messages');
    expect(streamed.events[0]).not.toHaveProperty('tools');
    expect(streamed.events.at(-1)).toMatchObject({ type: 'llm.ended', outcome: done });

    const replayed = doneOutcome((await runGenerate(protocol, {
      module: testModule(),
      stream: false,
    })).outcome);
    expect(replayed.message.content).toEqual(done.message.content);
    expect(replayed.message.toolCalls).toEqual(done.message.toolCalls);
    expect(replayed.message.attributes).toMatchObject({ finish, messageId: 'msg-1' });
    expect(replayed.usage).toEqual(done.usage);
    expect(replayed.finish).toEqual(done.finish);
    expect(replayed.requestId).toBe(done.requestId);

    const encoded = openAIProtocol.encode(testModule({
      messages: [
        createUserMessage('run tool', { promptId: 'p-1', origin: { kind: 'user' } }),
        createAssistantMessage([], [{ type: 'function', id: 'call_1', name: 'weather', arguments: '{}' }]),
        createToolMessage('call_1', 'boom', { isError: true, stopTurn: true }),
      ],
    }));
    expect(encoded.params.messages).toEqual([
      { role: 'user', content: 'run tool' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'weather', arguments: '{}' } }],
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: '<system>ERROR: Tool execution failed.</system>\nboom',
      },
    ]);
  });

  it('as a user, I want resolver failures to end without a provider request or synthetic delta events', async () => {
    let sends = 0;
    const protocol = {
      ...openAIProtocol,
      sendStream: async () => {
        sends += 1;
        return { body: asyncChunks([]), headers: {} };
      },
    };
    const result = await runGenerate(protocol, {
      module: testModule(),
      policy: {
        resolvers: [{
          id: 'fail-resolution',
          resolve: async () => {
            throw new Error('resolver failed');
          },
        }],
      },
    });

    expect(result.outcome).toMatchObject({
      type: 'failed',
      error: { message: 'resolver failed' },
    });
    expect(sends).toBe(0);
    expect(result.events.map((event) => event.type)).toEqual([
      'llm.started',
      'llm.ended',
    ]);
  });

  it('as a user, I want cancellation before generation to prevent any provider request', async () => {
    const controller = new AbortController();
    controller.abort('stop before start');
    let sends = 0;
    const protocol = {
      ...openAIProtocol,
      sendStream: async () => {
        sends += 1;
        return { body: asyncChunks([]), headers: {} };
      },
    };

    const result = await runGenerate(protocol, {
      module: testModule(),
      signal: controller.signal,
    });

    expect(result.outcome).toMatchObject({ type: 'aborted', message: null });
    expect(sends).toBe(0);
    expect(result.events.map((event) => event.type)).toEqual(['llm.started', 'llm.ended']);
  });

  it('as a user, I want cancellation during resolution to prevent any provider request', async () => {
    const controller = new AbortController();
    let sends = 0;
    const protocol = {
      ...openAIProtocol,
      sendStream: async () => {
        sends += 1;
        return { body: asyncChunks([]), headers: {} };
      },
    };
    const result = await runGenerate(protocol, {
      module: testModule(),
      signal: controller.signal,
      policy: {
        resolvers: [{
          id: 'cancel-resolution',
          resolve: async (request) => {
            controller.abort('stop resolving');
            return request;
          },
        }],
      },
    });

    expect(result.outcome).toMatchObject({ type: 'aborted', message: null });
    expect(sends).toBe(0);
    expect(result.events.map((event) => event.type)).toEqual(['llm.started', 'llm.ended']);
  });

  it('as an event consumer, I want resolver rewrites to emit a notice before the requested summary', async () => {
    const modules: Array<Parameters<typeof openAIProtocol.encode>[0]> = [];
    const protocol = {
      ...openAIProtocol,
      encode: (module: Parameters<typeof openAIProtocol.encode>[0]) => {
        modules.push(module);
        return openAIProtocol.encode(module);
      },
      sendStream: async () => ({
        body: asyncChunks([openAIChunk({ content: 'ok' }, { finishReason: 'stop' })]),
        headers: {},
      }),
    };

    const result = await runGenerate(protocol, {
      module: testModule(),
      policy: {
        resolvers: [{
          id: 'test-resolver',
          resolve: async (request, { report }) => {
            report({ code: 'request_rewritten', message: 'Resolver rewrote the request.' });
            return { ...request, model: { ...request.model, cacheKey: 'resolved' } };
          },
        }],
      },
    });

    expect(result.outcome.type).toBe('done');
    expect(result.events.slice(0, 2).map((event) => event.type)).toEqual([
      'llm.started',
      'llm.notice',
    ]);
    expect(result.events[1]).toMatchObject({
      type: 'llm.notice',
      notice: { source: 'test-resolver', code: 'request_rewritten' },
    });
    expect(modules[0]?.model.cacheKey).toBe('resolved');
  });

  it('as an event consumer, I want encoder adjustments to emit a notice within the requested attempt', async () => {
    const anthropicResponse = {
      id: 'msg-notice',
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const anthropic = {
      ...anthropicProtocol,
      send: async () => ({ body: anthropicResponse, headers: { 'request-id': 'req-notice' } }),
    };

    const result = await runGenerate(anthropic, {
      module: testModule({
        model: {
          spec: {
            provider: 'anthropic',
            name: 'test-model',
            capability: { thinking: true },
            thinking: { supportEfforts: ['low'] },
          },
          thinking: { effort: 'custom' },
          maxOutputTokens: 1024,
        },
      }),
      stream: false,
    });

    expect(result.outcome.type).toBe('done');
    expect(result.events.slice(0, 3).map((event) => event.type)).toEqual([
      'llm.started',
      'llm.requested',
      'llm.notice',
    ]);
    expect(result.events[2]).toMatchObject({
      type: 'llm.notice',
      notice: {
        source: 'legalize-model',
        code: 'anthropic-thinking-effort-not-listed',
        data: { effort: 'custom', knownEfforts: ['low'] },
      },
    });

    const warnings: unknown[][] = [];
    const debugLogs: unknown[][] = [];
    setLog({
      debug: (...args) => debugLogs.push(args),
      info: () => {},
      warn: (...args) => warnings.push(args),
      error: () => {},
    });
    const requests: Array<{ params: Record<string, unknown> }> = [];
    const kimi = {
      ...kimiOpenAIProtocol,
      send: async (_client: unknown, request: { params: Record<string, unknown> }) => {
        requests.push(request);
        return {
          body: openAICompletion({ content: 'ok' }, { finishReason: 'stop' }),
          headers: {},
        };
      },
    };
    const duplicated = await runGenerate(kimi, {
      module: testModule({
        profile: {
          tools: [
            { name: 'weather', description: 'old top', parameters: { type: 'object' } },
            {
              name: 'weather',
              description: 'new top',
              parameters: { type: 'object' },
              deferred: true,
            },
          ],
        },
        messages: [
          {
            role: 'system',
            content: [{ type: 'text', text: 'older' }],
            tools: [
              { name: 'weather', description: 'old system', parameters: { type: 'object' } },
              { name: 'local', description: 'old local', parameters: { type: 'object' } },
            ],
          },
          {
            role: 'system',
            content: [],
            tools: [
              { name: 'weather', description: 'new system', parameters: { type: 'object' } },
              { name: 'local', description: 'new local', parameters: { type: 'object' } },
            ],
          },
          {
            role: 'system',
            content: [],
            tools: [
              { name: 'weather', description: 'empty after dedupe', parameters: { type: 'object' } },
            ],
          },
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        ],
      }),
      stream: false,
    });

    expect(duplicated.outcome.type).toBe('done');
    expect(duplicated.events.filter((event) => event.type === 'llm.notice')).toMatchObject([
      {
        notice: {
          source: 'legalize-tools',
          code: 'duplicate_tool_declaration',
          data: { name: 'weather', kept: 'profile.tools[1]', dropped: 4 },
        },
      },
      {
        notice: {
          source: 'legalize-tools',
          code: 'duplicate_tool_declaration',
          data: { name: 'local', kept: 'messages[1].tools[1]', dropped: 1 },
        },
      },
    ]);
    expect(warnings).toMatchObject([
      [{ name: 'weather', kept: 'profile.tools[1]', dropped: 4 }, expect.any(String)],
      [{ name: 'local', kept: 'messages[1].tools[1]', dropped: 1 }, expect.any(String)],
    ]);
    expect(debugLogs).toContainEqual([{ pass: 'legalize-tools' }, 'llm encode stage']);
    expect(requests[0]?.params).toMatchObject({
      tools: [{
        type: 'function',
        function: { name: 'weather', description: 'new top', parameters: { type: 'object' } },
      }],
    });
  });
});
