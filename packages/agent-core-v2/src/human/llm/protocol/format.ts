import type { LlmRemoteErrorMessage } from '#/llm/errors';
import type { FinishInfo } from '#/llm/finish-reason';
import type { Message, StreamedMessagePart, ToolDescription } from '#/llm/message';
import type { LlmRequestConfig } from '#/llm/requester/requester';
import type { TokenUsage } from '#/llm/usage';

export type FormatRequestInput = LlmRequestConfig & {
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDescription[];
  readonly usedContextTokens?: number;
};

export function resolveContextWindowTokens(input: FormatRequestInput): number | undefined {
  const explicit = input.maxContextTokens;
  const window = explicit !== undefined && explicit > 0 ? explicit : input.model.maxContextSize;
  return window !== undefined && window > 0 ? window : undefined;
}

export function remainingContextTokens(input: FormatRequestInput): number | undefined {
  const window = resolveContextWindowTokens(input);
  if (window === undefined || input.usedContextTokens === undefined) return undefined;
  return window - input.usedContextTokens;
}

export function resolveMaxCompletionCap(input: FormatRequestInput): number | undefined {
  const { maxCompletionTokens } = input;
  if (maxCompletionTokens === undefined || maxCompletionTokens <= 0) {
    return undefined;
  }
  const remaining = remainingContextTokens(input);
  if (remaining === undefined) return maxCompletionTokens;
  return remaining > 0 ? Math.min(maxCompletionTokens, remaining) : undefined;
}

export interface StreamParseSink {
  onDelta(part: StreamedMessagePart): void;
  onFinish(finish: FinishInfo): void;
  onMessageId?(messageId: string): void;
  onUsage?(usage: Partial<TokenUsage>): void;
  onError?(message: LlmRemoteErrorMessage): void;
}

export interface StreamParserOptions<TChunk> {
  resolveUsage?(
    chunk: TChunk,
    defaultUsage: Partial<TokenUsage> | undefined,
  ): Partial<TokenUsage> | undefined;
}

export type StreamParser<TChunk = unknown> = (chunk: TChunk, sink: StreamParseSink) => void;

export interface ProtocolFormat<TChunk = unknown> {
  createStreamParser(options?: StreamParserOptions<TChunk>): StreamParser<TChunk>;
}
