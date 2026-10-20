// Type declarations for @moonshot-ai/kimi-native-tools
//
// This file provides TypeScript types for the native Rust functions exposed
// via napi-rs. The actual implementations are in the platform-specific .node
// files loaded by index.js.

// ============================================================================
// LLM Stream (buffered)
// ============================================================================

export interface NativeLlmStreamResult {
  parts: NativeLlmStreamPart[];
  metadata: NativeLlmStreamMetadata;
  error?: string;
}

/**
 * Execute an LLM streaming request and return all decoded parts at once.
 *
 * The Rust side handles HTTP POST, SSE parsing, and provider-specific event
 * decoding. Returns every part collected from the stream plus metadata.
 */
export function nativeLlmStream(config: NativeLlmStreamConfig): Promise<NativeLlmStreamResult>;

// ============================================================================
// LLM Stream (incremental)
// ============================================================================

export interface NativeLlmStreamPart {
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

export interface NativeLlmStreamMetadata {
  responseId?: string;
  finishReason?: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheCreationTokens?: number;
  traceId?: string;
}

export interface NativeLlmStreamEvent {
  kind: 'part' | 'done' | 'error';
  part?: NativeLlmStreamPart;
  metadata?: NativeLlmStreamMetadata;
  error?: string;
}

export interface NativeLlmStreamConfig {
  provider: 'openai-responses' | 'openai-legacy' | 'anthropic';
  url: string;
  apiKey: string;
  model: string;
  requestBody: string;
  /**
   * How long the stream may go WITHOUT a single SSE event before it is treated
   * as dead — an idle deadline, not the wall-clock budget of the whole answer.
   * Every event resets it, so a slow long-running stream is not cut off; the
   * overall request carries a separate 30-minute ceiling.
   */
  timeoutMs?: number | null;
  extraHeaders?: Array<{ key: string; value: string }> | null;
}

/**
 * Incremental streaming variant: forwards decoded parts to `onEvent` as they arrive.
 * Follows Node callback conventions: `(err, event)` — `err` is `null` on success.
 */
export function nativeLlmStreamStreaming(
  config: NativeLlmStreamConfig,
  onEvent: (error: unknown, event: NativeLlmStreamEvent) => void,
): void;
