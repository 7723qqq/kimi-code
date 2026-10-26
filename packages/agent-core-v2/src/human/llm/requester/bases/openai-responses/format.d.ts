import type OpenAI from 'openai';
import type { ToolDescription } from '#/llm/message';
import type { FormatRequestInput, ProtocolFormat } from '#/llm/protocol/format';
import type { ResponseFormat } from '#/llm/response-format';
import type { TokenUsage } from '#/llm/usage';
import type { ResponsesInputItem } from './contract';
type RawObject = Record<string, unknown>;
export declare function responseFormatToResponsesText(format: ResponseFormat): RawObject;
export declare function defaultOpenAIResponsesTool(tool: ToolDescription): Record<string, unknown>;
export declare function encodeOpenAIResponsesCacheKey(cacheKey: string): Record<string, unknown>;
export declare function encodeOpenAIResponsesMaxCompletionTokens(cap: number): Record<string, unknown>;
export declare function applyOpenAIResponsesResponseFormat(kwargs: Record<string, unknown>, format: ResponseFormat): Record<string, unknown>;
export declare function normalizeOpenAIResponsesReasoning(kwargs: Record<string, unknown>): Record<string, unknown>;
export declare function parseOpenAIResponsesUsage(usage: RawObject | null | undefined): TokenUsage | undefined;
export interface OpenAIResponsesRequestParams {
    readonly params: OpenAI.Responses.ResponseCreateParamsStreaming;
    readonly headers?: Record<string, string>;
}
export interface OpenAIResponsesLowerOptions {
    readonly extractText: boolean;
}
export declare function lowerOpenAIResponsesMessages(input: FormatRequestInput, options: OpenAIResponsesLowerOptions): ResponsesInputItem[];
export interface OpenAIResponsesRequestParts {
    readonly input: readonly ResponsesInputItem[];
    readonly tools: readonly Record<string, unknown>[];
    readonly kwargs: Readonly<Record<string, unknown>>;
}
export declare function assembleOpenAIResponsesRequest(input: FormatRequestInput, parts: OpenAIResponsesRequestParts): Record<string, unknown>;
export declare function encodeOpenAIResponsesRequest(params: Record<string, unknown>): OpenAIResponsesRequestParams;
export declare function createOpenAIResponsesFormat(): ProtocolFormat;
export {};
