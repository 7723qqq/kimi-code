/**
 * `model` domain (L2) — `models` config-section TOML transforms.
 *
 * Snake_case ↔ camelCase transforms that preserve user-defined alias names
 * (record keys) while converting each alias's fields. Registered into
 * `IConfigRegistry` by `ModelService` on construction, so the `config` domain
 * never imports this domain's types.
 */

import {
  camelToSnake,
  cloneRecord,
  isPlainObject,
  setDefined,
  transformPlainObject,
} from '#/app/config/toml';

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
