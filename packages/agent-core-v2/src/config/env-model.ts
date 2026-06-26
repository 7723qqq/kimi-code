/**
 * `config` domain (L2) — `KIMI_MODEL_*` environment overlay.
 *
 * Ported from v1 (`packages/agent-core/src/config/env-model.ts`) and adapted to
 * the section-registry model: instead of producing a whole `KimiConfig`, the
 * overlay mutates the per-section `effective` map in place — injecting the
 * reserved env provider/model alias and the env-driven default model and
 * thinking settings.
 *
 * The overlay is applied ONLY to the in-memory `effective` view, never to the
 * raw snake_case object used for writes, so the synthesized entries can never
 * be persisted back to config.toml (no separate strip step is needed).
 */

import { ErrorCodes, KimiError } from '#/errors';

/** Reserved keys for the env-driven synthetic provider / model alias. */
export const ENV_MODEL_PROVIDER_KEY = '__kimi_env__';
export const ENV_MODEL_ALIAS_KEY = '__kimi_env_model__';

const ALLOWED_TYPES = ['kimi', 'anthropic', 'openai'] as const;
type EnvProviderType = (typeof ALLOWED_TYPES)[number];

const DEFAULT_BASE_URL: Partial<Record<EnvProviderType, string>> = {
  kimi: 'https://api.moonshot.ai/v1',
  openai: 'https://api.openai.com/v1',
  // anthropic: omitted -> let the Anthropic SDK pick its default
};

/** Default context window (256K) used when KIMI_MODEL_MAX_CONTEXT_SIZE is unset. */
const DEFAULT_MAX_CONTEXT_SIZE = 262144;

/** Default capabilities when KIMI_MODEL_CAPABILITIES is unset. */
const DEFAULT_CAPABILITIES = ['image_in', 'thinking'];

type Env = Readonly<Record<string, string | undefined>>;

function trimmed(value: string | undefined): string | undefined {
  const t = value?.trim();
  return t === undefined || t.length === 0 ? undefined : t;
}

function fail(message: string): never {
  throw new KimiError(ErrorCodes.CONFIG_INVALID, message);
}

function parsePositiveInt(raw: string, varName: string): number {
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
    fail(`${varName} must be a positive integer, got "${raw}".`);
  }
  return Number(raw);
}

function parseProviderType(raw: string | undefined): EnvProviderType {
  if (raw === undefined) return 'kimi';
  const normalized = raw.toLowerCase();
  if (!(ALLOWED_TYPES as readonly string[]).includes(normalized)) {
    fail(`KIMI_MODEL_PROVIDER_TYPE must be one of ${ALLOWED_TYPES.join(', ')}, got "${raw}".`);
  }
  return normalized as EnvProviderType;
}

function parseCapabilities(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const caps = raw
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c.length > 0);
  return caps.length === 0 ? undefined : caps;
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

function parseBooleanValue(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return undefined;
}

// Treat a non-empty but unparseable value (e.g. a typo like `flase`) as a
// config error so it fails fast like the other KIMI_MODEL_* values, instead of
// silently keeping config.toml's existing value.
function parseBooleanVar(raw: string | undefined, varName: string): boolean | undefined {
  const value = trimmed(raw);
  if (value === undefined) return undefined;
  const parsed = parseBooleanValue(value);
  if (parsed === undefined) {
    fail(`${varName} must be a boolean (true/false/1/0/yes/no/on/off), got "${raw}".`);
  }
  return parsed;
}

/**
 * When `KIMI_MODEL_NAME` is set, synthesize one provider + one model alias from
 * the `KIMI_MODEL_*` environment variables and overlay them onto `effective`:
 * the reserved provider/model entries, `defaultModel`, and the thinking
 * settings. Mutates `effective` in place; returns the list of domains whose
 * value changed. Validates the affected sections through `validate` (the
 * section registry) so the synthesized entries honor the same constraints.
 *
 * Throws `KimiError(CONFIG_INVALID)` on malformed env input; callers running a
 * lenient load should catch it and surface it as an env warning.
 */
export function applyEnvModelOverlay(
  effective: Record<string, unknown>,
  env: Env,
  validate: (domain: string, value: unknown) => unknown,
): readonly string[] {
  const model = trimmed(env['KIMI_MODEL_NAME']);
  if (model === undefined) return [];

  const apiKey = trimmed(env['KIMI_MODEL_API_KEY']);
  if (apiKey === undefined) {
    fail('KIMI_MODEL_NAME is set but KIMI_MODEL_API_KEY is missing.');
  }

  const maxContextRaw = trimmed(env['KIMI_MODEL_MAX_CONTEXT_SIZE']);
  const maxContextSize =
    maxContextRaw === undefined
      ? DEFAULT_MAX_CONTEXT_SIZE
      : parsePositiveInt(maxContextRaw, 'KIMI_MODEL_MAX_CONTEXT_SIZE');

  const type = parseProviderType(trimmed(env['KIMI_MODEL_PROVIDER_TYPE']));
  const baseUrl = trimmed(env['KIMI_MODEL_BASE_URL']) ?? DEFAULT_BASE_URL[type];

  const provider: Record<string, unknown> = { type, apiKey };
  if (baseUrl !== undefined) provider['baseUrl'] = baseUrl;

  const maxOutputRaw = trimmed(env['KIMI_MODEL_MAX_OUTPUT_SIZE']);
  const maxOutputSize =
    maxOutputRaw !== undefined
      ? parsePositiveInt(maxOutputRaw, 'KIMI_MODEL_MAX_OUTPUT_SIZE')
      : undefined;
  const capabilities = parseCapabilities(env['KIMI_MODEL_CAPABILITIES']) ?? DEFAULT_CAPABILITIES;
  const displayName = trimmed(env['KIMI_MODEL_DISPLAY_NAME']);
  const reasoningKey = trimmed(env['KIMI_MODEL_REASONING_KEY']);
  const adaptiveThinking = parseBooleanVar(
    env['KIMI_MODEL_ADAPTIVE_THINKING'],
    'KIMI_MODEL_ADAPTIVE_THINKING',
  );

  const alias: Record<string, unknown> = {
    provider: ENV_MODEL_PROVIDER_KEY,
    model,
    maxContextSize,
    capabilities,
  };
  if (displayName !== undefined) alias['displayName'] = displayName;
  if (maxOutputSize !== undefined) alias['maxOutputSize'] = maxOutputSize;
  if (reasoningKey !== undefined) alias['reasoningKey'] = reasoningKey;
  if (adaptiveThinking !== undefined) alias['adaptiveThinking'] = adaptiveThinking;

  const thinkingMode = trimmed(env['KIMI_MODEL_THINKING_MODE']);
  const thinkingEffort = trimmed(env['KIMI_MODEL_THINKING_EFFORT']);
  const defaultThinking = parseBooleanVar(
    env['KIMI_MODEL_DEFAULT_THINKING'],
    'KIMI_MODEL_DEFAULT_THINKING',
  );

  const changed: string[] = [];

  const providers = asRecord(effective['providers']);
  const nextProviders = { ...providers, [ENV_MODEL_PROVIDER_KEY]: provider };
  effective['providers'] = validate('providers', nextProviders);
  changed.push('providers');

  const models = asRecord(effective['models']);
  const nextModels = { ...models, [ENV_MODEL_ALIAS_KEY]: alias };
  effective['models'] = validate('models', nextModels);
  changed.push('models');

  effective['defaultModel'] = ENV_MODEL_ALIAS_KEY;
  changed.push('defaultModel');

  if (thinkingMode !== undefined || thinkingEffort !== undefined) {
    const baseThinking = asRecord(effective['thinking']);
    const nextThinking: Record<string, unknown> = { ...baseThinking };
    if (thinkingMode !== undefined) nextThinking['mode'] = thinkingMode;
    if (thinkingEffort !== undefined) nextThinking['effort'] = thinkingEffort;
    effective['thinking'] = validate('thinking', nextThinking);
    changed.push('thinking');
  }

  if (defaultThinking !== undefined) {
    effective['defaultThinking'] = defaultThinking;
    changed.push('defaultThinking');
  }

  return changed;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Strip env-synthesized entries from a section value about to be written back
 * to disk. `set`/`replace` callers hand us values they read from `effective`
 * (which carries the env overlay); this guarantees the reserved provider/model
 * and the env `defaultModel` never reach config.toml, mirroring v1's
 * `stripEnvModelConfig`. `rawSnake` (the on-disk clone) supplies the value to
 * restore for `defaultModel`. Returns `undefined` when the domain should be
 * removed entirely.
 */
export function stripEnvForDomain(
  domain: string,
  value: unknown,
  rawSnake: Record<string, unknown>,
): unknown {
  switch (domain) {
    case 'providers':
      return withoutKey(value, ENV_MODEL_PROVIDER_KEY);
    case 'models':
      return withoutKey(value, ENV_MODEL_ALIAS_KEY);
    case 'defaultModel':
      if (value !== ENV_MODEL_ALIAS_KEY) return value;
      return typeof rawSnake['default_model'] === 'string' ? rawSnake['default_model'] : undefined;
    default:
      return value;
  }
}

function withoutKey(value: unknown, key: string): unknown {
  if (!asRecordHas(value, key)) return value;
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  delete out[key];
  return out;
}

function asRecordHas(value: unknown, key: string): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && key in value;
}
