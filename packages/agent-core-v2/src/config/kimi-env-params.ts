/**
 * `config` domain (L2) — environment-driven Kimi provider request parameters.
 */

import {
  type ChatProvider,
  type GenerationKwargs,
  KimiChatProvider,
  type ThinkingEffort,
} from '@moonshot-ai/kosong';

type Env = Readonly<Record<string, string | undefined>>;

export function applyKimiEnvSamplingParams(
  provider: ChatProvider,
  env: Env = process.env,
): ChatProvider {
  if (!(provider instanceof KimiChatProvider)) return provider;

  const kwargs: GenerationKwargs = {};
  const temperature = parseFloatEnv(env['KIMI_MODEL_TEMPERATURE']);
  if (temperature !== undefined) kwargs.temperature = temperature;
  const topP = parseFloatEnv(env['KIMI_MODEL_TOP_P']);
  if (topP !== undefined) kwargs.top_p = topP;

  return Object.keys(kwargs).length > 0 ? provider.withGenerationKwargs(kwargs) : provider;
}

export function applyKimiEnvThinkingKeep(
  provider: ChatProvider,
  thinkingLevel: ThinkingEffort,
  env: Env = process.env,
): ChatProvider {
  if (!(provider instanceof KimiChatProvider)) return provider;
  const keep = env['KIMI_MODEL_THINKING_KEEP']?.trim();
  if (keep === undefined || keep.length === 0 || thinkingLevel === 'off') return provider;
  return provider.withExtraBody({ thinking: { keep } });
}

function parseFloatEnv(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}
