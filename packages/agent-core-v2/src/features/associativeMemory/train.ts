import type { Atom, AssociativeMemoryParams, Edge } from './types';
import { cosine } from './vector';

const HETERO_FACTOR = 0.1;

export interface TrainResult {
  readonly edges: readonly Edge[];
  readonly superseded: ReadonlyMap<string, { readonly validUntil: number; readonly suppressed: boolean }>;
}

export function hebbianConnect(
  newAtoms: readonly Atom[],
  contextAtoms: readonly Atom[],
  edges: readonly Edge[],
  params: AssociativeMemoryParams,
  activity: ReadonlyMap<string, number>,
  now: number,
  contradiction: (candidate: Atom, existing: Atom) => boolean = (candidate, existing) =>
    cosine(candidate.vector, existing.vector) > params.supersedeThreshold,
): TrainResult {
  const byId = new Map<string, Edge>();
  for (const edge of edges) byId.set(edge.id, edge);
  const superseded = new Map<string, { validUntil: number; suppressed: boolean }>();

  for (const atom of newAtoms) {
    for (const other of contextAtoms) {
      if (atom.id === other.id) continue;
      const id = `${atom.id}>${other.id}`;
      if (contradiction(atom, other)) {
        superseded.set(other.id, { validUntil: now, suppressed: true });
        const supersedeId = `${atom.id}>${other.id}`;
        if (!byId.has(supersedeId)) {
          byId.set(supersedeId, {
            id: supersedeId,
            from: atom.id,
            to: other.id,
            kind: 'supersede',
            weight: 1,
            strengthenCount: 1,
            validFrom: now,
            validUntil: undefined,
            createdAt: now,
            lastUsedAt: now,
          });
        }
        const inhibitId = `${atom.id}~${other.id}`;
        if (!byId.has(inhibitId)) {
          byId.set(inhibitId, {
            id: inhibitId,
            from: atom.id,
            to: other.id,
            kind: 'inhibits',
            weight: 1,
            strengthenCount: 1,
            validFrom: now,
            validUntil: undefined,
            createdAt: now,
            lastUsedAt: now,
          });
        }
        continue;
      }
      const existing = byId.get(id);
      const strengthenCount = existing?.strengthenCount ?? 0;
      const nodeFactor = 1 / (1 + (activity.get(atom.id) ?? 0));
      const delta = (params.baseLearningRate / (1 + strengthenCount)) * nodeFactor;
      byId.set(id, {
        id,
        from: atom.id,
        to: other.id,
        kind: 'hebbian',
        weight: Math.min(params.maxEdgeWeight, (existing?.weight ?? 0) + delta),
        strengthenCount: strengthenCount + 1,
        validFrom: existing?.validFrom ?? now,
        validUntil: undefined,
        createdAt: existing?.createdAt ?? now,
        lastUsedAt: now,
      });
      applyHeterosynaptic(atom.id, other.id, delta, byId);
    }
    enforceBudget(atom.id, byId, params);
  }

  return { edges: [...byId.values()], superseded };
}

function applyHeterosynaptic(
  sourceId: string,
  keepTargetId: string,
  delta: number,
  byId: Map<string, Edge>,
): void {
  if (delta <= 0) return;
  const correction = delta * HETERO_FACTOR;
  for (const edge of byId.values()) {
    if (edge.from !== sourceId || edge.to === keepTargetId) continue;
    byId.set(edge.id, { ...edge, weight: Math.max(0, edge.weight - correction) });
  }
}

function enforceBudget(sourceId: string, byId: Map<string, Edge>, params: AssociativeMemoryParams): void {
  const out = [...byId.values()].filter((edge) => edge.from === sourceId && edge.validUntil === undefined);
  const total = out.reduce((sum, edge) => sum + edge.weight, 0);
  if (total <= params.outWeightBudget) return;
  const scale = params.outWeightBudget / total;
  for (const edge of out) byId.set(edge.id, { ...edge, weight: edge.weight * scale });
}
