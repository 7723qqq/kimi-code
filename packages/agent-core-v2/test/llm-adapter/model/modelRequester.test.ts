import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { isError2 } from '#/_base/errors/errors';
import {
  APIEmptyResponseError,
  APITimeoutError,
  ChatProviderError,
  PROVIDER_API_ERROR_CODE,
  PROVIDER_AUTH_ERROR_CODE,
  isAbortError,
} from '#/llm-adapter/contract/errors';
import { type Message } from '#/llm-adapter/contract/message';
import { type Model } from '#/llm-adapter/model/catalog';
import { type ModelRequestEvent } from '#/llm-adapter/model/model-requester';
import { effectiveMaxCompletionTokens } from '#/llm-adapter/model/model-requester';
import {
  buildStreamTiming,
  carriesOutputTokens,
  ModelRequesterImpl,
  type ModelLlmGateway,
} from '#/llm-adapter/model/model-requester-impl';
import {
  createOAuthCredentialProvider,
  createStaticCredentialProvider,
} from '#human/credentials/credentials';
import { type ProviderMediaContribution } from '#human/llm/media/upload';
import { type LlmModel } from '#human/llm/model';
import { createOpenAIRequester } from '#human/llm/requester/bases/openai/requester';
import {
  type LlmRequestConfig,
  type LlmRequestContent,
  type LlmRequestControl,
  type LlmRequestEvent,
  type LlmRequester,
} from '#human/llm/requester/requester';

import { startMockUpstream } from '../../helpers/mockUpstream';

class FakeLlmRequester implements LlmRequester {
  readonly calls: Array<{
    config: LlmRequestConfig;
    content: LlmRequestContent;
    control: LlmRequestControl;
  }> = [];

  handler: (callIndex: number, emit: (event: LlmRequestEvent) => void) => void | Promise<void> =
    () => {};

  async generate(
    config: LlmRequestConfig,
    content: LlmRequestContent,
    control: LlmRequestControl,
  ): Promise<void> {
    this.calls.push({ config, content, control });
    await this.handler(this.calls.length - 1, (event) => control.onEvent?.(event));
  }
}

const BASE_LLM_MODEL: LlmModel = {
  provider: 'fake',
  model: 'fake-model',
  capability: {
    image_in: false,
    video_in: false,
    audio_in: false,
    thinking: false,
    tool_use: true,
  },
  maxContextSize: 128000,
};

function gatewayReturning(
  requester: LlmRequester,
  media?: ProviderMediaContribution,
  llmModel: LlmModel = BASE_LLM_MODEL,
): ModelLlmGateway {
  return {
    resolve: () => ({ requester, protocol: 'openai', model: llmModel, media }),
  };
}

function emitAll(emit: (event: LlmRequestEvent) => void, events: readonly LlmRequestEvent[]): void {
  for (const event of events) emit(event);
}

function textStream(emit: (event: LlmRequestEvent) => void, text = 'hello'): void {
  emitAll(emit, [
    { type: 'llm.sent' },
    { type: 'llm.streaming.part', part: { type: 'text', text } },
    {
      type: 'llm.streaming.finish',
      finish: { finishReason: 'completed', rawFinishReason: 'stop' },
    },
    { type: 'llm.done' },
  ]);
}

function modelWith(credentialProvider: Model['credentialProvider']): Model {
  return {
    id: 'm1',
    name: 'fake-model',
    aliases: [],
    protocol: 'openai',
    headers: {},
    capabilities: {
      image_in: false,
      video_in: false,
      audio_in: false,
      thinking: false,
      tool_use: true,
      max_context_tokens: 128000,
    },
    maxContextSize: 128000,
    alwaysThinking: false,
    providerType: 'fake',
    providerName: 'fake',
    credentialProvider,
  };
}

async function collect(stream: AsyncIterable<ModelRequestEvent>): Promise<ModelRequestEvent[]> {
  const events: ModelRequestEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const INPUT = { systemPrompt: 'sys', tools: [], messages: [] };

describe('ModelRequesterImpl request execution', () => {
  it('separates tagged upstream reasoning from the finished answer', async () => {
    const reasoning =
      'Verifying focused source behaviorChecking patch onlyRebuilding one endpoint****Narrowing next scope';
    const upstream = startMockUpstream({
      kind: 'text',
      chunks: ['<thi', 'nking>', reasoning, '</thinking>', 'Answer'],
    });
    try {
      const impl = new ModelRequesterImpl(modelWith(createStaticCredentialProvider('sk-mock')), {
        resolve: () => ({
          requester: createOpenAIRequester(),
          protocol: 'openai',
          model: { ...BASE_LLM_MODEL, baseUrl: upstream.baseUrl },
        }),
      });
      const events = await collect(impl.request(INPUT));
      expect(events.filter((event) => event.type === 'part').map((event) => event.part)).toEqual([
        { type: 'think', think: reasoning },
        { type: 'text', text: 'Answer' },
      ]);
      const finish = events.find((event) => event.type === 'finish');
      expect(finish?.type === 'finish' ? finish.message.content : undefined).toEqual([
        { type: 'think', think: reasoning },
        { type: 'text', text: 'Answer' },
      ]);
    } finally {
      await upstream.close();
    }
  });

  it('maps ModelRequestParams onto LlmRequestConfig, content and control', async () => {
    const requester = new FakeLlmRequester();
    requester.handler = (_i, emit) => textStream(emit);
    const impl = new ModelRequesterImpl(
      modelWith(createStaticCredentialProvider('sk-1')),
      gatewayReturning(requester),
    );
    const signal = AbortSignal.timeout(1000);
    const messages: Message[] = [
      {
        role: 'system',
        content: [{ type: 'text', text: 's' }],
        toolCalls: [],
        tools: [{ name: 'decl', description: 'd', parameters: {} }],
      },
      { role: 'user', content: [{ type: 'text', text: 'u' }], toolCalls: [] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'a' }],
        toolCalls: [{ type: 'function', id: 'c1', name: 't', arguments: '{}' }],
        partial: true,
      },
      { role: 'tool', content: [{ type: 'text', text: 'r' }], toolCalls: [], toolCallId: 'c1' },
    ];

    await collect(
      impl.request(
        {
          systemPrompt: 'sys',
          tools: [
            { name: 'a', description: 'da', parameters: {} },
            { name: 'b', description: 'db', parameters: {}, deferred: true },
          ],
          messages,
          responseFormat: { type: 'json_object' },
        },
        signal,
        {
          cacheKey: 'session-1',
          sampling: { temperature: 0.5, topP: 0.9 },
          thinkingEffort: 'high',
          thinkingKeep: 'all',
          maxCompletionTokens: 1024,
          usedContextTokens: 5000,
          maxContextTokens: 128000,
        },
      ),
    );

    expect(requester.calls).toHaveLength(1);
    const call = requester.calls[0]!;
    expect(call.config.systemPrompt).toBe('sys');
    expect(call.config.tools).toEqual([{ name: 'a', description: 'da', parameters: {} }]);
    expect(call.config.cacheKey).toBe('session-1');
    expect(call.config.thinking).toEqual({ effort: 'high', keep: 'all' });
    expect(call.config.responseFormat).toEqual({ type: 'json_object' });
    expect(call.config.maxCompletionTokens).toBe(1024);
    expect(call.config.maxContextTokens).toBe(128000);
    expect(call.config.extraParams).toEqual({ openai: { temperature: 0.5, top_p: 0.9 } });
    expect(call.config.model.apiKey).toBe('sk-1');
    expect(call.content.usedContextTokens).toBe(5000);
    expect(call.content.messages).toEqual([
      {
        role: 'system',
        content: [{ type: 'text', text: 's' }],
        tools: [{ name: 'decl', description: 'd', parameters: {} }],
      },
      { role: 'user', content: [{ type: 'text', text: 'u' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'a' }],
        toolCalls: [{ type: 'function', id: 'c1', name: 't', arguments: '{}' }],
      },
      { role: 'tool', content: [{ type: 'text', text: 'r' }], toolCallId: 'c1' },
    ]);
    expect(call.control.signal).toBe(signal);
  });

  it('sends the session header on every model request', async () => {
    const requester = new FakeLlmRequester();
    requester.handler = (_i, emit) => textStream(emit);
    const impl = new ModelRequesterImpl(
      modelWith(createStaticCredentialProvider('sk-1')),
      gatewayReturning(requester),
    );

    await collect(impl.request(INPUT, undefined, { sessionId: 'session-123' }));

    expect(requester.calls[0]?.config.model.defaultHeaders).toEqual({
      'x-opencode-session': 'session-123',
    });
  });

  it('keeps existing model headers beside the session header', async () => {
    const requester = new FakeLlmRequester();
    requester.handler = (_i, emit) => textStream(emit);
    const impl = new ModelRequesterImpl(
      modelWith(createStaticCredentialProvider('sk-1')),
      gatewayReturning(requester, undefined, {
        ...BASE_LLM_MODEL,
        defaultHeaders: { 'x-tenant': 'acme' },
      }),
    );

    await collect(impl.request(INPUT, undefined, { sessionId: 'session-456' }));

    expect(requester.calls[0]?.config.model.defaultHeaders).toEqual({
      'x-tenant': 'acme',
      'x-opencode-session': 'session-456',
    });
  });

  it('keeps an explicitly configured session header', async () => {
    const requester = new FakeLlmRequester();
    requester.handler = (_i, emit) => textStream(emit);
    const impl = new ModelRequesterImpl(
      modelWith(createStaticCredentialProvider('sk-1')),
      gatewayReturning(requester, undefined, {
        ...BASE_LLM_MODEL,
        defaultHeaders: { 'X-Opencode-Session': 'configured-session' },
      }),
    );

    await collect(impl.request(INPUT, undefined, { sessionId: 'session-789' }));

    expect(requester.calls[0]?.config.model.defaultHeaders).toEqual({
      'X-Opencode-Session': 'configured-session',
    });
  });

  it('uses a process session id when no session is provided', async () => {
    const requester = new FakeLlmRequester();
    requester.handler = (_i, emit) => textStream(emit);
    const impl = new ModelRequesterImpl(
      modelWith(createStaticCredentialProvider('sk-1')),
      gatewayReturning(requester),
    );

    await collect(impl.request(INPUT));

    expect(requester.calls[0]?.config.model.defaultHeaders?.['x-opencode-session']).toMatch(
      /^ses_/,
    );
  });

  it('omits the thinking intent when no effort is requested', async () => {
    const requester = new FakeLlmRequester();
    requester.handler = (_i, emit) => textStream(emit);
    const impl = new ModelRequesterImpl(
      modelWith(createStaticCredentialProvider()),
      gatewayReturning(requester),
    );
    await collect(impl.request(INPUT));
    expect(requester.calls[0]?.config.thinking).toBeUndefined();
    expect(requester.calls[0]?.config.extraParams).toBeUndefined();
    expect(requester.calls[0]?.config.model.apiKey).toBeUndefined();
  });

  it('streams part, usage, finish and timing events exactly once', async () => {
    const requester = new FakeLlmRequester();
    requester.handler = (_i, emit) =>
      emitAll(emit, [
        { type: 'llm.sent' },
        { type: 'llm.streaming.headers', headers: { 'x-trace-id': 'trace-1' } },
        { type: 'llm.streaming.part', part: { type: 'text', text: 'he' } },
        { type: 'llm.streaming.part', part: { type: 'text', text: 'llo' } },
        {
          type: 'llm.streaming.part',
          part: { type: 'function', id: 'call-1', name: 'do', arguments: '{"a"', _streamIndex: 0 },
        },
        {
          type: 'llm.streaming.part',
          part: { type: 'tool_call_part', argumentsPart: ':1}', index: 0 },
        },
        { type: 'llm.streaming.usage', usage: { inputOther: 10 } },
        { type: 'llm.streaming.usage', usage: { output: 7 } },
        {
          type: 'llm.streaming.finish',
          finish: { finishReason: 'tool_calls', rawFinishReason: 'tool_calls' },
        },
        { type: 'llm.streaming.message_id', messageId: 'msg-42' },
        { type: 'llm.done' },
      ]);
    const traceIds: Array<string | null> = [];
    const impl = new ModelRequesterImpl(
      modelWith(createStaticCredentialProvider()),
      gatewayReturning(requester),
    );
    const events = await collect(
      impl.request(INPUT, undefined, { onTraceId: (id) => traceIds.push(id) }),
    );

    expect(events.map((e) => e.type)).toEqual([
      'part',
      'part',
      'part',
      'part',
      'usage',
      'finish',
      'timing',
    ]);
    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toMatchObject({ usage: { inputOther: 10, output: 7 }, model: 'fake-model' });
    const finish = events.find((e) => e.type === 'finish');
    expect(finish).toMatchObject({
      id: 'msg-42',
      traceId: 'trace-1',
      providerFinishReason: 'tool_calls',
      rawFinishReason: 'tool_calls',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
        toolCalls: [{ type: 'function', id: 'call-1', name: 'do', arguments: '{"a":1}' }],
      },
    });
    const timing = events.find((e) => e.type === 'timing');
    expect(timing).toMatchObject({
      firstTokenLatencyMs: expect.any(Number),
      streamDurationMs: expect.any(Number),
    });
    expect(traceIds).toEqual(['trace-1']);
  });

  it('surfaces a 401 as provider.auth_error without replaying', async () => {
    const requester = new FakeLlmRequester();
    requester.handler = (_i, emit) =>
      emit({
        type: 'llm.failed.remote',
        error: {
          kind: 'status',
          statusCode: 401,
          message: 'account rejected',
          requestId: null,
          retryAfterMs: null,
          headers: null,
          retryable: false,
        },
      });
    const impl = new ModelRequesterImpl(
      modelWith(createOAuthCredentialProvider(() => Promise.resolve('tok'))),
      gatewayReturning(requester),
    );

    const failure = await collect(impl.request(INPUT)).catch((error: unknown) => error);
    expect(isError2(failure)).toBe(true);
    expect((failure as { code: string }).code).toBe(PROVIDER_AUTH_ERROR_CODE);
    expect((failure as Error).message).toContain('account rejected');
    expect(requester.calls).toHaveLength(1);
  });

  it('does not replay 401s against static credentials', async () => {
    const requester = new FakeLlmRequester();
    requester.handler = (_i, emit) =>
      emit({
        type: 'llm.failed.remote',
        error: {
          kind: 'status',
          statusCode: 401,
          message: 'bad key',
          requestId: null,
          retryAfterMs: null,
          headers: null,
          retryable: false,
        },
      });
    const impl = new ModelRequesterImpl(
      modelWith(createStaticCredentialProvider('sk-bad')),
      gatewayReturning(requester),
    );

    const failure = await collect(impl.request(INPUT)).catch((error: unknown) => error);
    expect((failure as { code: string }).code).toBe(PROVIDER_AUTH_ERROR_CODE);
    expect(requester.calls).toHaveLength(1);
  });

  it('translates remote, syntax and empty-response failures and rethrows aborts untouched', async () => {
    const requester = new FakeLlmRequester();
    requester.handler = (_i, emit) =>
      emit({
        type: 'llm.failed.remote',
        error: {
          kind: 'status',
          statusCode: 500,
          message: 'boom',
          requestId: null,
          retryAfterMs: null,
          headers: null,
          retryable: true,
        },
      });
    const impl = new ModelRequesterImpl(
      modelWith(createStaticCredentialProvider()),
      gatewayReturning(requester),
    );
    const failure = await collect(impl.request(INPUT)).catch((error: unknown) => error);
    expect((failure as { code: string }).code).toBe(PROVIDER_API_ERROR_CODE);

    requester.handler = (_i, emit) =>
      emit({
        type: 'llm.failed.syntax',
        error: { kind: 'syntax', code: 'request_format', message: 'bad request shape' },
      });
    const syntaxFailure = await collect(impl.request(INPUT)).catch((error: unknown) => error);
    expect(syntaxFailure).toBeInstanceOf(ChatProviderError);
    expect((syntaxFailure as { code: string }).code).toBe(PROVIDER_API_ERROR_CODE);

    requester.handler = (_i, emit) =>
      emit({
        type: 'llm.failed.remote',
        error: { kind: 'abort', message: 'aborted', retryable: false },
      });
    const aborted = await collect(impl.request(INPUT)).catch((error: unknown) => error);
    expect(isAbortError(aborted)).toBe(true);

    requester.handler = (_i, emit) => emit({ type: 'llm.done' });
    const empty = await collect(impl.request(INPUT)).catch((error: unknown) => error);
    expect(empty).toBeInstanceOf(APIEmptyResponseError);
    expect((empty as { code: string }).code).toBe(PROVIDER_API_ERROR_CODE);
  });

  it('uploadVideo presence is the capability declaration', async () => {
    const requester = new FakeLlmRequester();
    const impl = new ModelRequesterImpl(
      modelWith(createStaticCredentialProvider('sk-1')),
      gatewayReturning(requester),
    );
    await expect(impl.uploadVideo('file-id')).rejects.toThrow(/does not support video upload/);

    const seen: Array<string | undefined> = [];
    const media: ProviderMediaContribution = {
      uploadVideo: (_video, options) => {
        seen.push(options.model.apiKey);
        return Promise.resolve({
          type: 'video_url',
          videoUrl: { url: 'https://cdn.example.test/v.mp4' },
        });
      },
    };
    const withMedia = new ModelRequesterImpl(
      modelWith(createStaticCredentialProvider('sk-1')),
      gatewayReturning(requester, media),
    );
    const part = await withMedia.uploadVideo({ data: new Uint8Array([1]), mimeType: 'video/mp4' });
    expect(part).toEqual({
      type: 'video_url',
      videoUrl: { url: 'https://cdn.example.test/v.mp4' },
    });
    expect(seen).toEqual(['sk-1']);
  });

  it('uploadImage presence is the capability declaration', async () => {
    const requester = new FakeLlmRequester();
    const impl = new ModelRequesterImpl(
      modelWith(createStaticCredentialProvider('sk-1')),
      gatewayReturning(requester),
    );
    await expect(
      impl.uploadImage({ data: new Uint8Array([1]), mimeType: 'image/png' }),
    ).rejects.toThrow(/does not support image upload/);

    const seen: Array<string | undefined> = [];
    const media: ProviderMediaContribution = {
      uploadImage: (_image, options) => {
        seen.push(options.model.apiKey);
        return Promise.resolve({
          type: 'image_url',
          imageUrl: { url: 'ms://img-1', id: 'img-1' },
        });
      },
    };
    const withMedia = new ModelRequesterImpl(
      modelWith(createStaticCredentialProvider('sk-1')),
      gatewayReturning(requester, media),
    );
    const part = await withMedia.uploadImage({ data: new Uint8Array([1]), mimeType: 'image/png' });
    expect(part).toEqual({ type: 'image_url', imageUrl: { url: 'ms://img-1', id: 'img-1' } });
    expect(seen).toEqual(['sk-1']);
  });

  it('checkUploadFailed resolves the credential and delegates to the provider checker', async () => {
    const requester = new FakeLlmRequester();
    const impl = new ModelRequesterImpl(
      modelWith(createStaticCredentialProvider('sk-1')),
      gatewayReturning(requester),
    );
    await expect(impl.checkUploadFailed('file-1')).resolves.toBe(false);

    const seen: Array<{ id: string; apiKey: string | undefined }> = [];
    const media: ProviderMediaContribution = {
      checkUploadFailed: (id, options) => {
        seen.push({ id, apiKey: options.model.apiKey });
        return Promise.resolve(id === 'failed-file');
      },
    };
    const withMedia = new ModelRequesterImpl(
      modelWith(createStaticCredentialProvider('sk-1')),
      gatewayReturning(requester, media),
    );

    await expect(withMedia.checkUploadFailed('failed-file')).resolves.toBe(true);
    await expect(withMedia.checkUploadFailed('ok-file')).resolves.toBe(false);
    expect(seen).toEqual([
      { id: 'failed-file', apiKey: 'sk-1' },
      { id: 'ok-file', apiKey: 'sk-1' },
    ]);
  });

  it('reports the event-loop-busy overlap of the decode window as clientBlockedMs', async () => {
    const requester = new FakeLlmRequester();
    requester.handler = (_i, emit) => {
      emit({ type: 'llm.sent' });
      emit({ type: 'llm.streaming.part', part: { type: 'text', text: 'a' } });
      const spinUntil = Date.now() + 150;
      while (Date.now() < spinUntil) {}
      emit({ type: 'llm.streaming.part', part: { type: 'text', text: 'b' } });
      emit({
        type: 'llm.streaming.finish',
        finish: { finishReason: 'completed', rawFinishReason: 'stop' },
      });
      emit({ type: 'llm.done' });
    };
    const impl = new ModelRequesterImpl(
      modelWith(createStaticCredentialProvider()),
      gatewayReturning(requester),
    );
    const events = await collect(impl.request(INPUT));
    const timing = events.find((event) => event.type === 'timing');
    expect(timing).toBeDefined();
    if (timing?.type !== 'timing') return;
    expect(timing.serverDecodeMs).toBeGreaterThanOrEqual(140);
    if (timing.clientBlockedMs === undefined) return;
    expect(timing.clientBlockedMs).toBeGreaterThanOrEqual(100);
  });
});

describe('stall watchdog', () => {
  const HEADERS_ENV = 'KIMI_CODE_LLM_HEADERS_TIMEOUT_MS';
  const BODY_ENV = 'KIMI_CODE_LLM_BODY_TIMEOUT_MS';
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved[HEADERS_ENV] = process.env[HEADERS_ENV];
    saved[BODY_ENV] = process.env[BODY_ENV];
    delete process.env[HEADERS_ENV];
    delete process.env[BODY_ENV];
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const stallingRequester = (before: (emit: (event: LlmRequestEvent) => void) => void) => {
    const requester = new FakeLlmRequester();
    requester.handler = (_index, emit) => {
      before(emit);
      return new Promise<void>(() => {});
    };
    return requester;
  };

  const failureOf = async (impl: ModelRequesterImpl): Promise<unknown> =>
    collect(impl.request(INPUT)).then(
      () => undefined,
      (error: unknown) => error,
    );

  it('keeps a slow stream alive while tag fragments are buffered', async () => {
    process.env[BODY_ENV] = '150';
    const upstream = startMockUpstream({
      kind: 'text',
      chunks: [...'<thinking>'.split(''), 'plan', ...'</thinking>'.split(''), 'answer'],
      gapMs: 25,
    });
    try {
      const requester = createOpenAIRequester();
      const impl = new ModelRequesterImpl(modelWith(createStaticCredentialProvider('sk-mock')), {
        resolve: () => ({
          requester,
          protocol: 'openai',
          model: { ...BASE_LLM_MODEL, baseUrl: upstream.baseUrl },
        }),
      });
      const events = await collect(impl.request(INPUT));
      const finish = events.find((event) => event.type === 'finish');
      expect(finish?.type === 'finish' ? finish.message.content : undefined).toEqual([
        { type: 'think', think: 'plan' },
        { type: 'text', text: 'answer' },
      ]);
      expect(events.filter((event) => event.type === 'part').map((event) => event.part)).toEqual([
        { type: 'think', think: 'plan' },
        { type: 'text', text: 'answer' },
      ]);
    } finally {
      await upstream.close();
    }
  });

  it('fails a stream that stops sending chunks and aborts the request', async () => {
    process.env[BODY_ENV] = '120';
    const requester = stallingRequester((emit) => {
      emit({ type: 'llm.sent' });
      emit({ type: 'llm.streaming.headers', headers: {} });
      emit({ type: 'llm.streaming.part', part: { type: 'text', text: 'x' } });
    });
    const impl = new ModelRequesterImpl(
      modelWith(createStaticCredentialProvider()),
      gatewayReturning(requester),
    );

    const failure = await failureOf(impl);

    expect(failure).toBeInstanceOf(APITimeoutError);
    expect((failure as APITimeoutError).message).toContain(BODY_ENV);
    expect((failure as APITimeoutError).retryable).toBe(true);
    expect(requester.calls[0]?.control.signal.aborted).toBe(true);
  }, 5_000);

  it('fails a request that never produces response headers', async () => {
    process.env[HEADERS_ENV] = '120';
    const requester = stallingRequester((emit) => {
      emit({ type: 'llm.sent' });
    });
    const impl = new ModelRequesterImpl(
      modelWith(createStaticCredentialProvider()),
      gatewayReturning(requester),
    );

    const failure = await failureOf(impl);

    expect(failure).toBeInstanceOf(APITimeoutError);
    expect((failure as APITimeoutError).message).toContain(HEADERS_ENV);
  }, 5_000);

  it('leaves a slow but alive stream alone when no budget is configured', async () => {
    const requester = new FakeLlmRequester();
    requester.handler = async (_index, emit) => {
      emit({ type: 'llm.sent' });
      emit({ type: 'llm.streaming.headers', headers: {} });
      emit({ type: 'llm.streaming.part', part: { type: 'text', text: 'a' } });
      await new Promise((resolve) => setTimeout(resolve, 200));
      emit({ type: 'llm.streaming.part', part: { type: 'text', text: 'b' } });
      emit({
        type: 'llm.streaming.finish',
        finish: { finishReason: 'completed', rawFinishReason: 'stop' },
      });
      emit({ type: 'llm.done' });
    };
    const impl = new ModelRequesterImpl(
      modelWith(createStaticCredentialProvider()),
      gatewayReturning(requester),
    );

    const events = await collect(impl.request(INPUT));

    expect(events.filter((event) => event.type === 'part')).toHaveLength(2);
    expect(events.some((event) => event.type === 'finish')).toBe(true);
  }, 5_000);
});

describe('effectiveMaxCompletionTokens', () => {
  it('reads the folded budget back from the params', () => {
    expect(effectiveMaxCompletionTokens(undefined)).toBeUndefined();
    expect(effectiveMaxCompletionTokens({})).toBeUndefined();
    expect(effectiveMaxCompletionTokens({ maxCompletionTokens: 512 })).toBe(512);
  });
});

describe('carriesOutputTokens', () => {
  it('accepts the part kinds counted in usage.output', () => {
    expect(carriesOutputTokens({ type: 'text', text: 'x' })).toBe(true);
    expect(carriesOutputTokens({ type: 'think', think: 'x' })).toBe(true);
    expect(carriesOutputTokens({ type: 'tool_call_part', argumentsPart: '{}' })).toBe(true);
  });

  it('rejects media parts, which describe the input side', () => {
    expect(carriesOutputTokens({ type: 'image_url', imageUrl: { url: 'kimi-file://a' } })).toBe(
      false,
    );
    expect(carriesOutputTokens({ type: 'audio_url', audioUrl: { url: 'kimi-file://b' } })).toBe(
      false,
    );
    expect(carriesOutputTokens({ type: 'video_url', videoUrl: { url: 'kimi-file://c' } })).toBe(
      false,
    );
  });
});

describe('buildStreamTiming', () => {
  it('returns base TTFT and stream duration only', () => {
    expect(buildStreamTiming(100, undefined, 250, 400, undefined)).toEqual({
      firstTokenLatencyMs: 150,
      streamDurationMs: 150,
    });
  });

  it('carries the token-bearing-part window when the stream reported one', () => {
    const timing = buildStreamTiming(100, undefined, 250, 4_000, undefined, {
      firstTokenAt: 1_000,
      lastTokenAt: 1_800,
    });
    expect(timing.llmFirstTokenOffsetMs).toBe(1_000);
    expect(timing.llmLastTokenOffsetMs).toBe(1_800);
  });

  it('omits the window when no token-bearing part was seen', () => {
    const timing = buildStreamTiming(100, undefined, 250, 400, undefined, {
      firstTokenAt: undefined,
      lastTokenAt: undefined,
    });
    expect(timing.llmFirstTokenOffsetMs).toBeUndefined();
    expect(timing.llmLastTokenOffsetMs).toBeUndefined();
  });

  it('splits TTFT across the request-sent boundary', () => {
    expect(buildStreamTiming(100, 180, 250, 400, undefined)).toEqual({
      firstTokenLatencyMs: 150,
      streamDurationMs: 150,
      requestBuildMs: 80,
      serverFirstTokenMs: 70,
    });
  });

  it('adds decode stats when present', () => {
    expect(
      buildStreamTiming(100, 120, 250, 400, { serverDecodeMs: 90, clientConsumeMs: 60 }),
    ).toEqual({
      firstTokenLatencyMs: 150,
      streamDurationMs: 150,
      requestBuildMs: 20,
      serverFirstTokenMs: 130,
      serverDecodeMs: 90,
      clientConsumeMs: 60,
    });
  });

  it('adds the blocked share of the decode window when reported', () => {
    expect(
      buildStreamTiming(100, 120, 250, 400, {
        serverDecodeMs: 10,
        clientConsumeMs: 60,
        clientBlockedMs: 80,
      }),
    ).toEqual({
      firstTokenLatencyMs: 150,
      streamDurationMs: 150,
      requestBuildMs: 20,
      serverFirstTokenMs: 130,
      serverDecodeMs: 10,
      clientConsumeMs: 60,
      clientBlockedMs: 80,
    });
  });
});
