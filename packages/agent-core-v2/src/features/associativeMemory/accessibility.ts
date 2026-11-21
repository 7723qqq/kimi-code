import { decayFactor } from './decay';
import type { AssociativeMemoryParams, Atom, Edge } from './types';

export function accessibility(
  atom: Atom,
  edges: readonly Edge[],
  now: number,
  params: AssociativeMemoryParams,
): number {
  let incident = 0;
  for (const edge of edges) {
    if (edge.validUntil !== undefined) continue;
    if (edge.from !== atom.id && edge.to !== atom.id) continue;
    incident += edge.weight;
  }
  return accessibilityFromWeight(atom, incident, now, params);
}

export function accessibilityFromWeight(
  atom: Atom,
  incident: number,
  now: number,
  params: AssociativeMemoryParams,
): number {
  const recency = decayFactor(Math.max(0, now - atom.lastActivatedAt), params);
  return recency * (1 + Math.log1p(incident)) * Math.max(1, atom.baseWeight);
}
