export interface ImageTokenPricing {
  readonly patchPx: number;
  readonly downsampleRatio: number;
  readonly scaleUpFloorPx: number;
  readonly tokenCap: number;
  readonly fallbackTokens: number;
}

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

const DEEPSEEK_IMAGE_PRICING: ImageTokenPricing = Object.freeze({
  patchPx: 14,
  downsampleRatio: 3,
  scaleUpFloorPx: 544,
  tokenCap: 1024,
  fallbackTokens: 1024,
});

const DEEPSEEK_REASONING_EFFORT: FamilyReasoningEffort = Object.freeze({
  historyDefault: 'high',
});

const DEEPSEEK_MAX_OUTPUT_DEFAULTS: FamilyMaxOutputDefaults = Object.freeze({
  nonThinking: 8192,
  thinking: 65536,
  thinkingMaxEffort: 131072,
});

const DEEPSEEK_THINKING_HISTORY: FamilyThinkingHistory = Object.freeze({
  fullEchoWithTools: true,
  ignoredWhileThinking: Object.freeze(['temperature', 'presence_penalty', 'frequency_penalty']),
});

const DEEPSEEK_PREFIXES: readonly ModelFamilyPrefix[] = Object.freeze([
  Object.freeze({ value: 'deepseek' }),
  Object.freeze({ value: 'xopdeepseek', glued: true }),
]);

const MODEL_FAMILIES: readonly ModelFamilyProfile[] = Object.freeze([
  Object.freeze({
    id: 'deepseek',
    prefixes: DEEPSEEK_PREFIXES,
    adaptationPrefixes: Object.freeze(['deepseek']),
    curatedAdaptation: true,
    imagePricing: DEEPSEEK_IMAGE_PRICING,
    reasoningEffort: DEEPSEEK_REASONING_EFFORT,
    thinkingHistory: DEEPSEEK_THINKING_HISTORY,
    maxOutputDefaults: DEEPSEEK_MAX_OUTPUT_DEFAULTS,
  }),
]);

const CLONE_SUFFIX = '-clone';

function modelNameSegments(name: string): readonly string[] {
  return name
    .toLowerCase()
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function modelSegmentMatches(segment: string, prefix: ModelFamilyPrefix): boolean {
  if (!segment.startsWith(prefix.value)) return false;
  if (segment.endsWith(CLONE_SUFFIX)) return false;
  const rest = segment.slice(prefix.value.length);
  if (rest.length === 0 || rest.startsWith('-') || rest.startsWith('.')) return true;
  return prefix.glued === true;
}

function gatewaySegmentMatches(segment: string, prefix: string): boolean {
  return segment.startsWith(`${prefix}-`) && !segment.endsWith(CLONE_SUFFIX);
}

function segmentMatchesFamily(
  segment: string,
  index: number,
  count: number,
  prefix: ModelFamilyPrefix,
): boolean {
  if (index === count - 1) return modelSegmentMatches(segment, prefix);
  if (index === 0) return false;
  return gatewaySegmentMatches(segment, prefix.value);
}

export function resolveModelFamily(name: string): ModelFamilyProfile | undefined {
  const segments = modelNameSegments(name);
  if (segments.length === 0) return undefined;
  let resolved: ModelFamilyProfile | undefined;
  let resolvedLength = 0;
  for (const family of MODEL_FAMILIES) {
    for (const prefix of family.prefixes) {
      const hit = segments.some((segment, index) =>
        segmentMatchesFamily(segment, index, segments.length, prefix),
      );
      if (hit && prefix.value.length > resolvedLength) {
        resolved = family;
        resolvedLength = prefix.value.length;
      }
    }
  }
  return resolved;
}

export function familyAdaptationPrefixes(name: string): readonly string[] {
  return resolveModelFamily(name)?.adaptationPrefixes ?? [];
}

export function imagePricingForModel(name: string | undefined): ImageTokenPricing | undefined {
  if (name === undefined) return undefined;
  return resolveModelFamily(name)?.imagePricing;
}

export function maxOutputDefaultsForModel(
  name: string | undefined,
): FamilyMaxOutputDefaults | undefined {
  if (name === undefined) return undefined;
  return resolveModelFamily(name)?.maxOutputDefaults;
}

export function reasoningEffortForModel(
  name: string | undefined,
): FamilyReasoningEffort | undefined {
  if (name === undefined) return undefined;
  return resolveModelFamily(name)?.reasoningEffort;
}

export function thinkingHistoryForModel(
  name: string | undefined,
): FamilyThinkingHistory | undefined {
  if (name === undefined) return undefined;
  return resolveModelFamily(name)?.thinkingHistory;
}

export function fullReasoningEchoRequired(name: string | undefined, hasTools: boolean): boolean {
  if (name === undefined || !hasTools) return false;
  return thinkingHistoryForModel(name)?.fullEchoWithTools === true;
}

export function ignoredSamplingParamsForModel(name: string | undefined): readonly string[] {
  if (name === undefined) return [];
  return thinkingHistoryForModel(name)?.ignoredWhileThinking ?? [];
}
