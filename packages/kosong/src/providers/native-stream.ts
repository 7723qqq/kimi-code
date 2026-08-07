/**
 * Native LLM stream provider — uses the Rust SSE streaming pipeline.
 *
 * When the native module is available, this replaces the TypeScript SDK-based
 * streaming implementations (openai, @anthropic-ai/sdk) with a Rust pipeline
 * that handles HTTP + SSE parsing + event decoding entirely off the JS event loop.
 *
 * The initial implementation collects all stream parts and yields them
 * synchronously (the HTTP streaming happens in Rust, but JS sees the parts
 * after the stream completes). A future iteration will add true streaming
 * via ThreadsafeFunction callbacks for real-time token delivery.
 */

import type { StreamedMessagePart, ToolCall } from '#/message';
import type { FinishReason, StreamedMessage } from '#/provider';
import type { TokenUsage } from '#/usage';

// ── Types matching the native module output ──────────────────────────────────

interface NativeStreamPart {
  partType: string;
  text?: string;
  think?: string;
  encrypted?: string;
  id?: string;
  name?: string;
  arguments?: string;
  argumentsPart?: string;
  streamIndex?: number;
}

interface NativeStreamMetadata {
  responseId?: string;
  finishReason?: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  traceId?: string;
}

interface NativeStreamResult {
  parts: NativeStreamPart[];
  metadata: NativeStreamMetadata;
  error?: string;
}

export interface NativeLlmStreamConfig {
  provider: 'openai-responses' | 'openai-legacy' | 'anthropic';
  url: string;
  apiKey: string;
  model: string;
  requestBody: string;
  timeoutMs?: number;
  extraHeaders?: Array<{ key: string; value: string }>;
  /**
   * Optional abort signal. The native call itself cannot be interrupted
   * (the Rust side buffers the whole stream and has no abort handle), but
   * the caller must not wait out the 120s timeout after a user cancel —
   * we race the native promise against the signal and reject with an
   * AbortError as soon as it fires. The underlying request keeps running
   * in the background and its result is discarded.
   */
  signal?: AbortSignal;
}

// ── Native module access ─────────────────────────────────────────────────────

let nativeModule: Record<string, unknown> | null | undefined;

function getNativeModule(): Record<string, unknown> | undefined {
  if (nativeModule === null) return undefined;
  if (nativeModule !== undefined) return nativeModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    nativeModule = require('@moonshot-ai/kimi-native-tools');
    return nativeModule ?? undefined;
  } catch {
    nativeModule = null;
    return undefined;
  }
}

// ── Circuit breaker ──────────────────────────────────────────────────────────
//
// A failing native pipeline (connection/TLS errors, Rust-side decode bugs)
// would otherwise make every LLM call throw here and then be re-issued over
// the SDK path by the caller — two full HTTP requests per call with zero
// diagnostics. After a short streak of consecutive failures we open the
// circuit for a cooldown window: `tryNativeLlmStream` returns `undefined`
// (the SDK fallback) without touching the native module at all.

const NATIVE_FAILURE_THRESHOLD = 3;
const NATIVE_COOLDOWN_MS = 60_000;

let nativeConsecutiveFailures = 0;
let nativeCooldownUntil = 0;

function isNativeCircuitOpen(): boolean {
  return Date.now() < nativeCooldownUntil;
}

function recordNativeSuccess(): void {
  nativeConsecutiveFailures = 0;
}

function recordNativeFailure(): void {
  nativeConsecutiveFailures += 1;
  if (nativeConsecutiveFailures >= NATIVE_FAILURE_THRESHOLD) {
    nativeCooldownUntil = Date.now() + NATIVE_COOLDOWN_MS;
    console.warn(
      `[kosong] native LLM stream failed ${nativeConsecutiveFailures} times in a row; ` +
        `disabling the native fast path for ${NATIVE_COOLDOWN_MS / 1000}s (falling back to SDK)`,
    );
  }
}

// ── Part conversion ──────────────────────────────────────────────────────────

function convertNativePart(part: NativeStreamPart): StreamedMessagePart | null {
  switch (part.partType) {
    case 'text':
      return { type: 'text', text: part.text ?? '' };
    case 'think': {
      const thinkPart: StreamedMessagePart = { type: 'think', think: part.think ?? '' };
      if (part.encrypted !== undefined) {
        (thinkPart as { encrypted: string }).encrypted = part.encrypted;
      }
      return thinkPart;
    }
    case 'function': {
      const tc: ToolCall = {
        type: 'function',
        id: part.id ?? '',
        name: part.name ?? '',
        arguments: part.arguments ?? null,
      };
      if (part.streamIndex !== undefined) {
        tc._streamIndex = part.streamIndex;
      }
      return tc;
    }
    case 'tool_call_part': {
      const callPart: StreamedMessagePart = {
        type: 'tool_call_part',
        argumentsPart: part.argumentsPart ?? null,
      };
      if (part.streamIndex !== undefined) {
        (callPart as { index: number }).index = part.streamIndex;
      }
      return callPart;
    }
    default:
      return null;
  }
}

// ── Finish reason normalization ──────────────────────────────────────────────

function normalizeFinishReason(raw: string | undefined): FinishReason | null {
  if (raw === undefined || raw === null) return null;
  switch (raw) {
    case 'completed':
    case 'stop':
    case 'end_turn':
    case 'stop_sequence':
      return 'completed';
    case 'max_tokens':
    case 'max_output_tokens':
    case 'length':
      return 'truncated';
    case 'tool_use':
    case 'tool_calls':
      return 'tool_calls';
    case 'content_filter':
      return 'filtered';
    case 'pause_turn':
      return 'paused';
    default:
      return 'other';
  }
}

// ── NativeStreamedMessage ────────────────────────────────────────────────────

/**
 * Wraps a completed native LLM stream result as a `StreamedMessage`.
 *
 * The Rust side has already completed the HTTP stream and decoded all events.
 * This class yields the pre-collected parts as an async iterator, matching
 * the interface expected by `generate.ts`.
 */
class NativeStreamedMessage implements StreamedMessage {
  private readonly _parts: StreamedMessagePart[];
  private readonly _id: string | null;
  private readonly _usage: TokenUsage | null;
  private readonly _finishReason: FinishReason | null;
  private readonly _rawFinishReason: string | null;
  private readonly _traceId: string | null;

  constructor(result: NativeStreamResult) {
    this._parts = result.parts
      .map(convertNativePart)
      .filter((p): p is StreamedMessagePart => p !== null);
    this._id = result.metadata.responseId ?? null;
    this._finishReason = normalizeFinishReason(result.metadata.finishReason);
    this._rawFinishReason = result.metadata.finishReason ?? null;
    this._traceId = result.metadata.traceId ?? null;
    this._usage = {
      inputOther: result.metadata.inputTokens - result.metadata.cachedTokens,
      output: result.metadata.outputTokens,
      inputCacheRead: result.metadata.cachedTokens,
      inputCacheCreation: 0,
    };
  }

  get id(): string | null { return this._id; }
  get usage(): TokenUsage | null { return this._usage; }
  get finishReason(): FinishReason | null { return this._finishReason; }
  get rawFinishReason(): string | null { return this._rawFinishReason; }
  get traceId(): string | null { return this._traceId; }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
    for (const part of this._parts) {
      yield part;
    }
  }
}

// ── Incremental streaming (TSFN) ─────────────────────────────────────────────

interface NativeLlmEventPayload {
  kind: 'part' | 'done' | 'error';
  part?: NativeStreamPart;
  metadata?: NativeStreamMetadata;
  error?: string;
}

/**
 * Try to stream an LLM response via the Rust native module with incremental
 * delivery.
 *
 * Unlike {@link tryNativeLlmStream} (which buffers the whole response in Rust
 * and yields only after completion), this uses the native
 * `nativeLlmStreamStreaming` binding: the Rust side decodes SSE events and
 * forwards each part to a JS callback via a ThreadsafeFunction, so parts are
 * observed as they arrive — true streaming, same as the SDK providers.
 *
 * Resolves to a `StreamedMessage` (incremental async iteration), or
 * `undefined` when the native streaming binding is unavailable (caller falls
 * back to SDK). The returned message throws on API errors (429/auth) and on
 * abort — matching the SDK providers' error behavior — and the buffered
 * path's circuit breaker still applies (a sustained native failure throttles
 * the fast path).
 */
export async function tryNativeLlmStreamIncremental(
  config: NativeLlmStreamConfig,
): Promise<StreamedMessage | undefined> {
  const mod = getNativeModule();
  if (!mod) return undefined;
  const fn = mod['nativeLlmStreamStreaming'];
  if (typeof fn !== 'function') return undefined;
  if (isNativeCircuitOpen()) return undefined;

  // Queue bridging the TSFN callback thread and the consumer's pull loop.
  const buffer: StreamedMessagePart[] = [];
  let done: { error?: string; metadata?: NativeStreamMetadata } | undefined;
  let waiters: Array<() => void> = [];
  let settled = false;
  const wake = (): void => {
    const pending = waiters;
    waiters = [];
    for (const w of pending) w();
  };
  const waitForData = (): Promise<void> =>
    new Promise((resolve) => {
      waiters.push(resolve);
    });

  const onEvent = (error: unknown, event: NativeLlmEventPayload): void => {
    if (settled) return;
    if (error !== null && error !== undefined) {
      // napi TSFN follows Node callback conventions: first arg is the error.
      // Treat a callback-time error like a stream error event.
      done = { error: error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error) };
      recordNativeFailure();
      settled = true;
      wake();
      return;
    }
    if (event.kind === 'part' && event.part !== undefined) {
      const converted = convertNativePart(event.part);
      if (converted !== null) {
        buffer.push(converted);
        wake();
      }
      return;
    }
    if (event.kind === 'done') {
      done = { metadata: event.metadata };
      recordNativeSuccess();
      settled = true;
      wake();
      return;
    }
    // kind === 'error'
    done = { error: event.error ?? 'native stream error' };
    recordNativeFailure();
    settled = true;
    wake();
  };

  try {
    (fn as (config: unknown, onEvent: (error: unknown, event: NativeLlmEventPayload) => void) => void)({
      provider: config.provider,
      url: config.url,
      apiKey: config.apiKey,
      model: config.model,
      requestBody: config.requestBody,
      timeoutMs: config.timeoutMs ?? null,
      extraHeaders: config.extraHeaders ?? undefined,
    }, onEvent);
  } catch (error) {
    if (error instanceof Error) {
      const msg = error.message;
      if (msg.includes('not a function') || msg.includes('not an object')) {
        return undefined;
      }
    }
    throw error;
  }

  return new NativeIncrementalStreamedMessage(config, buffer, () => done, waitForData, wake);
}

/**
 * Incrementally-yielding `StreamedMessage` backed by the TSFN callback queue.
 *
 * `id`/`usage`/`finishReason` are populated from the `done` metadata once the
 * stream completes; until then they read as `null` (same contract as the SDK
 * providers' streams, whose metadata also lands at the end).
 */
class NativeIncrementalStreamedMessage implements StreamedMessage {
  private _done: () => { error?: string; metadata?: NativeStreamMetadata } | undefined;

  constructor(
    private readonly _config: NativeLlmStreamConfig,
    private readonly _buffer: StreamedMessagePart[],
    done: () => { error?: string; metadata?: NativeStreamMetadata } | undefined,
    private readonly _waitForData: () => Promise<void>,
    private readonly _wake: () => void,
  ) {
    this._done = done;
  }

  get id(): string | null {
    return this._done()?.metadata?.responseId ?? null;
  }

  get usage(): TokenUsage | null {
    const m = this._done()?.metadata;
    if (m === undefined) return null;
    return {
      inputOther: m.inputTokens - m.cachedTokens,
      output: m.outputTokens,
      inputCacheRead: m.cachedTokens,
      inputCacheCreation: 0,
    };
  }

  get finishReason(): FinishReason | null {
    return normalizeFinishReason(this._done()?.metadata?.finishReason);
  }

  get rawFinishReason(): string | null {
    return this._done()?.metadata?.finishReason ?? null;
  }

  get traceId(): string | null {
    return this._done()?.metadata?.traceId ?? null;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
    const throwIfAborted = (): void => {
      if (this._config.signal?.aborted === true) {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }
    };

    for (;;) {
      throwIfAborted();
      while (this._buffer.length > 0) {
        const part = this._buffer.shift()!;
        yield part;
        throwIfAborted();
      }
      const done = this._done();
      if (done !== undefined) break;
      await this._waitForData();
    }

    const done = this._done();
    if (done?.error !== undefined) {
      throw new Error(done.error);
    }
  }
}


/**
 * Try to execute an LLM stream via the Rust native module.
 *
 * Returns a `StreamedMessage` if the native module is available and the
 * request succeeds. Returns `undefined` if the native module is unavailable,
 * allowing the caller to fall through to the SDK-based implementation.
 *
 * Throws an Error (with status info) on API errors so the caller's error
 * handling works consistently.
 */
export async function tryNativeLlmStream(
  config: NativeLlmStreamConfig,
): Promise<StreamedMessage | undefined> {
  const mod = getNativeModule();
  if (!mod) return undefined;
  const fn = mod['nativeLlmStream'];
  if (typeof fn !== 'function') return undefined;
  // Circuit is open: skip the native path entirely and let the caller use the
  // SDK fallback (avoids re-issuing a failing native request per LLM call).
  if (isNativeCircuitOpen()) return undefined;

  const run = async (): Promise<StreamedMessage | undefined> => {
    try {
      const result = await (fn as (config: unknown) => Promise<NativeStreamResult>)({
        provider: config.provider,
        url: config.url,
        apiKey: config.apiKey,
        model: config.model,
        requestBody: config.requestBody,
        timeoutMs: config.timeoutMs ?? null,
        extraHeaders: config.extraHeaders ?? null,
      });

      if (result.error) {
        // API errors (rate limit, auth, etc.) are surfaced to the caller.
        // Connection/TLS errors from Rust are also surfaced — the caller's
        // try/catch around tryNativeLlmStream will catch them and fall back.
        throw new Error(result.error);
      }

      recordNativeSuccess();
      return new NativeStreamedMessage(result);
    } catch (error) {
      if (error instanceof Error) {
        const msg = error.message;
        // Native module structural errors — fall back silently.
        if (msg.includes('not a function') || msg.includes('not an object')) {
          return undefined;
        }
      }
      // All other errors (API errors, connection errors) propagate to the
      // caller, which wraps them in a try/catch and falls back to SDK.
      recordNativeFailure();
      throw error;
    }
  };

  const signal = config.signal;
  if (signal === undefined || signal.aborted) {
    return run();
  }
  // The Rust call cannot be interrupted mid-flight, but a user cancel must
  // not be held hostage by the native 120s timeout: race it against the
  // signal and surface the abort immediately. The native request keeps
  // running in the background and its (discarded) outcome still counts
  // toward the circuit breaker — a sustained failure is still throttled.
  return new Promise<StreamedMessage | undefined>((resolve, reject) => {
    const onAbort = (): void => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    run().then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
