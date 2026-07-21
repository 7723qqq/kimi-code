/**
 * `model` domain (L2) — Astron (xunfei coding plan) effective-config overlay.
 *
 * When `KIMI_CODE_EXPERIMENTAL_XUNFEI_CODING_PLAN` (or the master
 * `KIMI_CODE_EXPERIMENTAL_FLAG`) is set and the `providers.astron` provider
 * entry exists in the effective config, synthesises one model alias per model
 * defined in `ASTRON_MODEL_DEFS` under `astron/{id}` keys. Each alias carries
 * `tool_use` + `thinking` capabilities and the model's context size.
 *
 * The overlay is applied ONLY to the in-memory `effective` view; its `strip`
 * removes all `astron/*` keys on the write path so they never reach
 * `config.toml`. Self-registered into `IConfigRegistry` at module load (see
 * `configOverlayContributions.ts`), so the `config` domain never imports this
 * domain's model semantics.
 */

import { parseBooleanEnv } from '#/_base/utils/env';
import type { ConfigEffectiveOverlay } from '#/app/config/config';
import { registerConfigOverlay } from '#/app/config/configOverlayContributions';
import { ASTRON_MODEL_DEFS, ASTRON_PROVIDER_KEY } from '@moonshot-ai/kosong';

const ASTRON_MODEL_KEY_PREFIX = `${ASTRON_PROVIDER_KEY}/`;

const XUNFEI_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_XUNFEI_CODING_PLAN';
const MASTER_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_FLAG';

function isTruthy(value: string | undefined): boolean {
  return parseBooleanEnv(value) === true;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stripAstronKeys(value: unknown): unknown {
  if (
    !(typeof value === 'object' && value !== null && !Array.isArray(value))
  ) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (!key.startsWith(ASTRON_MODEL_KEY_PREFIX)) {
      out[key] = record[key];
    }
  }
  return out;
}

export const astronModelEnvOverlay: ConfigEffectiveOverlay = {
  apply(effective, getEnv, validate) {
    const xunfeiFlag = isTruthy(getEnv(XUNFEI_FLAG_ENV));
    const masterFlag = isTruthy(getEnv(MASTER_FLAG_ENV));

    if (!xunfeiFlag && !masterFlag) {
      return [];
    }

    const providers = asRecord(effective['providers']);
    if (!(ASTRON_PROVIDER_KEY in providers)) {
      return [];
    }

    const models = asRecord(effective['models']);
    const nextModels: Record<string, unknown> = { ...models };

    for (const def of ASTRON_MODEL_DEFS) {
      const aliasKey = `${ASTRON_MODEL_KEY_PREFIX}${def.id}`;
      nextModels[aliasKey] = {
        providerId: ASTRON_PROVIDER_KEY,
        maxContextSize: def.contextLength,
        capabilities: ['tool_use', 'thinking'],
      };
    }

    effective['models'] = validate('models', nextModels);
    return ['models'];
  },

  strip(domain, value, _rawSnake) {
    switch (domain) {
      case 'models':
        return stripAstronKeys(value);
      default:
        return value;
    }
  },
};

registerConfigOverlay(astronModelEnvOverlay);
