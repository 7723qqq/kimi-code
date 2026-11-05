import type { HardRule } from '../types';

export function toHardRule(value: unknown): HardRule | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const id = record['id'];
  const pattern = record['pattern'];
  const action = record['action'];
  if (typeof id !== 'string' || typeof pattern !== 'string') return undefined;
  if (typeof action !== 'string') return undefined;
  const scope = record['scope'];
  const reason = record['reason'];
  return {
    id,
    pattern,
    regex: record['regex'] === true,
    action: action as HardRule['action'],
    scope: scope === 'recall' || scope === 'atom' ? scope : 'note',
    reason: typeof reason === 'string' ? reason : id,
  };
}
