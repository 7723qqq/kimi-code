export interface ImageTokenPricing {
    readonly patchPx: number;
    readonly downsampleRatio: number;
    readonly scaleUpFloorPx: number;
    readonly tokenCap: number;
    readonly fallbackTokens: number;
}
export type PromptShape = 'minimal';
export interface ModelFamilyPrefix {
    readonly value: string;
    readonly glued?: boolean;
}
export interface FamilyThinkingHistory {
    readonly fullEchoWithTools: boolean;
    readonly ignoredWhileThinking?: readonly string[];
}
export interface ModelFamilyProfile {
    readonly id: string;
    readonly prefixes: readonly ModelFamilyPrefix[];
    readonly adaptationPrefixes: readonly string[];
    readonly curatedAdaptation?: boolean;
    readonly promptShape?: PromptShape;
    readonly imagePricing?: ImageTokenPricing;
    readonly reasoningEffort?: FamilyReasoningEffort;
    readonly thinkingHistory?: FamilyThinkingHistory;
    readonly maxOutputDefaults?: FamilyMaxOutputDefaults;
}
export interface FamilyReasoningEffort {
    readonly historyDefault: string;
}
export interface FamilyMaxOutputDefaults {
    readonly nonThinking: number;
    readonly thinking: number;
    readonly thinkingMaxEffort: number;
}
export declare function resolveModelFamily(name: string): ModelFamilyProfile | undefined;
export declare function familyAdaptationPrefixes(name: string): readonly string[];
export declare function imagePricingForModel(name: string | undefined): ImageTokenPricing | undefined;
export declare function maxOutputDefaultsForModel(name: string | undefined): FamilyMaxOutputDefaults | undefined;
export declare function reasoningEffortForModel(name: string | undefined): FamilyReasoningEffort | undefined;
export declare function thinkingHistoryForModel(name: string | undefined): FamilyThinkingHistory | undefined;
export declare function fullReasoningEchoRequired(name: string | undefined, hasTools: boolean): boolean;
export declare function ignoredSamplingParamsForModel(name: string | undefined): readonly string[];
export declare function promptShapeForModel(name: string | undefined): PromptShape | undefined;
