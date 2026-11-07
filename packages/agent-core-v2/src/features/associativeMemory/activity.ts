import type { Edge } from './types';

export function recentActivity(
  edges: readonly Edge[],
  now: number,
  windowMs: number,
): ReadonlyMap<string, number> {
  const activity = new Map<string, number>();
  for (const edge of edges) {
    if (edge.kind !== 'hebbian') continue;
    if (edge.lastUsedAt > now || now - edge.lastUsedAt > windowMs) continue;
    activity.set(edge.from, (activity.get(edge.from) ?? 0) + edge.strengthenCount);
  }
  return activity;
}
