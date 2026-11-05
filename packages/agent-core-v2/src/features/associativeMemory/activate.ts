import { tokenize } from '@moonshot-ai/minidb';

import type {
  Atom,
  AssociativeMemoryParams,
  Concept,
  Edge,
  Procedure,
  RecallItem,
  RecallQuery,
  RecallResult,
  RecallTraceNode,
} from './types';
import { cosine, cosineDense, termFrequency } from './vector';

interface Node {
  readonly id: string;
  readonly kind: 'atom' | 'concept' | 'procedure';
  readonly text: string;
  readonly noteId: string;
  readonly vector: Readonly<Record<string, number>>;
  readonly denseVector: readonly number[] | undefined;
  readonly terms: readonly string[];
  readonly confidence: number;
  readonly validFrom: number;
  readonly validUntil: number | undefined;
  readonly conceptId: string | undefined;
  readonly suppressed: boolean;
  readonly isDeleted: boolean;
}

export function activate(
  query: RecallQuery,
  atoms: readonly Atom[],
  concepts: readonly Concept[],
  edges: readonly Edge[],
  params: AssociativeMemoryParams,
  now: number,
  procedures: readonly Procedure[] = [],
  cueDense: readonly number[] | undefined = undefined,
): RecallResult {
  const nodes = new Map<string, Node>();
  const atomById = new Map<string, Atom>();
  for (const atom of atoms) {
    atomById.set(atom.id, atom);
    nodes.set(atom.id, {
      id: atom.id,
      kind: 'atom',
      text: atom.text,
      noteId: atom.noteId,
      vector: atom.vector,
      denseVector: atom.denseVector,
      terms: atom.terms,
      confidence: atom.confidence,
      validFrom: atom.validFrom,
      validUntil: atom.validUntil,
      conceptId: atom.conceptId,
      suppressed: atom.suppressed,
      isDeleted: atom.isDeleted,
    });
  }
  for (const concept of concepts) {
    const noteId = concept.atomIds.length > 0 ? (atomById.get(concept.atomIds[0]!)?.noteId ?? '') : '';
    nodes.set(concept.id, {
      id: concept.id,
      kind: 'concept',
      text: concept.label,
      noteId,
      vector: concept.vector,
      denseVector: concept.denseVector,
      terms: concept.terms,
      confidence: 1,
      validFrom: concept.validFrom,
      validUntil: concept.validUntil,
      conceptId: undefined,
      suppressed: concept.suppressed,
      isDeleted: false,
    });
  }
  for (const procedure of procedures) {
    if (procedure.suppressed) continue;
    nodes.set(procedure.id, {
      id: procedure.id,
      kind: 'procedure',
      text: procedure.label,
      noteId: procedure.sourceNoteId,
      vector: procedure.vector,
      denseVector: undefined,
      terms: procedure.terms,
      confidence: 1,
      validFrom: procedure.createdAt,
      validUntil: undefined,
      conceptId: undefined,
      suppressed: false,
      isDeleted: false,
    });
  }

  const isActive = (node: Node): boolean => {
    if (node.isDeleted) return false;
    if (query.includeHistory) return true;
    if (node.suppressed) return false;
    if (node.validUntil === undefined) return true;
    return node.validUntil > now;
  };

  const cueTerms = tokenize(query.cue);
  const cueSet = new Set(cueTerms);
  const cueVector = termFrequency(cueTerms);

  const termSeeds = new Map<string, number>();
  const vectorSeeds = new Map<string, number>();
  for (const node of nodes.values()) {
    if (!isActive(node)) continue;
    const overlap =
      cueSet.size === 0 ? 0 : node.terms.filter((term) => cueSet.has(term)).length / cueSet.size;
    if (overlap > 0) termSeeds.set(node.id, overlap);
    const vectorScore =
      node.denseVector !== undefined && cueDense !== undefined
        ? cosineDense(node.denseVector, cueDense)
        : cosine(cueVector, node.vector);
    if (vectorScore >= params.vectorThreshold) vectorSeeds.set(node.id, vectorScore);
  }
  const seeded = new Map<string, number>(termSeeds);
  for (const [id, score] of [...vectorSeeds.entries()]
    .toSorted((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, params.seedTopM)) {
    seeded.set(id, Math.max(seeded.get(id) ?? 0, score));
  }

  const adjacency = new Map<string, { to: string; weight: number }[]>();
  for (const edge of edges) {
    if (edge.validUntil !== undefined && !query.includeHistory) continue;
    const list = adjacency.get(edge.from) ?? [];
    list.push({ to: edge.to, weight: edge.weight });
    adjacency.set(edge.from, list);
  }

  const scores = new Map<string, number>(seeded);
  const trace: RecallTraceNode[] = [];
  for (const [id, score] of [...seeded].toSorted((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) {
    trace.push({ id, kind: 'seed', score, viaEdge: undefined, truncated: false });
  }

  let frontier = [...seeded.keys()].toSorted();
  let visited = seeded.size;
  let truncated = false;

  for (let hop = 1; hop <= params.spreadHops; hop++) {
    if (frontier.length === 0) break;
    const k = Math.max(1, params.baseK - hop * params.kDecay);
    const candidates = new Map<
      string,
      { score: number; via: { from: string; weight: number; decayed: number } }
    >();
    for (const id of frontier) {
      const base = scores.get(id) ?? 0;
      for (const neighbor of adjacency.get(id) ?? []) {
        if (visited >= params.computeBudget) {
          truncated = true;
          break;
        }
        visited++;
        const target = nodes.get(neighbor.to);
        if (target === undefined || !isActive(target)) continue;
        const decayed = base * neighbor.weight * params.spreadDecay;
        const existing = candidates.get(neighbor.to);
        if (decayed > (existing?.score ?? 0)) {
          candidates.set(neighbor.to, {
            score: decayed,
            via: { from: id, weight: neighbor.weight, decayed },
          });
        }
      }
      if (truncated) break;
    }
    const winners = [...candidates.entries()]
      .toSorted((a, b) => b[1].score - a[1].score || (a[0] < b[0] ? -1 : 1))
      .slice(0, k);
    if (winners.length < candidates.size) truncated = true;
    for (const [id, info] of winners) {
      scores.set(id, Math.max(scores.get(id) ?? 0, info.score));
      trace.push({ id, kind: 'spread', score: info.score, viaEdge: info.via, truncated: false });
    }
    frontier = winners.map(([id]) => id);
    if (truncated) break;
  }

  const inhibition = new Map<string, { to: string; weight: number }[]>();
  for (const edge of edges) {
    if (edge.kind !== 'inhibits') continue;
    if (edge.validUntil !== undefined && !query.includeHistory) continue;
    const list = inhibition.get(edge.from) ?? [];
    list.push({ to: edge.to, weight: edge.weight });
    inhibition.set(edge.from, list);
  }
  for (const [id, score] of scores) {
    for (const link of inhibition.get(id) ?? []) {
      const target = scores.get(link.to);
      if (target === undefined) continue;
      const reduced = Math.max(0, target - link.weight * params.inhibitionFactor * score);
      scores.set(link.to, reduced);
      trace.push({
        id: link.to,
        kind: 'inhibit',
        score: reduced,
        viaEdge: { from: id, weight: link.weight, decayed: link.weight * params.inhibitionFactor * score },
        truncated: false,
      });
    }
  }

  const conflictGroups = buildConflictGroups(atoms, edges);
  const noteScores = new Map<string, number>();
  for (const [id, score] of scores) {
    const node = nodes.get(id);
    if (node === undefined || node.kind !== 'atom') continue;
    noteScores.set(node.noteId, (noteScores.get(node.noteId) ?? 0) + score);
  }
  const topNotes = new Set(
    [...noteScores.entries()]
      .toSorted((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, params.episodeTopN)
      .map(([note]) => note),
  );
  const episodeFilter = noteScores.size > 0;
  const items: RecallItem[] = [...scores.entries()]
    .filter(([, score]) => score >= params.activationThreshold)
    .filter(([id]) => {
      const node = nodes.get(id)!;
      return node.kind === 'concept' || !episodeFilter || topNotes.has(node.noteId);
    })
    .toSorted((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, query.limit ?? params.topK)
    .map(([id, score]) => {
      const node = nodes.get(id)!;
      return {
        id,
        kind: node.kind,
        text: node.text,
        score,
        noteId: node.noteId,
        conceptId: node.conceptId,
        confidence: node.confidence,
        validFrom: node.validFrom,
        validUntil: node.validUntil,
        conflictGroup: conflictGroups.get(id),
      };
    });

  return { items, trace: truncated ? trace.map((node) => ({ ...node, truncated: true })) : trace };
}

function buildConflictGroups(
  atoms: readonly Atom[],
  edges: readonly Edge[],
): ReadonlyMap<string, string> {
  const parent = new Map<string, string>();
  for (const atom of atoms) parent.set(atom.id, atom.id);
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  for (const edge of edges) {
    if (edge.kind !== 'supersede') continue;
    if (!parent.has(edge.from) || !parent.has(edge.to)) continue;
    const rootA = find(edge.from);
    const rootB = find(edge.to);
    if (rootA === rootB) continue;
    if (rootA < rootB) parent.set(rootB, rootA);
    else parent.set(rootA, rootB);
  }
  const groups = new Map<string, string>();
  for (const atom of atoms) groups.set(atom.id, find(atom.id));
  return groups;
}
