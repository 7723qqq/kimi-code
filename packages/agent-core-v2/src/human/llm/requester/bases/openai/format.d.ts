import OpenAI from 'openai';
import { type LlmRemoteErrorMessage } from '#/llm/errors';
import { type Message, type ToolDescription } from '#/llm/message';
import type { LlmLogger } from '#/log/log';
import type { FormatRequestInput, ProtocolFormat, StreamParser, StreamParserOptions } from '#/llm/protocol/format';
import type { ToolMessageConversion } from '#/llm/requester/requester';
import type { ResponseFormat } from '#/llm/response-format';
import type { OpenAIRawChunk, OpenAIWireMessage } from './contract';
import { parseOpenAIUsage } from './usage';
export declare function responseFormatToOpenAI(format: ResponseFormat): Record<string, unknown>;
export declare function encodeOpenAICacheKey(cacheKey: string): Record<string, unknown>;
export declare function encodeOpenAIThinkHistoryKwargs(model: string): Record<string, unknown>;
export declare function encodeOpenAIMaxCompletionTokens(model: string, cap: number): Record<string, unknown>;
export declare function defaultOpenAITool(tool: ToolDescription): Record<string, unknown>;
export { parseOpenAIUsage };
export interface OpenAIRequestParams {
    readonly params: OpenAI.Chat.ChatCompletionCreateParamsStreaming;
    readonly headers?: Record<string, string>;
}
export interface OpenAILowerOptions {
    readonly reasoningKey: string;
    readonly preserveThinking: boolean;
    readonly echoFullReasoning: boolean;
    readonly toolMessageConversion: ToolMessageConversion | undefined;
}
export interface OpenAILoweredMessage {
    readonly source: Message;
    readonly message: OpenAIWireMessage;
}
export declare function lowerOpenAIMessages(input: FormatRequestInput, options: OpenAILowerOptions): OpenAILoweredMessage[];
export interface OpenAIRequestParts {
    readonly messages: readonly OpenAIWireMessage[];
    readonly tools: readonly Record<string, unknown>[];
    readonly kwargs: Readonly<Record<string, unknown>>;
}
export declare function stripIgnoredSamplingParams(kwargs: Record<string, unknown>, ignored: readonly string[]): Record<string, unknown>;
export declare function assembleOpenAIRequest(input: FormatRequestInput, parts: OpenAIRequestParts): Record<string, unknown>;
export declare function encodeOpenAIRequest(params: Record<string, unknown>): OpenAIRequestParams;
export interface OpenAIStreamParserOptions extends StreamParserOptions<OpenAIRawChunk> {
    readonly reasoningKey?: string;
}
export interface OpenAIProtocolFormat extends ProtocolFormat<OpenAIRawChunk> {
    createStreamParser(options?: OpenAIStreamParserOptions): StreamParser<OpenAIRawChunk>;
}
export declare function createOpenAIFormat(log?: LlmLogger): OpenAIProtocolFormat;
export declare function isOpenAIInsufficientQuotaCode(code: string | null | undefined): boolean;
export declare function isContextOverflowErrorCode(code: string | null | undefined): boolean;
export declare function convertOpenAIError(error: unknown, classifyErrorHook?: (error: unknown) => LlmRemoteErrorMessage | undefined): LlmRemoteErrorMessage;
