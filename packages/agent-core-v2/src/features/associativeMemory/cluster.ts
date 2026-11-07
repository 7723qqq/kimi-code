import type { Atom, AssociativeMemoryParams, Cooccurrence, Concept, Edge } from './types';
import { compareByText } from './terms';
import { averageVector, averageDense, cosine, topTerms } from './vector';

export interface ClusterResult {
  readonly concepts: readonly Concept[];
  readonly edges: readonly Edge[];
}

export function coocClusterThreshold(
  params: AssociativeMemoryParams,
): number {
  return Math.max(
    1,
    Math.round(params.clusterCoocThreshold * 2 * (1 - params.conceptFormationRate)),
  );
}

export function conceptId(atomIds: readonly string[]): string {
  return new Bun.CryptoHasher('sha256').update(atomIds.join('\u0001')).digest('hex').slice(0, 24);
}

export function clusterIncremental(
  atoms: readonly Atom[],
  coocs: readonly Cooccurrence[],
  concepts: readonly Concept[],
  params: AssociativeMemoryParams,
  now: number,
): ClusterResult {
  const atomById = new Map(atoms.map((atom) => [atom.id, atom]));
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  for (const atom of atoms) parent.set(atom.id, atom.id);
  const coocThreshold = coocClusterThreshold(params);
  for (const cooc of coocs) {
    if (cooc.count < coocThreshold) continue;
    if (!atomById.has(cooc.a) || !atomById.has(cooc.b)) continue;
    const rootA = find(cooc.a);
    const rootB = find(cooc.b);
    if (rootA === rootB) continue;
    if (rootA < rootB) parent.set(rootB, rootA);
    else parent.set(rootA, rootB);
  }

  const components = new Map<string, string[]>();
  for (const atom of atoms) {
    const root = find(atom.id);
    const list = components.get(root) ?? [];
    list.push(atom.id);
    components.set(root, list);
  }

  const working: Concept[] = concepts.map((concept) => ({ ...concept }));
  const edges: Edge[] = [];
  const sortedComponents = [...components.values()].toSorted((a, b) => {
    const left = atomById.get(a[0]!);
    const right = atomById.get(b[0]!);
    if (left === undefined || right === undefined) return 0;
    return compareByText(left, right);
  });
  for (const ids of sortedComponents) {
    if (ids.length < params.clusterMinSize) continue;
    for (const chunk of chunkAtoms(ids, params.clusterMaxSize, atomById)) {
      const members = chunk.map((id) => atomById.get(id)!);
      const terms = new Set(
        topTerms(
          averageVector(members.map((member) => member.vector)),
          5,
        ),
      );
      const candidate = working
        .filter((concept) => concept.atomIds.length + chunk.length <= params.clusterMaxSize)
        .filter((concept) => concept.readiness >= MERGE_READINESS)
        .filter((concept) => concept.terms.some((term) => terms.has(term)))
        .toSorted(
          (a, b) =>
            b.readiness - a.readiness ||
            (a.label < b.label ? -1 : a.label > b.label ? 1 : a.id < b.id ? -1 : 1),
        )[0];
      const concept =
        candidate === undefined
          ? buildConcept(chunk, atomById, params, now)
          : mergeConcept(candidate, chunk, atomById, params);
      if (candidate === undefined) working.push(concept);
      else working[working.indexOf(candidate)] = concept;
      for (const atomId of chunk) {
        edges.push({
          id: `${concept.id}>${atomId}`,
          from: concept.id,
          to: atomId,
          kind: 'concept',
          weight: 1,
          strengthenCount: 1,
          validFrom: now,
          validUntil: undefined,
          createdAt: now,
          lastUsedAt: now,
        });
      }
    }
  }

  const deduped = mergeOverlapping(working, atomById, params);
  const finalEdges: Edge[] = [];
  for (const concept of deduped) {
    for (const atomId of concept.atomIds) {
      finalEdges.push({
        id: `${concept.id}>${atomId}`,
        from: concept.id,
        to: atomId,
        kind: 'concept',
        weight: 1,
        strengthenCount: 1,
        validFrom: now,
        validUntil: undefined,
        createdAt: now,
        lastUsedAt: now,
      });
    }
  }
  const all = deduped.map((concept) => {
    const load = concept.atomIds.length;
    return { ...concept, load, readiness: 1 / (1 + load / params.loadRef) };
  });
  return { concepts: all, edges: finalEdges };
}

const MERGE_READINESS = 0.5;

function mergeOverlapping(
  concepts: readonly Concept[],
  atomById: ReadonlyMap<string, Atom>,
  params: AssociativeMemoryParams,
): Concept[] {
  const merged = new Map<string, Concept>();
  for (const concept of concepts) {
    const owner = [...merged.values()].find((existing) =>
      existing.atomIds.some((id) => concept.atomIds.includes(id)),
    );
    if (owner === undefined) {
      merged.set(concept.id, concept);
      continue;
    }
    const extra = concept.atomIds.filter((id) => !owner.atomIds.includes(id));
    if (extra.length === 0) continue;
    const room = Math.max(0, params.clusterMaxSize - owner.atomIds.length);
    if (room === 0) continue;
    merged.set(owner.id, mergeConcept(owner, extra.slice(0, room), atomById, params));
  }
  return [...merged.values()];
}

function mergeConcept(
  candidate: Concept,
  chunk: readonly string[],
  atomById: ReadonlyMap<string, Atom>,
  params: AssociativeMemoryParams,
): Concept {
  const mergedIds = [...candidate.atomIds, ...chunk].filter((id) => atomById.has(id));
  const members = mergedIds.map((id) => atomById.get(id)!);
  return {
    ...candidate,
    label: labelFromAtoms(members),
    terms: topTerms(averageVector(members.map((member) => member.vector)), CONCEPT_TERM_LIMIT),
    vector: undefined,
    hubAtomId: members.reduce((best, atom) =>
      best === undefined || atom.baseWeight > best.baseWeight ? atom : best,
      undefined as Atom | undefined,
    )?.id,
    denseVector: averageDense(
      members
        .map((atom) => atom.denseVector)
        .filter((entry): entry is readonly number[] => entry !== undefined),
    ),
    atomIds: mergedIds,
    load: mergedIds.length,
    readiness: 1 / (1 + mergedIds.length / params.loadRef),
  };
}

function chunkAtoms(
  ids: readonly string[],
  max: number,
  atomById: ReadonlyMap<string, Atom>,
): string[][] {
  if (ids.length <= max) return [[...ids].toSorted()];
  const remaining = new Set(ids);
  const chunks: string[][] = [];
  while (remaining.size > 0) {
    const seed = [...remaining].toSorted()[0]!;
    remaining.delete(seed);
    const chunk = [seed];
    let centroid = { ...atomById.get(seed)!.vector };
    while (chunk.length < max && remaining.size > 0) {
      let bestId: string | undefined;
      let bestScore = -1;
      for (const id of [...remaining].toSorted()) {
        const score = cosine(centroid, atomById.get(id)!.vector);
        if (score > bestScore) {
          bestScore = score;
          bestId = id;
        }
      }
      if (bestId === undefined) break;
      chunk.push(bestId);
      remaining.delete(bestId);
      centroid = averageVector([centroid, atomById.get(bestId)!.vector]);
    }
    chunks.push(chunk.toSorted());
  }
  return chunks;
}

function buildConcept(
  atomIds: readonly string[],
  atomById: ReadonlyMap<string, Atom>,
  params: AssociativeMemoryParams,
  now: number,
): Concept {
  const members = atomIds.map((id) => atomById.get(id)!);
  const vector = averageVector(members.map((atom) => atom.vector));
  return {
    id: conceptId(atomIds),
    scopeKey: members[0]!.scopeKey,
    nodeType: 'concept',
    label: labelFromAtoms(members),
    labelSource: 'deterministic_v1',
    terms: topTerms(vector, CONCEPT_TERM_LIMIT),
    vector: undefined,
    hubAtomId: members.reduce((best, atom) =>
      best === undefined || atom.baseWeight > best.baseWeight ? atom : best,
      undefined as Atom | undefined,
    )?.id,
    denseVector: averageDense(
      members
        .map((atom) => atom.denseVector)
        .filter((entry): entry is readonly number[] => entry !== undefined),
    ),
    atomIds,
    load: atomIds.length,
    readiness: 1 / (1 + atomIds.length / params.loadRef),
    pinned: false,
    suppressed: false,
    validFrom: now,
    validUntil: undefined,
    createdAt: now,
    lastActivatedAt: now,
  };
}

const CONCEPT_TERM_LIMIT = 12;

function labelFromAtoms(atoms: readonly Atom[]): string {
  const ranked = [...atoms]
    .toSorted(
      (a, b) =>
        Object.values(b.vector).reduce((sum, value) => sum + value, 0) -
        Object.values(a.vector).reduce((sum, value) => sum + value, 0) || compareByText(a, b),
    )
    .slice(0, 3);
  const terms = new Set<string>();
  for (const atom of ranked) {
    for (const term of topTerms(atom.vector, 3)) {
      if (terms.size >= 6) break;
      terms.add(term);
    }
    if (terms.size >= 6) break;
  }
  return [...terms].join(' ');
}
