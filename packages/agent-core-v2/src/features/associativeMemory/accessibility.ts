import type { AssociativeMemoryParams, Atom, Edge } from './types';
import { decayFactor } from './decay';

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
  const recency = decayFactor(Math.max(0, now - atom.lastActivatedAt), params);
  return recency * (1 + Math.log1p(incident)) * Math.max(1, atom.baseWeight);
}
