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
export declare function resolveContextWindowTokens(input: FormatRequestInput): number | undefined;
export declare function remainingContextTokens(input: FormatRequestInput): number | undefined;
export declare function resolveMaxCompletionCap(input: FormatRequestInput): number | undefined;
export interface StreamParseSink {
    onDelta(part: StreamedMessagePart): void;
    onFinish(finish: FinishInfo): void;
    onMessageId?(messageId: string): void;
    onUsage?(usage: Partial<TokenUsage>): void;
    onError?(message: LlmRemoteErrorMessage): void;
}
export interface StreamParserOptions<TChunk> {
    resolveUsage?(chunk: TChunk, defaultUsage: Partial<TokenUsage> | undefined): Partial<TokenUsage> | undefined;
}
export type StreamParser<TChunk = unknown> = (chunk: TChunk, sink: StreamParseSink) => void;
export interface ProtocolFormat<TChunk = unknown> {
    createStreamParser(options?: StreamParserOptions<TChunk>): StreamParser<TChunk>;
}
