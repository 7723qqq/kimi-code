export interface ImageTokenPricing {
  readonly patchPx: number;
  readonly downsampleRatio: number;
  readonly scaleUpFloorPx: number;
  readonly tokenCap: number;
  readonly fallbackTokens: number;
}

export type PromptShape = 'minimal';

/**
 * Per-model-family constants for pricing and prompt shape. Wire encoding
 * (thinking fields, effort names) is not modelled here: it belongs to the
 * protocol bases in `human/llm/requester/bases` and to the provider wire
 * contract in `@moonshot-ai/kosong`.
 */
export interface ModelFamilyProfile {
  readonly id: string;
  readonly prefixes: readonly string[];
  readonly adaptationPrefixes: readonly string[];
  readonly curatedAdaptation?: boolean;
  readonly promptShape?: PromptShape;
  readonly imagePricing?: ImageTokenPricing;
  readonly reasoningEffort?: FamilyReasoningEffort;
}

export interface FamilyReasoningEffort {
  readonly historyDefault: string;
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

const MODEL_FAMILIES: readonly ModelFamilyProfile[] = Object.freeze([
  Object.freeze({
    id: 'deepseek',
    prefixes: Object.freeze(['deepseek', 'xopdeepseek']),
    adaptationPrefixes: Object.freeze(['deepseek']),
    curatedAdaptation: true,
    promptShape: 'minimal',
    imagePricing: DEEPSEEK_IMAGE_PRICING,
    reasoningEffort: DEEPSEEK_REASONING_EFFORT,
  }),
]);

export function normalizeModelName(name: string): string {
  const tail = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name;
  return tail.trim().toLowerCase();
}

export function resolveModelFamily(name: string): ModelFamilyProfile | undefined {
  const normalized = normalizeModelName(name);
  if (normalized.length === 0) return undefined;
  let resolved: ModelFamilyProfile | undefined;
  let resolvedLength = 0;
  for (const family of MODEL_FAMILIES) {
    for (const prefix of family.prefixes) {
      if (prefix.length > resolvedLength && normalized.startsWith(prefix)) {
        resolved = family;
        resolvedLength = prefix.length;
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

export function reasoningEffortForModel(
  name: string | undefined,
): FamilyReasoningEffort | undefined {
  if (name === undefined) return undefined;
  return resolveModelFamily(name)?.reasoningEffort;
}

export function promptShapeForModel(name: string | undefined): PromptShape | undefined {
  if (name === undefined) return undefined;
  return resolveModelFamily(name)?.promptShape;
}
