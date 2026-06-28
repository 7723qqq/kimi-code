/**
 * `kosong` domain (L1) — `models` config-section schema and TOML transforms.
 *
 * Owns the `[models.<alias>]` configuration section (model alias → provider +
 * context/capabilities) consumed by `ProviderManager` to resolve a runtime
 * provider. Includes the snake_case ↔ camelCase TOML transforms that preserve
 * user-defined alias names (record keys) while converting each alias's fields.
 * Registered into `IConfigRegistry` by `ProtocolHandlerRegistry` (the kosong
 * domain's Core service) on construction, so the `config` domain never imports
 * this domain's types.
 */

import { z } from 'zod';

import {
  camelToSnake,
  cloneRecord,
  isPlainObject,
  setDefined,
  transformPlainObject,
} from '#/config/toml';

export const MODELS_SECTION = 'models';

export const ModelAliasSchema = z.object({
  provider: z.string(),
  model: z.string(),
  maxContextSize: z.number().int().min(1),
  maxOutputSize: z.number().int().min(1).optional(),
  capabilities: z.array(z.string()).optional(),
  displayName: z.string().optional(),
  reasoningKey: z.string().optional(),
  adaptiveThinking: z.boolean().optional(),
});

export type ModelAlias = z.infer<typeof ModelAliasSchema>;

export const ModelsSectionSchema = z.record(z.string(), ModelAliasSchema);

export type ModelsSection = z.infer<typeof ModelsSectionSchema>;

/** Read transform: preserve alias names; camelCase each alias's fields. */
export const modelsFromToml = (rawSnake: unknown): unknown => {
  if (!isPlainObject(rawSnake)) return rawSnake;
  const out: Record<string, unknown> = {};
  for (const [alias, entry] of Object.entries(rawSnake)) {
    out[alias] = isPlainObject(entry) ? transformPlainObject(entry) : entry;
  }
  return out;
};

/** Write transform: preserve alias names; snake_case each alias's fields. */
export const modelsToToml = (value: unknown, rawSnake: unknown): unknown => {
  if (!isPlainObject(value)) return value;
  const rawSub = cloneRecord(rawSnake);
  const out: Record<string, unknown> = {};
  for (const [alias, entry] of Object.entries(value)) {
    if (!isPlainObject(entry)) {
      out[alias] = entry;
      continue;
    }
    const rawEntry = cloneRecord(rawSub[alias]);
    const converted: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(entry)) {
      if (key === 'capabilities' && Array.isArray(field)) {
        converted[camelToSnake(key)] = [...field];
      } else {
        setDefined(converted, camelToSnake(key), field);
      }
    }
    out[alias] = { ...rawEntry, ...converted };
  }
  return out;
};
