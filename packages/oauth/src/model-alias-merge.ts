import { isRecord } from './utils';
import type { ManagedKimiModelAlias, ManagedKimiModelAliasOverrides } from './managed-kimi-code';

export const MANAGED_KIMI_MODEL_FIELDS: ReadonlySet<string> = new Set([
  'provider',
  'model',
  'maxContextSize',
  'capabilities',
  'displayName',
  'protocol',
  'betaApi',
  'adaptiveThinking',
  'supportEfforts',
  'defaultEffort',
]);

export const CUSTOM_REGISTRY_MODEL_FIELDS: ReadonlySet<string> = new Set([
  'provider',
  'model',
  'maxContextSize',
  'capabilities',
  'displayName',
  'supportEfforts',
  'defaultEffort',
]);

function cloneOverrides(
  overrides: ManagedKimiModelAliasOverrides | undefined,
): ManagedKimiModelAliasOverrides | undefined {
  if (overrides === undefined) return undefined;
  return structuredClone(overrides);
}

function userExtras(
  existing: Record<string, unknown>,
  remoteOwnedFields: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(existing)) {
    if (key === 'overrides') continue;
    if (!remoteOwnedFields.has(key)) out[key] = value;
  }
  return out;
}

function mergeCapabilities(
  existingCaps: unknown,
  remoteCaps: readonly string[] | undefined,
): string[] | undefined {
  if (!Array.isArray(existingCaps) && remoteCaps === undefined) return undefined;
  const set = new Set<string>();
  if (Array.isArray(existingCaps)) {
    for (const c of existingCaps) {
      if (typeof c === 'string' && c.trim().length > 0) set.add(c.trim());
    }
  }
  if (Array.isArray(remoteCaps)) {
    for (const c of remoteCaps) {
      if (typeof c === 'string' && c.trim().length > 0) set.add(c.trim());
    }
  }
  return set.size > 0 ? [...set] : undefined;
}

export function mergeRefreshedModelAlias(
  existing: unknown,
  remote: ManagedKimiModelAlias,
  remoteOwnedFields: ReadonlySet<string>,
): ManagedKimiModelAlias {
  const current = isRecord(existing) ? existing : {};
  const overrides = cloneOverrides(
    isRecord(current['overrides'])
      ? (current['overrides'] as ManagedKimiModelAliasOverrides)
      : undefined,
  );
  const mergedCapabilities = mergeCapabilities(current['capabilities'], remote.capabilities);
  return {
    ...userExtras(current, remoteOwnedFields),
    ...remote,
    ...(mergedCapabilities !== undefined ? { capabilities: mergedCapabilities } : {}),
    ...(overrides !== undefined ? { overrides } : {}),
  };
}
