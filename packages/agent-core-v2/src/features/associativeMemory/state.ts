import type { AssociativeMemoryParams, Edge } from './types';

export interface NodeState {
  readonly activity: number;
  readonly thetaM: number;
  readonly cascadeLevel: number;
}

export function cascadeLevel(strengthenCount: number, maxLevel: number): number {
  const bounded = Math.max(0, strengthenCount);
  return Math.min(maxLevel, Math.max(0, Math.floor(Math.log2(1 + bounded))));
}

export function deriveNodeStates(
  edges: readonly Edge[],
  activity: ReadonlyMap<string, number>,
  params: AssociativeMemoryParams,
): ReadonlyMap<string, NodeState> {
  const totals = new Map<string, { sum: number; count: number }>();
  for (const edge of edges) {
    if (edge.kind !== 'hebbian') continue;
    const entry = totals.get(edge.from) ?? { sum: 0, count: 0 };
    entry.sum += edge.strengthenCount;
    entry.count += 1;
    totals.set(edge.from, entry);
  }
  const states = new Map<string, NodeState>();
  const sources = new Set<string>([...totals.keys(), ...activity.keys()]);
  for (const source of sources) {
    const entry = totals.get(source);
    const average = entry === undefined || entry.count === 0 ? 0 : entry.sum / entry.count;
    states.set(source, {
      activity: activity.get(source) ?? 0,
      thetaM: average,
      cascadeLevel: cascadeLevel(Math.round(average), params.cascadeMaxLevel),
    });
  }
  return states;
}
