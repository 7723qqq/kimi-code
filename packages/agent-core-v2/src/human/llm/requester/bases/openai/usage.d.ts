import type { TokenUsage } from '#/llm/usage';
import type { LlmLogger } from '#/log/log';
import type { OpenAIRawUsage } from './contract';
export interface OpenAICacheFields {
    readonly cached: number;
    readonly miss: number | undefined;
    readonly rejected: boolean;
    readonly reportedMiss?: number;
}
export declare function readOpenAICacheFields(usage: OpenAIRawUsage): OpenAICacheFields;
export declare function parseOpenAIUsage(usage: OpenAIRawUsage | null | undefined, log?: LlmLogger): TokenUsage | undefined;
