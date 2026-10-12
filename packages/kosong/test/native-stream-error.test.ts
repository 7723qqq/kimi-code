import { describe, expect, it } from 'vitest';

import {
  APIProviderQuotaExhaustedError,
  APIProviderRateLimitError,
  APIStatusError,
  isRetryableGenerateError,
} from '#/errors';
import { convertAnthropicError } from '#/providers/anthropic';
import { classifyKimiQuotaError } from '#/providers/kimi-errors';
import { convertOpenAIError } from '#/providers/openai-common';
import {
  NativeLlmApiError,
  tryNativeLlmStream,
  tryNativeLlmStreamIncremental,
} from '../src/providers/native-stream';

/**
 * The Rust pipeline reports an HTTP failure as `API error (<status>): <body>`
 * (`llm_stream.rs`, the non-2xx branch). That status used to be dropped on the
 * floor: the incremental/buffered paths threw a bare `Error` from inside the
 * consumer's iteration, i.e. AFTER the provider's `try/catch` around
 * `tryNativeLlmStream*` had already returned, so no `convert*Error` ever saw
 * it. A transient 429 therefore reached `isRetryableGenerateError` as a plain
 * `Error` (not retryable) and a quota-exhausted 429 bypassed
 * `classifyKimiQuotaError` (which requires a `status` property).
 *
 * `NativeLlmApiError` is the carrier that closes both holes: `native-stream.ts`
 * parses the status into it, and each provider's converter classifies it with
 * the SAME rule its SDK errors get.
 */

/**
 * `native-stream.ts` reaches the addon through a bare `require()`, which
 * `vi.mock` does NOT intercept (vitest's module registry only covers ESM
 * imports) — the real `.node` binary loads and the test would make a network
 * call. `bun:test`'s `mock.module` does replace it, and this suite is only ever
 * run under Bun (`bun --bun x vitest`), the sole supported runtime here.
 *
 * The specifier is held in a variable because the repo ships no Bun type
 * declarations: a literal `import('bun:test')` is a typecheck error
 * (TS2307), and adding `@types/bun` is out of scope for this fix.
 */
const bunTestModuleId = 'bun:test';
const { mock } = (await import(bunTestModuleId)) as {
  mock: { module(id: string, factory: () => unknown): void };
};

const incrementalEvents: unknown[] = [];
let bufferedError: string | undefined;

mock.module('@moonshot-ai/kimi-native-tools', () => ({
  nativeLlmStreamStreaming: (
    _config: unknown,
    onEvent: (error: unknown, event: unknown) => void,
  ): void => {
    for (const event of incrementalEvents) {
      onEvent(null, event);
    }
  },
  // The buffered binding RESOLVES with an optional `error` field (it does not
  // reject), which is the shape `tryNativeLlmStream` reads.
  nativeLlmStream: (): Promise<unknown> => {
    if (bufferedError === undefined) {
      return Promise.resolve({
        parts: [],
        metadata: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
      });
    }
    return Promise.resolve({
      parts: [],
      metadata: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
      error: bufferedError,
    });
  },
}));

const CONFIG = {
  provider: 'anthropic' as const,
  url: 'http://127.0.0.1:1/v1/messages',
  apiKey: 'test-key',
  model: 'claude-sonnet-4-5',
  requestBody: '{}',
};

function setIncrementalError(message: string): void {
  incrementalEvents.length = 0;
  incrementalEvents.push({ kind: 'error', error: message });
}

/**
 * The native path keeps a module-global circuit breaker: three consecutive
 * failures disable the fast path for a minute. These tests deliberately
 * trigger failures, so each one clears the counter by letting a successful
 * buffered call through — otherwise the third test would silently start
 * exercising the SDK fallback (`undefined`) instead of the native path, and
 * the suite would pass for the wrong reason.
 */
async function resetNativeCircuit(): Promise<void> {
  bufferedError = undefined;
  const stream = await tryNativeLlmStream(CONFIG);
  expect(stream).toBeDefined();
}

async function drain(stream: {
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
}): Promise<unknown> {
  let thrown: unknown;
  try {
    for await (const part of stream) void part;
  } catch (error) {
    thrown = error;
  }
  return thrown;
}

describe('NativeLlmApiError', () => {
  it('parses the status out of the Rust `API error (<status>)` shape', () => {
    const error = new NativeLlmApiError('API error (429): rate limited', 429);
    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(429);
    expect(error.name).toBe('NativeLlmApiError');
  });

  it('carries no status when the Rust message is not an HTTP failure', () => {
    const error = new NativeLlmApiError('SSE stream error: connection reset');
    expect(error.status).toBeUndefined();
  });
});

describe('native incremental stream errors', () => {
  it('throws a NativeLlmApiError carrying status 429', async () => {
    setIncrementalError('API error (429): rate limited');
    try {
      const stream = await tryNativeLlmStreamIncremental(CONFIG);
      expect(stream).toBeDefined();

      const thrown = await drain(stream!);
      expect(thrown).toBeInstanceOf(NativeLlmApiError);
      expect((thrown as NativeLlmApiError).status).toBe(429);
      expect((thrown as Error).message).toContain('rate limited');
    } finally {
      await resetNativeCircuit();
    }
  });

  it('throws a NativeLlmApiError with no status for a non-HTTP stream failure', async () => {
    setIncrementalError('SSE stream error: connection reset');
    try {
      const stream = await tryNativeLlmStreamIncremental(CONFIG);

      const thrown = await drain(stream!);
      expect(thrown).toBeInstanceOf(NativeLlmApiError);
      expect((thrown as NativeLlmApiError).status).toBeUndefined();
    } finally {
      await resetNativeCircuit();
    }
  });

  it('parses the status off the raw Rust message, not a re-formatted one', () => {
    const converted = convertAnthropicError(new NativeLlmApiError('API error (401): bad key', 401));
    expect(converted).toBeInstanceOf(APIStatusError);
    expect((converted as APIStatusError).statusCode).toBe(401);
  });
});

describe('native buffered stream errors', () => {
  it('throws a NativeLlmApiError carrying status 429', async () => {
    bufferedError = 'API error (429): rate limited';
    try {
      let thrown: unknown;
      try {
        await tryNativeLlmStream(CONFIG);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(NativeLlmApiError);
      expect((thrown as NativeLlmApiError).status).toBe(429);
    } finally {
      await resetNativeCircuit();
    }
  });
});

describe('provider classification of native API errors', () => {
  it('a 429 becomes a retryable rate-limit error', () => {
    const converted = convertAnthropicError(new NativeLlmApiError('API error (429): slow down', 429));
    expect(converted).toBeInstanceOf(APIProviderRateLimitError);
    expect((converted as APIStatusError).statusCode).toBe(429);
    expect(isRetryableGenerateError(converted)).toBe(true);
  });

  it('a 429 whose body is a Kimi quota exhaustion still fails fast', () => {
    // The vendor hook must see the native error, exactly as it sees an SDK one:
    // `classifyKimiQuotaError` reads `status` off the object and matches the
    // billing wording of the body, which is why the native carrier has to
    // expose the status and keep the raw Rust message intact.
    const converted = convertAnthropicError(
      new NativeLlmApiError(
        'API error (429): you exceeded your current token quota, please check your account balance',
        429,
      ),
      classifyKimiQuotaError,
    );
    expect(converted).toBeInstanceOf(APIProviderQuotaExhaustedError);
    expect(isRetryableGenerateError(converted)).toBe(false);
  });

  it('a 401 becomes a non-retryable 401 status error', () => {
    const converted = convertAnthropicError(new NativeLlmApiError('API error (401): bad key', 401));
    expect((converted as APIStatusError).statusCode).toBe(401);
    expect(isRetryableGenerateError(converted)).toBe(false);
  });

  it('an OpenAI-path native error is classified the same way', () => {
    const converted = convertOpenAIError(new NativeLlmApiError('API error (503): unavailable', 503));
    expect((converted as APIStatusError).statusCode).toBe(503);
    expect(isRetryableGenerateError(converted)).toBe(true);
  });

  it('a status-less native error is treated as a retryable 5xx', () => {
    const converted = convertAnthropicError(new NativeLlmApiError('SSE stream error: reset'));
    expect((converted as APIStatusError).statusCode).toBe(500);
    expect(isRetryableGenerateError(converted)).toBe(true);
  });
});
