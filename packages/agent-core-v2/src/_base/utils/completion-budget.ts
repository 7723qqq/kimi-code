/**
 * Completion-token budget — resolves env/config caps and applies them to a
 * chat provider.
 */

import type { ChatProvider, ModelCapability } from '@moonshot-ai/kosong';

export interface CompletionBudgetConfig {
  readonly hardCap?: number;
  readonly fallback?: number;
}

const MIN_FLOOR = 1;
const DEFAULT_UNKNOWN_CONTEXT_FALLBACK = 32000;

export function resolveCompletionBudget(args: {
  readonly maxOutputSize?: number;
  readonly reservedContextSize?: number;
  readonly maxCompletionTokensCap?: number;
}): CompletionBudgetConfig | undefined {
  if (args.maxCompletionTokensCap !== undefined) {
    if (args.maxCompletionTokensCap <= 0) return undefined;
    return { hardCap: args.maxCompletionTokensCap };
  }
  if (args.maxOutputSize !== undefined && args.maxOutputSize > 0) {
    return { hardCap: args.maxOutputSize };
  }
  if (args.reservedContextSize !== undefined && args.reservedContextSize > 0) {
    return { fallback: args.reservedContextSize };
  }
  return { fallback: DEFAULT_UNKNOWN_CONTEXT_FALLBACK };
}

export function computeCompletionBudgetCap(args: {
  readonly budget: CompletionBudgetConfig;
  readonly capability: ModelCapability | undefined;
}): number {
  const maxCtx = args.capability?.max_context_tokens ?? 0;
  const cap =
    args.budget.hardCap ??
    (maxCtx > 0 ? maxCtx : args.budget.fallback ?? DEFAULT_UNKNOWN_CONTEXT_FALLBACK);
  return Math.max(MIN_FLOOR, cap);
}

export function applyCompletionBudget(args: {
  readonly provider: ChatProvider;
  readonly budget: CompletionBudgetConfig | undefined;
  readonly capability: ModelCapability | undefined;
}): ChatProvider {
  if (args.budget === undefined) return args.provider;
  if (args.provider.withMaxCompletionTokens === undefined) return args.provider;
  const cap = computeCompletionBudgetCap({
    budget: args.budget,
    capability: args.capability,
  });
  return args.provider.withMaxCompletionTokens(cap);
}
