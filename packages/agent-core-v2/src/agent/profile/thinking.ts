/**
 * `profile` domain — thinking-level resolution helpers.
 *
 * Resolves the effective `ThinkingEffort` from a requested level, the
 * `thinking` config section (`ThinkingConfig`, owned here in `profile`), and
 * the `defaultThinking` toggle. Pure functions; own no scoped state.
 */

import type { ThinkingEffort } from '#/app/llmProtocol/thinkingEffort';
import {
  type ModelThinkingMetadata,
  resolveThinkingEffortForModel,
} from '#/app/model/thinking';

import type { ThinkingConfig } from './configSection';

export interface ResolveThinkingLevelOptions {
  readonly defaultThinking?: boolean;
  readonly thinking?: ThinkingConfig;
  readonly model?: ModelThinkingMetadata;
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

  return resolveThinkingEffort(resolvedRequest, options.thinking, options.model);
}

export function resolveThinkingEffort(
  requested: string | undefined,
  defaults: ThinkingConfig | undefined,
  model?: ModelThinkingMetadata,
): ThinkingEffort {
  return resolveThinkingEffortForModel(requested, defaults, model);
}
