/**
 * Localized model-alias helper — `effectiveModelAlias` from the v1 core,
 * copied so the SDK keeps the public helper without importing `agent-core`.
 * The v2 engine has no equivalent surface (its config is section-based); the
 * CLI's model pickers / status bars consume this through the SDK.
 */
import {
  BUDGET_THINKING_EFFORTS,
  matchKnownAnthropicModelProfile,
  matchUnknownClaudeProfile,
} from '@moonshot-ai/kosong/providers/anthropic-profile';

import type { ModelAlias, ProviderType } from '#/types';

export function effectiveModelAlias(alias: ModelAlias, providerType?: ProviderType): ModelAlias {
  const { overrides, ...base } = alias;
  const effective: ModelAlias = overrides === undefined ? alias : { ...base, ...overrides };

  if (
    overrides?.supportEfforts !== undefined &&
    overrides.defaultEffort === undefined &&
    effective.defaultEffort !== undefined &&
    !overrides.supportEfforts.includes(effective.defaultEffort)
  ) {
    delete effective.defaultEffort;
  }

  // The input cap can never exceed the effective total window (an override
  // lowering max_context_size must not leave a stale, larger cap behind).
  // Build a copy for the clamp — never rewrite the caller's config record.
  const clamped =
    effective.maxInputSize !== undefined && effective.maxInputSize > effective.maxContextSize
      ? { ...effective, maxInputSize: effective.maxContextSize }
      : effective;

  return withAnthropicProfile(clamped, providerType);
}

function withAnthropicProfile(model: ModelAlias, providerType?: ProviderType): ModelAlias {
  const protocol = model.protocol ?? providerType;
  const profile =
    providerType !== undefined && providerType !== 'kimi' && protocol === 'anthropic'
      ? (matchKnownAnthropicModelProfile(model.model) ?? matchUnknownClaudeProfile(model.model))
      : matchKnownAnthropicModelProfile(model.model);
  if (profile === undefined) {
    if (protocol === 'anthropic' && model.adaptiveThinking === false) {
      const capabilities = model.capabilities ?? [];
      const hasThinking = capabilities.some(
        (candidate) => candidate.trim().toLowerCase() === 'thinking',
      );
      const supportEfforts = model.supportEfforts ?? [...BUDGET_THINKING_EFFORTS];
      return {
        ...model,
        capabilities: hasThinking ? capabilities : [...capabilities, 'thinking'],
        supportEfforts,
        defaultEffort:
          model.defaultEffort ?? (supportEfforts.includes('high') ? 'high' : undefined),
      };
    }
    return model;
  }

  const capability = profile.canDisableThinking ? 'thinking' : 'always_thinking';
  const capabilities = model.capabilities ?? [];
  const hasCapability = capabilities.some(
    (candidate) => candidate.trim().toLowerCase() === capability,
  );
  const supportEfforts =
    model.supportEfforts ??
    (model.adaptiveThinking === false ? [...BUDGET_THINKING_EFFORTS] : [...profile.efforts]);

  return {
    ...model,
    capabilities: hasCapability ? capabilities : [...capabilities, capability],
    supportEfforts,
    defaultEffort: model.defaultEffort ?? (supportEfforts.includes('high') ? 'high' : undefined),
  };
}

export function effectiveModelAliases(
  models: Record<string, ModelAlias>,
): Record<string, ModelAlias> {
  return Object.fromEntries(
    Object.entries(models).map(([alias, model]) => [alias, effectiveModelAlias(model)]),
  );
}
