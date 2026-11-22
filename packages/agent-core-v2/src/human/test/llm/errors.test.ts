import { describe, expect, it, mock } from 'bun:test';

import {
  APIConnectionError as RawOpenAISDKConnectionError,
  APIConnectionTimeoutError as RawOpenAISDKConnectionTimeoutError,
  APIError as RawOpenAISDKAPIError,
  OpenAIError as RawOpenAISDKError,
} from 'openai';
import { APIError as RawAnthropicAPIError } from '@anthropic-ai/sdk';
import { ApiError as RawGoogleApiError } from '@google/genai';

import { classifyKimiQuotaError } from '#/llm-kimi/errors';
import { kimiConnection, kimiOpenAITrait } from '#/llm-kimi/trait';
import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import { createAssistantMessage, createUserMessage, type Message } from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import { convertGoogleGenAIError } from '#/llm/requester/bases/google-genai/format';
import { createGoogleGenAIRequester } from '#/llm/requester/bases/google-genai/requester';
import { convertAnthropicError } from '#/llm/requester/bases/anthropic/format';
import { convertOpenAIError } from '#/llm/requester/bases/openai/format';
import { createOpenAIRequester } from '#/llm/requester/bases/openai/requester';
import type { LlmRequester, LlmRequestEvent } from '#/llm/requester/requester';

const model: LlmModel = {
  provider: 'test',
  model: 'test-model',
  capability: UNKNOWN_CAPABILITY,
  baseUrl: 'https://example.test/v1',
};
const messages: readonly Message[] = [createUserMessage('hi')];

describe('convertOpenAIError', () => {
  it('converts abort errors to abort kind', () => {
    expect(convertOpenAIError(new DOMException('x', 'AbortError'))).toEqual({
      kind: 'abort',
      message: 'x',
      retryable: false,
    });
  });

  it('lets the hook win and hands it the raw error', () => {
    const custom = { kind: 'provider', message: 'custom' } as const;
    const raw = new RawOpenAISDKAPIError(500, {}, 'server error', new Headers());
    let hookArg: unknown;
    const result = convertOpenAIError(raw, (error) => {
      hookArg = error;
      return custom;
    });
    expect(result).toBe(custom);
    expect(hookArg).toBe(raw);
  });

  it('maps connection errors to their kinds', () => {
    expect(
      convertOpenAIError(new RawOpenAISDKConnectionTimeoutError({ message: 'request timed out' })),
    ).toEqual({ kind: 'timeout', message: 'request timed out', retryable: true });
    expect(
      convertOpenAIError(new RawOpenAISDKConnectionError({ message: 'connection refused' })),
    ).toEqual({ kind: 'connection', message: 'connection refused', retryable: true });
  });

  it('maps 429 to rate_limit with retry-after', () => {
    const raw = new RawOpenAISDKAPIError(
      429,
      { error: { message: 'too many requests' } },
      'too many requests',
      new Headers({ 'retry-after': '3' }),
    );
    expect(convertOpenAIError(raw)).toMatchObject({
      kind: 'rate_limit',
      statusCode: 429,
      retryAfterMs: 3000,
    });
  });

  it('maps insufficient_quota to quota_exhausted with the backend message', () => {
    const raw = new RawOpenAISDKAPIError(
      429,
      { message: 'backend quota message', code: 'insufficient_quota' },
      'SDK-composed fallback',
      new Headers(),
    );
    expect(convertOpenAIError(raw)).toMatchObject({
      kind: 'quota_exhausted',
      message: 'backend quota message',
      statusCode: 429,
      retryable: false,
    });
  });

  it('prefers the backend body message over the SDK-composed message', () => {
    const raw = new RawOpenAISDKAPIError(
      400,
      { message: 'backend validation message', type: 'invalid_request_error' },
      '400 SDK-composed text',
      new Headers(),
    );
    expect(convertOpenAIError(raw)).toMatchObject({
      kind: 'status',
      message: 'backend validation message',
      statusCode: 400,
      retryable: false,
    });
  });

  it('maps context overflow messages to context_overflow', () => {
    const raw = new RawOpenAISDKAPIError(
      400,
      { message: 'maximum context length exceeded' },
      undefined,
      new Headers(),
    );
    expect(convertOpenAIError(raw)).toMatchObject({ kind: 'context_overflow', statusCode: 400 });
  });

  it('maps remaining status errors to their kinds', () => {
    const tooLarge = new RawOpenAISDKAPIError(
      413,
      { message: 'request entity too large' },
      undefined,
      new Headers(),
    );
    expect(convertOpenAIError(tooLarge)).toMatchObject({
      kind: 'request_too_large',
      statusCode: 413,
    });
    const overloaded = new RawOpenAISDKAPIError(529, {}, 'overloaded', new Headers());
    expect(convertOpenAIError(overloaded)).toMatchObject({ kind: 'overloaded', statusCode: 529 });
    const generic = new RawOpenAISDKAPIError(500, {}, 'server error', new Headers());
    expect(convertOpenAIError(generic)).toMatchObject({ kind: 'status', statusCode: 500 });
  });

  it('maps 400 request-structure rejections to request_structure', () => {
    const structural = [
      'messages.142: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_01MWFhDRqdbB4nzCJNuWYiun',
      'messages: `tool_use` ids must be unique',
      'text content blocks must be non-empty',
      'first message must use the `user` role',
      'roles must alternate',
      "tool_call_id 'call_abc123' is not found",
      "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'",
      "the message at position 3 with role 'assistant' must not be empty",
    ];
    for (const message of structural) {
      const raw = new RawOpenAISDKAPIError(400, { message }, undefined, new Headers());
      expect(convertOpenAIError(raw)).toMatchObject({ kind: 'request_structure', statusCode: 400 });
    }
    const unprocessable = new RawOpenAISDKAPIError(
      422,
      { message: 'roles must alternate' },
      undefined,
      new Headers(),
    );
    expect(convertOpenAIError(unprocessable)).toMatchObject({
      kind: 'request_structure',
      statusCode: 422,
    });
    const unrelated = new RawOpenAISDKAPIError(
      400,
      { message: 'max_tokens must be positive' },
      undefined,
      new Headers(),
    );
    expect(convertOpenAIError(unrelated)).toMatchObject({ kind: 'status', statusCode: 400 });
  });

  it('maps 400 image-format rejections to image_format', () => {
    const imageFormat = [
      'unsupported image format',
      'Could not process image',
      'The image data you provided does not represent a valid image',
      "messages.0.content.1.image.source.base64.media_type: Input should be 'image/jpeg'",
    ];
    for (const message of imageFormat) {
      const raw = new RawOpenAISDKAPIError(400, { message }, undefined, new Headers());
      expect(convertOpenAIError(raw)).toMatchObject({ kind: 'image_format', statusCode: 400 });
    }
    const notFormat = [
      'too many images in request',
      'image input is disabled for this model',
      "messages.0.content.1.video.source.base64.media_type: Input should be 'video/mp4'",
    ];
    for (const message of notFormat) {
      const raw = new RawOpenAISDKAPIError(400, { message }, undefined, new Headers());
      expect(convertOpenAIError(raw)).toMatchObject({ kind: 'status', statusCode: 400 });
    }
    const wrongStatus = new RawOpenAISDKAPIError(
      422,
      { message: 'unsupported image format' },
      undefined,
      new Headers(),
    );
    expect(convertOpenAIError(wrongStatus)).toMatchObject({ kind: 'status', statusCode: 422 });
  });

  it('classifies a bare APIError by message', () => {
    const raw = new RawOpenAISDKAPIError(
      undefined,
      undefined,
      'network connection failed',
      undefined,
    );
    expect(convertOpenAIError(raw)).toEqual({
      kind: 'connection',
      message: 'network connection failed',
      retryable: true,
    });
  });

  it('wraps an OpenAIError as provider', () => {
    expect(convertOpenAIError(new RawOpenAISDKError('boom'))).toEqual({
      kind: 'provider',
      message: 'Error: boom',
      retryable: true,
    });
  });

  it('classifies a generic Error by message', () => {
    expect(convertOpenAIError(new Error('deadline exceeded timeout'))).toEqual({
      kind: 'timeout',
      message: 'deadline exceeded timeout',
      retryable: true,
    });
    expect(convertOpenAIError(new Error('plain'))).toEqual({
      kind: 'provider',
      message: 'Error: plain',
      retryable: true,
    });
  });

  it('wraps non-error values as unknown', () => {
    expect(convertOpenAIError('nope')).toEqual({
      kind: 'unknown',
      message: 'nope',
      retryable: false,
    });
  });
});

describe('classifyKimiQuotaError', () => {
  it('classifies by structured error code', () => {
    const classified = classifyKimiQuotaError({
      status: 429,
      message: 'quota',
      code: 'exceeded_current_quota_error',
      requestID: 'req-1',
      headers: new Headers({ 'retry-after': '5', 'x-trace-id': 'trace-1' }),
    });
    expect(classified).toMatchObject({
      kind: 'quota_exhausted',
      statusCode: 429,
      requestId: 'req-1',
      retryAfterMs: 5000,
    });
    if (classified?.kind === 'quota_exhausted') {
      expect(classified.headers?.['x-trace-id']).toBe('trace-1');
    }
  });

  it('does not classify by message wording alone', () => {
    const classified = classifyKimiQuotaError({
      status: 429,
      message: 'insufficient balance',
      headers: new Headers(),
    });
    expect(classified).toBeUndefined();
  });

  it('classifies a nested structured quota error without a status', () => {
    const classified = classifyKimiQuotaError({
      error: { code: 'exceeded_current_quota_error', message: 'quota exhausted' },
      headers: new Headers(),
    });
    expect(classified).toMatchObject({
      kind: 'quota_exhausted',
      message: 'quota exhausted',
      retryable: false,
    });
  });

  it('ignores 429 without quota signals', () => {
    expect(
      classifyKimiQuotaError({ status: 429, message: 'slow down', headers: new Headers() }),
    ).toBeUndefined();
  });

  it('ignores non-429 errors', () => {
    expect(
      classifyKimiQuotaError({ status: 400, message: 'insufficient balance' }),
    ).toBeUndefined();
  });
});

describe('requester error conversion', () => {
  function failingOpenAIClient(error: unknown) {
    return () =>
      ({
        chat: {
          completions: {
            create: () => {
              throw error;
            },
          },
        },
      }) as never;
  }

  function throwingStreamClient(error: unknown) {
    return () =>
      ({
        chat: {
          completions: {
            create: () => ({
              withResponse: () =>
                Promise.resolve({
                  data: {
                    async *[Symbol.asyncIterator]() {
                      yield {
                        id: 'chunk-1',
                        choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }],
                      };
                      throw error;
                    },
                  },
                  response: { headers: new Headers() },
                }),
            }),
          },
        },
      }) as never;
  }

  async function generateEvents(
    requester: LlmRequester,
    input: readonly Message[] = messages,
  ): Promise<readonly LlmRequestEvent[]> {
    const events: LlmRequestEvent[] = [];
    await requester.generate(
      { model },
      { messages: input },
      { signal: new AbortController().signal, onEvent: (event) => events.push(event) },
    );
    return events;
  }

  it.each([
    [429, undefined, 'rate_limit', true],
    [529, undefined, 'overloaded', true],
    [413, undefined, 'request_too_large', false],
    [undefined, 'rate_limit_exceeded', 'rate_limit', true],
    [undefined, 'engine_overloaded_error', 'overloaded', true],
    [undefined, 'insufficient_quota', 'quota_exhausted', false],
    [undefined, 'context_length_exceeded', 'context_overflow', false],
  ] as const)(
    'classifies a mid-stream failure (status %s, code %s) as %s',
    async (status, code, kind, retryable) => {
      const body = code === undefined ? { message: 'stream failure' } : { message: 'stream failure', code };
      const requester = createOpenAIRequester({
        clientFactory: throwingStreamClient(
          new RawOpenAISDKAPIError(status, body, 'stream failure', new Headers()),
        ),
      });

      const events = await generateEvents(requester);
      const failure = events.at(-1) as { type: string; error?: Record<string, unknown> };

      expect(failure).toMatchObject({ type: 'llm.failed.remote' });
      expect(failure.error).toMatchObject({ kind, retryable });
      expect(failure.error?.['statusCode']).toBeUndefined();
    },
  );

  it('converts a 429 response to rate_limit', async () => {
    const requester = createOpenAIRequester({
      clientFactory: failingOpenAIClient(
        new RawOpenAISDKAPIError(
          429,
          { error: { message: 'too many requests' } },
          'too many requests',
          new Headers(),
        ),
      ),
    });
    const events = await generateEvents(requester);
    expect(events.at(-1)).toMatchObject({
      type: 'llm.failed.remote',
      error: { kind: 'rate_limit' },
    });
  });

  it('converts a kimi quota response to quota_exhausted', async () => {
    const requester = createOpenAIRequester({
      connection: kimiConnection,
      trait: kimiOpenAITrait,
      classifyError: classifyKimiQuotaError,
      clientFactory: failingOpenAIClient(
        new RawOpenAISDKAPIError(
          429,
          {
            error: {
              code: 'exceeded_current_quota_error',
              message: 'check your account balance',
            },
          },
          'check your account balance',
          new Headers(),
        ),
      ),
    });
    const events = await generateEvents(requester);
    expect(events.at(-1)).toMatchObject({
      type: 'llm.failed.remote',
      error: { kind: 'quota_exhausted' },
    });
  });

  it('emits llm.failed.syntax for a local message syntax error without sending a request', async () => {
    const clientFactory = mock(() => ({}) as never);
    const requester = createGoogleGenAIRequester({ clientFactory });
    const events = await generateEvents(requester, [
      createAssistantMessage(
        [],
        [{ type: 'function', id: 'call-1', name: 'some_tool', arguments: 'not json' }],
      ),
    ]);
    expect(events.at(-1)).toMatchObject({
      type: 'llm.failed.syntax',
      error: { kind: 'syntax', code: 'request_format' },
    });
    expect(clientFactory).not.toHaveBeenCalled();
  });
});

describe('stream-source error classification', () => {
  it('classifies an anthropic mid-stream failure by its error type', () => {
    const failure = convertAnthropicError(
      new RawAnthropicAPIError(
        400,
        { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
        'stream failure',
        new Headers(),
      ),
      undefined,
      'stream',
    );
    expect(failure).toMatchObject({
      kind: 'rate_limit',
      message: 'slow down',
      retryable: true,
    });
    expect(failure['statusCode']).toBeUndefined();
  });

  it('classifies a google-genai mid-stream failure by its business code', () => {
    const failure = convertGoogleGenAIError(
      new RawGoogleApiError({
        message: JSON.stringify({
          error: { code: 429, message: 'quota', status: 'RESOURCE_EXHAUSTED' },
        }),
        status: 429,
      }),
      undefined,
      'stream',
    );
    expect(failure).toMatchObject({
      kind: 'rate_limit',
      message: 'quota',
      retryable: true,
    });
    expect(failure['statusCode']).toBeUndefined();
  });

  it('keeps an initial HTTP 429 as the status while a stream business 429 drops it', () => {
    const rawError = () =>
      new RawGoogleApiError({
        message: JSON.stringify({ error: { code: 429, message: 'quota', status: 'RESOURCE_EXHAUSTED' } }),
        status: 429,
      });

    expect(convertGoogleGenAIError(rawError())).toMatchObject({
      kind: 'rate_limit',
      statusCode: 429,
      retryable: true,
    });
    expect(convertGoogleGenAIError(rawError(), undefined, 'stream')).toMatchObject({
      kind: 'rate_limit',
      statusCode: undefined,
      retryable: true,
    });
  });

  it('classifies a structured context code before the HTTP fallback', () => {
    const failure = convertOpenAIError(
      new RawOpenAISDKAPIError(
        400,
        { message: 'too long', code: 'context_length_exceeded' },
        'too long',
        new Headers(),
      ),
    );
    expect(failure).toMatchObject({ kind: 'context_overflow', retryable: false });
  });

  it('preserves diagnostics for an unknown OpenAI stream business code', () => {
    const failure = convertOpenAIError(
      new RawOpenAISDKAPIError(
        429,
        { error: { message: 'backend stream rate limit', code: 'mystery_code' } },
        'backend stream rate limit',
        new Headers({ 'x-trace-id': 'trace-stream' }),
      ),
      undefined,
      'stream',
    );
    expect(failure).toMatchObject({ kind: 'rate_limit', retryable: true });
    expect(failure['statusCode']).toBeUndefined();
    expect(failure.headers).toMatchObject({ 'x-trace-id': 'trace-stream' });
  });
});
