import type { StreamedMessagePart } from '#/llm/message';
export declare const KNOWN_REASONING_KEYS: readonly ['reasoning_content', 'reasoning_details', 'reasoning'];
export type ReasoningKey = (typeof KNOWN_REASONING_KEYS)[number];
export declare const DEFAULT_REASONING_KEY: ReasoningKey;
export declare function extractReasoningStrings(source: unknown): {
    key: string;
    value: string;
}[];
export declare function extractReasoning(source: unknown, explicitKey?: string): {
    key: string;
    value: string;
} | undefined;
export declare class ReasoningKeyDialect {
    private readonly _explicitKey?;
    private _detected;
    constructor(_explicitKey?: string | undefined);
    observe(source: unknown): string | undefined;
    outboundKey(): string;
}
export declare const REASONING_DETAILS_KEY = "reasoning_details";
export interface ReasoningDetailsElement {
    readonly type?: string;
    readonly index: number;
    readonly summary?: string;
    readonly encrypted?: string;
}
export declare function extractReasoningDetails(source: unknown): ReasoningDetailsElement[] | undefined;
export declare function convertReasoningDetails(elements: readonly ReasoningDetailsElement[], hiddenSummary?: boolean): StreamedMessagePart[];
