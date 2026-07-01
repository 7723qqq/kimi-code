/**
 * `chatProvider` domain (L1) — applies `KIMI_MODEL_*` request overrides to a
 * `ChatProvider`.
 *
 * The override values are resolved by the `KIMI_MODEL_*` env overlay
 * (`#/model/envOverlay.ts`) into the `modelOverrides` effective config value;
 * this module applies that resolved value to a `ChatProvider`. It performs no
 * env access itself and owns no config schema — it is pure provider-adapter
 * adaptation, which is why it lives here rather than in `config` or `model`.
 */

import {
  type ChatProvider,
  type GenerationKwargs,
  KimiChatProvider,
  type ThinkingEffort,
} from '@moonshot-ai/kosong';

export interface KimiModelOverrides {
  readonly temperature?: number;
  readonly topP?: number;
  readonly thinkingKeep?: string;
  readonly maxCompletionTokens?: number;
}

export function applyKimiModelOverrides(
  provider: ChatProvider,
  overrides: KimiModelOverrides | undefined,
  thinkingLevel: ThinkingEffort,
): ChatProvider {
  if (!(provider instanceof KimiChatProvider) || overrides === undefined) return provider;

  const kwargs: GenerationKwargs = {};
  if (overrides.temperature !== undefined) kwargs.temperature = overrides.temperature;
  if (overrides.topP !== undefined) kwargs.top_p = overrides.topP;
  let out = Object.keys(kwargs).length > 0 ? provider.withGenerationKwargs(kwargs) : provider;

  const keep = overrides.thinkingKeep;
  if (keep !== undefined && keep.length > 0 && thinkingLevel !== 'off') {
    out = out.withExtraBody({ thinking: { keep } });
  }
  return out;
}
