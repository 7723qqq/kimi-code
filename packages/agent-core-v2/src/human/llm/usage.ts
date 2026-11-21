import type { TokenUsage } from '@moonshot-ai/core/llm/usage';

export type { TokenUsage } from '@moonshot-ai/core/llm/usage';

export function emptyUsage(): TokenUsage {
  return { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 };
}

export function inputTotal(usage: TokenUsage): number {
  return usage.inputOther + (usage.inputCacheRead ?? 0) + usage.inputCacheCreation;
}

export function grandTotal(usage: TokenUsage): number {
  return inputTotal(usage) + usage.output;
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputOther: a.inputOther + b.inputOther,
    output: a.output + b.output,
    inputCacheRead: (a.inputCacheRead ?? 0) + (b.inputCacheRead ?? 0),
    inputCacheCreation: a.inputCacheCreation + b.inputCacheCreation,
  };
}

export function chargeableTokens(usage: TokenUsage): number {
  return usage.inputOther + usage.inputCacheCreation + usage.output;
}

export function mergeUsagePatch(
  base: TokenUsage | undefined,
  patch: Partial<TokenUsage>,
): TokenUsage {
  return {
    inputOther: patch.inputOther ?? base?.inputOther ?? 0,
    output: patch.output ?? base?.output ?? 0,
    inputCacheRead: patch.inputCacheRead ?? base?.inputCacheRead ?? 0,
    inputCacheCreation: patch.inputCacheCreation ?? base?.inputCacheCreation ?? 0,
  };
}
