/**
 * `config` domain (L2) — TOML read/write transforms.
 *
 * Ported from v1 (`packages/agent-core/src/config/toml.ts`) and decomposed so
 * the section-registry `ConfigService` can transform one domain at a time.
 * Files store keys in snake_case; in-memory values are camelCase. Unknown
 * top-level keys are preserved by the caller (`ConfigService` keeps a raw
 * snake_case clone for round-trip); the read transform only produces values
 * for keys it recognizes, matching v1.
 */

import { TomlError } from 'smol-toml';

import { describeUnknownError, isPlainObject } from './configPure';

export { TomlError };

/* ------------------------------------------------------------------ */
/*  Key conversion                                                     */
/* ------------------------------------------------------------------ */

export function snakeToCamel(str: string): string {
  return str.replaceAll(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

export function camelToSnake(str: string): string {
  return str.replaceAll(/[A-Z]/g, (ch: string) => `_${ch.toLowerCase()}`);
}

/* ------------------------------------------------------------------ */
/*  Read transform (snake_case file -> camelCase in-memory)            */
/* ------------------------------------------------------------------ */

/**
 * Transform parsed TOML data into the camelCase in-memory shape. Unknown
 * top-level object keys are dropped (they survive only in the caller's raw
 * clone for round-trip); unknown scalars are passed through.
 */
export function transformTomlData(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const targetKey = snakeToCamel(key);

    if (targetKey === 'providers' && isPlainObject(value)) {
      result[targetKey] = transformRecord(value, transformProviderData);
    } else if (targetKey === 'models' && isPlainObject(value)) {
      result[targetKey] = transformRecord(value, transformModelData);
    } else if (targetKey === 'thinking' && isPlainObject(value)) {
      result[targetKey] = transformPlainObject(value);
    } else if (targetKey === 'permission' && isPlainObject(value)) {
      result[targetKey] = transformPermissionData(value);
    } else if (targetKey === 'services' && isPlainObject(value)) {
      result[targetKey] = transformRecord(value, transformServiceData, snakeToCamel);
    } else if (targetKey === 'loopControl' && isPlainObject(value)) {
      result[targetKey] = transformLoopControlData(value);
    } else if (targetKey === 'background' && isPlainObject(value)) {
      result[targetKey] = transformPlainObject(value);
    } else if (targetKey === 'experimental' && isPlainObject(value)) {
      result[targetKey] = cloneRecord(value);
    } else if (targetKey === 'hooks' && Array.isArray(value)) {
      result[targetKey] = value.map((hook) =>
        isPlainObject(hook) ? transformPlainObject(hook) : hook,
      );
    } else if (isPlainObject(value)) {
      // Generic section (e.g. `session`, or a future simple section): camelCase
      // its internal keys. Unknown objects survive round-trip via the raw clone.
      result[targetKey] = transformPlainObject(value);
    } else {
      result[targetKey] = value;
    }
  }
  return result;
}

function transformRecord(
  value: Record<string, unknown>,
  transformEntry: (entry: Record<string, unknown>) => Record<string, unknown>,
  transformName: (name: string) => string = (name) => name,
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [entryName, entryConfig] of Object.entries(value)) {
    record[transformName(entryName)] = isPlainObject(entryConfig)
      ? transformEntry(entryConfig)
      : entryConfig;
  }
  return record;
}

function transformPlainObject(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[snakeToCamel(key)] = value;
  }
  return out;
}

function transformProviderData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const targetKey = snakeToCamel(key);
    if (targetKey === 'oauth') {
      out[targetKey] = isPlainObject(value) ? transformPlainObject(value) : value;
    } else if (targetKey === 'env' || targetKey === 'customHeaders') {
      out[targetKey] = cloneObjectValue(value);
    } else {
      out[targetKey] = value;
    }
  }
  return out;
}

function transformModelData(data: Record<string, unknown>): Record<string, unknown> {
  return transformPlainObject(data);
}

function transformPermissionData(data: Record<string, unknown>): Record<string, unknown> {
  const raw = transformPlainObject(data);
  const out: Record<string, unknown> = {};

  const rules: unknown[] = [];
  appendPermissionRules(rules, raw['rules']);
  appendPermissionRules(rules, raw['deny'], 'deny');
  appendPermissionRules(rules, raw['allow'], 'allow');
  appendPermissionRules(rules, raw['ask'], 'ask');
  if (rules.length > 0) {
    out['rules'] = rules;
  }
  return out;
}

function appendPermissionRules(
  target: unknown[],
  value: unknown,
  decision?: 'allow' | 'deny' | 'ask',
): void {
  if (value === undefined) return;
  const entries = Array.isArray(value) ? value : [value];
  for (const entry of entries) {
    target.push(transformPermissionRule(entry, decision));
  }
}

function transformPermissionRule(value: unknown, decision?: 'allow' | 'deny' | 'ask'): unknown {
  if (!isPlainObject(value)) return value;

  const rule = transformPlainObject(value);
  const tool = rule['tool'];
  const match = rule['match'];
  const pattern = rule['pattern'];
  const out: Record<string, unknown> = {};

  out['decision'] = decision !== undefined ? decision : rule['decision'];
  out['scope'] = rule['scope'];
  out['reason'] = rule['reason'];

  if (typeof tool === 'string') {
    const argPattern = typeof match === 'string' ? match : pattern;
    out['pattern'] = typeof argPattern === 'string' ? `${tool}(${argPattern})` : tool;
  } else {
    out['pattern'] = pattern;
  }

  return out;
}

function transformServiceData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const targetKey = snakeToCamel(key);
    if (targetKey === 'oauth') {
      out[targetKey] = isPlainObject(value) ? transformPlainObject(value) : value;
    } else if (targetKey === 'customHeaders') {
      out[targetKey] = cloneObjectValue(value);
    } else {
      out[targetKey] = value;
    }
  }
  return out;
}

function transformLoopControlData(data: Record<string, unknown>): Record<string, unknown> {
  const out = transformPlainObject(data);
  if (out['maxStepsPerTurn'] === undefined && out['maxStepsPerRun'] !== undefined) {
    out['maxStepsPerTurn'] = out['maxStepsPerRun'];
  }
  delete out['maxStepsPerRun'];
  return out;
}

/* ------------------------------------------------------------------ */
/*  Write transform (camelCase in-memory -> snake_case file)           */
/* ------------------------------------------------------------------ */

/**
 * Apply a single domain's in-memory value into the snake_case raw object used
 * for writing. Mutates `rawSnake`. Domains without a special writer fall back
 * to a plain camelCase->snake_case key mapping (scalars) or recursive key
 * conversion (plain objects), preserving unknown sub-fields via the raw clone.
 */
export function applySectionToToml(
  rawSnake: Record<string, unknown>,
  domain: string,
  value: unknown,
): void {
  const snakeKey = camelToSnake(domain);
  switch (domain) {
    case 'providers':
      setRecordSection(rawSnake, snakeKey, value, providerToToml);
      break;
    case 'models':
      setRecordSection(rawSnake, snakeKey, value, modelToToml);
      break;
    case 'thinking':
      setSection(rawSnake, snakeKey, value, thinkingToToml);
      break;
    case 'permission':
      setSection(rawSnake, snakeKey, value, permissionToToml);
      break;
    case 'services':
      setSection(rawSnake, snakeKey, value, servicesToToml);
      break;
    case 'loopControl':
      setSection(rawSnake, snakeKey, value, loopControlToToml);
      break;
    case 'background':
      setSection(rawSnake, snakeKey, value, backgroundToToml);
      break;
    case 'experimental':
      setSection(rawSnake, snakeKey, value, experimentalToToml);
      break;
    case 'hooks':
      setHooks(rawSnake, value);
      break;
    default:
      if (isPlainObject(value)) {
        setSection(rawSnake, snakeKey, value, plainObjectToToml);
      } else {
        setDefined(rawSnake, snakeKey, value);
      }
  }
}

function setRecordSection(
  out: Record<string, unknown>,
  snakeKey: string,
  value: unknown,
  toToml: (v: Record<string, unknown>, raw: unknown) => Record<string, unknown>,
): void {
  if (value === undefined) {
    delete out[snakeKey];
    return;
  }
  if (!isPlainObject(value)) {
    setDefined(out, snakeKey, value);
    return;
  }

  const rawSub = cloneRecord(out[snakeKey]);
  const converted: Record<string, unknown> = {};
  for (const [entryName, entryConfig] of Object.entries(value)) {
    converted[entryName] = isPlainObject(entryConfig)
      ? toToml(entryConfig, rawSub[entryName])
      : entryConfig;
  }

  if (Object.keys(converted).length > 0) {
    out[snakeKey] = converted;
  } else {
    delete out[snakeKey];
  }
}

function setSection(
  out: Record<string, unknown>,
  snakeKey: string,
  value: unknown,
  toToml: (v: Record<string, unknown>, raw: unknown) => Record<string, unknown>,
): void {
  if (value === undefined) {
    delete out[snakeKey];
    return;
  }
  if (!isPlainObject(value)) {
    setDefined(out, snakeKey, value);
    return;
  }
  const rawSub = cloneRecord(out[snakeKey]);
  const converted = toToml(value, rawSub);
  if (Object.keys(converted).length > 0) {
    out[snakeKey] = converted;
  } else {
    delete out[snakeKey];
  }
}

function providerToToml(provider: Record<string, unknown>, rawProvider: unknown): Record<string, unknown> {
  const out = cloneRecord(rawProvider);
  for (const [key, value] of Object.entries(provider)) {
    if (key === 'oauth' && isPlainObject(value)) {
      out[camelToSnake(key)] = plainObjectToToml(value, undefined);
    } else if ((key === 'env' || key === 'customHeaders') && value !== undefined) {
      out[camelToSnake(key)] = cloneUnknown(value);
    } else {
      setDefined(out, camelToSnake(key), value);
    }
  }
  return out;
}

function modelToToml(model: Record<string, unknown>, rawModel: unknown): Record<string, unknown> {
  const out = cloneRecord(rawModel);
  for (const [key, value] of Object.entries(model)) {
    if (key === 'capabilities' && Array.isArray(value)) {
      out[camelToSnake(key)] = [...value];
    } else {
      setDefined(out, camelToSnake(key), value);
    }
  }
  return out;
}

function thinkingToToml(thinking: Record<string, unknown>, rawThinking: unknown): Record<string, unknown> {
  return plainObjectToToml(thinking, rawThinking);
}

function permissionToToml(
  permission: Record<string, unknown>,
  rawPermission: unknown,
): Record<string, unknown> {
  const out = cloneRecord(rawPermission);
  delete out['deny'];
  delete out['allow'];
  delete out['ask'];

  const rules = permission['rules'];
  if (Array.isArray(rules)) {
    out['rules'] = rules.map((rule) =>
      isPlainObject(rule) ? plainObjectToToml(rule, undefined) : rule,
    );
  } else {
    delete out['rules'];
  }
  return out;
}

function servicesToToml(services: Record<string, unknown>, rawServices: unknown): Record<string, unknown> {
  const out = cloneRecord(rawServices);
  const moonshotSearch = services['moonshotSearch'];
  const moonshotFetch = services['moonshotFetch'];
  if (isPlainObject(moonshotSearch)) {
    out['moonshot_search'] = serviceToToml(moonshotSearch);
  } else {
    delete out['moonshot_search'];
  }
  if (isPlainObject(moonshotFetch)) {
    out['moonshot_fetch'] = serviceToToml(moonshotFetch);
  } else {
    delete out['moonshot_fetch'];
  }
  return out;
}

function serviceToToml(service: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(service)) {
    if (key === 'oauth' && isPlainObject(value)) {
      out[camelToSnake(key)] = plainObjectToToml(value, undefined);
    } else if (key === 'customHeaders' && value !== undefined) {
      out[camelToSnake(key)] = cloneUnknown(value);
    } else {
      setDefined(out, camelToSnake(key), value);
    }
  }
  return out;
}

function loopControlToToml(
  loopControl: Record<string, unknown>,
  rawLoopControl: unknown,
): Record<string, unknown> {
  return plainObjectToToml(loopControl, rawLoopControl);
}

function backgroundToToml(
  background: Record<string, unknown>,
  rawBackground: unknown,
): Record<string, unknown> {
  return plainObjectToToml(background, rawBackground);
}

function experimentalToToml(
  experimental: Record<string, unknown>,
  _rawExperimental: unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(experimental)) {
    setDefined(out, key, value);
  }
  return out;
}

function setHooks(out: Record<string, unknown>, hooks: unknown): void {
  if (hooks === undefined) {
    delete out['hooks'];
    return;
  }
  if (!Array.isArray(hooks)) {
    setDefined(out, 'hooks', hooks);
    return;
  }
  out['hooks'] = hooks.map((hook) =>
    isPlainObject(hook) ? plainObjectToToml(hook, undefined) : hook,
  );
}

function plainObjectToToml(value: Record<string, unknown>, raw: unknown): Record<string, unknown> {
  const out = cloneRecord(raw);
  for (const [key, entry] of Object.entries(value)) {
    setDefined(out, camelToSnake(key), entry);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Parse diagnostics                                                  */
/* ------------------------------------------------------------------ */

/**
 * One-line summary of a smol-toml parse error: first message line plus the
 * line/column location, without the multi-line code-frame block.
 */
export function describeTomlSyntaxError(error: unknown): string {
  const firstLine = describeUnknownError(error).split('\n', 1)[0] ?? '';
  if (error instanceof TomlError) {
    return `${firstLine} (line ${error.line}, column ${error.column})`;
  }
  return firstLine;
}

/* ------------------------------------------------------------------ */
/*  Utilities                                                          */
/* ------------------------------------------------------------------ */

export function cloneRecord(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) return {};
  return cloneUnknown(value);
}

function cloneUnknown<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneObjectValue(value: unknown): unknown {
  return isPlainObject(value) ? cloneUnknown(value) : value;
}

export function setDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  } else {
    delete target[key];
  }
}
