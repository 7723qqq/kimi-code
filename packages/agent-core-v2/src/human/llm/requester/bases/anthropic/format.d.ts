import Anthropic from '@anthropic-ai/sdk';
import { type LlmRemoteErrorMessage } from '#/llm/errors';
import type { Message, ToolDescription } from '#/llm/message';
import type { FormatRequestInput, ProtocolFormat } from '#/llm/protocol/format';
import type { ResponseFormat } from '#/llm/response-format';
import type { AnthropicRawStreamEvent, AnthropicWireMessage } from './contract';
export declare function applyAnthropicResponseFormat(kwargs: Record<string, unknown>, format: ResponseFormat): Record<string, unknown>;
export declare function applyAnthropicThinkingKeep(kwargs: Record<string, unknown>, keep: string): Record<string, unknown>;
export declare function encodeAnthropicMaxTokens(cap: number): Record<string, unknown>;
export declare function defaultAnthropicTool(tool: ToolDescription): Record<string, unknown>;
export declare function defaultAnthropicMergeHistory(messages: readonly AnthropicWireMessage[]): AnthropicWireMessage[];
export interface AnthropicLoweredMessage {
    readonly source: Message;
    readonly message: AnthropicWireMessage;
}
export declare function lowerAnthropicMessages(input: FormatRequestInput, acceptedMimes: ReadonlySet<string>): AnthropicLoweredMessage[];
export interface AnthropicRequestParams {
    readonly params: Anthropic.MessageCreateParamsStreaming;
    readonly betas: readonly string[];
    readonly useBetaApi: boolean;
}
export interface AnthropicFormatOptions {
    readonly betaApi?: boolean;
}
export interface AnthropicRequestParts {
    readonly messages: readonly AnthropicWireMessage[];
    readonly tools: readonly Record<string, unknown>[];
    readonly kwargs: Readonly<Record<string, unknown>>;
    readonly betaApi: boolean;
}
export interface AnthropicRequestAssembly {
    readonly params: Record<string, unknown>;
    readonly betas: readonly string[];
    readonly useBetaApi: boolean;
}
export declare function assembleAnthropicRequest(input: FormatRequestInput, parts: AnthropicRequestParts): AnthropicRequestAssembly;
export declare function encodeAnthropicRequest(assembly: AnthropicRequestAssembly): AnthropicRequestParams;
export declare function createAnthropicFormat(): ProtocolFormat<AnthropicRawStreamEvent>;
export declare const anthropicFormat: ProtocolFormat<AnthropicRawStreamEvent>;
export declare function convertAnthropicError(error: unknown, classifyErrorHook?: (error: unknown) => LlmRemoteErrorMessage | undefined): LlmRemoteErrorMessage;
