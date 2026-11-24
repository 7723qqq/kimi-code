// Historical coverage: issue #451 and #4334; PR #92, #201, #3624, #3734 and #4574.
import { describe, expect, it } from 'bun:test';

import { createMediaDegradeRecovery } from '#/llm/builtin/policy/media-degrade';
import { openAIProtocol } from '#/llm/builtin/protocol/openai/index';
import type { LlmRecovery } from '#/llm/policy/recovery';
import type { LlmRemoteErrorMessage } from '#/llm/response';

type OpenAIModule = Parameters<typeof openAIProtocol.encode>[0];

import {
  asyncChunks,
  doneOutcome,
  openAIChunk,
  runGenerate,
  testModule,
} from '../harness';

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

function decodeError(error: unknown): LlmRemoteErrorMessage {
  const status = (error as { status?: unknown }).status;
  if (status === 429) {
    return {
      kind: 'rate_limit',
      message: 'retry',
      statusCode: 429,
      requestId: null,
      retryAfterMs: 1,
      headers: null,
      retryable: true,
    };
  }
  if (status === 413) {
    return {
      kind: 'request_too_large',
      message: 'request too large',
      requestId: null,
      retryAfterMs: null,
      headers: null,
      retryable: true,
    };
  }
  if ((error as { kind?: unknown }).kind === 'connection') {
    return { kind: 'connection', message: 'connection lost', retryable: true };
  }
  return {
    kind: 'provider',
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
}

function successfulStream(text = 'ok', headers: Record<string, string> = {}) {
  return {
    body: asyncChunks([openAIChunk({ content: text }, { finishReason: 'stop' })]),
    headers,
  };
}

function mediaMessage(id: string) {
  return {
    role: 'user' as const,
    content: [{ type: 'image_url' as const, imageUrl: { url: `data:image/png;base64,${id}` } }],
  };
}

describe('LLM retry boundaries', () => {
  it('as a user, I want a backoff retry to start a fresh requested delta segment', async () => {
    let sends = 0;
    const protocol = {
      ...openAIProtocol,
      sendStream: async () => {
        sends += 1;
        if (sends === 1) throw httpError(429, 'retry');
        return successfulStream('ok', { 'x-request-id': 'req-success' });
      },
      decodeError,
    };

    const result = await runGenerate(protocol, {
      module: testModule(),
      policy: { retry: { maxAttemptsPerStep: 2 } },
    });

    expect(doneOutcome(result.outcome).message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(sends).toBe(2);
    const retry = result.events.findIndex((event) => event.type === 'llm.retrying');
    expect(retry).toBeGreaterThanOrEqual(0);
    expect(result.events[retry]).toMatchObject({
      reason: 'backoff',
      failedAttempt: 1,
      nextAttempt: 2,
      delayMs: 1,
    });
    expect(result.events.slice(0, retry).some((event) => event.type === 'llm.streaming.finish')).toBe(false);
    expect(result.events.some((event) => event.type === 'llm.streaming.part')).toBe(true);
  });

  it('as a user, I want recovery to rewrite the next real request and start a fresh delta segment', async () => {
    const recovery: LlmRecovery = {
      propose: ({ appliedRecoveries }) => appliedRecoveries.length > 0
        ? undefined
        : {
            strategy: 'test-recovery',
            action: 'rewrite',
            rewrite: (request) => ({
              ...request,
              model: { ...request.model, cacheKey: 'recovered' },
            }),
          },
    };
    const modules: OpenAIModule[] = [];
    let sends = 0;
    const protocol = {
      ...openAIProtocol,
      encode: (module: OpenAIModule) => {
        modules.push(module);
        return openAIProtocol.encode(module);
      },
      sendStream: async () => {
        sends += 1;
        if (sends === 1) {
          return {
            body: (async function* () {
              yield openAIChunk({ content: 'partial' });
              throw Object.assign(new Error('connection lost'), { kind: 'connection' });
            })(),
            headers: { 'x-request-id': 'req-failed' },
          };
        }
        return successfulStream('ok', { 'x-request-id': 'req-success' });
      },
      decodeError,
    };

    const result = await runGenerate(protocol, {
      module: testModule(),
      policy: { retry: { maxAttemptsPerStep: 1 }, recoveries: [recovery] },
    });

    expect(doneOutcome(result.outcome).message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(sends).toBe(2);
    expect(modules[1]?.model.cacheKey).toBe('recovered');
    const retry = result.events.findIndex((event) => event.type === 'llm.retrying');
    expect(result.events[retry]).toMatchObject({
      reason: 'recovery',
      strategy: 'test-recovery',
      action: 'rewrite',
      message: { content: [{ type: 'text', text: 'partial' }] },
    });
    expect(result.events.slice(0, retry).some((event) => event.type === 'llm.streaming.finish')).toBe(false);
  });

  it('as a user, I want aborting backoff to prevent another provider request', async () => {
    const controller = new AbortController();
    let sends = 0;
    const protocol = {
      ...openAIProtocol,
      sendStream: async () => {
        sends += 1;
        throw httpError(429, 'retry later');
      },
      decodeError,
    };

    const result = await runGenerate(protocol, {
      module: testModule(),
      signal: controller.signal,
      policy: { retry: { maxAttemptsPerStep: 2 } },
      onEvent: (event) => {
        if (event.type === 'llm.retrying') controller.abort('stop backoff');
      },
    });

    expect(result.outcome).toMatchObject({ type: 'aborted', reason: 'stop backoff' });
    expect(sends).toBe(1);
    expect(result.events.map((event) => event.type)).toEqual([
      'llm.started',
      'llm.sent',
      'llm.retrying',
      'llm.ended',
    ]);
  });

  it('as a user, I want a disconnected stream to retry without repeating partial content', async () => {
    let sends = 0;
    const protocol = {
      ...openAIProtocol,
      sendStream: async () => {
        sends += 1;
        if (sends === 1) {
          return {
            body: (async function* () {
              yield openAIChunk({ content: 'partial' });
              throw Object.assign(new Error('connection lost'), { kind: 'connection' });
            })(),
            headers: { 'x-request-id': 'req-disconnected' },
          };
        }
        return successfulStream('ok', { 'x-request-id': 'req-success' });
      },
      decodeError,
    };

    const result = await runGenerate(protocol, {
      module: testModule(),
      policy: { retry: { maxAttemptsPerStep: 2 } },
    });

    expect(doneOutcome(result.outcome).message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(sends).toBe(2);
    const retry = result.events.findIndex((event) => event.type === 'llm.retrying');
    expect(result.events[retry]).toMatchObject({ reason: 'backoff' });
    expect(result.events.slice(0, retry).some((event) => event.type === 'llm.streaming.finish')).toBe(false);
    expect(result.events.some(
      (event) => event.type === 'llm.streaming.part' &&
        event.part.type === 'text' &&
        event.part.text === 'partial',
    )).toBe(true);
  });

  it('as a user, I want oversized media requests to recover with a compatible rewritten request', async () => {
    const modules: OpenAIModule[] = [];
    let sends = 0;
    const protocol = {
      ...openAIProtocol,
      encode: (module: OpenAIModule) => {
        modules.push(module);
        return openAIProtocol.encode(module);
      },
      sendStream: async () => {
        sends += 1;
        if (sends === 1) throw httpError(413, 'request too large');
        return successfulStream('recovered', { 'x-request-id': 'req-success' });
      },
      decodeError,
    };

    const result = await runGenerate(protocol, {
      module: testModule({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Look at this image' },
            { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
          ],
        }],
      }),
      policy: {
        retry: { maxAttemptsPerStep: 1 },
        recoveries: [createMediaDegradeRecovery()],
      },
    });

    expect(doneOutcome(result.outcome).message.content).toEqual([{ type: 'text', text: 'recovered' }]);
    expect(result.events.find((event) => event.type === 'llm.retrying')).toMatchObject({
      reason: 'recovery',
      strategy: 'media-degrade',
      action: 'stripped',
    });
    expect(modules).toHaveLength(2);
    expect(JSON.stringify(modules[0]?.content.messages)).toContain('data:image/png;base64,AAAA');
    const recovered = JSON.stringify(modules[1]?.content.messages);
    expect(recovered).not.toContain('data:image/png;base64,AAAA');
    expect(recovered).toContain('[image omitted for provider compatibility');
  });

  it('as a user, I want oversized requests to drop only older media and send the degraded placeholder text', async () => {
    const modules: OpenAIModule[] = [];
    let sends = 0;
    const protocol = {
      ...openAIProtocol,
      encode: (module: OpenAIModule) => {
        modules.push(module);
        return openAIProtocol.encode(module);
      },
      sendStream: async () => {
        sends += 1;
        if (sends === 1) throw httpError(413, 'request too large');
        return successfulStream('recovered', { 'x-request-id': 'req-success' });
      },
      decodeError,
    };

    const result = await runGenerate(protocol, {
      module: testModule({
        messages: [mediaMessage('OLDER'), mediaMessage('RECENT1'), mediaMessage('RECENT2')],
      }),
      policy: {
        retry: { maxAttemptsPerStep: 1 },
        recoveries: [createMediaDegradeRecovery()],
      },
    });

    expect(doneOutcome(result.outcome).message.content).toEqual([{ type: 'text', text: 'recovered' }]);
    expect(result.events.find((event) => event.type === 'llm.retrying')).toMatchObject({
      reason: 'recovery',
      strategy: 'media-degrade',
      action: 'degraded',
    });
    expect(modules).toHaveLength(2);
    const recovered = JSON.stringify(modules[1]?.content.messages);
    expect(recovered).not.toContain('data:image/png;base64,OLDER');
    expect(recovered).toContain('data:image/png;base64,RECENT1');
    expect(recovered).toContain('data:image/png;base64,RECENT2');
    expect(recovered).toContain(
      '[image omitted: dropped to fit the provider request size limit; re-read the file to view it]',
    );
  });
});
