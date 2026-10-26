import type { LlmModel } from '#/llm/model';
import { type ThinkingRequestOptions } from '#/llm/thinking';
export declare const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";
export type AnthropicThinkingMode = 'budget' | 'adaptive';
export interface AnthropicModelProfile {
    readonly mode: AnthropicThinkingMode;
    readonly efforts: readonly string[];
    readonly supportsEffortParam: boolean;
    readonly canDisableThinking: boolean;
}
export type AnthropicModelFamily = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'mythos';
export interface AnthropicModelVersion {
    readonly family: AnthropicModelFamily;
    readonly major: number;
    readonly minor: number | null;
}
export declare const BUDGET_THINKING_EFFORTS: readonly ['low', 'medium', 'high'];
export declare const LATEST_OPUS_THINKING_EFFORTS: readonly ['low', 'medium', 'high', 'xhigh', 'max'];
export declare const LATEST_OPUS_PROFILE: AnthropicModelProfile;
export declare function parseAnthropicModelVersion(model: string, requireClaudeMarker?: boolean): AnthropicModelVersion | null;
export declare function resolveDefaultMaxTokens(model: string, override?: number): number;
export declare function matchKnownAnthropicModelProfile(model: string): AnthropicModelProfile | undefined;
export declare function inferAnthropicModelProfile(model: string): AnthropicModelProfile;
export declare function matchUnknownClaudeProfile(model: string): AnthropicModelProfile | undefined;
export declare function shouldPreserveUnsignedThinking(model: string): boolean;
export declare function resolveThinkingProfile(model: LlmModel): AnthropicModelProfile;
export declare function encodeThinking(thinking: ThinkingRequestOptions, model: LlmModel): Record<string, unknown> | undefined;
