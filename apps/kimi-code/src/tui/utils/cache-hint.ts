import type { CacheHintConfig } from '#/utils/cache-hint-config';

export interface CacheHintInput {
  /** Current time, epoch ms. */
  readonly now: number;
  /** Last session activity, epoch ms. Missing → skip. */
  readonly lastActiveAt?: number;
  /** Current context size in tokens. Missing → skip (no local estimation). */
  readonly totalTokens?: number;
  /** Upstream model ID used to look up the rule. Missing/unconfigured → skip. */
  readonly modelId?: string;
  /** Fetch failure → undefined → skip. */
  readonly config?: CacheHintConfig;
  /** User dismissed the cache hint (tui.toml). */
  readonly dismissed: boolean;
}

export type CacheHintSkipReason =
  | 'dismissed'
  | 'missing_config'
  | 'missing_model'
  | 'missing_activity'
  | 'missing_tokens'
  | 'rule_missing'
  | 'clock_skew'
  | 'within_duration'
  | 'below_threshold';

export type CacheHintDecision =
  | { readonly kind: 'skip'; readonly reason: CacheHintSkipReason }
  | { readonly kind: 'hint'; readonly idleSeconds: number; readonly totalTokens: number };

/**
 * Shared trigger rule for both the resume and the idle scenarios. Every branch
 * that cannot prove the cache expired skips and names why, so a coverage gap
 * (`rule_missing`, `missing_config`) is countable instead of silent.
 */
export function evaluateCacheHint(input: CacheHintInput): CacheHintDecision {
  if (input.dismissed) return { kind: 'skip', reason: 'dismissed' };
  const { config, modelId, lastActiveAt, totalTokens } = input;
  if (config === undefined) return { kind: 'skip', reason: 'missing_config' };
  if (modelId === undefined) return { kind: 'skip', reason: 'missing_model' };
  if (lastActiveAt === undefined) return { kind: 'skip', reason: 'missing_activity' };
  if (totalTokens === undefined) return { kind: 'skip', reason: 'missing_tokens' };
  const rule = config.config[modelId];
  if (rule === undefined) return { kind: 'skip', reason: 'rule_missing' };
  const idleMs = input.now - lastActiveAt;
  if (idleMs < 0) return { kind: 'skip', reason: 'clock_skew' };
  if (idleMs <= rule.cache_duration * 1000) return { kind: 'skip', reason: 'within_duration' };
  if (totalTokens < rule.min_tokens_to_hint) return { kind: 'skip', reason: 'below_threshold' };
  return { kind: 'hint', idleSeconds: Math.floor(idleMs / 1000), totalTokens };
}

/** `45m` / `3h 20m` / `26d 22h`. */
export function formatIdleDuration(idleSeconds: number): string {
  const minutes = Math.max(1, Math.floor(idleSeconds / 60));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const restMinutes = minutes % 60;
    return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}
