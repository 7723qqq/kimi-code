/**
 * The DeepSeek vision accounting is a derivation from these constants,
 * calibrated against a live endpoint — not a reproduction of a published spec,
 * and not exact. Measured against `workbuddy/deepseek-v4.1-flash` (image portion
 * = `prompt_tokens` minus a text-only baseline), formula → measured:
 * 200×200 169→185, 512×512 169→185, 1024×1024 625→653, 1024×512 338→341
 * (deltas +3…+28). Treat every figure here as an estimate.
 *
 * `fallbackTokens` (dimensions unknown) and `tokenCap` (grid ceiling) are
 * independent knobs that happen to share the value 1024 today; an endpoint
 * change to either must not move the other.
 */
export interface ImageTokenPricing {
  readonly patchPx: number;
  readonly downsampleRatio: number;
  readonly scaleUpFloorPx: number;
  readonly tokenCap: number;
  readonly fallbackTokens: number;
}

export type PromptShape = 'minimal';

/**
 * How a family wants prior-turn reasoning echoed back to the wire.
 *
 * DeepSeek requires the full chain of thought to be replayed whenever the
 * request carries `tools`, and rejects a request that omits it with HTTP 400.
 * The requirement is a property of the *request shape*, not of any provider
 * trait, so it is modelled here rather than on the requester's trait hooks.
 */
export interface FamilyThinkingHistory {
  readonly fullEchoWithTools: boolean;
  /**
   * Sampling parameters the family silently ignores while thinking is on.
   * Sending them is not an error, but they have no effect, so they are dropped
   * instead of being presented to the user as if they applied.
   */
  readonly ignoredWhileThinking?: readonly string[];
}

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
  readonly thinkingHistory?: FamilyThinkingHistory;
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

/**
 * DeepSeek, per https://api-docs.deepseek.com/guides/thinking_mode:
 * "for requests carrying the `tools` parameter, the `reasoning_content` must be
 * fully passed back to the API in all subsequent requests — even for turns
 * where the model did not perform a tool call. If your code does not correctly
 * pass back `reasoning_content`, the API will return a 400 error."
 *
 * The same page records the effort vocabulary as a many-to-one collapse
 * (minimal→low, low→low, medium→high, high→high, xhigh→high, max→max) rather
 * than a set mismatch, and lists the sampling parameters that thinking mode
 * accepts but silently ignores.
 */
const DEEPSEEK_THINKING_HISTORY: FamilyThinkingHistory = Object.freeze({
  fullEchoWithTools: true,
  ignoredWhileThinking: Object.freeze([
    'temperature',
    'presence_penalty',
    'frequency_penalty',
  ]),
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
    thinkingHistory: DEEPSEEK_THINKING_HISTORY,
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

export function thinkingHistoryForModel(
  name: string | undefined,
): FamilyThinkingHistory | undefined {
  if (name === undefined) return undefined;
  return resolveModelFamily(name)?.thinkingHistory;
}

/**
 * True when this family requires the whole reasoning history to be replayed on
 * every request that carries tools — the condition DeepSeek documents as a hard
 * requirement (a request that omits it is rejected with HTTP 400).
 */
export function fullReasoningEchoRequired(
  name: string | undefined,
  hasTools: boolean,
): boolean {
  if (name === undefined || !hasTools) return false;
  return thinkingHistoryForModel(name)?.fullEchoWithTools === true;
}

/**
 * Sampling parameter names this family silently ignores while thinking is on.
 * Returns an empty list for families that declare none, so callers can filter
 * unconditionally.
 */
export function ignoredSamplingParamsForModel(name: string | undefined): readonly string[] {
  if (name === undefined) return [];
  return thinkingHistoryForModel(name)?.ignoredWhileThinking ?? [];
}

export function promptShapeForModel(name: string | undefined): PromptShape | undefined {
  if (name === undefined) return undefined;
  return resolveModelFamily(name)?.promptShape;
}
