/**
 * `profile` domain — thinking-level resolution helpers.
 *
 * Resolves the effective `ThinkingEffort` from a requested level, the
 * `thinking` config section (`ThinkingConfig`, owned here in `profile`), and
 * the `defaultThinking` toggle. Pure functions; own no scoped state.
 */

import type { ThinkingEffort } from '#/app/llmProtocol';

import type { ThinkingConfig } from './configSection';

const DEFAULT_THINKING_EFFORT: ThinkingEffort = 'high';
const THINKING_EFFORTS = new Set<ThinkingEffort>(['low', 'medium', 'high', 'xhigh', 'max']);

export interface ResolveThinkingLevelOptions {
  readonly defaultThinking?: boolean;
  readonly thinking?: ThinkingConfig;
}

export function resolveThinkingLevel(
  requestedThinking: string | undefined,
  options: ResolveThinkingLevelOptions,
): ThinkingEffort {
  const resolvedRequest =
    requestedThinking !== undefined && requestedThinking.trim().length > 0
      ? requestedThinking
      : options.defaultThinking === false
        ? 'off'
        : undefined;

  return resolveThinkingEffort(resolvedRequest, options.thinking);
}

export function resolveThinkingEffort(
  requested: string | undefined,
  defaults: ThinkingConfig | undefined,
): ThinkingEffort {
  const configEffort = parseEffort(defaults?.effort) ?? DEFAULT_THINKING_EFFORT;
  const normalized = requested?.trim().toLowerCase();
  if (!normalized) {
    if (defaults?.mode === 'off') return 'off';
    return configEffort;
  }
  if (normalized === 'off') return 'off';
  if (normalized === 'on') return configEffort;
  return parseEffort(normalized) ?? configEffort;
}

function parseEffort(value: string | undefined): ThinkingEffort | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized !== undefined && THINKING_EFFORTS.has(normalized as ThinkingEffort)
    ? (normalized as ThinkingEffort)
    : undefined;
}
