// Historical coverage: issue #149, #520, #1952, #3149 and #4012; PR #3101 and #4977.
import { describe, expect, it } from 'bun:test';

import { openAIProtocol } from '#/llm/builtin/protocol/openai/index';
import {
  createAssistantMessage,
  createMessageAccumulator,
  type StreamedMessagePart,
} from '#/llm/message';
import { emptyResponseError } from '#/llm/policy/settle';
import type { LlmModelSpec } from '#/llm/request';
import { NO_FINISH } from '#/llm/response';

import {
  asyncChunks,
  failedOutcome,
  openAIChunk,
  openAICompletion,
  runGenerate,
  testModule,
} from '../harness';

function accumulatedMessage(parts: readonly StreamedMessagePart[]) {
  const accumulator = createMessageAccumulator();
  for (const part of parts) accumulator.push(part);
  return accumulator.finish();
}

function statusError(statusCode: number, message: string) {
  return {
    kind: 'status' as const,
    message,
    statusCode,
    requestId: null,
    retryAfterMs: null,
    headers: null,
    retryable: statusCode >= 500,
  };
}

describe('LLM final outcomes', () => {
  it('as a user, I want empty and thinking-only responses to be distinguished from visible output', () => {
    const model: LlmModelSpec = { provider: 'test', name: 'test-model' };
    const empty = accumulatedMessage([]);
    expect(emptyResponseError(empty, model, NO_FINISH)).toMatchObject({
      kind: 'empty_response',
      finishReason: null,
      rawFinishReason: null,
      retryable: true,
    });
    expect(emptyResponseError(empty, model, {
      finishReason: 'filtered',
      rawFinishReason: 'content_filter',
    })).toMatchObject({ kind: 'empty_response', retryable: false });
    expect(
      emptyResponseError(accumulatedMessage([{ type: 'think', think: 'reasoning' }]), model, NO_FINISH)
        ?.message,
    ).toContain('only thinking content');
    expect(
      emptyResponseError(accumulatedMessage([{ type: 'text', text: '  \n' }]), model, NO_FINISH),
    ).toBeNull();
    expect(
      emptyResponseError(
        accumulatedMessage([
          { type: 'think', think: 'reasoning' },
          { type: 'text', text: ' ' },
        ]),
        model,
        NO_FINISH,
      )?.message,
    ).toContain('only thinking content');
    expect(
      emptyResponseError(accumulatedMessage([{ type: 'text', text: 'hi' }]), model, NO_FINISH),
    ).toBeNull();
    expect(
      emptyResponseError(
        createAssistantMessage([], [{ type: 'function', id: 'call_1', name: 'tool', arguments: '{}' }]),
        model,
        NO_FINISH,
      ),
    ).toBeNull();
  });

  it('as a user, I want repeated provider output to fail with an empty-response error', async () => {
    const model: LlmModelSpec = { provider: 'test', name: 'test-model' };
    const finish = { finishReason: 'other', rawFinishReason: 'repeat' } as const;
    for (const message of [
      accumulatedMessage([{ type: 'text', text: 'repeated text' }]),
      accumulatedMessage([{ type: 'function', id: 'call_1', name: 'tool', arguments: '{}' }]),
    ]) {
      expect(emptyResponseError(message, model, finish)).toMatchObject({
        kind: 'empty_response',
        rawFinishReason: 'repeat',
        retryable: true,
        message: expect.stringContaining('repeated output'),
      });
    }

    const protocol = {
      ...openAIProtocol,
      sendStream: async () => ({
        body: asyncChunks([openAIChunk({ content: 'repeated text' }, { finishReason: 'repeat' })]),
        headers: {},
      }),
    };
    const repeated = failedOutcome((await runGenerate(protocol, {
      module: testModule(),
    })).outcome);
    expect(repeated.error).toMatchObject({
      kind: 'empty_response',
      rawFinishReason: 'repeat',
      retryable: true,
      message: expect.stringContaining('repeated output'),
    });
  });

  it('as a user, I want invalid thinking configuration and HTTP failures to be classified, and aborted streams to preserve partial output', async () => {
    let sends = 0;
    const syntaxProtocol = {
      ...openAIProtocol,
      sendStream: async () => {
        sends += 1;
        return { body: asyncChunks([]), headers: {} };
      },
    };
    const syntax = failedOutcome((await runGenerate(syntaxProtocol, {
      module: testModule({
        model: {
          spec: { provider: 'test', name: 'test-model', capability: { thinking: false } },
          thinking: { effort: 'high' },
        },
      }),
    })).outcome);
    expect(syntax.error).toMatchObject({ kind: 'syntax', code: 'thinking_config' });
    expect(sends).toBe(0);

    const providerProtocol = {
      ...openAIProtocol,
      sendStream: async () => {
        throw Object.assign(new Error('provider unavailable'), { status: 500 });
      },
      decodeError: () => statusError(500, 'provider unavailable'),
    };
    const provider = failedOutcome((await runGenerate(providerProtocol, {
      module: testModule(),
    })).outcome);
    expect(provider.error).toMatchObject({
      kind: 'status',
      message: 'provider unavailable',
      statusCode: 500,
      retryable: true,
    });

    const controller = new AbortController();
    const abortProtocol = {
      ...openAIProtocol,
      sendStream: async (_client: unknown, _request: unknown, signal: AbortSignal) => ({
        body: (async function* () {
          yield openAIChunk({ content: 'partial' });
          if (signal.aborted) throw signal.reason;
          await new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        })(),
        headers: {},
      }),
    };
    const aborted = await runGenerate(abortProtocol, {
      module: testModule(),
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'llm.streaming.part') controller.abort();
      },
    });
    expect(aborted.outcome).toMatchObject({
      type: 'aborted',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'partial' }],
        toolCalls: [],
        attributes: { source: 'salvaged' },
      },
      reason: { kind: 'abort' },
    });
    expect(aborted.events.at(-1)).toMatchObject({
      type: 'llm.ended',
      outcome: { type: 'aborted' },
    });
  });

  it('as a user, I want turning thinking off to use the model declared off effort', async () => {
    const requests: Array<{ params: Record<string, unknown> }> = [];
    const protocol = {
      ...openAIProtocol,
      send: async (_client: unknown, request: { params: Record<string, unknown> }) => {
        requests.push(request);
        return {
          body: openAICompletion({ content: 'ok' }, { finishReason: 'stop' }),
          headers: {},
        };
      },
    };

    const result = await runGenerate(protocol, {
      module: testModule({
        model: {
          spec: {
            provider: 'openai',
            name: 'test-model',
            capability: { thinking: true },
            thinking: { offEffort: 'none' },
          },
          thinking: { effort: 'off' },
        },
      }),
      stream: false,
    });

    expect(result.outcome.type).toBe('done');
    expect(requests[0]?.params).toMatchObject({ reasoning_effort: 'none' });
  });

  it('as a user, I want always-thinking models to reject disabling thinking before any provider request', async () => {
    let sends = 0;
    const protocol = {
      ...openAIProtocol,
      sendStream: async () => {
        sends += 1;
        return { body: asyncChunks([]), headers: {} };
      },
    };
    const result = await runGenerate(protocol, {
      module: testModule({
        model: {
          spec: {
            provider: 'openai',
            name: 'test-model',
            capability: { thinking: true },
            thinking: { alwaysThinking: true, supportEfforts: ['low', 'high'] },
          },
          thinking: { effort: 'off' },
        },
      }),
    });

    expect(result.outcome).toMatchObject({
      type: 'failed',
      error: { kind: 'syntax', code: 'thinking_config' },
    });
    expect(sends).toBe(0);
    expect(result.events.map((event) => event.type)).toEqual(['llm.started', 'llm.ended']);
  });
});
