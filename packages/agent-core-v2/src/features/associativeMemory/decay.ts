import type { AssociativeMemoryParams, Edge } from './types';

export const POWER_LAW_ALPHA = 0.5;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function decayFactor(ageMs: number, params: AssociativeMemoryParams): number {
  const t = params.powerLawDays * MS_PER_DAY;
  if (ageMs <= t) return Math.pow(1 + ageMs / t, -POWER_LAW_ALPHA);
  const boundary = Math.pow(2, -POWER_LAW_ALPHA);
  return boundary * Math.pow(0.5, (ageMs - t) / params.halfLifeMs);
}

export function applyDecay(
  edges: readonly Edge[],
  now: number,
  params: AssociativeMemoryParams,
  pinnedIds: ReadonlySet<string> = new Set(),
  decayScale = 1,
): Edge[] {
  return edges.map((edge) => {
    if (pinnedIds.has(edge.from) || pinnedIds.has(edge.to)) return edge;
    const age = now - edge.lastUsedAt;
    if (age <= 0) return edge;
    return { ...edge, weight: edge.weight * Math.pow(decayFactor(age, params), decayScale) };
  });
}

export function pruneEdges(edges: readonly Edge[], params: AssociativeMemoryParams): Edge[] {
  return edges.filter((edge) => edge.weight >= params.pruneThreshold);
}
