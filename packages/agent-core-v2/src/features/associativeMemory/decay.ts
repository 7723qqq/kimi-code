import { cascadeLevel } from './state';
import type { AssociativeMemoryParams, Cooccurrence, Edge } from './types';

export const POWER_LAW_ALPHA = 0.5;
export const CONSOLIDATION_STRENGTH = 0.5;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function decayFactor(ageMs: number, params: AssociativeMemoryParams): number {
  const t = params.powerLawDays * MS_PER_DAY;
  if (ageMs <= t) return Math.pow(1 + ageMs / t, -POWER_LAW_ALPHA);
  const boundary = Math.pow(2, -POWER_LAW_ALPHA);
  return boundary * Math.pow(0.5, (ageMs - t) / params.halfLifeMs);
}

export const SALIENCE_DECAY_STRENGTH = 0.2;

export function applyDecay(
  edges: readonly Edge[],
  now: number,
  params: AssociativeMemoryParams,
  pinnedIds: ReadonlySet<string> = new Set(),
  decayScale = 1,
  salience: ReadonlyMap<string, number> = new Map(),
): Edge[] {
  return edges.map((edge) => {
    if (pinnedIds.has(edge.from) || pinnedIds.has(edge.to)) return edge;
    const age = now - edge.lastUsedAt;
    if (age <= 0) return edge;
    const endpointSalience = Math.max(1, salience.get(edge.from) ?? 1, salience.get(edge.to) ?? 1);
    const consolidation =
      1 /
      (1 +
        cascadeLevel(edge.strengthenCount, params.cascadeMaxLevel) * params.cascadeStrength +
        (endpointSalience - 1) * SALIENCE_DECAY_STRENGTH);
    const effectiveAge = age * consolidation;
    return {
      ...edge,
      weight: edge.weight * Math.pow(decayFactor(effectiveAge, params), decayScale),
    };
  });
}

export function applySleepDownscale(
  edges: readonly Edge[],
  params: AssociativeMemoryParams,
): Edge[] {
  return edges.map((edge) =>
    edge.kind === 'hebbian' ? { ...edge, weight: edge.weight * params.sleepDownscale } : edge,
  );
}

export function restoreCaptured(edges: readonly Edge[], params: AssociativeMemoryParams): Edge[] {
  const inverse = 1 / params.sleepDownscale;
  return edges.map((edge) =>
    edge.kind === 'hebbian' && edge.strengthenCount >= params.captureCount
      ? { ...edge, weight: Math.min(params.maxEdgeWeight, edge.weight * inverse) }
      : edge,
  );
}

export function applyMotivatedForgetting(
  edges: readonly Edge[],
  neglected: ReadonlySet<string>,
  params: AssociativeMemoryParams,
): Edge[] {
  return edges.map((edge) =>
    edge.kind === 'hebbian' && neglected.has(edge.from)
      ? { ...edge, weight: edge.weight * params.motivatedForgetting }
      : edge,
  );
}

export function pruneEdges(edges: readonly Edge[], params: AssociativeMemoryParams): Edge[] {
  return edges.filter((edge) => edge.weight >= params.pruneThreshold);
}

export function pruneCooccurrences(
  coocs: readonly Cooccurrence[],
  now: number,
  params: AssociativeMemoryParams,
  threshold: number,
): Cooccurrence[] {
  return coocs.filter((cooc) => cooc.count >= threshold || now - cooc.lastAt <= params.halfLifeMs);
}
