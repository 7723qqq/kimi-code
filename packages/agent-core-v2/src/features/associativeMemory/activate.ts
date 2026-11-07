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
import { matchesAny, STOP_TERMS } from './terms';
import { procedureModelFreeStrength } from './procedure';
import { averageVector, cosine, cosineDense, termFrequency } from './vector';

interface Node {
  readonly id: string;
  readonly kind: 'atom' | 'concept' | 'procedure';
  readonly text: string;
  readonly noteId: string;
  readonly scopeKey: string;
  readonly vector: Readonly<Record<string, number>>;
  readonly denseVector: readonly number[] | undefined;
  readonly terms: readonly string[];
  readonly confidence: number;
  readonly validFrom: number;
  readonly validUntil: number | undefined;
  readonly conceptId: string | undefined;
  readonly suppressed: boolean;
  readonly isDeleted: boolean;
  readonly salience: number;
  readonly memberIds: readonly string[];
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
      scopeKey: atom.scopeKey,
      vector: atom.vector,
      denseVector: atom.denseVector,
      terms: atom.terms,
      confidence: atom.confidence,
      validFrom: atom.validFrom,
      validUntil: atom.validUntil,
      conceptId: atom.conceptId,
      suppressed: atom.suppressed,
      isDeleted: atom.isDeleted,
      salience: atom.baseWeight,
      memberIds: [],
    });
  }
  for (const concept of concepts) {
    const noteId = concept.atomIds.length > 0 ? (atomById.get(concept.atomIds[0]!)?.noteId ?? '') : '';
    nodes.set(concept.id, {
      id: concept.id,
      kind: 'concept',
      text: concept.label,
      noteId,
      scopeKey: concept.scopeKey,
      vector:
        concept.vector ??
        (averageVector(
          concept.atomIds
            .map((id) => atomById.get(id)?.vector)
            .filter((entry): entry is Readonly<Record<string, number>> => entry !== undefined),
        ) as Readonly<Record<string, number>>) ??
        {},
      denseVector: concept.denseVector,
      terms: concept.terms,
      confidence: 1,
      validFrom: concept.validFrom,
      validUntil: concept.validUntil,
      conceptId: undefined,
      suppressed: concept.suppressed,
      isDeleted: false,
      salience: 1,
      memberIds: concept.atomIds,
    });
  }
  for (const procedure of procedures) {
    if (procedure.suppressed) continue;
    nodes.set(procedure.id, {
      id: procedure.id,
      kind: 'procedure',
      text: procedure.label,
      noteId: procedure.sourceNoteId,
      scopeKey: procedure.scopeKey,
      vector: procedure.vector,
      denseVector: undefined,
      terms: procedure.terms,
      confidence: 1,
      validFrom: procedure.createdAt,
      validUntil: undefined,
      conceptId: undefined,
      suppressed: false,
      isDeleted: false,
      salience: procedureModelFreeStrength(procedure),
      memberIds: [],
    });
  }

  const labels = new Map<string, string>();
  for (const node of nodes.values()) labels.set(node.id, node.text);
  const noteLabels = new Map<string, string>();
  for (const atom of atoms) {
    const current = noteLabels.get(atom.noteId);
    if (current === undefined || atom.text < current) noteLabels.set(atom.noteId, atom.text);
  }

  const isActive = (node: Node): boolean => {
    if (node.isDeleted) return false;
    if (query.includeHistory) return true;
    if (node.suppressed) return false;
    if (node.validUntil === undefined) return true;
    return node.validUntil > now;
  };

  const cueTerms = tokenize(query.cue).filter((term) => !STOP_TERMS.has(term));
  const cueSet = new Set(cueTerms);
  const cueVector = termFrequency(cueTerms);

  const conceptCoverage = (node: Node): number => {
    if (node.kind !== 'concept' || node.memberIds.length === 0) return 1;
    let matchedMembers = 0;
    for (const memberId of node.memberIds) {
      const member = nodes.get(memberId);
      if (member === undefined) continue;
      if (!member.terms.some((term) => matchesAny(term, cueTerms))) continue;
      matchedMembers += 1;
      if (matchedMembers >= 2) break;
    }
    return Math.min(1, matchedMembers / 2);
  };

  const termSeeds = new Map<string, number>();
  const vectorSeeds = new Map<string, number>();
  for (const node of nodes.values()) {
    if (!isActive(node)) continue;
    let matched = 0;
    let weight = 0;
    for (const term of node.terms) {
      if (!matchesAny(term, cueTerms)) continue;
      matched += 1;
      weight += node.vector[term] ?? 0;
    }
    const overlap = cueSet.size === 0 ? 0 : matched / cueSet.size;
    const vectorScore =
      node.denseVector !== undefined && cueDense !== undefined
        ? cosineDense(node.denseVector, cueDense)
        : cosine(cueVector, node.vector);
    if (overlap > 0) {
      const termWeight = weight;
      const coverage = conceptCoverage(node);
      const base = (cueSet.size === 0 ? overlap : (overlap + termWeight) / 2) * coverage;
      const salience = Math.min(
        SALIENCE_CAP,
        1 + (Math.max(1, node.salience) - 1) * SALIENCE_GAIN,
      );
      termSeeds.set(node.id, base * salience);
    }
    if (vectorScore >= params.vectorThreshold) vectorSeeds.set(node.id, vectorScore);
  }
  const seeded = new Map<string, number>(termSeeds);
  for (const [id, score] of [...vectorSeeds.entries()]
    .toSorted((a, b) => b[1] - a[1] || compareLabel(labels, a[0], b[0]))
    .slice(0, params.seedTopM)) {
    seeded.set(id, Math.max(seeded.get(id) ?? 0, score));
  }

  const ranked = [...seeded.entries()]
    .toSorted((a, b) => b[1] - a[1] || compareLabel(labels, a[0], b[0]))
    .slice(0, CROSS_SCORE_TOP_N);
  if (ranked.length > 1) {
    const termSets = ranked.map(([id]) => new Set(nodes.get(id)?.terms ?? []));
    for (let index = 0; index < ranked.length; index += 1) {
      const own = termSets[index]!;
      let support = 0;
      for (let peer = 0; peer < ranked.length; peer += 1) {
        if (peer === index) continue;
        const other = termSets[peer]!;
        if (own.size === 0 || other.size === 0) continue;
        let shared = 0;
        for (const term of own) if (other.has(term)) shared += 1;
        support += (shared / Math.sqrt(own.size * other.size)) * ranked[peer]![1];
      }
      const [id, score] = ranked[index]!;
      seeded.set(
        id,
        score * (1 - CROSS_SCORE_WEIGHT) + (support / (ranked.length - 1)) * CROSS_SCORE_WEIGHT,
      );
    }
  }

  const adjacency = new Map<string, { to: string; weight: number }[]>();
  const link = (from: string, to: string, weight: number): void => {
    const list = adjacency.get(from) ?? [];
    list.push({ to, weight });
    adjacency.set(from, list);
  };
  for (const edge of edges) {
    if (edge.validUntil !== undefined && !query.includeHistory) continue;
    if (edge.kind === 'supersede' || edge.kind === 'inhibits') {
      link(edge.from, edge.to, edge.weight);
      continue;
    }
    link(edge.from, edge.to, edge.weight);
    link(edge.to, edge.from, edge.weight);
  }

  const scores = new Map<string, number>(seeded);
  const trace: RecallTraceNode[] = [];
  for (const [id, score] of [...seeded].toSorted((a, b) => b[1] - a[1] || compareLabel(labels, a[0], b[0]))) {
    trace.push({
      id,
      kind: 'seed',
      score,
      viaEdge: undefined,
      truncated: false,
      salience: nodes.get(id)?.salience,
    });
  }

  let frontier = [...seeded.keys()].toSorted((a, b) => compareLabel(labels, a, b));
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
      .toSorted((a, b) => b[1].score - a[1].score || compareLabel(labels, a[0], b[0]))
      .slice(0, k);
    if (winners.length < candidates.size) truncated = true;
    for (const [id, info] of winners) {
      scores.set(id, Math.max(scores.get(id) ?? 0, info.score));
      trace.push({
        id,
        kind: 'spread',
        score: info.score,
        viaEdge: info.via,
        truncated: false,
        salience: nodes.get(id)?.salience,
      });
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
  const episodeFilter = noteScores.size > 0;
  const noteScope = new Map<string, string>();
  for (const atom of atoms) {
    if (!noteScope.has(atom.noteId)) noteScope.set(atom.noteId, atom.scopeKey);
  }
  const byScope = new Map<string, [string, number][]>();
  for (const entry of noteScores) {
    const scope = noteScope.get(entry[0]) ?? '';
    const list = byScope.get(scope);
    if (list === undefined) byScope.set(scope, [entry]);
    else list.push(entry);
  }
  const topNotes = new Set<string>();
  for (const list of byScope.values()) {
    for (const [note] of list
      .toSorted((a, b) => b[1] - a[1] || compareLabel(noteLabels, a[0], b[0]))
      .slice(0, params.episodeTopN)) {
      topNotes.add(note);
    }
  }
  const items: RecallItem[] = [...scores.entries()]
    .filter(([, score]) => score >= params.activationThreshold)
    .filter(([id]) => {
      const node = nodes.get(id)!;
      return node.kind === 'concept' || !episodeFilter || topNotes.has(node.noteId);
    })
    .toSorted((a, b) => b[1] - a[1] || compareLabel(labels, a[0], b[0]))
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

const CROSS_SCORE_TOP_N = 12;
const SALIENCE_GAIN = 0.25;
const SALIENCE_CAP = 2;
const CROSS_SCORE_WEIGHT = 0.2;

function compareLabel(labels: ReadonlyMap<string, string>, a: string, b: string): number {
  const left = labels.get(a) ?? a;
  const right = labels.get(b) ?? b;
  if (left !== right) return left < right ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
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
