import { deriveNodeStates } from './state';
import { memorySeparationDecision } from './separation';
import { stdpDrive } from './temporal';
import { compareByText, relatedTerms, STOP_TERMS } from './terms';
import type { Atom, AssociativeMemoryParams, Edge } from './types';


export interface TrainResult {
  readonly edges: readonly Edge[];
  readonly deleted: readonly string[];
  readonly superseded: ReadonlyMap<string, { readonly validUntil: number; readonly suppressed: boolean }>;
}

export function sharesContentTerm(left: Atom, right: Atom): boolean {
  if (left.terms.length === 0 || right.terms.length === 0) return false;
  for (const term of left.terms) {
    if (STOP_TERMS.has(term)) continue;
    for (const other of right.terms) {
      if (STOP_TERMS.has(other)) continue;
      if (relatedTerms(term, other)) return true;
    }
  }
  return false;
}

export function hebbianConnect(
  newAtoms: readonly Atom[],
  contextAtoms: readonly Atom[],
  edges: readonly Edge[],
  params: AssociativeMemoryParams,
  activity: ReadonlyMap<string, number>,
  now: number,
  contradiction: (candidate: Atom, existing: Atom) => boolean = (candidate, existing) =>
    memorySeparationDecision(candidate, existing, params) === 'separate',
): TrainResult {
  const byId = new Map<string, Edge>();
  const bySource = new Map<string, Set<string>>();
  const index = (edge: Edge): void => {
    let ids = bySource.get(edge.from);
    if (ids === undefined) {
      ids = new Set();
      bySource.set(edge.from, ids);
    }
    ids.add(edge.id);
  };
  for (const edge of edges) {
    byId.set(edge.id, edge);
    index(edge);
  }
  const stored = new Set(edges.map((edge) => edge.id));
  const labels = new Map<string, string>();
  for (const atom of contextAtoms) labels.set(atom.id, atom.text);
  for (const atom of newAtoms) labels.set(atom.id, atom.text);
  const superseded = new Map<string, { validUntil: number; suppressed: boolean }>();
  const deleted = new Set<string>();
  const nodeStates = deriveNodeStates(edges, activity, params);

  for (const atom of newAtoms) {
    const source = atom.id;
    const order: { readonly id: string; readonly delta: number; readonly weight: number }[] = [];
    const nodeFactor = 1 / (1 + (activity.get(source) ?? 0));

    for (const other of contextAtoms) {
      if (source === other.id) continue;
      if (!sharesContentTerm(atom, other)) continue;
      const id = `${source}>${other.id}`;
      if (contradiction(atom, other)) {
        superseded.set(other.id, { validUntil: now, suppressed: true });
        if (!byId.has(id)) {
          const edge: Edge = {
            id,
            from: source,
            to: other.id,
            kind: 'supersede',
            weight: 1,
            strengthenCount: 1,
            validFrom: now,
            validUntil: undefined,
            createdAt: now,
            lastUsedAt: now,
          };
          byId.set(id, edge);
          index(edge);
          order.push({ id, delta: 0, weight: 1 });
        }
        const inhibitId = `${source}~${other.id}`;
        if (!byId.has(inhibitId)) {
          const edge: Edge = {
            id: inhibitId,
            from: source,
            to: other.id,
            kind: 'inhibits',
            weight: 1,
            strengthenCount: 1,
            validFrom: now,
            validUntil: undefined,
            createdAt: now,
            lastUsedAt: now,
          };
          byId.set(inhibitId, edge);
          index(edge);
          order.push({ id: inhibitId, delta: 0, weight: 1 });
        }
        continue;
      }
      const existing = byId.get(id);
      const strengthenCount = existing?.strengthenCount ?? 0;
      const room = Math.max(0, 1 - (existing?.weight ?? 0) / params.maxEdgeWeight);
      const drive = stdpDrive(atom, other, params);
      const state = nodeStates.get(source);
      const bcm =
        strengthenCount === 0 || state === undefined || state.thetaM === 0
          ? 0
          : (params.bcmGain * (strengthenCount - state.thetaM)) / (state.thetaM + 1);
      const delta =
        (params.baseLearningRate / (1 + strengthenCount)) * nodeFactor * room * (1 + drive + bcm);
      const weight = Math.max(0, Math.min(params.maxEdgeWeight, (existing?.weight ?? 0) + delta));
      const edge: Edge = {
        id,
        from: source,
        to: other.id,
        kind: 'hebbian',
        weight,
        strengthenCount: delta > 0 ? strengthenCount + 1 : strengthenCount,
        validFrom: existing?.validFrom ?? now,
        validUntil: undefined,
        createdAt: existing?.createdAt ?? now,
        lastUsedAt: now,
      };
      byId.set(id, edge);
      index(edge);
      order.push({ id, delta: Math.max(0, delta), weight });
    }

    const step = new Map<string, number>();
    for (let position = 0; position < order.length; position += 1) step.set(order[position]!.id, position);
    const totalDelta = order.reduce((sum, entry) => sum + entry.delta, 0);
    const depression = (weight: number, competition: number): number =>
      1 / (1 + params.heteroFactor * competition * (weight / (weight + params.weightDependenceK)));
    for (const id of bySource.get(source) ?? []) {
      const edge = byId.get(id);
      if (edge === undefined || edge.kind !== 'hebbian') continue;
      const position = step.get(id);
      const ownDelta = position === undefined ? 0 : order[position]!.delta;
      const competition = Math.max(0, totalDelta - ownDelta);
      byId.set(id, { ...edge, weight: edge.weight * depression(edge.weight, competition) });
    }

    const out: Edge[] = [];
    for (const id of bySource.get(source) ?? []) {
      const edge = byId.get(id);
      if (edge === undefined || edge.validUntil !== undefined || edge.kind !== 'hebbian') continue;
      out.push(edge);
    }
    const total = out.reduce((sum, edge) => sum + edge.weight, 0);
    if (total > params.outWeightBudget) {
      const scale = params.outWeightBudget / total;
      for (const edge of out) byId.set(edge.id, { ...edge, weight: edge.weight * scale });
    }
    if (out.length > params.maxOutDegree) {
      const ranked = out
        .toSorted(
          (left, right) =>
            right.weight - left.weight ||
            compareByText(
              { id: left.to, text: labels.get(left.to) ?? '' },
              { id: right.to, text: labels.get(right.to) ?? '' },
            ),
        )
        .slice(params.maxOutDegree);
      for (const edge of ranked) {
        byId.delete(edge.id);
        bySource.get(source)?.delete(edge.id);
        if (stored.has(edge.id)) deleted.add(edge.id);
      }
    }
  }

  return { edges: [...byId.values()], deleted: [...deleted], superseded };
}
